// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Gearing: how the engine's torque curve turns into push at the road.
//
//   road speed  = engine rpm / (gear x final drive) x tire circumference
//   wheel force = engine torque x gear x final drive x driveline efficiency / tire radius
//   resistance  = aero drag (1/2 rho CdA v^2) + rolling resistance (Crr m g)
//
// The ideal gearbox would hold the engine at peak power at every speed:
// force = peak power / speed. Real gears leave gaps below that line; how much
// of it they cover is a measure of how well the gearing suits the engine.

import { brakeTorque, redline, analyse } from "./engine.js";
import { totalInertia, equivalentMass } from "./rotating.js";

export const AIR_DENSITY = 1.2;
export const GRAVITY = 9.81;
export const DRIVELINE_EFFICIENCY = 0.88;
export const SHIFT_TIME = 0.3; // s without drive while changing gear, for a quick shift

/** How fast the driver shifts: clutch in to clutch biting in the next gear, s. */
export const SHIFT_STYLES = {
  relaxed: { label: "Relaxed", time: 0.8, note: "everyday driving: unhurried, letting the clutch out gently" },
  brisk: { label: "Brisk", time: 0.5, note: "a good driver in a hurry on the road" },
  quick: { label: "Quick", time: SHIFT_TIME, note: "hard, fast shifts, as on a track or a rally stage" },
  sequential: { label: "Sequential", time: 0.1, note: "a sequential race box, shifting with barely a lift" },
};

/** The design's shift time, s. */
export function shiftTime(d) {
  return (SHIFT_STYLES[d.shift] ?? SHIFT_STYLES.quick).time;
}

/** Tire sizes offered (width / aspect R rim), all available on the BX. */
export const TIRES = ["185/70R14", "195/60R15", "205/60R15", "215/65R15", "225/50R15", "225/45R16", "235/55R16", "245/40R17", "245/35R17"];

export const DEFAULT_GEARING = {
  gearCount: 5,
  gear1: 3.32, gear2: 1.9, gear3: 1.31, gear4: 1.0, gear5: 0.84, gear6: 0.7,
  finalDrive: 4.08,
  tire: "195/60R15",
  shift: "quick",
};

/** Tire radius in metres from its size code. */
export function tireRadius(code) {
  const m = /^(\d+)\/(\d+)R(\d+)$/.exec(code);
  if (!m) return 0.305;
  const [, w, a, rim] = m.map(Number);
  return (rim * 25.4) / 2000 + (w * a) / 100 / 1000;
}

export function ratios(d) {
  return Array.from({ length: d.gearCount }, (_, i) => d[`gear${i + 1}`]);
}

/** km/h at an engine rpm in a gear ratio. */
export function speedAt(d, rpm, ratio) {
  return (rpm / 60 / (ratio * d.finalDrive)) * 2 * Math.PI * tireRadius(d.tire) * 3.6;
}

/** Engine rpm at a road speed (km/h) in a gear ratio. */
export function rpmAt(d, kmh, ratio) {
  return (kmh / 3.6 / (2 * Math.PI * tireRadius(d.tire))) * 60 * ratio * d.finalDrive;
}

/** Driving force at the tires (N) in a gear at a speed, or null outside the engine's range. */
export function wheelForce(d, kmh, ratio, { slipFirst = false } = {}) {
  const rpm = rpmAt(d, kmh, ratio);
  if (rpm > redline(d)) return null;
  if (rpm < 1000 && !slipFirst) return null;
  const t = Math.max(0, brakeTorque(d, Math.max(rpm, 1000)));
  return (t * ratio * d.finalDrive * DRIVELINE_EFFICIENCY) / tireRadius(d.tire);
}

/** Aero and rolling resistance (N) at a speed for a car { mass, cda, crr }. */
export function resistance(car, kmh) {
  const v = kmh / 3.6;
  return 0.5 * AIR_DENSITY * car.cda * v * v + car.crr * car.mass * GRAVITY;
}

/**
 * Everything the gearing section shows, for a design on a car.
 * car: { mass (kg), cda (m^2), crr, grip (tire friction x share of weight on the driven wheels) }
 */
export function analyseGearing(d, car) {
  const rs = ratios(d), red = redline(d);
  const a = analyse(d, 50);
  const peakPower = a.peakPower * 1000;
  const maxSpeed = Math.ceil(speedAt(d, red, rs[rs.length - 1]) / 10) * 10 + 10;
  const speeds = [];
  for (let v = 0; v <= maxSpeed; v += 1) speeds.push(v);

  const force = rs.map((r, i) => speeds.map((v) => {
    const f = wheelForce(d, v, r, { slipFirst: i === 0 });
    return f == null ? null : f / 1000;
  }));
  const resist = speeds.map((v) => resistance(car, v) / 1000);
  const ideal = speeds.map((v) => (v < 5 ? null : (peakPower * DRIVELINE_EFFICIENCY) / (v / 3.6) / 1000));
  const best = speeds.map((_, k) => Math.max(0, ...force.map((g) => g[k] ?? 0)));

  // top speed: the highest speed where some gear still out-pushes the resistance
  let top = 0, topGear = 0;
  speeds.forEach((v, k) => force.forEach((g, i) => { if (g[k] != null && g[k] >= resist[k] && v > top) { top = v; topGear = i; } }));
  const atRedline = speedAt(d, red, rs[topGear]);
  const limitedBy = top >= atRedline - 1.5 ? "redline" : "drag";
  const topRpm = rpmAt(d, top, rs[topGear]);

  // the rpm each shift lands on when shifting at redline
  const shifts = rs.slice(0, -1).map((r, i) => {
    const rpm = (red * rs[i + 1]) / r;
    const k = a.rpm.findIndex((x) => x >= rpm);
    return { from: i + 1, to: i + 2, rpm, powerShare: k >= 0 ? a.power[k] / a.peakPower : 0 };
  });

  // how much of the ideal (constant peak power) line the gears cover, 20 km/h to top speed
  let got = 0, want = 0;
  speeds.forEach((v, k) => { if (v >= 20 && v <= top && ideal[k]) { got += Math.min(best[k], ideal[k]); want += ideal[k]; } });

  // the engine's rotating inertia, felt at the wheels as extra mass in each gear
  const I = totalInertia(d), radius = tireRadius(d.tire);
  const inertiaMass = rs.map((r) => equivalentMass(I, r * d.finalDrive, radius));

  // 0-100 km/h: best gear at each speed, limited by grip, minus resistance, with shift pauses.
  // Mass: the car, about 3% for its wheels and driveline, and the engine's inertia in that gear.
  const traction = car.grip * car.mass * GRAVITY;
  let v = 0, t = 0, gear = 0;
  const dt = 0.01;
  while (v < 100 / 3.6 && t < 60) {
    const kmh = v * 3.6;
    let g = gear;
    while (g < rs.length - 1 && rpmAt(d, kmh, rs[g]) >= red - 1) g++;
    if (g !== gear) { t += shiftTime(d); gear = g; }
    const f = Math.min(traction, wheelForce(d, kmh, rs[gear], { slipFirst: gear === 0 }) ?? 0);
    const acc = (f - resistance(car, kmh)) / (car.mass * 1.03 + inertiaMass[gear]);
    if (acc <= 0) { t = Infinity; break; }
    v += acc * dt; t += dt;
  }

  return {
    speeds, force, resist, ideal, best, rs,
    top, topGear: topGear + 1, topRpm, limitedBy, atRedline,
    shifts, coverage: want ? got / want : 0, inertiaMass,
    zeroTo100: t,
    rpmAt100Top: rpmAt(d, 100, rs[rs.length - 1]),
    peakPowerRpm: a.peakPowerRpm, redline: red,
  };
}

/* ---------- ratio helpers: the arithmetic behind choosing gears ---------- */

// the range the gear and final-drive sliders allow (the game's own limits)
export const GEAR_LIMITS = [0.5, 5];
export const FINAL_LIMITS = [2, 6];
const r2 = (v) => Math.round(v * 100) / 100;
const outside = (v, [lo, hi]) => v < lo - 1e-9 || v > hi + 1e-9;

/**
 * Fill the gears between 1st and top. "even": every step the same,
 * step = (top / 1st)^(1 / (gears - 1)). "progressive": the same overall spread,
 * but the steps shrink going up (the first about 25% wider than even, in log terms,
 * the last about 25% tighter), so the top gears sit closer together.
 * Returns { changes } or { error }.
 */
export function spreadGears(d, mode = "even", progression = 0.25) {
  const n = d.gearCount, first = d.gear1, top = d[`gear${n}`];
  if (n < 3) return { error: "Needs at least three gears." };
  if (!(first > top)) return { error: "1st must be shorter (a bigger number) than the top gear." };
  const total = Math.log(first / top), mean = total / (n - 1);
  const changes = {};
  let g = first;
  for (let i = 0; i < n - 2; i++) {
    const w = mode === "progressive" ? 1 + progression * (1 - (2 * i) / (n - 2)) : 1;
    g = g / Math.exp(mean * w);
    changes[`gear${i + 2}`] = r2(g);
  }
  return { changes };
}

/** The steps between gears (next / current), for showing. */
export function steps(d) {
  const rs = ratios(d);
  return rs.slice(1).map((r, i) => r / rs[i]);
}

/**
 * Move ratio between the gearbox and the final drive without changing the car:
 * every gear x k, final drive / k, with k chosen so the top gear becomes `top`.
 */
export function rebase(d, top) {
  const n = d.gearCount, k = top / d[`gear${n}`];
  const changes = { finalDrive: r2(d.finalDrive / k) };
  for (let i = 1; i <= n; i++) changes[`gear${i}`] = r2(d[`gear${i}`] * k);
  if (outside(changes.finalDrive, FINAL_LIMITS)) {
    return { error: `That needs a final drive of ${changes.finalDrive.toFixed(2)}; it has to be between ${FINAL_LIMITS[0]} and ${FINAL_LIMITS[1]}.` };
  }
  const bad = Object.entries(changes).find(([key, v]) => key !== "finalDrive" && outside(v, GEAR_LIMITS));
  if (bad) return { error: `That makes ${bad[0].replace("gear", "gear ")} ${bad[1].toFixed(2)}; gears have to be between ${GEAR_LIMITS[0]} and ${GEAR_LIMITS[1]}.` };
  return { changes };
}

/**
 * The gear ratio that puts the engine at `rpm` at `kmh`:
 * overall = rpm x tire circumference x 0.06 / kmh, gear = overall / final drive.
 */
export function gearForSpeed(d, rpm, kmh) {
  if (!(rpm > 0 && kmh > 0)) return { error: "Enter an rpm and a speed." };
  const overall = (rpm * 2 * Math.PI * tireRadius(d.tire) * 0.06) / kmh;
  const gear = overall / d.finalDrive;
  if (outside(r2(gear), GEAR_LIMITS)) {
    return { error: `That needs a gear of ${gear.toFixed(2)} with this final drive (overall ${overall.toFixed(2)}); ` +
      `gears go from ${GEAR_LIMITS[0]} to ${GEAR_LIMITS[1]}. Change the final drive first.`, overall, gear };
  }
  return { gear: r2(gear), overall };
}
