// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// The exhaust: manifold or headers, pipe size, catalytic converter and muffler.
//
// Two things it does to the engine:
//   - back pressure: every part of the system resists the gas flowing through it,
//     and the pressure it takes to push the gas out grows with the square of the
//     gas speed. The piston pays it on every exhaust stroke (pumping), and the gas
//     left in the cylinder takes room the fresh charge would have had (residual),
//     more so with long cam overlap.
//   - pulse tuning: with tubular headers, the pressure wave from each exhaust pulse
//     comes back along its primary pipe as suction just as the valves overlap, and
//     helps empty the cylinder around one rpm, set by the primary length.
// A turbo's turbine sits upstream of the pipe: the gas after it is cooler and
// denser, and pressure in the pipe is multiplied back through the turbine, so the
// same pipe costs a turbo engine more.
//
// A design without exhaust parts (from before the Exhaust section) is free-flowing.

import { volumetricEfficiency, redline } from "./engine.js";
import { chargeFactor, hasTurbo } from "./induction.js";

export const MANIFOLDS = {
  cast:    { label: "Cast manifold", zeta: 1.5, fill: -0.015, note: "Compact and cheap; the pulses from different cylinders meet early and get in each other's way" },
  headers: { label: "Tubular headers", zeta: 0.8, fill: 0, note: "A separate primary pipe per cylinder, merging further down: the pulses help each other instead" },
};

export const CATS = {
  standard: { label: "Catalytic converter", zeta: 2.5 },
  highflow: { label: "High-flow cat", zeta: 1.2 },
  none:     { label: "No cat (race)", zeta: 0 },
};

/** Sound: how much the muffler damps the tailpipe, as the game's exhaust settings. */
export const MUFFLERS = {
  chambered: { label: "Chambered (quiet)", zeta: 3.5, sound: { muffling: 0.22, gain: -6, afterfire: 0.2, low: 13, high: -8, fundamental: 1 } },
  turbo:     { label: "Turbo muffler", zeta: 2.0, sound: { muffling: 0.35, gain: -5, afterfire: 0.3, low: 14, high: -6, fundamental: 2 } },
  straight:  { label: "Straight-through", zeta: 0.8, sound: { muffling: 0.55, gain: -4, afterfire: 0.6, low: 12, high: 0, fundamental: 3 } },
  none:      { label: "None (straight pipe)", zeta: 0, sound: { muffling: 0.8, gain: -2, afterfire: 1.0, low: 10, high: 5, fundamental: 4 } },
};

export const PIPES = { single: { label: "Single pipe", count: 1 }, dual: { label: "Dual pipes", count: 2 } };

export const PIPE_LIMITS = { min: 38, max: 89 };      // mm: 1.5" to 3.5"
export const PRIMARY_LIMITS = { min: 40, max: 120 };  // cm

const P_ATM = 101325;           // Pa
const GAS_DENSITY = 0.55;       // kg/m^3, exhaust gas at the tailpipe of an NA engine (~650 K)
const GAS_DENSITY_TURBO = 0.7;  // after the turbine: cooler, the turbine took energy out
const TURBINE_AMPLIFY = 1.8;    // pipe pressure seen back through the turbine
const AFR = 12.8;
const PIPE_LENGTH = 3;          // m, manifold to tailpipe
const PIPE_FRICTION = 0.02;     // Darcy friction factor
/** Design rule for the pipe: mean gas speed at redline, m/s. */
export const PIPE_SPEED = 90;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const hasExhaust = (d) => d.manifold != null;

/** The same design with a free-flowing exhaust: what Crankcase showed before exhausts. */
export const freeFlowing = (d) => ({ ...d, manifold: null });

/** rpm the header primaries are tuned for (Smith's rule, with the cam's exhaust duration). */
export function headerTunedRpm(d) {
  const ed = (d.duration ?? 224) + 30; // advertised duration, about 30° more than at 1 mm lift
  return Math.round(850 * ed / (d.primary / 2.54 + 3) / 50) * 50;
}

/** Exhaust gas through the system, m^3/s (at the tailpipe). */
function gasFlow(d, rpm) {
  const disp = d.cylinders * (Math.PI / 4) * (d.bore / 1000) ** 2 * (d.stroke / 1000);
  const air = volumetricEfficiency(d, rpm) * chargeFactor(d, rpm) * 1.18 * disp * rpm / 120; // kg/s
  return (air * (1 + 1 / AFR)) / (hasTurbo(d) ? GAS_DENSITY_TURBO : GAS_DENSITY);
}

/** Total loss coefficient of the system (velocity heads), per pipe. */
export function lossCoefficient(d) {
  const D = d.pipe / 1000;
  return MANIFOLDS[d.manifold].zeta + PIPE_FRICTION * PIPE_LENGTH / D + CATS[d.cat].zeta + MUFFLERS[d.muffler].zeta;
}

/** Back pressure the exhaust system makes at full throttle, Pa (0 when free-flowing). */
export function backPressure(d, rpm) {
  if (!hasExhaust(d)) return 0;
  const n = PIPES[d.pipes]?.count ?? 1;
  const area = n * Math.PI / 4 * (d.pipe / 1000) ** 2;
  const v = gasFlow(d, rpm) / area;
  const rho = hasTurbo(d) ? GAS_DENSITY_TURBO : GAS_DENSITY;
  return lossCoefficient(d) * 0.5 * rho * v * v;
}

/** Back pressure as the engine feels it: through the turbine, if there is one. */
function engineBackPressure(d, rpm) {
  return backPressure(d, rpm) * (hasTurbo(d) ? TURBINE_AMPLIFY : 1);
}

/** Pipe diameter (mm) that keeps the gas at the design speed at redline, per pipe. */
export function recommendedPipe(d) {
  const n = PIPES[d.pipes]?.count ?? 1;
  const q = gasFlow(d, redline(d)) / n;
  return Math.round(Math.sqrt(4 * q / (Math.PI * PIPE_SPEED)) * 1000);
}

/**
 * How much the exhaust changes the cylinder's filling (a multiplier, 1 = free-flowing):
 * residual gas from back pressure (worse with overlap), the manifold's own pulse
 * interference or the headers' tuning, and lost scavenging in an oversized pipe low down.
 */
export function exhaustFill(d, rpm) {
  if (!hasExhaust(d)) return 1;
  const overlap = Math.max(0, (d.duration ?? 224) - 220);
  const intakeP = P_ATM * chargeFactor(d, rpm);
  const residual = (engineBackPressure(d, rpm) / intakeP) / d.compression * (1 + overlap / 40);
  let fill = 1 - residual + MANIFOLDS[d.manifold].fill;
  if (d.manifold === "headers") {
    // a turbine in the way blunts the pulses (twin-scroll keeps them apart, so less so)
    const k = !hasTurbo(d) ? 1 : d.turboLayout === "twinscroll" ? 0.5 : 0.25;
    const tuned = headerTunedRpm(d);
    const t = (rpm - tuned) / (0.25 * tuned);
    fill += k * (0.01 + 0.04 * Math.exp(-t * t));
  }
  const over = d.pipe / Math.max(1, recommendedPipe(d));
  if (over > 1.15) fill -= 0.02 * clamp((over - 1.15) / 0.5, 0, 1) * Math.max(0, 1 - rpm / (0.7 * redline(d)));
  return clamp(fill, 0.6, 1.1);
}

/** Torque the piston spends pushing the gas out against the back pressure, N m. */
export function exhaustPumping(d, rpm) {
  if (!hasExhaust(d)) return 0;
  const disp = d.cylinders * (Math.PI / 4) * (d.bore / 1000) ** 2 * (d.stroke / 1000);
  return engineBackPressure(d, rpm) * disp / (4 * Math.PI);
}

export const DEFAULT_EXHAUST = { manifold: "cast", primary: 80, pipes: "single", pipe: 57, cat: "standard", muffler: "chambered" };
