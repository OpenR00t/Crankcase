// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Design locks: hold a target while the sliders move, so designing to a rule is
// quick. Two kinds:
//   - held values (displacement, redline, bore/stroke): moving one control moves
//     another to keep the value, e.g. with 2.0 L held, more bore means less stroke;
//   - limits (a mass ceiling, fits the target car, no knock): a slider stops at the
//     last setting that keeps the limit.
// A move no setting can satisfy (bore with displacement and redline both held,
// say) leaves the design as it was and says which lock held it.

import { displacement, redline, BUILDS, MAX_REDLINE, knockLoss } from "./engine.js";
import { mass, fixCylinders, layoutName } from "./geometry.js";
import { checkFit } from "./fit.js";

/** Geometry the sliders allow (mm). */
export const GEOMETRY = { bore: { min: 70, max: 105 }, stroke: { min: 60, max: 110 } };

const f0 = (v) => Math.round(v).toLocaleString("en-US");

export const LOCKS = {
  displacement: { label: "Displacement", kind: "hold", value: (d) => displacement(d) * 1000, fmt: (v) => `${v.toFixed(2)} L`, step: 0.01, unit: "L",
    tip: "Bore and stroke trade against each other to keep the litres: more bore, less stroke. Changing the cylinder count resizes both." },
  redline: { label: "Redline", kind: "hold", value: (d) => redline(d), fmt: (v) => `${f0(v)} rpm`, step: 50, unit: "rpm",
    tip: "The stroke is fixed by the redline and the rotating-assembly build: a stronger build gets a longer stroke at the same redline." },
  boreStroke: { label: "Bore / stroke", kind: "hold", value: (d) => d.bore / d.stroke, fmt: (v) => v.toFixed(2), step: 0.01, unit: "",
    tip: "Bore and stroke move together, keeping the engine's proportions." },
  mass: { label: "Mass", kind: "max", value: (d) => mass(d), fmt: (v) => `≤ ${f0(v)} kg`, step: 1, unit: "kg",
    tip: "A ceiling: sliders stop where the engine would get heavier." },
  fit: { label: "Fits the car", kind: "check", tip: "Sliders stop where the engine would no longer fit the target car's bay." },
  knock: { label: "No knock", kind: "check", tip: "Sliders stop where the engine would start to knock on its fuel." },
};

const HELD = ["displacement", "redline", "boreStroke"];
const close = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const swept = (n, bore, stroke) => n * Math.PI / 4 * (bore / 1000) ** 2 * (stroke / 1000) * 1000; // litres

/** The stroke (mm) that puts the redline exactly at `rpm` for a build. */
export function strokeFor(build, rpm) {
  return BUILDS[build].maxPistonSpeed * 30000 / (rpm + 0.5);
}

/** Is a check-kind lock met? */
export function checkMet(key, d, ctx) {
  if (key === "fit") return ctx?.profile ? checkFit(d, ctx.profile).ok : true;
  if (key === "knock") {
    for (let rpm = 1000; rpm <= redline(d); rpm += 100) if (knockLoss(d, rpm) > 0) return false;
    return true;
  }
  return true;
}

/** Which of the active locks this design breaks (held values within rounding). */
export function broken(d, locks, ctx) {
  const out = [];
  for (const [key, v] of Object.entries(locks ?? {})) {
    if (v == null || v === false || !LOCKS[key]) continue;
    const L = LOCKS[key];
    if (L.kind === "hold" && !close(L.value(d), v, key === "redline" ? 0 : 1e-3)) out.push(key);
    if (L.kind === "max" && L.value(d) > v + 1e-6) out.push(key);
    if (L.kind === "check" && !checkMet(key, d, ctx)) out.push(key);
  }
  return out;
}

/**
 * The design with `changes` applied and the held values kept, or { held } naming the
 * lock that makes it impossible. Only geometry (layout, cylinders, bore, stroke, build)
 * takes part in held values.
 */
export function project(d, changes, locks) {
  const x = { ...d, ...changes };
  const changed = new Set(Object.keys(changes));
  if (changed.has("layout")) { x.cylinders = fixCylinders(x); changed.add("cylinders"); }
  const V = locks?.displacement ?? null, R = locks?.redline ?? null, k = locks?.boreStroke ?? null;
  if (R != null) {
    if (R > MAX_REDLINE) return { held: "redline" };
    const s = strokeFor(x.build, R);
    if (changed.has("stroke") && !close(x.stroke, s)) return { held: "redline" };
    x.stroke = s;
  }
  const strokeFixed = R != null || changed.has("stroke"), boreFixed = changed.has("bore");
  const area = (n) => n * Math.PI / 4 / 1e6; // litres per (mm^2 x mm) / 1000
  if (V != null && k != null) {
    if (strokeFixed || boreFixed) {
      // both are given: they hold only if they already agree
      if (strokeFixed && !boreFixed) x.bore = k * x.stroke;
      if (boreFixed && !strokeFixed) x.stroke = x.bore / k;
      if (!close(swept(x.cylinders, x.bore, x.stroke), V) || !close(x.bore / x.stroke, k)) {
        return { held: R != null ? "redline" : !close(x.bore / x.stroke, k) ? "boreStroke" : "displacement" };
      }
    } else {
      x.stroke = Math.cbrt(V / (area(x.cylinders) * k * k));
      x.bore = k * x.stroke;
    }
  } else if (V != null) {
    if (boreFixed && strokeFixed) {
      if (!close(swept(x.cylinders, x.bore, x.stroke), V)) return { held: R != null ? "redline" : "displacement" };
    } else if (boreFixed) {
      x.stroke = V / (area(x.cylinders) * x.bore * x.bore);
    } else if (strokeFixed) {
      x.bore = Math.sqrt(V / (area(x.cylinders) * x.stroke));
    } else {
      // the cylinder count changed: keep the proportions, resize both
      const r = x.bore / x.stroke;
      x.stroke = Math.cbrt(V / (area(x.cylinders) * r * r));
      x.bore = r * x.stroke;
    }
  } else if (k != null) {
    if (boreFixed && strokeFixed) {
      if (!close(x.bore / x.stroke, k)) return { held: R != null ? "redline" : "boreStroke" };
    } else if (boreFixed) x.stroke = x.bore / k;
    else x.bore = k * x.stroke;
  }
  for (const key of ["bore", "stroke"]) {
    const g = GEOMETRY[key];
    if (x[key] < g.min - 1e-6 || x[key] > g.max + 1e-6) {
      // out of the slider's range: the lock that pushed it there holds
      return { held: changed.has(key) ? null : HELD.find((h) => locks?.[h] != null) ?? null, range: key };
    }
    x[key] = Math.round(x[key] * 1000) / 1000;
  }
  return { d: x };
}

/** Projected and checked against the limits; `skip` are limits the current design already breaks. */
function attempt(d, changes, locks, ctx, skip) {
  const p = project(d, changes, locks);
  if (!p.d) return p;
  for (const key of ["mass", "fit", "knock"]) {
    const v = locks?.[key];
    if (v == null || v === false || skip.has(key)) continue;
    if (key === "mass" ? mass(p.d) > v + 1e-6 : !checkMet(key, p.d, ctx)) return { held: key };
  }
  return p;
}

/**
 * Apply one control change under the locks. For a slider, a move the locks don't allow
 * stops at the last allowed setting on the way. Returns { d, held } where held names
 * the lock that stopped it (d is unchanged if nothing was allowed).
 */
export function applyChange(d, key, value, locks, ctx, slider = null) {
  const active = Object.values(locks ?? {}).some((v) => v != null && v !== false);
  if (!active) {
    const x = { ...d, [key]: value };
    if (key === "layout") x.cylinders = fixCylinders(x);
    return { d: x, held: null };
  }
  const skip = new Set(broken(d, locks, ctx).filter((k) => LOCKS[k].kind !== "hold"));
  const full = attempt(d, { [key]: value }, locks, ctx, skip);
  if (full.d) return { d: full.d, held: null };
  if (!slider || typeof value !== "number" || typeof d[key] !== "number") return { d, held: full.held ?? null, range: full.range };
  // a slider: find how far it can go towards the value
  let ok = d[key], bad = value;
  if (!attempt(d, { [key]: ok }, locks, ctx, skip).d) return { d, held: full.held ?? null, range: full.range };
  for (let i = 0; i < 30 && Math.abs(bad - ok) > slider.step / 4; i++) {
    const mid = (ok + bad) / 2;
    if (attempt(d, { [key]: mid }, locks, ctx, skip).d) ok = mid; else bad = mid;
  }
  // onto the slider's steps, on the allowed side
  const dir = Math.sign(value - d[key]);
  let snapped = d[key] + dir * Math.floor(Math.abs(ok - d[key]) / slider.step + 1e-9) * slider.step;
  snapped = Number(snapped.toFixed(6));
  const r = attempt(d, { [key]: snapped }, locks, ctx, skip);
  return { d: r.d ?? d, held: full.held ?? null, range: full.range };
}

/**
 * Turn a lock on (at the design's current value, or `target` for a held value or the
 * mass), or change its target. Returns { d, locks } or { error }.
 */
export function setLock(d, key, target, locks, ctx) {
  const L = LOCKS[key];
  const next = { ...(locks ?? {}) };
  if (L.kind === "check") {
    if (checkMet(key, d, ctx)) { next[key] = true; return { d, locks: next }; }
    if (key === "knock") {
      // lower the compression to the highest ratio that runs clean
      let lo = 7, hi = d.compression;
      if (!checkMet(key, { ...d, compression: lo }, ctx)) return { error: "It knocks even at 7:1: lower the boost or use better fuel first." };
      for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (checkMet(key, { ...d, compression: m }, ctx)) lo = m; else hi = m; }
      const cr = Math.floor(lo * 10) / 10;
      next[key] = true;
      return { d: { ...d, compression: cr }, locks: next, message: `Compression lowered to ${cr.toFixed(1)}:1 so it runs clean.` };
    }
    return { error: `The ${layoutName(d)} doesn't fit the ${ctx?.profile?.name ?? "car"} now: make it fit first (see Fit).` };
  }
  const value = target ?? L.value(d);
  if (L.kind === "max") {
    if (L.value(d) > value + 1e-6) return { error: `It already weighs ${f0(L.value(d))} kg.` };
    next[key] = value;
    return { d, locks: next };
  }
  if (key === "redline" && value % 50) return { error: "The redline goes in steps of 50 rpm." };
  next[key] = value;
  const p = project(d, {}, next);
  if (!p.d) {
    return { error: p.range ? `That needs a ${p.range} outside ${GEOMETRY[p.range].min}–${GEOMETRY[p.range].max} mm.`
      : `That can't be held together with the ${LOCKS[p.held]?.label.toLowerCase() ?? "other"} lock.` };
  }
  const skip = new Set(broken(d, locks, ctx).filter((k) => LOCKS[k].kind !== "hold"));
  const r = attempt(d, {}, next, ctx, skip);
  if (!r.d) return { error: `That breaks the ${LOCKS[r.held].label.toLowerCase()} lock.` };
  return { d: r.d, locks: next };
}

export function clearLock(locks, key) {
  const next = { ...(locks ?? {}) };
  delete next[key];
  return next;
}

/** Locks for display: [{ key, label, on, value, met }]. */
export function lockList(d, locks, ctx) {
  const off = new Set(broken(d, locks, ctx));
  return Object.entries(LOCKS).map(([key, L]) => {
    const v = locks?.[key];
    const on = v != null && v !== false;
    return { key, label: L.label, kind: L.kind, tip: L.tip, on, met: !off.has(key),
      value: L.kind === "check" ? null : L.fmt(on ? v : L.value(d)), raw: on ? v : L.kind === "check" ? null : L.value(d) };
  });
}
