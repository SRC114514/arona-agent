#!/usr/bin/env python3
"""
ARONA 非流式 TTS：一句话合成并播放（一次性进程，非流式 HTTP）。

与 Node 侧（src/tts_stream.ts）通过 stdin/stdout JSON 行通信（每句一个进程）：
  stdin  （单行）: {"text": "...", "voice": "..."}
  stdout 事件（协议通道，禁止混入日志）：
    {"event":"ready"}        进程就绪
    {"event":"play_start"}   音频就绪、开始播放
    {"event":"play_end"}     播放完毕
    {"event":"error","message":"..."}

流程：HTTP POST 非流式 TTS 端点 → 解析 output.audio.url → 下载音频 → 播放。
整句一次合成，语气上下文完整，避免流式逐段截断（如"好好吃饭哦"被拆读）。
播放：pyaudio 播 wav；pyaudio 不可用降级系统播放器（afplay / powershell / aplay / ffplay / paplay）。

环境变量：
  QWEN_TTS_API_KEY      - 百炼 API Key
  QWEN_TTS_MODEL        - 模型名（默认 qwen-audio-3.0-tts-plus）
  QWEN_WORKSPACE_ID     - 百炼业务空间 ID（可选；留空走全局域名 dashscope.aliyuncs.com）
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

from _i18n import t

SAMPLE_RATE = 24000  # qwen-audio-3.0-tts 非流式 wav 标准采样率


def emit(event, **kwargs):
    """向 stdout 输出一行事件 JSON（协议通道，禁止日志混入）。"""
    payload = {"event": event, **kwargs}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _opener():
    # 显式禁用代理：DashScope / OSS 国内服务直连，避免 Clash 系统代理干扰
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def build_endpoint():
    ws = os.environ.get("QWEN_WORKSPACE_ID", "")
    if ws:
        return f"https://{ws}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
    return "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"


def synthesize(text, voice):
    """非流式合成：返回完整 wav 音频字节。"""
    api_key = os.environ.get("QWEN_TTS_API_KEY", "")
    model = os.environ.get("QWEN_TTS_MODEL", "qwen-audio-3.0-tts-plus")
    if not api_key:
        raise RuntimeError(t("TTS: 未设置 QWEN_TTS_API_KEY", "TTS: QWEN_TTS_API_KEY not set"))

    body = {
        "model": model,
        "input": {
            "text": text,
            "voice": voice,
            "format": "wav",
            "sample_rate": SAMPLE_RATE,
        },
    }
    req = urllib.request.Request(
        build_endpoint(),
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with _opener().open(req, timeout=60) as resp:
        raw = resp.read()
    data = json.loads(raw)
    url = (data.get("output", {}) or {}).get("audio", {}) or {}
    url = url.get("url")
    if not url:
        raise RuntimeError(t(f"TTS 未返回音频 URL：{raw[:200]}", f"TTS no audio url: {raw[:200]}"))
    with _opener().open(url, timeout=60) as resp:
        return resp.read()


def _play_command(wav_path):
    """按平台选择降级播放命令（pyaudio 不可用时的非实时兜底）。"""
    if sys.platform == "darwin":
        return ["afplay", wav_path]
    if sys.platform == "win32":
        return ["powershell", "-NoProfile", "-NonInteractive",
                "-Command", f"(New-Object Media.SoundPlayer '{wav_path}').PlaySync()"]
    for cmd in ("aplay", "ffplay", "paplay"):
        if shutil.which(cmd):
            return [cmd, wav_path]
    return ["aplay", wav_path]


def _play_pyaudio(data):
    import pyaudio
    import wave
    wf = wave.open(io.BytesIO(data), "rb")
    p = pyaudio.PyAudio()
    stream = p.open(
        format=p.get_format_from_width(wf.getsampwidth()),
        channels=wf.getnchannels(),
        rate=wf.getframerate(),
        output=True,
    )
    try:
        chunk = 1024
        frame = wf.readframes(chunk)
        while frame:
            stream.write(frame)
            frame = wf.readframes(chunk)
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()
        wf.close()


def _play_fallback(data):
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(data)
        tmp.close()
        subprocess.run(_play_command(tmp.name), check=False)
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


def play_wav(data):
    try:
        _play_pyaudio(data)
    except Exception:
        _play_fallback(data)


def main():
    emit("ready")
    line = sys.stdin.readline()
    if not line:
        return
    try:
        cmd = json.loads(line)
    except Exception:
        emit("error", message=t("TTS: 无效的 stdin JSON", "TTS: invalid stdin JSON"))
        sys.stdout.flush()
        return
    text = (cmd.get("text") or "").strip()
    voice = cmd.get("voice") or ""
    if not text:
        emit("error", message=t("TTS: 空文本", "TTS: empty text"))
        sys.stdout.flush()
        return
    try:
        audio = synthesize(text, voice)
        emit("play_start")
        play_wav(audio)
        emit("play_end")
        sys.stdout.flush()
    except Exception as e:
        emit("error", message=str(e))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
