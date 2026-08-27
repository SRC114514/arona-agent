// ARONA 全屏特效渲染层：ba-click-fx（manual 输入），覆盖整个屏幕画点击特效 + 拖尾。
// 桌宠窗口只负责检测「窗口内长按拖动」，主进程把全局屏幕坐标转发到这里。
// 透明窗口关键：outputCompositing 'browser-overlay' + hostCompositingSurface 'transparent-window'。
let fx = null;

function initFx() {
  if (typeof BAClickFX === "undefined") return;
  try {
    fx = new BAClickFX.BAClickFX({
      target: "#fx",
      inputSource: "manual",
      effectBackend: "webgl2",
      bloomBackend: "webgl2",
      outputCompositing: "browser-overlay",
      overlayAlphaPolicy: "coverage",
      overlayColorCompensation: "none",
      overlayAlphaLimit: 250 / 255,
      hostCompositing: "source-over",
      hostCompositingSurface: "transparent-window",
      lightBackgroundContrastAlpha: 0,
      clickEnabled: true,
      trailEnabled: true,
      trailAlways: false,
    });
  } catch {
    fx = null;
  }
}

// 主进程已把全局屏幕坐标换算成本窗口（全屏覆盖）本地 CSS px，这里直接喂给 fx。
window.petAPI.onFxDown((x, y) => {
  if (fx) fx.pointerDown({ x, y, pointerId: 1, pointerType: "mouse" });
});
window.petAPI.onFxMove((x, y) => {
  if (fx) fx.pointerMove({ x, y, pointerId: 1, pointerType: "mouse" });
});
window.petAPI.onFxUp(() => {
  if (fx) fx.pointerUp(1);
});

// ---- 文字气泡：按角色各维护一个节点（气泡已从桌宠窗口迁到这里渲染） ----
// main.cjs 下发的消息：
//   { agent, kind: "show", data, x, y, flip } — 上屏文本并定位（flip=角色在右侧，尾巴镜像）
//   { agent, kind: "move", x, y, flip }       — 仅更新位置（拖动跟随；未显示时无副作用）
//   { agent, kind: "hide" }                   — 淡出（TTS 播完 / 兜底定时器 / 打断）
const bubbles = new Map();

function ensureBubble(agentId) {
  let el = bubbles.get(agentId);
  if (!el) {
    el = document.createElement("div");
    el.className = "bubble hidden";
    document.getElementById("fx-bubbles").appendChild(el);
    bubbles.set(agentId, el);
  }
  return el;
}

window.petAPI.onBubble((msg) => {
  const agentId = String(msg?.agent ?? "main");
  if (msg.kind === "hide") {
    bubbles.get(agentId)?.classList.add("hidden");
    return;
  }
  const el = ensureBubble(agentId);
  el.style.left = `${Math.round(msg.x)}px`;
  el.style.top = `${Math.round(msg.y)}px`;
  el.classList.toggle("flip", !!msg.flip);
  if (msg.kind === "show" && typeof msg.data === "string" && msg.data) {
    el.textContent = msg.data;
    el.classList.remove("hidden");
  }
});

initFx();
