// ARONA 桌宠渲染层：Spine 骨骼基底 + 情绪预设（track4 数字预设动画，瞬时切换）+ 手动拖动 + 摇动彩蛋（摸头）
// 角色参数化：当前 Agent 配置（agents.cjs，经 ?agent= + pet:get-agent-config）决定
//   情绪映射（emotions）、闭眼预设集合（closedEyePresets）、禁跟随集合（noGazePresets）。
// 情绪模型：track4 非循环数字预设"残留末帧"持有，脸+光环瞬时切换（游戏原生语义，无过渡）；
//   track0 始终 Idle_01 循环 → 情绪期间身体继续呼吸摇摆，只有脸+光环切换。
// 摸头（头部摇动 ≥2 次换向触发，轻微划出窗口也算——主进程光标轮询补采样）：Pat_01_A + Pat_01_M
//   静态姿势对 + Head_Rot 跟随光标，窗口锁死不动。
// dizzy（按住鼠标任意区域大幅晃动触发，仅主 Agent 窗口）：600ms 内单轴摆幅极差 ≥150px 且换向 ≥2 次
//   → track4 dizzy 预设（Arona 30 / Plana 13，闭眼晕脸）；与摸头按"摆幅量级"分档（小幅频繁=摸头）。
//   松手后保持 DIZZY_RECOVER_MS 再自动回待机；dizzy 期间窗口不锁死（桌宠被拎着晃，跟随鼠标拖动）。
// 摸头/dizzy 手势级互斥（interactionDone）：同一次按住内任一触发过，另一项禁用直到松开。
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

// 角色是否禁用摇动摸头（Hoshino pat.type = "none"）；模块加载后由 init 读取配置决定
let patDisabled = false;

// 是否主 Agent 窗口（main.cjs get-agent-config.isMain）：dizzy 大幅晃动仅主窗口响应
let isMainPet = false;

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
  // 外部（LLM）情绪覆盖时取消 dizzy 的延迟恢复，防定时器把新情绪拉回 idle
  if (name !== "dizzy") cancelDizzyRecover();
  routeTo(name);
}

function resetToBase() {
  cancelDizzyRecover();
  routeTo("spine");
}

// ---- 拖动与摇动检测 ----
// 不用 -webkit-app-region: drag（否则收不到鼠标事件，无法检测摇动）
const SHAKE_WINDOW_MS = 600;   // 采样窗口
const SHAKE_TURNS = 2;         // 水平换向次数阈值
const SHAKE_DISTANCE = 60;     // 累计水平位移阈值（px）
const PAT_TURN_PX = 20;        // 单次"有效换向"所需的最小半波位移（px）——单向拖动/微抖动不计数
// ---- dizzy（大幅晃动）检测：仅主 Agent 窗口 ----
// 与摸头按摆幅量级分档：采样窗口（同 SHAKE_WINDOW_MS）内光标单轴极差 ≥ DIZZY_AMPLITUDE
// 且该轴换向 ≥ DIZZY_TURNS → 判"大幅晃动"；小幅频繁滑动（摸头）包络远小于此，不会误抢。
// 用窗口内坐标极差（max−min）而非逐帧半波检测：快速甩动采样稀疏时极值点仍稳定可采。
const DIZZY_TURNS = 2;          // 换向次数阈值（一来一回）
const DIZZY_AMPLITUDE = 150;    // 窗口内单轴摆幅极差阈值（px）——"大幅"档位，待实测调整
const DIZZY_RECOVER_MS = 2000;  // 松手后保持晕脸的时长，之后自动回待机
// 头部区域：x 比例基于 320px 渲染区宽（spineCanvas.clientWidth——旧版窗口曾含 260px 气泡区，
// 若按整窗 innerWidth 算 x 会把头部左缘切掉；现窗口已收窄为渲染区本体，两者恰好相等，
// 但仍按 clientWidth 计算以防未来再加非渲染区域），y 基于窗口高。
// Spine 姿势实测头部在 CSS y 119~180。
const HEAD_BOX = { xMin: 0.26, xMax: 0.78, yMin: 0.06, yMax: 0.29 };
// 摸头期间"离开头部"判定缓冲（px）：用户反馈 16px 太严苛，先放宽 50px、再要求更宽 → 90px；
// 摸头时手在头部附近大幅游移不打断；离开很远（躯干以下/窗口外）才结束 enjoy
const HEAD_EXIT_MARGIN = 90;

let dragging = false;
let shaking = false;      // 摸头态（摇动触发）
let onHead = false;       // 本次手势是否起于头部区域（摇动彩蛋只在头上划动才触发）
let lastX = 0;
let lastY = 0;
let samples = [];         // { t, x, y }（e.screenX/Y 全局坐标，不受窗口移动影响）
let dragLocked = false;   // 本次手势摇动触发过摸头后锁死拖动（窗口停在原地、拖尾保留），直到松开
let dizzy = false;        // dizzy 态（按住大幅晃动触发）
let dizzyTimer = null;    // 松手后的延迟恢复定时器
// 手势级互斥：本次手势（mousedown→mouseup）内摸头/dizzy 任一触发过，另一项禁用直到松开。
// 堵"摸头触发→离开头部区退出→继续大幅晃又触发 dizzy"（及反向）的串扰。
let interactionDone = false;

// 采样入列 + 600ms 窗口裁剪（mousemove 与主进程光标轮询两路共用）
function pushSample(x, y) {
  const now = performance.now();
  samples.push({ t: now, x, y });
  while (samples.length && now - samples[0].t > SHAKE_WINDOW_MS) samples.shift();
}

function enterPat() {
  interactionDone = true; // 手势级互斥：本手势内 dizzy 不再触发
  window.SpineLayer.startPat();
  window.petAPI.shake();
}

function exitPat() {
  window.SpineLayer.endPat();
}

// ---- dizzy（大幅晃动）：仅主 Agent 窗口；纯本地动画，不涉及 LLM / 子 Agent ----
// 窗口不锁死：dizzy 状态下仍走现有拖动路径（桌宠跟随鼠标被拎着晃），松手 dragEnd 落盘位置。
function enterDizzy() {
  interactionDone = true; // 手势级互斥：本手势内摸头不再触发
  dizzy = true;
  window.petAPI.dizzy(); // 上报（与 pet:shake 对称，主进程仅日志）
  routeTo("dizzy");      // 幂等；闭眼预设（Arona 30 / Plana 13）自动禁眨眼/关注视
}

// 松手时调用：延迟 DIZZY_RECOVER_MS 自动回待机（晕一会儿缓过来）
function exitDizzy() {
  if (!dizzy) return;
  dizzy = false;
  dizzyTimer = setTimeout(() => {
    dizzyTimer = null;
    // 守卫：恢复瞬间若又开始摸头，不掐断摸头
    if (!window.SpineLayer.getState().patting) resetToBase();
  }, DIZZY_RECOVER_MS);
}

// 外部情绪 / 重置覆盖时取消 dizzy 的延迟恢复（防"LLM 发了新情绪后被定时器拉回 idle"）
function cancelDizzyRecover() {
  dizzy = false;
  if (dizzyTimer) {
    clearTimeout(dizzyTimer);
    dizzyTimer = null;
  }
}

function onMouseDown(e) {
  dragging = true;
  shaking = false;
  interactionDone = false; // 新手势重置互斥标志
  dragLocked = false;
  const h = window.innerHeight;
  const sw = spineCanvas.clientWidth || 320; // 渲染区宽（x 判定基准，见 HEAD_BOX 注释）
  onHead =
    !patDisabled &&
    e.clientX >= sw * HEAD_BOX.xMin && e.clientX <= sw * HEAD_BOX.xMax &&
    e.clientY >= h * HEAD_BOX.yMin && e.clientY <= h * HEAD_BOX.yMax;
  lastX = e.screenX;
  lastY = e.screenY;
  samples = [{ t: performance.now(), x: e.screenX, y: e.screenY }];
  window.petAPI.fxDown(e.screenX, e.screenY);
}

function onMouseMove(e) {
  if (!dragging) return;
  window.petAPI.fxMove(e.screenX, e.screenY);
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  lastX = e.screenX;
  lastY = e.screenY;

  // 摇动检测：维护采样序列（mousemove；按住期间另有主进程光标轮询补采样，见 init 的 onCursor）
  pushSample(e.screenX, e.screenY);

  // ---- dizzy 检测（大幅晃动，仅主 Agent 窗口）----
  // 按摆幅量级与摸头分档：真大幅优先判定（头部大幅晃 → dizzy，未达大幅的头部手势落回摸头检测）。
  // x/y 两轴独立判定、任一满足即触发（斜着甩、上下大幅晃也算）。
  if (!dizzy && !shaking && !interactionDone && isMainPet && samples.length >= 4) {
    let minX = Infinity, maxX = -Infinity, turnsX = 0, prevSx = 0;
    let minY = Infinity, maxY = -Infinity, turnsY = 0, prevSy = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
      if (i > 0) {
        const dx = s.x - samples[i - 1].x;
        const dy = s.y - samples[i - 1].y;
        const sx = dx > 2 ? 1 : dx < -2 ? -1 : 0;
        if (sx !== 0) {
          if (prevSx !== 0 && sx !== prevSx) turnsX++;
          prevSx = sx;
        }
        const sy = dy > 2 ? 1 : dy < -2 ? -1 : 0;
        if (sy !== 0) {
          if (prevSy !== 0 && sy !== prevSy) turnsY++;
          prevSy = sy;
        }
      }
    }
    if ((maxX - minX >= DIZZY_AMPLITUDE && turnsX >= DIZZY_TURNS) ||
        (maxY - minY >= DIZZY_AMPLITUDE && turnsY >= DIZZY_TURNS)) {
      enterDizzy();
      return;
    }
  }

  if (!shaking && !dizzy && !interactionDone && onHead && samples.length >= 4) {
    let turns = 0;
    let travel = 0;
    let half = 0;           // 当前方向半波累计位移
    let prevSign = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = samples[i].x - samples[i - 1].x;
      travel += Math.abs(d);
      half += Math.abs(d);
      const sign = d > 2 ? 1 : d < -2 ? -1 : 0;
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
        // 换向：仅当刚走完的这半波 ≥ PAT_TURN_PX 才算一次"有效换向"。
        // 单向拖动/手指微抖动的半波远小于此，不计入 turns → 不会误触发摸头。
        if (half >= PAT_TURN_PX) turns++;
        half = 0;
      }
      if (sign !== 0) prevSign = sign;
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
    const h = window.innerHeight;
    const sw = spineCanvas.clientWidth || 320; // 渲染区宽（x 判定基准，见 HEAD_BOX 注释）
    const inHead =
      e.clientX >= sw * HEAD_BOX.xMin - HEAD_EXIT_MARGIN &&
      e.clientX <= sw * HEAD_BOX.xMax + HEAD_EXIT_MARGIN &&
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
  if (dizzy) {
    // 松手结束 dizzy：延迟 DIZZY_RECOVER_MS 自动回待机（晕一会儿缓过来）
    exitDizzy();
  }
}

// ---- 文字气泡：已迁至全屏特效窗（fx.html/fx.js），本窗口不再渲染气泡 ----

async function init() {
  // 情绪预设映射：agents.cjs（与 main 进程白名单同源）值 = 预设动画名；
  // closedEye/noGaze 集合同样来自当前 Agent 配置
  const cfg = await window.petAPI.getAgentConfig();
  isMainPet = cfg.isMain === true;
  patDisabled = cfg.pat?.type === "none";
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
  // 附带的全局坐标（gx/gy）在按住期间补晃动检测采样：光标快速甩动划出窗口时
  // mousemove 断流（换向/位移凑不齐 → 摸头"没反应"），主进程 16ms 轮询不断流，
  // 轻微出窗的晃动也能采到 → 轻微划出窗口仍视为摸头手势的一部分。
  window.petAPI.onCursor((x, y, gx, gy) => {
    window.SpineLayer.setCursor(x, y);
    if (dragging) pushSample(gx, gy);
  });
  // 基底稳定态：开启空闲注视 + 眨眼调度
  window.SpineLayer.setGaze(true);

  window.petAPI.onEmotion(showEmotion);
  window.petAPI.onReset(resetToBase);

  // TTS 播放中实时音量 → 嘴型 lip-sync（spine_layer 内部做包络/档位/覆盖）
  window.petAPI.onTtsLevel((rms) => {
    window.SpineLayer.setMouthLevel(rms);
  });

  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  scheduleBlink();
}

init();
