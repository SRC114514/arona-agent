// ARONA 桌宠 Spine 渲染层（spine_layer.js，纯 <script> UMD，无构建）
// 职责：加载 arona_spr 骨架并常驻渲染（track0 = Idle_01 全身循环，基底永不隐藏），
//       提供摸头头部跟随 / 空闲注视 / 眨眼 / 情绪预设四个骨骼接口。
// 层模型：情绪 = track4 上的数字预设动画（非循环、残留末帧持有），脸+光环瞬时切换；
//        track0 始终保持 Idle_01 循环 → 情绪期间身体继续呼吸摇摆。无 DOM 层、无溶解过渡。
// 手动骨骼覆盖时机（spike 实证）：必须在 state.apply 之后、updateWorldTransform 之前，
// 否则会被 apply 的 setup 重置（slot 颜色同理，但本模块不覆盖 slot）。
(function () {
  "use strict";

  const SPINE_BASE = "../../assets/blue-archive/arona/spine/";
  const ANIM = {
    idle: "Idle_01",           // 3.333s 全身循环。setup pose 是瘫开的折叠姿势，绝不能裸显
    blink: "Eye_Close_01",     // 0.133s 闭眼（只 key 眼部 cover + 眉毛 translate，可安全叠加）
    // 摸头用静态姿势对（用户反馈 Dev_Pat_01_M 的 0.667s 循环"机械地左右摆动"）：
    pat: "Pat_01_A",           // 单帧 pose：闭眼 cover + 嘴（attachment 版）
    patPose: "Pat_01_M",       // 单帧 pose：眉毛 translate（M 版）
    look: "Look_01_M",         // 注视姿态（单帧 pose，含嘴部微动）
    lookEnd: "LookEnd_01_M",   // 0.133s 回中
  };
  const TRACK = { main: 0, look: 2, patPose: 3, emotion: 4, blink: 5 };
  // track 布局说明：
  //   0 main    Idle_01 循环常驻 / Pat_01_A（摸头）
  //   1 （腾空） 原 blink 已上移到 5（数字预设占 4，预设的 attachment key 会覆盖低 track 的眨眼）
  //   2 look    Look_01_M / LookEnd_01_M（空闲注视）
  //   3 patPose Pat_01_M（摸头眉毛）
  //   4 emotion 数字情绪预设（非循环，残留末帧持有；高 track attachment 恒覆盖低 track）
  //   5 blink   Eye_Close_01（在预设之上，短暂盖住预设眼部；closedEye 预设期间禁止）
  const DEFAULT_MIX = 0.2;     // track 内 crossfade 时长

  // 摸头/注视参数（初值，可调）
  const GAZE_MAX_DEG = 5;      // 空闲注视：Head_Rot ±5°（已停用，保留备取）
  const PAT_MAX_DEG = 3;       // 摸头：Head_Rot 微动幅度（用户：6° 的圆弧状摆动仍诡异，再减半）
  const HEAD_SMOOTH_NEAR = 0.3;
  const HEAD_SMOOTH_FAR = 0.6;
  const HEAD_FAR_DEG = 8;      // 超过该角度差用 FAR 系数（远快近慢）
  // 构图微调：情绪 PNG 是 1010×2128 全身图，spine 包围盒 1011×2128，
  // 两者比例一致；若溶解切换时人物轻微跳位，调这三个常量（世界单位 / 倍率）
  const OFFSET_X = 0;
  const OFFSET_Y = 0;
  const EXTRA_SCALE = 1;
  // 眼球跟随：虹膜（含瞳孔）相对眼骨 rest 的最大位移（世界单位，初值可调）
  // 世界→屏幕换算：viewport ≈ 1011 世界单位 对 640 backing px（约 0.63 px/单位），
  // 10 世界单位 ≈ 3 CSS px——虹膜宽约 9 CSS px，位移幅度明显可感。
  const EYE_MAX_OFF_X = 10;
  const EYE_MAX_OFF_Y = 8;

  let canvas = null;
  let gl = null;
  let assetManager = null;
  let skeleton = null;
  let state = null;
  let renderer = null;
  let headBone = null;
  let headRestRot = 0;
  let eyeL = null;
  let eyeR = null;
  let eyeOff = { x: 0, y: 0 };
  let lastT = 0;
  let cursorPos = null;
  let patting = false;
  let gazeEnabled = false;
  let headRotSmoothed = 0;
  let currentPreset = null;     // track4 当前情绪预设动画名（null = 无情绪）
  let presetClosedEye = false;  // 当前预设是否闭眼（闭眼预设期间禁止眨眼，防 cover 被眨眼末帧置 null 造成睁眼闪）
  let presetGaze = true;        // 当前预设是否保留瞳孔跟随（闭眼 / 禁跟随预设为 false）

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // 窗口 CSS px → 骨架世界坐标（runtime 自带逆投影，与绘制投影严格一致）
  function windowToSkeleton(x, y) {
    const cw = canvas.clientWidth || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    const p = new spine.webgl.Vector3(x, y, 0);
    renderer.camera.screenToWorld(p, cw, ch);
    return { x: p.x, y: p.y };
  }

  // 尺寸拟合：包围盒等比缩放填满窗口（无 pad，构图与 1010×2128 情绪 PNG 对齐）
  function fitCamera() {
    const offset = new spine.Vector2();
    const size = new spine.Vector2();
    skeleton.getBounds(offset, size, []);
    const cw = canvas.clientWidth || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    const scale = Math.min(cw / size.x, ch / size.y) * EXTRA_SCALE;
    renderer.camera.setViewport(cw / scale, ch / scale);
    renderer.camera.position.set(
      offset.x + size.x / 2 + OFFSET_X,
      offset.y + size.y / 2 + OFFSET_Y,
      0
    );
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round((canvas.clientWidth || window.innerWidth) * dpr);
    canvas.height = Math.round((canvas.clientHeight || window.innerHeight) * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // 手动骨骼覆盖（每帧，apply 之后）：
  // 1) 眼球跟随（空闲注视）：L_Eye_01/R_Eye_01（虹膜+瞳孔所在骨）向光标偏移；
  //    瞳孔是眼骨子骨自动跟随，眼白是独立骨保持不动 → 虹膜在眼白上滑动的 Live2D 效果。
  //    **关键坑**：本 rig 的头部骨骼帧在世界空间偏转 ~76°（附件自带 -76° 补偿所以画面正常，
  //    但骨骼 translation 没有补偿）——直接写 local x/y 会把"光标左右"变成"瞳孔上下"。
  //    必须用当前世界矩阵 [[a,b],[c,d]] 的逆把世界偏移转回骨局部帧（每帧自适应）。
  // 2) 摸头 Head_Rot 跟随：仅 patting 时启用（用户确认摸头要"和光标大致方向同步"；
  //    空闲注视不歪头）。rotation 是角度量，附件补偿后与屏幕方向一致（实测 +rotation = 向右歪，
  //    光标左应给负 rotation；水平偏移比例映射，勿用 atan2——左侧 ±180° 断点会方向反转）。
  function applyManualBones() {
    const cursor = cursorPos;
    const halfW = renderer.camera.viewportWidth / 2;
    const halfH = renderer.camera.viewportHeight / 2;

    // ---- 摸头 Head_Rot 跟随（仅摸头）----
    // 方向（用户实测定标）：光标在头左侧 → 需要正 rotation（+rotation = 头向左微歪），
    // 与数学直觉相反（本 rig 附件旋转补偿的符号约定所致），勿再"修正"符号。
    let target = 0;
    if (cursor && patting) {
      const p = windowToSkeleton(cursor.x, cursor.y);
      const dx = p.x - headBone.x;
      target = clamp(-dx / halfW, -1, 1) * PAT_MAX_DEG;
    }
    const d = Math.abs(target - headRotSmoothed);
    const k = d > HEAD_FAR_DEG ? HEAD_SMOOTH_FAR : HEAD_SMOOTH_NEAR;
    headRotSmoothed += (target - headRotSmoothed) * k;
    if (target === 0 && Math.abs(headRotSmoothed) < 0.05) headRotSmoothed = 0;
    headBone.rotation = headRestRot + headRotSmoothed;

    // ---- 眼球跟随（仅空闲注视；摸头闭眼时跳过——眼 cover 挂在眉毛骨上，跟眼球位移会露馅）----
    let eyeTX = 0;
    let eyeTY = 0;
    if (cursor && gazeEnabled && !patting && eyeL && eyeR) {
      const p = windowToSkeleton(cursor.x, cursor.y);
      let nx = (p.x - headBone.x) / halfW;
      let ny = (p.y - headBone.y) / halfH;
      const nd = Math.hypot(nx, ny);
      if (nd > 1) {
        nx /= nd;
        ny /= nd;
      }
      eyeTX = nx * EYE_MAX_OFF_X;
      eyeTY = ny * EYE_MAX_OFF_Y;
    }
    const ed = Math.hypot(eyeTX - eyeOff.x, eyeTY - eyeOff.y);
    const ek = ed > 2 ? HEAD_SMOOTH_FAR : HEAD_SMOOTH_NEAR;
    eyeOff.x += (eyeTX - eyeOff.x) * ek;
    eyeOff.y += (eyeTY - eyeOff.y) * ek;
    if (eyeL) {
      // 世界偏移 → 骨局部帧：[[a,b],[c,d]] 的逆（含旋转/缩放/镜像，逐帧取当前矩阵）
      const det = eyeL.a * eyeL.d - eyeL.b * eyeL.c;
      if (Math.abs(det) > 1e-6) {
        const lx = (eyeL.d * eyeOff.x - eyeL.b * eyeOff.y) / det;
        const ly = (-eyeL.c * eyeOff.x + eyeL.a * eyeOff.y) / det;
        eyeL.x = eyeL.data.x + lx;
        eyeL.y = eyeL.data.y + ly;
        eyeR.x = eyeR.data.x + lx;
        eyeR.y = eyeR.data.y + ly;
      }
    }
  }

  function loop(now) {
    const dt = clamp((now - lastT) / 1000, 0, 0.1); // 防标签页休眠跳变
    lastT = now;
    state.update(dt);
    state.apply(skeleton);
    applyManualBones();
    skeleton.updateWorldTransform();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.begin();
    renderer.drawSkeleton(skeleton, true); // premultiplied
    renderer.end();
    requestAnimationFrame(loop);
  }

  function waitLoad(am) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const poll = () => {
        if (am.isLoadingComplete()) return resolve(Object.keys(am.errors).length === 0);
        if (performance.now() - t0 > 8000) return resolve(false);
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  }

  async function init(targetCanvas) {
    canvas = targetCanvas;
    gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!gl) throw new Error("WebGL 不可用");
    assetManager = new spine.webgl.AssetManager(gl, SPINE_BASE);
    // 纹理上传时预乘（UNPACK_PREMULTIPLY_ALPHA_WEBGL），与 drawSkeleton(skeleton, true) 的
    // premultiplied 混合配套。注意：本 vendored 3.8 构建的 GLTexture 只有 (context, image, useMipMaps)
    // 三个参数、无 premultiply 开关——必须在上传前手动设 pixelStorei，否则边缘 RGB 不预乘
    // 会与 premultiplied 混合冲突，半透明边缘爆白（"白边像抠图没抠好"+ 虹膜被冲淡成白）。
    assetManager.textureLoader = (image) => {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const tex = new spine.webgl.GLTexture(gl, image, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      return tex;
    };
    assetManager.loadBinary("arona_spr.skel");
    assetManager.loadTextureAtlas("arona_spr.atlas.txt");
    const ok = await waitLoad(assetManager);
    if (!ok) throw new Error("Spine 资源加载失败: " + JSON.stringify(assetManager.errors));

    const atlas = assetManager.get("arona_spr.atlas.txt");
    const atlasLoader = new spine.AtlasAttachmentLoader(atlas);
    const skelData = new spine.SkeletonBinary(atlasLoader).readSkeletonData(
      assetManager.get("arona_spr.skel")
    );
    skeleton = new spine.Skeleton(skelData);
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform();

    headBone = skeleton.findBone("Head_Rot");
    headRestRot = headBone ? headBone.data.rotation : 0;
    eyeL = skeleton.findBone("L_Eye_01");
    eyeR = skeleton.findBone("R_Eye_01");

    const stateData = new spine.AnimationStateData(skelData);
    stateData.defaultMix = DEFAULT_MIX;
    state = new spine.AnimationState(stateData);
    state.setAnimation(TRACK.main, ANIM.idle, true);

    renderer = new spine.webgl.SceneRenderer(canvas, gl, true);
    resize();
    fitCamera();
    window.addEventListener("resize", () => {
      resize();
      fitCamera();
    });
    requestAnimationFrame((t) => {
      lastT = t;
      requestAnimationFrame(loop);
    });
  }

  // ---- 对外 API（renderer.js / visual_test.cjs 使用）----
  window.SpineLayer = {
    init,

    // 光标（窗口本地 CSS px，可为负/超界；主进程 16ms 轮询发送）
    setCursor(x, y) {
      cursorPos = { x, y };
    },

    // 空闲注视开关（仅基底稳定态开启；情绪预设显示时关闭）
    // 注视姿态（Look_01_M 单帧 pose）由非循环 track 的"残留末帧"特性天然持有；
    // 回中动画播完显式 clearTrack（同上：防残留 track 干扰其它叠加层）
    setGaze(on) {
      gazeEnabled = !!on;
      if (on) {
        state.setAnimation(TRACK.look, ANIM.look, false);
      } else {
        const entry = state.setAnimation(TRACK.look, ANIM.lookEnd, false);
        entry.listener = { complete: () => state.clearTrack(TRACK.look) };
      }
    },

    // 摸头（摇动触发）：track0 crossfade 到 Pat_01_A（闭眼嘴）+ track3 Pat_01_M（眉毛）两个静态 pose，
    // Head_Rot 跟随光标大致方向（applyManualBones 内，仅 patting 时）。
    // 摸头期间清掉注视 pose（track2），闭眼 cover 不被注视位移干扰。
    // 决策点：摸头期间 track4 情绪预设保留不动（"情绪脸+摸头身体"，无 PNG 遮盖冲突，Phase C 目视验收）。
    startPat() {
      if (patting) return;
      patting = true;
      gazeEnabled = false;
      state.clearTrack(TRACK.look);
      state.setAnimation(TRACK.main, ANIM.pat, false);
      state.setAnimation(TRACK.patPose, ANIM.patPose, false);
    },
    // 结束摸头：crossfade 回 Idle_01，恢复空闲注视（按当前预设的 gaze 标志），头部随平滑系数回正
    endPat() {
      if (!patting) return;
      patting = false;
      gazeEnabled = presetGaze;
      state.clearTrack(TRACK.patPose);
      if (gazeEnabled) state.setAnimation(TRACK.look, ANIM.look, false);
      state.setAnimation(TRACK.main, ANIM.idle, true);
    },

    // 眨眼（track5 一次性，预设之上）。忙时返回 false：摸头中 / 闭眼情绪预设中。
    // 注意：本 vendored 3.8.95+ 运行时非循环 track 不会自动清空（trackEnd=MAX_VALUE），
    // 且残留 track 会持续 apply 末帧 → 必须在 complete 里显式 clearTrack（track5 不清理会
    // 把睁眼预设的眼睛盖成闭眼末帧）。
    blink() {
      if (patting) return false;
      if (currentPreset && presetClosedEye) return false;
      const entry = state.setAnimation(TRACK.blink, ANIM.blink, false);
      entry.listener = { complete: () => state.clearTrack(TRACK.blink) };
      return true;
    },

    // ---- 情绪预设（track4）----
    // 数字预设 = 游戏原生情绪（脸+光环 attachment 集），非循环、残留末帧永久持有，
    // 与 Idle_01 低 track 无竞争（Idle 无 attachment timeline）。瞬时切换，无过渡。
    // closedEye：闭眼预设期间禁止眨眼；gaze：是否保留瞳孔跟随（renderer 从 EMOTION_PRESET 传入）。
    setEmotionPreset(name, closedEye, gaze) {
      if (patting) return; // 摸头中不接受情绪切换（与旧 setEmotionPose 语义一致）
      currentPreset = name;
      presetClosedEye = !!closedEye;
      presetGaze = gaze !== false;
      state.setAnimation(TRACK.emotion, name, false);
    },
    // 摘除情绪预设（回基底脸）。
    // ⚠️ R2 陷阱（后续维护者勿踩）：严禁用 clearTrack 摘除——本运行时 clearTrack 直接摘
    // entry、无 mix-out，被预设 key 过的 slot 会残留预设 attachment 不还原。
    // 必须用 setEmptyAnimation 触发 mix-out 过程的 SETUP 重置（slot 回 setup attachment），
    // empty entry 播完再 clearTrack 防空壳残留。
    clearEmotionPreset() {
      currentPreset = null;
      presetClosedEye = false;
      presetGaze = true;
      const entry = state.setEmptyAnimation(TRACK.emotion, 0.1);
      entry.listener = { complete: () => state.clearTrack(TRACK.emotion) };
    },

    // 状态内省（visual_test.cjs 断言用）；init 完成前 state 为 null，返回空态不抛错
    getState() {
      if (!state) return { track0: null, track4: null, track5: null, preset: null, patting: false, gaze: false, headRot: 0, eyeOff: { x: 0, y: 0 } };
      const t0 = state.getCurrent(TRACK.main);
      const t4 = state.getCurrent(TRACK.emotion);
      const t5 = state.getCurrent(TRACK.blink);
      return {
        track0: t0 ? t0.animation.name : null,
        track4: t4 ? t4.animation.name : null,
        track5: t5 ? t5.animation.name : null,
        preset: currentPreset,
        patting,
        gaze: gazeEnabled,
        headRot: +headRotSmoothed.toFixed(1),
        eyeOff: { x: +eyeOff.x.toFixed(1), y: +eyeOff.y.toFixed(1) },
      };
    },
    // 调试内省：slot 当前 attachment 名（visual_test 断言摸头闭眼 cover 等）
    getSlotAttachment(name) {
      if (!skeleton) return null;
      const s = skeleton.findSlot(name);
      return s && s.attachment ? s.attachment.name : null;
    },
    // 调试内省：骨骼父子链 + 世界旋转（定位局部坐标系与屏幕坐标系的偏转）
    getBoneDebug(name) {
      if (!skeleton) return null;
      const b = skeleton.findBone(name);
      if (!b) return null;
      const chain = [];
      let cur = b;
      while (cur && chain.length < 10) {
        chain.push({ name: cur.data.name, rot: +cur.data.rotation.toFixed(1), len: +cur.data.length.toFixed(0) });
        cur = cur.parent;
      }
      return {
        name: b.data.name,
        worldRotDeg: +((Math.atan2(b.c, b.a) * 180) / Math.PI).toFixed(1),
        a: +b.a.toFixed(3), b: +b.b.toFixed(3), c: +b.c.toFixed(3), d: +b.d.toFixed(3),
        world: { x: +b.worldX.toFixed(1), y: +b.worldY.toFixed(1) },
        local: { x: +b.x.toFixed(1), y: +b.y.toFixed(1) },
        data: { x: +b.data.x.toFixed(1), y: +b.data.y.toFixed(1) },
        chain,
      };
    },
  };
})();
