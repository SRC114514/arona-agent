#!/usr/bin/env python3
"""
ARONA STT - Qwen ASR (阿里云百炼 DashScope) 实时语音识别客户端
录音并流式上传，返回识别文本到 stdout。

环境变量：
  QWEN_WORKSPACE_ID     - 百炼业务空间 ID（可选；留空走旧域名 dashscope.aliyuncs.com）
  QWEN_STT_API_KEY      - 百炼 API Key
  QWEN_STT_MODEL        - 模型名（默认 qwen-audio-3.0-asr-flash-streaming）
  QWEN_STT_FORMAT       - 音频格式（默认 pcm）
  QWEN_STT_SAMPLE_RATE  - 采样率（默认 16000）

流程：run-task → (等 task-started) → 录音并 send_bytes → finish-task
识别结果在 result-generated 的 payload.output.sentence 中，
sentence_end=true 为最终结果，聚合后输出到 stdout。
"""

import json
import os
import sys
import uuid
import asyncio
import traceback

from _i18n import t

# 录音参数
CHUNK_DURATION_MS = 200
MAX_RECORDING_SECONDS = 15
SILENCE_THRESHOLD = 500      # RMS 阈值
SILENCE_DURATION_MS = 1500   # 静音超过此时长则结束


def build_uri(workspace_id):
    if workspace_id:
        return f"wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
    return "wss://dashscope.aliyuncs.com/api-ws/v1/inference"


async def receive_results(ws):
    """持续接收识别结果，返回最终聚合文本。"""
    final_text = ""
    last_partial = ""
    while True:
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
        except asyncio.TimeoutError:
            break

        if isinstance(msg, (bytes, bytearray)):
            continue

        try:
            data = json.loads(msg)
        except Exception:
            continue

        header = data.get("header", {})
        event = header.get("event")

        if event == "result-generated":
            sentence = data.get("payload", {}).get("output", {}).get("sentence", {})
            text = sentence.get("text", "")
            if sentence.get("sentence_end"):
                final_text += text
                last_partial = ""  # 该句已终结，清空部分结果
            else:
                # 保留最新部分结果，防止长句在 sentence_end 前被截断而丢字
                last_partial = text
        elif event == "task-finished":
            break
        elif event == "task-failed":
            err_code = header.get("error_code", "")
            err_msg = header.get("error_message", "")
            print(t(f"STT task-failed: {err_code} {err_msg}", f"STT task-failed: {err_code} {err_msg}"), file=sys.stderr)
            break

    # 若最后一段未收到 sentence_end，补上已识别的部分结果
    return final_text + last_partial


async def stt_recognize(api_key, workspace_id, model, audio_format, sample_rate):
    import websockets
    import pyaudio
    import numpy as np

    uri = build_uri(workspace_id)
    task_id = str(uuid.uuid4())
    headers = {
        "Authorization": f"bearer {api_key}",
        "X-DashScope-DataInspection": "enable",
    }

    channels = 1
    sample_width = 2  # 16-bit
    frames_per_buffer = int(sample_rate * CHUNK_DURATION_MS / 1000)

    run_task = {
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex",
        },
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": model,
            "parameters": {
                "format": audio_format,
                "sample_rate": sample_rate,
            },
            "input": {},
        },
    }

    pa = None
    stream = None
    final_text = ""
    try:
        pa = pyaudio.PyAudio()
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            frames_per_buffer=frames_per_buffer,
        )

        async with websockets.connect(uri, additional_headers=headers, max_size=64 * 1024 * 1024) as ws:
            await ws.send(json.dumps(run_task))

            # 等 task-started
            started = False
            while not started:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=30.0)
                except asyncio.TimeoutError:
                    print(t("STT: 等待 task-started 超时", "STT: timeout waiting for task-started"), file=sys.stderr)
                    return ""
                if isinstance(msg, (bytes, bytearray)):
                    continue
                try:
                    data = json.loads(msg)
                except Exception:
                    # 非 JSON 消息，跳过继续等待 task-started
                    continue
                ev = data.get("header", {}).get("event")
                if ev == "task-started":
                    started = True
                elif ev == "task-failed":
                    err = data.get("header", {})
                    print(t(f"STT task-failed: {err.get('error_code')} {err.get('error_message')}", f"STT task-failed: {err.get('error_code')} {err.get('error_message')}"), file=sys.stderr)
                    return ""

            # 后台接收结果
            receive_task = asyncio.create_task(receive_results(ws))

            # 录音并上传
            silence_start = None
            speech_started = False  # 首次检测到声音后才开始静音计时，给用户反应宽限
            total_chunks = 0
            max_chunks = int(MAX_RECORDING_SECONDS * 1000 / CHUNK_DURATION_MS)

            print(t("正在录音…请说话", "Recording... (speak now)"), file=sys.stderr)

            while total_chunks < max_chunks:
                audio_data = stream.read(frames_per_buffer, exception_on_overflow=False)

                # 静音检测
                samples = np.frombuffer(audio_data, dtype=np.int16)
                rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
                if rms < SILENCE_THRESHOLD:
                    if speech_started:
                        if silence_start is None:
                            silence_start = total_chunks
                        elif (total_chunks - silence_start) * CHUNK_DURATION_MS >= SILENCE_DURATION_MS:
                            break
                else:
                    silence_start = None
                    speech_started = True

                # 发送二进制音频帧
                await ws.send(audio_data)
                total_chunks += 1

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

            try:
                final_text = await asyncio.wait_for(receive_task, timeout=10.0)
            except asyncio.TimeoutError:
                final_text = ""

    except Exception as e:
        print(t(f"STT 错误：{e}", f"STT error: {e}"), file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        if pa is not None:
            try:
                pa.terminate()
            except Exception:
                pass

    return final_text


def main():
    api_key = os.environ.get("QWEN_STT_API_KEY", "")
    workspace_id = os.environ.get("QWEN_WORKSPACE_ID", "")
    model = os.environ.get("QWEN_STT_MODEL", "qwen-audio-3.0-asr-flash-streaming")
    audio_format = os.environ.get("QWEN_STT_FORMAT", "pcm")
    sample_rate = int(os.environ.get("QWEN_STT_SAMPLE_RATE", "16000"))

    if not api_key:
        print(t("STT: 未设置 QWEN_STT_API_KEY", "STT: QWEN_STT_API_KEY not set"), file=sys.stderr)
        sys.exit(1)

    text = asyncio.run(stt_recognize(api_key, workspace_id, model, audio_format, sample_rate))
    print(text)


if __name__ == "__main__":
    main()
