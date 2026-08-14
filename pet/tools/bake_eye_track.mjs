#!/usr/bin/env node
// 桌宠瞳孔跟随 · 离线烘焙脚本（仅开发期运行，零 npm 依赖，需系统 ffmpeg）
//
// 模型（Live2D 式整体虹膜位移）：
//   Arona 的眼睛无独立瞳孔分界——虹膜是一整块蓝紫渐变椭圆（顶部深海军蓝、底部青色高光），
//   两侧为白色巩膜，上缘被深棕色眼睑线压住。因此"注视"= 整个虹膜内容在眼窝内平移：
//   - sprite：虹膜 blob（含高光），按候选色分割 + 最大连通域提取，软边 alpha
//   - patch ：原位抹除虹膜后的干净眼窝（扩散式 inpaint，填入巩膜白/睑影）
//   运行时先贴 patch 盖住原虹膜，再把 sprite 按鼠标方向偏移绘制——看向一侧时另一侧露出眼白。
//
// 输出单文件 pet/renderer/eye_track.js（window.EYE_TRACK，base64 内嵌，file:// 直接 <script> 加载）。
//
// 用法：npm run bake:eye        （--preview 额外输出运行时合成模拟图供人工抽检）
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = {
  video: join(ROOT, "assets", "blue-archive", "arona", "arona_video_normal.webm"),
  out: join(ROOT, "pet", "renderer", "eye_track.js"),
  videoW: 1010,
  videoH: 2128,
  fps: 30,                        // 采样率（运行时按 currentTime 插值，无需与源帧率一致）
  box: { x0: 310, y0: 320, x1: 650, y1: 620 },  // 眼睛搜索框（视频坐标，含安全边）
  margin: 3,                      // sprite/patch 相对虹膜 bbox 的外扩
  maxOffX: 8,                     // 运行时水平最大偏移（视频 px，过大虹膜会压睑线）
  maxOffY: 5,                     // 垂直最大偏移（上方有睑线，收紧）
  preview: process.argv.includes("--preview"),
};
const { videoW: W, videoH: H } = CONFIG;
const BOX = CONFIG.box;
const BW = BOX.x1 - BOX.x0;
const BH = BOX.y1 - BOX.y0;

// ---------- 颜色 ----------
function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx === 0 ? 0 : d / mx, mx / 255];
}

// 虹膜候选色：蓝~蓝紫~青色（含深海军蓝顶部与青色高光），排除棕/白/肤/浅色发
//   深棕睑线 b<r 排除；白巩膜 s<0.1 排除；肤色 hue 排除；浅青发 s 低且与虹膜不连通
function isEyeContent(r, g, b) {
  const [h, s, v] = rgb2hsv(r, g, b);
  return h >= 178 && h <= 272 && s > 0.22 && v > 0.12 && b > r + 12;
}

// ---------- 最大连通域（4 连通洪泛）----------
function largestComponent(mask, w, h) {
  const visited = new Uint8Array(w * h);
  let best = null;
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || visited[i]) continue;
    let area = 0, sx = 0, sy = 0, minX = w, minY = h, maxX = 0, maxY = 0;
    const pixels = [];
    visited[i] = 1;
    stack.length = 0;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      pixels.push(p);
      const push = (q) => { if (!visited[q] && mask[q]) { visited[q] = 1; stack.push(q); } };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    if (!best || area > best.area) {
      best = { area, cx: sx / area, cy: sy / area, minX, minY, maxX, maxY, pixels };
    }
  }
  return best;
}

// ---------- 解帧（ffmpeg rawvideo 流式）----------
function decodeFrames(onFrame) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-v", "error", "-i", CONFIG.video,
      "-vf", `fps=${CONFIG.fps}`,
      "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ]);
    const frameSize = W * H * 4;
    let chunks = [], pending = 0, fi = 0, err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.stdout.on("data", (d) => {
      chunks.push(d);
      pending += d.length;
      while (pending >= frameSize) {
        const buf = Buffer.concat(chunks);
        onFrame(buf.subarray(0, frameSize), fi++);
        const rest = buf.subarray(frameSize);
        chunks = rest.length ? [rest] : [];
        pending = rest.length;
      }
    });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg 退出码 ${code}: ${err}`));
      resolve(fi);
    });
  });
}

// ---------- 每帧检测：虹膜 blob ----------
function detectFrame(frame) {
  const mask = new Uint8Array(BW * BH);
  for (let by = 0; by < BH; by++) {
    const rowOff = ((BOX.y0 + by) * W + BOX.x0) * 4;
    for (let bx = 0; bx < BW; bx++) {
      const o = rowOff + bx * 4;
      if (isEyeContent(frame[o], frame[o + 1], frame[o + 2])) mask[by * BW + bx] = 1;
    }
  }
  const iris = largestComponent(mask, BW, BH);
  if (!iris || iris.area < 800 || iris.area > 6000) return null;
  return {
    icx: BOX.x0 + iris.cx, icy: BOX.y0 + iris.cy,           // 虹膜质心（视频坐标）
    bbox: { minX: iris.minX, minY: iris.minY, maxX: iris.maxX, maxY: iris.maxY },  // box 坐标
    pixels: iris.pixels,                                     // box 坐标下标
    area: iris.area,
  };
}

// ---------- 扩散式 inpaint ----------
function inpaint(patch, S, mask) {
  const known = new Uint8Array(S * S);
  let remaining = 0;
  for (let i = 0; i < S * S; i++) { known[i] = mask[i] ? 0 : 1; remaining += mask[i]; }
  const nbrs = (p) => {
    const x = p % S, y = (p / S) | 0, out = [];
    if (x > 0) out.push(p - 1);
    if (x < S - 1) out.push(p + 1);
    if (y > 0) out.push(p - S);
    if (y < S - 1) out.push(p + S);
    return out;
  };
  for (let round = 0; round < 300 && remaining > 0; round++) {
    const fill = [];
    for (let p = 0; p < S * S; p++) {
      if (known[p]) continue;
      const kn = nbrs(p).filter((q) => known[q]);
      if (kn.length >= 2) fill.push([p, kn]);
    }
    if (!fill.length) break;
    for (const [p, kn] of fill) {
      let r = 0, g = 0, b = 0;
      for (const q of kn) { r += patch[q * 4]; g += patch[q * 4 + 1]; b += patch[q * 4 + 2]; }
      patch[p * 4] = r / kn.length;
      patch[p * 4 + 1] = g / kn.length;
      patch[p * 4 + 2] = b / kn.length;
      patch[p * 4 + 3] = 255;
      known[p] = 1;
      remaining--;
    }
  }
  // 兜底：≥1 已知邻居 → 邻居均值；再不行 → 全局均值
  for (let pass = 0; pass < 2 && remaining > 0; pass++) {
    let gr = 0, gg = 0, gb = 0, gn = 0;
    for (let p = 0; p < S * S; p++) if (known[p]) { gr += patch[p * 4]; gg += patch[p * 4 + 1]; gb += patch[p * 4 + 2]; gn++; }
    for (let p = 0; p < S * S; p++) {
      if (known[p]) continue;
      const kn = nbrs(p).filter((q) => known[q]);
      if (!kn.length && pass === 0) continue;
      let r = gr / gn, g = gg / gn, b = gb / gn;
      if (kn.length) {
        r = 0; g = 0; b = 0;
        for (const q of kn) { r += patch[q * 4]; g += patch[q * 4 + 1]; b += patch[q * 4 + 2]; }
        r /= kn.length; g /= kn.length; b /= kn.length;
      }
      patch[p * 4] = r; patch[p * 4 + 1] = g; patch[p * 4 + 2] = b; patch[p * 4 + 3] = 255;
      known[p] = 1;
      remaining--;
    }
  }
}

// ---------- 最小 PNG 编码器（RGBA8，逐行 filter=0）----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 主流程 ----------
async function main() {
  const frames = [];   // 每帧 { det, boxCopy }
  let failCount = 0;
  const N = await decodeFrames((frame) => {
    let det = detectFrame(frame);
    if (!det) {
      failCount++;
      det = frames.length ? { ...frames[frames.length - 1].det } : null;   // 沿用上一帧
    }
    // 存搜索框副本（340x300x4 ≈ 400KB/帧，供 patch/sprite/抽检使用）
    const boxCopy = Buffer.alloc(BW * BH * 4);
    for (let by = 0; by < BH; by++) {
      frame.copy(boxCopy, by * BW * 4, ((BOX.y0 + by) * W + BOX.x0) * 4, ((BOX.y0 + by) * W + BOX.x1) * 4);
    }
    frames.push({ det, boxCopy });
  });
  console.log(`[bake] ${N} frames decoded`);
  if (!frames[0].det) throw new Error("第 0 帧检测失败，请调整 CONFIG.box / 分割阈值");

  // 统一 cell 尺寸 S：虹膜 bbox 最大包络 + margin，取整到 8 的倍数
  let maxW = 0, maxH = 0;
  for (const { det } of frames) {
    maxW = Math.max(maxW, det.bbox.maxX - det.bbox.minX + 1);
    maxH = Math.max(maxH, det.bbox.maxY - det.bbox.minY + 1);
  }
  const S = Math.ceil((Math.max(maxW, maxH) + CONFIG.margin * 2) / 8) * 8;

  // 每帧：patch（inpaint 抹除虹膜）+ sprite（虹膜 RGBA，边缘 1px 羽化）
  const framesData = [];   // 每帧 4 int：[sx, sy, icx, icy]
  const patches = [];
  const sprites = [];
  for (const { det, boxCopy } of frames) {
    // cell 原点（box 坐标）：以虹膜 bbox 中心为基准，尺寸统一 S
    const bcx = (det.bbox.minX + det.bbox.maxX) / 2;
    const bcy = (det.bbox.minY + det.bbox.maxY) / 2;
    const ox = Math.max(0, Math.min(Math.round(bcx - S / 2), BW - S));
    const oy = Math.max(0, Math.min(Math.round(bcy - S / 2), BH - S));

    // 虹膜 mask → cell 坐标
    const cellMask = new Uint8Array(S * S);
    for (const p of det.pixels) {
      const bx = p % BW, by = (p / BW) | 0;
      const mx = bx - ox, my = by - oy;
      if (mx >= 0 && mx < S && my >= 0 && my < S) cellMask[my * S + mx] = 1;
    }

    // patch：原图拷贝 + inpaint（遮罩膨胀 2px 吃掉抗锯齿残边）
    // 关键：patch 只保留抹除区（羽毛边 alpha，其余全透明）——
    // 睑线/发丝始终来自活体视频，避免整格不透明截图与当前帧对不上产生重影
    const patch = Buffer.alloc(S * S * 4);
    for (let y = 0; y < S; y++) {
      boxCopy.copy(patch, y * S * 4, ((oy + y) * BW + ox) * 4, ((oy + y) * BW + ox + S) * 4);
    }
    const dilate1 = (src) => {
      const out = new Uint8Array(S * S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          if (!src[y * S + x]) continue;
          for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const mx = x + dx, my = y + dy;
            if (mx >= 0 && mx < S && my >= 0 && my < S) out[my * S + mx] = 1;
          }
        }
      }
      return out;
    };
    const m1 = dilate1(cellMask);       // 外扩 1 圈
    const iMask = dilate1(m1);          // 外扩 2 圈（inpaint 遮罩）
    inpaint(patch, S, iMask);
    // alpha 羽化：mask 内 255，第 1 圈 170，第 2 圈 90，其余透明
    for (let p = 0; p < S * S; p++) {
      patch[p * 4 + 3] = cellMask[p] ? 255 : m1[p] ? 170 : iMask[p] ? 90 : 0;
    }
    patches.push(patch);

    // sprite：原图 + alpha（mask 内 255，边缘 1px 羽化 128，其余 0）
    const sprite = Buffer.alloc(S * S * 4);
    const isEdge = (x, y) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= S || ny < 0 || ny >= S || !cellMask[ny * S + nx]) return true;
      }
      return false;
    };
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const c = y * S + x;
        if (!cellMask[c]) continue;
        const src = ((oy + y) * BW + ox + x) * 4;
        const dst = c * 4;
        sprite[dst] = boxCopy[src];
        sprite[dst + 1] = boxCopy[src + 1];
        sprite[dst + 2] = boxCopy[src + 2];
        sprite[dst + 3] = isEdge(x, y) ? 128 : 255;
      }
    }
    sprites.push(sprite);

    framesData.push(BOX.x0 + ox, BOX.y0 + oy, Math.round(det.icx), Math.round(det.icy));
  }

  // atlas：每帧占 2 列（左 patch 右 sprite），cols 帧一行
  const cols = 10, rows = Math.ceil(N / cols);
  const atlasW = cols * 2 * S, atlasH = rows * S;
  const atlas = Buffer.alloc(atlasW * atlasH * 4);
  const blit = (src, cellCol, cellRow) => {
    for (let y = 0; y < S; y++) {
      src.copy(atlas, ((cellRow * S + y) * atlasW + cellCol * S) * 4, y * S * 4, (y + 1) * S * 4);
    }
  };
  patches.forEach((p, i) => blit(p, (i % cols) * 2, (i / cols) | 0));
  sprites.forEach((s, i) => blit(s, (i % cols) * 2 + 1, (i / cols) | 0));

  const atlasPng = encodePng(atlasW, atlasH, atlas);
  const data = {
    version: 2, videoW: W, videoH: H, fps: CONFIG.fps,
    cellSize: S, atlasCols: cols,
    maxOff: { x: CONFIG.maxOffX, y: CONFIG.maxOffY },
    // 每帧 4 int：[sx, sy, icx, icy]（cell 原点 + 虹膜质心，视频 px）
    frames: framesData,
    atlas: "data:image/png;base64," + atlasPng.toString("base64"),
  };
  const js = "// 由 pet/tools/bake_eye_track.mjs 生成，请勿手改。重新生成：npm run bake:eye\n" +
    "window.EYE_TRACK = " + JSON.stringify(data) + ";\n";
  writeFileSync(CONFIG.out, js);

  // ---------- sanity 自检 ----------
  const failRate = failCount / N;
  let maxJump = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].det, b = frames[i].det;
    maxJump = Math.max(maxJump, Math.hypot(a.icx - b.icx, a.icy - b.icy));
  }
  const areas = frames.map((f) => f.det.area);
  const areaMean = areas.reduce((s, v) => s + v, 0) / N;
  const areaStd = Math.sqrt(areas.reduce((s, v) => s + (v - areaMean) ** 2, 0) / N);
  const checks = [
    [`iris detect: ok=${N - failCount} fail=${failCount} (${(failRate * 100).toFixed(1)}% < 5%)`, failRate < 0.05],
    [`iris centroid 逐帧跳变 max=${maxJump.toFixed(1)}px (< 25)`, maxJump < 25],
    [`iris area: mean=${areaMean.toFixed(0)} stddev=${areaStd.toFixed(0)} (< 15%)`, areaStd / areaMean < 0.15],
  ];
  let failed = false;
  for (const [msg, ok] of checks) {
    console.log(`[bake] ${ok ? "✓" : "✗"} ${msg}`);
    if (!ok) failed = true;
  }
  console.log(`[bake] cell=${S}px, atlas=${atlasW}x${atlasH}, eye_track.js=${(js.length / 1024).toFixed(0)}KB`);
  if (failed) {
    console.error("[bake] sanity 检查未通过，未产出可信数据（文件已写出但请勿提交）");
    process.exit(1);
  }

  // ---------- 抽检图（红=虹膜 mask，白十字=质心，黄框=cell）----------
  const dumpIdx = [0, N >> 1, N - 1];
  for (const i of dumpIdx) {
    const { det, boxCopy } = frames[i];
    const scale = 2;
    const img = Buffer.alloc(BW * scale * BH * scale * 4);
    const pixSet = new Set(det.pixels);
    for (let y = 0; y < BH * scale; y++) {
      for (let x = 0; x < BW * scale; x++) {
        const bx = x >> 1, by = y >> 1;
        const src = (by * BW + bx) * 4, dst = (y * BW * scale + x) * 4;
        let r = boxCopy[src], g = boxCopy[src + 1], b = boxCopy[src + 2];
        if (pixSet.has(by * BW + bx)) { r = r * 0.5 + 128; g = g * 0.5; b = b * 0.5; }
        img[dst] = r; img[dst + 1] = g; img[dst + 2] = b; img[dst + 3] = 255;
      }
    }
    const setPx = (x, y, r, g, b) => {
      if (x < 0 || x >= BW * scale || y < 0 || y >= BH * scale) return;
      const dst = (y * BW * scale + x) * 4;
      img[dst] = r; img[dst + 1] = g; img[dst + 2] = b; img[dst + 3] = 255;
    };
    for (let d = -8; d <= 8; d++) {
      setPx(Math.round(det.icx - BOX.x0) * scale + d, Math.round(det.icy - BOX.y0) * scale, 255, 255, 255);
      setPx(Math.round(det.icx - BOX.x0) * scale, Math.round(det.icy - BOX.y0) * scale + d, 255, 255, 255);
    }
    const cx0 = (framesData[i * 4] - BOX.x0) * scale, cy0 = (framesData[i * 4 + 1] - BOX.y0) * scale;
    for (let d = 0; d < S * scale; d++) {
      setPx(cx0 + d, cy0, 255, 255, 0); setPx(cx0 + d, cy0 + S * scale - 1, 255, 255, 0);
      setPx(cx0, cy0 + d, 255, 255, 0); setPx(cx0 + S * scale - 1, cy0 + d, 255, 255, 0);
    }
    const p = join(tmpdir(), `eye_debug_f${i}.png`);
    writeFileSync(p, encodePng(BW * scale, BH * scale, img));
    console.log(`[bake] 抽检图: ${p}`);
  }

  // ---------- --preview：模拟运行时合成（patch 盖原虹膜 + sprite 偏移 (+10,+4)）----------
  if (CONFIG.preview) {
    const off = { x: CONFIG.maxOffX, y: 4 };
    const blend = (img, cell, dx0, dy0) => {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const s = (y * S + x) * 4, a = cell[s + 3] / 255;
          if (a === 0) continue;
          const dx = dx0 + x, dy = dy0 + y;
          if (dx < 0 || dx >= BW || dy < 0 || dy >= BH) continue;
          const d = (dy * BW + dx) * 4;
          img[d] = cell[s] * a + img[d] * (1 - a);
          img[d + 1] = cell[s + 1] * a + img[d + 1] * (1 - a);
          img[d + 2] = cell[s + 2] * a + img[d + 2] * (1 - a);
        }
      }
    };
    for (const i of dumpIdx) {
      const { boxCopy } = frames[i];
      const img = Buffer.from(boxCopy);
      const ox = framesData[i * 4] - BOX.x0, oy = framesData[i * 4 + 1] - BOX.y0;
      blend(img, patches[i], ox, oy);                 // patch（羽毛 alpha）盖原位
      blend(img, sprites[i], ox + off.x, oy + off.y); // sprite 偏移重绘
      // 裁眼部区域放大 3x
      const cw = 160, ch = 120;
      const cx0 = Math.max(0, Math.min(Math.round(frames[i].det.icx - BOX.x0) - cw / 2, BW - cw));
      const cy0 = Math.max(0, Math.min(Math.round(frames[i].det.icy - BOX.y0) - ch / 2, BH - ch));
      const crop = Buffer.alloc(cw * 3 * ch * 3 * 4);
      for (let y = 0; y < ch * 3; y++) {
        for (let x = 0; x < cw * 3; x++) {
          const src = ((cy0 + (y / 3 | 0)) * BW + cx0 + (x / 3 | 0)) * 4;
          img.copy(crop, (y * cw * 3 + x) * 4, src, src + 4);
        }
      }
      const p = join(tmpdir(), `eye_preview_f${i}.png`);
      writeFileSync(p, encodePng(cw * 3, ch * 3, crop));
      console.log(`[bake] 合成预览: ${p}`);
    }
  }
  console.log(`[bake] done → ${CONFIG.out}`);
}

main().catch((err) => {
  console.error("[bake] 失败:", err.message);
  process.exit(1);
});
