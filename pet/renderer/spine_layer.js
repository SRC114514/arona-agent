// ARONA 桌宠 Spine 渲染层（spine_layer.js，纯 <script> UMD，无构建）
// 职责：加载当前 Agent（agents.cjs，经 ?agent= + pet:get-agent-config）骨架并常驻渲染
//       （track0 = Idle_01 全身循环，基底永不隐藏），
//       提供摸头头部跟随 / 空闲注视 / 眨眼 / 情绪预设四个骨骼接口。
// 层模型：情绪 = track4 上的数字预设动画（非循环、残留末帧持有），脸+光环瞬时切换；
//        track0 始终保持 Idle_01 循环 → 情绪期间身体继续呼吸摇摆。无 DOM 层、无溶解过渡。
// 手动骨骼覆盖时机（spike 实证）：必须在 state.apply 之后、updateWorldTransform 之前，
// 否则会被 apply 的 setup 重置（slot 颜色同理，但本模块不覆盖 slot）。
(function () {
  "use strict";

  // 当前角色 id（main.cjs loadFile 注入 ?agent=；缺省 arona）。实际配置经 IPC 从主进程取，
  // agents.cjs 是 pet 侧唯一事实源。
  let agent = null; // init() 时从 pet:get-agent-config 获取（含 anims/bones/spineBase 等）

  const TRACK = { main: 0, look: 2, patPose: 3, emotion: 4, blink: 5 };
  // track 布局说明：
  //   0 main    Idle_01 循环常驻 / Pat_01_A（摸头）
  //   1 （腾空） 原 blink 已上移到 5（数字预设占 4，预设的 attachment key 会覆盖低 track 的眨眼）
  //   2 look    Look_01_M / LookEnd_01_M（空闲注视）
  //   3 patPose Pat_01_M（摸头眉毛）
  //   4 emotion 数字情绪预设（非循环，残留末帧持有；高 track attachment 恒覆盖低 track）
  //   5 blink   Eye_Close_01（在预设之上，短暂盖住预设眼部；closedEye 预设期间禁止）
  const DEFAULT_MIX = 0.2;     // track 内 crossfade 时长

  // ---- 嘴型 lip-sync（音量 RMS → 3 档嘴型，apply 后手动覆盖嘴槽 attachment）----
  // 覆盖铁律：手动覆盖在 state.apply 之后天然压过所有 track——情绪预设（track4）也会 key 嘴槽
  // （编号动画含 Mouse_01 attachment timeline），说话结束后嘴回中性嘴属预期行为（plan.md 已确认）。
  const MOUTH_ENV_ATTACK = 0.8;   // 包络上升系数（≈80ms 时标，快——跟上语音起始）
  const MOUTH_ENV_RELEASE = 0.3;  // 包络下降系数（≈200ms 时标，慢——吸收清音/爆破音突兀感）
  const MOUTH_THRESHOLD = 0.06;   // 低于 = 静音闭口
  const MOUTH_PART_HI = 0.22;     // 高于 = 大张（微张区间在 [THRESHOLD, PART_HI)）

  // 摸头/注视参数（初值，可调）
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
  let ctx2d = null;             // Canvas 2D 降级模式上下文（WebGL 不可用时）
  let canvasRenderer2d = null;  // spine.canvas.SkeletonRenderer（降级模式）
  let mode = "webgl";           // "webgl" | "canvas2d"（WebGL 创建失败自动降级）
  let cam2d = { scale: 1, cx: 0, cy: 0, cw: 1, ch: 1 }; // 2D 模式投影参数（fitCamera 填充）
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
  // 精灵图角色的摸头：记录进入摸头前的情绪预设，结束摸头时还原（若无则摘除预设）
  let patPrevPreset = null;
  // 精灵图角色摸头微倾骨（如 PC_Layer）；骨脸角色为 null
  let tiltBone = null;
  let tiltRestRot = 0;
  // 精灵图角色摸头“仅头动”用的 mesh 槽位：直接旋转脸部/头发 Mesh 顶点，避免整身晃动
  let tiltSlots = []; // { slot, att, base, pivotX, pivotY }
  // 调试用身体冻结：非 null 时每帧把 track0 Idle_01 的 trackTime 钉在固定相位（gallery 截图用，
  // 保证不同批次截图身体姿势完全一致、可直接像素对比；桌宠正常运行不设置，零影响）
  let pinBodyT = null;
  // 嘴型 lip-sync：agent.mouth 缺省（无嘴槽角色如 Shiroko）→ mouthCfg=null 静默关闭
  let mouthCfg = null;
  let mouthLevel = 0;       // 目标电平（setMouthLevel 传入，0~1）
  let mouthEnv = 0;         // 平滑包络（快攻慢放）
  let mouthOverride = null; // 调试/标定：强制嘴槽 attachment（null = 自动）

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // 窗口 CSS px → 骨架世界坐标（与绘制投影严格一致：WebGL 用 runtime 逆投影，
  // canvas2d 用 cam2d 手动画的 ctx 变换之逆——注意 2D 投影含 y 轴翻转）
  function windowToSkeleton(x, y) {
    const cw = canvas.clientWidth || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    if (mode === "webgl") {
      const p = new spine.webgl.Vector3(x, y, 0);
      renderer.camera.screenToWorld(p, cw, ch);
      return { x: p.x, y: p.y };
    }
    return {
      x: (x - cam2d.cw / 2) / cam2d.scale + cam2d.cx,
      y: -(y - cam2d.ch / 2) / cam2d.scale + cam2d.cy,
    };
  }

  // 尺寸拟合：包围盒等比缩放填满窗口（无 pad，构图与 1010×2128 情绪 PNG 对齐）
  // extraScale 按角色参数化（agents.cjs）：Arona 1.0；Plana 1.10——其 bounds 比例偏宽、
  // 宽度先顶格导致身高只占窗口 91%，放大后接近 Arona 的满窗高度（数据见 CLAUDE.md A4）
  function fitCamera() {
    const offset = new spine.Vector2();
    const size = new spine.Vector2();
    skeleton.getBounds(offset, size, []);
    const cw = canvas.clientWidth || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    const extra = agent && typeof agent.extraScale === "number" ? agent.extraScale : EXTRA_SCALE;
    const scale = Math.min(cw / size.x, ch / size.y) * extra;
    const cx = offset.x + size.x / 2 + OFFSET_X;
    const cy = offset.y + size.y / 2 + OFFSET_Y;
    if (mode === "webgl") {
      renderer.camera.setViewport(cw / scale, ch / scale);
      renderer.camera.position.set(cx, cy, 0);
    } else {
      // canvas2d：记录投影参数，loop 每帧换算成 ctx 变换（含 y 轴翻转）
      cam2d = { scale, cx, cy, cw, ch };
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round((canvas.clientWidth || window.innerWidth) * dpr);
    canvas.height = Math.round((canvas.clientHeight || window.innerHeight) * dpr);
    if (mode === "webgl") gl.viewport(0, 0, canvas.width, canvas.height);
    // canvas2d：无需 viewport；loop 每帧按 cam2d + dpr 重设 ctx 变换
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
  // ---- 精灵图角色“仅头动”辅助：直接旋转脸部/头发 Mesh 顶点 ----
  function refreshTiltSlot(t) {
    const att = t.slot.attachment;
    if (!att || !att.vertices) {
      t.att = null;
      t.base = null;
      return false;
    }
    if (t.att === att) return true;
    t.att = att;
    t.base = Array.from(att.vertices);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < t.base.length; i += 2) {
      const x = t.base[i], y = t.base[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!isFinite(minX) || !isFinite(minY)) return false;
    t.pivotX = (minX + maxX) / 2;
    t.pivotY = (minY + maxY) / 2;
    return true;
  }

  function prepareTiltSlots() {
    tiltSlots = [];
    if (!skeleton || !agent.pat || agent.pat.type !== "emotion" || !Array.isArray(agent.pat.tiltSlots)) return;
    for (const name of agent.pat.tiltSlots) {
      const slot = skeleton.findSlot(name);
      if (!slot) continue;
      const t = { slotName: name, slot, att: null, base: null, pivotX: 0, pivotY: 0 };
      refreshTiltSlot(t);
      tiltSlots.push(t);
    }
  }

  function applySlotTilt(deg) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (const t of tiltSlots) {
      if (!refreshTiltSlot(t)) continue;
      const v = t.att.vertices;
      for (let i = 0; i < v.length; i += 2) {
        const x = t.base[i] - t.pivotX;
        const y = t.base[i + 1] - t.pivotY;
        v[i] = t.pivotX + x * cos - y * sin;
        v[i + 1] = t.pivotY + x * sin + y * cos;
      }
    }
  }

  function restoreSlotTilt() {
    for (const t of tiltSlots) {
      if (!t.att || !t.base) continue;
      for (let i = 0; i < t.att.vertices.length; i++) t.att.vertices[i] = t.base[i];
    }
  }

  // ---- 嘴型 lip-sync：音量包络 → 3 档嘴型，apply 后手动覆盖嘴槽 attachment ----
  // 在 state.apply 之后调用（与摸头/眼球同类，手动覆盖压过所有 track，包括 track4 情绪预设）。
  // ⚠️ 静音（无电平且包络已收尾）必须 return 不干预：否则会把情绪预设 key 的嘴型强制打回 closed
  // （visual_test 回归实证：angry 预设 Mouse_06 被改回 Mouse_01）。说话结束包络衰减到 0 后
  // 自然交还控制权，state.apply 让 track4 的嘴型（或 setup 中性嘴）恢复显示。
  function applyMouth() {
    if (!mouthCfg || !skeleton || !state) return;
    const slot = skeleton.findSlot(mouthCfg.slot);
    if (!slot) return;
    if (mouthOverride !== null) {
      // 调试/标定：强制指定嘴型（mouth 图库截图用）
      if (slot.attachment && slot.attachment.name === mouthOverride) return;
      const att = skeleton.getAttachment(slot.data.index, mouthOverride);
      if (att) slot.attachment = att;
      return;
    }
    if (mouthLevel <= 0 && mouthEnv <= 0) return;
    // 包络：快攻慢放（release 吸收清音/爆破音突兀感，避免嘴型跳变机械）
    const target = mouthLevel;
    if (target > mouthEnv) mouthEnv += (target - mouthEnv) * MOUTH_ENV_ATTACK;
    else mouthEnv += (target - mouthEnv) * MOUTH_ENV_RELEASE;
    if (mouthEnv < 0.002) mouthEnv = 0;
    const name = mouthEnv < MOUTH_THRESHOLD
      ? mouthCfg.closed
      : mouthEnv < MOUTH_PART_HI ? mouthCfg.part : mouthCfg.open;
    if (slot.attachment && slot.attachment.name === name) return;
    const att = skeleton.getAttachment(slot.data.index, name);
    if (att) slot.attachment = att;
  }

  function applyManualBones() {
    const cursor = cursorPos;
    if (!skeleton) return;
    // 无头/眼骨的角色（Shiroko/Hoshino 精灵图骨架）直接短路；顶多处理 PC_Layer 微倾或 Mesh 头动
    const hasHead = !!headBone;
    const hasEyes = !!(eyeL && eyeR);
    const hasTilt = !!tiltBone;
    const hasSlotTilt = tiltSlots.length > 0;
    if (!hasHead && !hasEyes && !hasTilt && !hasSlotTilt) {
      return;
    }
    let halfW = 1;
    let halfH = 1;
    if (mode === "webgl" && renderer) {
      halfW = renderer.camera.viewportWidth / 2;
      halfH = renderer.camera.viewportHeight / 2;
    } else if (cam2d.scale > 0) {
      halfW = cam2d.cw / (2 * cam2d.scale);
      halfH = cam2d.ch / (2 * cam2d.scale);
    }

    // ---- 摸头 Head_Rot 跟随（骨脸角色，仅摸头）----
    // 方向（用户实测定标）：光标在头左侧 → 需要正 rotation（+rotation = 头向左微歪），
    // 与数学直觉相反（本 rig 附件旋转补偿的符号约定所致），勿再"修正"符号。
    let target = 0;
    if (cursor && patting && hasHead) {
      const p = windowToSkeleton(cursor.x, cursor.y);
      const dx = p.x - headBone.x;
      target = clamp(-dx / halfW, -1, 1) * PAT_MAX_DEG;
    }
    const d = Math.abs(target - headRotSmoothed);
    const k = d > HEAD_FAR_DEG ? HEAD_SMOOTH_FAR : HEAD_SMOOTH_NEAR;
    headRotSmoothed += (target - headRotSmoothed) * k;
    if (target === 0 && Math.abs(headRotSmoothed) < 0.05) headRotSmoothed = 0;
    if (hasHead) headBone.rotation = headRestRot + headRotSmoothed;

    // ---- 精灵图角色摸头微倾（仅头动：旋转脸部/头发 Mesh 顶点，不再转 PC_Layer 整身）----
    if (hasSlotTilt) {
      if (patting) {
        const cw = canvas.clientWidth || window.innerWidth;
        const tiltTarget = cursor ? clamp(-(cursor.x - cw / 2) / (cw / 2), -1, 1) * PAT_MAX_DEG : 0;
        applySlotTilt(tiltTarget);
      } else {
        restoreSlotTilt();
      }
    } else if (hasTilt) {
      let tiltTarget = 0;
      if (cursor && patting) {
        const p = windowToSkeleton(cursor.x, cursor.y);
        const dx = p.x - tiltBone.x;
        tiltTarget = clamp(-dx / halfW, -1, 1) * PAT_MAX_DEG;
      }
      tiltBone.rotation = tiltRestRot + tiltTarget;
    }

    // ---- 眼球跟随（仅空闲注视；摸头闭眼时跳过——眼 cover 挂在眉毛骨上，跟眼球位移会露馅）----
    let eyeTX = 0;
    let eyeTY = 0;
    if (cursor && gazeEnabled && !patting && hasEyes && hasHead) {
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
    if (hasEyes) {
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
    if (pinBodyT !== null) {
      // 冻结身体相位：update 推进后再钉回，保证 apply 时 track0 姿势确定
      const e = state.getCurrent(TRACK.main);
      if (e) e.trackTime = pinBodyT;
    }
    state.apply(skeleton);
    applyMouth();
    applyManualBones();
    skeleton.updateWorldTransform();
    if (mode === "webgl") {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.begin();
      renderer.drawSkeleton(skeleton, true); // premultiplied
      renderer.end();
    } else {
      // Canvas 2D 降级：手动投影（等价 WebGL camera 的 setViewport+position）：
      // setTransform(dpr) 后 translate 到画布中心 → scale(scale, -scale) 缩放并翻转 y
      // （骨架世界坐标 y 向上、canvas 2D y 向下）→ translate 到世界中心。
      const c = ctx2d;
      const dpr = window.devicePixelRatio || 1;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, cam2d.cw, cam2d.ch);
      c.translate(cam2d.cw / 2, cam2d.ch / 2);
      c.scale(cam2d.scale, -cam2d.scale);
      c.translate(-cam2d.cx, -cam2d.cy);
      canvasRenderer2d.draw(skeleton);
    }
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
    // 先取当前 Agent 配置（agents.cjs 单一事实源，经主进程 IPC 注入）
    agent = await window.petAPI.getAgentConfig();
    if (!agent) throw new Error("pet:get-agent-config 未返回配置");
    canvas = targetCanvas;
    gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (gl) {
      // ---- WebGL 模式（macOS 主路径；Windows 需 enable-unsafe-swiftshader 软渲染）----
      mode = "webgl";
      assetManager = new spine.webgl.AssetManager(gl, agent.spineBase);
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
    } else {
      // ---- Canvas 2D 降级（WebGL 不可用时的保险丝，如 Windows 软渲染失败/远程桌面）----
      // getContext("webgl") 返回 null 不锁定 canvas 类型，可再取 2d。
      // canvas 2D 无 premultiplied 管线问题（drawImage 由浏览器按 straight alpha 合成）。
      mode = "canvas2d";
      console.warn("[pet:render] WebGL 不可用，已降级 Canvas 2D 渲染（性能较低，仅兜底）");
      ctx2d = canvas.getContext("2d");
      if (!ctx2d) throw new Error("Canvas 2D 也不可用");
      assetManager = new spine.AssetManager(
        (img) => ({ getImage: () => img }), // 最小 Texture：仅需 getImage()（drawImages 只读图）
        agent.spineBase
      );
    }
    // skelFile 支持两种格式：.skel 二进制（SkeletonBinary）与 .json（SkeletonJson，
    // 由 pet/tools/skel_to_json.cjs 从 skel 导出，供 gen_sway 等离线工具注入形变动画）
    const isJson = agent.skelFile.endsWith(".json");
    if (isJson) assetManager.loadText(agent.skelFile);
    else assetManager.loadBinary(agent.skelFile);
    assetManager.loadTextureAtlas(agent.atlasFile);
    const ok = await waitLoad(assetManager);
    if (!ok) throw new Error("Spine 资源加载失败: " + JSON.stringify(assetManager.errors));

    const atlas = assetManager.get(agent.atlasFile);
    const atlasLoader = new spine.AtlasAttachmentLoader(atlas);
    const skelData = isJson
      ? new spine.SkeletonJson(atlasLoader).readSkeletonData(
          JSON.parse(assetManager.get(agent.skelFile))
        )
      : new spine.SkeletonBinary(atlasLoader).readSkeletonData(
          assetManager.get(agent.skelFile)
        );
    skeleton = new spine.Skeleton(skelData);
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform();

    headBone = agent.bones?.head ? skeleton.findBone(agent.bones.head) : null;
    headRestRot = headBone ? headBone.data.rotation : 0;
    eyeL = agent.bones?.eyeL ? skeleton.findBone(agent.bones.eyeL) : null;
    eyeR = agent.bones?.eyeR ? skeleton.findBone(agent.bones.eyeR) : null;
    tiltBone = agent.pat?.tiltBone ? skeleton.findBone(agent.pat.tiltBone) : null;
    tiltRestRot = tiltBone ? tiltBone.data.rotation : 0;
    prepareTiltSlots();
    // 嘴型 lip-sync 配置（无嘴槽角色缺省 mouth → 静默关闭）
    mouthCfg = agent.mouth && agent.mouth.slot ? agent.mouth : null;

    const stateData = new spine.AnimationStateData(skelData);
    stateData.defaultMix = DEFAULT_MIX;
    state = new spine.AnimationState(stateData);
    state.setAnimation(TRACK.main, agent.anims.idle, true);

    if (mode === "webgl") {
      renderer = new spine.webgl.SceneRenderer(canvas, gl, true);
    } else {
      canvasRenderer2d = new spine.canvas.SkeletonRenderer(ctx2d);
      // drawImages 模式会跳过 mesh attachment（骨架网格变形部分不显示），
      // 开 triangleRendering 逐三角形绘制保证骨架完整（性能换完整性，兜底场景可接受）。
      canvasRenderer2d.triangleRendering = true;
    }
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

  // 情绪预设内部实现（不检查 patting 守卫；摸头内部路径复用）
  function applyEmotionPreset(name, closedEye, gaze) {
    currentPreset = name;
    presetClosedEye = !!closedEye;
    presetGaze = gaze !== false;
    state.setAnimation(TRACK.emotion, name, false);
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
    // 精灵图角色（无 look 动画）退化为仅记录 gazeEnabled，不播任何动画。
    setGaze(on) {
      gazeEnabled = !!on;
      if (!agent.anims.look || !agent.anims.lookEnd) return;
      if (on) {
        state.setAnimation(TRACK.look, agent.anims.look, false);
      } else {
        const entry = state.setAnimation(TRACK.look, agent.anims.lookEnd, false);
        entry.listener = { complete: () => state.clearTrack(TRACK.look) };
      }
    },

    // 摸头（摇动触发）：
    // - 骨脸角色（Arona/Plana）：track0 crossfade 到 Pat_01_A + track3 Pat_01_M，
    //   Head_Rot 跟随光标（applyManualBones 内，仅 patting 时）。
    // - 精灵图角色（Shiroko）：无 Pat 动画，改走 pat.emotion 情绪预设 + pat.tiltBone 微倾。
    // - pat.type = "none"（Hoshino）：不触发摸头。
    // 摸头期间清掉注视 pose（track2），闭眼 cover 不被注视位移干扰。
    startPat() {
      const patType = agent.pat?.type || "anim";
      if (patType === "none") return;
      if (patting) return;

      if (patType === "emotion") {
        // 记录当前情绪预设，进入"摸头脸"后结束摸头时还原
        patPrevPreset = currentPreset;
        // pat.emotion 是情绪键（如 "enjoy"），需经 agent.emotions 解析成数字预设动画名
        const patEmotionName = agent.pat.emotion;
        const patPreset = (patEmotionName && agent.emotions && agent.emotions[patEmotionName]) || patEmotionName;
        patting = true;
        gazeEnabled = false;
        state.clearTrack(TRACK.look);
        applyEmotionPreset(patPreset, false, false);
        return;
      }

      patting = true;
      gazeEnabled = false;
      state.clearTrack(TRACK.look);
      if (agent.anims.pat) state.setAnimation(TRACK.main, agent.anims.pat, false);
      if (agent.anims.patPose) state.setAnimation(TRACK.patPose, agent.anims.patPose, false);
    },
    // 结束摸头：
    // - 骨脸：crossfade 回 Idle_01，恢复空闲注视（按当前预设的 gaze 标志），头部随平滑系数回正
    // - 精灵图：还原摸头前的情绪预设（无则摘除），PC_Layer 随 applyManualBones 归零
    endPat() {
      if (!patting) return;
      patting = false;
      const patType = agent.pat?.type || "anim";
      if (patType === "emotion") {
        if (patPrevPreset !== null) {
          applyEmotionPreset(patPrevPreset, presetClosedEye, presetGaze);
        } else {
          window.SpineLayer.clearEmotionPreset();
        }
        patPrevPreset = null;
        gazeEnabled = presetGaze;
        return;
      }
      gazeEnabled = presetGaze;
      state.clearTrack(TRACK.patPose);
      if (gazeEnabled && agent.anims.look) state.setAnimation(TRACK.look, agent.anims.look, false);
      state.setAnimation(TRACK.main, agent.anims.idle, true);
    },

    // 眨眼（track5 一次性，预设之上）。忙时返回 false：摸头中 / 闭眼情绪预设中。
    // 注意：本 vendored 3.8.95+ 运行时非循环 track 不会自动清空（trackEnd=MAX_VALUE），
    // 且残留 track 会持续 apply 末帧 → 必须在 complete 里显式 clearTrack（track5 不清理会
    // 把睁眼预设的眼睛盖成闭眼末帧）。
    blink() {
      if (!agent.anims.blink) return false; // 无眨眼动画的角色（编码子Agent NPC 骨架未导出眨眼）
      if (patting) return false;
      if (currentPreset && presetClosedEye) return false;
      const entry = state.setAnimation(TRACK.blink, agent.anims.blink, false);
      entry.listener = { complete: () => state.clearTrack(TRACK.blink) };
      return true;
    },

    // ---- 情绪预设（track4）----
    // 数字预设 = 游戏原生情绪（脸+光环 attachment 集，或精灵图整脸切换），非循环、残留末帧永久持有，
    // 与 Idle_01 低 track 无竞争（Idle 无 attachment timeline）。瞬时切换，无过渡。
    // closedEye：闭眼预设期间禁止眨眼；gaze：是否保留瞳孔跟随（renderer 从 EMOTION_PRESET 传入）。
    setEmotionPreset(name, closedEye, gaze) {
      if (patting) return; // 摸头中不接受外部情绪切换（内部摸头路径用 applyEmotionPreset）
      applyEmotionPreset(name, closedEye, gaze);
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
    getBoneNames() {
      if (!skeleton) return [];
      return skeleton.bones.map((b) => b.data.name);
    },
    getBones() {
      if (!skeleton) return [];
      return skeleton.bones.map((b) => ({
        name: b.data.name,
        parent: b.data.parent ? b.data.parent.name : null,
        rotation: +b.data.rotation.toFixed(2),
        x: +b.data.x.toFixed(1),
        y: +b.data.y.toFixed(1),
        length: +b.data.length.toFixed(1),
      }));
    },
    getSlots() {
      if (!skeleton) return [];
      return skeleton.slots.map((s) => {
        const a = s.attachment;
        return {
          name: s.data.name,
          bone: s.data.boneData.name,
          attachment: a ? a.name : null,
          type: a ? a.constructor.name : null,
          x: a && typeof a.x === "number" ? +a.x.toFixed(2) : null,
          y: a && typeof a.y === "number" ? +a.y.toFixed(2) : null,
          rotation: a && typeof a.rotation === "number" ? +a.rotation.toFixed(2) : null,
          scaleX: a && typeof a.scaleX === "number" ? +a.scaleX.toFixed(3) : null,
          scaleY: a && typeof a.scaleY === "number" ? +a.scaleY.toFixed(3) : null,
        };
      });
    },
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
    // 调试内省：全骨架附件签名（slot=attachment 列表）。比像素更硬的证据——
    // 情绪预设间签名应互不相同（B5 普查）；签名不同而截图相同 = capturePage 拿到过期纹理
    getAttachmentSignature() {
      if (!skeleton) return null;
      const parts = [];
      for (const s of skeleton.slots) {
        if (s.attachment) parts.push(s.data.name + "=" + s.attachment.name);
      }
      return parts.join("|");
    },
    // 调试用：冻结 track0 身体相位（gallery 批量截图对比用；null 恢复动画）
    pinBody(t) {
      pinBodyT = t === undefined ? 0 : t;
    },

    // ---- 嘴型 lip-sync（音量 RMS → 3 档）----
    // renderer 在 pet:tts-level 事件时调用；rms 为裸音量 0~1，包络/档位在此内部处理
    setMouthLevel(rms) {
      mouthLevel = clamp(+rms || 0, 0, 1);
    },
    // 调试/标定：强制嘴槽 attachment（null 恢复自动）。mouth 图库截图用。
    setMouthOverride(name) {
      mouthOverride = name || null;
    },
    // 嘴型图库：枚举嘴槽所有可选 attachment 名（skin 定义；无 mouth 配置返回空数组）
    getMouthOptions() {
      if (!skeleton || !mouthCfg) return [];
      // skin.attachments 以 slotIndex 为键（非 slot 名），须经 findSlotIndex 转换
      const idx = skeleton.findSlotIndex(mouthCfg.slot);
      const atts = skeleton.data.defaultSkin.attachments[idx];
      return atts ? Object.keys(atts) : [];
    },
  };
})();
