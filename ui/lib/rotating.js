// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Rotating mass: everything that spins at engine speed (crank, rods' big ends,
// flywheel, clutch) has to be spun up along with the car. Its moment of
// inertia I sets:
//
//   rev response   d(omega)/dt = torque / I            (in neutral)
//   rev drop       how fast the revs fall with the throttle shut, during a shift
//   in-gear mass   the engine's inertia, seen at the wheels through the gearing,
//                  feels like extra mass: I x (overall ratio / tyre radius)^2
//
// The crank's share comes from the design (the build and the crank chosen);
// the flywheel and clutch are bought parts. BeamNG keeps them apart the same
// way: the engine part carries its own inertia, and the gearbox's flywheel
// part adds "additionalEngineInertia" on top.

import { inertia, brakeTorque, frictionTorque, redline, displacement } from "./engine.js";

/** Flywheel and clutch packages, kg m^2 (BeamNG's stock, lightened and ultra-light flywheels are 0.10, 0.05, 0.02). */
export const FLYWHEELS = {
  dualmass: { label: "Dual-mass", inertia: 0.14, clutchMass: 5.5,
    note: "two masses joined by springs: soaks up the engine's pulses for a smooth, quiet drive, at the cost of the most inertia" },
  stock: { label: "Stock steel", inertia: 0.10, clutchMass: 4.5,
    note: "a plain steel flywheel: easy to pull away and holds revs" },
  light: { label: "Lightened steel", inertia: 0.05, clutchMass: 4,
    note: "machined down: quicker revs, still easy to drive" },
  ultra: { label: "Ultra-light (aluminium)", inertia: 0.02, clutchMass: 3.25,
    note: "aluminium with a steel friction face: revs snap up and drop away; pulling away needs more revs and clutch slip" },
};

/** The crank itself. Knife-edged counterweights cut its inertia but balance the engine less well. */
export const CRANKS = {
  full: { label: "Fully counterweighted", scale: 1.0, note: "the smoothest-running crank" },
  lightened: { label: "Lightened, knife-edged", scale: 0.82, note: "less inertia, a little more vibration" },
};

export const DEFAULT_ROTATING = { flywheel: "stock", crank: "full" };

/** The engine's own rotating inertia (crank and rotating assembly), kg m^2: what the engine part carries. */
export function crankInertia(d) {
  return inertia(d) * (CRANKS[d.crank]?.scale ?? 1);
}

/** Flywheel and clutch, kg m^2: BeamNG's additionalEngineInertia. */
export function flywheelInertia(d) {
  return (FLYWHEELS[d.flywheel] ?? FLYWHEELS.stock).inertia;
}

export function totalInertia(d) {
  return crankInertia(d) + flywheelInertia(d);
}

const RAD = Math.PI / 30; // rpm -> rad/s

/**
 * Full throttle in neutral from `from` rpm to redline: { t: [s], rpm: [] } and the time taken.
 * The engine's own net torque spins up its own inertia.
 */
export function revUp(d, from = 1500, I = totalInertia(d)) {
  const red = redline(d), dt = 0.002;
  let w = from * RAD, t = 0;
  const ts = [0], rs = [from];
  while (w < red * RAD && t < 10) {
    w += (Math.max(1, brakeTorque(d, w / RAD)) / I) * dt;
    t += dt;
    if (Math.round(t / dt) % 5 === 0) { ts.push(t); rs.push(Math.min(red, w / RAD)); }
  }
  ts.push(t); rs.push(red);
  return { t: ts, rpm: rs, time: t };
}

/**
 * Closed-throttle pumping: with the throttle shut the pistons pull against
 * manifold vacuum, about 0.8 bar on every intake stroke, whatever the rpm.
 * BeamNG's "engineBrakeTorque" is exactly this: a constant torque applied
 * when the throttle is closed.
 */
export const PUMPING_MEP = 80e3; // Pa

/** Closed-throttle pumping torque, N m: what the export writes as engineBrakeTorque. */
export function pumpingTorque(d) {
  return (PUMPING_MEP * displacement(d)) / (4 * Math.PI);
}

/**
 * The design's friction as BeamNG models it: a constant part plus a part
 * growing with engine speed, friction + dynamicFriction x rad/s. A least-squares
 * fit to the design's friction from 1,000 rpm to redline.
 */
export function frictionFit(d) {
  const red = redline(d);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let rpm = 1000; rpm <= red; rpm += 100) {
    const x = rpm * RAD, y = frictionTorque(d, rpm);
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const dynamicFriction = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { friction: (sy - dynamicFriction * sx) / n, dynamicFriction };
}

/** Everything slowing the engine with the throttle shut, N m: BeamNG's own sum, with the values the export writes. */
export function closedThrottleDrag(d, rpm, fit = frictionFit(d)) {
  return fit.friction + fit.dynamicFriction * rpm * RAD + pumpingTorque(d);
}

/** Throttle shut at `from` rpm: how the revs fall over `seconds` (friction and pumping slow the engine). */
export function revDrop(d, from = redline(d), seconds = 1, I = totalInertia(d)) {
  const dt = 0.002, fit = frictionFit(d);
  let w = from * RAD, t = 0;
  const ts = [0], rs = [from];
  while (t < seconds && w > 800 * RAD) {
    const drag = closedThrottleDrag(d, w / RAD, fit);
    w -= (drag / I) * dt;
    t += dt;
    if (Math.round(t / dt) % 5 === 0) { ts.push(t); rs.push(w / RAD); }
  }
  return { t: ts, rpm: rs };
}

/** rpm lost with the throttle shut for `seconds` from `from` rpm. */
export function dropIn(d, from, seconds, I = totalInertia(d)) {
  const r = revDrop(d, from, seconds, I);
  return from - r.rpm[r.rpm.length - 1];
}

/** Seconds with the throttle shut for the revs to fall from `from` to `target` (Infinity if they don't within 3 s). */
export function matchTime(d, from, target, I = totalInertia(d)) {
  const r = revDrop(d, from, 3, I);
  const i = r.rpm.findIndex((x) => x <= target);
  if (i < 0) return Infinity;
  if (i === 0) return 0;
  const k = (r.rpm[i - 1] - target) / (r.rpm[i - 1] - r.rpm[i]);
  return r.t[i - 1] + k * (r.t[i] - r.t[i - 1]);
}

/** The engine's inertia as extra mass at the wheels in a gear, kg: I (overall ratio / r)^2. */
export function equivalentMass(I, overallRatio, tyreRadius) {
  return I * Math.pow(overallRatio / tyreRadius, 2);
}
