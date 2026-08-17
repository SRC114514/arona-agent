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

initFx();
