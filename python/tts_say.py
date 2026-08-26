#!/usr/bin/env python3
"""
ARONA 非流式 TTS：一句话合成并播放（一次性进程，非流式 HTTP）。

与 Node 侧（src/tts_stream.ts）通过 stdin/stdout JSON 行通信（每句一个进程）：
  stdin  （单行）: {"provider":"aliyun"|"gpt-sovits", "text": "...", ...}
  stdout 事件（协议通道，禁止混入日志）：
    {"event":"ready"}        进程就绪
    {"event":"play_start"}   音频就绪、开始播放
    {"event":"level","rms":0~1}  播放中实时音量（节流 20Hz，驱动桌宠嘴型 lip-sync）
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

import array
import io
import json
import math
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

from _i18n import t

# ---- IPv4 优先解析 ----
# macOS 家宽常见坑：系统持有全局 IPv6 地址但出口路由不通。python 无 Happy Eyeballs，
# getaddrinfo 返回 v6 在前 → 每次请求先对 v6 卡满 socket 超时才回落 v4（合成+下载两请求
# = 每句多等 ~2×timeout，表现为"TTS 超时但无报错"）。重排 AF_INET 在前即可根治；
# IPv4 不可用时仍会按序回落 IPv6，不牺牲极端环境。
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_first_getaddrinfo(*args, **kwargs):
    res = _orig_getaddrinfo(*args, **kwargs)
    return sorted(res, key=lambda r: 0 if r[0] == socket.AF_INET else 1)


socket.getaddrinfo = _ipv4_first_getaddrinfo

SAMPLE_RATE = 24000  # qwen-audio-3.0-tts 非流式 wav 标准采样率

# ---- lip-sync 音量电平（RMS 0~1，供渲染侧嘴型同步）----
# 渲染侧做包络（快攻 80ms / 慢放 200ms）+ 阈值分档，这里只发裸 RMS。
_LEVEL_WINDOW_MS = 100    # RMS 滑动窗口（100ms）
_LEVEL_INTERVAL_S = 0.05  # 节流 20Hz（上限；窗口 100ms 实际约 10Hz，嘴型动画足够）
_LEVEL_LAST = [0.0]       # 上次 emit 时间戳


def _emit_level(rms):
    """节流发 level 事件（≤20Hz）：播放循环每帧调，超节流间隔才真正发，防事件风暴。"""
    now = time.time()
    if now - _LEVEL_LAST[0] < _LEVEL_INTERVAL_S:
        return
    _LEVEL_LAST[0] = now
    emit("level", rms=rms)


def _to_samples(raw, width):
    """wav 帧字节 → 有符号样本数组（仅支持常见 1/2/4 字节 PCM）。"""
    if width == 2:
        a = array.array("h")
        a.frombytes(raw)
        if sys.byteorder != "little":
            a.byteswap()
        return a
    if width == 1:
        a = array.array("B")
        a.frombytes(raw)
        return array.array("h", (x - 128 for x in a))
    if width == 4:
        a = array.array("i")
        a.frombytes(raw)
        if sys.byteorder != "little":
            a.byteswap()
        return a
    raise ValueError(t(f"不支持的 wav 位深：{width * 8}bit", f"unsupported wav sample width: {width * 8}bit"))


def _compute_envelope(data):
    """预计算 100ms 窗口 RMS 包络数组 (rate, [rms...])：供降级播放按时间推算嘴型电平。"""
    import wave
    wf = wave.open(io.BytesIO(data), "rb")
    rate = wf.getframerate()
    width = wf.getsampwidth()
    norm = 2.0 ** (width * 8 - 1)
    win = max(1, int(rate * _LEVEL_WINDOW_MS / 1000))
    env = []
    sum_sq = 0.0
    n = 0
    while True:
        raw = wf.readframes(4096)
        if not raw:
            break
        for s in _to_samples(raw, width):
            sum_sq += s * s
            n += 1
            if n >= win:
                env.append(math.sqrt(sum_sq / win) / norm)
                sum_sq = 0.0
                n = 0
    if n > 0 and env:  # 末尾不足窗口并入最后一段
        env[-1] = math.sqrt(sum_sq / n) / norm
    return rate, env


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


def synthesize_aliyun(cmd):
    """百炼非流式合成：返回完整 wav 音频字节。"""
    api_key = os.environ.get("QWEN_TTS_API_KEY", "")
    model = os.environ.get("QWEN_TTS_MODEL", "qwen-audio-3.0-tts-plus")
    if not api_key:
        raise RuntimeError(t("TTS: 未设置 QWEN_TTS_API_KEY", "TTS: QWEN_TTS_API_KEY not set"))
    # HTTP 超时由 Node 侧按“保险丝 − 5s”下发（aliyun 默认 25000ms）：合成挂死时
    # python 先报真实错误（urlopen 原因），Node 30s 保险丝只作最后兜底，不再静默吞错。
    timeout = float(cmd.get("timeoutMs") or (30_000 - 5_000)) / 1000.0

    body = {
        "model": model,
        "input": {
            "text": cmd.get("text") or "",
            "voice": cmd.get("voice") or "",
            "format": "wav",
            "sample_rate": SAMPLE_RATE,
        },
    }
    emit("phase", name="synthesizing")
    req = urllib.request.Request(
        build_endpoint(),
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with _opener().open(req, timeout=timeout) as resp:
        raw = resp.read()
    data = json.loads(raw)
    url = (data.get("output", {}) or {}).get("audio", {}) or {}
    url = url.get("url")
    if not url:
        raise RuntimeError(t(f"TTS 未返回音频 URL：{raw[:200]}", f"TTS no audio url: {raw[:200]}"))
    emit("phase", name="downloading")
    with _opener().open(url, timeout=timeout) as resp:
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
    if (cmd.get("switchGpt") and gpt_weights) or (cmd.get("switchSovits") and sovits_weights):
        emit("phase", name="switching_weights")
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
    emit("phase", name="synthesizing")
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
    return synthesize_aliyun(cmd)


def _synth_with_deadline(cmd):
    """合成 + 总时长 watchdog：合成在工作线程跑，主线程限时等待。
    socket 级 timeout 覆盖不到的卡法（慢速滴流、DNS 卡死、connect 回落链）到点报明确
    错误，杜绝"无声卡死到 Node 保险丝"。deadline = timeoutMs + 2s 余量（HTTP 层先报）。"""
    deadline = float(cmd.get("timeoutMs") or 25_000) / 1000.0 + 2.0
    box = {}

    def _worker():
        try:
            box["audio"] = _audio_bytes(cmd)
        except BaseException as e:  # noqa: BLE001 - 原样转抛主线程
            box["error"] = e

    th = threading.Thread(target=_worker, daemon=True)
    th.start()
    th.join(deadline)
    if th.is_alive():
        raise RuntimeError(t(
            f"TTS 合成超时（{int(deadline)}s 无响应）：网络到语音服务极慢或中断",
            f"TTS synthesis timed out ({int(deadline)}s no response): network to TTS service is extremely slow or down",
        ))
    if "error" in box:
        raise box["error"]
    return box["audio"]


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
    rate = wf.getframerate()
    width = wf.getsampwidth()
    norm = 2.0 ** (width * 8 - 1)
    win = max(1, int(rate * _LEVEL_WINDOW_MS / 1000))
    p = pyaudio.PyAudio()
    stream = p.open(
        format=p.get_format_from_width(width),
        channels=wf.getnchannels(),
        rate=rate,
        output=True,
    )
    try:
        chunk = 1024
        window = deque()
        sum_sq = 0.0
        frame = wf.readframes(chunk)
        while frame:
            stream.write(frame)
            # 实时 RMS（滑动窗口 + 节流）：时序与播放严格同步，驱动渲染侧嘴型
            for s in _to_samples(frame, width):
                window.append(s)
                sum_sq += s * s
            while len(window) > win:
                sum_sq -= window.popleft() ** 2
            if len(window) >= win:
                _emit_level(math.sqrt(sum_sq / len(window)) / norm)
            frame = wf.readframes(chunk)
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()
        wf.close()


def _play_fallback(data, envelope):
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(data)
        tmp.close()
        # 系统播放器（afplay/ffplay…）拿不到逐帧 PCM：起线程按已播放时长推算包络发 level
        rate, env = envelope
        stop = threading.Event()

        def _env_player():
            t0 = time.time()
            while not stop.is_set():
                idx = int((time.time() - t0) / (_LEVEL_WINDOW_MS / 1000.0))
                if 0 <= idx < len(env):
                    _emit_level(env[idx])
                time.sleep(_LEVEL_INTERVAL_S)

        th = threading.Thread(target=_env_player, daemon=True)
        th.start()
        try:
            subprocess.run(_play_command(tmp.name), check=False)
        finally:
            stop.set()
    finally:
        _remove_file(tmp.name)


def play_wav(data):
    # 先预算 100ms 包络（供降级播放路径按时间推算；pyaudio 主路径实时算、不依赖它）
    envelope = _compute_envelope(data)
    try:
        _play_pyaudio(data)
    except Exception:
        _play_fallback(data, envelope)


def _wav_duration(data):
    """按 wav 数据区实际字节数推断时长（秒）。百炼 TTS 把 RIFF/data size 写成 0x7FFFFFFF 占位值，
    wave.nframes 不可信；逐 chunk 解析 fmt 的 nAvgBytesPerSec 与 data 实际字节（占位 size 钳到文件剩余）。
    play_start 带实际时长，Node 侧据此扩容播放期保险丝。解析失败回退 0（Node 保持原保险丝）。"""
    import struct
    pos = 12
    total = len(data)
    byte_rate = 48000  # 回退（24kHz/mono/16bit，本项目百炼标准）
    samples = 0
    try:
        while pos + 8 <= total:
            cid = data[pos:pos + 4]
            size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
            body = pos + 8
            if cid == b"fmt " and size >= 16:
                byte_rate = struct.unpack("<I", data[body + 8:body + 12])[0] or byte_rate
            elif cid == b"data":
                # 占位 size（0x7FFFFFFF）远超剩余字节：钳到实际长度即可
                samples = min(size, total - body)
                break
            pos = body + size + (size & 1)
    except Exception:
        return 0.0
    if samples <= 0 or byte_rate <= 0:
        return 0.0
    return round(samples / byte_rate, 2)


def _write_temp_wav(data):
    """写入临时 wav，返回路径（供 synth_only 模式：合成后暂存，由 play 模式进程读取并删除）。"""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.write(data)
    tmp.close()
    return tmp.name


def _synth_and_play(cmd):
    """默认模式：合成 + 播放（向后兼容，预合成流水线回退路径）。异常由 main() 统一发 error。"""
    audio = _synth_with_deadline(cmd)
    emit("play_start", duration=_wav_duration(audio))
    play_wav(audio)
    emit("play_end")


def _synth_only(cmd):
    """预合成模式：只合成，写临时 wav 后发 synth_done（带路径）退出，不播放。
    Node 侧在上一句播放期间调用本模式预合成下一句，消除句间 HTTP 合成停顿。
    异常由 main() 统一发 error。"""
    audio = _synth_with_deadline(cmd)
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
    emit("play_start", duration=_wav_duration(data))
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
