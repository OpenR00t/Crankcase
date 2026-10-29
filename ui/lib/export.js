// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Writes a design as a complete BeamNG.drive engine part for a target car.
//
// The donor (one of the car's own engines, read from the game) supplies what
// is specific to the car: its mesh, sounds, mounts and neighbouring slots.
// Everything about the engine itself comes from the design: the torque table
// in N m, redline and rev limiter, inertia, damage limits, and the size and
// mass of its eight block nodes.

import { parseJBeam, writeJBeam } from "./jbeamparse.js";
import { brakeTorque, redline, displacement } from "./engine.js";
import { crankInertia, FLYWHEELS, frictionFit, pumpingTorque } from "./rotating.js";
import { blockNodes, mass, layoutName } from "./geometry.js";
import { familyFor } from "./profiles.js";
import { torqueRating } from "./fit.js";
import { engineParts } from "./mesh.js";
import { writeDae } from "./dae.js";
import { soundFor } from "./sounds.js";

export const MOD_NAME = "crankcase";

export function slug(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s.slice(0, 40) || "engine";
}

export function partName(d, profile) {
  return `${profile.slotType}_crankcase_${slug(d.name)}`;
}

export function flywheelPartName(d, profile) {
  return `${profile.flywheelSlot}_crankcase_${slug(d.name)}`;
}

export function exportRelativePath(d, profile, ext = "jbeam") {
  return `mods/unpacked/${MOD_NAME}/vehicles/${profile.vehicle}/crankcase_${slug(d.name)}.${ext}`;
}

/** The vehicle config's info file: BeamNG pairs info_<config>.json with <config>.pc. */
export function infoRelativePath(d, profile) {
  return `mods/unpacked/${MOD_NAME}/vehicles/${profile.vehicle}/info_crankcase_${slug(d.name)}.json`;
}

export function meshName(d) {
  return `crankcase_${slug(d.name)}_engine`;
}

const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The torque table BeamNG gets. BeamNG subtracts the engine's own friction
 * (friction + dynamicFriction x rad/s) from this table, and the design's
 * torque is already net of friction, so that amount is added back.
 */
export function torqueTable(d, friction, dynamicFriction) {
  const red = redline(d);
  const add = (rpm) => friction + dynamicFriction * rpm * Math.PI / 30;
  const at = (rpm) => Math.max(0, brakeTorque(d, rpm)) + add(rpm);
  const rows = [["rpm", "torque"], [0, 0], [500, r1(0.6 * at(1000))]];
  for (let rpm = 1000; rpm <= red + 500; rpm += 250) rows.push([rpm, r1(at(rpm))]);
  return rows;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Build the engine part from the donor file's text. Returns { name, part, text, dae, mesh }. */
export function buildEngine(d, profile, donorText) {
  const fam = familyFor(profile, d.layout);
  const donorFile = parseJBeam(donorText);
  const donor = donorFile[fam.donorPart];
  if (!donor) throw new Error(`${fam.donorPart} not found in ${fam.donorFile}`);
  const part = clone(donor);
  const red = redline(d);
  const litres = displacement(d) * 1000;
  const name = partName(d, profile);

  part.information = {
    authors: "Crankcase",
    name: `Crankcase: ${d.name} (${layoutName(d)} ${litres.toFixed(1)} L)`,
    value: 0,
  };
  part.slotType = profile.slotType;
  if (Array.isArray(part.slots2)) {
    part.slots2 = part.slots2.filter((row, i) => i === 0 || !fam.drop.includes(row[0]));
  }

  const me = part.mainEngine;
  const peak = Math.max(...torqueTable(d, 0, 0).slice(1).map((r) => r[1])); // net, at the flywheel
  // the design's own friction and engine braking, in BeamNG's terms (not the donor engine's)
  const fit = frictionFit(d);
  me.friction = Math.round(fit.friction * 100) / 100;
  me.dynamicFriction = Math.round(fit.dynamicFriction * 1e5) / 1e5;
  me.engineBrakeTorque = Math.round(pumpingTorque(d) * 10) / 10;
  me.torque = torqueTable(d, me.friction, me.dynamicFriction);
  me.maxRPM = red + 300;
  me.revLimiterRPM = red;
  me.revLimiterType = "timeBased";
  me.revLimiterCutTime = 0.1;
  me.inertia = r3(crankInertia(d)); // the flywheel and clutch are their own part, below
  const rating = torqueRating(d, peak);
  me.maxTorqueRating = rating;
  me.maxOverTorqueDamage = Math.round(rating * 1.2);
  const sound = soundFor(d);
  if (sound && part.soundConfig) part.soundConfig.sampleName = sound.engine;
  if (sound && part.soundConfigExhaust) part.soundConfigExhaust.sampleName = sound.exhaust;
  for (const key of ["soundConfig", "soundConfigExhaust"]) {
    if (part[key]) part[key].fundamentalFrequencyCylinderCount = d.cylinders;
  }
  if (part.vehicleController && "highShiftUpRPM" in part.vehicleController) {
    part.vehicleController.highShiftUpRPM = red - 200;
  }

  // Block nodes: the design's size, placed at the donor's anchor, and its mass
  // shared over the eight nodes (the two mount nodes keep the donor's weight).
  const block = new Map(blockNodes(d, fam.anchor).map((row) => [row[0], row]));
  const perNode = r1((mass(d) - 7) / 8);
  part.nodes = part.nodes.map((row) => {
    if (!Array.isArray(row) || !block.has(row[0])) return row;
    const [, x, y, z] = block.get(row[0]);
    const opts = typeof row[4] === "object" && row[4] ? { ...row[4] } : {};
    opts.nodeWeight = perNode;
    return [row[0], x, y, z, opts];
  });

  // The look: the generated model replaces the donor's engine meshes (and any
  // props spinning on them, like the V8's pulleys). It's attached to the
  // engine's node group so it moves and deforms with the block.
  let group = null;
  for (const row of part.nodes) {
    if (row && !Array.isArray(row) && typeof row === "object" && "group" in row) group = row.group;
    if (Array.isArray(row) && row[0] === "e1r") break;
  }
  const engineGroup = Array.isArray(group) ? group[0] : group || `${profile.vehicle}_engine`;
  const mesh = meshName(d);
  part.flexbodies = [["mesh", "[group]:", "nonFlexMaterials"], [mesh, [engineGroup]]];
  delete part.props;
  const dae = writeDae(mesh, engineParts(d, fam.anchor));

  const header = [
    `// Crankcase engine "${d.name}" for the ${profile.name}.`,
    `// ${layoutName(d)}, bore ${d.bore} mm, stroke ${d.stroke} mm (${litres.toFixed(2)} L), CR ${d.compression}:1 on ${d.fuel} fuel,`,
    d.duration != null
      ? `// ${d.build} build, cam ${d.duration}° / ${d.lift} mm, ${d.runner} cm runners (tuned ${d.tuneRpm} rpm), ${d.rings} rings, ${d.bearings} bearings, ${d.oil} oil, ${d.sump} sump.`
      : `// ${d.build} build, cam ${Math.round(d.cam * 100)}%, intake tuned for ${d.tuneRpm} rpm, friction build ${Math.round(d.friction * 100)}%.`,
    `// Behaviour, size, mass and model from the design (model in crankcase_${slug(d.name)}.dae);`,
    `// mounts and neighbouring parts from the stock ${fam.donorLabel}${sound ? `; sound: the game's ${sound.engine} recording` : ""}.`,
  ].join("\n");
  // The flywheel and clutch: a part for the gearbox's flywheel slot, adding its
  // inertia to the engine's (BeamNG's own flywheels work the same way).
  const parts = { [name]: part };
  let flywheel = null;
  if (profile.flywheelSlot) {
    const fw = FLYWHEELS[d.flywheel] ?? FLYWHEELS.stock;
    flywheel = flywheelPartName(d, profile);
    parts[flywheel] = {
      information: { authors: "Crankcase", name: `Crankcase: ${d.name} flywheel (${fw.label.toLowerCase()})`, value: 0 },
      slotType: profile.flywheelSlot,
      clutch: { uiName: "Clutch", additionalEngineInertia: fw.inertia, clutchMass: fw.clutchMass },
    };
  }
  return { name, part, flywheel, text: writeJBeam(parts, header), dae, mesh };
}
