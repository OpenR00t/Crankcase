// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// A vehicle config (.pc) for the target car with the design's engine and gearing:
// a stock config (read from the game at export time) with the engine, an
// adjustable gearbox and an adjustable final drive swapped in, and the gear and
// final-drive sliders set to the design's ratios. Everything else (body, wheels,
// suspension, intake and exhaust) stays as the stock config has it.

import { parseJBeam } from "./jbeamparse.js";
import { partName, flywheelPartName } from "./export.js";
import { ratios, tireRadius } from "./gearing.js";
import { analyse, hp } from "./engine.js";
import { mass } from "./geometry.js";

const r3 = (v) => Math.round(v * 1000) / 1000;

/** "tire_R_195_60_15_standard" → "195/60R15" (null if the name has no size). */
export function tireSizeFromPart(part) {
  const m = /(\d{3})_(\d{2})_(\d{2})/.exec(part || "");
  return m ? `${m[1]}/${m[2]}R${m[3]}` : null;
}

/** The gearbox a design gets: the adjustable box with enough gears. */
export function gearboxFor(d, cfg) {
  const n = d.gearCount || 5;
  return cfg.gearboxes[Math.max(n, 5)] || cfg.gearboxes[6];
}

/**
 * buildConfig(design, profile, basePcText) → { pc, info, gearbox, notes }.
 * pc and info are the file texts; notes are warnings to show with the export.
 */
export function buildConfig(d, profile, baseText) {
  const cfg = profile.config;
  const base = parseJBeam(baseText);
  const parts = { ...(base.parts || {}) };
  const vars = { ...(base.vars || {}) };
  const notes = [];

  const box = gearboxFor(d, cfg);
  const rs = ratios(d);
  parts[cfg.engineSlot] = partName(d, profile);
  parts[cfg.gearboxSlot] = box.part;
  parts[cfg.finalDriveSlot] = cfg.finalDrivePart;
  if (profile.flywheelSlot) parts[profile.flywheelSlot] = flywheelPartName(d, profile);
  for (let i = 0; i < box.gears; i++) {
    // a 4-speed design in a 5-speed box: the extra top gear repeats the last one
    vars[`$gear_${i + 1}`] = r3(rs[Math.min(i, rs.length - 1)]);
  }
  vars[cfg.finalDriveVar] = r3(d.finalDrive);
  if (rs.length < box.gears) {
    notes.push(`The ${profile.name} has no adjustable ${rs.length}-speed, so this uses the ${box.label} with ` +
      `gear ${rs.length + 1} set the same as gear ${rs.length}: shifting into it changes nothing.`);
  }

  // the car keeps its own tyres; say so if they aren't the size the gearing was worked out for
  const tirePart = Object.entries(parts).find(([k, v]) => /^tire_R/.test(k) && v)?.[1];
  const carTire = tireSizeFromPart(tirePart);
  if (carTire && carTire !== d.tire) {
    const pct = Math.round((tireRadius(carTire) / tireRadius(d.tire) - 1) * 100);
    notes.push(`The car keeps its own ${carTire} tyres; the gearing was set up on ${d.tire}.` +
      (pct ? ` Every speed in every gear will be about ${Math.abs(pct)}% ${pct > 0 ? "higher" : "lower"} than the tool shows.` : ""));
  }

  const pc = { format: base.format || 2, mainPartName: base.mainPartName, model: base.model, parts, vars };
  if (base.paints) pc.paints = base.paints;

  const a = analyse(d, 50);
  const info = {
    Configuration: `Crankcase: ${d.name}`,
    Description: `${d.name}, designed in Crankcase, with ${box.label.toLowerCase()} gearing to match.`,
    "Config Type": "Custom",
    Drivetrain: cfg.drivetrain,
    Transmission: box.transmission,
    "Induction Type": "NA",
    "Fuel Type": "Gasoline",
    Propulsion: "ICE",
    Power: Math.round(hp(a.peakPower)),
    Torque: Math.round(a.peakTorque),
    PowerPeakRPM: `${Math.round(a.peakPowerRpm)}`,
    TorquePeakRPM: `${Math.round(a.peakTorqueRpm)}`,
    "Engine Mass": Math.round(mass(d)),
  };
  return { pc: JSON.stringify(pc, null, 2), info: JSON.stringify(info, null, 2), gearbox: box, notes };
}
