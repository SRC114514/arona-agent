#!/usr/bin/env python3
"""
ARONA Computer Use - cua wrapper (local-only)
Persistent process that reads JSON commands from stdin, writes JSON responses to stdout.

Commands:
  {"action": "screenshot"}                          -> {"screenshot": "<base64>"}
  {"action": "click", "x": 100, "y": 200}           -> {"screenshot": "<base64>"}
  {"action": "click", "x": 100, "y": 200, "button": "right"}  -> {"screenshot": "<base64>"}
  {"action": "type", "text": "hello"}               -> {"screenshot": "<base64>"}
  {"action": "key", "keys": ["ctrl", "c"]}          -> {"screenshot": "<base64>"}
  {"action": "scroll", "x": 100, "y": 200, "direction": "down", "amount": 3} -> {"screenshot": "<base64>"}
  {"action": "move", "x": 100, "y": 200}            -> {"screenshot": "<base64>"}
"""

import asyncio
import json
import sys
import traceback

from _i18n import t


# 需要 macOS 辅助功能权限的操作（pynput 控制鼠标/键盘；截图不需要）
_AX_REQUIRED_ACTIONS = {"click", "type", "key", "scroll", "move"}


def check_accessibility_permission() -> bool:
    """检查 macOS 辅助功能权限（pynput 控制鼠标/键盘需要此权限，截图不需要）。"""
    import platform
    if platform.system() != "Darwin":
        return True
    try:
        import ctypes
        lib = ctypes.cdll.LoadLibrary(
            '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
        )
        lib.AXIsProcessTrustedWithOptions.restype = ctypes.c_bool
        lib.AXIsProcessTrustedWithOptions.argtypes = [ctypes.c_void_p]
        return lib.AXIsProcessTrustedWithOptions(None)
    except Exception:
        return True  # 检查失败时不阻止操作


def check_screen_capture_permission() -> bool:
    """检查 macOS 屏幕录制权限（截图需要此权限；未授权时静默返回空白图）。"""
    import platform
    if platform.system() != "Darwin":
        return True
    try:
        import ctypes
        lib = ctypes.cdll.LoadLibrary(
            '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
        )
        lib.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
        lib.CGPreflightScreenCaptureAccess.argtypes = []
        return lib.CGPreflightScreenCaptureAccess()
    except Exception:
        return True  # 老版本 macOS 无此 API，不阻止


async def main():
    # 检查 macOS 辅助功能权限（pynput 控制鼠标/键盘需要此权限，截图不受影响）
    has_ax_permission = check_accessibility_permission()
    if not has_ax_permission:
        print(t(
            "WARNING: 未授予 macOS 辅助功能权限，鼠标/键盘操作将无法生效（截图不受影响）",
            "WARNING: macOS Accessibility permission not granted — mouse/keyboard actions will not work (screenshot unaffected)",
        ), file=sys.stderr, flush=True)
        print(t(
            "修复方法：系统设置 > 隐私与安全性 > 辅助功能 > 启用运行此程序的终端应用",
            "To fix: System Settings > Privacy & Security > Accessibility > enable the terminal app running this program",
        ), file=sys.stderr, flush=True)

    # 检查 macOS 屏幕录制权限（截图需要此权限；未授权时静默返回空白图，不报错但 AI 看不到真实屏幕）
    has_screen_permission = check_screen_capture_permission()
    if not has_screen_permission:
        print(t(
            "WARNING: 未授予 macOS 屏幕录制权限，截图将返回空白图（不报错但 AI 看不到真实屏幕内容）",
            "WARNING: macOS Screen Recording permission not granted — screenshots will return a blank image (no error, but the AI cannot see the real screen)",
        ), file=sys.stderr, flush=True)
        print(t(
            "修复方法：系统设置 > 隐私与安全性 > 屏幕录制 > 启用运行此程序的终端应用",
            "To fix: System Settings > Privacy & Security > Screen Recording > enable the terminal app running this program",
        ), file=sys.stderr, flush=True)

    # Sandbox mode is hard-wired to local (controls the local machine's mouse/keyboard)
    try:
        from cua import Localhost
        computer = await Localhost.connect()
    except Exception as e:
        print(json.dumps({"error": f"Failed to connect to cua Localhost: {e}"}), flush=True)
        sys.exit(1)

    # Signal ready
    print("READY", flush=True)

    # Read commands from stdin
    loop = asyncio.get_event_loop()

    while True:
        try:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break

            line = line.strip()
            if not line:
                continue

            cmd = json.loads(line)
            if not isinstance(cmd, dict):
                print(json.dumps({"error": "Expected JSON object"}), flush=True)
                continue
            action = cmd.get("action", "")

            result = {}

            if action in _AX_REQUIRED_ACTIONS and not has_ax_permission:
                result = {"error": "macOS 辅助功能权限未授予，无法执行鼠标/键盘操作。请到「系统设置 > 隐私与安全性 > 辅助功能」中为终端应用授权。"}

            elif action == "screenshot" and not has_screen_permission:
                result = {"error": "macOS 屏幕录制权限未授予，截图将返回空白图。请到「系统设置 > 隐私与安全性 > 屏幕录制」中为终端应用授权。"}

            elif action == "screenshot":
                b64 = await computer.screenshot_base64()
                result = {"screenshot": b64}

            elif action == "click":
                x = cmd["x"]
                y = cmd["y"]
                button = cmd.get("button", "left")
                if button == "right":
                    await computer.mouse.right_click(x, y)
                elif button == "double":
                    await computer.mouse.double_click(x, y)
                else:
                    await computer.mouse.click(x, y)
                b64 = await computer.screenshot_base64()
                result = {"screenshot": b64}

            elif action == "type":
                text = cmd["text"]
                await computer.keyboard.type(text)
                b64 = await computer.screenshot_base64()
                result = {"screenshot": b64}

            elif action == "key":
                keys = cmd["keys"]
                await computer.keyboard.keypress(keys)
                b64 = await computer.screenshot_base64()
                result = {"screenshot": b64}

            elif action == "scroll":
                x = cmd["x"]
                y = cmd["y"]
                direction = cmd.get("direction", "down")
                amount = cmd.get("amount", 3)
                # pynput 语义：正 dy = 向上滚动，负 dy = 向下滚动
                scroll_y = -amount if direction == "down" else amount
                await computer.mouse.scroll(x, y, scroll_x=0, scroll_y=scroll_y)
                b64 = await computer.screenshot_base64()
                result = {"screenshot": b64}

            elif action == "move":
                x = cmd["x"]
                y = cmd["y"]
                await computer.mouse.move(x, y)
                b64 = await computer.screenshot_base64()
                result = {"screenshot": b64}

            else:
                result = {"error": f"Unknown action: {action}"}

            print(json.dumps(result), flush=True)

        except json.JSONDecodeError:
            print(json.dumps({"error": "Invalid JSON input"}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e), "trace": traceback.format_exc()}), flush=True)

    # Cleanup
    try:
        await computer.disconnect()
    except Exception:
        pass


if __name__ == "__main__":
    asyncio.run(main())
