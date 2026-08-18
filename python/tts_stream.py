#!/usr/bin/env python3
"""
ARONA TTS Stream - 常驻实时语音合成进程（阿里云百炼 DashScope 流式 TTS）

与 Node 侧（src/tts_stream.ts）通过 stdin/stdout JSON 行通信：

  stdin 指令：
    {"type":"text","data":"..."}   文本增量（流式输入，可多次）
    {"type":"end"}                 当前合成段结束（对该段执行 finish-task）
    {"type":"cancel"}              打断当前合成（取消连接任务 + 停止播放）
    {"type":"exit"}                退出进程
  stdout 事件：
    {"event":"ready"}
    {"event":"play_start"}         收到首个音频帧
    {"event":"play_end"}           当前段播放完毕（或被打断）
    {"event":"error","message":"..."}

WebSocket duplex 流式输入：一段（首个 text 到 end）共用一个 task_id：
  run-task → (task-started) → 多次 continue-task(text) → finish-task → 收帧到 task-finished。
这样同一段内多句话共享语气上下文，避免逐句独立任务导致语气骤变。
连接在主协程 connection_loop 中常驻复用；task 结束只向播放队列写 Marker，
不等待播放完毕，因此下一段的合成可与上一段音频播放重叠。pyaudio 不可用时
降级为逐段缓冲后整段播放（不做流水线）。

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
import collections
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
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


class Marker:
    """播放队列中的任务结束标记：pump 线程遇到它后通过事件循环发 play_end。"""


class PcmPlayer:
    """pcm 音频流式播放器（连接复用后常驻，不再每段 new/close）。

    - pyaudio 可用：后台线程从队列取块写入声卡；队列项为 bytes / Marker / None。
      Marker 表示对应 task 的全部音频已入队，播放到该位置时发 play_end。
      None 为关闭哨兵。
    - pyaudio 不可用：缓冲全部音频，finish 时写 WAV 临时文件按平台选择播放命令（降级）。
    """

    def __init__(self, rate, loop=None):
        self.rate = rate
        self.loop = loop
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
            self.pa_sample_format = pyaudio.paInt16
            self.pyaudio_ok = True
            self._open()
        except Exception as e:
            self.pyaudio_ok = False
            print(t(f"TTS Stream: pyaudio 不可用，将缓冲后播放：{e}", f"TTS Stream: pyaudio unavailable, will buffer then play: {e}"), file=sys.stderr)

    def _open(self):
        if not self.pyaudio_ok:
            return
        import queue as _queue
        if self.stream is not None:
            try:
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        self.stream = self.pa.open(
            format=self.pa_sample_format,
            channels=1,
            rate=self.rate,
            output=True,
        )
        self.queue = _queue.Queue()
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self):
        """后台播放线程：顺序写块；Marker 发 play_end；None 哨兵 = 排空退出。"""
        while True:
            try:
                item = self.queue.get()
                if item is None:
                    break
                if isinstance(item, Marker):
                    if self.loop is not None:
                        self.loop.call_soon_threadsafe(self._notify_play_end)
                    continue
                self.stream.write(item)
            except Exception:
                break

    def _notify_play_end(self):
        print(t("TTS Stream play_end", "TTS Stream play_end"), file=sys.stderr)
        emit("play_end")

    def _ensure_open(self):
        if not self.pyaudio_ok:
            return
        if self.stream is None or self.thread is None or not self.thread.is_alive():
            try:
                self._open()
            except Exception as e:
                print(t(f"TTS Stream: 重新打开音频输出失败：{e}", f"TTS Stream: reopen audio output failed: {e}"), file=sys.stderr)
                self.pyaudio_ok = False
                raise

    def write(self, chunk):
        if self.pyaudio_ok:
            try:
                self._ensure_open()
                self.queue.put(chunk)
            except Exception:
                self.buffered.append(chunk)
        else:
            self.buffered.append(chunk)

    def mark(self):
        if self.pyaudio_ok and self.queue is not None:
            self.queue.put(Marker())

    def abort(self):
        """打断：丢弃排队中未播音频、停止当前/降级播放子进程。"""
        with self.lock:
            if self.play_proc is not None:
                try:
                    self.play_proc.kill()
                except Exception:
                    pass
                self.play_proc = None
        if self.pyaudio_ok:
            if self.queue is not None:
                try:
                    while True:
                        self.queue.get_nowait()
                except Exception:
                    pass
                # 唤醒可能在 queue.get() 上等待的 pump 线程，避免 abort 后老线程残留
                try:
                    self.queue.put(None)
                except Exception:
                    pass
            self._close_stream()
            if self.thread is not None:
                try:
                    self.thread.join(timeout=2)
                except Exception:
                    pass
                self.thread = None
            self.queue = None
        self.buffered = []

    def finish(self):
        """降级路径：等待已缓冲音频播完（pyaudio 可用时流水线不使用本方法）。"""
        if self.pyaudio_ok:
            return
        self._play_buffered()

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
                if self.queue is not None:
                    try:
                        self.queue.put(None)
                    except Exception:
                        pass
                if self.thread is not None:
                    self.thread.join(timeout=2)
                    self.thread = None
                self._close_stream()
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

        # 流水线状态：pending_cmds 存放 stdin 来的 text/end；
        # connection_loop 严格串行消费（同一时刻至多一个 task，无独立 sender）。
        self.pending_cmds = collections.deque()
        self.cmd_event = asyncio.Event()
        self.current_ws = None
        self.player = None
        self.task_id = None
        self.task_active = False
        self.play_started = False
        self.cancelling = False
        self.exit_requested = False
        self.loop = None
        self.last_task_end_monotonic = 0.0

    # ------------------------------------------------------------
    # 播放器
    # ------------------------------------------------------------
    def _ensure_player(self):
        if self.player is None:
            self.player = PcmPlayer(self.sample_rate, self.loop)
        elif self.loop is not None and self.player.loop is None:
            self.player.loop = self.loop
        return self.player

    # ------------------------------------------------------------
    # 指令队列
    # ------------------------------------------------------------
    def _enqueue_cmd(self, cmd):
        self.pending_cmds.append(cmd)
        self.cmd_event.set()

    def _clear_pending(self):
        self.pending_cmds.clear()

    async def _next_cmd(self):
        while True:
            if self.pending_cmds:
                return self.pending_cmds.popleft()
            if self.exit_requested:
                return None
            self.cmd_event.clear()
            if not self.pending_cmds and not self.exit_requested:
                await self.cmd_event.wait()

    # ------------------------------------------------------------
    # WebSocket 连接（常驻复用；task-failed / cancel / 60s 空闲才重建）
    # ------------------------------------------------------------
    async def _connect_ws(self):
        import websockets
        uri = build_uri(self.workspace_id)
        headers = {
            "Authorization": f"bearer {self.api_key}",
            "X-DashScope-DataInspection": "enable",
        }
        last_err = None
        for attempt in range(3):
            try:
                return await websockets.connect(
                    uri, additional_headers=headers, max_size=64 * 1024 * 1024, open_timeout=30,
                    # proxy=None 显式禁用代理：websockets 默认会读系统/环境代理（Clash 的 SOCKS 代理
                    # 会让它报 "requires python-socks"），而 DashScope 国内服务应直连
                    proxy=None,
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                last_err = e
                if attempt < 2:
                    print(t(
                        f"TTS Stream: 连接失败（{e}），立即重试（第 {attempt + 2}/3 次）",
                        f"TTS Stream: connect failed ({e}), retry immediately (attempt {attempt + 2}/3)",
                    ), file=sys.stderr)
        raise last_err

    async def _ensure_ws(self):
        if self.current_ws is None:
            self.current_ws = await self._connect_ws()
        return self.current_ws

    async def _close_ws(self):
        ws = self.current_ws
        self.current_ws = None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass

    def _make_run_task(self, task_id):
        return {
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

    def _make_continue_task(self, task_id, text):
        return {
            "header": {
                "action": "continue-task",
                "task_id": task_id,
                "streaming": "duplex",
            },
            "payload": {"input": {"text": text}},
        }

    def _make_finish_task(self, task_id, cancel=False):
        payload = {"input": {}}
        if cancel:
            payload["input"]["directive"] = "cancel"
        return {
            "header": {
                "action": "finish-task",
                "task_id": task_id,
                "streaming": "duplex",
            },
            "payload": payload,
        }

    async def _send_json(self, ws, payload):
        await ws.send(json.dumps(payload))

    # ------------------------------------------------------------
    # 分段任务：一段（text...end）共用一个 task_id，保留上下文语气；
    # 段与段之间复用 WS，且上一段播放未结束时即可开始下一段合成。
    # ------------------------------------------------------------
    async def _start_task(self, ws, text):
        task_id = str(uuid.uuid4())
        self.task_id = task_id
        self.task_active = True
        self.play_started = False
        player = self._ensure_player()
        print(t(f"TTS Stream task-start {task_id[:8]}", f"TTS Stream task-start {task_id[:8]}"), file=sys.stderr)

        try:
            # 距上次任务结束超过 50s：主动重连，规避服务端 60s 空闲断开
            if self.last_task_end_monotonic and (time.monotonic() - self.last_task_end_monotonic) > 50.0:
                await self._close_ws()
                ws = await self._ensure_ws()

            await self._send_json(ws, self._make_run_task(task_id))

            # 等 task-started（15s 超时）
            started = False
            while not started:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=15.0)
                except asyncio.TimeoutError:
                    raise TimeoutError("task-started timeout")
                if isinstance(msg, (bytes, bytearray)):
                    continue
                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                event = data.get("header", {}).get("event")
                if event == "task-started":
                    started = True
                elif event == "task-failed":
                    err_code = data.get("header", {}).get("error_code", "")
                    err_msg = data.get("header", {}).get("error_message", "")
                    emit("error", message=t(
                        f"TTS task-failed: {err_code} {err_msg}",
                        f"TTS task-failed: {err_code} {err_msg}",
                    ))
                    await self._close_ws()
                    self.task_active = False
                    self.task_id = None
                    return

            # 首句文本通过 continue-task 送入当前任务
            await self._send_json(ws, self._make_continue_task(task_id, text))
        except asyncio.CancelledError:
            raise
        except Exception:
            self.task_active = False
            self.task_id = None
            raise

    async def _continue_task(self, ws, text):
        if not self.task_id:
            return
        await self._send_json(ws, self._make_continue_task(self.task_id, text))

    async def _finish_task(self, ws):
        task_id = self.task_id
        if not task_id:
            return
        player = self._ensure_player()
        try:
            await self._send_json(ws, self._make_finish_task(task_id, cancel=False))

            # 收音频到 task-finished；这一段内所有 continue-task 的文本共享同一语气上下文
            timed_out = False
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=120.0)
                except asyncio.TimeoutError:
                    timed_out = True
                    print(t("TTS Stream: 接收超时，断开重连", "TTS Stream: receive timeout, reconnect"), file=sys.stderr)
                    break

                if isinstance(msg, (bytes, bytearray)):
                    if not self.play_started:
                        self.play_started = True
                        print(t(f"TTS Stream play-start {task_id[:8]}", f"TTS Stream play-start {task_id[:8]}"), file=sys.stderr)
                        emit("play_start")
                    player.write(bytes(msg))
                    continue

                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                event = data.get("header", {}).get("event")
                if event == "task-finished":
                    break
                if event == "task-failed":
                    err_code = data.get("header", {}).get("error_code", "")
                    err_msg = data.get("header", {}).get("error_message", "")
                    emit("error", message=t(
                        f"TTS task-failed: {err_code} {err_msg}",
                        f"TTS task-failed: {err_code} {err_msg}",
                    ))
                    await self._close_ws()
                    if self.play_started:
                        emit("play_end")  # 避免 Node 侧 pending 卡住
                    return

            if timed_out:
                raise TimeoutError("receive timeout")

            print(t(f"TTS Stream task-finished {task_id[:8]}", f"TTS Stream task-finished {task_id[:8]}"), file=sys.stderr)

            # 正常结束：pyaudio 用 Marker 发 play_end（不阻塞等播完）；
            # 降级路径直接等整段播完再发 play_end（串行）。
            if player.pyaudio_ok:
                player.mark()
            else:
                await asyncio.to_thread(player.finish)
                emit("play_end")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if not self.cancelling and not self.exit_requested:
                emit("error", message=t(f"TTS Stream 错误：{e}", f"TTS Stream error: {e}"))
                traceback.print_exc(file=sys.stderr)
            await self._close_ws()
            if self.play_started:
                emit("play_end")
        finally:
            self.task_active = False
            self.task_id = None
            self.last_task_end_monotonic = time.monotonic()

    # ------------------------------------------------------------
    # 主连接协程：常驻，逐个消费 pending_cmds
    # ------------------------------------------------------------
    async def connection_loop(self):
        while not self.exit_requested:
            # 上一次 cancel 的标记由这里消费，避免任务误报错误
            if self.cancelling:
                self.cancelling = False
            cmd = await self._next_cmd()
            if cmd is None:
                break
            kind, data = cmd
            # 无活跃任务的 end 无事可做：直接忽略，避免无谓建立 WS 连接
            # （整条回复的句子都被长句过滤跳过时，Node 侧只会发 end）
            if kind == "end" and not self.task_active:
                continue
            try:
                ws = await self._ensure_ws()
                if kind == "text":
                    if self.task_active:
                        # 同一段内继续追加文本，保持语气上下文
                        await self._continue_task(ws, data)
                    else:
                        # 新的一段：开新 task，后续文本直到 end 都留在同一 task 内
                        await self._start_task(ws, data)
                elif kind == "end":
                    if self.task_active:
                        await self._finish_task(ws)
                    # 没有活跃任务时 end 直接忽略
            except asyncio.CancelledError:
                break
            except Exception as e:
                if not self.cancelling and not self.exit_requested:
                    emit("error", message=t(f"TTS Stream 连接错误：{e}", f"TTS Stream connection error: {e}"))
                await self._close_ws()
                if not self.exit_requested:
                    await asyncio.sleep(0.2)
        await self._close_ws()

    # ------------------------------------------------------------
    # 指令处理（stdin 主循环调用）
    # ------------------------------------------------------------
    async def handle_text(self, text: str):
        if not self.api_key:
            emit("error", message=t("TTS: 未设置 QWEN_TTS_API_KEY", "TTS: QWEN_TTS_API_KEY not set"))
            return
        if not text:
            return
        self._enqueue_cmd(("text", text))

    async def handle_end(self):
        # end 表示当前这一段结束：connection_loop 收到后会对活跃 task 执行 finish-task
        self._enqueue_cmd(("end", None))

    async def handle_cancel(self):
        self.cancelling = True
        self._clear_pending()
        if self.player is not None:
            self.player.abort()
        # 正在跑任务时尽量发 cancel finish-task，随后关 ws 让当前任务退出
        if self.current_ws is not None and self.task_id is not None:
            try:
                await self._send_json(self.current_ws, self._make_finish_task(self.task_id, cancel=True))
            except Exception:
                pass
        await self._close_ws()
        emit("play_end")  # 幂等：Node 侧 pendingCount 已归零时会忽略
        self.task_active = False
        self.task_id = None
        self.play_started = False
        # 注意：cancelling 不在本函数复位，由 connection_loop 下轮消费

    async def handle_exit(self):
        if self.exit_requested:
            return
        self.exit_requested = True
        self.cmd_event.set()
        await self.handle_cancel()
        if self.player is not None:
            self.player.close()
            self.player = None


async def main():
    server = TtsStreamServer()
    server.loop = asyncio.get_running_loop()
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

    connection_task = asyncio.ensure_future(server.connection_loop())
    try:
        await read_stdin()
    except Exception as e:
        print(t(f"TTS Stream 主循环错误：{e}", f"TTS Stream main loop error: {e}"), file=sys.stderr)
    finally:
        await server.handle_exit()
        if connection_task is not None and not connection_task.done():
            connection_task.cancel()
            try:
                await connection_task
            except BaseException:
                pass
        os._exit(0)


if __name__ == "__main__":
    asyncio.run(main())