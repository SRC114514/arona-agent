// 表情目视图库（gallery.js）：加载当前 Agent 骨架，逐帧切换数字情绪预设，供人工目视选号。
// 由 pet/tools/gallery_capture.cjs 驱动截图。
// 与 spinetest 不同：这里不调度眨眼/注视/拖动，保证截图干净。
// 注意：截图内不带任何水印——DOM 文本与 WebGL 画布是两条合成路径，
// 曾出现水印滞后于骨架的过期纹理帧，编号与脸错位误导选号；编号一律以 gallery.html 文字为准。
const canvas = document.getElementById("spine");

async function init() {
  await window.SpineLayer.init(canvas);
  // 冻结 track0 Idle_01 相位：不同截图/不同批次身体姿势完全一致，可像素级对比（编号↔脸一一对应）
  window.SpineLayer.pinBody(1.0);
  window.__gallery = {
    /**
     * 切换到指定预设（数字动画名）。
     * 数字预设 3.333s 非循环、残留末帧持有 → 外部按 settledMs 节奏等动画落定后再截图。
     */
    show(name) {
      window.SpineLayer.setEmotionPreset(String(name), false, true);
    },
    /** 情绪确认模式：按情绪名渲染其映射预设 */
    showEmotion(_emotionName, preset) {
      window.SpineLayer.setEmotionPreset(String(preset), false, true);
    },
    /** 数字预设动画时长 + 余量（等落定到末帧——settled face 才是表情本体，见 CLAUDE.md B5） */
    settledMs: 3600,
  };
}

init().catch((err) => {
  console.error("gallery init failed:", err);
});
