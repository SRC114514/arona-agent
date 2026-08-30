// 桌宠角色配置（pet 侧单一事实源，替代旧 emotions.cjs）。
// 每个 Agent 独立定义：spine 资源路径、动画/骨名、情绪映射、闭眼/禁跟随预设集合。
// main.cjs 按 ARONA_AGENT 环境变量（默认 arona）选择；renderer 经 pet:get-agent-config 获取。
// 情绪键 = main.cjs 的情绪白名单（17 个，与 change_emotion 工具一致，勿改键）；
// 值 = 数字预设动画名，renderer 构建 EMOTION_PRESET。
// 映射为用户对照目视图库逐项选定，以图库实际渲染效果为准。

const ARONA = {
  id: "arona",
  spineBase: "../../assets/blue-archive/arona/spine/",
  skelFile: "arona_spr.skel",
  atlasFile: "arona_spr.atlas.txt",
  // 构图放大系数（fitCamera 用）：Arona bounds 1:2.105 填满 320×674 窗口，保持 1.0
  extraScale: 1,
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
  // 嘴型 lip-sync 3 档（几何 bounds 初值：closed=setup 中性嘴；part=Mouse_02 说话嘴、
  // open=Mouse_11 惊讶最大张口——visual_test 情绪嘴型交叉验证开度与顶点高度相关；
  // 精确开度可生成嘴型图库目视微调）
  mouth: { slot: "Mouse_01", closed: "Mouse_01", part: "Mouse_02", open: "Mouse_11" },
};

const PLANA = {
  id: "plana",
  spineBase: "../../assets/blue-archive/plana/spine/",
  skelFile: "plana_spr.skel",
  atlasFile: "plana_spr.atlas.txt",
  // 构图放大系数：Plana bounds 1154×2216（1:1.92，比例偏宽）→ 宽度先顶格，身高只占窗口 91%，
  // 比 Arona（满窗 99.9%）矮 ~9%；1.10 使其身高 ≈ Arona（两侧各裁 ~16px，一般只裁到光环/发梢边缘）
  extraScale: 1.1,
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
  // 嘴型 lip-sync 3 档（几何 bounds 初值：closed=setup 中性嘴 Mouth_01；part=Mouth_03 中等开度；
  // open=Mouth_08 最大张口——精确开度可生成嘴型图库目视微调）
  mouth: { slot: "Mouth_01", closed: "Mouth_01", part: "Mouth_03", open: "Mouth_08" },
};

// ---- 精灵图切换式角色（Shiroko / Hoshino）----
// 与 Arona/Plana 的骨脸完全不同：仅 root / PC_Layer / halo 三骨，无 Head_Rot、无眼骨；
// 表情 = 数字预设整张 sprite 切换（Shiroko 切 00_default slot，Hoshino 切全 11 slot）。
// 仅 Idle_01（身体摆动）+ Eye_Close_01（眨眼），无 Look/Pat 动画。
// 闭眼/禁跟随集合为空：没有骨脸瞳孔跟随，自然不需要这些集合。

const SHIROKO = {
  id: "shiroko",
  // 资源在 assets/blue-archive/shiroko/spine/（修复：早期无 spine/ 子目录时指向上一级，
  // 资源整理后未同步 → 渲染 404 白屏）
  spineBase: "../../assets/blue-archive/shiroko/spine/",
  // .json = skel_to_json.cjs 导出 + gen_sway.cjs 注入衣摆微动（Idle_01 deform）；
  // 重新生成顺序：先 skel_to_json 再 gen_sway（只跑 skel_to_json 会覆盖掉形变）
  skelFile: "shiroko_spr.json",
  atlasFile: "shiroko_spr.atlas.txt",
  // bounds 1133×2287（高 95.8%）→ 保持 1.0
  extraScale: 1,
  anims: {
    idle: "Idle_01",
    blink: "Eye_Close_01",
    // 无 pat/look 动画：摸头走 emotion 预设 + PC_Layer 微倾斜
  },
  bones: {},
  // 数字预设 00~17+99（19 个）
  emotions: {
    angry: "06",
    assured: "05",
    curious: "02",
    delighted: "03",
    desire: "09",
    dizzy: "08",
    doubt: "10",
    dreaming: "03",
    enjoy: "03",
    excited: "03",
    jealous: "02",
    love: "04",
    saying: "02",
    scared: "07",
    shame: "08",
    smile: "03",
    tired: "16",
  },
  closedEyePresets: [],
  noGazePresets: [],
  // 摸头：emotion 预设 + 仅旋转脸部/头发 Mesh（tiltSlots），避免 PC_Layer 整身晃动
  pat: { type: "emotion", emotion: "enjoy", tiltSlots: ["00_default", "Hair_Cover", "eyeclose"] },
};

const HOSHINO = {
  id: "hoshino",
  spineBase: "../../assets/blue-archive/hoshino/spine/",
  // .json = skel_to_json 导出 + meshify_region 身体网格化(6×10) + gen_sway 衣摆形变；
  // 重新生成顺序：skel_to_json → meshify_region → gen_sway（任何前一步都会覆盖后一步产物）
  skelFile: "hoshino_spr.json",
  atlasFile: "hoshino_spr.atlas.txt",
  // bounds 1161×2074：480×780 窗口下比例偏窄、高度先顶格 → 1.0 恰好满窗高。
  // （1.1 是按旧 320 宽窗口调的：当时宽度先顶格、放大只裁两侧；现窗口加宽后纵向
  //   也被放大 → 脚底/头顶溢出裁切，且调多高都按比例溢出，加高窗口无效）
  extraScale: 1,
  anims: {
    idle: "Idle_01",
    blink: "Eye_Close_01",
  },
  bones: {},
  // 数字预设 00~17+99（19 个）
  emotions: {
    angry: "06",
    assured: "01",
    curious: "04",
    delighted: "03",
    desire: "17",
    dizzy: "12",
    doubt: "17",
    dreaming: "11",
    enjoy: "11",
    excited: "03",
    jealous: "07",
    love: "12",
    saying: "17",
    scared: "12",
    shame: "12",
    smile: "14",
    tired: "99",
  },
  closedEyePresets: [],
  noGazePresets: [],
  // 用户需求：星野不做摸头适配
  pat: { type: "none" },
};

// ---- Hanako / Koharu（三一补课部，精灵图切换式）----
// 结构与 shiroko/hoshino 同构（root/PC_Layer/halo 三骨）；预设数量不同：
//   hanako = 00~06 + 99（8 个）；koharu = 00~12 + 99（14 个）。
// 用户需求：不做摸头、不做瞳孔跟随（bones 为空 + pat none）。衣摆微动经 gen_sway 注入
// 的 Idle_01 deform（hanako_01 裙摆底边 band 0~500；koharu 裙摆带 band 800~1350）。

const HANAKO = {
  id: "hanako",
  spineBase: "../../assets/blue-archive/hanako/spine/",
  // .json = skel_to_json 导出 + gen_sway 衣摆形变；重新生成顺序：skel_to_json → gen_sway
  skelFile: "hanako_spr.json",
  atlasFile: "hanako_spr.atlas.txt",
  // bounds 1163×2463（更高更窄，fitCamera 高度压缩）→ 1.0 初值，目视后按需调
  extraScale: 1,
  anims: {
    idle: "Idle_01",
    blink: "Eye_Close_01",
  },
  bones: {},
  // 数字预设 00~06+99（8 个）；99 = 闭眼预设
  emotions: {
    angry: "05",
    assured: "01",
    curious: "00",
    delighted: "01",
    desire: "03",
    dizzy: "99",
    doubt: "00",
    dreaming: "99",
    enjoy: "99",
    excited: "03",
    jealous: "99",
    love: "03",
    saying: "00",
    scared: "00",
    shame: "99",
    smile: "01",
    tired: "04",
  },
  closedEyePresets: [],
  noGazePresets: [],
  // 用户需求：花子不做摸头适配
  pat: { type: "none" },
};

const KOHARU = {
  id: "koharu",
  spineBase: "../../assets/blue-archive/koharu/spine/",
  // .json = skel_to_json 导出 + gen_sway 衣摆形变；重新生成顺序：skel_to_json → gen_sway
  skelFile: "koharu_spr.json",
  atlasFile: "koharu_spr.atlas.txt",
  // bounds 1395×2069：宽(含光环球)超宽，480×780 下宽度先顶格，1.0 身高仅 ~91%。
  // 纵向不裁的上限 extra = 780/(2069×480/1395) ≈ 1.095，取 1.08 留 idle 摆动余量
  // （身高 ≈98% 满窗；光环球两侧各裁 ~19px，与旧版 1.3 按比例裁两侧一致）。
  // （1.3 是按旧 320 宽窗口调的，现窗口加宽后纵向溢出裁切脚底/头顶）
  extraScale: 1.08,
  anims: {
    idle: "Idle_01",
    blink: "Eye_Close_01",
  },
  bones: {},
  // 数字预设 00~12+99（14 个）
  emotions: {
    angry: "07",
    assured: "01",
    curious: "01",
    delighted: "03",
    desire: "03",
    dizzy: "99",
    doubt: "10",
    dreaming: "99",
    enjoy: "03",
    excited: "03",
    jealous: "10",
    love: "03",
    saying: "02",
    scared: "09",
    shame: "08",
    smile: "02",
    tired: "99",
  },
  closedEyePresets: [],
  noGazePresets: [],
  // 用户需求：小春不做摸头适配
  pat: { type: "none" },
};

// ---- Kei / Aris（游戏开发部，精灵图切换式）----
// 结构与 hanako/koharu 同构（root/PC_Layer/Halo 三骨）；预设：
//   kei = 00~33 + 99（35 个，含 04_embarassed 素材原生拼写）；aris = 00~19 + 99（21 个）。
// aris = skel_to_json(3.8.96 二进制) + gen_sway（全身单 mesh，band 850~1500），3.8 runtime。
// kei 源骨骼是 **Spine 4.2.33**（3.8 runtime 不兼容，降级转换有 region 附件错位缺陷已弃用），
//   走原生 4.2 双运行时（spineVersion: "4.2"，pet/vendor/spine/spine-webgl-4.2.js）：
//   kei_spr.json = wang606/SpineSkeletonDataConverter 同版本 skel→JSON（供 gen_sway 注入 deform；
//   4.2 JSON 的 deform 路径是 attachments.<skin>.<slot>.<att>，3.8 是 deform.<skin>.<slot>.<att>），
//   atlas/png 用素材原生 4.x 文件（CH0335_noweapon_spr.*，4.2 解析器原生支持）。
// 重新生成顺序：aris = skel_to_json → gen_sway；kei = （wang606 同版本转 JSON）→ gen_sway。

const KEI = {
  id: "kei",
  spineVersion: "4.2",
  spineBase: "../../assets/blue-archive/kei/spine/",
  skelFile: "kei_spr.json",
  atlasFile: "CH0335_noweapon_spr.atlas.txt",
  // bounds 1261×2171：480 窗宽下恰好高度占满（hair 391px < 480 无裁切）→ 保持 1.0
  extraScale: 1,
  anims: {
    idle: "Idle_01",
    blink: "Eye_Close_01",
  },
  bones: {},
  // 数字预设 00~33+99；01~06 与 hanako 同名附件（01_normal~06_depressed），映射初版复制
  // hanako，07~33 差异预设经 emotion_map_editor 网页目视重调
  emotions: {
    angry: "25",
    assured: "03",
    curious: "02",
    delighted: "03",
    desire: "03",
    dizzy: "99",
    doubt: "23",
    dreaming: "99",
    enjoy: "99",
    excited: "03",
    jealous: "23",
    love: "08",
    saying: "02",
    scared: "17",
    shame: "21",
    smile: "19",
    tired: "99",
  },
  closedEyePresets: [],
  noGazePresets: [],
  pat: { type: "none" },
};

const ARIS = {
  id: "aris",
  spineBase: "../../assets/blue-archive/aris/spine/",
  skelFile: "aris_spr.json",
  atlasFile: "aris_spr.atlas.txt",
  // bounds 1530×2118：480 窗宽下 hair 480px 恰好满宽、高度 fill 98.5% → 保持 1.0
  extraScale: 1,
  anims: {
    idle: "Idle_01",
    blink: "Eye_Close_01",
  },
  bones: {},
  // 数字预设 00~19+99；01~06 与 hanako 同名附件，映射初版复制 hanako
  emotions: {
    angry: "04",
    assured: "00",
    curious: "01",
    delighted: "03",
    desire: "03",
    dizzy: "10",
    doubt: "12",
    dreaming: "99",
    enjoy: "07",
    excited: "03",
    jealous: "04",
    love: "03",
    saying: "03",
    scared: "10",
    shame: "13",
    smile: "03",
    tired: "99",
  },
  closedEyePresets: [],
  noGazePresets: [],
  pat: { type: "none" },
};

// ---- Millennium / Justice（编码子Agent：主 Agent 经 create_subagent 派出时的临时窗口）----
// 精灵图切换式（root/PC_Layer/Halo(halo) 三骨）；动画仅数字预设 00~07+99 + Idle_01，
// **无 Eye_Close_01 眨眼动画**（anims 不配 blink，spine_layer 空值守卫跳过）。
// 无情绪/摸头/dizzy/嘴型/TTS：emotions 置空（main.cjs set_emotion 对空映射一律 unknown 拒绝）、
// 窗口 isMain=false 手势不响应、无 mouth 配置；桌宠只负责待机展示 + 最终报告气泡。

const MILLENNIUM = {
  id: "millennium",
  // ⚠️ 目录拼写就是 Millenmium（少一个 n），勿"修正"成 Millennium → 资源 404 白屏
  spineBase: "../../assets/blue-archive/Millenmium_NPC/spine/",
  skelFile: "NP0036_spr.skel",
  atlasFile: "NP0036_spr.atlas.txt",
  // bounds 721×2606（h/w 3.61，高度占满窗口）→ 1.0
  extraScale: 1,
  anims: {
    idle: "Idle_01",
  },
  bones: {},
  emotions: {},
  closedEyePresets: [],
  noGazePresets: [],
  pat: { type: "none" },
};

const JUSTICE = {
  id: "justice",
  spineBase: "../../assets/blue-archive/Justice_NPC/spine/",
  skelFile: "Justice_normal1_spr.skel",
  atlasFile: "Justice_normal1_spr.atlas.txt",
  // bounds 565×2162（h/w 3.83，高度占满窗口）→ 1.0
  extraScale: 1,
  anims: {
    idle: "Idle_01",
  },
  bones: {},
  emotions: {},
  closedEyePresets: [],
  noGazePresets: [],
  pat: { type: "none" },
};

const AGENTS = { arona: ARONA, plana: PLANA, shiroko: SHIROKO, hoshino: HOSHINO, hanako: HANAKO, koharu: KOHARU, kei: KEI, aris: ARIS, millennium: MILLENNIUM, justice: JUSTICE };

module.exports = { AGENTS };
