// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// The engine as a physical object: layout, outside dimensions, mass, and the
// eight-node box BeamNG uses to give an engine its size and weight.
//
// Dimensions are rough packaging estimates built from bore and stroke:
//   bore spacing        = 1.15 x bore
//   connecting rod      = 1.65 x stroke
//   piston compression height = 0.32 x bore
//   cylinder head       = 0.55 x bore + 60 mm
// They were checked against the 2.4 L I4 and 4.5 L V8 in BeamNG's Ibishu BX,
// whose node boxes they match to within a few centimetres.

export const LAYOUTS = {
  inline: { label: "Inline", counts: [3, 4, 5, 6], banks: 1 },
  flat:   { label: "Flat (boxer)", counts: [4, 6], banks: 2 },
  v:      { label: "V", counts: [6, 8, 10, 12], banks: 2 },
};

/** Bank angle for V engines, degrees: the usual choice for even firing. */
export function vAngle(cylinders) {
  return cylinders === 8 || cylinders === 10 ? 90 : 60;
}

/** Layout name for display, e.g. "I4", "Flat-6", "V8". */
export function layoutName(d) {
  if (d.layout === "flat") return `Flat-${d.cylinders}`;
  if (d.layout === "v") return `V${d.cylinders}`;
  return `I${d.cylinders}`;
}

/** Keep the cylinder count valid when the layout changes. */
export function fixCylinders(d) {
  const counts = LAYOUTS[d.layout].counts;
  if (counts.includes(d.cylinders)) return d.cylinders;
  return counts.reduce((a, b) => (Math.abs(b - d.cylinders) < Math.abs(a - d.cylinders) ? b : a));
}

/**
 * Outside dimensions in metres: length (along the crank), height, and the
 * half-widths at the bottom (crankcase) and top (heads).
 */
export function dimensions(d) {
  const b = d.bore / 1000, s = d.stroke / 1000;
  const L = LAYOUTS[d.layout];
  const perBank = d.cylinders / L.banks;
  const crankcase = 0.5 * s + 0.08;                 // crank centre to the bottom of the block
  const deck = 0.5 * s + 1.65 * s + 0.32 * b;       // crank centre to the top of the block
  const head = 0.55 * b + 0.06;
  const bank = deck + head;                          // crank centre to the top of a head
  const length = perBank * 1.15 * b + 0.16;
  if (d.layout === "inline") {
    return { length, height: crankcase + bank, bottomHalf: 0.9 * b + 0.08, topHalf: 1.1 * b + 0.105 };
  }
  if (d.layout === "v") {
    const a = (vAngle(d.cylinders) / 2) * Math.PI / 180;
    return {
      length,
      height: crankcase + bank * Math.cos(a) + 0.08, // + intake in the valley
      bottomHalf: 0.9 * b + 0.04,
      topHalf: bank * Math.sin(a) + 0.1,
    };
  }
  // flat: cylinders lie horizontally either side of the crank
  const half = bank + 0.05;
  return { length, height: 1.6 * b + 0.2, bottomHalf: half * 0.95, topHalf: half };
}

/**
 * Estimated dressed engine mass, kg (aluminium block and heads):
 * a fixed part (accessories, flywheel, crank ends), a part per litre,
 * a part per cylinder, and a second head for flat and V engines.
 */
export function mass(d) {
  const litres = d.cylinders * (Math.PI / 4) * (d.bore / 1000) ** 2 * (d.stroke / 1000) * 1000;
  return 70 + 28 * litres + 4 * d.cylinders + (LAYOUTS[d.layout].banks > 1 ? 6 : 0);
}

/**
 * The eight block nodes BeamNG engines are built from, relative to an anchor
 * at the rear face of the block, on the centreline, at the bottom:
 *   e1 rear-bottom, e2 front-bottom, e3 rear-top, e4 front-top; r = right (-x), l = left (+x).
 * BeamNG's vehicle frame: +x left, -y forward, +z up. Returns [id, x, y, z] rows.
 */
export function blockNodes(d, anchor) {
  const dim = dimensions(d);
  const rear = anchor.y, front = anchor.y - dim.length;
  const bottom = anchor.z, top = anchor.z + dim.height;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const row = (id, x, y, z) => [id, r3(anchor.x + x), r3(y), r3(z)];
  return [
    row("e1r", -dim.bottomHalf, rear, bottom), row("e1l", dim.bottomHalf, rear, bottom),
    row("e2r", -dim.bottomHalf, front, bottom), row("e2l", dim.bottomHalf, front, bottom),
    row("e3r", -dim.topHalf, rear, top), row("e3l", dim.topHalf, rear, top),
    row("e4r", -dim.topHalf, front, top), row("e4l", dim.topHalf, front, top),
  ];
}
