#!/usr/bin/env python3
"""
ARONA 全局热键监听 - pynput 实现

常驻进程，监听全局键盘事件。检测到右 Cmd 长按 >= 2 秒时，
向 stdout 输出一行 JSON {"event":"trigger"}，Node 端接收后触发 STT 录音。

启动时输出 READY 表示就绪。
退出时输出 {"event":"exit"}。

环境变量：
  ARONA_HOTKEY_KEY      - 热键名称（默认 cmd_r，即右 Cmd）
  ARONA_HOTKEY_HOLD_MS  - 长按阈值（默认 2000 毫秒）
"""

import json
import os
import sys
import time
import threading

from _i18n import t


HOLD_MS = int(os.environ.get("ARONA_HOTKEY_HOLD_MS", "2000"))
HOTKEY_NAME = os.environ.get("ARONA_HOTKEY_KEY", "cmd_r")

# pynput key.code 映射
KEY_CODES = {
    "cmd_r": "cmd",
    "cmd_l": "cmd",
    "ctrl_r": "ctrl",
    "ctrl_l": "ctrl",
    "alt_r": "alt",
    "alt_l": "alt",
    "shift_r": "shift",
    "shift_l": "shift",
    "f8": "f8",
    "f7": "f7",
    "f6": "f6",
    "f9": "f9",
}


def emit(obj):
    """输出 JSON 到 stdout 并 flush。"""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    try:
        from pynput import keyboard
    except Exception as e:
        print(t(f"hotkey: 导入 pynput 失败：{e}", f"hotkey: import pynput failed: {e}"), file=sys.stderr)
        sys.exit(1)

    # 目标 key code
    target_code = KEY_CODES.get(HOTKEY_NAME, "cmd")
    if HOTKEY_NAME not in KEY_CODES:
        print(t(
            f"hotkey: 未知的 ARONA_HOTKEY_KEY='{HOTKEY_NAME}'，回退到 'cmd'",
            f"hotkey: unknown ARONA_HOTKEY_KEY='{HOTKEY_NAME}', falling back to 'cmd'",
        ), file=sys.stderr)
    target_is_right = HOTKEY_NAME.endswith("_r")

    state = {"pressed_at": None, "fired": False, "lock": threading.Lock()}

    def on_press(key):
        # 判断是否目标键
        code = None
        is_right = None
        try:
            # pynput 的 key 可能是 KeyCode 或 Key
            if hasattr(key, "name"):
                code = key.name
            elif hasattr(key, "value"):
                code = key.value.vk if hasattr(key.value, "vk") else None
            # 右修饰键判断：pynput 在 macOS 上用 Key.cmd / Key.cmd_l / Key.cmd_r
            if key == keyboard.Key.cmd_r:
                code = "cmd"
                is_right = True
            elif key == keyboard.Key.cmd_l:
                code = "cmd"
                is_right = False
            elif key == keyboard.Key.ctrl_r:
                code = "ctrl"
                is_right = True
            elif key == keyboard.Key.ctrl_l:
                code = "ctrl"
                is_right = False
            elif key == keyboard.Key.alt_r:
                code = "alt"
                is_right = True
            elif key == keyboard.Key.alt_l:
                code = "alt"
                is_right = False
            elif key == keyboard.Key.shift_r:
                code = "shift"
                is_right = True
            elif key == keyboard.Key.shift_l:
                code = "shift"
                is_right = False
            elif key == keyboard.Key.f8:
                code = "f8"
                is_right = None
        except Exception:
            return

        if code != target_code:
            return
        if target_is_right and is_right is not True:
            return
        if not target_is_right and is_right is True and target_code in ("cmd", "ctrl", "alt", "shift"):
            # 左键模式：排除右键
            return

        with state["lock"]:
            if state["pressed_at"] is not None:
                # 已按下，忽略重复
                return
            state["pressed_at"] = time.monotonic()
            state["fired"] = False

    def on_release(key):
        code = None
        is_right = None
        try:
            if key == keyboard.Key.cmd_r:
                code = "cmd"
                is_right = True
            elif key == keyboard.Key.cmd_l:
                code = "cmd"
                is_right = False
            elif key == keyboard.Key.ctrl_r:
                code = "ctrl"
                is_right = True
            elif key == keyboard.Key.ctrl_l:
                code = "ctrl"
                is_right = False
            elif key == keyboard.Key.alt_r:
                code = "alt"
                is_right = True
            elif key == keyboard.Key.alt_l:
                code = "alt"
                is_right = False
            elif key == keyboard.Key.shift_r:
                code = "shift"
                is_right = True
            elif key == keyboard.Key.shift_l:
                code = "shift"
                is_right = False
            elif key == keyboard.Key.f8:
                code = "f8"
                is_right = None
        except Exception:
            return

        if code != target_code:
            return
        if target_is_right and is_right is not True:
            return

        with state["lock"]:
            state["pressed_at"] = None
            state["fired"] = False

    # 长按检测线程：轮询检查是否达到阈值
    def hold_checker():
        while True:
            time.sleep(0.1)
            with state["lock"]:
                pressed_at = state["pressed_at"]
                fired = state["fired"]
                if pressed_at is not None and not fired:
                    elapsed_ms = (time.monotonic() - pressed_at) * 1000
                    if elapsed_ms >= HOLD_MS:
                        state["fired"] = True
                        emit({"event": "trigger"})
            # 检查主线程是否还活着
            if not threading.main_thread().is_alive():
                break

    checker_thread = threading.Thread(target=hold_checker, daemon=True)
    checker_thread.start()

    emit({"event": "ready"})

    try:
        with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
            listener.join()
    except KeyboardInterrupt:
        pass
    finally:
        emit({"event": "exit"})


if __name__ == "__main__":
    main()
