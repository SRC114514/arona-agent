// ARONA Spine 调试页（spinetest）：加载 skel/atlas/png → 转储骨骼/动画事实 → 交互预览。
// 用途（spike）：
//   1) Idle_01 姿势与情绪 PNG 构图对齐校验（?overlay=smile 半透叠）
//   2) Head_Rot 手动设 rotation 是否只转头
//   3) A/M/Dev 各变体动画语义
//   4) Look/LookEnd 起止姿势与介导路由对应关系
//   5) Flush_01/02 是否可叠加的局部动画
//   6) Touch_Point_KeyV / Touch_Eye_KeyT 是否 Point attachment
//   7) spine-webgl 在透明窗的实际合成效果（?pm=0 可切换非 premultiplied 路径对比）
// 键盘：←/→ 手动转 Head_Rot；↑/↓ 循环动画；1~9/0/a~z 直接跳转到第 N 个动画。
// ?probe：加载完成后置 window.__SPINE_READY=true 并在 console 输出完整事实清单（供探针 harness 读取）。
const SPINE_BASE = "../../assets/blue-archive/arona/spine/";
const canvas = document.getElementById("spine");
const hud = document.getElementById("hud");
const overlayEl = document.getElementById("overlay");
const params = new URLSearchParams(location.search);

const USE_PM = params.get("pm") !== "0"; // 默认 premultiplied 路径
const PROBE = params.has("probe");
const OVERLAY = params.get("overlay"); // 情绪名（如 smile）：半透叠校验
console.log("[spinetest] URL", location.href, "| search", location.search, "| PROBE", PROBE);

let gl = null;
let assetManager = null;
let skeleton = null;
let state = null;
let renderer = null;
let headBone = null;
let headRestRot = 0;
let manualHeadRot = 0;
let isoSet = null;
let animIndex = 0;
let fps = 0;
let fit = null; // { offset:{x,y}, size:{x,y}, scale }

function log(...args) {
  console.log("[spinetest]", ...args);
}

// ---- 加载 ----
async function load() {
  gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: USE_PM,
    antialias: true,
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    hud.textContent = "WebGL 不可用";
    return;
  }
  assetManager = new spine.webgl.AssetManager(gl, SPINE_BASE);
  if (USE_PM) {
    // 纹理上传时预乘（UNPACK_PREMULTIPLY_ALPHA_WEBGL），与 drawSkeleton(skeleton, true) 配套
    // 本 vendored 3.8 构建 GLTexture 无 premultiply 参数，须上传前手动设 pixelStorei
    assetManager.textureLoader = (image) => {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const tex = new spine.webgl.GLTexture(gl, image, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      return tex;
    };
  }
  assetManager.loadBinary("arona_spr.skel");
  assetManager.loadTextureAtlas("arona_spr.atlas.txt");

  const ok = await waitLoad();
  if (!ok) {
    hud.textContent = "加载失败：\n" + Object.keys(assetManager.errors).map((k) => k + ": " + assetManager.errors[k]).join("\n");
    console.error("加载失败", assetManager.errors);
    return;
  }

  const atlas = assetManager.get("arona_spr.atlas.txt");
  const atlasLoader = new spine.AtlasAttachmentLoader(atlas);
  const binary = new spine.SkeletonBinary(atlasLoader);
  const skelBytes = assetManager.get("arona_spr.skel");
  let skelData = null;
  try {
    skelData = binary.readSkeletonData(skelBytes);
  } catch (e) {
    console.error("readSkeletonData 失败:", e.message, "\n", e.stack);
    hud.textContent = "解析失败: " + e.message;
    return;
  }

  skeleton = new spine.Skeleton(skelData);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform();
  headBone = skeleton.findBone("Head_Rot");
  headRestRot = headBone ? headBone.data.rotation : 0;

  state = new spine.AnimationState(new spine.AnimationStateData(skelData));
  // 基础轨道固定 Idle_01（setup pose 是瘫开的折叠姿势，不能直接显示）
  state.setAnimation(0, "Idle_01", true);
  animIndex = skelData.animations.findIndex((a) => a.name === "Idle_01");

  renderer = new spine.webgl.SceneRenderer(canvas, gl, true);
  resize();
  fitCamera();

  // 半透叠校验层
  if (OVERLAY) {
    overlayEl.src = "../../assets/blue-archive/arona/arona_" + OVERLAY + ".png";
    overlayEl.style.display = "block";
  }

  dumpFacts();
  if (PROBE) window.__SPINE_READY = true;
  requestAnimationFrame(loop);
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", resize);
  window.addEventListener("mousemove", onMouseMove);
  updateHud();
}

function waitLoad() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const poll = () => {
      if (assetManager.isLoadingComplete()) return resolve(Object.keys(assetManager.errors).length === 0);
      if (performance.now() - t0 > 8000) return resolve(false);
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

// ---- 尺寸与相机拟合 ----
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 320;
  const h = canvas.clientHeight || 674;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
}

// 以 setup pose 包围盒为中心，等比缩放填满画布（CSS px 世界单位；DPR 由 backing store 处理）
function fitCamera() {
  const offset = new spine.Vector2();
  const size = new spine.Vector2();
  skeleton.getBounds(offset, size, []);
  const pad = 8;
  const cw = canvas.clientWidth || 320;
  const ch = canvas.clientHeight || 674;
  const scale = Math.min(cw / (size.x + pad * 2), ch / (size.y + pad * 2));
  renderer.camera.setViewport(cw / scale, ch / scale);
  renderer.camera.position.set(offset.x + size.x / 2, offset.y + size.y / 2, 0);
  fit = { offset: { x: offset.x, y: offset.y }, size: { x: size.x, y: size.y }, scale };
  log("包围盒", JSON.stringify(fit));
}

// 窗口 CSS px → 骨架世界坐标（逆相机变换）
function windowToSkeleton(x, y) {
  const cw = canvas.clientWidth || 320;
  const ch = canvas.clientHeight || 674;
  const p = new spine.webgl.Vector3(x, y, 0);
  renderer.camera.screenToWorld(p, cw, ch);
  return { x: p.x, y: p.y };
}

// ---- 事实清单转储 ----
function dumpFacts() {
  const sd = skeleton.data;
  const TL = spine.TimelineType;
  const typeName = (t) => {
    const id = (t.getPropertyId() >> 24) & 0xff;
    for (const k in TL) if (TL[k] === id) return k;
    return "?";
  };
  const anims = sd.animations.map((a) => {
    const types = {};
    const keyedBones = new Set();
    const keyedSlots = new Set();
    const attachments = [];
    for (const tl of a.timelines) {
      types[typeName(tl)] = (types[typeName(tl)] || 0) + 1;
      if (tl.boneIndex != null) keyedBones.add(sd.bones[tl.boneIndex].name);
      if (tl.slotIndex != null) keyedSlots.add(sd.slots[tl.slotIndex].name);
      if (typeName(tl) === "attachment") {
        // 列出该 timeline 里的 attachment 帧名（含眼部 slot 切换；帧名存于 tl.attachmentNames）
        const names = [];
        for (let i = 0; i < tl.frames.length; i++) {
          names.push(sd.slots[tl.slotIndex].name + ":" + (tl.attachmentNames[i] == null ? "∅" : tl.attachmentNames[i]));
        }
        attachments.push(names.join(","));
      }
    }
    return {
      name: a.name,
      duration: +a.duration.toFixed(3),
      timelines: a.timelines.length,
      types,
      keyedBones: [...keyedBones],
      keyedSlots: [...keyedSlots],
      attachmentFrames: attachments,
    };
  });
  // Point attachment（动画师定义的触摸命中点）
  const points = [];
  for (const skin of sd.skins) {
    for (const slotName in skin.attachments) {
      for (const name in skin.attachments[slotName]) {
        const at = skin.attachments[slotName][name];
        if (at instanceof spine.PointAttachment) {
          points.push({ skin: skin.name, slot: slotName, name, x: +at.x.toFixed(1), y: +at.y.toFixed(1), rotation: at.rotation });
        }
      }
    }
  }
  const facts = {
    version: sd.version,
    hash: sd.hash,
    width: sd.width,
    height: sd.height,
    bones: sd.bones.map((b) => ({
      name: b.name,
      parent: b.parent ? b.parent.name : null,
      rotation: +b.rotation.toFixed(2),
      x: +b.x.toFixed(1),
      y: +b.y.toFixed(1),
      length: +b.length.toFixed(1),
      transformMode: b.transformMode,
    })),
    slots: sd.slots.map((s) => ({ name: s.name, bone: s.boneData.name, attachment: s.attachmentName })),
    skins: sd.skins.map((s) => s.name),
    animations: anims,
    pointAttachments: points,
    events: sd.events.map((e) => e.name),
    ikConstraints: sd.ikConstraints.map((c) => c.name),
    fit,
    headBone: headBone
      ? { name: headBone.data.name, parent: headBone.parent ? headBone.parent.data.name : null, restRot: headRestRot, world: { x: +headBone.x.toFixed(1), y: +headBone.y.toFixed(1) } }
      : null,
  };
  window.__FACTS = facts;
  if (PROBE) log("FACTS", JSON.stringify(facts));
  log("动画数", sd.animations.length, "骨骼数", sd.bones.length, "Point 附件数", points.length);
}

// ---- 渲染循环 ----
let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  fps = fps * 0.9 + (1000 / Math.max(1, now - (loop._lastNow || now))) * 0.1;
  loop._lastNow = now;

  state.update(dt);
  state.apply(skeleton);
  // 手动 Head_Rot 覆盖：apply 之后、updateWorldTransform 之前（spike 验证签名）
  if (headBone) headBone.rotation = headRestRot + manualHeadRot;
  // 隔离渲染覆盖（每帧重施加，因 state.apply 会重置 slot 颜色）
  if (isoSet) for (const s of skeleton.slots) s.color.a = isoSet.has(s.data.name) ? 1 : 0;
  skeleton.updateWorldTransform();

  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  renderer.begin();
  renderer.drawSkeleton(skeleton, USE_PM);
  renderer.end();
  requestAnimationFrame(loop);
}

// ---- 交互 ----
function onKey(e) {
  const anims = skeleton.data.animations;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const step = e.key === "ArrowLeft" ? -5 : 5;
    manualHeadRot = Math.max(-35, Math.min(35, manualHeadRot + step));
    log("Head_Rot 手动偏移", manualHeadRot + "°");
  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    animIndex = (animIndex + (e.key === "ArrowUp" ? 1 : -1) + anims.length) % anims.length;
    state.setAnimation(0, anims[animIndex].name, true);
    log("动画", anims[animIndex].name);
  } else if (/^[0-9a-z]$/i.test(e.key)) {
    const idx = e.key >= "0" && e.key <= "9" ? (e.key === "0" ? 9 : +e.key - 1) : 10 + (e.key.toLowerCase().charCodeAt(0) - 97);
    if (idx < anims.length) {
      animIndex = idx;
      state.setAnimation(0, anims[animIndex].name, true);
      log("动画", anims[animIndex].name);
    }
  }
  updateHud();
}

// 鼠标位置 → 骨架坐标，实时打印（验证 windowToSkeleton / 头部命中换算）
function onMouseMove(e) {
  const p = windowToSkeleton(e.clientX, e.clientY);
  if (headBone) {
    const dx = p.x - headBone.x;
    const dy = p.y - headBone.y;
    const deg = Math.atan2(dy, dx) * spine.MathUtils.radDeg;
    hud.dataset.head = `光标→骨架 (${p.x.toFixed(0)},${p.y.toFixed(0)}) 头骨(${headBone.x.toFixed(0)},${headBone.y.toFixed(0)}) 夹角 ${deg.toFixed(0)}°`;
  }
  updateHud();
}

function updateHud() {
  const anim = state.tracks[0] ? state.tracks[0].animation.name : "-";
  hud.textContent =
    `动画[${animIndex}] ${anim}  循环=${state.tracks[0] ? state.tracks[0].loop : "-"}\n` +
    `Head_Rot 手动 ${manualHeadRot}°  渲染=${USE_PM ? "premultiplied" : "straight"}  fps≈${fps.toFixed(0)}\n` +
    `骨架 ${skeleton.data.animations.length} 动画 / ${skeleton.data.bones.length} 骨骼\n` +
    `包围盒 ${fit ? `offset(${fit.offset.x.toFixed(0)},${fit.offset.y.toFixed(0)}) size(${fit.size.x.toFixed(0)},${fit.size.y.toFixed(0)}) scale=${fit.scale.toFixed(3)}` : "-"}\n` +
    (hud.dataset.head || "") +
    `\n按键：←→ 转 Head_Rot · ↑↓/数字/字母 切动画`;
}

// ---- 探针 API（供 spike_probe.cjs / visual_test 通过 executeJavaScript 调用）----
window.spineTest = {
  setAnim: (name, loop) => {
    const idx = skeleton.data.animations.findIndex((a) => a.name === name);
    if (idx < 0) return false;
    animIndex = idx;
    state.setAnimation(0, name, loop !== false);
    updateHud();
    return true;
  },
  setManualHeadRot: (deg) => {
    manualHeadRot = Math.max(-35, Math.min(35, deg));
    updateHud();
  },
  getState: () => ({
    track0: state.tracks[0] ? state.tracks[0].animation.name : null,
    headRot: +headBone.rotation.toFixed(2),
    headRestRot,
    manualHeadRot,
    headWorld: headBone ? { x: +headBone.x.toFixed(1), y: +headBone.y.toFixed(1) } : null,
    windowToSkeleton100: windowToSkeleton(100, 100),
  }),
  sampleAlpha: () => {    // 读像素 alpha：4 角 + 中心 + 头部骨骼投影位置（验证透明窗合成）
    const w = canvas.width, h = canvas.height;
    const pts = [
      [4, 4], [w - 5, 4], [4, h - 5], [w - 5, h - 5],
      [w >> 1, h >> 1],
    ];
    if (headBone) {
      const p = renderer.camera; // 世界 → 屏幕：x 同向，y 翻转
      const sx = (headBone.x - p.position.x + p.viewportWidth / 2) / p.viewportWidth * w;
      const sy = (p.position.y + p.viewportHeight / 2 - headBone.y) / p.viewportHeight * h;
      pts.push([Math.round(sx), Math.round(sy)]);
    }
    const out = [];
    for (const [x, y] of pts) {
      const px = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push({ x, y, a: px[3] });
    }
    return out;
  },
  // 每个动画里眼部相关 slot 的 attachment 帧（帧名 ∅=null=隐藏），用于语义映射
  dumpEyeFrames: () => {
    const sd = skeleton.data;
    const EYE_SLOTS = new Set([
      "L_Eye_01", "R_Eye_01", "L_Eye_PP", "R_Eye_PP", "L_Eye_Cover_01", "R_Eye_Cover_01",
      "L_Eye_White_01", "R_Eye_White_01", "L_Eye_P_01", "R_Eye_P_01", "L_Eye_P_02_0", "R_Eye_P_02_0",
      "L_Eyebrows_01", "R_eyebrows_01", "L_B_Eyebrows_01", "R_B_Eyebrows_01", "Mouse_01",
    ]);
    const out = {};
    for (const a of sd.animations) {
      const frames = [];
      for (const tl of a.timelines) {
        const type = (tl.getPropertyId() >> 24) & 0xff;
        if (type !== spine.TimelineType.attachment) continue;
        const slotName = sd.slots[tl.slotIndex].name;
        if (!EYE_SLOTS.has(slotName)) continue;
        for (let i = 0; i < tl.frames.length; i++) {
          frames.push(`${slotName}@${tl.frames[i].toFixed(2)}=${tl.attachmentNames[i] == null ? "∅" : tl.attachmentNames[i]}`);
        }
      }
      out[a.name] = frames;
    }
    return out;
  },
  // 隔离渲染：仅保留指定 slot 可见（其余 alpha=0），用于定位渲染问题
  isolateSlots: (names) => {
    isoSet = new Set(names);
    return true;
  },
  restoreSlots: () => {
    isoSet = null;
    for (const s of skeleton.slots) s.color.a = 1;
    return true;
  },
  dumpDrawState: () => {
    return skeleton.drawOrder.map((s) => ({
      name: s.data.name,
      attachment: s.attachment ? s.attachment.name : null,
      region: s.attachment && s.attachment.region ? "OK" : null,
      alpha: s.color.a,
    }));
  },
  // 同步渲染一帧并立即读回像素，返回 ASCII 快照（确定性，不经过合成器）
  renderSnapshot: (names) => {
    if (names) isoSet = new Set(names);
    else isoSet = null;
    state.update(0);
    state.apply(skeleton);
    if (headBone) headBone.rotation = headRestRot + manualHeadRot;
    if (isoSet) for (const s of skeleton.slots) s.color.a = isoSet.has(s.data.name) ? 1 : 0;
    skeleton.updateWorldTransform();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.begin();
    renderer.drawSkeleton(skeleton, USE_PM);
    renderer.end();
    const w = canvas.width, h = canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const B = 4; // 4x4 降采样
    const rows = [];
    for (let y = 0; y + B <= h; y += B) {
      let line = "";
      for (let x = 0; x + B <= w; x += B) {
        let rr = 0, gg = 0, bb = 0, n = 0;
        for (let dy = 0; dy < B; dy++) {
          const off = ((y + dy) * w + x) * 4;
          for (let dx = 0; dx < B; dx++) {
            const i = off + dx * 4;
            if (buf[i + 3] > 100) { rr += buf[i]; gg += buf[i + 1]; bb += buf[i + 2]; n++; }
          }
        }
        if (!n) { line += "."; continue; }
        const r = rr / n, g = gg / n, b = bb / n, s = r + g + b;
        if (s < 330) line += "#";
        else if (b > r + 25 && b > 90 && s < 560) line += "@";
        else if (r > 235 && g > 230 && b > 220) line += "o";
        else line += "+";
      }
      rows.push(line);
    }
    const first = rows.findIndex((l) => /[^.]/.test(l));
    const last = rows.length - 1 - [...rows].reverse().findIndex((l) => /[^.]/.test(l));
    if (first < 0) return { w: w / B, h: h / B, rows: ["(empty)"] };
    return { w: w / B, h: h / B, y0: first, rows: rows.slice(first, last + 1) };
  },
  // 骨骼世界坐标 + 屏幕投影（CSS y 向下 / gl y 向上），用于定位骨骼与渲染的一致性
  getBoneScreen: (names) => {
    const cam = renderer.camera;
    const w = canvas.width, h = canvas.height;
    const out = {};
    for (const n of names) {
      const b = skeleton.findBone(n);
      if (!b) { out[n] = null; continue; }
      const sx = ((b.x - cam.position.x + cam.viewportWidth / 2) / cam.viewportWidth) * w;
      const syCSS = ((cam.position.y + cam.viewportHeight / 2 - b.y) / cam.viewportHeight) * h;
      out[n] = { world: [+b.x.toFixed(1), +b.y.toFixed(1)], cssY: +syCSS.toFixed(0), glY: +(h - syCSS).toFixed(0), cssX: +sx.toFixed(0) };
    }
    return out;
  },
  // 附件世界顶点（4 个），用于核对附件实际绘制位置
  getAttachmentVerts: (slotName) => {
    const slot = skeleton.findSlot(slotName);
    if (!slot || !slot.attachment) return null;
    const v = new Float32Array(8);
    slot.attachment.computeWorldVertices(slot, 0, 2, v, 0, 2);
    const cam = renderer.camera;
    const w = canvas.width, h = canvas.height;
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const sx = ((v[i * 2] - cam.position.x + cam.viewportWidth / 2) / cam.viewportWidth) * w;
      const syCSS = ((cam.position.y + cam.viewportHeight / 2 - v[i * 2 + 1]) / cam.viewportHeight) * h;
      pts.push([+sx.toFixed(1), +syCSS.toFixed(1)]);
    }
    return { bone: slot.bone ? { x: +slot.bone.x.toFixed(1), y: +slot.bone.y.toFixed(1) } : null, verts: pts };
  },
  // 窗口 CSS 坐标 → 骨架世界坐标（runtime 自带 screenToWorld）
  worldAt: (x, y) => {
    const p = windowToSkeleton(x, y);
    return { x: +p.x.toFixed(1), y: +p.y.toFixed(1) };
  },
};

load();
