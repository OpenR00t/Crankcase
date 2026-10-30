// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// A simple 3D model of the engine, built from the design: oil pan, block,
// heads, cam covers, intake, exhaust manifolds, timing cover and crank pulley,
// arranged for the layout (inline, flat or V). Every part stays inside the
// engine's node box from geometry.js, so the model, the fit drawing and the
// physics all describe the same engine.
//
// Coordinates are BeamNG's vehicle frame: +x left, -y forward, +z up, metres.

import { dimensions, vAngle, LAYOUTS } from "./geometry.js";

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const Y = [0, 1, 0];

/**
 * A six-sided solid along a local axis frame: `out` points from the base to the
 * top, `side` across it, and y runs along the engine. The base is `w0` wide and
 * the top `w1` wide (a taper), between distances r0 and r1 along `out`, from
 * `origin`, over the engine length y0..y1. Returns { quads, material }.
 */
function block(origin, out, side, r0, r1, w0, w1, y0, y1, material) {
  const p = (r, w, y) => add(add(add(origin, mul(out, r)), mul(side, w)), [0, y, 0]);
  const c = [
    p(r0, -w0 / 2, y0), p(r0, w0 / 2, y0), p(r0, w0 / 2, y1), p(r0, -w0 / 2, y1),
    p(r1, -w1 / 2, y0), p(r1, w1 / 2, y0), p(r1, w1 / 2, y1), p(r1, -w1 / 2, y1),
  ];
  const quads = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]
    .map((q) => q.map((i) => c[i]));
  return { quads: orient(quads, centroid(c)), material };
}

/** A cylinder along y (the crank axis), centred at (x, z), from y0 to y1. */
function pulley(x, z, radius, y0, y1, material, segments = 20) {
  const quads = [];
  const ring = (y) => Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [x + Math.cos(a) * radius, y, z + Math.sin(a) * radius];
  });
  const a = ring(y0), b = ring(y1);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    quads.push([a[i], a[j], b[j], b[i]]);
  }
  const caps = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    caps.push([[x, y0, z], a[j], a[i]], [[x, y1, z], b[i], b[j]]);
  }
  const all = [...quads, ...caps];
  return { quads: orient(all, [x, (y0 + y1) / 2, z]), material };
}

function centroid(pts) {
  return mul(pts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / pts.length);
}

/** Make every face wind outward from the part's centre. */
function orient(faces, centre) {
  return faces.map((f) => {
    const n = cross(sub(f[1], f[0]), sub(f[2], f[0]));
    return dot(n, sub(centroid(f), centre)) < 0 ? [...f].reverse() : f;
  });
}

/**
 * Build the parts. `anchor` is the rear face of the block, centreline, bottom
 * (the same anchor the node box uses). Returns [{ name, quads, material }].
 */
export function engineParts(d, anchor) {
  const dim = dimensions(d);
  const b = d.bore / 1000, s = d.stroke / 1000;
  const crankcase = 0.5 * s + 0.08;
  const deck = 0.5 * s + 1.65 * s + 0.32 * b;
  const head = 0.55 * b + 0.06;
  const rear = anchor.y, front = anchor.y - dim.length;
  const yFront = front + 0.06;             // timing cover and pulley in front of this
  const yRear = rear - 0.01;
  const cx = anchor.x, z0 = anchor.z;
  const crankZ = d.layout === "flat" ? z0 + dim.height / 2 : z0 + crankcase;
  const crank = [cx, 0, crankZ];
  const len = rear - front;
  const parts = [];
  const put = (name, part) => parts.push({ name, ...part });

  if (d.layout === "inline") {
    const blockHalf = 0.9 * b + 0.05;
    put("pan", block([cx, 0, z0], [0, 0, 1], [1, 0, 0], 0, 0.09, blockHalf * 1.4, blockHalf * 1.6, yFront + 0.04, yRear - 0.05, "dark"));
    put("block", block(crank, [0, 0, 1], [1, 0, 0], -crankcase + 0.07, deck, blockHalf * 2, blockHalf * 2, yFront, yRear, "alloy"));
    put("head", block(crank, [0, 0, 1], [1, 0, 0], deck, deck + head * 0.7, blockHalf * 2.05, blockHalf * 1.9, yFront, yRear, "alloy"));
    put("cover", block(crank, [0, 0, 1], [1, 0, 0], deck + head * 0.7, deck + head, blockHalf * 1.6, blockHalf * 1.2, yFront + 0.02, yRear - 0.02, "cover"));
    const sideZ0 = deck - 0.02, sideZ1 = deck + head * 0.6;
    put("intake", block([cx, 0, crankZ + (sideZ0 + sideZ1) / 2], [1, 0, 0], [0, 0, 1], blockHalf * 1.02, dim.topHalf, sideZ1 - sideZ0, (sideZ1 - sideZ0) * 0.8, yFront + len * 0.08, yRear - len * 0.08, "grey"));
    put("exhaust", block([cx, 0, crankZ + deck - 0.01], [-1, 0, 0], [0, 0, 1], blockHalf * 1.02, dim.topHalf * 0.95, 0.07, 0.05, yFront + len * 0.12, yRear - len * 0.12, "grey"));
  } else {
    // two banks around the crank: V at its bank angle, flat at 180 degrees
    const half = d.layout === "flat" ? Math.PI / 2 : (vAngle(d.cylinders) / 2) * Math.PI / 180;
    const bankW = 1.2 * b + 0.04;
    const caseHalf = d.layout === "flat" ? 0.9 * b + 0.04 : dim.bottomHalf;
    if (d.layout === "flat") {
      put("case", block([cx, 0, crankZ], [0, 0, 1], [1, 0, 0], -0.11, 0.11, caseHalf * 2, caseHalf * 2, yFront, yRear, "alloy"));
      put("pan", block([cx, 0, z0], [0, 0, 1], [1, 0, 0], 0, crankZ - z0 - 0.11, caseHalf * 1.4, caseHalf * 1.6, yFront + 0.05, yRear - 0.06, "dark"));
    } else {
      put("case", block([cx, 0, z0], [0, 0, 1], [1, 0, 0], 0.07, crankcase + 0.06, caseHalf * 2, caseHalf * 2, yFront, yRear, "alloy"));
      put("pan", block([cx, 0, z0], [0, 0, 1], [1, 0, 0], 0, 0.08, caseHalf * 1.6, caseHalf * 1.8, yFront + 0.04, yRear - 0.05, "dark"));
    }
    for (const sgn of [1, -1]) {
      const out = [sgn * Math.sin(half), 0, Math.cos(half)];
      const side = norm(cross(Y, out));
      const tag = sgn > 0 ? "L" : "R";
      put(`bank${tag}`, block(crank, out, side, 0.06, deck, bankW, bankW, yFront, yRear, "alloy"));
      put(`head${tag}`, block(crank, out, side, deck, deck + head * 0.7, bankW * 1.05, bankW, yFront, yRear, "alloy"));
      put(`cover${tag}`, block(crank, out, side, deck + head * 0.7, deck + head, bankW * 0.85, bankW * 0.65, yFront + 0.02, yRear - 0.02, "cover"));
    }
    if (d.layout === "v") {
      // intake plenum in the valley, up to the top of the node box
      const top = z0 + dim.height;
      const valleyHalf = Math.max(0.06, deck * Math.sin(half) * 0.7);
      put("intake", block([cx, 0, crankZ + 0.1], [0, 0, 1], [1, 0, 0], 0, top - crankZ - 0.1, valleyHalf * 1.2, valleyHalf * 1.6, yFront + len * 0.1, yRear - len * 0.1, "grey"));
    } else {
      // flat: intake on top of the crankcase
      const room = Math.max(0.03, z0 + dim.height - (crankZ + 0.11));
      put("intake", block([cx, 0, crankZ + 0.11], [0, 0, 1], [1, 0, 0], 0, Math.min(0.1, room), caseHalf * 1.4, caseHalf * 1.1, yFront + len * 0.15, yRear - len * 0.15, "grey"));
    }
  }

  // timing cover across the front of the block, and the crank pulley
  const coverHalf = d.layout === "inline" ? 0.9 * b + 0.05 : d.layout === "flat" ? 0.9 * b + 0.04 : dim.bottomHalf;
  const coverTop = d.layout === "flat" ? 0.12 : d.layout === "inline" ? deck + head * 0.7 : crankcase * 0.5 + 0.12;
  put("timing", block(crank, [0, 0, 1], [1, 0, 0], d.layout === "flat" ? -0.11 : -crankcase + 0.07, coverTop, coverHalf * 2, coverHalf * 1.8, yFront - 0.025, yFront, "dark"));
  put("pulley", pulley(cx, crankZ, Math.min(0.085, 0.4 * b + 0.04), front + 0.003, yFront - 0.025, "chrome"));
  return parts;
}

/**
 * The forced induction's own model, as a separate mesh carried by the intake part
 * (so swapping the intake in the game takes it away): turbos (compressor and turbine
 * housings) on the exhaust side, one per bank for a V or a boxer's parallel twins;
 * a supercharger on top of the intake (roots or twin-screw) or a centrifugal blower's
 * snail at the front, with its drive pulley. Empty for a naturally aspirated design.
 */
export function inductionParts(d, anchor) {
  const parts = [];
  if (!d.induction || d.induction === "none") return parts;
  const put = (name, part) => parts.push({ name, ...part });
  const dim = dimensions(d);
  const s = d.stroke / 1000;
  const rear = anchor.y, front = anchor.y - dim.length;
  const len = rear - front;
  const cx = anchor.x, z0 = anchor.z;
  const crankcase = 0.5 * s + 0.08;
  const crankZ = d.layout === "flat" ? z0 + dim.height / 2 : z0 + crankcase;
  const litres = (Math.PI / 4) * (d.bore / 1000) ** 2 * s * d.cylinders * 1000;
  const turbo = d.induction === "turbo" || d.induction === "twincharged";
  const sc = d.induction === "supercharger" || d.induction === "twincharged";

  if (turbo) {
    // housings scale with the engine and the turbo's size (a later full-boost rpm is a bigger turbo)
    const size = Math.min(Math.max((d.spoolRpm ?? 3500) / 6500, 0.3), 1.2);
    const base = (0.045 + 0.02 * Math.sqrt(litres / 2)) * (0.8 + 0.4 * size);
    const one = (tag, x, z, y, r) => {
      put(`turbo${tag}C`, pulley(x, z, r, y - 0.045, y + 0.005, "alloy"));          // compressor
      put(`turbo${tag}S`, pulley(x, z, r * 0.45, y + 0.005, y + 0.03, "dark"));     // centre section
      put(`turbo${tag}T`, pulley(x, z, r * 0.85, y + 0.03, y + 0.075, "dark"));     // turbine
    };
    const side = -1; // exhaust side: -x (the car's right) for an inline engine
    const zEx = d.layout === "inline" ? z0 + dim.height * 0.62 : d.layout === "v" ? crankZ + 0.06 : z0 + dim.height * 0.15;
    const xOut = (sgn, r) => cx + sgn * (dim.topHalf + r + 0.015);
    const layout = d.induction === "twincharged" ? "single" : d.turboLayout || "single";
    const pair = layout === "twin" || layout === "sequential";
    if (d.layout === "inline" || !pair || layout === "sequential") {
      if (pair) {
        const rs = layout === "sequential" ? [base * 0.8, base * 1.15] : [base * 0.85, base * 0.85];
        one("A", xOut(side, rs[0]), zEx, front + len * 0.28, rs[0]);
        one("B", xOut(side, rs[1]), zEx, rear - len * 0.28, rs[1]);
      } else {
        const r = layout === "twinscroll" ? base * 1.05 : base;
        one("A", xOut(side, r), zEx, front + len * 0.35, r);
      }
    } else {
      // a V or a boxer's parallel twins: one per bank
      const r = base * 0.85;
      one("L", xOut(1, r), zEx, front + len * 0.35, r);
      one("R", xOut(-1, r), zEx, front + len * 0.35, r);
    }
  }

  if (sc) {
    const type = d.scType || "roots";
    const pulleyR = 0.045;
    if (type === "centrifugal") {
      const r = 0.06 + 0.02 * Math.sqrt(litres / 2);
      const x = cx + (dim.topHalf - r) * 0.8, z = crankZ + Math.max(0.12, dim.height * 0.35);
      put("scSnail", pulley(x, z, r, front - 0.07, front - 0.005, "alloy"));
      put("scHub", pulley(x, z, r * 0.4, front - 0.1, front - 0.07, "chrome"));
    } else {
      // roots or twin-screw: a casing on top of the intake, as long as most of the engine
      const w = 0.11 + 0.04 * Math.sqrt(litres / 2), h = 0.1 + 0.03 * Math.sqrt(litres / 2);
      const x = d.layout === "inline" ? cx + dim.topHalf * 0.45 : cx;
      const zb = z0 + dim.height - 0.03;
      const y0 = front + len * 0.12, y1 = rear - len * 0.2;
      put("scCase", block([x, 0, zb], [0, 0, 1], [1, 0, 0], 0, h, w, w * (type === "screw" ? 0.9 : 0.8), y0, y1, "alloy"));
      put("scSnout", pulley(x, zb + h * 0.55, w * 0.22, front + 0.02, y0, "alloy"));
      put("scPulley", pulley(x, zb + h * 0.55, pulleyR, front - 0.005, front + 0.02, "chrome"));
    }
  }
  return parts;
}

/** Axis-aligned bounds of the model, for checks. */
export function bounds(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (const q of p.quads) for (const v of q) {
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
  }
  return { lo, hi };
}

export { LAYOUTS };
