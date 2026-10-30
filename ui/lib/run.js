// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Comparing a recorded run (a MoTeC log from Beamlog) with the design.
//
// Only what belongs to the engine and gearbox is compared: the full-throttle
// torque curve, and engine speed against road speed in each gear. Everything
// that depends on the rest of the car (tyres, aero, exhaust, mass, set up in
// BeamNG) is shown as measured, not checked against a model.

import { brakeTorque, redline } from "./engine.js";
import { totalInertia } from "./rotating.js";
import { ratios, rpmAt } from "./gearing.js";
import { slug } from "./export.js";

const FULL_THROTTLE = 98; // %
const BIN = 250;          // rpm
const MIN_SAMPLES = 8;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** The channels used here, as plain arrays (missing ones are null). */
function channels(run) {
  const get = (n) => run.channels.get(n)?.data || null;
  const speed = get("Ground Speed");
  if (!speed) throw new Error("the run has no Ground Speed channel");
  return {
    rate: run.channels.get("Ground Speed").rate,
    speed, wheel: get("Drive Wheel Speed"), rpm: get("Engine RPM"), gear: get("Gear"), throttle: get("Throttle Pos"),
    clutch: get("Clutch Pos"), torque: get("Engine Torque"),
    water: get("Water Temp"), oil: get("Oil Temp"),
  };
}

/**
 * The driven wheels' angular speed (rad/s) per sample: the two wheels that turn
 * fastest under power (they slip a little forward; free wheels don't), or null.
 */
function drivenWheelSpeed(run, c) {
  const wheels = [...run.channels.keys()].filter((k) => k.startsWith("Wheel Angular Speed "));
  if (wheels.length < 2) return null;
  const data = wheels.map((k) => run.channels.get(k).data);
  const pull = (w) => {
    const xs = [];
    for (let i = 0; i < w.length; i++) if (c.throttle && c.throttle[i] > 50 && c.speed[i] > 20) xs.push(w[i]);
    return median(xs) ?? 0;
  };
  const order = data.map((w, i) => [pull(w), i]).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, i]) => data[i]);
  return order[0].map((v, i) => (v + order[1][i]) / 2);
}

/** Does the run come from this design's exported config? */
export function matchesDesign(run, d) {
  return run.vehicle.includes(`crankcase_${slug(d.name)}`);
}

/**
 * analyseRun(run, design) →
 *   torque: [{ rpm, logged, design, n }]   full throttle, clutch in, by 250 rpm
 *   gears: [{ gear, rpmPer100, design, ratio, designRatio, n }]
 *                                          engine rpm at 100 km/h, and the overall ratio
 *   points: [{ gear, kmh, rpm }]            for plotting rpm against speed
 *   shifts: [{ from, to, left, landed, kmh }]
 *   summary: { duration, topSpeed, topRpm, topGear, zeroTo100, water, oil }
 */
export function analyseRun(run, d, laps = []) {
  const c = channels(run);
  const n = c.speed.length, dt = 1 / c.rate;
  const out = { torque: [], gears: [], points: [], shifts: [], summary: {}, laps, matches: matchesDesign(run, d) };

  // Full-throttle torque. The logged torque is what leaves the engine through the clutch:
  // while the revs climb, part of the engine's torque goes into spinning up its own crank
  // and flywheel, so that share (inertia x angular acceleration) is added back. Samples where
  // the clutch slips (engine speed running away from the driven wheels) or the rev limiter
  // cuts are left out.
  if (c.torque && c.rpm && c.throttle) {
    const inertia = totalInertia(d);
    const av = drivenWheelSpeed(run, c);
    const limiter = redline(d) - 150;
    // the clutch is locked when engine speed / wheel speed sits at its gear's usual ratio
    const usual = new Map();
    if (av && c.gear) {
      const per = new Map();
      for (let i = 0; i < n; i++) if (c.gear[i] > 0 && av[i] > 5 && c.throttle[i] > 50) {
        if (!per.has(c.gear[i])) per.set(c.gear[i], []);
        per.get(c.gear[i]).push((c.rpm[i] * Math.PI / 30) / av[i]);
      }
      for (const [g, xs] of per) usual.set(g, median(xs));
    }
    const k = Math.max(1, Math.round(0.06 * c.rate)); // ±60 ms for the acceleration and cut checks
    const bins = new Map();
    for (let i = k; i < n - k; i++) {
      if (c.throttle[i] < FULL_THROTTLE || (c.clutch && c.clutch[i] > 2) || (c.gear && c.gear[i] < 1)) continue;
      if (c.rpm[i] > limiter) continue;
      if (av && c.gear && usual.has(c.gear[i]) && av[i] > 5) {
        const r = (c.rpm[i] * Math.PI / 30) / av[i] / usual.get(c.gear[i]);
        if (Math.abs(r - 1) > 0.02) continue;
      }
      let cut = false;
      for (let j = i - k; j <= i + k; j++) if (c.torque[j] < 0.5 * c.torque[i]) cut = true;
      if (cut) continue;
      const alpha = ((c.rpm[i + k] - c.rpm[i - k]) * Math.PI / 30) / (2 * k * dt);
      const b = Math.round(c.rpm[i] / BIN) * BIN;
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b).push(c.torque[i] + inertia * alpha);
    }
    out.torque = [...bins.entries()]
      .filter(([, v]) => v.length >= MIN_SAMPLES)
      .sort((a, b) => a[0] - b[0])
      .map(([rpm, v]) => ({ rpm, logged: median(v), design: brakeTorque(d, rpm), n: v.length }));
  }

  // engine speed against road speed, per gear, and the overall ratio (engine speed
  // over driven-wheel speed), which doesn't depend on the tyres or on slip
  if (c.rpm && c.gear) {
    const av = drivenWheelSpeed(run, c);
    const per = new Map(), ratio = new Map();
    const step = Math.max(1, Math.round(n / 3000));
    for (let i = 0; i < n; i++) {
      const g = Math.round(c.gear[i]), kmh = c.speed[i];
      if (g < 1 || kmh < 15 || (c.clutch && c.clutch[i] > 2)) continue;
      if (!per.has(g)) per.set(g, []);
      per.get(g).push((c.rpm[i] / kmh) * 100);
      if (av && av[i] > 5) {
        if (!ratio.has(g)) ratio.set(g, []);
        ratio.get(g).push((c.rpm[i] * Math.PI) / 30 / av[i]);
      }
      if (i % step === 0) out.points.push({ gear: g, kmh, rpm: c.rpm[i] });
    }
    const rs = ratios(d);
    out.gears = [...per.entries()].sort((a, b) => a[0] - b[0]).map(([gear, v]) => ({
      gear, rpmPer100: median(v), n: v.length,
      design: gear <= rs.length ? rpmAt(d, 100, rs[gear - 1]) : null,
      ratio: ratio.has(gear) ? median(ratio.get(gear)) : null,
      designRatio: gear <= rs.length ? rs[gear - 1] * d.finalDrive : null,
    }));
  }

  // upshifts, through neutral or not: last sample in the old gear, and 0.3 s into the new one
  if (c.rpm && c.gear) {
    let last = null;
    for (let i = 0; i < n; i++) {
      const g = Math.round(c.gear[i]);
      if (g < 1) continue;
      if (last && g > last.g) {
        const j = Math.min(n - 1, i + Math.round(0.3 / dt));
        out.shifts.push({ from: last.g, to: g, left: c.rpm[last.i], landed: c.rpm[j], kmh: c.speed[last.i] });
      }
      last = { g, i };
    }
  }

  // what the car did
  let top = 0;
  for (let i = 1; i < n; i++) if (c.speed[i] > c.speed[top]) top = i;
  let zeroTo100 = null, from = null;
  for (let i = 0; i < n; i++) {
    if (c.speed[i] < 2) from = i;
    else if (c.speed[i] >= 100 && from !== null) {
      const t = (i - from) * dt;
      if (zeroTo100 === null || t < zeroTo100) zeroTo100 = t;
      from = null;
    }
  }
  const max = (xs) => (xs ? xs.reduce((a, b) => Math.max(a, b), -Infinity) : null);
  out.summary = {
    duration: n * dt, topSpeed: c.speed[top], topRpm: c.rpm?.[top] ?? null, topGear: c.gear ? Math.round(c.gear[top]) : null,
    zeroTo100, water: max(c.water), oil: max(c.oil),
  };
  return out;
}
