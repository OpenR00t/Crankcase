// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Placing the engine in a car. Nodes and meshes are built in the engine's own
// frame, the BX's orientation with the anchor at the origin (x to the engine's
// left, -y towards the crank nose, z up), then moved into the car along its
// donor's frame. That lets the same engine go in longways, sideways or in the
// back, whichever way the car's stock engines point.

import { blockNodes } from "./geometry.js";
import { engineParts, inductionParts } from "./mesh.js";

const ORIGIN = { x: 0, y: 0, z: 0 };

/** The family's frame; a hand-written family with only an anchor sits like the BX's engines. */
export function frameOf(fam) {
  if (fam.frame) return fam.frame;
  const a = fam.anchor;
  return { origin: [a.x, a.y, a.z], forward: [0, -1, 0], left: [1, 0, 0], up: [0, 0, 1], swapped: false, orientation: "longitudinal" };
}

/** A point from the engine frame into the car. A car that names its sides the other way gets the engine mirrored. */
export function place(frame, p) {
  const s = frame.swapped ? -1 : 1;
  const [x, y, z] = p;
  const up = frame.up ?? [0, 0, 1];
  return [0, 1, 2].map((i) => frame.origin[i] + frame.left[i] * s * x - frame.forward[i] * y + up[i] * z);
}

const r3 = (v) => Math.round(v * 1000) / 1000 + 0;

/** The block nodes, in the car. */
export function placedBlockNodes(d, fam) {
  const frame = frameOf(fam);
  // a car that numbers its block from the nose: our gearbox-end corners take its e2/e4 names
  // and a car that spells them en1r ... gets them spelt its way
  const prefix = frame.nodePrefix ?? "e";
  const rename = (id) => id.replace(/^e([1-4])/, (m, n) => `${prefix}${frame.flipEnds ? { 1: 2, 2: 1, 3: 4, 4: 3 }[n] : n}`);
  return blockNodes(d, ORIGIN).map(([id, ...p]) => [rename(id), ...place(frame, p).map(r3)]);
}

/** Mesh parts moved into the car; mirroring turns faces inside out, so their winding flips with it. */
function placeParts(parts, frame) {
  return parts.map((part) => ({
    ...part,
    quads: part.quads.map((q) => {
      const moved = q.map((p) => place(frame, p));
      return frame.swapped ? moved.reverse() : moved;
    }),
  }));
}

export const placedEngineParts = (d, fam) => placeParts(engineParts(d, ORIGIN), frameOf(fam));
export const placedInductionParts = (d, fam) => placeParts(inductionParts(d, ORIGIN), frameOf(fam));

/**
 * The bay in the engine's frame: how far the block may reach ahead of its gearbox face,
 * to each side of the centreline, and above and below its bottom. Detected families
 * carry their own; a hand-written profile's bay is in car coordinates.
 */
export function localBay(profile, fam) {
  if (fam.bay) return fam.bay;
  const b = profile.bay, a = fam.anchor;
  return { front: r3(a.y - b.frontY), halfWidth: b.maxHalfWidth, top: r3(b.maxTopZ - a.z), bottom: r3(b.minBottomZ - a.z) };
}
