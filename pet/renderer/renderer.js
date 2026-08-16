// ARONA 桌宠渲染层：Spine 骨骼基底 + 情绪预设（track4 数字预设动画，瞬时切换）+ 手动拖动 + 摇动彩蛋（摸头）
// 角色参数化：当前 Agent 配置（agents.cjs，经 ?agent= + pet:get-agent-config）决定
//   情绪映射（emotions）、闭眼预设集合（closedEyePresets）、禁跟随集合（noGazePresets）。
// 情绪模型：track4 非循环数字预设"残留末帧"持有，脸+光环瞬时切换（游戏原生语义，无过渡）；
//   track0 始终 Idle_01 循环 → 情绪期间身体继续呼吸摇摆，只有脸+光环切换。
// 摸头（头部摇动 ≥3 次换向触发）：Pat_01_A + Pat_01_M 静态姿势对 + Head_Rot 跟随光标，窗口锁死不动。
// 空闲注视：瞳孔跟随光标（spine_layer.js 内部实现），头部不歪。
// 眨眼：Eye_Close_01 独立轨道（track5，预设之上），2~6s 均匀随机，15% 概率双眨；闭眼预设期间禁止。
const spineCanvas = document.getElementById("spine");

const IS_IDLE_DEBUG = new URLSearchParams(location.search).has("idledebug");

// ---- 情绪预设映射（单一事实源：agents.cjs 当前 Agent 的 emotions 值 = 预设动画名；closedEye 集合见下）----
// closedEye：该预设 key 了 L/R_Eye_Cover_01/02（闭眼）→ 情绪期间禁止眨眼
// （Eye_Close_01 播完末帧会把 cover 置 null，闭眼预设上眨眼会闪出"睁眼"）。
// noGaze：睁眼预设默认保留瞳孔跟随；以下预设禁跟随（如 jealous 自带固定斜视，跟随会覆盖）。
let closedEyePresets = new Set();
let noGazePresets = new Set();
let EMOTION_PRESET = {};

// 当前稳定态情绪名（"spine" 基底时为 null）；同名重复路由跳过（幂等）
let currentEmotion = null;

// 路由入口：摸头中收到新指令先结束摸头（crossfade 回 Idle），再正常路由。
// 瞬时切换语义：setAnimation 直接 snap（本运行时高 track attachment 恒覆盖低 track），无过渡。
function routeTo(target) {
  if (window.SpineLayer.getState().patting) window.SpineLayer.endPat();
  if (target === "spine") {
    if (currentEmotion === null) return;
    currentEmotion = null;
    // ⚠️ 摘除必须走 setEmptyAnimation（触发 mix-out SETUP 重置，脸回 setup pose）；
    // clearTrack 会残留预设 attachment 不还原（见 spine_layer.clearEmotionPreset 注释）。
    window.SpineLayer.clearEmotionPreset();
    // 空闲注视恢复（决策点：情绪期间 gaze/眼球跟随维持关闭，与现状一致）
    window.SpineLayer.setGaze(true);
  } else {
    if (currentEmotion === target) return;
    const m = EMOTION_PRESET[target];
    if (!m) return;
    currentEmotion = target;
    // 睁眼情绪保留瞳孔跟随，闭眼 / 禁跟随预设（jealous/angry/doubt）关闭
    window.SpineLayer.setGaze(m.gaze);
    window.SpineLayer.setEmotionPreset(m.anim, m.closedEye, m.gaze);
  }
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
  // 互斥判断全在 SpineLayer.blink() 内部（摸头中/闭眼情绪预设中返回 false 即跳过本次）
  if (!window.SpineLayer.blink()) return;
  if (Math.random() < 0.15) {
    // 双眨：第一次（0.133s）结束后 150~250ms 再来一次
    setTimeout(() => {
      window.SpineLayer.blink();
    }, 300 + Math.random() * 150);
  }
}

function showEmotion(name) {
  if (!EMOTION_PRESET[name]) return;
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
  // 情绪预设映射：agents.cjs（与 main 进程白名单同源）值 = 预设动画名；
  // closedEye/noGaze 集合同样来自当前 Agent 配置
  const cfg = await window.petAPI.getAgentConfig();
  closedEyePresets = new Set(cfg.closedEyePresets || []);
  noGazePresets = new Set(cfg.noGazePresets || []);
  for (const [name, anim] of Object.entries(cfg.emotions || {})) {
    EMOTION_PRESET[name] = {
      anim,
      closedEye: closedEyePresets.has(anim),
      gaze: !closedEyePresets.has(anim) && !noGazePresets.has(anim),
    };
  }

  try {
    // Spine 基底（加载失败时抛出——spine 资源是硬依赖，渲染层无降级路径；
    // WebGL 不可用时 spine_layer 内部已自动降级 Canvas 2D，此处仅兜底输出错误）
    await window.SpineLayer.init(spineCanvas);
  } catch (err) {
    // 错误经 main.cjs console-message 转发 → 终端可见（[pet:render]），不静默
    console.error("[pet:render] SpineLayer.init 失败:", err && err.message ? err.message : err);
    return; // 不挂交互事件，保持窗口透明
  }

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
