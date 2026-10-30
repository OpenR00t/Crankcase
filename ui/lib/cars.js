// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// The target cars: every car and truck in the game and in active mods, each
// worked out from its own files (detect.js) the first time it's needed. The
// hand-written profiles stay as they are; they're the checked references.

import { parseJBeam } from "./jbeamparse.js";
import { detectProfile, partIndex } from "./detect.js";
import { PROFILES } from "./profiles.js";

const DRIVEABLE = new Set(["car", "truck"]);

const readJson = (text) => { try { return parseJBeam(text || "{}"); } catch { return {}; } };

/**
 * The car list: [{ id, name, years, info }], sorted by name. Cars that share a name
 * (an old and a new model) get their years added.
 */
export async function listCars(platform, names) {
  const rows = (await platform.listVehicles())
    .map(({ id, info }) => ({ id, info: readJson(info) }))
    .filter(({ info }) => info.Type == null || DRIVEABLE.has(String(info.Type).toLowerCase()));
  const nameOf = ({ id, info }) => {
    if (PROFILES[id]) return PROFILES[id].name;
    const n = info.Name;
    const model = typeof n === "string" && /^vehiclesData\./.test(n) ? names[n] ?? id : n || id;
    return info.Brand && !String(model).startsWith(info.Brand) ? `${info.Brand} ${model}` : String(model);
  };
  const cars = rows.map((r) => ({ id: r.id, name: nameOf(r), years: r.info.Years, info: r.info }));
  const count = {};
  for (const c of cars) count[c.name] = (count[c.name] ?? 0) + 1;
  for (const c of cars) if (count[c.name] > 1 && c.years?.min) c.name += ` (${c.years.min}${c.years.max && c.years.max !== c.years.min ? `–${c.years.max}` : ""})`;
  return cars.sort((a, b) => a.name.localeCompare(b.name));
}

/** Detects profiles on demand, one at a time, and remembers them. */
export function carDetector(platform) {
  let common = null, names = null;
  const done = new Map();
  let queue = Promise.resolve();
  const shared = async () => {
    if (!common) common = partIndex(await platform.vehicleBundle("common"));
    if (!names) names = await platform.vehicleNames();
  };
  return {
    names: async () => { await shared(); return names; },
    known: (id) => PROFILES[id] ?? done.get(id) ?? null,
    /** The profile for a car (hand-written if there is one), detecting it if needed. */
    detect(id, label) {
      if (PROFILES[id]) return Promise.resolve(PROFILES[id]);
      if (done.has(id)) return Promise.resolve(done.get(id));
      const job = queue.then(async () => {
        if (done.has(id)) return done.get(id);
        await shared();
        let prof;
        try {
          prof = detectProfile(id, { files: await platform.vehicleBundle(id) }, common, names);
        } catch (e) {
          prof = { id, name: label ?? id, vehicle: id, support: { ok: false, reason: `couldn't read its files (${e.message ?? e})` } };
        }
        if (label) prof.name = label;
        done.set(id, prof);
        return prof;
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}
