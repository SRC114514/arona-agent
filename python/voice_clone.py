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
import sys
import time


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
        resp = Files.upload(file_path=audio_file, purpose="voice_clone")
        file_id = resp.output["uploaded_files"][0]["file_id"]
    except Exception as e:
        fail(f"Upload failed: {e}")

    # 2. Get the Alibaba Cloud internal URL (must use internal address)
    try:
        oss_url = Files.get(file_id).output["url"]
    except Exception as e:
        fail(f"Failed to get OSS URL: {e}")

    # 3. Submit voice cloning
    try:
        svc = VoiceEnrollmentService()
        voice_id = svc.create_voice(target_model=target_model, prefix=prefix, url=oss_url)
    except Exception as e:
        fail(f"create_voice failed: {e}")

    # 4. Wait for voice to be ready (max 5 minutes)
    try:
        for _ in range(30):
            info = svc.query_voice(voice_id=voice_id)
            status = info.get("status")
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
        Files.delete(file_id)
    except Exception:
        pass  # Cleanup is best-effort

    print(json.dumps({"voice_id": voice_id}))


if __name__ == "__main__":
    main()
