// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Car profiles: what Crankcase needs to know to put an engine in a car.
// The engine's behaviour, size and mass come from the design; a profile says
// which slot to fill, where the engine bay is, and which of the car's own
// engines to borrow the look, sound and neighbouring parts from (the donor),
// per layout family. Donor files are read from the game at export time.
//
// Coordinates are BeamNG's vehicle frame: +x left, -y forward, +z up, metres.
// The anchor is the rear face of the block, on the centreline, at the bottom.

export const PROFILES = {
  bx: {
    id: "bx",
    name: "Ibishu BX",
    vehicle: "bx",          // vehicles/<vehicle>/ inside the mod
    zip: "bx",              // content/vehicles/<zip>.zip in the game
    slotType: "bx_engine",
    flywheelSlot: "bx_flywheel", // inside every BX gearbox; its parts add engine inertia
    layoutNote: "front engine, longitudinal, rear-wheel drive",
    families: {
      inline: {
        donorFile: "vehicles/bx/bx_engine_i4_large.jbeam",
        donorPart: "bx_engine_i4_2.4",
        donorLabel: "BX 2.4 L I4",
        donorMass: 174,
        anchor: { x: 0, y: -0.97, z: 0.31 },
        // the stock engine's own long block and ECU; the design replaces both
        drop: ["bx_engine_internals_i4_large", "bx_engine_ecu_i4_large"],
        // forced induction is written as a part for this intake slot: a turbo from this stock
        // turbo (its pipework, intercooler, nodes and sounds), a supercharger from the slot's
        // stock intake; the design sets everything that decides how they behave
        intake: { slot: "bx_intake_i4_large", turboTemplate: "bx_intake_i4_large_stage2", turboLabel: "single turbo" },
        // the design's exhaust is written as a part for this slot, on the stock exhaust's pipes
        exhaust: { slot: "bx_exhaust_i4", template: "bx_exhaust_i4", file: "vehicles/bx/bx_exhaust_i4.jbeam" },
      },
      v: {
        donorFile: "vehicles/bx/bx_engine_v8_4.5.jbeam",
        donorPart: "bx_engine_v8_4.5",
        donorLabel: "BX 4.5 L V8",
        donorMass: 207,
        anchor: { x: 0, y: -1.044, z: 0.292 },
        drop: ["pickup_engine_v8_internals", "pickup_engine_v8_ecu"],
        // the V8's stock turbos are a pair, one per bank, with their own exhaust manifolds
        intake: { slot: "bx_intake_v8", turboTemplate: "bx_turbo_v8_stage3", turboLabel: "twin turbos (one per bank)" },
        exhaust: { slot: "bx_exhaust_v8", template: "bx_exhaust_v8", file: "vehicles/bx/bx_exhaust_v8.jbeam" },
      },
    },
    // Flat engines borrow the inline donor (the BX has no boxer).
    familyFor: { inline: "inline", flat: "inline", v: "v" },
    // Space for the engine's node box, estimated from the stock engines that
    // fit (the V8 reaches y = -1.63; the radiator sits at y = -1.62; the I4's
    // top nodes are at z = 0.79).
    bay: { frontY: -1.66, maxHalfWidth: 0.36, maxTopZ: 0.84, minBottomZ: 0.27 },
    gearboxNote: "BeamNG gives the BX's gearboxes no torque rating, so there's no gearbox limit to check.",
    // For gearing: stock mass from the game's BX configs (1,281 to 1,336 kg), drag area
    // backed out of the stock 2.0's listed top speed, grip as tire friction x rear-axle share.
    car: { mass: 1300, cda: 0.58, crr: 0.012, grip: 0.45 },
    gearingNote: "Export also writes a BX config with this gearing: your engine, the Race 5-Speed Sequential (or Race 6-Speed Manual for six gears) and the Race Adjustable final drive, with these ratios already set. The stock 5-speed is fixed at 3.32 / 1.90 / 1.31 / 1.00 / 0.84.",
    // Export writes a vehicle config (.pc) starting from this stock config, with the
    // engine, an adjustable gearbox and final drive swapped in and the ratios set.
    config: {
      base: "vehicles/bx/200bx_type_l_M.pc",
      engineSlot: "bx_engine",
      gearboxSlot: "bx_transmission",
      // adjustable gearboxes by gear count; each has $gear_1 ... $gear_n sliders
      gearboxes: {
        5: { part: "bx_transmission_5M_sequential", label: "Race 5-Speed Sequential", gears: 5, transmission: "Sequential" },
        6: { part: "bx_transmission_6M_race", label: "Race 6-Speed Manual", gears: 6, transmission: "Manual" },
      },
      finalDriveSlot: "bx_finaldrive_R",
      finalDrivePart: "bx_finaldrive_R_race",
      finalDriveVar: "$finaldrive_R",
      drivetrain: "RWD",
    },
  },
};

export const DEFAULT_PROFILE = "bx";

export function familyFor(profile, layout) {
  return profile.families[profile.familyFor[layout]];
}
