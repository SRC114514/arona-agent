// ARONA 桌宠渲染层：Spine 骨骼动画基底 + 情绪 PNG 单向溶解过渡 + 手动拖动 + 摇动彩蛋（摸头）
// 过渡模型：目标层垫底 opacity=1 常亮，当前层在顶部 opacity 1→0 单向淡出（WAAPI）。
// 任意时刻至少一层完全不透明（角色区合成 alpha 恒为 1），透明窗口下桌面不会透出 → 无残影。
// 基底是活的 Spine（Idle_01 常驻、永不隐藏）：情绪 PNG 溶解消失后露出的是动画而非定帧。
// 摸头（头部摇动 ≥3 次换向触发）：Spine Dev_Pat_01_M 循环 + Head_Rot ±15° 跟随光标，窗口锁死不动。
// 空闲注视：基底稳定态 Head_Rot ±5° 慢速跟随光标（spine_layer.js 内部实现）。
// 眨眼：Eye_Close_01 独立轨道（track1），2~6s 均匀随机，15% 概率双眨。
const slots = [document.getElementById("emoA"), document.getElementById("emoB")];
const spineCanvas = document.getElementById("spine");

const ARONA_BASE = "../../assets/blue-archive/arona/";
const IS_IDLE_DEBUG = new URLSearchParams(location.search).has("idledebug");
let emotions = {};

function emotionUrl(name) {
  const file = emotions[name];
  return file ? ARONA_BASE + file : null;
}

// ---- 情绪切换：单向溶解过渡状态机 ----
const TRANSITION_MS = 200;

// 稳定态：{ kind:"spine" } | { kind:"emotion", name, slotEl }
let cur = { kind: "spine" };
// 进行中的过渡（含 prep 阶段）：{ seq, target, from, to, slotEl, direction, anims, committed }
let inflight = null;
let seqCounter = 0;
// 当前稳定态情绪名（spine 基底时为 null），供基底恢复时选择介导 exit 动画
let currentEmotion = null;

function sideEl(side) {
  if (side.kind === "spine") return spineCanvas;
  return side.slotEl;
}

function sideTarget(side) {
  return side.kind === "spine" ? "spine" : side.name;
}

// 层序归位（静态层序由 style.css 提供：spine 1 / slot 3）
function resetLayers() {
  for (const s of slots) s.style.zIndex = "";
}

// 过渡落定后隐藏一侧：spine 侧 no-op（基底继续渲染、继续播 Idle——露出的是活动画）
function hideSide(side) {
  const el = sideEl(side);
  el.style.display = "none";
  el.style.opacity = "";
  if (side.kind === "emotion") el.removeAttribute("src");
}

// 过渡落定后一侧成为稳定态：spine 侧 no-op（永远在播）
function showSide(side) {
  const el = sideEl(side);
  el.style.display = "block";
  el.style.opacity = "";
}

function applyFinalState(t) {
  for (const a of t.anims) a.cancel();
  if (t.direction === "out") {
    hideSide(t.from);
    showSide(t.to);
    cur = t.to;
  } else {
    hideSide(t.to);
    showSide(t.from);
    cur = t.from;
  }
  resetLayers();
}

function completeTransition(t, anim) {
  // 仅响应当前动画的自然结束（回播/落定会替换 t.anims 或清空 inflight，旧回调一律忽略）
  if (inflight !== t || t.anims[0] !== anim) return;
  inflight = null;
  applyFinalState(t);
}

// 启动已提交的过渡动画：from 在顶、to 垫底常亮
// direction "out"：from 淡出（正常方向）；"in"：from 淡回（中断反向回播）
function startAnimation(t, startOp) {
  const topEl = sideEl(t.from);
  const botEl = sideEl(t.to);

  // 层序：情绪 slot 提到最顶（spine 基底永远是垫底 z1）
  if (t.from.kind === "emotion") t.from.slotEl.style.zIndex = "4";
  botEl.style.display = "block";
  botEl.style.opacity = "1";
  topEl.style.display = "block";

  const targetOp = t.direction === "out" ? 0 : 1;
  // 回播场景 startOp<1，时长等比缩短，溶解速率一致
  const dur = Math.max(1, TRANSITION_MS * Math.abs(targetOp - startOp));
  const opts = { duration: dur, easing: "linear", fill: "forwards" };
  const anim = topEl.animate([{ opacity: startOp }, { opacity: targetOp }], opts);
  t.anims = [anim];
  anim.finished.then(() => completeTransition(t, anim)).catch(() => {});
}

// prep 期被抢占：撤销不可见的准备工作（此刻 cur 仍完全不透明地显示着，无视觉变化）
function abortPrep(t) {
  if (t.slotEl) t.slotEl.removeAttribute("src");
}

// 中断情形 1：反向回播（新目标 == 正在淡出的 from 侧），从当前 opacity 原路退回，零跳变
function reverseInflight(mySeq) {
  const t = inflight;
  const topEl = sideEl(t.from);
  let op = parseFloat(getComputedStyle(topEl).opacity);
  if (!Number.isFinite(op)) op = 1;
  // cancel 前显式锁定当前透明度，避免 WAAPI cancel 后浏览器回退到默认值 1 造成闪帧
  topEl.style.opacity = String(op);
  for (const a of t.anims) a.cancel();
  t.direction = "in";
  t.seq = mySeq;
  t.target = sideTarget(t.from);
  startAnimation(t, op);
}

// 中断情形 3：第三者闯入，瞬间落定当前过渡（≤200ms 进度步进），再由调用方按新目标重启
function settleInflight() {
  const t = inflight;
  inflight = null;
  applyFinalState(t);
}

async function transitionTo(target) {
  // 幂等：已在目标稳定态；续播：正在向目标过渡（含 prep）
  if (!inflight && sideTarget(cur) === target) return;
  if (inflight && inflight.target === target) return;

  const mySeq = ++seqCounter;

  if (inflight && inflight.committed) {
    if (sideTarget(inflight.from) === target) {
      reverseInflight(mySeq);
      return;
    }
    settleInflight();
  } else if (inflight) {
    abortPrep(inflight);
    inflight = null;
  }

  const t = {
    seq: mySeq,
    target,
    from: cur,
    to: null,
    slotEl: null,
    direction: "out",
    anims: [],
    committed: false,
  };
  inflight = t;

  // ---- prep（仅不可见变更；每个 await 后检查是否被抢占）----
  if (target === "spine") {
    // 无需 prep：基底永远在播（emotion→spine 溶解可直接开始）
    t.to = { kind: "spine" };
  } else {
    const url = emotionUrl(target);
    if (!url) {
      if (inflight === t) inflight = null;
      return;
    }
    // 双 slot：当前显示占一个，目标用另一个
    const slotEl = cur.kind === "emotion" && cur.slotEl === slots[0] ? slots[1] : slots[0];
    t.slotEl = slotEl;
    slotEl.src = url;
    // decode 完成再开始动画，避免透明窗口下闪白（情绪图已预加载，实际秒回）
    try { await slotEl.decode(); } catch {}
    if (inflight !== t) return;
    t.to = { kind: "emotion", name: target, slotEl };
  }

  // ---- commit（同步可见变更 + 启动动画）----
  t.committed = true;
  startAnimation(t, 1);
}

// ---- 情绪 ↔ Spine 介导姿态（旧 clip 介导过渡的免费替代，Step 6）----
// 情绪 PNG 溶解盖上的同时，track0 crossfade 到对应姿态——PNG 溶解退出时底下姿势已衔接。
// enter 是单帧 pose 时非循环持有；exit 播完由 spine_layer 自动接回 Idle_01。
const EMOTION_SPINE_ANIM = {
  saying: { enter: "Look_01_A", exit: "LookEnd_01_A" },
  doubt:  { enter: "Look_01_M", exit: "LookEnd_01_M" },
  tired:  { enter: "Eye_Close_01" },
  enjoy:  { enter: "Pat_01_A" },
};

function applyBaseHooks(target) {
  const L = window.SpineLayer;
  if (target === "spine") {
    // 回基底：先播 exit 介导动画（如有）再接 Idle；开启空闲注视
    const prev = currentEmotion;
    currentEmotion = null;
    if (prev && EMOTION_SPINE_ANIM[prev] && EMOTION_SPINE_ANIM[prev].exit) {
      L.setEmotionPose(null, EMOTION_SPINE_ANIM[prev].exit);
    } else {
      L.clearEmotionPose();
    }
    L.setGaze(true);
  } else {
    currentEmotion = target;
    L.setGaze(false);
    const m = EMOTION_SPINE_ANIM[target];
    if (m) L.setEmotionPose(m.enter || null, null);
    else L.clearEmotionPose();
  }
}

// 路由入口：摸头中收到新指令先结束摸头（crossfade 回 Idle），再正常路由
async function routeTo(target) {
  if (window.SpineLayer.getState().patting) window.SpineLayer.endPat();
  applyBaseHooks(target);
  await transitionTo(target);
}

// ---- 眨眼调度（2~6s 均匀随机，15% 概率双眨；?idledebug 缩短为 1~2s 供视觉回归截获）----
let blinkTimer = null;

function scheduleBlink() {
  const delay = IS_IDLE_DEBUG
    ? 1000 + Math.random() * 1000
    : 2000 + Math.random() * 4000;
  blinkTimer = setTimeout(() => {
    tryBlink();
    scheduleBlink();
  }, delay);
}

function tryBlink() {
  // 忙时跳过本次并重排：情绪 PNG 显示中（底下眨眼看不到）、DOM 过渡中、摸头/介导姿态中
  if (cur.kind !== "spine" || inflight) return;
  if (!window.SpineLayer.blink()) return;
  if (Math.random() < 0.15) {
    // 双眨：第一次（0.133s）结束后 150~250ms 再来一次
    setTimeout(() => {
      if (cur.kind === "spine" && !inflight) window.SpineLayer.blink();
    }, 300 + Math.random() * 150);
  }
}

function showEmotion(name) {
  if (!emotionUrl(name)) return;
  routeTo(name);
}

function resetToBase() {
  routeTo("spine");
}

// ---- 拖动与摇动检测 ----
// 不用 -webkit-app-region: drag（否则收不到鼠标事件，无法检测摇动）
const SHAKE_WINDOW_MS = 600;   // 采样窗口
const SHAKE_TURNS = 3;         // 水平换向次数阈值
const SHAKE_DISTANCE = 60;     // 累计水平位移阈值（px）
// 头部区域（占窗口比例）：Spine 姿势实测头部在 CSS y 119~180（旧视频为 y 6%-29%，保留旧值兼容）
const HEAD_BOX = { xMin: 0.26, xMax: 0.78, yMin: 0.06, yMax: 0.29 };
// 摸头期间"离开头部"判定缓冲（px）：用户反馈 16px 太严苛，先放宽 50px、再要求更宽 → 90px；
// 摸头时手在头部附近大幅游移不打断；离开很远（躯干以下/窗口外）才结束 enjoy
const HEAD_EXIT_MARGIN = 90;

let dragging = false;
let shaking = false;      // 摸头态（摇动触发）
let onHead = false;       // 本次手势是否起于头部区域（摇动彩蛋只在头上划动才触发）
let lastX = 0;
let lastY = 0;
let samples = [];         // { t, x }
let dragLocked = false;   // 本次手势摇动触发过摸头后锁死拖动（窗口停在原地、拖尾保留），直到松开

function enterPat() {
  window.SpineLayer.startPat();
  window.petAPI.shake();
}

function exitPat() {
  window.SpineLayer.endPat();
}

function onMouseDown(e) {
  dragging = true;
  shaking = false;
  dragLocked = false;
  const w = window.innerWidth;
  const h = window.innerHeight;
  onHead =
    e.clientX >= w * HEAD_BOX.xMin && e.clientX <= w * HEAD_BOX.xMax &&
    e.clientY >= h * HEAD_BOX.yMin && e.clientY <= h * HEAD_BOX.yMax;
  lastX = e.screenX;
  lastY = e.screenY;
  samples = [{ t: performance.now(), x: e.screenX }];
  window.petAPI.fxDown(e.screenX, e.screenY);
}

function onMouseMove(e) {
  if (!dragging) return;
  window.petAPI.fxMove(e.screenX, e.screenY);
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  lastX = e.screenX;
  lastY = e.screenY;

  // 摇动检测：维护采样序列
  const now = performance.now();
  samples.push({ t: now, x: e.screenX });
  while (samples.length && now - samples[0].t > SHAKE_WINDOW_MS) samples.shift();

  if (!shaking && onHead && samples.length >= 4) {
    let turns = 0;
    let travel = 0;
    let prevSign = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = samples[i].x - samples[i - 1].x;
      travel += Math.abs(d);
      const sign = d > 2 ? 1 : d < -2 ? -1 : 0;
      if (sign !== 0) {
        if (prevSign !== 0 && sign !== prevSign) turns++;
        prevSign = sign;
      }
    }
    if (turns >= SHAKE_TURNS && travel > SHAKE_DISTANCE) {
      // 判定摇动 → 进入摸头态：锁死本次手势（不再拖动），Spine Pat 动画 + 头部跟随
      shaking = true;
      dragLocked = true; // 本次手势触发过摸头 → 之后不再拖动窗口
      enterPat();
      return;
    }
  }

  // 摸头中（仍长按）：光标离开头部区域（任意方向）→ 结束摸头（窗口仍锁在原地，头部平滑回正）
  if (shaking) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const inHead =
      e.clientX >= w * HEAD_BOX.xMin - HEAD_EXIT_MARGIN &&
      e.clientX <= w * HEAD_BOX.xMax + HEAD_EXIT_MARGIN &&
      e.clientY >= h * HEAD_BOX.yMin - HEAD_EXIT_MARGIN &&
      e.clientY <= h * HEAD_BOX.yMax + HEAD_EXIT_MARGIN;
    if (!inHead) {
      shaking = false;
      onHead = false; // 本次手势不再触发摇动
      exitPat();
    }
  }

  if (!shaking && !dragLocked && (dx !== 0 || dy !== 0)) {
    window.petAPI.drag(dx, dy);
  }
}

function onMouseUp() {
  if (!dragging) return;
  window.petAPI.fxUp();
  dragging = false;
  samples = [];
  if (shaking) {
    // 松手结束摸头：crossfade 回 Idle，头部随平滑系数回正
    shaking = false;
    exitPat();
  } else {
    window.petAPI.dragEnd();
  }
}

async function init() {
  emotions = await window.petAPI.getEmotions();

  // 预加载并解码全部情绪图，避免首次切换闪白
  for (const name of Object.keys(emotions)) {
    const img = new Image();
    img.src = emotionUrl(name);
    img.decode().catch(() => {});
  }

  // Spine 基底（加载失败时抛出——spine 资源是硬依赖，渲染层无降级路径）
  await window.SpineLayer.init(spineCanvas);

  // 光标 → Spine（摸头头部跟随 / 空闲注视共用）
  window.petAPI.onCursor((x, y) => window.SpineLayer.setCursor(x, y));
  // 基底稳定态：开启空闲注视 + 眨眼调度
  window.SpineLayer.setGaze(true);

  window.petAPI.onEmotion(showEmotion);
  window.petAPI.onReset(resetToBase);

  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  scheduleBlink();
}

init();
