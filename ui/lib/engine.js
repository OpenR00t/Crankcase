// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// The engine model. Deliberately simple and readable: every step is a
// textbook relationship, so the numbers can be followed by hand.
//
//   air in   = displacement x volumetric efficiency x air density
//   work out = fuel energy (air / AFR x LHV) x indicated efficiency
//   torque   = work per cycle / 4 pi            (4-stroke: one cycle per 2 revs)
//   brake    = indicated torque - friction torque
//
// Units: SI inside (m, m^3, Pa, J, N m, rad/s); mm, litres, kPa and kW at the edges.

export const AIR_DENSITY = 1.18;        // kg/m^3, sea level at ~25 C
export const FUEL_LHV = 44e6;           // J/kg, petrol lower heating value
export const AFR_POWER = 12.8;          // air/fuel ratio at full throttle (rich for power)
export const GAMMA_EFF = 1.3;           // effective ratio of specific heats in a real cycle
export const REAL_CYCLE_FACTOR = 0.78;  // share of ideal Otto efficiency a real engine reaches

/** Rotating-assembly builds: how fast the pistons may travel on average. */
export const BUILDS = {
  road:  { label: "Road",  maxPistonSpeed: 19.0, inertiaScale: 1.10, durability: 1.15 },
  sport: { label: "Sport", maxPistonSpeed: 21.5, inertiaScale: 1.00, durability: 1.00 },
  race:  { label: "Race",  maxPistonSpeed: 24.0, inertiaScale: 0.85, durability: 0.85 },
};

/**
 * Fuels and the knock index each can take before the ECU has to pull timing.
 * Octane is the US pump rating (AKI). Calibrated so a typical 10.5:1 road
 * engine runs clean on 87, and so the limits rise about as real compression
 * allowances do with octane.
 */
export const FUELS = {
  "87":   { label: "87 regular", limit: 9.9 },
  "91":   { label: "91 premium", limit: 10.6 },
  "93":   { label: "93 premium", limit: 11.0 },
  "100":  { label: "100 race fuel", limit: 12.0 },
  "e85":  { label: "E85 ethanol", limit: 13.0 },
};

/** Highest redline the export supports (the BeamNG base table it scales ends at 9500 rpm). */
export const MAX_REDLINE = 9000;

export const DEFAULT_DESIGN = {
  name: "My first engine",
  layout: "inline",  // inline, flat or v (see geometry.js)
  cylinders: 4,
  bore: 87,          // mm
  stroke: 100,       // mm
  build: "sport",
  compression: 10.5, // Compression section
  fuel: "91",        // pump octane (AKI), see FUELS
  cam: 0.3,          // 0 = mild road cam, 1 = wild race cam
  tuneRpm: 4500,     // rpm the intake runners are tuned for
  friction: 0.3,     // 0 = durable (thick rings, big bearings), 1 = low-friction race build
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Swept volume of all cylinders, m^3. */
export function displacement(d) {
  const b = d.bore / 1000, s = d.stroke / 1000;
  return d.cylinders * (Math.PI / 4) * b * b * s;
}

/** Mean piston speed, m/s: the piston covers 2 strokes per revolution. */
export function pistonSpeed(d, rpm) {
  return (2 * (d.stroke / 1000) * rpm) / 60;
}

/** Redline from the build's piston-speed limit, rounded down to 50 rpm. */
export function redline(d) {
  const limit = BUILDS[d.build].maxPistonSpeed;
  const rpm = (limit * 60) / (2 * (d.stroke / 1000));
  return Math.min(MAX_REDLINE, Math.floor(rpm / 50) * 50);
}

/** Rough intake runner length for a tuned rpm (rule of thumb, not a wave model). */
export function runnerLength(tuneRpm) {
  return 2100 / tuneRpm; // m: ~0.35 m for 6000 rpm, ~0.6 m for 3500 rpm
}

/**
 * How freely the valves flow at high piston speed: more lift helps, up to the
 * point where the valve is fully out of its own way (about 0.27 of a valve
 * diameter, with intake valves about 0.45 of the bore). 1 = a typical road cam.
 */
export function valveFlow(d) {
  if (d.lift == null) return 1;
  const useful = 0.27 * 0.45 * d.bore;
  return clamp(Math.sqrt(Math.min(d.lift, useful * 1.15) / useful), 0.85, 1.12);
}

/** The rpm where the cam alone breathes best. */
export function camPeakRpm(d) {
  return 3500 + d.cam * 4000;
}

/**
 * Volumetric efficiency: how full each cylinder gets compared with its
 * swept volume at ambient density. Three effects multiplied together:
 *  - the cam: best at its own rpm, falling away either side (a bigger cam
 *    peaks higher and fills better there, but falls off harder down low,
 *    where long overlap pushes charge back out),
 *  - intake tuning: a pressure-wave bump around the tuned rpm,
 *  - flow choke: at high piston speed the valves can't pass air fast enough.
 */
export function volumetricEfficiency(d, rpm) {
  const a = d.cam;
  const nCam = camPeakRpm(d);
  const peak = 0.86 + 0.14 * a;
  let ve;
  if (rpm < nCam) {
    const x = (nCam - rpm) / nCam;
    ve = peak - (0.18 + 0.6 * a) * x * x;
  } else {
    const x = (rpm - nCam) / nCam;
    ve = peak - (0.45 - 0.2 * a) * x * x;
  }
  const t = (rpm - d.tuneRpm) / (0.2 * d.tuneRpm);
  ve += 0.07 * Math.exp(-t * t);
  const vp = pistonSpeed(d, rpm);
  ve *= 1 / (1 + Math.pow(vp / (30 * valveFlow(d)), 8));
  return clamp(ve, 0.25, 1.15);
}

/**
 * Knock index: how close the unburnt mixture comes to exploding on its own
 * before the flame reaches it. It rises with
 *  - the compression ratio (hotter, denser mixture at the end of compression),
 *  - how full the cylinder is (VE: a full cylinder squeezes more mixture),
 *  - the bore (the flame has further to travel, giving the far side time to go off),
 *  - low rpm (the burn takes longer in real time).
 * Above the fuel's limit the ECU retards the ignition, which costs torque.
 */
export function knockIndex(d, rpm) {
  const ve = volumetricEfficiency(d, rpm);
  return d.compression * Math.pow(ve, 0.9) * Math.pow(d.bore / 86, 0.6) * Math.pow(2500 / Math.max(rpm, 1000), 0.12);
}

export function fuelLimit(d) {
  return (FUELS[d.fuel] || FUELS["91"]).limit;
}

/** Share of combustion torque lost to retarded timing at this rpm (0 = none). */
export function knockLoss(d, rpm) {
  const over = (knockIndex(d, rpm) - fuelLimit(d)) / fuelLimit(d);
  return clamp(over * 2, 0, 0.35);
}

/** Indicated thermal efficiency from compression ratio (scaled Otto cycle). */
export function indicatedEfficiency(d) {
  return REAL_CYCLE_FACTOR * (1 - Math.pow(d.compression, 1 - GAMMA_EFF));
}

/** Torque from combustion before any friction, N m (after any knock-limited timing). */
export function indicatedTorque(d, rpm) {
  const airPerCycle = volumetricEfficiency(d, rpm) * AIR_DENSITY * displacement(d); // kg
  const work = (airPerCycle / AFR_POWER) * FUEL_LHV * indicatedEfficiency(d);        // J per cycle
  return (work / (4 * Math.PI)) * (1 - knockLoss(d, rpm));
}

/**
 * Friction mean effective pressure, Pa. The usual shape (after Chen and Flynn):
 * a constant part (bearings, valvetrain springs), a part growing with piston
 * speed (ring and skirt shear) and a part growing with its square (pumping
 * and windage). A low-friction build trims all three.
 */
export function frictionPressure(d, rpm) {
  const vp = pistonSpeed(d, rpm);
  const f = d.friction;
  const c0 = 70 - 15 * f, c1 = 8 - 2 * f, c2 = 0.3 - 0.08 * f; // kPa, kPa/(m/s), kPa/(m/s)^2
  return (c0 + c1 * vp + c2 * vp * vp) * 1000;
}

/** Friction torque, N m. */
export function frictionTorque(d, rpm) {
  return (frictionPressure(d, rpm) * displacement(d)) / (4 * Math.PI);
}

/** Torque at the flywheel, N m. */
export function brakeTorque(d, rpm) {
  return indicatedTorque(d, rpm) - frictionTorque(d, rpm);
}

export const kW = (torque, rpm) => (torque * rpm) / 9549.3;
export const hp = (kw) => kw * 1.341;

/** Rotating inertia estimate, kg m^2 (scaled from a typical 2.4 L four at 0.11). */
export function inertia(d) {
  const litres = displacement(d) * 1000;
  return 0.11 * Math.pow(litres / 2.4, 0.9) * BUILDS[d.build].inertiaScale;
}

/** Torque and power over an rpm band, sampled every 50 rpm (beyond redline counts as zero). */
export function bandStats(d, lo, hi) {
  const red = redline(d), ts = [], ps = [];
  for (let rpm = lo; rpm <= hi; rpm += 50) {
    const t = rpm <= red ? Math.max(0, brakeTorque(d, rpm)) : 0;
    ts.push(t); ps.push(kW(t, rpm));
  }
  const min = Math.min(...ts), max = Math.max(...ts);
  return { min, max, spread: max > 0 ? (max - min) / max : 0, avgPower: ps.reduce((a, b) => a + b, 0) / ps.length };
}


/** Everything the interface needs for one design, sampled every `step` rpm. */
export function analyse(d, step = 100) {
  const red = redline(d);
  const rpm = [], ve = [], ind = [], fric = [], torque = [], power = [], vp = [], knock = [], lost = [];
  for (let n = 1000; n <= red; n += step) {
    rpm.push(n);
    ve.push(volumetricEfficiency(d, n));
    ind.push(indicatedTorque(d, n));
    knock.push(knockIndex(d, n));
    const loss = knockLoss(d, n);
    lost.push(loss > 0 ? (indicatedTorque(d, n) / (1 - loss)) * loss : 0);
    fric.push(frictionTorque(d, n));
    const t = brakeTorque(d, n);
    torque.push(t);
    power.push(kW(t, n));
    vp.push(pistonSpeed(d, n));
  }
  let iT = 0, iP = 0;
  torque.forEach((t, i) => { if (t > torque[iT]) iT = i; });
  power.forEach((p, i) => { if (p > power[iP]) iP = i; });
  const litres = displacement(d) * 1000;
  return {
    litres,
    boreStroke: d.bore / d.stroke,
    redline: red,
    pistonSpeedAtRedline: pistonSpeed(d, red),
    peakTorque: torque[iT], peakTorqueRpm: rpm[iT],
    peakPower: power[iP], peakPowerRpm: rpm[iP],
    specificPower: power[iP] / litres,
    camPeakRpm: camPeakRpm(d),
    runnerLength: runnerLength(d.tuneRpm),
    efficiency: indicatedEfficiency(d),
    inertia: inertia(d),
    knockLimit: fuelLimit(d),
    knockLost: Math.max(0, ...lost),
    rpm, ve, ind, fric, torque, power, vp, knock, lost,
  };
}
