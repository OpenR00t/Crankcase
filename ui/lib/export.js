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
import { brakeTorque, redline, displacement, analyse } from "./engine.js";
import { turboSpec, turboBoost, boostEfficiency, superchargerSpec, superchargerBoost, superchargerLoss, hasTurbo, hasSupercharger, inductionLabel, naturallyAspirated } from "./induction.js";
import { crankInertia, FLYWHEELS, frictionFit, pumpingTorque } from "./rotating.js";
import { mass, layoutName } from "./geometry.js";
import { familyFor } from "./profiles.js";
import { torqueRating } from "./fit.js";
import { placedBlockNodes, placedEngineParts, placedInductionParts } from "./frame.js";
import { writeDae, writeDaeMeshes } from "./dae.js";
import { soundFor } from "./sounds.js";

export const MOD_NAME = "crankcase";

export function slug(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s.slice(0, 40) || "engine";
}

export function partName(d, profile) {
  return `${profile.slotType}_crankcase_${slug(d.name)}`;
}

/** The forced induction part: for the donor family's intake slot. */
export function inductionPartName(d, profile) {
  const fam = familyFor(profile, d.layout);
  return fam.intake ? `${fam.intake.slot}_crankcase_${slug(d.name)}` : null;
}

/** The forced induction's own model (turbos, blower). */
export function inductionMeshName(d) {
  return `crankcase_${slug(d.name)}_induction`;
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
  // naturally aspirated: a turbo multiplies this table itself in the game
  const na = naturallyAspirated(d);
  const add = (rpm) => friction + dynamicFriction * rpm * Math.PI / 30;
  const at = (rpm) => Math.max(0, brakeTorque(na, rpm)) + add(rpm);
  const rows = [["rpm", "torque"], [0, 0], [500, r1(0.6 * at(1000))]];
  for (let rpm = 1000; rpm <= red + 500; rpm += 250) rows.push([rpm, r1(at(rpm))]);
  return rows;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Build the engine part from the donor file's text. Returns { name, part, text, dae, mesh }.
 * `donorText` may also be a list: the donor's file first, then any files holding the
 * intake parts forced induction is built on (see donorFiles).
 */
export function buildEngine(d, profile, donorText) {
  const fam = familyFor(profile, d.layout);
  const texts = [donorText].flat();
  const donorFile = Object.assign({}, ...texts.slice(1).reverse().map((t) => parseJBeam(t)), parseJBeam(texts[0]));
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
  // net, at the flywheel, with any boost: the internals are rated for what the engine really makes
  const peak = Math.max(...torqueTable(d, 0, 0).slice(1).map((r) => r[1]), analyse(d, 50).peakTorque);
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
  const block = new Map(placedBlockNodes(d, fam).map((row) => [row[0], row]));
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
  const dae = writeDae(mesh, placedEngineParts(d, fam));

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
  let induction = null;
  if (d.induction && d.induction !== "none") {
    if (!fam.intake) throw new Error(`no intake slot known for the ${fam.donorLabel}`);
    induction = inductionPartName(d, profile);
    parts[induction] = buildInduction(d, fam, donorFile, donor, me, engineGroup);
  }
  const daeText = induction
    ? writeDaeMeshes([{ name: mesh, parts: placedEngineParts(d, fam) }, { name: inductionMeshName(d), parts: placedInductionParts(d, fam) }])
    : dae;
  return { name, part, flywheel, induction, text: writeJBeam(parts, header), dae: daeText, mesh };
}

/** The files an export reads for a family: the donor's, then any its intake parts live in. */
export function donorFiles(fam) {
  return [...new Set([fam.donorFile, ...(fam.intake?.files ?? [])])];
}

/**
 * The forced induction part, for the intake slot. A turbo is built on the stock turbo
 * for this engine family (its pipework, intercooler, nodes and sounds), a supercharger
 * alone on the slot's stock intake; either way the look is the design's own model,
 * and every number that decides how it behaves comes from the design.
 *
 * BeamNG has no knock, and its turbo and supercharger use the engine's table a little
 * differently from Crankcase's model, so the part carries the difference: the turbo's
 * efficiency where it's boosting, and a torque multiplier (torqueModMult, applied only
 * while this part is fitted) where the supercharger is doing the work. With them the
 * game makes the torque Crankcase predicts at full throttle.
 */
function buildInduction(d, fam, donorFile, engine, me, engineGroup) {
  const slot = fam.intake.slot;
  const turbo = hasTurbo(d), sc = hasSupercharger(d);
  // a turbo builds on the car's own stock turbo when it has one; a supercharger alone,
  // or a turbo for an engine the car never had one for, on the slot's stock intake
  const onStockTurbo = turbo && !!fam.intake.turboTemplate;
  let templateName = fam.intake.turboTemplate;
  if (!onStockTurbo) {
    const row2 = (engine.slots2 || []).find((r) => Array.isArray(r) && r[0] === slot);
    const row1 = (engine.slots || []).find((r) => Array.isArray(r) && r[0] === slot);
    templateName = row2?.[3] ?? row1?.[1] ?? fam.intake.defaultIntake;
  }
  const template = donorFile[templateName];
  if (!template) throw new Error(`${templateName || `the ${slot} intake`} not found in ${fam.donorFile}`);
  const part = clone(template);
  const red = redline(d);
  const na = naturallyAspirated(d);
  const fr = (rpm) => me.friction + me.dynamicFriction * rpm * Math.PI / 30;
  const PER_PSI = 0.0000087 * 6894.757293178;
  const tspec = turbo ? turboSpec(d) : null, sspec = sc ? superchargerSpec(d) : null;
  const scCoef = (rpm) => (sc ? 1 + PER_PSI * superchargerBoost(d, rpm, sspec) - superchargerLoss(d, rpm, sspec) : 1);

  // what the game has to make: Crankcase's torque, from the exported table
  const mult = [], engineDef = tspec ? tspec.engineDef.map((p) => [...p]) : null;
  for (let rpm = 0; rpm <= red + 500; rpm += 250) {
    let m = 1;
    if (rpm >= 1000 && rpm <= red) {
      const table = Math.max(0, brakeTorque(na, rpm)) + fr(rpm);
      const want = (brakeTorque(d, rpm) + fr(rpm)) / table;
      const psi = turbo ? turboBoost(d, rpm, tspec) : 0;
      if (turbo && psi >= 0.5) {
        const k = engineDef.findIndex((p) => p[0] === rpm);
        const e = (want / scCoef(rpm) - 1) / (PER_PSI * psi);
        if (k >= 0) engineDef[k][1] = +Math.min(1.5, Math.max(0, e)).toFixed(4);
      } else if (sc) {
        const t = turbo ? 1 + PER_PSI * psi * boostEfficiency(d, rpm, tspec) : 1;
        m = want / (scCoef(rpm) * t);
      }
    }
    mult.push([rpm, +m.toFixed(4)]);
  }

  part.information = { authors: "Crankcase", name: `Crankcase: ${d.name} ${inductionLabel(d)} (${d.boost} psi)`, value: 0 };
  part.slotType = slot;
  delete part.variables;
  const me2 = (part.mainEngine = { ...(part.mainEngine || {}) });
  delete me2.torqueModIntake; // the stock part's own extra torque: the design's numbers already say it all
  delete me2.turbocharger;
  delete me2.supercharger;
  if (mult.some(([, m]) => Math.abs(m - 1) > 0.002)) me2.torqueModMult = [["rpm", "torque"], ...mult];

  if (turbo) {
    part.variables = [
      ["name", "type", "unit", "category", "default", "min", "max", "title", "description"],
      ["$wastegateStart", "range", "psi", "Engine", tspec.wastegateStart, 1, Math.max(30, Math.ceil(d.boost + 10)),
        "Turbo Boost Pressure", "Pressure at which the wastegate begins to open (boost settles about 0.5 psi above)", { stepDis: 0.5 }],
    ];
    part.turbocharger = Object.assign(part.turbocharger || {}, {
      wastegateStart: "$wastegateStart",
      wastegateLimit: `$=$wastegateStart+${tspec.wastegateRange}`,
      maxExhaustPower: tspec.maxExhaustPower,
      backPressureCoef: tspec.backPressureCoef,
      frictionCoef: tspec.frictionCoef,
      inertia: tspec.inertia,
      pressureRatePSI: tspec.pressureRatePSI,
      turboSizeCoef: tspec.turboSizeCoef,
      pressurePSI: tspec.pressurePSI,
      engineDef,
    });
    me2.turbocharger = "turbocharger";
  } else {
    delete part.turbocharger;
  }
  if (sc) {
    const s = sspec;
    part.supercharger = {
      type: s.beamType,
      twistedLobes: s.type === "roots",
      lobes: s.type === "screw" ? 4 : 3,
      gearRatio: s.gearRatio,
      clutchEngageRPM: 0,
      ...(s.clutchDisengageRPM ? { clutchDisengageRPM: s.clutchDisengageRPM, clutchDisengageRange: s.clutchDisengageRange } : {}),
      pressureRatePSI: s.pressureRatePSI,
      pressurePSIPer1kRPM: s.pressurePSIPer1kRPM,
      crankLossPer1kRPM: s.crankLossPer1kRPM,
      whineLoopEvent: "event:>Vehicle>Forced_Induction>Supercharger_05>supercharger",
      whineVolumePerPSI: 0.03,
      whinePitchPer10kRPM: s.type === "centrifugal" ? 0.4 : 1.1,
      boostController: [[0, 0.2], [100, 1]],
    };
    me2.supercharger = "supercharger";
  }

  // the look: keep the stock intercooler and air filter (they sit at the front of the car),
  // drop the stock turbo's engine-mounted pipework, add the design's own model
  const keep = (row) => Array.isArray(row) && typeof row[0] === "string" && row[0] !== "mesh" &&
    (onStockTurbo ? /intercooler|filter|airbox/i.test(row[0]) : true);
  part.flexbodies = [["mesh", "[group]:", "nonFlexMaterials"], ...(part.flexbodies || []).filter(keep),
    [inductionMeshName(d), [engineGroup]]];
  delete part.props;
  return part;
}
