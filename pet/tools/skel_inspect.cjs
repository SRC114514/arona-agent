// skel 结构勘察工具：dump 骨/槽/附件/动画 timeline + mesh 顶点 bounds + atlas region +
// Idle_01 关键帧数值。用于判定衣摆 mesh、为 gen_sway 定参数。
// 用法：node pet/tools/skel_inspect.cjs [agentId ...]   （缺省 shiroko hoshino）
"use strict";

const { loadAgent } = require("./spine_node.cjs");

function fmt(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  return Math.abs(n) < 1e-6 ? "0" : n.toFixed(2).replace(/\.?0+$/, "");
}

function attachmentInfo(a) {
  const type = a.constructor.name;
  if (type === "MeshAttachment") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < a.vertices.length; i += 2) {
      if (a.vertices[i] < minX) minX = a.vertices[i];
      if (a.vertices[i + 1] < minY) minY = a.vertices[i + 1];
      if (a.vertices[i] > maxX) maxX = a.vertices[i];
      if (a.vertices[i + 1] > maxY) maxY = a.vertices[i + 1];
    }
    return {
      type,
      verts: a.vertices.length / 2,
      tris: a.triangles.length / 3,
      hull: a.hull,
      minX, minY, maxX, maxY,
      w: maxX - minX,
      h: maxY - minY,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    };
  }
  return { type, x: a.x, y: a.y, w: a.width, h: a.height, rot: a.rotation };
}

function dump(id) {
  const { skelData, atlas } = loadAgent(id);
  const slotName = (i) => skelData.slots[i] ? skelData.slots[i].name : `#${i}`;

  console.log(`\n===== ${id} =====`);
  console.log(`skeleton meta: version=${skelData.version} hash=${skelData.hash} x=${skelData.x} y=${skelData.y} w=${skelData.width} h=${skelData.height}`);

  console.log("\n-- bones --");
  for (const b of skelData.bones) {
    console.log(
      `  ${b.name}${b.parent ? " <- " + b.parent.name : ""} x=${fmt(b.x)} y=${fmt(b.y)} rot=${fmt(b.rotation)} sx=${fmt(b.scaleX)} sy=${fmt(b.scaleY)}`
    );
  }

  console.log("\n-- slots --");
  skelData.slots.forEach((s, i) => {
    console.log(`  #${i} ${s.name} [bone=${s.boneData.name}] blend=${s.blendMode} setupAtt=${s.attachmentName}`);
  });

  console.log("\n-- attachments (skin) --");
  const skin = skelData.defaultSkin || Object.values(skelData.skins)[0];
  for (const slotIdx of Object.keys(skin.attachments)) {
    const perSlot = skin.attachments[slotIdx];
    for (const name of Object.keys(perSlot)) {
      const a = perSlot[name];
      if (!a) { console.log(`  [${slotName(slotIdx)}] "${name}" -> null(卸下)`); continue; }
      const info = attachmentInfo(a);
      if (info.type === "MeshAttachment") {
        console.log(
          `  [${slotName(slotIdx)}] "${name}" mesh verts=${info.verts} tris=${info.tris} hull=${info.hull} bounds=(${fmt(info.minX)},${fmt(info.minY)})~(${fmt(info.maxX)},${fmt(info.maxY)}) w=${fmt(info.w)} h=${fmt(info.h)} c=(${fmt(info.cx)},${fmt(info.cy)})`
        );
      } else {
        console.log(
          `  [${slotName(slotIdx)}] "${name}" region x=${fmt(info.x)} y=${fmt(info.y)} ${fmt(info.w)}x${fmt(info.h)} rot=${fmt(info.rot)}`
        );
      }
    }
  }

  console.log("\n-- atlas regions --");
  for (const r of atlas.regions) {
    console.log(`  ${r.name} ${r.width}x${r.height} rotate=${r.rotate} xy=(${r.x},${r.y})`);
  }

  console.log("\n-- animations --");
  for (const anim of skelData.animations) {
    console.log(`  * ${anim.name} dur=${anim.duration.toFixed(3)}s timelines=${anim.timelines.length}`);
    for (const t of anim.timelines) {
      const cn = t.constructor.name;
      let target = "";
      if (t.boneIndex !== undefined) target = `bone=${slotName2bone(skelData, t.boneIndex)}`;
      else if (t.slotIndex !== undefined) target = `slot=${slotName(t.slotIndex)}`;
      // 关键帧数值（仅 translate / deform 展开前几帧）
      if (cn === "TranslateTimeline" && anim.name === "Idle_01") {
        const frames = [];
        for (let f = 0; f < t.frames.length; f += 3) {
          frames.push(`(${t.frames[f].toFixed(2)},${t.frames[f + 1].toFixed(2)},${t.frames[f + 2].toFixed(2)})`);
        }
        console.log(`      ${cn} ${target} frames(t,x,y): ${frames.join(" ")}`);
      } else if (cn === "DeformTimeline" && anim.name === "Idle_01") {
        console.log(`      ${cn} ${target} frames=${t.frames.length} att=${t.attachment ? t.attachment.name : "?"}`);
      } else {
        console.log(`      ${cn} ${target} frames=${t.frames.length / (t.frameVertices ? 1 : 1)}`);
      }
    }
  }
}

function slotName2bone(skelData, boneIndex) {
  const b = skelData.bones[boneIndex];
  return b ? b.name : `#${boneIndex}`;
}

const ids = process.argv.slice(2);
(ids.length ? ids : ["shiroko", "hoshino"]).forEach(dump);
