#!/usr/bin/env python3
"""
ARONA TTS - Qwen TTS (阿里云百炼 DashScope) 实时语音合成客户端
从 stdin 读取文本，经 WebSocket 合成并播放。

环境变量：
  QWEN_WORKSPACE_ID     - 百炼业务空间 ID（可选；留空走旧域名 dashscope.aliyuncs.com）
  QWEN_TTS_API_KEY      - 百炼 API Key
  QWEN_TTS_MODEL        - 模型名（默认 qwen-audio-3.0-tts-plus）
  QWEN_TTS_VOICE        - 系统音色名 或 自定义音色(声音复刻)ID
  QWEN_TTS_FORMAT       - 音频格式 mp3/pcm/wav/opus（默认 mp3）
  QWEN_TTS_SAMPLE_RATE  - 采样率（默认 22050）

流程：run-task → (等 task-started) → continue-task(text) → finish-task
音频以二进制帧返回：pcm 用 pyaudio 流式播放，其它格式缓冲后用 afplay 播放。
进程在播放结束后才退出（runPython 的 await 语义依赖此行为）。
"""

import json
import os
import sys
import uuid
import asyncio
import tempfile
import subprocess
import traceback

from _i18n import t


def build_uri(workspace_id):
    if workspace_id:
        return f"wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
    return "wss://dashscope.aliyuncs.com/api-ws/v1/inference"


async def tts_synthesize(text, api_key, workspace_id, model, voice, audio_format, sample_rate):
    import websockets

    uri = build_uri(workspace_id)
    task_id = str(uuid.uuid4())
    headers = {
        "Authorization": f"bearer {api_key}",
        "X-DashScope-DataInspection": "enable",
    }

    buffered = []  # 非 pcm 格式缓冲的音频帧

    # pcm 用 pyaudio 流式播放；不可用时退化为缓冲后播放
    PyAudio_mod = None
    pa = None
    pa_stream = None
    if audio_format == "pcm":
        try:
            import pyaudio
            PyAudio_mod = pyaudio
            pa = pyaudio.PyAudio()
        except Exception as e:
            print(t(f"TTS: pyaudio 不可用，将缓冲后播放：{e}", f"TTS: pyaudio unavailable, will buffer then play: {e}"), file=sys.stderr)
            pa = None
            PyAudio_mod = None

    tmp_path = None
    try:
        async with websockets.connect(uri, additional_headers=headers, max_size=64 * 1024 * 1024) as ws:
            # 1. run-task
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
                    "model": model,
                    "parameters": {
                        "text_type": "PlainText",
                        "voice": voice,
                        "format": audio_format,
                        "sample_rate": sample_rate,
                        "volume": 50,
                        "rate": 1,
                        "pitch": 1,
                        "enable_ssml": False,
                    },
                    "input": {},
                },
            }
            await ws.send(json.dumps(run_task))

            # 2. 事件循环
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=60.0)
                except asyncio.TimeoutError:
                    print(t("TTS: 接收超时", "TTS: receive timeout"), file=sys.stderr)
                    break

                # 二进制帧 = 音频数据
                if isinstance(msg, (bytes, bytearray)):
                    chunk = bytes(msg)
                    if pa_stream is not None:
                        pa_stream.write(chunk)
                    else:
                        buffered.append(chunk)
                    continue

                try:
                    data = json.loads(msg)
                except Exception:
                    continue

                header = data.get("header", {})
                event = header.get("event")

                if event == "task-started":
                    # 打开 pcm 播放流
                    if pa is not None and pa_stream is None and PyAudio_mod is not None:
                        pa_stream = pa.open(
                            format=PyAudio_mod.paInt16,
                            channels=1,
                            rate=sample_rate,
                            output=True,
                        )
                    # 发送文本（可多次，这里一次性发送完整文本）
                    continue_task = {
                        "header": {
                            "action": "continue-task",
                            "task_id": task_id,
                            "streaming": "duplex",
                        },
                        "payload": {
                            "input": {
                                "text": text,
                            },
                        },
                    }
                    await ws.send(json.dumps(continue_task))
                    # 结束任务
                    finish_task = {
                        "header": {
                            "action": "finish-task",
                            "task_id": task_id,
                            "streaming": "duplex",
                        },
                        "payload": {
                            "input": {},
                        },
                    }
                    await ws.send(json.dumps(finish_task))

                elif event == "task-finished":
                    break

                elif event == "task-failed":
                    err_code = header.get("error_code", "")
                    err_msg = header.get("error_message", "")
                    print(t(f"TTS task-failed: {err_code} {err_msg}", f"TTS task-failed: {err_code} {err_msg}"), file=sys.stderr)
                    break
                # result-generated 等其它事件：忽略

        # 播放缓冲的非流式音频
        if buffered:
            try:
                data = b"".join(buffered)
                # afplay 无法播放裸 PCM：补 WAV 头后写成 .wav
                if audio_format == "pcm":
                    import io
                    import wave
                    buf = io.BytesIO()
                    with wave.open(buf, "wb") as wf:
                        wf.setnchannels(1)
                        wf.setsampwidth(2)  # 16-bit
                        wf.setframerate(sample_rate)
                        wf.writeframes(data)
                    data = buf.getvalue()
                    suffix = ".wav"
                else:
                    suffix = f".{audio_format}"
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                    f.write(data)
                    tmp_path = f.name
                subprocess.run(["afplay", tmp_path], check=True, timeout=120)
            except Exception as e:
                print(t(f"TTS 播放错误：{e}", f"TTS playback error: {e}"), file=sys.stderr)

    except Exception as e:
        print(t(f"TTS 错误：{e}", f"TTS error: {e}"), file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    finally:
        if pa_stream is not None:
            try:
                pa_stream.stop_stream()
                pa_stream.close()
            except Exception:
                pass
        if pa is not None:
            try:
                pa.terminate()
            except Exception:
                pass
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def main():
    # 显式 UTF-8 解码，避免依赖系统 locale（非 UTF-8 终端会乱码）
    text = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    if not text:
        return

    api_key = os.environ.get("QWEN_TTS_API_KEY", "")
    workspace_id = os.environ.get("QWEN_WORKSPACE_ID", "")
    model = os.environ.get("QWEN_TTS_MODEL", "qwen-audio-3.0-tts-plus")
    voice = os.environ.get("QWEN_TTS_VOICE", "longanhuan_v3.6")
    audio_format = os.environ.get("QWEN_TTS_FORMAT", "mp3")
    sample_rate = int(os.environ.get("QWEN_TTS_SAMPLE_RATE", "22050"))

    if not api_key:
        print(t("TTS: 未设置 QWEN_TTS_API_KEY", "TTS: QWEN_TTS_API_KEY not set"), file=sys.stderr)
        sys.exit(1)

    asyncio.run(tts_synthesize(text, api_key, workspace_id, model, voice, audio_format, sample_rate))


if __name__ == "__main__":
    main()
