// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
// Does the design fit the target car? Packaging checks against a profile.

import { dimensions, mass, blockNodes, layoutName } from "./geometry.js";
import { engineParts } from "./mesh.js";
import { familyFor } from "./profiles.js";
import { soundFor } from "./sounds.js";
import { durability } from "./parts.js";

const cm = (m) => `${Math.round(Math.abs(m) * 100)} cm`;
/** Less than this to spare counts as tight: it fits, but with no room for real-world plumbing. */
export const TIGHT = 0.03;
const level = (spare) => (spare < 0 ? "fail" : spare < TIGHT ? "warn" : "ok");

/** { ok, checks: [{level: "ok"|"warn"|"fail"|"info", text}], nodes, family } */
export function checkFit(d, profile, a) {
  const fam = familyFor(profile, d.layout);
  const dim = dimensions(d);
  const nodes = blockNodes(d, fam.anchor);
  const bay = profile.bay;
  const checks = [];

  const front = fam.anchor.y - dim.length;
  const spareLength = front - bay.frontY;
  checks.push(spareLength >= 0
    ? { level: level(spareLength), text: `Length ${Math.round(dim.length * 100)} cm: ${spareLength < TIGHT ? "tight" : "fits"}, ${cm(spareLength)} to spare in front.` }
    : { level: "fail", text: `Length ${Math.round(dim.length * 100)} cm: ${cm(spareLength)} too long, it would sit in the radiator. Fewer cylinders per bank or a smaller bore.` });

  const spareWidth = bay.maxHalfWidth - dim.topHalf;
  checks.push(spareWidth >= 0
    ? { level: level(spareWidth * 2), text: `Width ${Math.round(dim.topHalf * 200)} cm: ${spareWidth * 2 < TIGHT ? "tight" : "fits"}, ${cm(spareWidth * 2)} to spare.` }
    : { level: "fail", text: `Width ${Math.round(dim.topHalf * 200)} cm: ${cm(spareWidth * 2)} too wide for the bay.` });

  const top = fam.anchor.z + dim.height;
  const spareHeight = bay.maxTopZ - top;
  checks.push(spareHeight >= 0
    ? { level: level(spareHeight), text: `Height ${Math.round(dim.height * 100)} cm: ${spareHeight < TIGHT ? "tight, " : ""}clears the hood by ${cm(spareHeight)}.` }
    : { level: "fail", text: `Height ${Math.round(dim.height * 100)} cm: ${cm(spareHeight)} into the hood. A shorter stroke lowers the deck.` });

  const m = mass(d), dm = m - fam.donorMass;
  checks.push({
    level: "info",
    text: `Mass about <b>${Math.round(m)} kg</b>, ${Math.abs(dm) < 3 ? "the same as" : `${Math.round(Math.abs(dm))} kg ${dm > 0 ? "heavier" : "lighter"} than`} ` +
      `the ${fam.donorLabel}. ${dm > 15 ? "More weight over the front axle: expect more understeer." : dm < -15 ? "Less weight over the front: sharper turn-in." : ""}`,
  });

  if (a) {
    const rating = torqueRating(d, a.peakTorque);
    checks.push({ level: "info", text: `Rated to <b>${rating} N·m</b> (peak ${Math.round(a.peakTorque)} N·m); BeamNG damages it above that.` });
  }
  checks.push({ level: "info", text: profile.gearboxNote });
  if (checks.some((c) => c.level === "warn")) {
    checks.push({ level: "info", text: "Tight means it fits in the game, but a real engine would have no room for exhaust, plugs and hoses there. In BeamNG the engine doesn't collide with its own car, so overlap only changes how crashes deform." });
  }
  const sound = soundFor(d);
  checks.push({
    level: "info",
    text: `Its own ${layoutName(d)} model. Mounts, intake, exhaust and radiator come from the <b>${fam.donorLabel}</b>; ` +
      (sound ? `the sound is a stock ${sound.engine.split("_")[0].replace(/^b4p$/, "boxer")} recording` : `the sound is the ${fam.donorLabel}'s`) +
      `, tuned to ${d.cylinders} cylinders.`,
  });

  return {
    ok: !checks.some((c) => c.level === "fail"), checks, nodes, family: fam, name: layoutName(d),
    parts: engineParts(d, fam.anchor),
  };
}

/**
 * Torque the engine is built to survive: peak torque with headroom, less for
 * lighter builds, never under 15% above peak (BeamNG damages it above this).
 */
export function torqueRating(d, peakTorque) {
  const build = { road: 1.15, sport: 1.0, race: 0.85 }[d.build] ?? 1;
  const parts = d.duration != null ? durability(d) : 1 - 0.25 * d.friction;
  return Math.round(peakTorque * Math.max(1.15, 1.3 * build * parts));
}
