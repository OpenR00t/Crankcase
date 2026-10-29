// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Engine sounds by layout. BeamNG.drive loads engine sounds by name from a
// shared folder, so any car can use any of the game's engine recordings.
// These are the names of stock recordings closest to each layout; null keeps
// the donor engine's own sound (already the right kind for that family).
// The harmonics are always tuned to the design's cylinder count on export.

const SAMPLES = {
  "inline-3": { engine: "i3_2_engine", exhaust: "i3_2_exhaust" },
  "inline-4": null,
  "inline-5": { engine: "i5_engine", exhaust: "i5pt_1983_02000cc_motorsport_01_exhaust" },
  "inline-6": { engine: "I6_2_engine", exhaust: "I6_2_exhaust" },
  "flat-4": { engine: "b4p_2008_02500cc_modified_01_engine", exhaust: "b4p_2008_02500cc_modified_01_exhaust" },
  "flat-6": { engine: "b4p_2008_02500cc_modified_01_engine", exhaust: "b4p_2008_02500cc_modified_01_exhaust" },
  "v-6": { engine: "V6_2_engine", exhaust: "V6_2_exhaust" },
  "v-8": null,
  "v-10": { engine: "V10_2_engine_rear", exhaust: "V10_2_exhaust" },
  "v-12": { engine: "V10_2_engine_rear", exhaust: "V10_2_exhaust" },
};

/** { engine, exhaust } sample names for the design, or null to keep the donor's. */
export function soundFor(d) {
  return SAMPLES[`${d.layout}-${d.cylinders}`] ?? null;
}
