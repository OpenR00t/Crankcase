// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Works out a car profile from the car's own files, so any car in the game or
// in a mod can take a Crankcase engine without a hand-written profile.
//
// Input is a bundle: { files: { path: text } } for vehicles/<car>/ and a shared
// lookup for vehicles/common/. Everything comes from what the car already has:
//   - the engine slot is the slot holding the default config's combustion engine
//   - each layout family borrows a stock engine of that family as the donor
//   - the engine frame (where the block sits and which way the crank points)
//     comes from the donor's e1..e4 block nodes
//   - the bay is the space the car's stock engines occupy, padded a little
//   - intake, flywheel, gearbox and final drive slots come from the donor's slots
//   - mass, drivetrain and drag come from the default config's info file
// The result has the same shape as a hand-written profile plus `frame`,
// `support` and `sources` (which archive each donor file lives in).

import { parseJBeam } from "./jbeamparse.js";

// block corners are e1r..e4l on most cars; trucks and buses spell them en1r..en4l
const BLOCK_NODE = /^(en?)([1-4])([rl])$/;

/** A lazy index over a set of jbeam files: part name -> file, slot type -> part names. */
export function partIndex(files) {
  const byName = new Map(), bySlot = new Map(), parsed = new Map();
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith(".jbeam")) continue;
    for (const name of topLevelKeys(text)) if (!byName.has(name)) byName.set(name, path);
  }
  const parse = (path) => {
    if (!parsed.has(path)) {
      let doc = {};
      try { doc = parseJBeam(files[path]); } catch { /* a broken file just contributes nothing */ }
      parsed.set(path, doc);
      for (const [name, part] of Object.entries(doc)) {
        if (!part || typeof part !== "object") continue;
        for (const t of [part.slotType].flat()) if (t) {
          if (!bySlot.has(t)) bySlot.set(t, new Set());
          bySlot.get(t).add(name);
        }
      }
    }
    return parsed.get(path);
  };
  return {
    files,
    has: (name) => byName.has(name),
    fileOf: (name) => byName.get(name),
    part(name) {
      const path = byName.get(name);
      return path ? parse(path)[name] ?? null : null;
    },
    /** Every part that fits a slot type. Parses only files that mention the type. */
    inSlot(type) {
      const quoted = `"${type}"`;
      for (const [path, text] of Object.entries(files)) if (path.endsWith(".jbeam") && !parsed.has(path) && text.includes(quoted)) parse(path);
      return [...(bySlot.get(type) ?? [])];
    },
  };
}

/** The keys of a jbeam file's top-level object (its part names), without parsing it all. */
export function topLevelKeys(text) {
  const keys = [];
  let depth = 0, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1) {
        let k = j + 1;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] === ":") keys.push(text.slice(i + 1, j));
      }
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return keys;
}

/** Looks parts up in the car's own files first, then vehicles/common. */
function lookup(own, common) {
  const pick = (name) => (own.has(name) ? own : common?.has(name) ? common : null);
  return {
    part: (name) => pick(name)?.part(name) ?? null,
    fileOf: (name) => pick(name)?.fileOf(name) ?? null,
    source: (name) => (own.has(name) ? "car" : common?.has(name) ? "common" : null),
    inSlot: (type) => [...new Set([...own.inSlot(type), ...(common ? common.inSlot(type) : [])])],
  };
}

const readJson = (text) => {
  if (!text) return {};
  try { return parseJBeam(text); } catch { return {}; }
};

/** A part's slots as { name, types, default }, for both the old and new slot formats. */
export function slotsOf(part) {
  if (Array.isArray(part?.slots2)) {
    return part.slots2.slice(1).filter(Array.isArray).map((r) => ({ name: r[0], types: [r[1]].flat().filter(Boolean), default: r[3] }));
  }
  if (Array.isArray(part?.slots)) {
    return part.slots.slice(1).filter(Array.isArray).map((r) => ({ name: r[0], types: [r[0]], default: r[1] }));
  }
  return [];
}

/** Variable names a part declares ($gear_1, $finaldrive, ...). */
function variablesOf(part) {
  return Array.isArray(part?.variables) ? part.variables.slice(1).filter(Array.isArray).map((r) => r[0]) : [];
}

const isCombustion = (part) => !!part?.mainEngine?.torque;

/** Engine layout family from its names and shape: "inline", "flat" or "v". */
export function engineFamily(name, part) {
  const s = `${name} ${part?.information?.name ?? ""}`.toLowerCase();
  if (/boxer|flat(?!head)|\bh\d\b|_h\d\b|_b\d\b|\bb\d\b/.test(s)) return "flat";
  if (/(^|[_\s])v\d{1,2}([_\s.]|$)|\bv\d{1,2}\b|vr\d/.test(s)) return "v";
  if (/(^|[_\s])i\d([_\s.]|$)|\bi\d\b|inline|straight|\bl\d\b/.test(s)) return "inline";
  // no name hint: wide and low reads as flat, wide and tall as a V
  const n = blockNodes(part);
  if (n.length >= 8) {
    const w = width(n), h = height(n);
    if (w > 1.4 * h) return "flat";
    if (w > 0.85 * h) return "v";
  }
  return "inline";
}

/** The block corners under their usual names (e1r ...), each remembering how the car spells it. */
function blockNodes(part) {
  return (part?.nodes ?? []).filter((r) => Array.isArray(r) && BLOCK_NODE.test(r[0]))
    .map((r) => { const [, prefix, n, side] = BLOCK_NODE.exec(r[0]); return { id: `e${n}${side}`, prefix, p: [Number(r[1]), Number(r[2]), Number(r[3])] }; });
}

/** How the car spells its block corners: "e" (e1r) or "en" (en1r). */
const nodePrefix = (nodes) => nodes.find((n) => n.prefix)?.prefix ?? "e";

const mean = (ps) => ps.reduce((a, p) => a.map((v, i) => v + p[i] / ps.length), [0, 0, 0]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
const nodesOf = (n, re) => n.filter((x) => re.test(x.id)).map((x) => x.p);
const width = (n) => { const f = engineFrame(n); return f ? Math.max(...n.map((x) => dot(sub(x.p, f.origin), f.left))) - Math.min(...n.map((x) => dot(sub(x.p, f.origin), f.left))) : 0; };
const height = (n) => Math.max(...n.map((x) => x.p[2])) - Math.min(...n.map((x) => x.p[2]));

/**
 * The engine's own frame, from its block nodes. e1..e4 are the block's corners: e1/e2 the
 * two ends at the bottom, e3/e4 the same ends at the top, r and l the two sides. The
 * gearbox end is normally e1; when the gearbox node sits by e2 instead, the car numbers
 * its block from the nose (`flipEnds`). `forward` points from the gearbox end to the nose
 * (level), `left` is up x forward, and the origin is the gearbox end of the block, on its
 * centreline, at the bottom. `swapped` says the car names its sides the other way round
 * from the BX (its "l" nodes are on the engine's right).
 */
export function engineFrame(nodes, gearbox = null) {
  let e1 = nodesOf(nodes, /^e1/), e2 = nodesOf(nodes, /^e2/);
  if (!e1.length || !e2.length) return null;
  const flat = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const flipEnds = !!gearbox && flat(gearbox, mean(e2)) < flat(gearbox, mean(e1));
  if (flipEnds) [e1, e2] = [e2, e1];
  const c1 = mean(e1), c2 = mean(e2);
  const axis = sub(c2, c1);
  if (Math.hypot(axis[0], axis[1]) < 0.05) return null;
  const forward = norm([axis[0], axis[1], 0]);
  const up = [0, 0, 1];
  const left = [up[1] * forward[2] - up[2] * forward[1], up[2] * forward[0] - up[0] * forward[2], 0];
  const bottom = Math.min(...[...e1, ...e2].map((p) => p[2]));
  const origin = [c1[0], c1[1], bottom];
  const ls = nodesOf(nodes, /l$/), rs = nodesOf(nodes, /r$/);
  const swapped = ls.length && rs.length ? dot(sub(mean(ls), mean(rs)), left) < 0 : false;
  const along = (v) => [Math.round(v[0]), Math.round(v[1])].join(",");
  const orientation = along(forward) === "0,-1" ? "longitudinal" : along(forward) === "0,1" ? "longitudinal, reversed"
    : Math.abs(forward[0]) > 0.9 ? "transverse" : "angled";
  return { origin, forward, left, up, swapped, flipEnds, orientation };
}

/** Where the engine's gearbox sits: the first node of its default gearbox, or of any gearbox that fits. */
function gearboxPoint(look, engineName) {
  const firstNode = (name) => {
    const row = (look.part(name)?.nodes ?? []).find((r) => Array.isArray(r) && [1, 2, 3].every((i) => typeof r[i] === "number"));
    return row ? [row[1], row[2], row[3]] : null;
  };
  for (const s of slotsOf(look.part(engineName))) {
    const type = s.types[0] ?? s.name;
    if (!/transmission|transaxle|gearbox/i.test(type)) continue;
    const p = (s.default && firstNode(s.default)) ?? look.inSlot(type).sort().map(firstNode).find(Boolean);
    if (p) return p;
  }
  return null;
}

/** A point from the car into the canonical engine frame. */
export function toEngine(frame, q) {
  const d = sub(q, frame.origin);
  return [dot(d, frame.left), -dot(d, frame.forward), dot(d, frame.up)];
}

/** Space the stock engines take up in the donor's frame, padded: the bay estimate. */
function bayFrom(frame, engines) {
  const pts = engines.flatMap((e) => blockNodes(e).map((n) => toEngine(frame, n.p)));
  if (!pts.length) return null;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    front: r3(-Math.min(...pts.map((p) => p[1])) + 0.03),   // metres ahead of the gearbox face
    halfWidth: r3(Math.max(...pts.map((p) => Math.abs(p[0]))) + 0.04),
    top: r3(Math.max(...pts.map((p) => p[2])) + 0.05),      // above the block's bottom
    bottom: r3(Math.min(...pts.map((p) => p[2])) - 0.04),
  };
}

/**
 * Grows the stock-engine bay into free space the rest of the car leaves around it: up to
 * the nearest node above (the hood), ahead (the radiator) and to the sides (rails, towers),
 * less a 3 cm gap, and never by more than a sensible amount.
 */
export function roomAround(bay, pts, radiators = []) {
  if (!bay) return bay;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const fwd = (p) => -p[1];
  const within = (v, lo, hi) => v > lo && v < hi;
  const above = pts.filter((p) => Math.abs(p[0]) < bay.halfWidth && within(fwd(p), 0, bay.front) && p[2] > bay.top - 0.02).map((p) => p[2]);
  const ahead = pts.filter((p) => Math.abs(p[0]) < bay.halfWidth && within(p[2], bay.bottom + 0.05, bay.top) && fwd(p) > bay.front - 0.02).map(fwd);
  const side = pts.filter((p) => within(fwd(p), 0.05, bay.front) && within(p[2], bay.bottom + 0.1, bay.top) && Math.abs(p[0]) > bay.halfWidth - 0.02).map((p) => Math.abs(p[0]));
  // a radiator ahead of the block caps the front where it is, even inside the stock envelope
  const rad = radiators.filter((p) => Math.abs(p[0]) < bay.halfWidth && fwd(p) > 0.1).map(fwd);
  if (rad.length) ahead.push(Math.min(...rad));
  const grow = (stock, near, most) => r3(near.length ? Math.min(stock + most, Math.max(stock, Math.min(...near) - 0.03)) : stock);
  return {
    front: grow(bay.front, ahead, 0.2),
    halfWidth: grow(bay.halfWidth, side, 0.1),
    top: grow(bay.top, above, 0.2),
    bottom: bay.bottom,
    stock: bay,
  };
}

const PS = 735.5, RHO = 1.2, G = 9.81;
const GRIP = { RWD: 0.45, FWD: 0.5, AWD: 0.8, "4WD": 0.8 };

/** Mass, drag area and grip for the gearing maths, from a config's info file. */
function carFrom(info) {
  const mass = Number(info.Weight) || 1400;
  const crr = 0.012;
  const v = Number(info["Top Speed"]), p = Number(info.Power) * PS * 0.85;
  let cda = 0.65;
  if (v > 20 && p > 0) cda = (p - crr * mass * G * v) / (0.5 * RHO * v ** 3);
  cda = Math.min(1.3, Math.max(0.45, cda || 0.65));
  const drive = String(info.Drivetrain || "RWD").toUpperCase();
  return { mass: Math.round(mass), cda: Math.round(cda * 100) / 100, crr, grip: GRIP[drive] ?? 0.45, drivetrain: drive };
}

const SHIFTING = { sequentialGearbox: "Sequential", manualGearbox: "Manual", dctGearbox: "DCT", automaticGearbox: "Automatic", cvtGearbox: "CVT" };

function gearboxKind(part) {
  const row = (part?.powertrain ?? []).find((r) => Array.isArray(r) && SHIFTING[r[0]]);
  return row ? SHIFTING[row[0]] : null;
}

/** Adjustable gearboxes in a slot ($gear_1 ... $gear_n), best one per gear count. */
function adjustableGearboxes(look, type) {
  const out = {};
  for (const name of look.inSlot(type).sort()) {
    const part = look.part(name);
    const vars = variablesOf(part);
    const gears = vars.filter((v) => /^\$gear_\d+$/.test(v)).length;
    const kind = gearboxKind(part);
    if (gears < 4 || !kind || kind === "Automatic" || kind === "CVT") continue;
    const cand = { part: name, label: part.information?.name ?? name, gears, transmission: kind };
    // prefer sequentials for quick shifts, then manuals
    const rank = (c) => (c.transmission === "Sequential" ? 2 : c.transmission === "Manual" ? 1 : 0);
    if (!out[gears] || rank(cand) > rank(out[gears])) out[gears] = cand;
  }
  return out;
}

/**
 * The parts a config actually uses, walking the slot tree from the car's main part: each
 * slot takes the config's choice, otherwise its default. Returns slot type -> part name,
 * and for each part the engine-subtree flag (parts hanging off the engine).
 */
export function configParts(look, own, pc, engineSlotName) {
  const chosen = pc.parts ?? {};
  const slots = new Map(), parts = new Map(); // part -> { slot, underEngine }
  const roots = own.inSlot("main");
  const queue = roots.map((r) => ({ name: r, slot: "main", under: false }));
  while (queue.length) {
    const { name, slot, under } = queue.shift();
    if (parts.has(name)) continue;
    const part = look.part(name);
    if (!part) continue;
    parts.set(name, { slot, underEngine: under });
    for (const s of slotsOf(part)) {
      const type = s.types[0] ?? s.name;
      if (slots.has(type)) continue;
      const pick = chosen[s.name] ?? chosen[type] ?? s.default;
      slots.set(type, pick || null);
      if (pick && pick !== "none") queue.push({ name: pick, slot: type, under: under || s.name === engineSlotName || type === engineSlotName });
    }
  }
  return { slots, parts };
}

/** The car's adjustable final drives: slot, part and variable, one per driven axle. */
function finalDrives(look, slots) {
  const out = [];
  for (const slot of slots) {
    if (!/final.?drive|differential|diff/i.test(slot)) continue;
    const parts = look.inSlot(slot);
    let best = null;
    for (const name of parts.sort()) {
      const v = variablesOf(look.part(name)).find((x) => /^\$finaldrive/i.test(x));
      if (!v) continue;
      const c = { slot, part: name, var: v };
      if (!best || /race|adjust/i.test(name)) best = c;
    }
    if (best && !out.some((o) => o.var === best.var)) out.push(best);
  }
  return out;
}

const titleCase = (s) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The car's display name. Stock cars name themselves with translation keys
 * (vehiclesData.bx.Name), looked up in the game's English translations when given.
 */
function carName(id, info, names = {}) {
  const tr = (k) => (typeof k === "string" && /^vehiclesData\./.test(k) ? names[k] ?? null : k || null);
  const model = tr(info.Name) ?? titleCase(id);
  return info.Brand && !model.startsWith(info.Brand) ? `${info.Brand} ${model}` : model;
}

/**
 * A profile for one car, or { id, name, support: { ok: false, reason } } when it can't take
 * a Crankcase engine. `bundle.files` are the car's files (vehicles/<id>/...), `common` a
 * partIndex over vehicles/common, `names` the game's translations for car names.
 */
export function detectProfile(id, bundle, common, names = {}) {
  const files = bundle.files;
  const own = partIndex(files);
  const look = lookup(own, common);
  const base = `vehicles/${id}/`;
  const info = readJson(files[`${base}info.json`]);
  const name = carName(id, info, names);
  const fail = (reason) => ({ id, name, vehicle: id, support: { ok: false, reason } });

  const pcs = Object.keys(files).filter((f) => f.startsWith(base) && f.endsWith(".pc")).sort();
  const pcPath = files[`${base}${info.default_pc}.pc`] ? `${base}${info.default_pc}.pc` : pcs[0];
  if (!pcPath) return fail("no vehicle configs found");
  const pc = readJson(files[pcPath]);
  const pcInfo = readJson(files[pcPath.replace(/([^/]+)\.pc$/, "info_$1.json")]);

  // the engine slot holds the default config's combustion engine
  let slotType = null, defaultEngine = null;
  for (const [slot, part] of Object.entries(pc.parts ?? {})) {
    if (part && isCombustion(look.part(part))) { slotType = slot; defaultEngine = part; break; }
  }
  if (!slotType) {
    // the default config may be electric: look through the others
    for (const p of pcs) {
      for (const [slot, part] of Object.entries(readJson(files[p]).parts ?? {})) {
        if (part && isCombustion(look.part(part))) { slotType = slot; defaultEngine = part; break; }
      }
      if (slotType) break;
    }
  }
  if (!slotType) return fail("no combustion engine in any config");
  // slot keys in configs are slot names; the engine's own slotType is what parts must declare
  const engineSlotType = [look.part(defaultEngine).slotType].flat()[0] ?? slotType;

  const engines = look.inSlot(engineSlotType).filter((n) => isCombustion(look.part(n)) && blockNodes(look.part(n)).length >= 4);
  if (!engines.length) return fail("its engines have no e1-e4 block nodes to mount against");

  const used = configParts(look, own, pc, slotType);
  // the rest of the car, as obstacles for the bay: everything not hanging off the engine,
  // plus the radiator and intercooler, which do
  const obstacles = [];
  for (const [n, u] of used.parts) {
    if (u.underEngine && !/radiator|intercooler|oilcooler/i.test(u.slot)) continue;
    for (const r of look.part(n)?.nodes ?? []) {
      if (Array.isArray(r) && [1, 2, 3].every((i) => typeof r[i] === "number")) obstacles.push([r[1], r[2], r[3]]);
    }
  }

  // every radiator any stock engine brings: the bay never grows forward past one
  const radiators = [];
  for (const e of engines) for (const sl of slotsOf(look.part(e))) {
    const type = sl.types[0] ?? sl.name;
    if (!/radiator/i.test(type)) continue;
    for (const r of look.inSlot(type)) for (const row of look.part(r)?.nodes ?? []) {
      if (Array.isArray(row) && [1, 2, 3].every((i) => typeof row[i] === "number")) radiators.push([row[1], row[2], row[3]]);
    }
  }

  // one donor per family: the default engine for its own family, otherwise the first of that family
  const byFamily = {};
  const diesel = (n) => /diesel/i.test(n) || look.part(n)?.mainEngine?.requiredEnergyType === "diesel";
  const ranked = [defaultEngine, ...engines.filter((e) => e !== defaultEngine).sort()].sort((a, b) => diesel(a) - diesel(b));
  for (const n of ranked) {
    if (!engines.includes(n)) continue;
    const fam = engineFamily(n, look.part(n));
    if (!byFamily[fam]) byFamily[fam] = n;
  }
  const families = {};
  const sources = {};
  const notes = [];
  for (const [fam, donor] of Object.entries(byFamily)) {
    const part = look.part(donor);
    const frame = engineFrame(blockNodes(part), gearboxPoint(look, donor));
    if (!frame) continue;
    frame.nodePrefix = nodePrefix(blockNodes(part));
    const slots = slotsOf(part);
    const drop = slots.filter((s) => /internals|ecu/i.test(s.name) || s.types.some((t) => /internals|ecu/i.test(t))).map((s) => s.name);
    // the intake slot, or on trucks the turbo slot, which is where their induction parts go
    const intakeSlot = slots.find((s) => /intake|induction/i.test(s.name) || s.types.some((t) => /intake/i.test(t)))
      ?? slots.find((s) => /turbo/i.test(s.name) || s.types.some((t) => /turbo/i.test(t)));
    let intake = null;
    if (intakeSlot) {
      const type = intakeSlot.types[0] ?? intakeSlot.name;
      const turbos = look.inSlot(type).filter((n) => look.part(n)?.turbocharger).sort();
      const template = turbos[Math.floor((turbos.length - 1) / 2)] ?? null;
      intake = {
        slot: type,
        turboTemplate: template,
        turboLabel: template ? (look.part(template).information?.name ?? "turbo") : null,
        defaultIntake: intakeSlot.default ?? null,
      };
      // files beyond the donor's that hold the parts an export builds on
      intake.files = [...new Set([template, intake.defaultIntake].filter(Boolean).map((n) => look.fileOf(n)).filter((f) => f && f !== look.fileOf(donor)))];
      for (const n of [template, intake.defaultIntake]) if (n && look.fileOf(n)) sources[look.fileOf(n)] = look.source(n);
    }
    const donorFile = look.fileOf(donor);
    sources[donorFile] = look.source(donor);
    const anchor = { x: frame.origin[0], y: frame.origin[1], z: frame.origin[2] };
    families[fam] = {
      donorFile,
      donorPart: donor,
      donorLabel: part.information?.name ?? donor,
      donorMass: Math.round(nodeMass(part)),
      anchor: roundObj(anchor),
      frame: roundFrame(frame),
      bay: roomAround(bayFrom(frame, engines.filter((e) => sameFrame(frame, engineFrame(blockNodes(look.part(e)), gearboxPoint(look, e))))
        .map((e) => look.part(e))), obstacles.map((q) => toEngine(frame, q)), radiators.map((q) => toEngine(frame, q))),
      drop,
      intake,
    };
  }
  if (!Object.keys(families).length) return fail("couldn't work out which way its engines point");

  const order = { inline: ["inline", "flat", "v"], flat: ["flat", "inline", "v"], v: ["v", "inline", "flat"] };
  const familyFor = Object.fromEntries(Object.entries(order).map(([k, list]) => [k, list.find((f) => families[f])]));

  // gearbox and flywheel slots hang off the donor engine
  const firstFam = families[familyFor.inline];
  const engineSlots = [...used.slots.keys()].filter((t) => { const p = used.slots.get(t); return p && used.parts.get(p)?.underEngine; });
  const gearboxSlot = slotsOf(look.part(firstFam.donorPart)).map((s) => s.types[0] ?? s.name).find((t) => /transmission|transaxle|gearbox/i.test(t))
    ?? engineSlots.find((t) => /transmission|transaxle|gearbox/i.test(t)) ?? null;
  let flywheelSlot = null, gearboxes = {};
  if (gearboxSlot) {
    for (const g of look.inSlot(gearboxSlot)) {
      const fw = slotsOf(look.part(g)).find((s) => s.types.some((t) => /flywheel/i.test(t)));
      if (fw) { flywheelSlot = fw.types.find((t) => /flywheel/i.test(t)); break; }
    }
    gearboxes = adjustableGearboxes(look, gearboxSlot);
  }
  const drives = finalDrives(look, new Set([...used.slots.keys(), ...Object.keys(pc.parts ?? {})]));
  const car = carFrom({ ...pcInfo, Drivetrain: pcInfo.Drivetrain ?? info.Drivetrain });
  const orient = firstFam.frame.orientation;
  // front or behind the driver: the block's middle against the middle of the car's bounding box
  const bb = pcInfo.BoundingBox;
  const ff = firstFam.frame, mid = ff.origin.map((o, i) => o + ff.forward[i] * firstFam.bay.stock.front / 2);
  const where = Array.isArray(bb) && bb.length === 2 ? (mid[1] < (bb[0][1] + bb[1][1]) / 2 ? "front" : "mid or rear") : null;
  const along = /longitudinal/.test(orient) ? "longitudinal" : orient;
  const place = where ? `${where} engine, ${along}` : `${along} engine`;
  const layoutNote = `${place}, ${car.drivetrain.toLowerCase().replace("wd", "-wheel drive").replace("r-", "rear-").replace("f-", "front-").replace("a-", "all-")}`;

  if (!flywheelSlot) notes.push("no flywheel slot: the design's flywheel mass is left out");
  if (!Object.keys(gearboxes).length) notes.push("no adjustable gearbox: export keeps the car's own gearing");
  if (!drives.length) notes.push("no adjustable final drive");
  const missing = ["inline", "flat", "v"].filter((f) => !families[f]);
  if (missing.length) notes.push(`no stock ${missing.join(" or ")} engine: those layouts borrow the ${familyFor[missing[0]]} donor's mounts`);

  return {
    id,
    name,
    vehicle: id,
    slotType: engineSlotType,
    flywheelSlot,
    layoutNote,
    enginePosition: where ?? "front",
    families,
    familyFor,
    bay: firstFam.bay,
    car: { mass: car.mass, cda: car.cda, crr: car.crr, grip: car.grip },
    gearboxNote: "Gearbox torque limits aren't checked for detected cars.",
    gearingNote: Object.keys(gearboxes).length
      ? `Export also writes a ${name} config with this gearing, using ${Object.values(gearboxes).map((g) => `the ${g.label}`).join(" or ")}.`
      : `The ${name} has no adjustable gearbox, so export keeps its own gearing.`,
    config: {
      base: pcPath,
      engineSlot: slotType,
      gearboxSlot,
      gearboxes,
      finalDrives: drives,
      finalDriveSlot: drives[0]?.slot ?? null,
      finalDrivePart: drives[0]?.part ?? null,
      finalDriveVar: drives[0]?.var ?? null,
      drivetrain: car.drivetrain,
    },
    sources,
    detected: true,
    support: { ok: true, notes },
  };
}

function sameFrame(a, b) {
  return b && dot(a.forward, b.forward) > 0.95;
}

/** Block mass: the engine part's own node weights (its nodes and default weights). */
function nodeMass(part) {
  let weight = 0, total = 0;
  for (const r of part?.nodes ?? []) {
    if (r && !Array.isArray(r) && typeof r === "object" && r.nodeWeight !== undefined) weight = Number(r.nodeWeight) || 0;
    else if (Array.isArray(r) && typeof r[1] === "number") {
      const own = r[4] && typeof r[4] === "object" && r[4].nodeWeight !== undefined ? Number(r[4].nodeWeight) : weight;
      total += own || 0;
    }
  }
  return total;
}

const r3 = (v) => Math.round(v * 1000) / 1000 + 0;
const roundObj = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r3(v)]));
const roundFrame = (f) => ({ ...f, origin: f.origin.map(r3), forward: f.forward.map(r3), left: f.left.map(r3) });
