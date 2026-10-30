// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Writes the engine model as a COLLADA (.dae) file BeamNG.drive can load.
// No textures of our own: each surface uses a material that ships with the
// game in its shared `common` folder, with texture coordinates pointing at a
// flat-coloured patch of that material's texture, so the model looks like the
// game's own engines.

/** Surface kinds used by mesh.js, mapped to a shared BeamNG material. */
export const SURFACES = {
  // patches of the shared ibishu_engine texture (u, v of the top-left corner, size)
  alloy:  { material: "ibishu_engine", patch: [0.722, 0.373, 0.034] },  // cast aluminium
  grey:   { material: "ibishu_engine", patch: [0.578, 0.558, 0.034] },  // dark grey casting
  dark:   { material: "ibishu_engine", patch: [0.250, 0.066, 0.034] },  // black paint
  cover:  { material: "ibishu_engine", patch: [0.250, 0.066, 0.034] },
  chrome: { material: "generic_chrome", patch: [0, 0, 1] },
};

const f = (v) => Number(v.toFixed(5)).toString();
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };

/** Flat-shaded triangles grouped by material: { material: { pos, nrm, uv, count } }. */
function triangulate(parts) {
  const groups = {};
  for (const part of parts) {
    const s = SURFACES[part.material];
    const g = (groups[s.material] ||= { pos: [], nrm: [], uv: [], count: 0 });
    for (const face of part.quads) {
      const n = unit(cross(sub(face[1], face[0]), sub(face[2], face[0])));
      // map the face's own extent onto the inside of the patch
      const ax = Math.abs(n[0]) > 0.5 ? [1, 2] : Math.abs(n[1]) > 0.5 ? [0, 2] : [0, 1];
      const lo = ax.map((i) => Math.min(...face.map((v) => v[i])));
      const hi = ax.map((i) => Math.max(...face.map((v) => v[i])));
      const [pu, pv, ps] = s.patch;
      const uvOf = (v) => ax.map((i, k) => {
        const t = hi[k] > lo[k] ? (v[i] - lo[k]) / (hi[k] - lo[k]) : 0.5;
        return k === 0 ? pu + ps * (0.15 + 0.7 * t) : 1 - (pv + ps * (0.15 + 0.7 * t));
      });
      for (let i = 1; i + 1 < face.length; i++) {
        for (const v of [face[0], face[i], face[i + 1]]) {
          g.pos.push(...v); g.nrm.push(...n); g.uv.push(...uvOf(v));
        }
        g.count++;
      }
    }
  }
  return groups;
}

/** The .dae text for one mesh object named `name`. */
export function writeDae(name, parts) {
  return writeDaeMeshes([{ name, parts }]);
}

/** The .dae text for several mesh objects in one file: [{ name, parts }]. */
export function writeDaeMeshes(meshes) {
  const allMats = new Set();
  const geometries = [], nodes = [];
  for (const { name, parts } of meshes) {
    const groups = triangulate(parts);
    const mats = Object.keys(groups);
    mats.forEach((m) => allMats.add(m));
    const id = name.replace(/[^A-Za-z0-9_]/g, "_");
    const src = (sid, data, stride, params) =>
      `<source id="${id}-${sid}"><float_array id="${id}-${sid}-array" count="${data.length}">${data.map(f).join(" ")}</float_array>` +
      `<technique_common><accessor source="#${id}-${sid}-array" count="${data.length / stride}" stride="${stride}">` +
      params.map((p) => `<param name="${p}" type="float"/>`).join("") + `</accessor></technique_common></source>`;

    // one shared vertex list, with each material's triangles indexing into it
    const pos = [], nrm = [], uv = [];
    const tris = mats.map((m) => {
      const g = groups[m], start = pos.length / 3;
      pos.push(...g.pos); nrm.push(...g.nrm); uv.push(...g.uv);
      const idx = Array.from({ length: g.count * 3 }, (_, i) => start + i);
      return `<triangles material="${m}-material" count="${g.count}">` +
        `<input semantic="VERTEX" source="#${id}-vertices" offset="0"/>` +
        `<input semantic="NORMAL" source="#${id}-normals" offset="0"/>` +
        `<input semantic="TEXCOORD" source="#${id}-map-0" offset="0" set="0"/>` +
        `<input semantic="TEXCOORD" source="#${id}-map-0" offset="0" set="1"/>` +
        `<p>${idx.join(" ")}</p></triangles>`;
    });
    geometries.push(`<geometry id="${id}-mesh" name="${name}"><mesh>
    ${src("positions", pos, 3, ["X", "Y", "Z"])}
    ${src("normals", nrm, 3, ["X", "Y", "Z"])}
    ${src("map-0", uv, 2, ["S", "T"])}
    <vertices id="${id}-vertices"><input semantic="POSITION" source="#${id}-positions"/></vertices>
    ${tris.join("\n    ")}
  </mesh></geometry>`);
    nodes.push(`<node id="${id}" name="${name}" type="NODE"><instance_geometry url="#${id}-mesh" name="${name}"><bind_material><technique_common>
      ${mats.map((m) => `<instance_material symbol="${m}-material" target="#${m}-material"><bind_vertex_input semantic="${id}-map-0" input_semantic="TEXCOORD" input_set="0"/></instance_material>`).join("")}
    </technique_common></bind_material></instance_geometry></node>`);
  }
  const mats = [...allMats];
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><contributor><authoring_tool>Crankcase</authoring_tool></contributor><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>
  <library_effects>${mats.map((m) => `<effect id="${m}-effect"><profile_COMMON><technique sid="common"><lambert><diffuse><color sid="diffuse">0.6 0.6 0.6 1</color></diffuse></lambert></technique></profile_COMMON></effect>`).join("")}</library_effects>
  <library_materials>${mats.map((m) => `<material id="${m}-material" name="${m}"><instance_effect url="#${m}-effect"/></material>`).join("")}</library_materials>
  <library_geometries>${geometries.join("")}</library_geometries>
  <library_visual_scenes><visual_scene id="Scene" name="Scene">
    ${nodes.join("\n    ")}
  </visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
`;
}
