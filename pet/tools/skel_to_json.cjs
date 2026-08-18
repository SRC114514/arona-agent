// skel(二进制) → Spine 3.8 JSON 导出器 + round-trip 深比对验证。
// 用法：node pet/tools/skel_to_json.cjs <agentId> [--verify] [--out <path>]
//   默认输出到 assets/blue-archive/<id>/<id>_spr.json（arona/plana 在 spine/ 子目录）
//   --verify：导出后用 SkeletonJson 读回，与 SkeletonBinary 的 SkeletonData 深比对。
//
// 关键格式事实（源码核对 vendored spine-webgl.js）：
// - binary 的 defaultSkin 恒命名 "default"；JSON skins 是数组，deform timeline 以 skin 名为键。
// - deform 帧值在两个 loader 里都是"绝对值"（delta + setup）；JSON 文件里的 vertices 是
//   **相对 setup 的增量**（parser 会 += setup）——导出时必须减去 setup 顶点。
// - curves 按 19(float BEZIER_SIZE) 分段：[0]=类型(0 linear/1 stepped/2 bezier)。
//   bezier 段不存控制点，存 t=k/10 (k=1..9) 的 9 个 (x,y) 采样——可反解控制点
//   （x(t)=3(1-t)²t·cx1+3(1-t)t²·cx2+t³，两组采样解 2×2 线性方程，再全采样校验）。
// - JSON color 为 "rrggbbaa" 十六进制；binary rgba8888→float 往返无损。
"use strict";

const fs = require("fs");
const path = require("path");
const { loadAgent, loadSkelDataFromJson } = require("./spine_node.cjs");

const BEZIER_SIZE = 19;
const TRANSFORM_MODES = ["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"];
const BLEND_MODES = ["normal", "additive", "multiply", "screen"];

function r2(v) {
  // 浮点输出精简：保留足够精度（float32 精度 ~1e-7，7 位有效数字安全）
  return Number.isInteger(v) ? v : Number(v.toFixed(7));
}

function arr(a) {
  return Array.from(a, r2);
}

function colorToHex(c) {
  const b = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return b(c.r) + b(c.g) + b(c.b) + b(c.a);
}

// ---- 贝塞尔控制点反解 ----
// seg: 采样数组（9 对 x,y，即 curves[base+1..base+18]）
function recoverBezierControls(seg) {
  const S = [];
  for (let k = 1; k <= 9; k++) S.push({ x: seg[(k - 1) * 2], y: seg[(k - 1) * 2 + 1] });
  // x(t) = a(t)*cx1 + b(t)*cx2 + t^3, t=k/10
  const solve2 = (t1, t2, v1, v2) => {
    const a1 = 3 * (1 - t1) * (1 - t1) * t1, b1 = 3 * (1 - t1) * t1 * t1;
    const a2 = 3 * (1 - t2) * (1 - t2) * t2, b2 = 3 * (1 - t2) * t2 * t2;
    const c1 = v1 - t1 * t1 * t1, c2 = v2 - t2 * t2 * t2;
    const det = a1 * b2 - b1 * a2;
    if (Math.abs(det) < 1e-9) return null;
    return [(c1 * b2 - b1 * c2) / det, (a1 * c2 - c1 * a2) / det];
  };
  const cx = solve2(0.1, 0.2, S[0].x, S[1].x);
  const cy = solve2(0.1, 0.2, S[0].y, S[1].y);
  if (!cx || !cy) return null;
  const [cx1, cx2] = cx, [cy1, cy2] = cy;
  // 全采样校验（float32 误差容忍）
  for (let k = 1; k <= 9; k++) {
    const t = k / 10, o = 1 - t;
    const ex = 3 * o * o * t * cx1 + 3 * o * t * t * cx2 + t * t * t;
    const ey = 3 * o * o * t * cy1 + 3 * o * t * t * cy2 + t * t * t;
    if (Math.abs(ex - S[k - 1].x) > 2e-4 || Math.abs(ey - S[k - 1].y) > 2e-4) return null;
  }
  return [cx1, cy1, cx2, cy2];
}

// 导出第 i 段曲线；linear 返回 {}（省略键），stepped/bBezier 附加键
function curveFields(timeline, i) {
  const base = i * BEZIER_SIZE;
  const type = timeline.curves[base];
  if (type === 0) return {};
  if (type === 1) return { curve: "stepped" };
  const ctl = recoverBezierControls(timeline.curves.subarray(base + 1, base + BEZIER_SIZE));
  if (!ctl) throw new Error("bezier 控制点反解失败（采样校验不过）");
  return { curve: r2(ctl[0]), c2: r2(ctl[1]), c3: r2(ctl[2]), c4: r2(ctl[3]) };
}

// ---- 附件导出 ----
function exportAttachment(a) {
  if (a.constructor.name === "RegionAttachment") {
    const m = { type: "region", name: a.name, path: a.path, x: r2(a.x), y: r2(a.y) };
    if (a.rotation) m.rotation = r2(a.rotation);
    if (a.scaleX !== 1) m.scaleX = r2(a.scaleX);
    if (a.scaleY !== 1) m.scaleY = r2(a.scaleY);
    m.width = r2(a.width);
    m.height = r2(a.height);
    m.color = colorToHex(a.color);
    return m;
  }
  if (a.constructor.name === "MeshAttachment") {
    if (a.bones != null) throw new Error(`加权 mesh 不支持导出: ${a.name}`);
    const m = {
      type: "mesh",
      name: a.name,
      path: a.path,
      color: colorToHex(a.color),
      uvs: arr(a.regionUVs),
      vertices: arr(a.vertices),
      triangles: arr(a.triangles),
      hull: a.hullLength / 2,
    };
    if (a.edges) m.edges = arr(a.edges);
    if (a.width) m.width = r2(a.width);
    if (a.height) m.height = r2(a.height);
    return m;
  }
  throw new Error(`不支持的附件类型: ${a.constructor.name} (${a.name})`);
}

// ---- 动画导出 ----
function exportAnimation(anim, data) {
  const out = { slots: {}, bones: {}, deform: {}, drawOrder: [] };
  const skin = data.defaultSkin || data.skins[0];
  const nSeg = (t) => Math.floor(t.frames.length / (t.frameVertices ? 1 : (t.constructor.ENTRIES || 1)));

  for (const t of anim.timelines) {
    const cn = t.constructor.name;
    if (cn === "AttachmentTimeline") {
      const slot = data.slots[t.slotIndex].name;
      const list = (out.slots[slot] = out.slots[slot] || {});
      const tl = (list.attachment = []);
      for (let i = 0; i < t.frames.length; i++)
        tl.push({ time: r2(t.frames[i]), name: t.attachmentNames[i] });
    } else if (cn === "ColorTimeline") {
      const slot = data.slots[t.slotIndex].name;
      const list = (out.slots[slot] = out.slots[slot] || {});
      const tl = (list.color = []);
      const E = 5;
      for (let i = 0; i * E < t.frames.length; i++) {
        const b = i * E;
        const hex = colorToHex({ r: t.frames[b + 1], g: t.frames[b + 2], b: t.frames[b + 3], a: t.frames[b + 4] });
        tl.push({ time: r2(t.frames[b]), color: hex, ...curveFields(t, i) });
      }
    } else if (cn === "TranslateTimeline" || cn === "ScaleTimeline" || cn === "ShearTimeline") {
      const bone = data.bones[t.boneIndex].name;
      const kind = cn === "TranslateTimeline" ? "translate" : cn === "ScaleTimeline" ? "scale" : "shear";
      const list = (out.bones[bone] = out.bones[bone] || {});
      const tl = (list[kind] = []);
      const E = 3, def = kind === "scale" ? 1 : 0;
      for (let i = 0; i * E < t.frames.length; i++) {
        const b = i * E;
        const f = { time: r2(t.frames[b]) };
        if (t.frames[b + 1] !== def) f.x = r2(t.frames[b + 1]);
        if (t.frames[b + 2] !== def) f.y = r2(t.frames[b + 2]);
        tl.push({ ...f, ...curveFields(t, i) });
      }
    } else if (cn === "RotateTimeline") {
      const bone = data.bones[t.boneIndex].name;
      const list = (out.bones[bone] = out.bones[bone] || {});
      const tl = (list.rotate = []);
      const E = 2;
      for (let i = 0; i * E < t.frames.length; i++) {
        const b = i * E;
        const f = { time: r2(t.frames[b]) };
        if (t.frames[b + 1] !== 0) f.angle = r2(t.frames[b + 1]);
        tl.push({ ...f, ...curveFields(t, i) });
      }
    } else if (cn === "DeformTimeline") {
      const slot = data.slots[t.slotIndex].name;
      const attName = t.attachment.name;
      const setup = t.attachment.vertices;
      if (t.attachment.bones != null) throw new Error(`加权 deform 不支持导出: ${attName}`);
      const perSkin = (out.deform[skin.name] = out.deform[skin.name] || {});
      const perSlot = (perSkin[slot] = perSkin[slot] || {});
      const tl = (perSlot[attName] = []);
      for (let i = 0; i < t.frames.length; i++) {
        const fv = t.frameVertices[i];
        const isSetup = fv === setup;
        const delta = new Array(fv.length);
        let allZero = isSetup;
        if (!isSetup) {
          allZero = true;
          for (let v = 0; v < fv.length; v++) {
            delta[v] = fv[v] - setup[v];
            if (Math.abs(delta[v]) > 1e-9) allZero = false;
          }
        }
        tl.push({
          time: r2(t.frames[i]),
          ...(allZero ? { vertices: null } : { vertices: delta.map(r2) }),
          ...curveFields(t, i),
        });
      }
    } else if (cn === "DrawOrderTimeline") {
      for (let i = 0; i < t.frames.length; i++) {
        const perm = t.drawOrders[i]; // drawOrder[position] = originalIndex
        const pos = new Array(perm.length);
        for (let p = 0; p < perm.length; p++) pos[perm[p]] = p;
        const offsets = [];
        for (let o = 0; o < perm.length; o++)
          if (pos[o] !== o) offsets.push({ slot: data.slots[o].name, offset: pos[o] - o });
        out.drawOrder.push({ time: r2(t.frames[i]), offsets });
      }
    } else {
      throw new Error(`不支持的 timeline 类型: ${cn} (${anim.name})`);
    }
  }
  for (const k of ["slots", "bones", "deform"]) if (!Object.keys(out[k]).length) delete out[k];
  if (!out.drawOrder.length) delete out.drawOrder;
  return out;
}

// ---- 顶层导出 ----
function exportSkeletonData(data) {
  if (data.ikConstraints.length || data.transformConstraints.length || data.pathConstraints.length)
    throw new Error("存在 IK/transform/path 约束，导出器未覆盖");
  if (data.events.length) throw new Error("存在事件，导出器未覆盖");

  const root = {
    skeleton: {
      hash: data.hash,
      spine: data.version,
      x: r2(data.x), y: r2(data.y), width: r2(data.width), height: r2(data.height),
    },
    bones: data.bones.map((b) => {
      const m = { name: b.name };
      if (b.parent) m.parent = b.parent.name;
      if (b.rotation) m.rotation = r2(b.rotation);
      m.x = r2(b.x); m.y = r2(b.y);
      if (b.scaleX !== 1) m.scaleX = r2(b.scaleX);
      if (b.scaleY !== 1) m.scaleY = r2(b.scaleY);
      if (b.shearX) m.shearX = r2(b.shearX);
      if (b.shearY) m.shearY = r2(b.shearY);
      if (b.length) m.length = r2(b.length);
      m.transform = TRANSFORM_MODES[b.transformMode] || "normal";
      return m;
    }),
    slots: data.slots.map((s) => {
      const m = { name: s.name, bone: s.boneData.name, color: colorToHex(s.color) };
      if (s.darkColor) m.dark = colorToHex(s.darkColor);
      if (s.attachmentName != null) m.attachment = s.attachmentName;
      if (s.blendMode) m.blend = BLEND_MODES[s.blendMode] || "normal";
      return m;
    }),
    skins: data.skins.map((skin) => {
      const attachments = {};
      for (const slotIdx of Object.keys(skin.attachments)) {
        const slotName = data.slots[Number(slotIdx)].name;
        const per = {};
        for (const name of Object.keys(skin.attachments[slotIdx])) {
          const a = skin.attachments[slotIdx][name];
          if (a) per[name] = exportAttachment(a);
        }
        attachments[slotName] = per;
      }
      return { name: skin.name, attachments };
    }),
    animations: {},
  };
  for (const anim of data.animations) root.animations[anim.name] = exportAnimation(anim, data);
  return root;
}

// ---- 深比对（--verify） ----
function approx(a, b, eps) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= eps;
  return false;
}

function cmpFloatArray(label, x, y, eps, errors) {
  const xa = Array.from(x), ya = Array.from(y);
  if (xa.length !== ya.length) { errors.push(`${label}: 长度 ${xa.length} != ${ya.length}`); return; }
  for (let i = 0; i < xa.length; i++)
    if (!approx(xa[i], ya[i], eps)) { errors.push(`${label}[${i}]: ${xa[i]} != ${ya[i]}`); return; }
}

function cmpCurves(label, ta, tb, errors) {
  const len = Math.min(ta.curves.length, tb.curves.length);
  if (ta.curves.length !== tb.curves.length) { errors.push(`${label}: curves 长度不等`); return; }
  for (let i = 0; i < len; i += BEZIER_SIZE) {
    const typeA = ta.curves[i], typeB = tb.curves[i];
    if (typeA !== typeB) { errors.push(`${label} seg${i / BEZIER_SIZE}: 类型 ${typeA}!=${typeB}`); return; }
    const eps = typeA === 2 ? 2e-3 : 1e-6;
    for (let j = i; j < i + BEZIER_SIZE; j++)
      if (!approx(ta.curves[j], tb.curves[j], eps)) { errors.push(`${label} seg${i / BEZIER_SIZE}[${j - i}]: ${ta.curves[j]} != ${tb.curves[j]}`); return; }
  }
}

function verify(a, b) {
  const errors = [];
  const ctx = (s) => errors.push.bind(errors, s);

  // 元数据
  if (a.version !== b.version) ctx()( `version ${a.version} != ${b.version}`);
  for (const k of ["x", "y", "width", "height"]) if (!approx(a[k], b[k], 1e-4)) ctx()(`skeleton.${k}`);

  // 骨
  if (a.bones.length !== b.bones.length) ctx()("骨数量不等");
  a.bones.forEach((ba, i) => {
    const bb = b.bones[i];
    if (ba.name !== bb.name) return ctx()(`bone[${i}] 名 ${ba.name}!=${bb.name}`);
    for (const k of ["x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "length"]) {
      if (!approx(ba[k], bb[k], 1e-4)) ctx()(`bone ${ba.name}.${k}: ${ba[k]} != ${bb[k]}`);
    }
    const pa = ba.parent ? ba.parent.name : null, pb = bb.parent ? bb.parent.name : null;
    if (pa !== pb) ctx()(`bone ${ba.name} parent ${pa}!=${pb}`);
  });

  // 槽
  if (a.slots.length !== b.slots.length) ctx()("槽数量不等");
  a.slots.forEach((sa, i) => {
    const sb = b.slots[i];
    if (sa.name !== sb.name) return ctx()(`slot[${i}] 名 ${sa.name}!=${sb.name}`);
    if (sa.boneData.name !== sb.boneData.name) ctx()(`slot ${sa.name} bone 不等`);
    if (colorToHex(sa.color) !== colorToHex(sb.color)) ctx()(`slot ${sa.name} color`);
    if ((sa.attachmentName || null) !== (sb.attachmentName || null)) ctx()(`slot ${sa.name} setupAtt ${sa.attachmentName}!=${sb.attachmentName}`);
    if (sa.blendMode !== sb.blendMode) ctx()(`slot ${sa.name} blend`);
  });

  // 皮肤附件
  if (a.skins.length !== b.skins.length) ctx()("皮肤数量不等");
  a.skins.forEach((ska, i) => {
    const skb = b.skins[i];
    if (ska.name !== skb.name) ctx()(`skin[${i}] 名 ${ska.name}!=${skb.name}`);
    for (const slotIdx of Object.keys(ska.attachments)) {
      const perA = ska.attachments[slotIdx];
      const perB = skb.attachments[slotIdx] || {};
      const slotName = a.slots[Number(slotIdx)].name;
      const namesA = Object.keys(perA).sort(), namesB = Object.keys(perB).sort();
      if (namesA.join() !== namesB.join()) { ctx()(`skin ${ska.name} slot ${slotName} 附件集不等`); continue; }
      for (const n of namesA) {
        const aa = perA[n], ab = perB[n];
        const p = `skin[${ska.name}] ${slotName}/${n}`;
        if (aa.constructor.name !== ab.constructor.name) { ctx()(`${p} 类型不等`); continue; }
        if (aa.path !== ab.path) ctx()(`${p} path`);
        if (colorToHex(aa.color) !== colorToHex(ab.color)) ctx()(`${p} color`);
        if (aa.constructor.name === "RegionAttachment") {
          for (const k of ["x", "y", "rotation", "scaleX", "scaleY", "width", "height"])
            if (!approx(aa[k], ab[k], 1e-4)) ctx()(`${p}.${k}: ${aa[k]} != ${ab[k]}`);
          cmpFloatArray(`${p}.offset`, aa.offset, ab.offset, 1e-4, errors);
        } else {
          cmpFloatArray(`${p}.vertices`, aa.vertices, ab.vertices, 1e-4, errors);
          cmpFloatArray(`${p}.regionUVs`, aa.regionUVs, ab.regionUVs, 1e-6, errors);
          cmpFloatArray(`${p}.uvs`, aa.uvs, ab.uvs, 1e-6, errors);
          cmpFloatArray(`${p}.triangles`, aa.triangles, ab.triangles, 0, errors);
          if (aa.hullLength !== ab.hullLength) ctx()(`${p} hull ${aa.hullLength}!=${ab.hullLength}`);
          if ((aa.edges ? aa.edges.length : -1) !== (ab.edges ? ab.edges.length : -1)) ctx()(`${p} edges`);
        }
      }
    }
  });

  // 动画（按 属性标识 分组比对，顺序无关）
  const keyOf = (t, data) => `${t.constructor.name}#${t.slotIndex ?? t.boneIndex ?? ""}#${t.attachment ? t.attachment.name : ""}`;
  if (a.animations.length !== b.animations.length) ctx()(`动画数量 ${a.animations.length}!=${b.animations.length}`);
  const mapB = new Map(b.animations.map((x) => [x.name, x]));
  for (const anA of a.animations) {
    const anB = mapB.get(anA.name);
    if (!anB) { ctx()(`缺动画 ${anA.name}`); continue; }
    if (!approx(anA.duration, anB.duration, 1e-4)) ctx()(`${anA.name} duration`);
    const gA = new Map();
    for (const t of anA.timelines) { const k = keyOf(t, a); if (gA.has(k)) ctx()(`${anA.name} 重复 timeline ${k}`); gA.set(k, t); }
    const gB = new Map(anB.timelines.map((t) => [keyOf(t, b), t]));
    if (gA.size !== gB.size) { ctx()(`${anA.name} timeline 数 ${gA.size}!=${gB.size} (${[...gA.keys()].filter(k=>!gB.has(k)).join(",")})`); continue; }
    for (const [k, ta] of gA) {
      const tb = gB.get(k);
      if (!tb) { ctx()(`${anA.name} 缺 timeline ${k}`); continue; }
      const eps = 1e-4;
      cmpFloatArray(`${anA.name}/${k}.frames`, ta.frames, tb.frames, eps, errors);
      if (ta.curves && tb.curves) cmpCurves(`${anA.name}/${k}`, ta, tb, errors);
      if (ta.constructor.name === "DeformTimeline") {
        if (ta.frameVertices.length !== tb.frameVertices.length) { ctx()(`${anA.name}/${k} deform 帧数不等`); continue; }
        for (let i = 0; i < ta.frameVertices.length; i++)
          cmpFloatArray(`${anA.name}/${k}.deform[${i}]`, ta.frameVertices[i], tb.frameVertices[i], 1e-4, errors);
      }
      if (ta.constructor.name === "AttachmentTimeline") {
        const na = ta.attachmentNames.map((x) => x ?? null).join("|");
        const nb = tb.attachmentNames.map((x) => x ?? null).join("|");
        if (na !== nb) ctx()(`${anA.name}/${k} attachmentNames 不等`);
      }
      if (ta.constructor.name === "DrawOrderTimeline") {
        for (let i = 0; i < ta.drawOrders.length; i++)
          if (Array.from(ta.drawOrders[i]).join(",") !== Array.from(tb.drawOrders[i]).join(","))
            ctx()(`${anA.name}/${k} drawOrder[${i}] 不等`);
      }
    }
  }
  return errors;
}

// ---- main ----
function main() {
  const args = process.argv.slice(2);
  const id = args.find((x) => !x.startsWith("--"));
  if (!id) { console.error("用法: node pet/tools/skel_to_json.cjs <agentId> [--verify] [--out <path>]"); process.exit(2); }
  const verifyFlag = args.includes("--verify");
  const outIdx = args.indexOf("--out");
  const { skelData, base, skelFile } = loadAgent(id);

  const root = exportSkeletonData(skelData);
  const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join(base, `${id}_spr.json`);
  const json = JSON.stringify(root, null, 1);
  fs.writeFileSync(outPath, json);
  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`[${id}] ${skelFile} -> ${path.relative(process.cwd(), outPath)} (${sizeKb} KB)`);

  if (verifyFlag) {
    const { loader } = loadAgent(id);
    const dataB = loadSkelDataFromJson(loader, outPath);
    const errors = verify(skelData, dataB);
    if (errors.length) {
      console.error(`verify FAILED: ${errors.length} 处差异（前 20 条）:`);
      for (const e of errors.slice(0, 20)) console.error("  - " + e);
      process.exit(1);
    }
    console.log(`[${id}] verify OK: 骨/槽/皮肤附件/动画 timeline 深比对全部一致`);
  }
}

main();
