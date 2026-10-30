// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Forced induction: turbochargers (single, parallel twin, sequential twin,
// twin-scroll), superchargers (roots, twin-screw, centrifugal) and both at once
// (twincharged), sized to the design, written as BeamNG's own devices, and
// predicted with the same sums the game runs.
//
// BeamNG's turbo (lua/vehicle/powertrain/turbocharger.lua), at full throttle:
//
//   exhaust power  P = 0.9 x (engine rpm / maxRPM) x exhaustFactor(rpm) x maxExhaustPower
//   turbine speed  steady when P = backPressureCoef x w^2 + frictionCoef
//   boost          pressurePSI(turbine rpm), held at the wastegate's target
//   torque         x (1 + 0.0000087 x boost Pa x efficiency(rpm))   (about +6% per psi)
//   response       boost rises at most pressureRatePSI psi per second
//
// BeamNG's supercharger (supercharger.lua): the blower turns at engine rpm x
// gearRatio (through a clutch that can let go above an rpm), its boost is
// pressurePSIPer1kRPM x blower rpm x a shape for its type, and it takes
// crankLossPer1kRPM x blower rpm off the torque: torque x (1 + 0.0000087 x
// boost Pa - loss). A turbo and a supercharger on one engine multiply.
//
// Curves are Catmull-Rom splines through their points, as the game draws them.
// One engine has room for one turbo device and one supercharger: a pair of
// turbos is one turbo device tuned to behave like the pair, as the game's own
// twin-turbo parts are. Boost also fills the cylinders: the engine model
// multiplies its air (and so its knock) by the boost, and takes the
// supercharger's drive off the torque.

import { volumetricEfficiency, redline } from "./engine.js";

export const INDUCTIONS = {
  none: { label: "Naturally aspirated" },
  turbo: { label: "Turbocharged" },
  supercharger: { label: "Supercharged" },
  twincharged: { label: "Twincharged" },
};

export const TURBO_LAYOUTS = {
  single: { label: "Single", note: "one turbo" },
  twin: { label: "Parallel twin", note: "two smaller turbos sharing the exhaust (one per bank on a V or a boxer): the same boost, quicker to respond" },
  sequential: { label: "Sequential twin", note: "a small turbo for early boost, a big one joining at the hand-over rpm for the top end; steady boost sags a little at the hand-over" },
  twinscroll: { label: "Twin-scroll", note: "one turbo fed by exhaust pulses kept apart in pairs of cylinders: boost builds sooner" },
};

export const SUPERCHARGERS = {
  // BeamNG's pressure shapes (b1 x r^2 + b3, r = blower rpm / its top rpm), gear ratio, drive loss per psi at redline
  roots: { label: "Roots", shape: [-0.35, 1], ratio: 1.8, lossPerPsi: 0.011, rate: 220,
    note: "lobed rotors pushing air: full boost almost from idle, but it runs out of breath and costs the most to drive at high rpm" },
  screw: { label: "Twin-screw", shape: [0.3, 0.7], ratio: 2.4, lossPerPsi: 0.009, rate: 200,
    note: "meshing screws compressing the air inside: strong everywhere, more efficient than a roots" },
  centrifugal: { label: "Centrifugal", shape: [0.6, 0.45], ratio: 3.6, lossPerPsi: 0.007, rate: 80,
    note: "a belt-driven turbo compressor: little down low, boost climbing with rpm to a big top end" },
};

export const DEFAULT_INDUCTION = {
  induction: "none", turboLayout: "single", scType: "roots",
  boost: 10, spoolRpm: 3500, handoverRpm: 4500,
};

const PSI = 6894.757293178;            // Pa
const TORQUE_PER_PASCAL = 0.0000087;   // BeamNG: 1 psi = about 6% more torque
const PER_PSI = TORQUE_PER_PASCAL * PSI;
const TURBINE_MAX_RPM = 250000;
const RPM_TO_AV = 0.10471971768;
const BACK_PRESSURE = 0.0001;          // as the BX's stock turbos
const TURBO_FRICTION = 65;
const LOW_BOOST = -2.5;                // psi at a standstill turbine: the compressor in the way
const MAP_TOP = 40;                    // psi at the turbine's top speed
const STEP = 250;                      // rpm between curve points
const TURBINE_EXPONENT = 2.2;          // turbine power against exhaust flow

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const hasTurbo = (d) => d.induction === "turbo" || d.induction === "twincharged";
export const hasSupercharger = (d) => d.induction === "supercharger" || d.induction === "twincharged";

/** A Catmull-Rom spline through [x, y] points, as BeamNG's createCurve, evaluated at x. */
export function spline(points, x) {
  const n = points.length;
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[n - 1][0]) return points[n - 1][1];
  let i = Math.min(n - 2, Math.max(0, Math.floor((x - points[0][0]) / (points[1][0] - points[0][0]))));
  while (i > 0 && x < points[i][0]) i--;
  while (i < n - 2 && x > points[i + 1][0]) i++;
  const p0 = points[Math.max(i - 1, 0)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(i + 2, n - 1)];
  const t = (x - p1[0]) / (p2[0] - p1[0]);
  const [y0, y1, y2, y3] = [p0[1], p1[1], p2[1], p3[1]];
  const c1 = 3 * (y1 - y2) + y3 - y0, c2 = 2 * y0 - 5 * y1 + 4 * y2 - y3, c3 = y2 - y0;
  return y1 + 0.5 * t * (c3 + (c1 * t + c2) * t);
}

/** The engine's maxRPM as exported (redline plus the limiter's margin): BeamNG scales exhaust power by it. */
export function engineMaxRpm(d) {
  return redline(d) + 300;
}

/** The boost the design aims for, psi (the wastegate's for a turbo, the peak for a supercharger). */
export function targetBoost(d) {
  return d.induction && d.induction !== "none" ? d.boost : 0;
}

/** Turbo size as a share of the rev range: where full boost arrives over the redline. */
export function turboSize(d, spool = d.spoolRpm) {
  return clamp(spool / redline(d), 0.15, 0.95);
}

/** Where a twincharged engine's supercharger lets go and the turbo takes over, rpm. */
function handover(d) {
  return clamp(d.handoverRpm ?? d.spoolRpm, 1500, redline(d) - 200);
}

// ---------------------------------------------------------------- caching

const cache = new Map();
const keyOf = (d) => Object.keys(d).filter((k) => k !== "name" && k !== "notes").sort().map((k) => `${k}=${d[k]}`).join("|");
function cached(kind, d, build) {
  const key = kind + "|" + keyOf(d);
  let v = cache.get(key);
  if (v === undefined) {
    if (cache.size > 200) cache.clear();
    v = build(d);
    cache.set(key, v);
  }
  return v;
}

// ---------------------------------------------------------------- turbo

/** The engine's exhaust flow per revolution relative to its best: its own VE. */
function exhaustShape(d) {
  return cached("exh", d, () => {
    const red = redline(d);
    let veMax = 0;
    for (let n = 1000; n <= red; n += 100) veMax = Math.max(veMax, volumetricEfficiency(d, n));
    return (rpm) => (rpm < 1000 ? (rpm / 1000) * volumetricEfficiency(d, 1000) : volumetricEfficiency(d, rpm)) / veMax;
  });
}

const turbineSpeedFor = (psi) => TURBINE_MAX_RPM * Math.sqrt(clamp((psi - LOW_BOOST) / (MAP_TOP - LOW_BOOST), 0, 1)) * RPM_TO_AV;
const boostForTurbine = (w) => LOW_BOOST + (MAP_TOP - LOW_BOOST) * clamp(w / (TURBINE_MAX_RPM * RPM_TO_AV), 0, 1) ** 2;

/**
 * A plain turbo's boost at full throttle, uncapped by the wastegate, for a turbo that
 * reaches `psi` at `spool` rpm: exhaust power grows with rpm x the engine's airflow.
 */
function naturalBoost(d, psi, spool, scroll = 0) {
  const x = exhaustShape(d);
  const flow = (rpm) => rpm * x(rpm) * (1 + scroll * clamp(1 - rpm / spool, 0, 1)); // twin-scroll: more energy down low
  // The turbine's power grows faster than the exhaust flow (more flow also means more pressure
  // to expand from), roughly with its square: so boost stays low, then arrives over a few
  // hundred rpm, as real turbos (and the game's stock ones) do.
  const need = BACK_PRESSURE * turbineSpeedFor(psi) ** 2 + TURBO_FRICTION;
  const atSpool = flow(spool);
  return (rpm) => {
    const p = need * (flow(rpm) / atSpool) ** TURBINE_EXPONENT - TURBO_FRICTION;
    return boostForTurbine(Math.sqrt(Math.max(p, 0) / BACK_PRESSURE));
  };
}

/** Compressor efficiency, best around 1.5x its full-boost rpm: small turbos choke up top, big ones are lazy down low. */
function compressorEfficiency(d, spool) {
  const sweet = Math.min(spool * 1.5, redline(d));
  return (rpm) => (rpm < 650 ? 0.1 : clamp(0.98 - 0.35 * Math.log(rpm / sweet) ** 2, 0.4, 0.98));
}

/** Boost response, psi/s, for a turbo of a size (share of the rev range): 100 on a tiny one, 10 on a huge one. */
const riseRate = (size) => 10 + 90 * clamp((0.75 - size) / 0.5, 0, 1) ** 1.5;

/**
 * The turbo for a design, in BeamNG's terms. Each layout is a boost curve (what the
 * turbo or turbos would make, before the wastegate), an efficiency curve and a
 * response; the turbo device is then given the exhaust curve that makes exactly
 * that boost from the game's sums.
 */
export function turboSpec(d) {
  return cached("turbo", d, buildTurboSpec);
}

function buildTurboSpec(d) {
  const red = redline(d), maxRpm = engineMaxRpm(d);
  const target = d.boost;
  const layout = d.induction !== "twincharged" && TURBO_LAYOUTS[d.turboLayout] ? d.turboLayout : "single";
  // a twincharged engine's turbo takes over from the supercharger: full boost at the hand-over
  const spool = d.induction === "twincharged" ? handover(d) : clamp(d.spoolRpm, 1200, red);
  let boost, efficiency, rate;
  if (layout === "sequential") {
    const h = clamp(d.handoverRpm ?? spool + 1500, spool + 500, red);
    const small = naturalBoost(d, target, spool), big = naturalBoost(d, target, h * 0.93); // the big one is pre-spooled to be at full boost by the hand-over
    const effSmall = compressorEfficiency(d, spool), effBig = compressorEfficiency(d, h);
    // the hand-over: with the transfer valves timed well, steady full-throttle boost only sags a
    // little (about 5%) as the big turbo comes in; the bigger step is a transient one, when the
    // revs climb through it quickly, and the game's single boost-rate limit can't show that
    boost = (rpm) => {
      const w = clamp((rpm - (h - 600)) / 600, 0, 1);
      const sag = 0.05 * target * Math.exp(-(((rpm - h) / 300) ** 2));
      return Math.min(small(rpm), target + 3) * (1 - w) + big(rpm) * w - sag;
    };
    efficiency = (rpm) => { const w = clamp((rpm - (h - 400)) / 800, 0, 1); return effSmall(rpm) * (1 - w) + effBig(rpm) * w; };
    rate = riseRate(turboSize(d, spool)) * 1.2;
  } else {
    const scroll = layout === "twinscroll" ? 0.3 : 0;
    boost = naturalBoost(d, target, spool, scroll);
    efficiency = compressorEfficiency(d, spool);
    rate = riseRate(turboSize(d, spool)) * (layout === "twin" ? 1.6 : layout === "twinscroll" ? 1.25 : 1);
  }
  if (d.induction === "twincharged") {
    // while the supercharger is still pushing, the turbo only tops it up to the design's boost
    // (the game multiplies the two): no more exhaust than that reaches its turbine
    const natural = boost, sc = superchargerSpec(d);
    boost = (rpm) => {
      const s = 1 + PER_PSI * superchargerBoost(d, rpm, sc);
      const want = ((1 + PER_PSI * target) / s - 1) / (PER_PSI * Math.max(efficiency(rpm), 0.3));
      return Math.min(natural(rpm), Math.max(want, LOW_BOOST));
    };
  }
  // Exhaust curve that makes that boost in the game: the turbine speed each boost needs,
  // the exhaust power that holds it there, as a share of the most the curve calls for.
  const points = [];
  for (let rpm = 0; rpm <= maxRpm + 500; rpm += STEP) points.push(rpm);
  const need = points.map((rpm) => {
    if (rpm === 0) return 0;
    const psi = Math.min(boost(Math.min(rpm, maxRpm)), MAP_TOP - 0.5);
    return (BACK_PRESSURE * turbineSpeedFor(psi) ** 2 + TURBO_FRICTION) / (0.9 * (rpm / maxRpm));
  });
  const maxExhaustPower = Math.max(...need.slice(4)); // from 1,000 rpm
  const engineDef = points.map((rpm, i) => [rpm, +efficiency(rpm).toFixed(3), +clamp(need[i] / maxExhaustPower, 0, 1).toFixed(4)]);
  const size = turboSize(d, spool);
  return {
    pressurePSI: Array.from({ length: 11 }, (_, i) => [i * 25000, +boostForTurbine(i * 25000 * RPM_TO_AV).toFixed(2)]),
    engineDef,
    effCurve: engineDef.map((p) => [p[0], p[1]]),
    exhCurve: engineDef.map((p) => [p[0], p[2]]),
    maxExhaustPower: Math.round(maxExhaustPower),
    backPressureCoef: BACK_PRESSURE,
    frictionCoef: TURBO_FRICTION,
    pressureRatePSI: Math.round(Math.min(rate, 160)),
    inertia: +((2 + 14 * size) * (layout === "twin" ? 0.5 : 1)).toFixed(1),
    turboSizeCoef: +(0.6 + 0.6 * size).toFixed(2),
    // the wastegate opens 0.5 psi under the boost and is fully open 0.5 psi over: BeamNG aims at the middle
    wastegateStart: +(target - 0.5).toFixed(1),
    wastegateRange: 1,
    layout, spool,
  };
}

/** Steady turbo boost at full throttle, psi: BeamNG's own estimate (the one behind its power graph). */
export function turboBoost(d, rpm, spec = turboSpec(d)) {
  if (!hasTurbo(d)) return 0;
  const x = Math.min(1, spline(spec.exhCurve, rpm));
  const power = 0.9 * (rpm / engineMaxRpm(d)) * x * spec.maxExhaustPower - spec.frictionCoef;
  const w = Math.min(Math.sqrt(Math.max(power, 0) / spec.backPressureCoef), TURBINE_MAX_RPM * RPM_TO_AV);
  const pressure = spline(spec.pressurePSI, Math.floor(w * 9.5493));
  return Math.min(pressure, spec.wastegateStart + spec.wastegateRange / 2);
}

/** The turbo's efficiency at an engine rpm (how much of its boost becomes torque). */
export function boostEfficiency(d, rpm, spec = turboSpec(d)) {
  return hasTurbo(d) ? spline(spec.effCurve, rpm) : 1;
}

// ---------------------------------------------------------------- supercharger

/** The supercharger for a design, in BeamNG's terms. */
export function superchargerSpec(d) {
  return cached("sc", d, buildSuperchargerSpec);
}

function buildSuperchargerSpec(d) {
  const type = SUPERCHARGERS[d.scType] ? d.scType : "roots";
  const t = SUPERCHARGERS[type];
  const red = redline(d), maxRpm = engineMaxRpm(d);
  const maxBlower = Math.ceil(maxRpm * t.ratio);
  // twincharged: the supercharger's clutch starts letting go at 65% of the hand-over and is
  // out by the hand-over, while the turbo (full boost at the hand-over) takes its place
  const twin = d.induction === "twincharged";
  const h = handover(d);
  const s = {
    type, label: t.label,
    beamType: type === "screw" ? "screws" : type,
    gearRatio: t.ratio,
    maxBlower,
    shape: t.shape,
    pressureRatePSI: t.rate,
    clutchEngageRPM: 0,
    clutchDisengageRPM: twin ? Math.round(h * 0.65) : null,
    clutchDisengageRange: twin ? Math.round(h * 0.35) : null,
  };
  // boost per 1,000 blower rpm so its peak below redline is the design's boost
  let peak = 0;
  for (let rpm = 500; rpm <= red; rpm += 25) {
    const blower = rpm * t.ratio * scClutch(d, rpm, s), r = blower / maxBlower;
    peak = Math.max(peak, (t.shape[0] * r * r + t.shape[1]) * blower / 1000);
  }
  s.pressurePSIPer1kRPM = +(d.boost / peak).toFixed(4);
  // the drive costs about lossPerPsi x boost of the torque at redline (on its own)
  s.crankLossPer1kRPM = +(t.lossPerPsi * d.boost / (red * t.ratio) * 1000).toFixed(5);
  return s;
}

/** Clutch engagement of the supercharger's drive at an engine rpm (BeamNG's ramp). */
function scClutch(d, rpm, s) {
  if (!s.clutchDisengageRPM) return 1;
  return clamp(-(rpm - s.clutchDisengageRPM) / s.clutchDisengageRange + 1, 0, 1);
}

/** Supercharger boost at full throttle, psi. */
export function superchargerBoost(d, rpm, s = superchargerSpec(d)) {
  if (!hasSupercharger(d)) return 0;
  const blower = rpm * s.gearRatio * scClutch(d, rpm, s);
  const r = blower / s.maxBlower;
  return Math.max((s.shape[0] * r * r + s.shape[1]) * s.pressurePSIPer1kRPM * 0.001 * blower, 0);
}

/** Share of the torque spent driving the supercharger at an engine rpm. */
export function superchargerLoss(d, rpm, s = superchargerSpec(d)) {
  if (!hasSupercharger(d)) return 0;
  return s.crankLossPer1kRPM * 0.001 * rpm * s.gearRatio * scClutch(d, rpm, s);
}

// ---------------------------------------------------------------- the engine sees

/** Total boost at full throttle, psi (what a gauge in the manifold would read). */
export function steadyBoost(d, rpm) {
  if (!d.induction || d.induction === "none") return 0;
  const t = hasTurbo(d) ? turboBoost(d, rpm) : 0;
  const s = hasSupercharger(d) ? superchargerBoost(d, rpm) : 0;
  // in series the pressure ratios multiply
  return ((1 + t / 14.696) * (1 + s / 14.696) - 1) * 14.696;
}

/**
 * How much more air the cylinders get than without boost, at full throttle: BeamNG's
 * torque multiplier before the supercharger's drive. 1 without forced induction.
 */
export function chargeFactor(d, rpm) {
  if (!d.induction || d.induction === "none") return 1;
  const t = hasTurbo(d) ? 1 + PER_PSI * turboBoost(d, rpm) * boostEfficiency(d, rpm) : 1;
  const s = hasSupercharger(d) ? 1 + PER_PSI * superchargerBoost(d, rpm) : 1;
  return t * s;
}

/** The turbo's own torque multiplier (1 without one): the supercharger's drive loss is scaled by it in the game. */
export function turboFactor(d, rpm) {
  return hasTurbo(d) ? 1 + PER_PSI * turboBoost(d, rpm) * boostEfficiency(d, rpm) : 1;
}

/** The rpm where the boost first reaches (within 0.3 psi of) its target, or null. */
export function fullBoostRpm(d) {
  if (!d.induction || d.induction === "none") return null;
  for (let rpm = 1000; rpm <= redline(d); rpm += 25) {
    if (steadyBoost(d, rpm) >= targetBoost(d) - 0.3) return rpm;
  }
  return null;
}

/** Seconds for the boost to build from nothing to full once the revs allow it. */
export function boostRiseTime(d) {
  if (hasTurbo(d) && d.induction === "turbo") return targetBoost(d) / turboSpec(d).pressureRatePSI;
  if (hasSupercharger(d)) return targetBoost(d) / superchargerSpec(d).pressureRatePSI;
  return 0;
}

/** The same design without forced induction. */
export function naturallyAspirated(d) {
  return { ...d, induction: "none" };
}

/** A short description of the induction, for labels. */
export function inductionLabel(d) {
  if (!d.induction || d.induction === "none") return "naturally aspirated";
  const layout = d.induction === "twincharged" ? TURBO_LAYOUTS.single : TURBO_LAYOUTS[d.turboLayout] ?? TURBO_LAYOUTS.single;
  const turbo = `${layout.label.toLowerCase()} turbo`;
  const sc = `${(SUPERCHARGERS[d.scType] ?? SUPERCHARGERS.roots).label.toLowerCase()} supercharger`;
  return d.induction === "turbo" ? turbo : d.induction === "supercharger" ? sc : `${sc} and ${turbo}`;
}
