#!/usr/bin/env python3
"""
ARONA Voice Cloning — uploads voice.mp3 to DashScope, creates a custom voice,
and prints the voice_id as JSON on stdout. Deletes the uploaded file afterward.

Environment variables:
  QWEN_TTS_API_KEY     - DashScope API key
  QWEN_TTS_MODEL       - target TTS model (default qwen-audio-3.0-tts-plus)
  ARONA_VOICE_AUDIO    - path to the audio file (voice.mp3)
  ARONA_VOICE_PREFIX   - voice ID prefix, lowercase alnum, <=10 chars (default "arona")

Output (stdout): {"voice_id": "..."} on success, {"error": "..."} on failure.
All logging goes to stderr so stdout stays clean JSON.
"""

import json
import os
import re
import socket
import sys
import time

from _i18n import t

# ---- IPv4 优先解析（同 tts_say.py）----
# macOS 家宽坑：系统有全局 IPv6 地址但出口路由不通，python 无 Happy Eyeballs，
# getaddrinfo 返回 v6 在前 → 每次请求先卡满 v6 超时才回落 v4（上传/轮询多请求叠加=分钟级卡死，
# 表现为"正在克隆"卡住；开代理可用是因为代理直连 127.0.0.1 恰好绕开 v6）。
# 重排 AF_INET 在前根治；IPv4 不可用时仍按序回落 IPv6。
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_first_getaddrinfo(*args, **kwargs):
    res = _orig_getaddrinfo(*args, **kwargs)
    return sorted(res, key=lambda r: 0 if r[0] == socket.AF_INET else 1)


socket.getaddrinfo = _ipv4_first_getaddrinfo


def log(msg_zh, msg_en):
    # 阶段诊断只走 stderr：Node 侧 --verbose 会逐行转发实时可见，stdout 保持纯 JSON。
    print(f"[voice_clone] {t(msg_zh, msg_en)}", file=sys.stderr, flush=True)


def fail(msg):
    print(json.dumps({"error": msg}))
    # 同步写 stderr：Node 侧 runPython 在非零退出码时只保留 stderr，stdout 会被丢弃，
    # 不写 stderr 的话克隆失败的真实原因（如音频质量/网络）到不了调用方。
    print(f"voice_clone error: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    api_key = os.environ.get("QWEN_TTS_API_KEY", "")
    audio_file = os.environ.get("ARONA_VOICE_AUDIO", "")
    prefix = os.environ.get("ARONA_VOICE_PREFIX", "arona")
    target_model = os.environ.get("QWEN_TTS_MODEL", "qwen-audio-3.0-tts-plus")

    if not api_key:
        fail("QWEN_TTS_API_KEY not set")
    if not audio_file or not os.path.isfile(audio_file):
        fail(f"Audio file not found: {audio_file}")
    if not re.fullmatch(r"[a-z0-9]{1,10}", prefix):
        fail(f"PREFIX must be lowercase alnum, 1-10 chars (got: {prefix})")

    try:
        import dashscope
        from dashscope import Files
        from dashscope.audio.tts_v2 import VoiceEnrollmentService
    except ImportError:
        fail("dashscope package not installed. Run: pip install dashscope")

    dashscope.api_key = api_key

    # 1. Upload audio to DashScope hosted OSS
    try:
        log(f"上传音频 {os.path.basename(audio_file)} 到 DashScope 托管 OSS...",
            f"Uploading {os.path.basename(audio_file)} to DashScope OSS...")
        resp = Files.upload(file_path=audio_file, purpose="voice_clone")
        file_id = resp.output["uploaded_files"][0]["file_id"]
        log(f"上传完成 file_id={file_id}", f"Upload complete file_id={file_id}")
    except Exception as e:
        fail(f"Upload failed: {e}")

    # 2. Get the Alibaba Cloud internal URL (must use internal address)
    try:
        log("获取 OSS 内部地址...", "Getting OSS internal URL...")
        oss_url = Files.get(file_id).output["url"]
        log("OSS 内部地址获取成功", "OSS internal URL acquired")
    except Exception as e:
        fail(f"Failed to get OSS URL: {e}")

    # 3. Submit voice cloning
    try:
        log(f"提交音色克隆（model={target_model}，prefix={prefix}）...",
            f"Submitting voice creation (model={target_model}, prefix={prefix})...")
        svc = VoiceEnrollmentService()
        voice_id = svc.create_voice(target_model=target_model, prefix=prefix, url=oss_url)
        log(f"已提交，voice_id={voice_id}", f"Submitted, voice_id={voice_id}")
    except Exception as e:
        fail(f"create_voice failed: {e}")

    # 4. Wait for voice to be ready (max 5 minutes)
    try:
        for i in range(30):
            info = svc.query_voice(voice_id=voice_id)
            status = info.get("status")
            log(f"查询克隆状态：{status}（第 {i + 1}/30 次，每 10s）",
                f"Voice status: {status} ({i + 1}/30, every 10s)")
            if status == "OK":
                break
            if status == "UNDEPLOYED":
                fail("Voice creation failed. Please check audio quality (10-20s clear voice recommended).")
            time.sleep(10)
        else:
            fail("Timeout waiting for voice to be ready (5 minutes)")
    except Exception as e:
        fail(f"query_voice failed: {e}")

    # 5. Delete the uploaded file (best-effort cleanup)
    try:
        log("删除已上传文件（尽力清理）...", "Deleting uploaded file (best-effort)...")
        Files.delete(file_id)
    except Exception:
        pass  # Cleanup is best-effort

    log(f"音色克隆完成 voice_id={voice_id}", f"Voice clone complete voice_id={voice_id}")
    print(json.dumps({"voice_id": voice_id}))


if __name__ == "__main__":
    main()
