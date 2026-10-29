// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
// Run with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../ui/lib/engine.js";
import * as G from "../ui/lib/geometry.js";
import * as X from "../ui/lib/export.js";
import { parseJBeam } from "../ui/lib/jbeamparse.js";
import { PROFILES } from "../ui/lib/profiles.js";
import { checkFit, torqueRating } from "../ui/lib/fit.js";
import { engineParts, bounds } from "../ui/lib/mesh.js";
import { writeDae } from "../ui/lib/dae.js";
import { soundFor } from "../ui/lib/sounds.js";
import * as Parts from "../ui/lib/parts.js";
import * as Gear from "../ui/lib/gearing.js";

const D = E.DEFAULT_DESIGN;
const at = (a, rpm) => a.torque[a.rpm.indexOf(rpm)];

test("displacement of 4 x 87 x 100 mm is 2.378 L", () => {
  assert.equal((E.displacement(D) * 1000).toFixed(3), "2.378");
});

test("redline follows piston speed and the build", () => {
  assert.equal(E.redline(D), 6450); // 21.5 m/s, 100 mm stroke
  assert.ok(E.redline({ ...D, stroke: 80 }) > E.redline(D));
  assert.ok(E.redline({ ...D, build: "race" }) > E.redline(D));
  assert.ok(E.redline({ ...D, stroke: 40, build: "race" }) <= E.MAX_REDLINE);
});

test("a bigger cam moves power up and costs low-end torque", () => {
  const mild = E.analyse({ ...D, cam: 0 }), wild = E.analyse({ ...D, cam: 1 });
  assert.ok(wild.peakPowerRpm > mild.peakPowerRpm);
  assert.ok(wild.peakPower > mild.peakPower);
  assert.ok(at(wild, 2000) < at(mild, 2000));
});

test("intake tuning adds torque around the tuned rpm", () => {
  const low = E.analyse({ ...D, tuneRpm: 3000 }), high = E.analyse({ ...D, tuneRpm: 6000 });
  assert.ok(at(low, 3000) > at(high, 3000));
  assert.ok(at(high, 6000) > at(low, 6000));
});

test("a low-friction build makes more torque everywhere", () => {
  const durable = E.analyse({ ...D, friction: 0 }), slick = E.analyse({ ...D, friction: 1 });
  durable.rpm.forEach((r, i) => assert.ok(slick.torque[i] > durable.torque[i]));
});

test("the default engine is in the BX 2.4's league", () => {
  const a = E.analyse(D);
  assert.ok(a.peakTorque > 200 && a.peakTorque < 300, `peak torque ${a.peakTorque}`);
  assert.ok(a.peakPower > 90 && a.peakPower < 160, `peak power ${a.peakPower}`);
});

test("block size and mass grow the way the layout says", () => {
  const i4 = G.dimensions(D), i6 = G.dimensions({ ...D, cylinders: 6 });
  const v8 = G.dimensions({ ...D, layout: "v", cylinders: 8 }), f4 = G.dimensions({ ...D, layout: "flat" });
  assert.ok(i6.length > i4.length);
  assert.ok(v8.length < G.dimensions({ ...D, cylinders: 8, layout: "inline" }).length);
  assert.ok(v8.topHalf > i4.topHalf);
  assert.ok(f4.height < i4.height && f4.topHalf > i4.topHalf);
  assert.ok(G.mass({ ...D, layout: "v", cylinders: 8 }) > G.mass(D));
  // the default 2.4 I4 matches the BX's stock 2.4 node box (0.56 x 0.48 m)
  assert.ok(Math.abs(i4.length - 0.56) < 0.02 && Math.abs(i4.height - 0.48) < 0.02);
});

test("cylinder count follows the layout", () => {
  assert.equal(G.fixCylinders({ layout: "v", cylinders: 4 }), 6);
  assert.equal(G.fixCylinders({ layout: "flat", cylinders: 5 }), 4);
  assert.equal(G.fixCylinders({ layout: "inline", cylinders: 6 }), 6);
  assert.equal(G.layoutName({ layout: "flat", cylinders: 6 }), "Flat-6");
});

test("fit: the default fits the BX, an inline 6 is too long", () => {
  const bx = PROFILES.bx;
  assert.equal(checkFit(D, bx, E.analyse(D)).ok, true);
  const i6 = checkFit({ ...D, cylinders: 6 }, bx, null);
  assert.equal(i6.ok, false);
  assert.ok(i6.checks.some((c) => c.level === "fail" && c.text.startsWith("Length")));
  assert.equal(checkFit({ ...D, layout: "v", cylinders: 8, bore: 95, stroke: 79 }, bx, null).ok, true);
});

// A made-up donor with the shape of a BeamNG engine part (no game data).
const DONOR = `{
"test_engine": {
  "information": {"authors": "test", "name": "Donor", "value": 1},
  "slotType": "bx_engine",
  "slots2": [
    ["name", "allowTypes", "denyTypes", "default", "description"],
    ["bx_enginemounts", ["bx_enginemounts"], [], "bx_enginemounts", "Engine Mounts"]
    ["bx_engine_internals_i4_large", ["bx_engine_internals_i4_large"], [], "x", "Long Block"],
    ["bx_engine_ecu_i4_large", ["bx_engine_ecu_i4_large"], [], "y", "ECU"],
  ],
  "mainEngine": {"torque": [["rpm", "torque"], [0, 0], [6000, 100]], "maxRPM": 6500, "friction": 10, "dynamicFriction": 0.02,
    "maxTorqueRating": 300},
  // comment, and a missing comma below
  "soundConfig": {"sampleName": "x" "fundamentalFrequencyCylinderCount": 4},
  "vehicleController": {"highShiftUpRPM": 6600},
  "flexbodies": [["mesh", "[group]:", "nonFlexMaterials"], ["donor_engine", ["bx_engine"]]],
  "nodes": [["id", "posX", "posY", "posZ"], {"group": "bx_engine"}, {"nodeWeight": 21},
    ["e1r", 0, 0, 0], ["e1l", 0, 0, 0], ["e2r", 0, 0, 0], ["e2l", 0, 0, 0],
    ["e3r", 0, 0, 0, {"isExhaust": "mainEngine"}], ["e3l", 0, 0, 0], ["e4r", 0, 0, 0], ["e4l", 0, 0, 0],
    ["em1r", -0.25, -1.25, 0.47, {"nodeWeight": 3}]],
},
}`;
const testProfile = { ...PROFILES.bx, families: { ...PROFILES.bx.families,
  inline: { ...PROFILES.bx.families.inline, donorPart: "test_engine" } } };

test("export: a whole engine with the design's torque, size and mass", () => {
  const d = { ...D, name: "Test Engine #1", cylinders: 5 };
  const { name, text, dae, mesh } = X.buildEngine(d, testProfile, DONOR);
  assert.equal(mesh, "crankcase_test_engine_1_engine");
  assert.ok(dae.includes(`name="${mesh}"`));
  assert.equal(name, "bx_engine_crankcase_test_engine_1");
  const part = parseJBeam(text)[name];
  assert.equal(part.slotType, "bx_engine");
  assert.deepEqual(part.slots2.map((r) => r[0]), ["name", "bx_enginemounts"]);
  const me = part.mainEngine;
  assert.equal(me.revLimiterRPM, E.redline(d));
  assert.equal(me.maxRPM, E.redline(d) + 300);
  // the engine carries the design's own friction and engine braking, not the donor's
  const fit = Rot.frictionFit(d);
  assert.ok(Math.abs(me.friction - fit.friction) < 0.01 && Math.abs(me.dynamicFriction - fit.dynamicFriction) < 1e-5);
  assert.ok(Math.abs(me.engineBrakeTorque - Rot.pumpingTorque(d)) < 0.06);
  // the table minus that friction gives back the design's torque
  for (const [rpm, t] of me.torque.slice(1)) {
    if (rpm < 1000) continue;
    const net = t - (me.friction + me.dynamicFriction * rpm * Math.PI / 30);
    assert.ok(Math.abs(net - Math.max(0, E.brakeTorque(d, rpm))) < 0.2, `${rpm}: ${net}`);
  }
  assert.ok(me.maxTorqueRating >= Math.max(...me.torque.slice(1).map((r) => r[1])) * 0.9);
  assert.equal(part.soundConfig.fundamentalFrequencyCylinderCount, 5);
  assert.equal(part.soundConfig.sampleName, soundFor(d).engine);
  assert.deepEqual(part.flexbodies, [["mesh", "[group]:", "nonFlexMaterials"], [mesh, ["bx_engine"]]]);
  assert.equal(part.vehicleController.highShiftUpRPM, E.redline(d) - 200);
  const nodes = Object.fromEntries(part.nodes.filter(Array.isArray).map((r) => [r[0], r]));
  const dim = G.dimensions(d);
  assert.ok(Math.abs((nodes.e1r[2] - nodes.e2r[2]) - dim.length) < 0.002);
  assert.equal(nodes.e3r[4].isExhaust, "mainEngine");
  const weight = nodes.e1r[4].nodeWeight * 8 + 7;
  assert.ok(Math.abs(weight - G.mass(d)) < 1);
  assert.deepEqual(nodes.em1r.slice(0, 4), ["em1r", -0.25, -1.25, 0.47]);
});

test("torque rating rises with the design's torque", () => {
  assert.ok(torqueRating(D, 400) > torqueRating(D, 250));
});

test("slug and export path", () => {
  assert.equal(X.slug("  My  Engine! v2 "), "my_engine_v2");
  assert.equal(X.slug("***"), "engine");
  assert.equal(X.exportRelativePath({ name: "Hi" }, PROFILES.bx), "mods/unpacked/crankcase/vehicles/bx/crankcase_hi.jbeam");
});

const LAYOUT_CASES = [
  D, { ...D, cylinders: 6 }, { ...D, cylinders: 3 },
  { ...D, layout: "v", cylinders: 8, bore: 95, stroke: 79 }, { ...D, layout: "v", cylinders: 6 }, { ...D, layout: "v", cylinders: 12, bore: 80, stroke: 70 },
  { ...D, layout: "flat", cylinders: 4, bore: 92, stroke: 75 }, { ...D, layout: "flat", cylinders: 6, bore: 92.5, stroke: 78.5 },
];

test("the model stays inside the engine's node box for every layout", () => {
  const anchor = { x: 0, y: -1, z: 0.3 };
  for (const d of LAYOUT_CASES) {
    const { lo, hi } = bounds(engineParts(d, anchor));
    const nodes = G.blockNodes(d, anchor);
    const nlo = [1, 2, 3].map((i) => Math.min(...nodes.map((r) => r[i])));
    const nhi = [1, 2, 3].map((i) => Math.max(...nodes.map((r) => r[i])));
    for (let i = 0; i < 3; i++) {
      assert.ok(lo[i] >= nlo[i] - 0.01 && hi[i] <= nhi[i] + 0.01,
        `${G.layoutName(d)} axis ${i}: model ${lo[i].toFixed(3)}..${hi[i].toFixed(3)} vs nodes ${nlo[i]}..${nhi[i]}`);
    }
  }
});

test("the model file is well-formed and uses shared game materials", () => {
  const dae = writeDae("crankcase_x_engine", engineParts({ ...D, layout: "v", cylinders: 8 }, { x: 0, y: -1, z: 0.3 }));
  assert.ok(dae.startsWith("<?xml") && dae.trim().endsWith("</COLLADA>"));
  assert.ok(dae.includes('<material id="ibishu_engine-material" name="ibishu_engine">'));
  assert.ok(dae.includes('name="generic_chrome"'));
  const opens = (dae.match(/<triangles /g) || []).length, closes = (dae.match(/<\/triangles>/g) || []).length;
  assert.equal(opens, closes);
  // every index points at a vertex
  const count = Number(dae.match(/positions-array" count="(\d+)"/)[1]) / 3;
  const idx = [...dae.matchAll(/<p>([^<]*)<\/p>/g)].flatMap((m) => m[1].split(" ").map(Number));
  assert.ok(Math.max(...idx) < count);
});

test("every layout has a sound, own or the donor's", () => {
  for (const d of LAYOUT_CASES) {
    const s = soundFor(d);
    assert.ok(s === null || (s.engine && s.exhaust), G.layoutName(d));
  }
  assert.equal(soundFor({ layout: "flat", cylinders: 4 }).engine.startsWith("b4p"), true);
});

test("a design right at the bay's edge is tight, not failed", () => {
  // the flat-6 that fills the BX's width
  const fit = checkFit({ ...D, layout: "flat", cylinders: 6, bore: 92.5, stroke: 78.5, build: "race" }, PROFILES.bx, null);
  assert.equal(fit.ok, true);
  assert.ok(fit.checks.some((c) => c.level === "warn" && c.text.startsWith("Width")));
  assert.ok(!checkFit(D, PROFILES.bx, null).checks.some((c) => c.level === "warn"));
});

test("band numbers: Brief 1's intake change flattens 2,500-5,500", () => {
  const stock = E.bandStats(D, 2500, 5500), tuned = E.bandStats({ ...D, tuneRpm: 5500 }, 2500, 5500);
  assert.ok(tuned.spread < stock.spread);
  assert.ok(Math.abs(stock.spread - 0.13) < 0.02 && Math.abs(tuned.spread - 0.07) < 0.02);
  assert.ok(E.bandStats(D, 6000, 7000).min === 0); // past the 6,450 redline
});

test("knock: compression and bore raise it, octane cures it", () => {
  const peak = (d) => Math.max(...E.analyse(d, 100).knock);
  assert.ok(peak({ ...D, compression: 12 }) > peak(D));
  assert.ok(peak({ ...D, bore: 100 }) > peak(D));
  // a stock-like engine runs clean on regular
  assert.equal(E.analyse({ ...D, fuel: "87" }).knockLost, 0);
  // 12:1 knocks on 91 and costs torque there, but is clean on 93 and then beats 10.5:1 everywhere
  const hi91 = E.analyse({ ...D, compression: 12, fuel: "91" }), hi93 = E.analyse({ ...D, compression: 12, fuel: "93" });
  assert.ok(hi91.knockLost > 5);
  assert.equal(hi93.knockLost, 0);
  const base = E.analyse(D);
  hi93.torque.forEach((t, i) => assert.ok(t > base.torque[i]));
});

test("parts: the default parts give the default engine", () => {
  const r = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS });
  assert.ok(Math.abs(r.cam - D.cam) < 0.01 && Math.abs(r.tuneRpm - D.tuneRpm) <= 100 && Math.abs(r.friction - D.friction) < 0.01);
  assert.ok(Math.abs(E.analyse(r).peakPower - E.analyse(D).peakPower) < 2);
});

test("parts: what each part does", () => {
  const base = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS });
  const red = E.redline(base);
  const longCam = Parts.resolve({ ...base, duration: 270 }), shortRunner = Parts.resolve({ ...base, runner: 28 });
  assert.ok(E.analyse(longCam).camPeakRpm > E.analyse(base).camPeakRpm);
  assert.ok(Parts.overlap(longCam) > Parts.overlap(base));
  assert.ok(shortRunner.tuneRpm > base.tuneRpm);
  const lowRings = Parts.resolve({ ...base, rings: "low" });
  assert.ok(E.frictionTorque(lowRings, red) < E.frictionTorque(base, red));
  assert.ok(Parts.durability(lowRings) < Parts.durability(base));
  const highLift = Parts.resolve({ ...base, lift: 13.5 });
  assert.ok(E.valveFlow(highLift) > E.valveFlow(base));
  assert.ok(Parts.springFriction(highLift) > Parts.springFriction(base));
  // the lobes: open for the duration, peak at the lift, around TDC
  assert.ok(Math.abs(Parts.valveLift(base, 108, "intake") - base.lift) < 1e-9);
  assert.equal(Parts.valveLift(base, 360, "intake"), 0);
});

test("parts: old designs migrate to parts with nearly the same result", () => {
  const old = { ...D, layout: "v", cylinders: 8, bore: 72.5, stroke: 60, build: "race", cam: 1, tuneRpm: 8000, friction: 0.5 };
  const m = Parts.resolve(Parts.migrate(old));
  assert.equal(m.duration, 280);
  assert.ok(Math.abs(E.analyse(m).peakPower - E.analyse(old).peakPower) < 5);
});

test("gearing: tire size, speed and rpm agree", () => {
  assert.ok(Math.abs(Gear.tireRadius("195/60R15") - 0.3075) < 0.001);
  const g = { ...Gear.DEFAULT_GEARING };
  const v = Gear.speedAt(g, 6000, 1.0);
  assert.ok(Math.abs(Gear.rpmAt(g, v, 1.0) - 6000) < 1e-6);
  // 6000 rpm in 4th (1.00) with a 4.08 final on 195/60R15: about 170 km/h
  assert.ok(Math.abs(v - 170) < 3, `${v}`);
});

test("gearing: too tall a top gear is drag-limited below redline, too short hits the limiter", () => {
  const car = PROFILES.bx.car;
  const base = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING });
  const tall = Gear.analyseGearing({ ...base, finalDrive: 3.0, gear5: 0.7 }, car);
  const short = Gear.analyseGearing({ ...base, finalDrive: 5.0 }, car);
  assert.equal(tall.limitedBy, "drag");
  assert.ok(tall.topRpm < tall.redline - 200);
  assert.equal(short.limitedBy, "redline");
  // a big gap between gears shows up as a low-power shift and less coverage
  const gappy = Gear.analyseGearing({ ...base, gear2: 2.9, gear3: 1.31 }, car);
  const even = Gear.analyseGearing(base, car);
  assert.ok(gappy.shifts[1].powerShare < even.shifts[1].powerShare);
  assert.ok(gappy.coverage < even.coverage);
  assert.ok(even.zeroTo100 > 4 && even.zeroTo100 < 12, `${even.zeroTo100}`);
});

import * as Crank from "../ui/lib/crankfile.js";

test(".crank: a design survives save and open", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING, name: "Round trip", notes: "hello",
    layout: "v", cylinders: 8, bore: 95, stroke: 85, duration: 260, runner: 30, rings: "low", compression: 13.7, fuel: "e85",
    gearCount: 6, gear6: 0.72, finalDrive: 3.9, tire: "245/40R17" });
  const text = Crank.toCrank(d);
  const file = JSON.parse(text);
  assert.equal(file.format, "crankcase");
  assert.equal(file.gearing.gears.length, 6);
  assert.ok(file.summary.engine.startsWith("V8"));
  const back = Crank.fromCrank(text);
  for (const k of ["name", "notes", "layout", "cylinders", "bore", "stroke", "duration", "runner", "rings", "compression", "fuel", "gearCount", "gear6", "finalDrive", "tire"]) {
    assert.deepEqual(back[k], d[k], k);
  }
  assert.ok(Math.abs(E.analyse(back).peakPower - E.analyse(d).peakPower) < 1e-9);
});

test(".crank: rejects what isn't one", () => {
  assert.throws(() => Crank.fromCrank("{"), /not valid JSON/);
  assert.throws(() => Crank.fromCrank('{"format":"other"}'), /not a .crank/);
  assert.throws(() => Crank.fromCrank('{"format":"crankcase","version":99}'), /newer/);
});

import * as VC from "../ui/lib/vehicleconfig.js";

// a made-up stock config in the game's format
const BASE_PC = `{
  "format":2, "mainPartName":"bx", "model":"bx",
  "parts":{ "bx_engine":"bx_engine_i4_2.0", "bx_transmission":"bx_transmission_5M",
    "bx_finaldrive_R":"bx_finaldrive_R_408", "tire_R_15x7":"tire_R_195_60_15_standard", "bx_body":"bx_body_hatch" },
  "vars":{ "$brakebias":0.6 }
}`;

test("vehicle config: engine, adjustable gearbox and final drive with the design's ratios", () => {
  const prof = PROFILES.bx;
  const d = { ...D, ...Gear.DEFAULT_GEARING, name: "Rally box", gear1: 2.7, gear2: 1.97, gear3: 1.55, gear4: 1.26, gear5: 1, finalDrive: 6, tire: "195/60R15" };
  const { pc, info, notes } = VC.buildConfig(d, prof, BASE_PC);
  const c = JSON.parse(pc);
  assert.equal(c.parts.bx_engine, X.partName(d, prof));
  assert.equal(c.parts.bx_transmission, "bx_transmission_5M_sequential");
  assert.equal(c.parts.bx_finaldrive_R, "bx_finaldrive_R_race");
  assert.equal(c.parts.bx_body, "bx_body_hatch");
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => c.vars[`$gear_${i}`]), [2.7, 1.97, 1.55, 1.26, 1]);
  assert.equal(c.vars.$finaldrive_R, 6);
  assert.equal(c.vars.$brakebias, 0.6);
  assert.equal(notes.length, 0);
  assert.equal(JSON.parse(info).Configuration, "Crankcase: Rally box");
  assert.ok(X.infoRelativePath(d, prof).endsWith("vehicles/bx/info_crankcase_rally_box.json"));
});

test("vehicle config: six gears, four gears and a tyre mismatch", () => {
  const prof = PROFILES.bx, g = { ...D, ...Gear.DEFAULT_GEARING };
  const six = JSON.parse(VC.buildConfig({ ...g, gearCount: 6, gear6: 0.7 }, prof, BASE_PC).pc);
  assert.equal(six.parts.bx_transmission, "bx_transmission_6M_race");
  assert.equal(six.vars.$gear_6, 0.7);
  const four = VC.buildConfig({ ...g, gearCount: 4 }, prof, BASE_PC);
  assert.equal(JSON.parse(four.pc).vars.$gear_5, g.gear4);
  assert.ok(four.notes.some((n) => /same as gear 4/.test(n)));
  const tyre = VC.buildConfig({ ...g, tire: "245/40R17" }, prof, BASE_PC);
  assert.ok(tyre.notes.some((n) => /195\/60R15/.test(n) && /lower/.test(n)), tyre.notes.join());
  assert.equal(VC.tireSizeFromPart("tire_R_175_70_15_altb_rally"), "175/70R15");
});

test("ratio tools: spread, rebase and gear from a speed", () => {
  const d = { ...Gear.DEFAULT_GEARING, gearCount: 6, gear1: 3.45, gear6: 0.8, finalDrive: 3.48, tire: "225/45R16" };
  const even = { ...d, ...Gear.spreadGears(d, "even").changes };
  const st = Gear.steps(even);
  assert.ok(Math.max(...st) - Math.min(...st) < 0.02, st.join());
  const prog = Gear.steps({ ...d, ...Gear.spreadGears(d, "progressive").changes });
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i] > prog[i - 1], prog.join()); // closer going up
  // rebase keeps every overall ratio
  const v6 = { ...d, gear1: 5, gear2: 3.73, gear3: 2.89, gear4: 2.39, gear5: 1.76, gear6: 1.16, finalDrive: 2.4 };
  const rb = { ...v6, ...Gear.rebase(v6, 0.8).changes };
  assert.equal(rb.gear6, 0.8);
  for (let i = 1; i <= 6; i++) assert.ok(Math.abs(rb[`gear${i}`] * rb.finalDrive / (v6[`gear${i}`] * v6.finalDrive) - 1) < 0.01);
  assert.match(Gear.rebase(v6, 0.3).error, /final drive/);
  const s = Gear.gearForSpeed(d, 2400, 100);
  assert.equal(s.gear, 0.79);
  assert.ok(Math.abs(Gear.rpmAt(d, 100, s.gear) - 2400) < 20);
  assert.ok(Gear.gearForSpeed(d, 8000, 20).error);
});

import { parseLd, parseLdx } from "../ui/lib/motec.js";
import { analyseRun } from "../ui/lib/run.js";

/** A small MoTeC .ld in the layout Beamlog writes: int32 channels at one rate. */
function makeLd(channels, rate, vehicle) {
  const HEADER = 1762, EVENT = 1154, CH = 116;
  const n = channels[0].values.length, meta = HEADER + EVENT, data = meta + channels.length * CH;
  const buf = new ArrayBuffer(data + channels.length * n * 4), v = new DataView(buf), b = new Uint8Array(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  v.setUint32(0, 0x40, true); v.setUint32(8, meta, true); v.setUint32(12, data, true); v.setUint32(36, HEADER, true);
  v.setUint32(86, channels.length, true);
  str(94, "29/10/2026"); str(126, "11:32:41"); str(222, vehicle); str(HEADER + 64, "test session");
  channels.forEach((c, i) => {
    const p = meta + i * CH;
    v.setUint32(p, i ? p - CH : 0, true); v.setUint32(p + 4, i < channels.length - 1 ? p + CH : 0, true);
    v.setUint32(p + 8, data + i * n * 4, true); v.setUint32(p + 12, n, true);
    v.setUint16(p + 18, 5, true); v.setUint16(p + 20, 4, true); v.setUint16(p + 22, rate, true);
    v.setInt16(p + 26, 1, true); v.setInt16(p + 28, 1, true); v.setInt16(p + 30, c.dec, true);
    str(p + 32, c.name); str(p + 72, c.unit);
    c.values.forEach((x, k) => v.setInt32(data + i * n * 4 + k * 4, Math.round(x * 10 ** c.dec), true));
  });
  return buf;
}

test("a recorded run: torque, gear ratios, shifts and what the car did", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING, name: "Test V6" });
  const rate = 50, r = Gear.tireRadius(d.tire), rs = Gear.ratios(d);
  const ch = { speed: [], rpm: [], gear: [], thr: [], clutch: [], tq: [], wl: [], wr: [], wf: [] };
  // a full-throttle pull through the gears from 20 km/h, upshifting at 6,000 rpm
  let kmh = 20, gear = 1;
  for (let i = 0; i < 40 * rate; i++) {
    let rpm = Gear.rpmAt(d, kmh, rs[gear - 1]);
    if (rpm > 6000 && gear < rs.length) { gear++; rpm = Gear.rpmAt(d, kmh, rs[gear - 1]); }
    const wheelAv = (kmh / 3.6 / r) * 1.02; // driven wheels slip 2% forward
    ch.speed.push(kmh); ch.rpm.push(rpm); ch.gear.push(gear); ch.thr.push(100); ch.clutch.push(0);
    ch.tq.push(E.brakeTorque(d, rpm) * 1.03); // the game makes 3% more
    ch.wl.push(wheelAv); ch.wr.push(wheelAv); ch.wf.push(kmh / 3.6 / r);
    kmh += 4 / gear / rate;
  }
  const buf = makeLd([
    { name: "Ground Speed", unit: "km/h", dec: 2, values: ch.speed },
    { name: "Engine RPM", unit: "rpm", dec: 0, values: ch.rpm },
    { name: "Gear", unit: "", dec: 0, values: ch.gear },
    { name: "Throttle Pos", unit: "%", dec: 1, values: ch.thr },
    { name: "Clutch Pos", unit: "%", dec: 1, values: ch.clutch },
    { name: "Engine Torque", unit: "Nm", dec: 1, values: ch.tq },
    { name: "Wheel Angular Speed FL", unit: "rad/s", dec: 2, values: ch.wf },
    { name: "Wheel Angular Speed FR", unit: "rad/s", dec: 2, values: ch.wf },
    { name: "Wheel Angular Speed RL", unit: "rad/s", dec: 2, values: ch.wl },
    { name: "Wheel Angular Speed RR", unit: "rad/s", dec: 2, values: ch.wr },
  ], rate, `bx crankcase_${X.slug(d.name)}`);
  const run = parseLd(buf);
  assert.equal(run.date, "29/10/2026");
  assert.equal(run.session, "test session");
  assert.equal(run.channels.get("Ground Speed").rate, 50);
  assert.ok(Math.abs(run.channels.get("Ground Speed").data[0] - 20) < 1e-9);

  const a = analyseRun(run, d, parseLdx('<Marker Time="1000000.000000"/><Marker Time="31000000.000000"/>'));
  assert.ok(a.matches);
  assert.deepEqual(a.laps, [1, 31]);
  assert.ok(a.torque.length >= 6, `${a.torque.length}`);
  for (const t of a.torque) assert.ok(Math.abs(t.logged / t.design - 1.03) < 0.02, `${t.rpm}: ${t.logged} vs ${t.design}`);
  // the ratio check uses the driven (faster) wheels: 2% slip shows up as 2% lower than gear x final
  for (const g of a.gears.filter((x) => x.ratio)) assert.ok(Math.abs(g.ratio * 1.02 / g.designRatio - 1) < 0.01, `${g.gear}`);
  assert.ok(a.shifts.length >= 2 && a.shifts.every((s) => s.left > 5500 && s.landed < s.left), JSON.stringify(a.shifts));
  assert.equal(a.summary.topGear, a.gears[a.gears.length - 1].gear);
  assert.throws(() => parseLd(new ArrayBuffer(10)), /not a MoTeC/);
  assert.equal(analyseRun({ ...run, vehicle: "bx stock" }, d).matches, false);
});

import * as Rot from "../ui/lib/rotating.js";
import * as VC2 from "../ui/lib/vehicleconfig.js";

test("rotating mass: inertia, rev response, rev drop, inertia felt in each gear", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING });
  assert.equal(d.flywheel, "stock");
  assert.ok(Math.abs(Rot.flywheelInertia(d) - 0.10) < 1e-9);
  assert.ok(Math.abs(Rot.totalInertia(d) - (E.inertia(d) + 0.10)) < 1e-9);
  const light = { ...d, flywheel: "ultra", crank: "lightened" };
  assert.ok(Rot.crankInertia(light) < Rot.crankInertia(d));
  // half the inertia, about half the time to rev
  const t1 = Rot.revUp(d).time, t2 = Rot.revUp(d, 1500, Rot.totalInertia(d) / 2).time;
  assert.ok(Math.abs(t2 / t1 - 0.5) < 0.02, `${t1} ${t2}`);
  assert.ok(Rot.revUp(light).time < t1);
  // a lighter flywheel drops revs faster when the throttle shuts
  assert.ok(Rot.dropIn(light, 6000, 0.3) > Rot.dropIn(d, 6000, 0.3));
  // felt as extra mass: largest in 1st, and lighter engines feel lighter
  const g = Gear.analyseGearing(d, PROFILES.bx.car), gl = Gear.analyseGearing(light, PROFILES.bx.car);
  assert.ok(g.inertiaMass[0] > g.inertiaMass[4] * 5);
  assert.ok(gl.zeroTo100 < g.zeroTo100);
  // .crank keeps the choices; old files get the stock parts
  const back = Crank.fromCrank(Crank.toCrank({ ...light, name: "Light" }));
  assert.equal(back.flywheel, "ultra"); assert.equal(back.crank, "lightened");
  assert.equal(Crank.fromCrank('{"format":"crankcase","version":1,"engine":{}}').flywheel, "stock");
});

test("export: the engine carries the crank's inertia, the flywheel is its own part in the config", () => {
  const prof = PROFILES.bx;
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING, name: "Fly test", flywheel: "light" });
  const donor = `{"bx_engine_i4_2.4": {"information": {"name": "x"}, "slotType": "bx_engine", "slots2": [["name"]],
    "mainEngine": {"torque": [["rpm","torque"],[0,0]], "friction": 10, "dynamicFriction": 0.02, "inertia": 0.11},
    "nodes": [["id","posX","posY","posZ"]], "flexbodies": []}}`;
  const out = X.buildEngine(d, prof, donor);
  const file = parseJBeam(out.text);
  assert.ok(Math.abs(file[out.name].mainEngine.inertia - Rot.crankInertia(d)) < 0.001);
  assert.equal(file[out.flywheel].slotType, "bx_flywheel");
  assert.equal(file[out.flywheel].clutch.additionalEngineInertia, 0.05);
  const base = `{"format":2,"mainPartName":"bx","model":"bx","parts":{"bx_flywheel":"bx_flywheel"},"vars":{}}`;
  const pc = JSON.parse(VC2.buildConfig(d, prof, base).pc);
  assert.equal(pc.parts.bx_flywheel, out.flywheel);
});

import * as L from "../ui/lib/sections.js";
import { familyFor } from "../ui/lib/profiles.js";

test("section readouts: figures, notes ranked by urgency, background", () => {
  const base = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING });
  const prof = PROFILES.bx;
  const designs = [base, { ...base, compression: 13.5, fuel: "87" }, { ...base, flywheel: "ultra", crank: "lightened" }];
  for (const d of designs) {
    const a = E.analyse(d);
    const car = { ...prof.car, mass: prof.car.mass + (G.mass(d) - familyFor(prof, d.layout).donorMass) };
    const ctx = { car, gearingNote: prof.gearingNote };
    for (const l of L.SECTIONS) {
      const figs = l.figures(d, a, ctx);
      assert.ok(figs.length > 0, l.id);
      for (const f of figs) assert.ok(f.label && f.value && !String(f.value).includes("NaN"), `${l.id} ${f.label}`);
      const notes = L.sectionNotes(l, d, a, ctx);
      const order = notes.map((n) => L.LEVEL_ORDER[n.level]);
      assert.deepEqual(order, [...order].sort((x, y) => x - y), l.id);
      for (const n of notes) assert.ok(n.text && !n.text.includes("NaN") && n.text.length < 90, `${l.id}: ${n.text}`);
      assert.ok(Array.isArray(l.background(d, a, ctx)));
    }
  }
  // knocking is critical and comes first
  const k = { ...base, compression: 13.5, fuel: "87" };
  const comp = L.SECTIONS.find((l) => l.id === "compression");
  assert.equal(L.sectionNotes(comp, k, E.analyse(k), {})[0].level, "crit");
});

test("shift speed: presets, the perfect shift time, saved in the design file", async () => {
  const { toCrank, fromCrank } = await import("../ui/lib/crankfile.js");
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING });
  assert.equal(Gear.shiftTime(d), 0.3);
  assert.equal(Gear.shiftTime({ ...d, shift: "relaxed" }), 0.8);
  assert.equal(Gear.shiftTime({ ...d, shift: undefined }), 0.3);
  // slower shifts cost 0-100 time
  const car = PROFILES.bx.car;
  assert.ok(Gear.analyseGearing({ ...d, shift: "relaxed" }, car).zeroTo100 > Gear.analyseGearing({ ...d, shift: "sequential" }, car).zeroTo100);
  // the perfect shift time: the revs reach the target then, and a lighter flywheel gets there sooner
  const red = E.redline(d), target = red * 0.75;
  const m = Rot.matchTime(d, red, target);
  assert.ok(Math.abs(red - Rot.dropIn(d, red, m) - target) < 30);
  assert.ok(Rot.matchTime({ ...d, flywheel: "ultra" }, red, target) < m);
  assert.equal(fromCrank(toCrank({ ...d, shift: "brisk", name: "x" })).shift ?? fromCrank(toCrank({ ...d, shift: "brisk", name: "x" })).design.shift, "brisk");
});

test("closed-throttle drag: the design's friction in BeamNG's form, plus pumping against a shut throttle", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING });
  const fit = Rot.frictionFit(d);
  assert.ok(fit.friction > 0 && fit.dynamicFriction > 0);
  for (let rpm = 1000; rpm <= E.redline(d); rpm += 500) {
    const beam = fit.friction + fit.dynamicFriction * rpm * Math.PI / 30;
    assert.ok(Math.abs(beam - E.frictionTorque(d, rpm)) < 0.08 * E.frictionTorque(d, rpm) + 2, `${rpm}`);
  }
  // pumping is constant and scales with displacement: about 15 N m for 2.4 L
  assert.ok(Math.abs(Rot.pumpingTorque(d) - 0.08e6 * E.displacement(d) / (4 * Math.PI)) < 1e-9);
  assert.ok(Rot.pumpingTorque(d) > 13 && Rot.pumpingTorque(d) < 17);
  // the rev drop follows that drag: rate = drag / inertia
  const red = E.redline(d), I = Rot.totalInertia(d);
  const rate = Rot.dropIn(d, red, 0.01) / 0.01;
  const want = Rot.closedThrottleDrag(d, red) / I * 30 / Math.PI;
  assert.ok(Math.abs(rate / want - 1) < 0.03, `${rate} ${want}`);
  // better parts (less friction) brake less
  assert.ok(Rot.closedThrottleDrag(Parts.resolve({ ...d, rings: "low", oil: "0w20" }), 6000) < Rot.closedThrottleDrag(d, 6000));
});

test("best shift points: where the next gear accelerates harder, redline if it never does", () => {
  const car = PROFILES.bx.car;
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING });
  const g = Gear.analyseGearing(d, car);
  assert.equal(g.bestShifts.length, g.rs.length - 1);
  for (const s of g.bestShifts) {
    assert.ok(s.rpm <= E.redline(d) + 1, `${s.from}: ${s.rpm}`);
    assert.ok(Math.abs(s.landing - s.rpm * g.rs[s.to - 1] / g.rs[s.from - 1]) < 1);
    // before the best point the current gear pulls at least as hard as the next
    const before = s.kmh - 3;
    const fNow = Gear.wheelForce(d, before, g.rs[s.from - 1]), fNext = Gear.wheelForce(d, before, g.rs[s.to - 1]);
    if (s.early && fNow != null && fNext != null) assert.ok(fNow >= fNext * 0.97, `${s.from}→${s.to}`);
  }
  // an engine whose power falls off well before its redline shifts early; widely spaced gears shift at redline
  const peaky = { ...d, gearCount: 4, gear1: 3.3, gear2: 2.9, gear3: 2.5, gear4: 2.2 };
  assert.ok(Gear.analyseGearing(peaky, car).bestShifts.some((s) => s.early));
  const wide = { ...d, gearCount: 4, gear1: 4.5, gear2: 2.2, gear3: 1.2, gear4: 0.7 };
  assert.ok(Gear.analyseGearing(wide, car).bestShifts.slice(1).every((s) => !s.early));
});
