#!/usr/bin/env python3
"""ARONA i18n 辅助（仅用于 stderr 人读日志；stdout 协议通道禁止使用）。

语言判定优先级：ARONA_LANG（Node 注入，最可靠）> LANG 环境变量。
协议通道（stdout JSON / READY / 事件名 / 识别文本）为结构豁免，不得翻译。
"""

import os


def is_en() -> bool:
    """是否英文模式。ARONA_LANG 由 Node 侧 src/utils/python.ts 注入。"""
    return (os.environ.get("ARONA_LANG") or os.environ.get("LANG") or "").startswith("en")


def t(zh: str, en: str) -> str:
    """按当前语言返回中英两版文案之一。"""
    return en if is_en() else zh
