#!/usr/bin/env python3
"""
ARONA TTS Stream - 常驻实时语音合成进程（阿里云百炼 DashScope 流式 TTS）

与 Node 侧（src/tts_stream.ts）通过 stdin/stdout JSON 行通信：

  stdin 指令：
    {"type":"text","data":"..."}   文本增量（流式输入，可多次）
    {"type":"end"}                 当前合成段结束（finish-task）
    {"type":"cancel"}              打断当前合成（取消连接任务 + 停止播放）
    {"type":"exit"}                退出进程
  stdout 事件：
    {"event":"ready"}
    {"event":"play_start"}         收到首个音频帧
    {"event":"play_end"}           当前段播放完毕（或被打断）
    {"event":"error","message":"..."}

WebSocket duplex 流式输入：run-task → (task-started) → 多次 continue-task → finish-task。
服务端边收文本边返回音频帧。音频格式固定 pcm，pyaudio 边收边播；
pyaudio 不可用时缓冲为 WAV 后按平台选择播放命令（降级，非实时）。

环境变量：
  QWEN_WORKSPACE_ID     - 百炼业务空间 ID（可选；留空走旧域名 dashscope.aliyuncs.com）
  QWEN_TTS_API_KEY      - 百炼 API Key
  QWEN_TTS_MODEL        - 模型名（默认 qwen-audio-3.0-tts-plus）
  QWEN_TTS_VOICE        - 系统音色名 或 自定义音色(声音复刻)ID
  QWEN_TTS_SAMPLE_RATE  - 采样率（默认 22050）

注意：本进程 stdout 输出的是结构化事件 JSON（协议通道），不要混入日志；
日志请走 stderr（_i18n 双语言）。
"""

import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
import uuid
import wave

from _i18n import t


def build_uri(workspace_id):
    if workspace_id:
        return f"wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
    return "wss://dashscope.aliyuncs.com/api-ws/v1/inference"


def emit(event, **kwargs):
    """向 stdout 输出一行事件 JSON（协议通道，禁止日志混入）。"""
    payload = {"event": event, **kwargs}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class PcmPlayer:
    """pcm 音频流式播放器。

    - pyaudio 可用：后台线程从队列取块写入声卡（顺序播放，finish 排空后线程退出）。
    - pyaudio 不可用：缓冲全部音频，finish 时写 WAV 临时文件按平台选择播放命令（降级）。
    """

    def __init__(self, rate):
        self.rate = rate
        self.pyaudio_ok = False
        self.pa = None
        self.stream = None
        self.queue = None
        self.thread = None
        self.buffered = []
        self.play_proc = None
        self.lock = threading.Lock()
        try:
            import pyaudio
            self.pa = pyaudio.PyAudio()
            self.stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=rate,
                output=True,
            )
            self.pyaudio_ok = True
            import queue as _queue
            self.queue = _queue.Queue()
            self.thread = threading.Thread(target=self._pump, daemon=True)
            self.thread.start()
        except Exception as e:
            self.pyaudio_ok = False
            print(t(f"TTS Stream: pyaudio 不可用，将缓冲后播放：{e}", f"TTS Stream: pyaudio unavailable, will buffer then play: {e}"), file=sys.stderr)

    def _pump(self):
        """后台播放线程：顺序写块；None 哨兵 = 排空退出；write 抛异常（被 abort 关闭）即退出。"""
        while True:
            try:
                chunk = self.queue.get()
                if chunk is None:
                    break
                self.stream.write(chunk)
            except Exception:
                break

    def write(self, chunk):
        if self.pyaudio_ok and self.queue is not None:
            self.queue.put(chunk)
        else:
            self.buffered.append(chunk)

    def finish(self):
        """正常收尾：等待所有已入队音频播完（或缓冲播放），返回后播放已结束。"""
        if self.pyaudio_ok and self.queue is not None:
            # 排空哨兵：线程会先把队列中已有块写完再退出
            self.queue.put(None)
            if self.thread is not None:
                self.thread.join(timeout=10)
            self._close_stream()
        else:
            self._play_buffered()

    def abort(self):
        """打断：丢弃未播音频、停止播放（含 kill 掉降级播放子进程）。"""
        with self.lock:
            if self.play_proc is not None:
                try:
                    self.play_proc.kill()
                except Exception:
                    pass
                self.play_proc = None
        if self.pyaudio_ok:
            self._close_stream()  # 中断 _pump 中的 write
            if self.thread is not None:
                self.thread.join(timeout=2)
        self.buffered = []

    def _close_stream(self):
        try:
            if self.stream is not None:
                self.stream.stop_stream()
                self.stream.close()
        except Exception:
            pass
        self.stream = None

    @staticmethod
    def _play_command(wav_path):
        """按平台选择降级播放命令（pyaudio 不可用时的非实时兜底）。"""
        if sys.platform == "darwin":
            return ["afplay", wav_path]
        if sys.platform == "win32":
            # PowerShell SoundPlayer 同步播放 WAV；保持子进程模式，abort/close 时 kill 即可打断
            return ["powershell", "-NoProfile", "-NonInteractive",
                    "-Command", f"(New-Object Media.SoundPlayer '{wav_path}').PlaySync()"]
        # linux 等：优先 aplay，其次 ffplay/paplay，均无则回退 aplay（Popen 会抛异常并被上层捕获）
        for cmd in ("aplay", "ffplay", "paplay"):
            if shutil.which(cmd):
                return [cmd, wav_path]
        return ["aplay", wav_path]

    def _play_buffered(self):
        if not self.buffered:
            return
        data = b"".join(self.buffered)
        self.buffered = []
        try:
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(self.rate)
                wf.writeframes(data)
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(buf.getvalue())
                tmp_path = f.name
            try:
                with self.lock:
                    self.play_proc = subprocess.Popen(self._play_command(tmp_path))
                self.play_proc.wait(timeout=120)
            except Exception as e:
                print(t(f"TTS Stream 播放错误：{e}", f"TTS Stream playback error: {e}"), file=sys.stderr)
            finally:
                with self.lock:
                    self.play_proc = None
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
        except Exception as e:
            print(t(f"TTS Stream 播放错误：{e}", f"TTS Stream playback error: {e}"), file=sys.stderr)

    def close(self):
        with self.lock:
            if self.play_proc is not None:
                try:
                    self.play_proc.kill()
                except Exception:
                    pass
                self.play_proc = None
        if self.pyaudio_ok:
            try:
                self._close_stream()
                if self.thread is not None:
                    self.thread.join(timeout=2)
            except Exception:
                pass
        if self.pa is not None:
            try:
                self.pa.terminate()
            except Exception:
                pass
        self.pa = None


class TtsStreamServer:
    def __init__(self):
        self.api_key = os.environ.get("QWEN_TTS_API_KEY", "")
        self.workspace_id = os.environ.get("QWEN_WORKSPACE_ID", "")
        self.model = os.environ.get("QWEN_TTS_MODEL", "qwen-audio-3.0-tts-plus")
        self.voice = os.environ.get("QWEN_TTS_VOICE", "longanhuan_v3.6")
        self.sample_rate = int(os.environ.get("QWEN_TTS_SAMPLE_RATE", "22050"))
        self.format = "pcm"  # 实时播放固定 pcm，忽略 QWEN_TTS_FORMAT

        # 段状态机：idle（无活跃段）→ running（建连+收音频，接受 text 流式）→ finishing（end 已发，等播完）
        # 段间严格串行：上一条消息播完（play_end）后，才启动下一条（暂存于 next_texts）。
        self.state = "idle"
        self.task_id = None
        self.current_ws = None
        self.started_evt = asyncio.Event()  # task-started 后置位
        self.send_queue = asyncio.Queue()   # 当前段指令（continue-task / finish-task）
        self.next_cmds = []                 # finishing 期间暂存的下一条消息指令（("text", str) / ("end", None)）
        self.player = None
        self.run_task = None                # 当前段的 run_connection Task
        self.play_started = False
        self.cancelling = False
        self.exit_requested = False

    # ------------------------------------------------------------
    # 播放 / 段生命周期
    # ------------------------------------------------------------
    def _ensure_player(self):
        if self.player is None:
            self.player = PcmPlayer(self.sample_rate)
        return self.player

    def _start_session(self):
        """开启一个新合成段：新 task_id + 新播放器 + 新连接任务。"""
        self.task_id = str(uuid.uuid4())
        # 清掉上一段残留指令（异常结束时未消费的 continue/finish 带旧 task_id，
        # 泄漏进新段会触发服务端 task-failed 或让 _send_loop 提前退出吞掉正文）
        self._clear_send_queue()
        self.state = "running"
        self.started_evt = asyncio.Event()
        self.play_started = False
        self.player = PcmPlayer(self.sample_rate)
        self.run_task = asyncio.ensure_future(self.run_connection())
        return self.task_id

    def _clear_send_queue(self):
        try:
            while True:
                self.send_queue.get_nowait()
        except asyncio.QueueEmpty:
            pass

    # ------------------------------------------------------------
    # WebSocket 连接生命周期（一个任务一次连接，cancel 后断开重连）
    # ------------------------------------------------------------
    async def run_connection(self):
        import websockets
        uri = build_uri(self.workspace_id)
        task_id = self.task_id  # 由 _start_session 预生成
        headers = {
            "Authorization": f"bearer {self.api_key}",
            "X-DashScope-DataInspection": "enable",
        }
        sender = None
        try:
            # 握手重试：opening handshake 超时多为瞬时网络抖动（DNS 慢 / 链路闪断 /
            # 系统代理干扰），重试 3 次可吞掉；cancel 传播的 CancelledError 不重试直接上抛
            ws = None
            last_err = None
            for attempt in range(3):
                try:
                    ws = await websockets.connect(
                        uri, additional_headers=headers, max_size=64 * 1024 * 1024, open_timeout=30,
                        # proxy=None 显式禁用代理：websockets 默认会读系统/环境代理（Clash 的 SOCKS 代理
                        # 会让它报 "requires python-socks"），而 DashScope 国内服务应直连
                        proxy=None,
                    )
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    last_err = e
                    if attempt < 2:
                        print(t(
                            f"TTS Stream: 连接失败（{e}），立即重试（第 {attempt + 2}/3 次）",
                            f"TTS Stream: connect failed ({e}), retry immediately (attempt {attempt + 2}/3)",
                        ), file=sys.stderr)
            if ws is None:
                raise last_err
            async with ws:
                self.current_ws = ws
                run_task = {
                    "header": {
                        "action": "run-task",
                        "task_id": task_id,
                        "streaming": "duplex",
                    },
                    "payload": {
                        "task_group": "audio",
                        "task": "tts",
                        "function": "SpeechSynthesizer",
                        "model": self.model,
                        "parameters": {
                            "text_type": "PlainText",
                            "voice": self.voice,
                            "format": self.format,
                            "sample_rate": self.sample_rate,
                            "volume": 50,
                            "rate": 1,
                            "pitch": 1,
                            "enable_ssml": False,
                        },
                        "input": {},
                    },
                }
                await ws.send(json.dumps(run_task))

                # 发送协程：task-started 后从队列取 continue-task / finish-task 发送
                # （sender 的取消/回收统一在 finally，覆盖正常 break 与异常断开所有路径）
                sender = asyncio.ensure_future(self._send_loop())

                # 接收循环
                while True:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=120.0)
                    except asyncio.TimeoutError:
                        print(t("TTS Stream: 接收超时，断开重连", "TTS Stream: receive timeout, reconnect"), file=sys.stderr)
                        break

                    if isinstance(msg, (bytes, bytearray)):
                        if not self.play_started:
                            self.play_started = True
                            emit("play_start")
                        self._ensure_player().write(bytes(msg))
                        continue

                    try:
                        data = json.loads(msg)
                    except Exception:
                        continue
                    header = data.get("header", {})
                    event = header.get("event")

                    if event == "task-started":
                        self.started_evt.set()
                    elif event == "task-finished":
                        break
                    elif event == "task-failed":
                        err_code = header.get("error_code", "")
                        err_msg = header.get("error_message", "")
                        emit("error", message=t(
                            f"TTS task-failed: {err_code} {err_msg}",
                            f"TTS task-failed: {err_code} {err_msg}",
                        ))
                        break

        except asyncio.CancelledError:
            # 由 handle_cancel 取消：直接上抛，交由 finally 收尾
            raise
        except Exception as e:
            if not self.cancelling:
                emit("error", message=t(f"TTS Stream 错误：{e}", f"TTS Stream error: {e}"))
                traceback.print_exc(file=sys.stderr)
        finally:
            # 连接已结束。播放收尾（串行阻塞到播完），完成后复位并启动下一段。
            # 先把异常结束（未经 end）的段降级为 finishing：下方 await 收尾窗口内到达的
            # text/end 会路由到 next_cmds（见 handle_text/handle_end）；若仍排进死段的
            # send_queue，既丢失又会毒化下一段（旧 task_id 指令）。
            if self.state == "running":
                self.state = "finishing"
            # 所有路径（含 ws 异常断开）都回收发送协程，防僵尸 _send_loop 吞掉新段指令
            if sender is not None and not sender.done():
                sender.cancel()
                try:
                    await sender
                except Exception:
                    pass
            self.current_ws = None
            player = self.player
            self.player = None
            if player is not None:
                try:
                    await asyncio.to_thread(player.finish)
                except Exception:
                    pass
                try:
                    await asyncio.to_thread(player.close)
                except Exception:
                    pass
            emit("play_end")
            self.state = "idle"
            self.task_id = None
            self.started_evt = asyncio.Event()
            self.run_task = None
            # 段间串行：若有暂存的下一段指令，立即重放开启新段
            if self.next_cmds and not self.cancelling and not self.exit_requested:
                cmds = self.next_cmds
                self.next_cmds = []
                for kind, val in cmds:
                    if kind == "text":
                        await self.handle_text(val)
                    else:  # "end"
                        await self.handle_end()

    async def _send_loop(self):
        """等待 task-started 后，从队列逐个发送 continue-task / finish-task。"""
        await self.started_evt.wait()
        while True:
            item = await self.send_queue.get()
            if item is None:
                break
            kind, payload = item
            try:
                await self.current_ws.send(json.dumps(payload))
            except Exception:
                break
            if kind == "finish":
                # finish-task 已发出，任务将在服务端侧收尾
                break

    def _make_continue_task(self, text):
        return ("text", {
            "header": {
                "action": "continue-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": {"input": {"text": text}},
        })

    def _make_finish_task(self, cancel=False):
        payload = {"input": {}}
        if cancel:
            payload["input"]["directive"] = "cancel"
        return ("finish", {
            "header": {
                "action": "finish-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": payload,
        })

    # ------------------------------------------------------------
    # 指令处理（主循环调用）
    # ------------------------------------------------------------
    async def handle_text(self, text: str):
        if not self.api_key:
            emit("error", message=t("TTS: 未设置 QWEN_TTS_API_KEY", "TTS: QWEN_TTS_API_KEY not set"))
            return
        if not text:
            return
        if self.state == "idle":
            self._start_session()
        if self.state == "finishing":
            # 上一条消息还在播放：暂存完整指令，段间串行（下段播完上段后自动重放）
            self.next_cmds.append(("text", text))
            return
        # running（含刚启动的段）
        await self.send_queue.put(self._make_continue_task(text))

    async def handle_end(self):
        if self.state == "running":
            self.state = "finishing"
            await self.send_queue.put(self._make_finish_task(cancel=False))
        elif self.state == "finishing":
            # 下一条消息的 end：与暂存的 text 一起排队重放
            self.next_cmds.append(("end", None))
        # idle：忽略（Node 串行发指令，不会出现）

    async def handle_cancel(self):
        self.cancelling = True
        self._clear_send_queue()
        self.next_cmds = []
        # 先打断播放器（置 None），再取消连接 Task——避免 finally 里阻塞 finish 播完残余
        if self.player is not None:
            self.player.abort()
            self.player = None
        if self.run_task is not None and not self.run_task.done():
            self.run_task.cancel()
            try:
                await self.run_task
            except (asyncio.CancelledError, Exception):
                pass
        ws = self.current_ws
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass
        emit("play_end")  # 立即复位 Node 侧 pending（幂等）
        self.state = "idle"
        self.task_id = None
        self.started_evt = asyncio.Event()
        self.run_task = None
        self.cancelling = False

    async def handle_exit(self):
        if self.exit_requested:
            return
        self.exit_requested = True
        await self.handle_cancel()
        if self.player is not None:
            self.player.close()


async def main():
    server = TtsStreamServer()
    if not server.api_key:
        emit("error", message=t("TTS: 未设置 QWEN_TTS_API_KEY", "TTS: QWEN_TTS_API_KEY not set"))
    emit("ready")

    loop = asyncio.get_running_loop()

    async def read_stdin():
        while not server.exit_requested:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except Exception:
                continue
            kind = cmd.get("type")
            if kind == "text":
                await server.handle_text(cmd.get("data", ""))
            elif kind == "end":
                await server.handle_end()
            elif kind == "cancel":
                await server.handle_cancel()
            elif kind == "exit":
                await server.handle_exit()
                break
        # stdin 关闭或 exit：结束进程
        if not server.exit_requested:
            await server.handle_exit()

    try:
        await read_stdin()
    except Exception as e:
        print(t(f"TTS Stream 主循环错误：{e}", f"TTS Stream main loop error: {e}"), file=sys.stderr)
    finally:
        await server.handle_exit()
        os._exit(0)


if __name__ == "__main__":
    asyncio.run(main())
