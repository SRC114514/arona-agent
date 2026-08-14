#!/usr/bin/env node
// 空闲小动作 · 帧对齐烘焙脚本（仅开发期运行，零 npm 依赖，需系统 ffmpeg）
//
// 问题：空闲眨眼/皱眉在 normal 循环边界硬切进 clip，但 rAF 轮询 currentTime 回绕有
//       ~16ms 检测延迟 + pause 落地延迟，实际冻结帧已越过边界 1-2 帧 → 切入/切出闪跳。
// 方案：离线计算 normal 视频中与 clip 首帧（进入点）/ 末帧（切出点）像素最相似的帧时间戳，
//       运行时等到进入点帧再切；clip 播放期间把 vid 预 seek 到切出点帧，结束后直接续播。
//
// 输出 pet/renderer/idle_sync.js（window.IDLE_SYNC，file:// 直接 <script> 加载，需提交 git）。
//
// 用法：npm run bake:idle
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = {
  video: join(ROOT, "assets", "blue-archive", "arona", "arona_video_normal.webm"),
  clips: {
    eyeClose: join(ROOT, "assets", "blue-archive", "arona", "arona_video_EyeClose.webm"),
  },
  out: join(ROOT, "pet", "renderer", "idle_sync.js"),
  fps: 30,          // normal 采样率（与 EYE_TRACK 一致；输出帧 i 对应 pts = i/30）
  sw: 101, sh: 213, // 降采样尺寸（10x，SAD 足够区分，计算量可忽略）
};
const { sw: SW, sh: SH } = CONFIG;

// ---------- 解帧（ffmpeg rawvideo，可选 fps 重采样）----------
function decodeFrames(file, { fps = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", file];
    if (fps) args.push("-vf", `fps=${fps}`);
    else args.push("-fps_mode", "passthrough"); // clip：不按时戳补帧，取原始帧
    args.push("-s", `${SW}x${SH}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-");
    const proc = spawn("ffmpeg", args);
    const frameSize = SW * SH * 4;
    const frames = [];
    let chunks = [], pending = 0, err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.stdout.on("data", (d) => {
      chunks.push(d);
      pending += d.length;
      while (pending >= frameSize) {
        const buf = Buffer.concat(chunks);
        frames.push(Buffer.from(buf.subarray(0, frameSize)));
        const rest = buf.subarray(frameSize);
        chunks = rest.length ? [rest] : [];
        pending = rest.length;
      }
    });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg 退出码 ${code}: ${err}`));
      resolve(frames);
    });
  });
}

// ---------- 相似度：角色区掩膜内的平均绝对差（越小越像）----------
// 全图白底差分会被背景淹没（角色占比小、整循环 SAD 仅 7.7~8.9），
// 只在"任一帧 alpha>16"的角色区合成白底比较，区分度集中在姿势差异上
function sad(a, b) {
  let sum = 0, n = 0;
  for (let p = 0; p < SW * SH; p++) {
    const o = p * 4;
    if (a[o + 3] <= 16 && b[o + 3] <= 16) continue;
    n++;
    const aa = a[o + 3] / 255, ab = b[o + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const va = a[o + c] * aa + 255 * (1 - aa);
      const vb = b[o + c] * ab + 255 * (1 - ab);
      sum += Math.abs(va - vb);
    }
  }
  return n ? sum / (n * 3) : 255;
}

// 在 normal 帧序列中找与 target 最相似的帧，返回 { idx, time, score, top }
function bestMatch(target, normalFrames, label) {
  const scores = normalFrames.map((f, i) => ({ i, s: sad(target, f) }));
  scores.sort((x, y) => x.s - y.s);
  const best = scores[0];
  const median = scores.map((x) => x.s).sort((a, b) => a - b)[scores.length >> 1];
  const top5 = scores.slice(0, 5).map((x) => `#${x.i}:${x.s.toFixed(2)}`).join(" ");
  console.log(
    `[bake] ${label}: best=#${best.i} t=${(best.i / CONFIG.fps).toFixed(3)}s SAD=${best.s.toFixed(2)}` +
    `（中位 ${median.toFixed(2)}）top5 ${top5}`
  );
  return { idx: best.i, time: best.i / CONFIG.fps, score: best.s, median, top: scores.slice(0, 5) };
}

async function main() {
  const normalFrames = await decodeFrames(CONFIG.video, { fps: CONFIG.fps });
  console.log(`[bake] normal: ${normalFrames.length} frames @${CONFIG.fps}fps（≈${(normalFrames.length / CONFIG.fps).toFixed(2)}s/loop）`);
  if (normalFrames.length < 10) throw new Error("normal 解帧数量异常");

  const eyeClose = await decodeFrames(CONFIG.clips.eyeClose);
  console.log(`[bake] eyeClose: ${eyeClose.length} frames`);
  if (eyeClose.length !== 5) throw new Error("clip 帧数与预期不符（5）");

  const enterBlink = bestMatch(eyeClose[0], normalFrames, "eyeClose 首帧→进入点");
  const exitBlink = bestMatch(eyeClose[eyeClose.length - 1], normalFrames, "eyeClose 末帧→切出点");

  // sanity：最佳匹配显著优于中位（idle 摆动本身细微，比例阈值放宽到 0.95），
  // 且 top5 帧号聚簇（散布 = 匹配噪声，对齐无意义）
  const N = normalFrames.length;
  const checks = [
    ["eyeClose enter", enterBlink], ["eyeClose exit", exitBlink],
  ];
  let failed = false;
  for (const [label, m] of checks) {
    const spread = Math.max(...m.top.map((x) => x.i)) - Math.min(...m.top.map((x) => x.i));
    const ok = m.score < m.median * 0.95 && spread <= N * 0.15;
    console.log(`[bake] ${ok ? "✓" : "✗"} ${label}: SAD ${m.score.toFixed(2)}/${m.median.toFixed(2)}, top5 散布 ${spread} 帧`);
    if (!ok) failed = true;
  }
  if (failed) {
    console.error("[bake] sanity 未通过（clip 首末帧与 normal 任何帧都不像），未写出文件");
    process.exit(1);
  }

  const data = {
    version: 1,
    fps: CONFIG.fps, // 时间戳精度 = 1/fps
    // 单位秒（normal 视频 currentTime）。enter=切入帧起点，exit=切出续播起点
    eyeClose: { enter: +enterBlink.time.toFixed(4), exit: +exitBlink.time.toFixed(4) },
  };
  const js = "// 由 pet/tools/bake_idle_sync.mjs 生成，请勿手改。重新生成：npm run bake:idle\n" +
    "window.IDLE_SYNC = " + JSON.stringify(data) + ";\n";
  writeFileSync(CONFIG.out, js);
  console.log(`[bake] done → ${CONFIG.out}`);
  console.log(`[bake] eyeClose enter=${data.eyeClose.enter}s exit=${data.eyeClose.exit}s`);
}

main().catch((err) => {
  console.error("[bake] 失败:", err.message);
  process.exit(1);
});
