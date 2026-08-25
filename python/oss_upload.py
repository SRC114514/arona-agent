#!/usr/bin/env python3
"""
ARONA OSS Upload — 把本地文件上传到阿里云 DashScope 托管 OSS，返回可长期引用的 URL。

与 voice_clone.py 同一上传通道（dashscope Files.upload / Files.get），但【不删除】已上传文件，
因为返回的 OSS URL 需要长期被云端 GPT-SoVITS 作为 ref_audio_path 引用（删除后 URL 会 404）。

stdin（单行 JSON）:
  {"path": "<本地文件绝对路径>", "apiKey": "<DashScope API Key>"}

stdout:
  {"url": "<OSS URL>"} 成功
  {"error": "..."}     失败

日志走 stderr（保持 stdout 干净 JSON）。
"""

import json
import os
import sys


def fail(msg):
    print(json.dumps({"error": msg}))
    # 同步写 stderr：Node 侧 runPython 在非零退出码时只保留 stderr，不写的话真实原因到不了调用方。
    print(f"oss_upload error: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    line = sys.stdin.readline()
    if not line:
        fail("no stdin input")
    try:
        cmd = json.loads(line)
    except Exception:
        fail("invalid stdin JSON")
    path = (cmd.get("path") or "").strip()
    api_key = (cmd.get("apiKey") or "").strip()
    if not path or not os.path.isfile(path):
        fail(f"File not found: {path}")
    if not api_key:
        fail("DashScope apiKey not set")

    try:
        import dashscope
        from dashscope import Files
    except ImportError:
        fail("dashscope package not installed. Run: pip install dashscope")

    dashscope.api_key = api_key

    # 1. Upload to DashScope hosted OSS
    try:
        resp = Files.upload(file_path=path, purpose="voice_clone")
        file_id = resp.output["uploaded_files"][0]["file_id"]
    except Exception as e:
        fail(f"Upload failed: {e}")

    # 2. Get the OSS URL (长期有效，可被云端服务端引用)
    try:
        oss_url = Files.get(file_id).output["url"]
    except Exception as e:
        fail(f"Failed to get OSS URL: {e}")

    print(json.dumps({"url": oss_url}))


if __name__ == "__main__":
    main()
