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
import * as Exh from "../ui/lib/exhaust.js";

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
  // with a free-flowing exhaust, as the summary numbers knew no exhaust
  assert.ok(Math.abs(E.analyse(Exh.freeFlowing(r)).peakPower - E.analyse(D).peakPower) < 2);
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
    // the game makes 3% more; what's logged leaves through the clutch, less what spins up the engine itself
    const alpha = (Gear.rpmAt(d, kmh + 4 / gear / rate, rs[gear - 1]) - rpm) * rate * Math.PI / 30;
    ch.tq.push(E.brakeTorque(d, rpm) * 1.03 - Rot.totalInertia(d) * alpha);
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

import * as Ind from "../ui/lib/induction.js";
import * as VC3 from "../ui/lib/vehicleconfig.js";

const TURBO_DONOR = DONOR.replace(/}\s*$/, `,
"bx_intake_i4_large_stage2": {
  "information": {"authors": "test", "name": "Stock turbo", "value": 1},
  "slotType": "bx_intake_i4_large",
  "variables": [["name", "type", "unit", "category", "default", "min", "max", "title", "description"],
    ["$wastegateStart", "range", "psi", "Engine", 10, 7, 17, "Boost", "x"]],
  "turbocharger": {"bovSoundFileName": "bov", "wastegateStart": "$wastegateStart", "maxExhaustPower": 35000,
    "pressurePSI": [[0, -3.5], [250000, 38]], "engineDef": [[0, 0, 0], [9000, 0.9, 0.8]]},
  "mainEngine": {"torqueModIntake": [["rpm", "torque"], [0, 0], [4000, 24]], "turbocharger": "turbocharger"},
  "nodes": [["id", "posX", "posY", "posZ"], ["trb1", 0.247, -1.263, 0.486]],
},
}`);

test("turbo: boost reaches its target at the full-boost rpm, fills the cylinders, and knocks", () => {
  const na = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING });
  assert.equal(na.induction, "none");
  assert.equal(Ind.chargeFactor(na, 4000), 1);
  const t = { ...na, induction: "turbo", boost: 10, spoolRpm: 3500, compression: 9 };
  const full = Ind.fullBoostRpm(t);
  assert.ok(Math.abs(full - 3500) <= 150, `${full}`);
  for (let rpm = 1000; rpm <= E.redline(t); rpm += 250) assert.ok(Ind.steadyBoost(t, rpm) <= 10.01);
  assert.ok(Ind.steadyBoost(t, 2000) < Ind.steadyBoost(t, 3000));
  // about 6% more torque per psi at full boost, before friction
  const cf = Ind.chargeFactor(t, 5000);
  assert.ok(cf > 1.5 && cf < 1.62, `${cf}`);
  assert.ok(E.brakeTorque(t, 5000) > E.brakeTorque({ ...t, induction: "none" }, 5000) * 1.4);
  // boost raises knock: 10.5:1 at 10 psi knocks on 91, 9:1 doesn't
  assert.ok(E.analyse({ ...t, compression: 10.5 }).knockLost > 0);
  assert.equal(E.analyse(t).knockLost, 0);
  // a bigger turbo (later full boost) spins up more slowly
  assert.ok(Ind.turboSpec({ ...t, spoolRpm: 5000 }).pressureRatePSI < Ind.turboSpec(t).pressureRatePSI);
  // the spline matches BeamNG's: through the points
  assert.equal(Ind.spline([[0, 0], [10, 5], [20, 7], [30, 8]], 10), 5);
});

/** BeamNG's full-throttle torque from exported parts: engine table, intake part's multiplier, exhaust part, turbo and supercharger. */
function gameTorque(engine, ind, rpm, exhaust = null) {
  const curve = (rows) => rows.slice(1);
  const base = Ind.spline(curve(engine.torque), rpm);
  const exh = exhaust?.mainEngine?.torqueModExhaust ? Ind.spline(curve(exhaust.mainEngine.torqueModExhaust), rpm) : 0;
  const mult = ind.mainEngine?.torqueModMult ? Ind.spline(curve(ind.mainEngine.torqueModMult), rpm) : 1;
  let coef = 1;
  const tc = ind.turbocharger;
  if (tc && ind.mainEngine.turbocharger) {
    const exh = tc.engineDef.map((p) => [p[0], Math.min(1, p[2])]), eff = tc.engineDef.map((p) => [p[0], p[1]]);
    const target = ind.variables[1][4] + Number(tc.wastegateLimit.match(/\+([\d.]+)/)[1]) / 2;
    const w = Math.min(Math.sqrt(Math.max(0.9 * rpm / engine.maxRPM * Ind.spline(exh, rpm) * tc.maxExhaustPower - tc.frictionCoef, 0) / tc.backPressureCoef), 250000 * 0.10471971768);
    const psi = Math.min(Ind.spline(tc.pressurePSI, Math.floor(w * 9.5493)), target);
    coef *= 1 + 0.0000087 * psi * 6894.757293178 * Ind.spline(eff, rpm);
  }
  const sc = ind.supercharger;
  if (sc) {
    const maxBlower = Math.ceil(engine.maxRPM * sc.gearRatio);
    const clutch = sc.clutchDisengageRPM ? Math.min(Math.max(-(rpm - sc.clutchDisengageRPM) / sc.clutchDisengageRange + 1, 0), 1) : 1;
    const blower = rpm * sc.gearRatio * clutch, r = blower / maxBlower;
    const shape = { roots: [-0.35, 1], screws: [0.3, 0.7], centrifugal: [0.6, 0.45] }[sc.type];
    const psi = Math.max((shape[0] * r * r + shape[1]) * sc.pressurePSIPer1kRPM * 0.001 * blower, 0);
    coef *= Math.max(1 + 0.0000087 * psi * 6894.757293178 - sc.crankLossPer1kRPM * 0.001 * blower, 0);
  }
  return (base * mult + exh) * coef - (engine.friction + engine.dynamicFriction * rpm * Math.PI / 30);
}

const INDUCTION_DONOR = TURBO_DONOR
  .replace('["bx_enginemounts", ["bx_enginemounts"], [], "bx_enginemounts", "Engine Mounts"]',
    '["bx_enginemounts", ["bx_enginemounts"], [], "bx_enginemounts", "Engine Mounts"],\n    ["bx_intake_i4_large", ["bx_intake_i4_large"], [], "bx_intake_i4_large", "Intake"]')
  .replace(/}\s*$/, `,
"bx_exhaust_i4": {
  "information": {"authors": "test", "name": "Stock exhaust", "value": 1},
  "slotType": "bx_exhaust_i4",
  "mainEngine": {"torqueModExhaust": [["rpm", "torque"], [0, 0], [6000, -12]]},
  "soundConfigExhaust": {"$+lowShelfGain": 13},
  "nodes": [["id", "posX", "posY", "posZ"], ["ex1", 0, 1, 0.3], ["ex7r", 0, 2, 0.3, {"exhaustAudioMufflingCoef": 0.22, "afterFireAudioCoef": 0.2}]],
},
"bx_intake_i4_large": {
  "information": {"authors": "test", "name": "Stock intake", "value": 1},
  "slotType": "bx_intake_i4_large",
  "mainEngine": {"torqueModIntake": [["rpm", "torque"], [0, 0], [4000, 5]]},
  "flexbodies": [["mesh", "[group]:", "nonFlexMaterials"], ["bx_airbox", ["bx_engine"]]],
},
}`);

test("induction export: every layout makes the predicted torque in BeamNG", () => {
  const base = { ...Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING }), name: "Boosted", compression: 9.5 };
  const cases = [
    { induction: "turbo", turboLayout: "single", boost: 12, spoolRpm: 3800 },
    { induction: "turbo", turboLayout: "twin", boost: 12, spoolRpm: 3800 },
    { induction: "turbo", turboLayout: "sequential", boost: 12, spoolRpm: 2600, handoverRpm: 4500 },
    { induction: "turbo", turboLayout: "twinscroll", boost: 14, spoolRpm: 3500, compression: 10.5 }, // knocks
    { induction: "supercharger", scType: "roots", boost: 8 },
    { induction: "supercharger", scType: "screw", boost: 10 },
    { induction: "supercharger", scType: "centrifugal", boost: 12, compression: 10.5 },
    { induction: "twincharged", scType: "roots", turboLayout: "single", boost: 10, handoverRpm: 4000 },
  ];
  for (const c of cases) {
    const d = { ...base, ...c };
    const out = X.buildEngine(d, testProfile, INDUCTION_DONOR);
    assert.equal(out.induction, "bx_intake_i4_large_crankcase_boosted");
    const parts = parseJBeam(out.text);
    const ind = parts[out.induction], me = parts[out.name].mainEngine, exh = parts[out.exhaust];
    assert.equal(out.exhaust, "bx_exhaust_i4_crankcase_boosted");
    assert.equal(ind.slotType, "bx_intake_i4_large");
    assert.equal(ind.mainEngine.torqueModIntake, undefined);
    assert.equal(!!ind.turbocharger, Ind.hasTurbo(d), c.induction);
    assert.equal(!!ind.supercharger, Ind.hasSupercharger(d), c.induction);
    assert.ok(ind.flexbodies.some((r) => Array.isArray(r) && r[0] === "crankcase_boosted_induction"));
    assert.ok(out.dae.includes('name="crankcase_boosted_induction"') && out.dae.includes('name="crankcase_boosted_engine"'));
    // the engine's own table is the same as without forced induction
    const naOut = X.buildEngine({ ...d, induction: "none" }, testProfile, INDUCTION_DONOR);
    assert.equal(naOut.induction, null);
    assert.deepEqual(me.torque, parseJBeam(naOut.text)[naOut.name].mainEngine.torque);
    assert.ok(me.maxTorqueRating >= E.analyse(d).peakTorque);
    for (let rpm = 1500; rpm <= E.redline(d); rpm += 125) {
      // exact on the 250 rpm grid; between points both sides interpolate their own way
      const game = gameTorque(me, ind, rpm, exh), want = E.brakeTorque(d, rpm);
      assert.ok(Math.abs(game - want) < (rpm % 250 ? 0.025 * want + 2 : 1.5), `${c.induction}/${c.turboLayout ?? c.scType} at ${rpm}: game ${game.toFixed(1)}, Crankcase ${want.toFixed(1)}`);
    }
  }
  // the config fits the part, at the design's boost
  const d = { ...base, induction: "turbo", boost: 12, spoolRpm: 3800 };
  const cfg = VC3.buildConfig(d, PROFILES.bx, BASE_PC);
  const pc = JSON.parse(cfg.pc);
  assert.equal(pc.parts.bx_intake_i4_large, "bx_intake_i4_large_crankcase_boosted");
  assert.equal(pc.vars.$wastegateStart, 11.5);
  assert.equal(pc.parts.bx_exhaust_i4, "bx_exhaust_i4_crankcase_boosted");
  assert.equal(JSON.parse(cfg.info)["Induction Type"], "Turbo");
  assert.equal(JSON.parse(VC3.buildConfig({ ...d, induction: "supercharger" }, PROFILES.bx, BASE_PC).info)["Induction Type"], "Supercharger");
});

/* ---------- any car: profiles worked out from a car's own files ---------- */
import * as Det from "../ui/lib/detect.js";
import * as Frame from "../ui/lib/frame.js";

// A made-up front-wheel-drive car with a transverse engine that lives in common/
// and names its sides the other way round from the BX (no game data).
const TC_COMMON = {
  "vehicles/common/tc/tc_engine.jbeam": `{
"tc_engine_i4": {
  "information": {"name": "Test 1.6 I4"},
  "slotType": "tc_engine",
  "slots2": [["name", "allowTypes", "denyTypes", "default", "description"],
    ["tc_intake", ["tc_intake"], [], "tc_intake_na", "Intake"],
    ["tc_engine_internals", ["tc_engine_internals"], [], "", "Internals"],
    ["tc_radiator", ["tc_radiator"], [], "tc_radiator", "Radiator"],
    ["tc_transmission", ["tc_transmission"], [], "tc_transmission_6M", "Gearbox"]],
  "mainEngine": {"torque": [["rpm", "torque"], [0, 0], [6000, 140]]},
  "nodes": [["id", "posX", "posY", "posZ"], {"nodeWeight": 15},
    ["e1r", 0.30, -1.60, 0.30], ["e1l", 0.30, -1.30, 0.30], ["e2r", -0.20, -1.60, 0.30], ["e2l", -0.20, -1.30, 0.30],
    ["e3r", 0.30, -1.62, 0.75], ["e3l", 0.30, -1.28, 0.75], ["e4r", -0.20, -1.62, 0.75], ["e4l", -0.20, -1.28, 0.75]]
},
"tc_intake_na": {"information": {"name": "Stock intake"}, "slotType": "tc_intake", "mainEngine": {}},
"tc_turbo": {"information": {"name": "Stage 1 Turbo"}, "slotType": "tc_intake", "turbocharger": {"wastegateStart": 8}},
"tc_radiator": {"slotType": "tc_radiator", "nodes": [["id", "posX", "posY", "posZ"], ["rad1", 0.0, -1.95, 0.5], ["rad2", 0.3, -1.95, 0.5]]}
}`,
};
const TC_FILES = {
  "vehicles/tc/info.json": `{"Brand": "Testa", "Name": "vehiclesData.tc.Name", "default_pc": "base", "Type": "Car"}`,
  "vehicles/tc/base.pc": `{"format": 2, "parts": {"tc_engine": "tc_engine_i4", "tc_differential_F": "tc_differential_F"}}`,
  "vehicles/tc/info_base.json": `{"Weight": 1100, "Power": 110, "Top Speed": 52, "Drivetrain": "FWD"}`,
  "vehicles/tc/tc.jbeam": `{
"tc": {"slotType": "main", "slots2": [["name", "allowTypes", "denyTypes", "default", "description"],
  ["tc_body", ["tc_body"], [], "tc_body", "Body"], ["tc_engine", ["tc_engine"], [], "tc_engine_i4", "Engine"],
  ["tc_differential_F", ["tc_differential_F"], [], "tc_differential_F", "Front differential"]]},
"tc_body": {"slotType": "tc_body", "nodes": [["id", "posX", "posY", "posZ"], ["hood1", 0.0, -1.45, 0.90], ["hood2", 0.4, -1.45, 0.92]]}
}`,
  "vehicles/tc/tc_drivetrain.jbeam": `{
"tc_transmission_6M": {"slotType": "tc_transmission",
  "slots2": [["name", "allowTypes", "denyTypes", "default", "description"], ["tc_flywheel", ["tc_flywheel"], [], "tc_flywheel", "Flywheel"]],
  "powertrain": [["type", "name", "inputName", "inputIndex"], ["frictionClutch", "clutch", "mainEngine", 1], ["manualGearbox", "gearbox", "clutch", 1]]},
"tc_transmission_6M_race": {"information": {"name": "Race 6-Speed"}, "slotType": "tc_transmission",
  "slots2": [["name", "allowTypes", "denyTypes", "default", "description"], ["tc_flywheel", ["tc_flywheel"], [], "tc_flywheel", "Flywheel"]],
  "variables": [["name", "type", "unit", "category", "default", "min", "max", "title", "description"],
    ["$gear_1", "range", ":1", "Gears", 3.5, 0.5, 5], ["$gear_2", "range", ":1", "Gears", 2.1, 0.5, 5], ["$gear_3", "range", ":1", "Gears", 1.5, 0.5, 5],
    ["$gear_4", "range", ":1", "Gears", 1.1, 0.5, 5], ["$gear_5", "range", ":1", "Gears", 0.9, 0.5, 5], ["$gear_6", "range", ":1", "Gears", 0.8, 0.5, 5]],
  "powertrain": [["type", "name", "inputName", "inputIndex"], ["frictionClutch", "clutch", "mainEngine", 1], ["sequentialGearbox", "gearbox", "clutch", 1]]},
"tc_differential_F": {"slotType": "tc_differential_F",
  "slots2": [["name", "allowTypes", "denyTypes", "default", "description"], ["tc_finaldrive_F", ["tc_finaldrive_F"], [], "tc_finaldrive_F_4", "Final drive"]]},
"tc_finaldrive_F_4": {"slotType": "tc_finaldrive_F"},
"tc_finaldrive_F_race": {"slotType": "tc_finaldrive_F",
  "variables": [["name", "type", "unit", "category", "default", "min", "max", "title", "description"], ["$finaldrive_F", "range", ":1", "Differentials", 4, 2, 6]]}
}`,
};

test("a car's profile is worked out from its own files", () => {
  const p = Det.detectProfile("tc", { files: TC_FILES }, Det.partIndex(TC_COMMON), { "vehiclesData.tc.Name": "Tester" });
  assert.equal(p.support.ok, true);
  assert.equal(p.name, "Testa Tester");
  assert.equal(p.slotType, "tc_engine");
  assert.equal(p.flywheelSlot, "tc_flywheel");
  assert.equal(p.config.gearboxSlot, "tc_transmission");
  assert.deepEqual(p.config.gearboxes[6], { part: "tc_transmission_6M_race", label: "Race 6-Speed", gears: 6, transmission: "Sequential" });
  assert.deepEqual(p.config.finalDrives, [{ slot: "tc_finaldrive_F", part: "tc_finaldrive_F_race", var: "$finaldrive_F" }]);
  assert.equal(p.config.drivetrain, "FWD");
  assert.equal(p.car.mass, 1100);
  const fam = p.families.inline;
  assert.equal(fam.donorPart, "tc_engine_i4");
  assert.equal(fam.donorMass, 120);
  assert.equal(p.sources[fam.donorFile], "common");
  assert.deepEqual(fam.drop, ["tc_engine_internals"]);
  assert.equal(fam.intake.turboTemplate, "tc_turbo");
  // crank along -x, its "l" nodes on the engine's right: transverse and swapped
  assert.equal(fam.frame.orientation, "transverse");
  assert.equal(fam.frame.swapped, true);
  assert.deepEqual(fam.frame.origin, [0.3, -1.45, 0.3]);
  // the bay: the stock engine plus room up to the hood and the radiator, less 3 cm
  assert.equal(fam.bay.stock.front, 0.53);
  assert.equal(fam.bay.top, 0.57);
  assert.equal(p.familyFor.v, "inline");
});

test("an engine placed in a transverse car keeps the donor's frame", () => {
  const p = Det.detectProfile("tc", { files: TC_FILES }, Det.partIndex(TC_COMMON), {});
  const fam = p.families.inline;
  const out = X.buildEngine(D, p, [TC_COMMON[fam.donorFile]]);
  const part = parseJBeam(out.text)[out.name];
  const nodes = part.nodes.filter((r) => Array.isArray(r) && /^e[1-4][rl]$/.test(r[0])).map((r) => ({ id: r[0], p: r.slice(1, 4) }));
  const f = Det.engineFrame(nodes);
  assert.deepEqual(f.forward.map((v) => Math.round(v)), [-1, 0, 0]);
  assert.equal(f.swapped, true);
  f.origin.forEach((v, i) => assert.ok(Math.abs(v - fam.frame.origin[i]) < 1e-3));
  // the block reaches its own length towards the crank nose
  const e2 = nodes.find((n) => n.id === "e2r").p;
  assert.ok(Math.abs(0.3 - e2[0] - G.dimensions(D).length) < 1e-3);
  // and the fit is judged in the engine's own frame
  const fit = checkFit(D, p);
  assert.match(fit.checks[0].text, /crank nose|out of bay/);
  assert.equal(fit.frame.orientation, "transverse");
});

test("the BX's hand-written profile places engines exactly where it always did", () => {
  for (const layout of ["inline", "v"]) {
    const d = { ...D, layout, cylinders: layout === "v" ? 8 : 4 };
    const fam = PROFILES.bx.families[PROFILES.bx.familyFor[layout]];
    assert.deepEqual(Frame.placedBlockNodes(d, fam), G.blockNodes(d, fam.anchor));
    const flat = (parts) => parts.flatMap((part) => part.quads.flat(2));
    const a = flat(Frame.placedEngineParts(d, fam)), b = flat(engineParts(d, fam.anchor));
    assert.equal(a.length, b.length);
    a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9));
  }
  assert.deepEqual(Frame.localBay(PROFILES.bx, PROFILES.bx.families.inline), { front: 0.69, halfWidth: 0.36, top: 0.53, bottom: -0.04 });
});

test("trucks that spell their block corners en1r ... get them spelt the same way", () => {
  const spelt = Object.fromEntries(Object.entries(TC_COMMON).map(([k, v]) => [k, v.replace(/"e([1-4][rl])"/g, '"en$1"')]));
  const p = Det.detectProfile("tc", { files: TC_FILES }, Det.partIndex(spelt), {});
  assert.equal(p.support.ok, true);
  const out = X.buildEngine(D, p, [spelt[p.families.inline.donorFile]]);
  const ids = parseJBeam(out.text)[out.name].nodes.filter(Array.isArray).map((r) => r[0]);
  for (const id of ["en1r", "en2l", "en3r", "en4l"]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes("e1r"));
});

/* ---------- design locks ---------- */
import * as Lk from "../ui/lib/locks.js";

test("locks: a held displacement trades bore against stroke", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS });
  const s = Lk.setLock(d, "displacement", 2.0, {}, null);
  assert.ok(!s.error);
  assert.ok(Math.abs(E.displacement(s.d) * 1000 - 2.0) < 1e-3);
  const r = Lk.applyChange(s.d, "bore", 90, s.locks, null, { step: 0.5 });
  assert.equal(r.d.bore, 90);
  assert.ok(Math.abs(E.displacement(r.d) * 1000 - 2.0) < 1e-3 && r.d.stroke < s.d.stroke);
  // more cylinders, same litres: both shrink, the proportions stay
  const six = Lk.applyChange(r.d, "cylinders", 6, s.locks, null);
  assert.ok(Math.abs(E.displacement(six.d) * 1000 - 2.0) < 1e-3);
  assert.ok(Math.abs(six.d.bore / six.d.stroke - r.d.bore / r.d.stroke) < 1e-3);
});

test("locks: displacement and redline together leave the bore nowhere to go", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS });
  let L = Lk.setLock(d, "displacement", 2.4, {}, null);
  L = Lk.setLock(L.d, "redline", 7000, L.locks, null);
  assert.ok(!L.error, L.error);
  assert.equal(E.redline(L.d), 7000);
  const r = Lk.applyChange(L.d, "bore", L.d.bore + 3, L.locks, null, { step: 0.5 });
  assert.equal(r.d.bore, L.d.bore);
  assert.ok(r.held);
  // a stronger build gets a longer stroke at the same redline, and the bore follows the litres
  const race = Lk.applyChange(L.d, "build", "race", L.locks, null);
  assert.equal(E.redline(race.d), 7000);
  assert.ok(race.d.stroke > L.d.stroke && Math.abs(E.displacement(race.d) * 1000 - 2.4) < 1e-3);
});

test("locks: sliders stop at a mass ceiling and where knock starts", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, compression: 9.5 });
  const m = Lk.setLock(d, "mass", G.mass(d) + 5, {}, null);
  const r = Lk.applyChange(d, "bore", 105, m.locks, null, { step: 0.5 });
  assert.equal(r.held, "mass");
  assert.ok(r.d.bore > d.bore && r.d.bore < 105 && G.mass(r.d) <= G.mass(d) + 5);
  const k = Lk.setLock(d, "knock", null, {}, null);
  assert.ok(!k.error);
  const c = Lk.applyChange(k.d, "compression", 14, k.locks, null, { step: 0.1 });
  assert.equal(c.held, "knock");
  assert.ok(c.d.compression > 9.5 && c.d.compression < 14);
  assert.ok(Lk.checkMet("knock", c.d) && !Lk.checkMet("knock", { ...c.d, compression: c.d.compression + 0.2 }));
  // turning the lock on while it knocks lowers the compression to the clean ratio
  const hot = Lk.setLock({ ...d, compression: 13 }, "knock", null, {}, null);
  assert.ok(hot.d.compression < 13 && Lk.checkMet("knock", hot.d), hot.message);
});

/* ---------- direct injection and the exhaust ---------- */
test("direct injection resists knock and fills a little better", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, compression: 12.5 });
  const di = { ...d, injection: "direct" };
  assert.ok(E.knockIndex(di, 3000) < 0.9 * E.knockIndex(d, 3000));
  assert.ok(E.analyse(d).knockLost > 0 && E.analyse(di).knockLost < E.analyse(d).knockLost);
  assert.ok(E.cylinderFilling(di, 4000) > E.cylinderFilling(d, 4000));
});

test("exhaust: back pressure costs torque, more with boost; tuned headers give some back", () => {
  const d = Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS });
  const free = Exh.freeFlowing(d);
  const red = E.redline(d);
  assert.equal(Exh.backPressure(free, 5000), 0);
  assert.ok(Exh.backPressure(d, red) > 2.5 * Exh.backPressure(d, red / 2)); // about the square of the flow
  assert.ok(E.brakeTorque(d, red) < E.brakeTorque(free, red));
  const big = { ...d, pipe: 76, muffler: "straight" };
  assert.ok(E.brakeTorque(big, red) > E.brakeTorque(d, red));
  const turbo = { ...d, induction: "turbo", boost: 15, spoolRpm: 3500, compression: 8.5 };
  const costNa = E.brakeTorque(free, red) - E.brakeTorque(d, red);
  const costTurbo = E.brakeTorque(Exh.freeFlowing(turbo), red) - E.brakeTorque(turbo, red);
  assert.ok(costTurbo > 2 * costNa, `${costTurbo} vs ${costNa}`);
  const headers = { ...d, manifold: "headers", primary: 80 };
  const tuned = Exh.headerTunedRpm(headers);
  assert.ok(tuned > 4000 && tuned < 8000);
  assert.ok(E.brakeTorque(headers, tuned) > E.brakeTorque(d, tuned));
  assert.ok(Exh.headerTunedRpm({ ...headers, primary: 100 }) < tuned);
});

test("exhaust export: the part carries the exhaust's torque and its muffler's sound", () => {
  const d = { ...Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING }), name: "Loud", muffler: "none", cat: "none" };
  const out = X.buildEngine(d, testProfile, INDUCTION_DONOR);
  const parts = parseJBeam(out.text);
  assert.equal(out.exhaust, "bx_exhaust_i4_crankcase_loud");
  const ex = parts[out.exhaust];
  assert.equal(ex.slotType, "bx_exhaust_i4");
  for (const [rpm, t] of ex.mainEngine.torqueModExhaust.slice(1)) {
    if (rpm < 1000) continue;
    const want = E.brakeTorque(Ind.naturallyAspirated(d), rpm) - E.brakeTorque(Exh.freeFlowing(Ind.naturallyAspirated(d)), rpm);
    assert.ok(Math.abs(t - want) < 0.06, `${rpm}`);
  }
  const tail = ex.nodes.find((r) => Array.isArray(r) && r[0] === "ex7r")[4];
  assert.equal(tail.exhaustAudioMufflingCoef, Exh.MUFFLERS.none.sound.muffling);
  // the engine's exhaust slot defaults to it (the fixture's engine has none, so check the config instead)
  const pc = JSON.parse(VC3.buildConfig(d, testProfile, BASE_PC, out).pc);
  assert.equal(pc.parts.bx_exhaust_i4, out.exhaust);
  // the engine's own table stays free-flowing; the game sums table + exhaust part
  const me = parts[out.name].mainEngine;
  for (let rpm = 1500; rpm <= E.redline(d); rpm += 250) {
    const game = gameTorque(me, {}, rpm, ex);
    assert.ok(Math.abs(game - E.brakeTorque(d, rpm)) < 1, `${rpm}: ${game} vs ${E.brakeTorque(d, rpm)}`);
  }
  // no exhaust template: no part, and the car keeps its own
  const none = X.buildEngine(d, testProfile, DONOR);
  assert.equal(none.exhaust, null);
});

test("exhaust export: when the turbo replaces the intake that holds the exhaust slot, the turbo carries the exhaust", () => {
  // like the Piccolina: the exhaust slot hangs off the stock intake, and its turbos have none
  const donor = INDUCTION_DONOR.replace('"slotType": "bx_intake_i4_large",\n  "mainEngine": {"torqueModIntake": [["rpm", "torque"], [0, 0], [4000, 5]]},',
    '"slotType": "bx_intake_i4_large",\n  "slots2": [["name", "allowTypes", "denyTypes", "default", "description"], ["bx_exhaust_i4", ["bx_exhaust_i4"], [], "bx_exhaust_i4", "Exhaust"]],\n  "mainEngine": {"torqueModIntake": [["rpm", "torque"], [0, 0], [4000, 5]]},');
  assert.notEqual(donor, INDUCTION_DONOR);
  const d = { ...Parts.resolve({ ...D, ...Parts.DEFAULT_PARTS, ...Gear.DEFAULT_GEARING }), name: "Carried", compression: 9.5,
    induction: "turbo", turboLayout: "single", boost: 12, spoolRpm: 3800 };
  const out = X.buildEngine(d, testProfile, donor);
  assert.equal(out.exhaust, null);
  assert.equal(out.exhaustCarried, true);
  const parts = parseJBeam(out.text), ind = parts[out.induction], me = parts[out.name].mainEngine;
  assert.ok(ind.mainEngine.torqueModExhaust);
  for (let rpm = 1500; rpm <= E.redline(d); rpm += 250) {
    const game = gameTorque(me, ind, rpm, ind), want = E.brakeTorque(d, rpm);
    assert.ok(Math.abs(game - want) < 1.5, `${rpm}: game ${game.toFixed(1)}, Crankcase ${want.toFixed(1)}`);
  }
  assert.equal(JSON.parse(VC3.buildConfig(d, testProfile, BASE_PC, out).pc).parts.bx_exhaust_i4, undefined);
});
