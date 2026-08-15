// 情绪名 → track4 情绪预设动画名（pet 侧唯一权威映射）。
// 键 = main.cjs 的情绪白名单（`if (EMOTIONS[msg.name])`，勿改键）；
// 值 = 数字预设名，renderer.js 经 pet:get-emotions 消费构建 EMOTION_PRESET。
// closedEye 由 renderer.js 的 CLOSED_EYE_PRESETS 全量闭眼预设集合自动判定，无需在此标注。
// 映射为用户对照目视图库（gallery_all.html）逐项选定，以图库实际渲染效果为准。
const EMOTIONS = {
  angry: "05",
  assured: "22",
  curious: "02",
  delighted: "12",
  desire: "21",
  dizzy: "30",
  doubt: "27",
  dreaming: "23",
  enjoy: "13",
  excited: "12",
  jealous: "07",
  love: "11",
  saying: "20",
  scared: "04",
  shame: "18",
  smile: "99",
  tired: "24",
};

module.exports = { EMOTIONS };
