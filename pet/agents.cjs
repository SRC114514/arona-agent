// 桌宠角色配置（pet 侧单一事实源，替代旧 emotions.cjs）。
// 每个 Agent 独立定义：spine 资源路径、动画/骨名、情绪映射、闭眼/禁跟随预设集合。
// main.cjs 按 ARONA_AGENT 环境变量（默认 arona）选择；renderer 经 pet:get-agent-config 获取。
// 情绪键 = main.cjs 的情绪白名单（17 个，与 change_emotion 工具一致，勿改键）；
// 值 = 数字预设动画名，renderer 构建 EMOTION_PRESET。
// 映射为用户对照目视图库逐项选定，以图库实际渲染效果为准。

const ARONA = {
  id: "arona",
  label: "Arona",
  spineBase: "../../assets/blue-archive/arona/spine/",
  skelFile: "arona_spr.skel",
  atlasFile: "arona_spr.atlas.txt",
  anims: {
    idle: "Idle_01",           // 3.333s 全身循环。setup pose 是瘫开的折叠姿势，绝不能裸显
    blink: "Eye_Close_01",     // 闭眼（只 key 眼部 cover + 眉毛 translate，可安全叠加）
    pat: "Pat_01_A",           // 摸头静态 pose：闭眼 cover + 嘴（attachment 版）
    patPose: "Pat_01_M",       // 摸头静态 pose：眉毛 translate（M 版）
    look: "Look_01_M",         // 注视姿态（单帧 pose，含嘴部微动）
    lookEnd: "LookEnd_01_M",   // 回中
  },
  bones: {
    head: "Head_Rot",
    eyeL: "L_Eye_01",
    eyeR: "R_Eye_01",
  },
  emotions: {
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
  },
  // 闭眼预设：该预设 key 了 L/R_Eye_Cover → 情绪期间禁止眨眼
  // （Eye_Close_01 播完末帧会把 cover 置 null，闭眼预设上眨眼会闪出"睁眼"）
  closedEyePresets: [
    "03", "10", "11", "12", "13", "14", "18", "23", "24", "26", "27", "28", "29", "30", "32", "99",
  ],
  // 睁眼预设默认保留瞳孔跟随；以下预设禁跟随：jealous(07) 自带固定斜视（跟随会覆盖）、
  // angry(05) 眼神固定不跟光标、doubt(27) 闭眼本就关闭（显式列出以便理解）
  noGazePresets: ["05", "07", "27"],
};

const PLANA = {
  id: "plana",
  label: "Plana",
  spineBase: "../../assets/blue-archive/plana/spine/",
  skelFile: "plana_spr.skel",
  atlasFile: "plana_spr.atlas.txt",
  anims: {
    idle: "Idle_01",           // 6.667s 全身循环（与 Arona 的 3.333s 不同，勿改）
    blink: "Eye_Close_01",     // 0.333s 闭眼
    pat: "Pat_01_A",           // 摸头静态 pose：闭眼 cover + 嘴（attachment 版）
    patPose: "Pat_01_M",       // 摸头静态 pose：眉毛 translate（M 版）
    look: "Look_01_M",         // 注视姿态（单帧 pose）
    lookEnd: "LookEnd_01_M",   // 回中（0.433s）
  },
  bones: {
    head: "Head_Rot",
    eyeL: "L_Eye_01",
    // ⚠️ Plana 右眼骨是 R_Eye_1（无前导零），Arona 是 R_Eye_01——勿"修正"
    eyeR: "R_Eye_1",
  },
  emotions: {
    // 用户 2026-08-15 对照重绑版图库（plana_emotions_rebind_*.html，无水印防错位版）重新指定；
    // 共用预设：jealous/doubt=20；love/smile=17；delighted/excited=09（合并，与 Arona 12 同语义）；
    // dreaming/enjoy/scared/shame=14；desire/saying=18
    angry: "05",
    assured: "03",
    curious: "07",
    delighted: "09",
    desire: "18",
    dizzy: "13",
    doubt: "20",
    dreaming: "14",
    enjoy: "14",
    excited: "09",
    jealous: "20",
    love: "17",
    saying: "18",
    scared: "14",
    shame: "14",
    smile: "17",
    tired: "06",
  },
  // 闭眼预设（客观普查：cover slot 非空，probe_cover 转储）：闭眼预设期间禁止眨眼、关闭瞳孔跟随
  closedEyePresets: ["04", "05", "06", "10", "11", "12", "13", "14", "16", "17", "99"],
  // 禁跟随预设：05 闭眼冗余无害；07（curious）按 Arona 同源保留固定斜视，待用户目视确认跟随是否别扭
  noGazePresets: ["05", "07"],
};

const AGENTS = { arona: ARONA, plana: PLANA };

module.exports = { AGENTS };
