#!/usr/bin/env python3
"""Spine 4.x atlas → 3.8 atlas 转换（配套 4.x→3.8 骨骼降级用，如 wang606/SpineSkeletonDataConverter）。

要点：
- 4.x bounds = 未旋转足迹 (x,y,w,h)；rotate:90/270 时存储矩形宽高对调，rotate:180 不变。
  （用 offsets 交叉验证：offset_y + bounds_h ≈ orig_h，说明 bounds 高 = 未旋转高。）
- 3.8 atlas 对 rotate:true 的 size 写未旋转宽高（loader 内部转置：u2 = x + height）。
- rotate:180 → 原位把存储矩形像素旋转 180°，flag 写 false；rotate:270 → 同样旋转 180° 后
  flag 写 true（R270 = R180∘R90，loader 90° 反旋转 + 像素预翻转合成出正确朝向）。
- 页面头丢弃 scale/pma 行（3.8 spine-ts 解析器按固定顺序读 size/format/filter/repeat，
  多余行会串位）；bounds 即 PNG 字面像素，不做 scale 缩放。
- 4.x 打包器用多边形打包，bounds bbox 重叠属正常，不做重叠校验。

用法：python3 atlas_4x_to_3x.py <in.atlas> <in.png> <out.atlas.txt> <out.png>
"""

import re
import sys
from PIL import Image

REGION_KEYS = ("bounds", "offsets", "rotate", "index", "splits", "pads")
PAGE_KEYS = ("size", "format", "filter", "repeat", "scale", "pma")


def parse_4x(path):
    page = {"name": None, "regions": []}
    region = None
    for line in open(path, encoding="utf-8").read().splitlines():
        s = line.strip()
        if not s:
            continue
        key, _, val = s.partition(":")
        is_kv = val != "" and key in PAGE_KEYS + REGION_KEYS
        if region is not None and is_kv:
            region[key] = val.strip()
        elif region is not None:
            page["regions"].append(region)
            region = {"name": s}
        elif page["name"] is None:
            page["name"] = s
        elif is_kv:
            page[key] = val.strip()
        else:
            region = {"name": s}
    if region:
        page["regions"].append(region)
    return page


def to_int(s, default=0):
    try:
        return int(round(float(s)))
    except ValueError:
        return default


def main():
    if len(sys.argv) != 5:
        print(__doc__)
        sys.exit(2)
    in_atlas, in_png, out_atlas, out_png = sys.argv[1:5]

    page = parse_4x(in_atlas)
    img = Image.open(in_png).convert("RGBA")
    if img.size != tuple(to_int(v) for v in page["size"].split(",")):
        print(f"警告: png 尺寸 {img.size} 与 atlas size {page['size']} 不一致，按 png 实际尺寸处理")

    lines = [
        out_png.rsplit("/", 1)[-1].rsplit("\\", 1)[-1],
        f"size: {img.size[0]},{img.size[1]}",
        f"format: {page.get('format', 'RGBA8888')}",
        f"filter: {page.get('filter', 'Linear,Linear')}",
        f"repeat: {page.get('repeat', 'none')}",
    ]
    for r in page["regions"]:
        x, y, w, h = (to_int(v) for v in r["bounds"].split(","))
        ox, oy, ow, oh = (to_int(v) for v in r.get("offsets", "0,0,0,0").split(","))
        deg = to_int(r.get("rotate", "0"))
        if deg == 90:
            flag = "true"
        elif deg in (180, 270):
            sw, sh = (h, w) if deg == 270 else (w, h)
            rect = img.crop((x, y, x + sw, y + sh)).transpose(Image.ROTATE_180)
            img.paste(rect, (x, y))
            flag = "true" if deg == 270 else "false"
        else:
            flag = "false"
        lines += [
            r["name"],
            f"  rotate: {flag}",
            f"  xy: {x}, {y}",
            f"  size: {w}, {h}",
            f"  orig: {ow}, {oh}",
            f"  offset: {ox}, {oy}",
            "  index: -1",
        ]
    img.save(out_png)
    open(out_atlas, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    flipped = sum(1 for r in page["regions"] if to_int(r.get("rotate", "0")) in (180, 270))
    print(f"完成: {len(page['regions'])} 区域（{flipped} 个 180/270 已翻转像素）→ {out_atlas}, {out_png}")


if __name__ == "__main__":
    main()
