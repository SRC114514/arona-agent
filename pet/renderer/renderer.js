// ARONA 桌宠渲染层：视频循环 + 情绪切换单向溶解过渡 + 手动拖动 + 摇动彩蛋
// 过渡模型：目标层垫底 opacity=1 常亮，当前层在顶部 opacity 1→0 单向淡出（WAAPI）。
// 任意时刻至少一层完全不透明（角色区合成 alpha 恒为 1），透明窗口下桌面不会透出 → 无残影。
const vid = document.getElementById("vid");
const eyeCanvas = document.getElementById("eye");
const ectx = eyeCanvas.getContext("2d");
const slots = [document.getElementById("emoA"), document.getElementById("emoB")];
const clipEl = document.getElementById("clip");

const ARONA_BASE = "../../assets/blue-archive/arona/";
let emotions = {};

function emotionUrl(name) {
  const file = emotions[name];
  return file ? ARONA_BASE + file : null;
}

// ---- 情绪切换：单向溶解过渡状态机 ----
const TRANSITION_MS = 200;

// 稳定态：{ kind:"video" } | { kind:"emotion", name, slotEl }
let cur = { kind: "video" };
// 进行中的过渡（含 prep 阶段）：{ seq, target, from, to, slotEl, direction, anims, committed }
let inflight = null;
let seqCounter = 0;

function sideEl(side) {
  if (side.kind === "video") return vid;
  if (side.kind === "clip") return clipEl;
  return side.slotEl;
}

function sideTarget(side) {
  return side.kind === "video" ? "video" : side.name;
}

// 层序归位（静态层序由 style.css 提供：vid 1 / eye 2 / slot 3 / clip 6）
function resetLayers() {
  vid.style.zIndex = "";
  eyeCanvas.style.zIndex = "";
  clipEl.style.zIndex = "";
  for (const s of slots) s.style.zIndex = "";
}

// 过渡落定后隐藏一侧：out 方向是淡出的 from；in（回播）方向是被盖没的 to
function hideSide(side) {
  const el = sideEl(side);
  el.style.display = "none";
  el.style.opacity = "";
  if (side.kind === "video") {
    vid.pause();
    eyeCanvas.style.display = "none";
    eyeCanvas.style.opacity = "";
  } else if (side.kind === "clip") {
    clipEl.pause(); // 保留 src 供复用
  } else {
    el.removeAttribute("src");
  }
}

// 过渡落定后一侧成为稳定态
function showSide(side) {
  const el = sideEl(side);
  el.style.display = "block";
  el.style.opacity = "";
  if (side.kind === "video") {
    eyeCanvas.style.display = "block";
    eyeCanvas.style.opacity = "";
  }
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
  if (t.doneResolve) t.doneResolve(); // clip-from 过渡的 prep 期等待者（见 routeTo）
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

  // 层序：from 提到最顶（视频在顶时瞳孔 overlay 跟随其上）
  if (t.from.kind === "emotion") t.from.slotEl.style.zIndex = "4";
  if (t.from.kind === "clip") clipEl.style.zIndex = "4";
  if (t.from.kind === "video") {
    vid.style.zIndex = "4";
    eyeCanvas.style.zIndex = "5";
  }
  botEl.style.display = "block";
  botEl.style.opacity = "1";
  topEl.style.display = "block";

  const targetOp = t.direction === "out" ? 0 : 1;
  // 回播场景 startOp<1，时长等比缩短，溶解速率一致
  const dur = Math.max(1, TRANSITION_MS * Math.abs(targetOp - startOp));
  const opts = { duration: dur, easing: "linear", fill: "forwards" };
  const anim = topEl.animate([{ opacity: startOp }, { opacity: targetOp }], opts);
  t.anims = [anim];
  if (t.from.kind === "video") {
    // 瞳孔 overlay 与视频同步淡（贴着渐隐/渐显的脸，不闪不漂）
    eyeCanvas.style.display = "block";
    t.anims.push(eyeCanvas.animate([{ opacity: startOp }, { opacity: targetOp }], opts));
  }
  anim.finished.then(() => completeTransition(t, anim)).catch(() => {});
}

// 等视频首帧实际呈现，避免 emotion→video 淡出到底层黑帧/旧帧
function waitVideoFrame() {
  return new Promise((resolve) => {
    if (typeof vid.requestVideoFrameCallback === "function") {
      vid.requestVideoFrameCallback(() => resolve());
    } else {
      vid.addEventListener("playing", () => requestAnimationFrame(() => resolve()), { once: true });
    }
  });
}

// prep 期被抢占：撤销不可见的准备工作（此刻 cur 仍完全不透明地显示着，无视觉变化）
function abortPrep(t) {
  if (t.target === "video") {
    vid.pause();
    vid.style.display = "none";
    vid.style.opacity = "";
  } else if (t.slotEl) {
    t.slotEl.removeAttribute("src");
  }
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
  if (target === "video") {
    // vid 垫底（静态 z1，被顶层不透明情绪图完全遮住），先播放并等首帧
    vid.style.display = "block";
    vid.style.opacity = "1";
    let playOk = true;
    try { await vid.play(); } catch { playOk = false; }
    if (inflight !== t) return;
    // play 失败时不再等首帧（否则 waitVideoFrame 可能永久挂起）
    if (playOk) await waitVideoFrame();
    if (inflight !== t) return;
    t.to = { kind: "video" };
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

// ---- clip 微动画：介导情绪过渡 + 空闲小动作 ----
// 三个 clip（VP9+alpha，1010x2128，3~5 帧 / 36~69ms，名义 fps=1000）：
//   eyeClose  睁眼基准→闭眼→睁眼基准（完整眨眼，首末帧≈normal 基准姿势）
//   lookEndA  睁眼张嘴→闭眼闭嘴（倒放 = 开始说话）
//   lookEndM  睁眼微笑→平嘴微皱眉（≈doubt）
// 播放模型：clip 是"盖布"（静态 z6 最顶），cur 不变；播完接既有单向溶解（from=clip）。
const CLIPS = {
  eyeClose: { file: "arona_video_EyeClose.webm", frames: 5, stretchMs: 350 },
  lookEndA: { file: "arona_video_LookEnd_A.webm", frames: 5, stretchMs: 350 },
  lookEndM: { file: "arona_video_LookEnd_M.webm", frames: 3, stretchMs: 300 },
};
// 介导路由（每次必触发；from/to 用 sideTarget 值："video" 或情绪名）
const MEDIATED_ROUTES = [
  { from: "video", to: "saying", clip: "lookEndA", reverse: true }, // 倒放=开始说话
  { from: "saying", to: "video", clip: "lookEndA", reverse: false }, // 正放=说话结束
  { from: "video", to: "doubt", clip: "lookEndM", reverse: false },
  { from: "video", to: "tired", clip: "eyeClose", reverse: false },
];
// 空闲小动作 = 仅眨眼：末帧=基准 → 硬切回（holdMs/returnMode 结构保留，加新动作时复用骨架）
const IDLE_ACTIONS = {
  blink: { clip: "eyeClose", holdMs: 0, returnMode: "hardcut" },
};
// 统一调度：每 3~5 分钟一轮，先随机要不要做（50%），要做则固定眨眼
const IDLE_CFG = { minMs: 180000, maxMs: 300000, actProb: 0.5 };
// 调试钩子：?idledebug 缩短间隔、每轮必做，供 visual_test 截获
if (new URLSearchParams(location.search).has("idledebug")) {
  IDLE_CFG.minMs = 4000; IDLE_CFG.maxMs = 8000;
  IDLE_CFG.actProb = 1;
}

function resolveRoute(from, to) {
  return MEDIATED_ROUTES.find((r) => r.from === from && r.to === to) || null;
}

// clip 播放阶段：{ kind:"mediated", route, token, pendingTarget, cfg }
//              | { kind:"idle:blink", token, cfg }
let clipPhase = null;
const clipWarmers = []; // init 预热的离屏 video 元素（保持引用防 GC）

// 加载 clip 并等首帧可显示；失败/超时 resolve(false)，调用方降级
function loadClip(cfg) {
  if (clipEl.dataset.cur === cfg.file && clipEl.readyState >= 2) return Promise.resolve(true);
  clipEl.pause();
  clipEl.removeAttribute("src");
  clipEl.load();
  clipEl.dataset.cur = cfg.file;
  clipEl.src = ARONA_BASE + cfg.file;
  clipEl.load();
  return new Promise((resolve) => {
    const finish = (ok) => { clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => finish(clipEl.readyState >= 2), 500);
    clipEl.addEventListener("loadeddata", () => finish(true), { once: true });
    clipEl.addEventListener("error", () => finish(false), { once: true });
  });
}

// 逐帧步进播放（rAF + currentTime seek，正倒统一；帧区间中点 seek 避免边界舍入）
// 播放完 resolve(true)；token.cancelled 时 resolve(false)
function playClip(cfg, { reverse, token }) {
  const N = cfg.frames;
  const D = clipEl.duration && Number.isFinite(clipEl.duration) ? clipEl.duration : N / 1000;
  const t0 = performance.now();
  let lastIdx = -1;
  return new Promise((resolve) => {
    function tick(now) {
      if (token.cancelled) return resolve(false);
      const el = now - t0;
      if (el >= cfg.stretchMs) return resolve(true); // 末帧已展示足够久
      let idx = Math.min(N - 1, Math.floor((el / cfg.stretchMs) * N));
      if (reverse) idx = N - 1 - idx;
      if (idx !== lastIdx) {
        lastIdx = idx;
        clipEl.currentTime = ((idx + 0.5) / N) * D;
      }
      token.rafId = requestAnimationFrame(tick);
    }
    token.rafId = requestAnimationFrame(tick);
  });
}

function cancelClip(token) {
  token.cancelled = true;
  cancelAnimationFrame(token.rafId);
}

// seek clip 到第 idx 帧中点并等 seeked（超时兜底 resolve(false)）
// 用途：clip 从 display:none 重新显示后，强制解码管线产出一帧——
// 合成层重建有延迟，不等这一帧就隐底层会漏出一帧透明桌面（录屏实测）
function seekClipFrame(cfg, idx) {
  const D = clipEl.duration && Number.isFinite(clipEl.duration) ? clipEl.duration : cfg.frames / 1000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 150);
    clipEl.addEventListener("seeked", () => { clearTimeout(timer); resolve(true); }, { once: true });
    clipEl.currentTime = ((idx + 0.5) / cfg.frames) * D;
  });
}

// 双 rAF：等一帧合成周期（新显示层的画面真正上屏）
function nextPaint() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// 介导过渡：clip 盖布播放（cur 不变）→ transitionFromClip 溶解到最终目标
async function mediatedTransition(route) {
  // 调用前已保证 !inflight && !clipPhase（见 routeTo）
  const cfg = CLIPS[route.clip];
  const token = { cancelled: false, rafId: 0 };
  clipPhase = { kind: "mediated", route, token, pendingTarget: route.to, cfg };

  const ok = await loadClip(cfg);
  if (!ok) {
    clipPhase = null;
    return transitionTo(route.to); // 降级纯溶解
  }

  // 切到 clip 盖布（可见变更）：clip 首帧≈cur 侧起始姿势，硬切可接受。
  // 顺序关键：先显示 clip 并等其首帧上屏（vid 仍在底下播），再隐 vid——
  // 同帧显 clip + 隐 vid 会撞上 clip 合成层重建延迟，透明窗漏出一帧桌面
  clipEl.style.opacity = "1";
  clipEl.style.display = "block"; // 静态 z6 最顶
  await seekClipFrame(cfg, route.reverse ? cfg.frames - 1 : 0); // 首帧（倒放=末帧）
  await nextPaint();
  if (token.cancelled) { clipEl.style.display = "none"; clipPhase = null; return; } // 防御（当前不可达）
  hideSide(cur); // video: pause+隐eye；emotion: 隐 slot。注意 cur 不变！

  await playClip(cfg, { reverse: route.reverse, token });

  const target = clipPhase.pendingTarget; // 播放期间新指令可能改写过
  clipPhase = null;
  return transitionFromClip(target);
}

// clip 播完接既有单向溶解：from=clip（顶层淡出），to=最终目标
async function transitionFromClip(target) {
  // 目标情绪无效（理论上不可达：showEmotion 已校验）→ 兜底回 video，不留卡住的 clip 层
  if (target !== "video" && !emotionUrl(target)) target = "video";
  const mySeq = ++seqCounter;
  const t = {
    seq: mySeq, target,
    from: { kind: "clip" }, to: null, slotEl: null,
    direction: "out", anims: [], committed: false,
    done: null, doneResolve: null,
  };
  t.done = new Promise((r) => (t.doneResolve = r));
  inflight = t;

  // prep（同 transitionTo 骨架；每个 await 后检查是否被 settle 抢先落定）
  if (target === "video") {
    vid.style.display = "block";
    vid.style.opacity = "1";
    let playOk = true;
    try { await vid.play(); } catch { playOk = false; }
    if (inflight !== t) return;
    if (playOk) await waitVideoFrame();
    if (inflight !== t) return;
    t.to = { kind: "video" };
  } else {
    const url = emotionUrl(target);
    const slotEl = cur.kind === "emotion" && cur.slotEl === slots[0] ? slots[1] : slots[0];
    t.slotEl = slotEl;
    slotEl.src = url;
    try { await slotEl.decode(); } catch {}
    if (inflight !== t) return;
    t.to = { kind: "emotion", name: target, slotEl };
  }

  t.committed = true;
  startAnimation(t, 1); // clipEl 顶层淡出 → 目标层常亮；落定后 cur=t.to，永不落 clip
}

// 情绪指令统一入口：空闲小动作取消 → 介导改写 → clip 溶解守卫 → 介导/纯溶解
function routeTo(target) {
  // 1) 空闲小动作进行中：新指令直接取消（装饰性动画，可牺牲）
  if (clipPhase && clipPhase.kind.startsWith("idle:")) cancelIdle();
  // 2) 介导 clip 播放中：不打断（≤400ms），改写最终目标即可
  if (clipPhase && clipPhase.kind === "mediated") {
    clipPhase.pendingTarget = target;
    return;
  }
  // 3) clip→X 溶解进行中：禁反向回 clip——已提交的瞬间落定；prep 期的等落定后再路由
  if (inflight && inflight.from.kind === "clip") {
    if (inflight.committed) {
      settleInflight();
    } else {
      const w = inflight.done;
      void w.then(() => routeTo(target));
      return;
    }
  }
  const route = resolveRoute(sideTarget(cur), target);
  if (route && !inflight) {
    void mediatedTransition(route);
    return;
  }
  // inflight 存在（普通过渡）时一律纯溶解，避免嵌套介导
  void transitionTo(target);
}

// ---- 空闲小动作调度器（眨眼 + 偶尔皱眉） ----
// 帧对齐数据（bake_idle_sync.mjs 生成）：normal 中与 clip 首/末帧最相似的帧时间戳。
// 切入等 enter 帧、切出预 seek 到 exit 帧——比"循环边界硬切"准（实测循环首帧≠clip 基准姿势，
// 且 pause 检测延迟会让冻结帧越过边界 1-2 帧，两者叠加就是肉眼可见的闪跳）。
const IS = window.IDLE_SYNC || null;
let idleTimer = null;

function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(rollIdle, IDLE_CFG.minMs + Math.random() * (IDLE_CFG.maxMs - IDLE_CFG.minMs));
}

// 一轮空闲掷签：先定要不要做，要做则眨眼
function rollIdle() {
  idleTimer = null;
  if (Math.random() >= IDLE_CFG.actProb) return scheduleIdle();
  void tryIdle("blink");
}

async function tryIdle(name) {
  // 触发条件：稳定 video 态、无过渡、无 clip、无情绪显示
  if (cur.kind !== "video" || inflight || clipPhase) return scheduleIdle();
  // 先占位再等对齐帧——两个 idle 动作同时到期时，后到者看到 clipPhase 即放弃重排，不会撞车
  const token = { cancelled: false, rafId: 0 };
  const phase = { kind: "idle:" + name, token, cfg: CLIPS[IDLE_ACTIONS[name].clip] };
  clipPhase = phase;
  // 等 normal 播到与 clip 首帧最相似的帧（烘焙时间戳）；无烘焙数据时退回循环边界
  const sync = IS && IS[IDLE_ACTIONS[name].clip];
  const aligned = sync
    ? await waitForVideoTime(sync.enter, 4000, phase)
    : await waitLoopBoundary(3500, phase);
  if (!aligned || token.cancelled || cur.kind !== "video" || inflight || clipPhase !== phase) {
    if (clipPhase === phase) clipPhase = null;
    return scheduleIdle();
  }
  return runIdle(name, phase);
}

// rAF 轮询 vid.currentTime 进入 [tTarget, tTarget+一帧) 即触发（带环绕处理）；打断/超时 resolve(false)
function waitForVideoTime(tTarget, timeoutMs, phase) {
  return new Promise((resolve) => {
    const win = (1.2 / (IS ? IS.fps : 30)); // 略宽于 1 帧，16ms 轮询必捕获
    const t0 = performance.now();
    function tick() {
      if (cur.kind !== "video" || inflight || clipPhase !== phase) return resolve(false);
      if (performance.now() - t0 > timeoutMs) return resolve(false);
      const dur = vid.duration;
      if (Number.isFinite(dur) && dur > 0) {
        const diff = (vid.currentTime - tTarget + dur) % dur;
        if (diff <= win) return resolve(true);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

// rAF 轮询 vid.currentTime 回绕（prev > cur）或起点；状态被打断/超时 resolve(false)
function waitLoopBoundary(timeoutMs, phase) {
  return new Promise((resolve) => {
    let prev = vid.currentTime;
    const t0 = performance.now();
    function tick() {
      if (cur.kind !== "video" || inflight || clipPhase !== phase) return resolve(false);
      if (performance.now() - t0 > timeoutMs) return resolve(false);
      const ct = vid.currentTime;
      if (ct < prev || ct < 0.05) return resolve(true);
      prev = ct;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

async function runIdle(name, phase) {
  const a = IDLE_ACTIONS[name];
  const cfg = phase.cfg;
  const token = phase.token;

  const ok = await loadClip(cfg);
  if (!ok || token.cancelled) {
    if (clipPhase === phase) clipPhase = null;
    return scheduleIdle();
  }

  // 硬切进 clip（vid 冻结在烘焙对齐帧，与 clip 首帧同姿势）。
  // 顺序关键（录屏实测）：先显示 clip 等首帧上屏，再隐 vid——同帧显隐会漏一帧透明桌面
  clipEl.style.opacity = "1";
  clipEl.style.display = "block";
  await seekClipFrame(cfg, 0);
  await nextPaint();
  if (token.cancelled) return; // cancelIdle 已接管恢复
  vid.pause();
  eyeCanvas.style.display = "none"; // EYE_TRACK 只匹配 normal 时序
  vid.style.display = "none";

  // hardcut 回程预对准：趁 clip 播放把 vid 预 seek 到切出帧（vid 不可见，seek 无闪烁）
  const sync = IS && IS[a.clip];
  if (a.returnMode === "hardcut" && sync && sync.exit != null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 300); // seek 超时兜底，不阻塞 clip 开播
      vid.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
      vid.currentTime = sync.exit;
    });
    if (token.cancelled) return; // cancelIdle 已接管恢复
  }

  await playClip(cfg, { reverse: false, token });
  if (token.cancelled) return; // cancelIdle 已接管恢复
  if (a.holdMs) await new Promise((r) => setTimeout(r, a.holdMs)); // 末帧停留（皱眉让人读到）
  if (token.cancelled) return;

  if (a.returnMode === "hardcut") {
    // 顺序关键：先把 vid/eye 垫到 clip（z6）底下点亮并等续播首帧上屏，再撤顶层 clip。
    // 反过来的话顶层一撤、底层首帧未上屏，透明窗会透出一帧桌面 = "闪一下"
    vid.style.display = "block";
    eyeCanvas.style.display = "block";
    let playOk = true;
    try { await vid.play(); } catch { playOk = false; }
    if (playOk) await waitVideoFrame();
    if (token.cancelled) return;
    clipEl.style.display = "none";
    clipPhase = null;
    scheduleIdle();
  } else {
    // dissolve 回程（预留给末帧≠基准姿势的动作）：复用介导溶解机器回 normal
    clipPhase = null;
    await transitionFromClip("video");
    scheduleIdle();
  }
}

function cancelIdle() {
  const p = clipPhase;
  if (!p || !p.kind.startsWith("idle:")) return;
  cancelClip(p.token);
  clipEl.style.display = "none";
  clipPhase = null;
  // cur 仍是 video：恢复显示（未切走 vid 时以下操作幂等无害）；
  // 已进 dissolve 溶解段时 clipPhase 已为 null，不会走到这里（由 routeTo 的 clip 守卫接管）
  vid.style.display = "block";
  eyeCanvas.style.display = "block";
  vid.play().catch(() => {});
  scheduleIdle(); // 小动作延后，情绪指令优先
}

function showEmotion(name) {
  if (!emotionUrl(name)) return;
  // 新情绪切换时取消挂起的摇动恢复定时器，避免它覆盖刚设定的情绪
  if (shakeRecoverTimer) { clearTimeout(shakeRecoverTimer); shakeRecoverTimer = null; }
  routeTo(name);
}

function resetToVideo() {
  routeTo("video");
}

// ---- 瞳孔跟随（数据由 pet/tools/bake_eye_track.mjs 离线烘焙，eye_track.js 提供 window.EYE_TRACK）----
// 模型：Live2D 式整体虹膜位移——patch（已抹除虹膜的干净眼窝）盖住原虹膜，
//       sprite（虹膜 RGBA）按鼠标方向偏移重绘，看向一侧时另一侧露出眼白。
const ET = window.EYE_TRACK || null;
// 自适应平滑：目标远时快速追赶（避免"慢半拍"），接近后放缓（稳定不抖）
const EYE_SMOOTH_NEAR = 0.3;
const EYE_SMOOTH_FAR = 0.6;
const EYE_FAR_DIST = 6;   // 视频 px，超过此距离用 FAR 系数
let atlasImg = null;
let cursorPos = { x: 0, y: 0 };   // 窗口本地 CSS px（主进程全局轮询；负值合法=光标在窗口左/上方）
let hasCursor = false;            // 收到首个光标事件前不绘制（负坐标不是"无效"信号！）
let eyeOff = { x: 0, y: 0 };      // 平滑后的注视偏移（视频 px）
let eyeReady = false;
let lastEyeKey = "";              // 重绘跳过用

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function initEye() {
  if (!ET || !ET.frames || !ET.frames.length) return; // 数据缺失 → 静默降级为原行为
  try {
    atlasImg = await loadImage(ET.atlas);
    if (typeof atlasImg.decode === "function") await atlasImg.decode().catch(() => {});
    const dpr = window.devicePixelRatio || 1;
    eyeCanvas.width = Math.round(window.innerWidth * dpr);
    eyeCanvas.height = Math.round(window.innerHeight * dpr);
    ectx.scale(dpr, dpr); // 之后全部用 CSS px 绘制
    window.petAPI.onCursor((x, y) => { cursorPos = { x, y }; hasCursor = true; });
    eyeReady = true;
    console.log(`EYE_TRACK v${ET.version}, ${ET.frames.length / 4} frames`);
    requestAnimationFrame(eyeLoop);
  } catch {
    // atlas 解码失败 → 降级，overlay 永远空白
  }
}

function eyeLoop() {
  drawEye();
  requestAnimationFrame(eyeLoop); // rAF 常驻；非激活态 early-return 代价可忽略
}

function drawEye() {
  if (!eyeReady || !hasCursor || vid.style.display === "none" || vid.paused) return;
  const S = ET.cellSize;
  const N = ET.frames.length / 4;
  const s = window.innerWidth / ET.videoW; // 窗口与视频同比例，无 letterbox

  // 1) 按播放时间查帧（质心与 cell 原点都插值——人物微晃时基线位置连续，消除采样跳变；
  //    取模自然处理循环回绕）
  const pos = vid.currentTime * ET.fps;
  const i0 = Math.floor(pos) % N;
  const i1 = (i0 + 1) % N;
  const f = pos - Math.floor(pos);
  const F = ET.frames;
  const L = (k) => F[i0 * 4 + k] + (F[i1 * 4 + k] - F[i0 * 4 + k]) * f;
  const bx = L(0);   // cell 原点（视频 px，亚像素）
  const by = L(1);
  const icx = L(2);  // 虹膜质心
  const icy = L(3);

  // 2) 注视目标：cursor CSS px → 视频 px → 相对虹膜质心，椭圆域 clamp
  let dx = cursorPos.x / s - icx;
  let dy = cursorPos.y / s - icy;
  const d = Math.hypot(dx / ET.maxOff.x, dy / ET.maxOff.y);
  if (d > 1) { dx /= d; dy /= d; }

  // 3) 自适应平滑：远快近慢
  const dist = Math.hypot(dx - eyeOff.x, dy - eyeOff.y);
  const k = dist > EYE_FAR_DIST ? EYE_SMOOTH_FAR : EYE_SMOOTH_NEAR;
  eyeOff.x += (dx - eyeOff.x) * k;
  eyeOff.y += (dy - eyeOff.y) * k;

  // 4) 基线与偏移变化均可忽略 → 跳过重绘
  const key = `${i0}:${bx.toFixed(1)}:${by.toFixed(1)}:${eyeOff.x.toFixed(1)}:${eyeOff.y.toFixed(1)}`;
  if (key === lastEyeKey) return;
  lastEyeKey = key;

  // 5) 绘制（亚像素坐标）：patch（羽毛 alpha 抹除区）盖原虹膜 → sprite 偏移重绘
  const col = i0 % ET.atlasCols;
  const row = (i0 / ET.atlasCols) | 0;
  const ps = S * s;
  ectx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ectx.drawImage(atlasImg, col * 2 * S, row * S, S, S, bx * s, by * s, ps, ps);
  ectx.drawImage(atlasImg, (col * 2 + 1) * S, row * S, S, S, (bx + eyeOff.x) * s, (by + eyeOff.y) * s, ps, ps);
}


// ---- 点击/拖尾特效：转发全局屏幕坐标给全屏特效窗口 ----
// 特效画在独立的全屏透明窗口里（见 main.cjs / fx.js），桌宠窗口只负责检测手势。
// 用 screenX/screenY（全局 DIP）而非 clientX/clientY——拖尾要跨屏延伸，窗口内坐标会因窗口跟随鼠标而几乎不变。

// ---- 拖动与摇动检测 ----
// 不用 -webkit-app-region: drag（否则收不到鼠标事件，无法检测摇动）
const SHAKE_WINDOW_MS = 600;   // 采样窗口
const SHAKE_TURNS = 3;         // 水平换向次数阈值
const SHAKE_DISTANCE = 60;     // 累计水平位移阈值（px）
const SHAKE_RECOVER_MS = 800;  // 摇完后 enjoy 停留时长
// 头部区域（占窗口比例）：依据视频帧 1010x2128 中头部位置
// （x 285-760 / y 170-570，即 x 26%-78%、y 6%-29%）换算，窗口与视频同比例
const HEAD_BOX = { xMin: 0.26, xMax: 0.78, yMin: 0.06, yMax: 0.29 };
// enjoy 期间"离开头部"判定缓冲（px）：吸收摇动余量与抖动，
// 避免窗口刚停住、clientX 短暂摆动时误触发取消
const HEAD_EXIT_MARGIN = 16;

let dragging = false;
let shaking = false;
let onHead = false; // 本次手势是否起于头部区域（摇动彩蛋只在头上划动才触发）
let lastX = 0;
let lastY = 0;
let samples = []; // { t, x }
let shakeRecoverTimer = null; // 摇动后恢复默认视频的定时器（新情绪切换时需取消）
let dragLocked = false; // 本次手势摇动触发过 enjoy 后锁死拖动（窗口停在原地、拖尾保留），直到松开

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
      // 判定摇动：锁死本次手势（不再拖动），强制 enjoy
      shaking = true;
      dragLocked = true; // 本次手势触发过 enjoy → 之后不再拖动窗口
      showEmotion("enjoy");
      window.petAPI.shake();
      return;
    }
  }

  // enjoy 状态中（仍长按）：光标离开头部区域（任意方向）→ 停止 enjoy（本次手势拖动已锁定，窗口停原地）
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
      resetToVideo();
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
    shaking = false;
    shakeRecoverTimer = setTimeout(resetToVideo, SHAKE_RECOVER_MS);
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

  window.petAPI.onEmotion(showEmotion);
  window.petAPI.onReset(resetToVideo);

  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  await initEye(); // 瞳孔跟随（数据缺失时静默跳过）

  // clip 预热（本地小文件；loadClip 另有 500ms 超时降级兜底）
  for (const k of Object.keys(CLIPS)) {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = ARONA_BASE + CLIPS[k].file;
    v.load();
    clipWarmers.push(v);
  }

  // 空闲小动作调度（3~5min 一轮，掷签决定做不做，做则眨眼）
  scheduleIdle();
}

init();
