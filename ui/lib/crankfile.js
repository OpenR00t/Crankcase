// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// .crank files: a Crankcase design saved as plain JSON.
//
// {
//   "format": "crankcase", "version": 1,
//   "name": "...", "notes": "...",
//   "engine":  { layout, cylinders, bore, stroke, build, compression, fuel,
//                duration, lift, runner, rings, bearings, oil, sump, flywheel, crank },
//   "gearing": { gears: [...], finalDrive, tire },
//   "locks":   { displacement: 2.0, redline: 7000, ... }   // design locks, if any
//   "summary": { ... }   // written for reading; ignored when opening
// }
//
// Nothing BeamNG-specific is stored: export turns a design into a .jbeam for a car.

import { DEFAULT_DESIGN, analyse } from "./engine.js";
import { DEFAULT_PARTS, resolve, migrate } from "./parts.js";
import { DEFAULT_GEARING, SHIFT_STYLES } from "./gearing.js";
import { layoutName, mass } from "./geometry.js";
import { LOCKS } from "./locks.js";

export const FORMAT = "crankcase";
export const VERSION = 1;
export const EXTENSION = "crank";

const ENGINE_KEYS = ["layout", "cylinders", "bore", "stroke", "build", "compression", "fuel",
  "duration", "lift", "runner", "rings", "bearings", "oil", "sump", "flywheel", "crank",
  "induction", "turboLayout", "scType", "boost", "spoolRpm", "handoverRpm", "injection",
  "manifold", "primary", "pipes", "pipe", "cat", "muffler"];

/** The file text for a design. */
export function toCrank(d) {
  const a = analyse(d, 50);
  const gears = Array.from({ length: d.gearCount }, (_, i) => d[`gear${i + 1}`]);
  const file = {
    format: FORMAT,
    version: VERSION,
    name: d.name,
    notes: d.notes || "",
    engine: Object.fromEntries(ENGINE_KEYS.map((k) => [k, d[k]])),
    gearing: { gears, finalDrive: d.finalDrive, tire: d.tire, shift: d.shift },
    ...(d.locks && Object.keys(d.locks).length ? { locks: d.locks } : {}),
    summary: {
      engine: `${layoutName(d)} ${a.litres.toFixed(2)} L`,
      peakPowerKw: Math.round(a.peakPower), peakPowerRpm: a.peakPowerRpm,
      peakTorqueNm: Math.round(a.peakTorque), peakTorqueRpm: a.peakTorqueRpm,
      redline: a.redline, massKg: Math.round(mass(d)),
    },
  };
  return JSON.stringify(file, null, 2) + "\n";
}

/** A design from file text (throws with a readable message if it isn't one). */
export function fromCrank(text) {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error("not a .crank file (not valid JSON)"); }
  if (!file || file.format !== FORMAT) throw new Error("not a .crank file");
  if (typeof file.version !== "number" || file.version > VERSION) {
    throw new Error(`made by a newer Crankcase (file version ${file.version})`);
  }
  const engine = file.engine || {};
  const gearing = file.gearing || {};
  const d = { ...DEFAULT_DESIGN, ...DEFAULT_PARTS, ...DEFAULT_GEARING };
  for (const k of ENGINE_KEYS) if (engine[k] != null) d[k] = engine[k];
  // a file saved before parts existed would carry cam/tuneRpm/friction instead
  for (const k of ["cam", "tuneRpm", "friction"]) if (engine[k] != null && engine.duration == null) d[k] = engine[k];
  if (Array.isArray(gearing.gears) && gearing.gears.length >= 4 && gearing.gears.length <= 6) {
    d.gearCount = gearing.gears.length;
    gearing.gears.forEach((r, i) => { d[`gear${i + 1}`] = Number(r); });
  }
  if (gearing.finalDrive != null) d.finalDrive = Number(gearing.finalDrive);
  if (gearing.tire) d.tire = gearing.tire;
  if (typeof gearing.shift === "string" && SHIFT_STYLES[gearing.shift]) d.shift = gearing.shift;
  d.name = typeof file.name === "string" && file.name.trim() ? file.name.trim() : "Untitled";
  d.notes = typeof file.notes === "string" ? file.notes : "";
  if (file.locks && typeof file.locks === "object") {
    d.locks = Object.fromEntries(Object.entries(file.locks).filter(([k, v]) => LOCKS[k] && (typeof v === "number" || v === true)));
  }
  return resolve(engine.duration == null && d.cam != null ? migrate(d) : d);
}
