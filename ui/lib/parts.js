// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// The parts you actually choose, and how they map onto the engine model.
//
//   camshaft:  duration (crank degrees open, at 1 mm lift) and lift (mm)
//   intake:    runner length (cm), which sets the rpm the intake is tuned for
//   internals: piston rings, bearings, oil and sump, which set friction and
//              how much torque the engine survives
//
// engine.js works from three summary numbers (cam 0..1, tuneRpm, friction);
// resolve() derives them from the parts, so the physics stays in one place.

export const CAM = { minDuration: 200, maxDuration: 280, minLift: 8, maxLift: 14 };
/** Lobe centres (degrees from TDC): intake opens around the overlap TDC, exhaust before it. */
export const LOBE_CENTRES = { intake: 108, exhaust: 112 };

export const INTERNALS = {
  rings: {
    label: "Piston rings",
    options: {
      standard: { label: "Standard tension", friction: 0, durability: 0 },
      low: { label: "Low tension", friction: 0.35, durability: -0.12 },
    },
  },
  bearings: {
    label: "Crank & rod bearings",
    options: {
      large: { label: "Large", friction: 0, durability: 0.05 },
      standard: { label: "Standard", friction: 0.15, durability: 0 },
      small: { label: "Small", friction: 0.25, durability: -0.1 },
    },
  },
  oil: {
    label: "Oil",
    options: {
      "10w40": { label: "10W-40", friction: 0, durability: 0.03 },
      "5w30": { label: "5W-30", friction: 0.15, durability: 0 },
      "0w20": { label: "0W-20", friction: 0.25, durability: -0.05 },
    },
  },
  sump: {
    label: "Oil system",
    options: {
      wet: { label: "Wet sump", friction: 0, durability: 0 },
      dry: { label: "Dry sump", friction: 0.2, durability: 0.02 },
    },
  },
};

export const DEFAULT_PARTS = {
  duration: 224, lift: 10.5, runner: 47,
  rings: "standard", bearings: "standard", oil: "5w30", sump: "wet",
  flywheel: "stock", crank: "full",
  induction: "none", turboLayout: "single", scType: "roots", boost: 10, spoolRpm: 3500, handoverRpm: 4500,
  injection: "port",
  // a road car's exhaust (see exhaust.js)
  manifold: "cast", primary: 80, pipes: "single", pipe: 57, cat: "standard", muffler: "chambered",
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Valve overlap in degrees: both valves open around TDC. */
export function overlap(d) {
  return Math.max(0, d.duration - (LOBE_CENTRES.intake + LOBE_CENTRES.exhaust));
}

/** rpm the intake runners are tuned for (rule of thumb: about 2100 / length in metres). */
export function tunedRpm(runnerCm) {
  return clamp(Math.round(2100 / (runnerCm / 100) / 50) * 50, 2500, 9000);
}

/** Valve springs: a longer, higher-lift cam needs stiffer springs, which add friction. */
export function springFriction(d) {
  const cam = (d.duration - CAM.minDuration) / (CAM.maxDuration - CAM.minDuration);
  return 0.12 * (cam - 0.3) + 0.06 * (d.lift - 10.5) / 3.5;
}

/** Durability multiplier from the internals (1 = standard parts). */
export function durability(d) {
  return 1 + Object.entries(INTERNALS).reduce((s, [k, part]) => s + (part.options[d[k]]?.durability ?? 0), 0);
}

/** The design with cam, tuneRpm and friction derived from its parts. */
export function resolve(d) {
  if (d.duration == null) return d; // an old-style design: summary numbers only
  const partsFriction = Object.entries(INTERNALS).reduce((s, [k, part]) => s + (part.options[d[k]]?.friction ?? 0), 0);
  return {
    ...d,
    cam: clamp((d.duration - CAM.minDuration) / (CAM.maxDuration - CAM.minDuration), 0, 1),
    tuneRpm: tunedRpm(d.runner),
    friction: clamp(partsFriction - springFriction(d), -0.3, 1),
  };
}

/** Turn an old-style design (cam %, tuned rpm, friction %) into parts. */
export function migrate(d) {
  if (d.duration != null) return d;
  const cam = d.cam ?? 0.3, f = d.friction ?? 0.3;
  const internals = f < 0.15 ? { rings: "standard", bearings: "large", oil: "10w40", sump: "wet" }
    : f < 0.45 ? { rings: "standard", bearings: "standard", oil: "5w30", sump: "wet" }
    : f < 0.8 ? { rings: "low", bearings: "standard", oil: "5w30", sump: "wet" }
    : { rings: "low", bearings: "small", oil: "0w20", sump: "dry" };
  return {
    ...d,
    duration: Math.round((CAM.minDuration + cam * (CAM.maxDuration - CAM.minDuration)) / 2) * 2,
    lift: Math.round((9 + cam * 5) * 10) / 10,
    runner: Math.round(2100 / (d.tuneRpm ?? 4500) * 100),
    ...internals,
  };
}

/**
 * Valve lift (mm) against crank angle (degrees, 0 = TDC between exhaust and
 * intake): a smooth lobe of the cam's duration and lift around each centre.
 */
export function valveLift(d, angle, valve) {
  const centre = valve === "intake" ? LOBE_CENTRES.intake : -LOBE_CENTRES.exhaust;
  const half = d.duration / 2 + 30; // ramps beyond the 1 mm checking height
  const x = (angle - centre) / half;
  return Math.abs(x) >= 1 ? 0 : d.lift * Math.pow(1 - x * x, 1.6);
}
