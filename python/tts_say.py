#!/usr/bin/env python3
"""
ARONA 非流式 TTS：一句话合成并播放（一次性进程，非流式 HTTP）。

与 Node 侧（src/tts_stream.ts）通过 stdin/stdout JSON 行通信（每句一个进程）：
  stdin  （单行）: {"provider":"aliyun"|"gpt-sovits", "text": "...", ...}
  stdout 事件（协议通道，禁止混入日志）：
    {"event":"ready"}        进程就绪
    {"event":"play_start"}   音频就绪、开始播放
    {"event":"play_end"}     播放完毕
    {"event":"weights_loaded","gpt":"...","sovits":"..."}   GPT-SoVITS 权重切换完成
    {"event":"error","message":"..."}

Provider：
  - aliyun    百炼非流式 SpeechSynthesizer → 下载 OSS 音频 → 播放。
  - gpt-sovits GPT-SoVITS api_v2（云端/本地）：可选 apiKey 作 Bearer 鉴权、
              set_gpt_weights/set_sovits_weights 切换权重，POST /tts 拿 wav 字节 → 播放。
整句一次合成，语气上下文完整，避免流式逐段截断（如"好好吃饭哦"被拆读）。
播放：pyaudio 播 wav；pyaudio 不可用降级系统播放器（afplay / powershell / aplay / ffplay / paplay）。

百炼环境变量：
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
import time
import urllib.error
import urllib.parse
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


def synthesize_aliyun(text, voice):
    """百炼非流式合成：返回完整 wav 音频字节。"""
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


def _switch_weights(base_url, endpoint, label, weights_path, timeout, headers=None):
    """调用 GPT-SoVITS api_v2 的 set_gpt_weights / set_sovits_weights（GET 查询串）。"""
    url = f"{base_url}/set_{endpoint}?weights_path={urllib.parse.quote(weights_path)}"
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with _opener().open(req, timeout=timeout) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(t(
            f"GPT-SoVITS {label} 权重切换失败 (HTTP {e.code}): {detail}",
            f"GPT-SoVITS {label} weights switch failed (HTTP {e.code}): {detail}",
        ))
    except urllib.error.URLError as e:
        raise RuntimeError(t(
            f"GPT-SoVITS {label} 权重切换失败：{e.reason}",
            f"GPT-SoVITS {label} weights switch failed: {e.reason}",
        ))


def synthesize_gpt_sovits(cmd):
    """GPT-SoVITS api_v2 非流式合成：必要时切换权重，POST /tts 返回 wav 字节。"""
    base_url = (cmd.get("baseUrl") or "http://127.0.0.1:9880").rstrip("/")
    timeout = float(cmd.get("timeoutMs") or 60000) / 1000.0
    ref_audio_path = cmd.get("refAudioPath") or ""
    if not ref_audio_path:
        raise RuntimeError(t("TTS: 未配置 GPT-SoVITS 参考音频", "TTS: GPT-SoVITS ref audio not configured"))

    gpt_weights = cmd.get("gptWeightsPath") or ""
    sovits_weights = cmd.get("sovitsWeightsPath") or ""
    api_key = cmd.get("apiKey") or ""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    switched = {}
    if cmd.get("switchGpt") and gpt_weights:
        _switch_weights(base_url, "gpt_weights", "GPT", gpt_weights, timeout, headers)
        switched["gpt"] = gpt_weights
    if cmd.get("switchSovits") and sovits_weights:
        _switch_weights(base_url, "sovits_weights", "SoVITS", sovits_weights, timeout, headers)
        switched["sovits"] = sovits_weights
    if switched:
        emit("weights_loaded", **switched)

    body = {
        "text": cmd.get("text") or "",
        "text_lang": cmd.get("textLang") or "auto",
        "ref_audio_path": ref_audio_path,
        "prompt_text": cmd.get("promptText") or "",
        "prompt_lang": cmd.get("promptLang") or "zh",
        "text_split_method": "cut5",
        "batch_size": 1,
        "media_type": "wav",
        "streaming_mode": False,
        "parallel_infer": True,
        "fragment_interval": 0.3,
        "speed_factor": 1.0,
    }
    req = urllib.request.Request(
        base_url + "/tts",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
    )
    try:
        with _opener().open(req, timeout=timeout) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(t(
            f"GPT-SoVITS 请求失败 (HTTP {e.code}): {detail}",
            f"GPT-SoVITS request failed (HTTP {e.code}): {detail}",
        ))
    except urllib.error.URLError as e:
        raise RuntimeError(t(
            f"GPT-SoVITS 连接失败：{e.reason}",
            f"GPT-SoVITS connection failed: {e.reason}",
        ))
    # 200 但返回 JSON 错误（部分分支异常）：按错误处理
    if data[:1] == b"{" or data[:1] == b"[":
        try:
            parsed = json.loads(data)
            detail = parsed.get("detail") or parsed.get("msg") or parsed.get("message") or data[:300]
        except Exception:
            detail = data[:300]
        raise RuntimeError(t(
            f"GPT-SoVITS 返回错误：{detail}",
            f"GPT-SoVITS returned error: {detail}",
        ))
    return data


def _audio_bytes(cmd):
    """按 provider 分发合成，返回音频字节（wav）。"""
    provider = cmd.get("provider") or "aliyun"
    text = (cmd.get("text") or "").strip()
    if not text:
        raise RuntimeError(t("TTS: 空文本", "TTS: empty text"))
    if provider == "gpt-sovits":
        return synthesize_gpt_sovits(cmd)
    voice = cmd.get("voice") or ""
    return synthesize_aliyun(text, voice)


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


def _remove_file(path):
    """稳健删除临时文件：Windows 降级播放（PowerShell SoundPlayer）返回后句柄/杀软可能
    尚未释放，单次 os.unlink 会抛 PermissionError；以短间隔重试 ≤3 次收敛后静默。
    macOS/Linux 通常一次即删。"""
    for attempt in range(3):
        try:
            os.unlink(path)
            return
        except OSError:
            if attempt < 2:
                time.sleep(0.1)
            # 最后一次失败：静默容忍（留作残留临时文件，不影响播放/功能）


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
        _remove_file(tmp.name)


def play_wav(data):
    try:
        _play_pyaudio(data)
    except Exception:
        _play_fallback(data)


def _write_temp_wav(data):
    """写入临时 wav，返回路径（供 synth_only 模式：合成后暂存，由 play 模式进程读取并删除）。"""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.write(data)
    tmp.close()
    return tmp.name


def _synth_and_play(cmd):
    """默认模式：合成 + 播放（向后兼容，预合成流水线回退路径）。异常由 main() 统一发 error。"""
    audio = _audio_bytes(cmd)
    emit("play_start")
    play_wav(audio)
    emit("play_end")


def _synth_only(cmd):
    """预合成模式：只合成，写临时 wav 后发 synth_done（带路径）退出，不播放。
    Node 侧在上一句播放期间调用本模式预合成下一句，消除句间 HTTP 合成停顿。
    异常由 main() 统一发 error。"""
    audio = _audio_bytes(cmd)
    path = _write_temp_wav(audio)
    emit("synth_done", path=path)


def _play_path(cmd):
    """播放模式：读已合成的临时 wav 播放（无 HTTP），播完删除临时文件。"""
    path = cmd.get("path") or ""
    if not path or not os.path.exists(path):
        emit("error", message=t("TTS: 无效的音频路径", "TTS: invalid audio path"))
        sys.stdout.flush()
        return
    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception as e:
        emit("error", message=str(e))
        sys.stdout.flush()
        return
    _remove_file(path)
    emit("play_start")
    play_wav(data)
    emit("play_end")


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
    mode = cmd.get("mode") or "synth_play"
    try:
        if mode == "synth_only":
            _synth_only(cmd)
        elif mode == "play":
            _play_path(cmd)
        else:
            _synth_and_play(cmd)
        sys.stdout.flush()
    except Exception as e:
        emit("error", message=str(e))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
