// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// The sections: each one adds controls for one physical idea and explains,
// from the current numbers, what those controls are doing. Each section gives:
//
//   figures(d, a, ctx)     the numbers the section is about, always shown:
//                          [{ label, value, tip?, tone? }]
//   notes(d, a, ctx)       what's worth acting on, one short line each, with the
//                          detail behind a hover: [{ level, text, more? }],
//                          level "crit" (red), "warn" (yellow) or "info" (blue)
//   background(d, a, ctx)  how it works: reference text that doesn't change
//                          with the design's verdicts, folded away by default

import { BUILDS, FUELS, INJECTION, indicatedEfficiency, valveFlow, frictionTorque, redline, knockIndex, fuelLimit } from "./engine.js";
import { MANIFOLDS, CATS, MUFFLERS, PIPES, PIPE_LIMITS, PRIMARY_LIMITS, PIPE_SPEED, backPressure, headerTunedRpm, recommendedPipe,
  freeFlowing } from "./exhaust.js";
import { CAM, INTERNALS, overlap, tunedRpm, springFriction, durability, resolve } from "./parts.js";
import { TIRES, analyseGearing, ratios, tireRadius, SHIFT_STYLES, shiftTime } from "./gearing.js";
import { FLYWHEELS, CRANKS, crankInertia, flywheelInertia, totalInertia, revUp, dropIn, matchTime, equivalentMass, closedThrottleDrag, pumpingTorque } from "./rotating.js";
import { LAYOUTS, vAngle, layoutName } from "./geometry.js";
import { GEOMETRY } from "./locks.js";
import { INDUCTIONS, TURBO_LAYOUTS, SUPERCHARGERS, turboSpec, steadyBoost, boostEfficiency, fullBoostRpm, boostRiseTime,
  naturallyAspirated, hasTurbo, hasSupercharger, superchargerLoss, turboFactor, inductionLabel } from "./induction.js";
import { analyse as analyseEngine, superchargerDrive } from "./engine.js";
import { familyFor, PROFILES, DEFAULT_PROFILE } from "./profiles.js";

const ORD = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
const f0 = (v) => Math.round(v).toLocaleString("en-US");
const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);
const pct = (v) => `${Math.round(v * 100)}%`;
const crit = (text, more) => ({ level: "crit", text, more });
const warn = (text, more) => ({ level: "warn", text, more });
const info = (text, more) => ({ level: "info", text, more });
const fig = (label, value, tip, tone) => ({ label, value, tip, tone });
const torqueAt = (a, rpm) => {
  let best = 0;
  a.rpm.forEach((r, i) => { if (Math.abs(r - rpm) < Math.abs(a.rpm[best] - rpm)) best = i; });
  return a.torque[best];
};

const LAYOUT_NOTES = {
  inline: (d) =>
    `<b>${layoutName(d)}</b>: one row of cylinders and one cylinder head. Simple and narrow, but it gets long ` +
    "as cylinders are added. " +
    (d.cylinders === 6
      ? "An inline six is perfectly balanced: its forces cancel, so it runs very smoothly."
      : d.cylinders === 4
        ? "An inline four has an unbalanced shake at twice crank speed, which is why big fours use balance shafts."
        : "Odd cylinder counts fire unevenly between the ends of the crank and need balancing."),
  flat: (d) =>
    `<b>${layoutName(d)}</b>: cylinders lie flat in two banks facing each other, so opposite pistons cancel each ` +
    "other's shake. Very short and very low (a low centre of gravity), but wide, with two heads.",
  v: (d) =>
    `<b>${layoutName(d)}</b>: two banks at <b>${vAngle(d.cylinders)}°</b> sharing one crank. Half the length of an ` +
    "inline engine with the same cylinders, at the cost of width, two heads and more parts.",
};


export const SECTIONS = [
  {
    id: "displacement",
    title: "Displacement",
    tagline: "How much air the engine can swallow",
    intro:
      "Each piston sweeps a cylinder of air: <b>bore</b> is the cylinder's width, <b>stroke</b> is how far " +
      "the piston travels. All cylinders together give the <b>displacement</b>, taken in once every two " +
      "revolutions. More air lets more fuel burn, so torque grows roughly in step with displacement.",
    controls: [
      { key: "layout", label: "Layout", type: "choice", relayout: true,
        options: Object.entries(LAYOUTS).map(([k, l]) => [k, l.label]) },
      { key: "cylinders", label: "Cylinders", type: "choice",
        options: (d) => LAYOUTS[d.layout].counts.map((n) => [n, String(n)]) },
      { key: "bore", label: "Bore", unit: "mm", type: "range", min: GEOMETRY.bore.min, max: GEOMETRY.bore.max, step: 0.5, fmt: (v) => `${+v.toFixed(1)} mm` },
      { key: "stroke", label: "Stroke", unit: "mm", type: "range", min: GEOMETRY.stroke.min, max: GEOMETRY.stroke.max, step: 0.5, fmt: (v) => `${+v.toFixed(1)} mm` },
      { key: "build", label: "Rotating assembly", type: "choice",
        options: Object.entries(BUILDS).map(([k, b]) => [k, `${b.label} (${b.maxPistonSpeed} m/s)`]) },
    ],
    figures(d, a) {
      const bs = a.boreStroke;
      return [
        fig("Displacement", `${f2(a.litres)} L`, `${d.cylinders} × π/4 × ${d.bore}² × ${d.stroke} mm³`),
        fig("Per cylinder", `${Math.round((a.litres / d.cylinders) * 1000)} cc`),
        fig("Bore / stroke", `${f2(bs)} · ${bs > 1.05 ? "oversquare" : bs < 0.95 ? "undersquare" : "square"}`),
        fig("Redline", `${f0(a.redline)} rpm`,
          `Where mean piston speed reaches the ${BUILDS[d.build].label.toLowerCase()} build's ${BUILDS[d.build].maxPistonSpeed} m/s with a ${d.stroke} mm stroke`),
      ];
    },
    notes(d, a) {
      const out = [];
      const perCyl = a.litres / d.cylinders;
      if (a.boreStroke > 1.05) {
        out.push(info("Oversquare: revs freely, less low-rpm torque",
          "Wide pistons leave room for big valves, and the short stroke keeps piston speed down, so it can rev. " +
          "The price is a flatter, wider combustion chamber and less torque at low rpm for its size."));
      } else if (a.boreStroke < 0.95) {
        out.push(info("Undersquare: strong low down, redline comes early",
          "A compact chamber and long lever arm give strong low-rpm torque, but the pistons travel far each turn, " +
          "so piston speed caps the rpm early."));
      }
      if (perCyl > 0.65) {
        out.push(warn(`Big cylinders (${Math.round(perCyl * 1000)} cc): slow to rev`,
          "The flame has far to travel and the heavy parts resist revving. That's why large engines usually get " +
          "more cylinders rather than bigger ones."));
      } else if (perCyl < 0.3) {
        out.push(info(`Small cylinders (${Math.round(perCyl * 1000)} cc): rev easily, little torque each`,
          "Each cylinder makes little torque, and more cylinders mean more friction and parts."));
      }
      return out;
    },
    background(d) {
      return [
        LAYOUT_NOTES[d.layout](d),
        "Mean piston speed = 2 × stroke × rpm ÷ 60. Each rotating-assembly build has a piston speed it survives; " +
        "that speed, with your stroke, sets the redline. Shorten the stroke to rev higher.",
      ];
    },
  },
  {
    id: "breathing",
    title: "Breathing",
    tagline: "How full the cylinders actually get",
    intro:
      "Displacement is the most air the engine <i>could</i> take. <b>Volumetric efficiency (VE)</b> is the " +
      "share it really gets at each rpm. The torque curve is essentially the VE curve scaled up, so " +
      "<b>this is where the curve's shape comes from</b>.",
    controls: [
      { key: "duration", label: "Cam duration", type: "range", min: CAM.minDuration, max: CAM.maxDuration, step: 2,
        fmt: (v) => `${v}° ` + (v < 216 ? "(mild)" : v < 236 ? "(sport)" : v < 256 ? "(hot)" : "(race)") },
      { key: "lift", label: "Valve lift", unit: "mm", type: "range", min: CAM.minLift, max: CAM.maxLift, step: 0.1,
        fmt: (v) => `${v.toFixed(1)} mm` },
      { key: "runner", label: "Intake runner length", type: "range", min: 20, max: 75, step: 1,
        fmt: (v) => `${v} cm → ${tunedRpm(v).toLocaleString("en-US")} rpm` },
    ],
    figures(d, a) {
      return [
        fig("Cam breathes best", `${f0(a.camPeakRpm)} rpm`, `${d.duration}° duration, ${overlap(d)}° overlap`,
          a.camPeakRpm > a.redline ? "crit" : null),
        fig("Runners tuned to", `${f0(d.tuneRpm)} rpm`),
        fig("Torque at 2,000", `${f0(torqueAt(a, 2000))} N·m`),
        fig("Peak torque", `${f0(a.peakTorque)} N·m @ ${f0(a.peakTorqueRpm)}`),
        fig("Peak power", `${f0(a.peakPower)} kW @ ${f0(a.peakPowerRpm)}`),
      ];
    },
    notes(d, a) {
      const out = [];
      if (a.camPeakRpm > a.redline) {
        out.push(crit(`Cam peaks above the redline (${f0(a.camPeakRpm)} vs ${f0(a.redline)} rpm)`,
          "The engine never reaches its best breathing: it pays the low-rpm penalty without collecting the reward. " +
          "Shorten the stroke (or pick a stronger build) to rev higher, or choose a shorter-duration cam."));
      }
      const choke = a.vp[a.vp.length - 1];
      const loss = 1 - 1 / (1 + Math.pow(choke / (30 * valveFlow(d)), 8));
      if (loss > 0.03) {
        out.push(warn(`Valves choke near redline: −${pct(loss)} filling`,
          `At redline the pistons average ${f1(choke)} m/s and the air is starting to outrun the valves. ` +
          "More lift (or a bigger bore, for bigger valves) helps."));
      } else if (valveFlow(d) < 0.98) {
        out.push(warn("Lift is low for the bore: the valves limit high-rpm flow",
          `Past about ${(0.27 * 0.45 * d.bore).toFixed(1)} mm the valve is clear of its seat; yours is below that.`));
      }
      if (valveFlow(d) > 1.03) {
        out.push(info("High lift: free-flowing head, stiffer valve springs",
          "Well past the point where the valve clears its seat, so the head flows freely at high rpm; the springs " +
          "needed add friction (see Internals)."));
      }
      if (Math.abs(d.tuneRpm - a.camPeakRpm) > 2000) {
        out.push(info(`Runners and cam work ${f0(Math.abs(d.tuneRpm - a.camPeakRpm))} rpm apart: a wider, flatter curve`,
          "When the runner's ram effect and the cam's best breathing land at different rpm, each fills in where the " +
          "other is weak. Bring them together for a sharper peak."));
      }
      return out;
    },
    background(d) {
      const valve = 0.45 * d.bore;
      return [
        "<b>Cam duration</b> is how long each valve stays open, in degrees of crank rotation. <b>Overlap</b> is when the " +
        "intake opens before the exhaust has closed (the shaded band in the valve diagram). At high rpm the moving " +
        "exhaust gas helps pull fresh charge in; at low rpm it isn't moving fast enough, and some charge escapes or " +
        "gets pushed back.",
        `<b>Lift</b>: intake valves here are about ${f0(valve)} mm across (they scale with the bore). Past about ` +
        `${(0.27 * valve).toFixed(1)} mm the valve is clear of its seat and more lift adds little.`,
        "<b>Runners</b>: the pressure wave bouncing along the runner arrives just as the valve closes and rams in " +
        "extra air. Long runners tune low, short ones high. Some road cars switch between two lengths for this reason.",
        "Peak torque sits near the VE peak; peak power comes later, because power is torque × rpm and keeps climbing " +
        "while torque falls only slowly.",
      ];
    },
  },
  {
    id: "friction",
    title: "Internals",
    tagline: "Rings, bearings and oil: where the top-end power goes",
    intro:
      "Not all the combustion torque reaches the flywheel. Piston rings scraping the bore, crank and rod " +
      "bearings, the valve springs, and oil being churned and pumped all take a share, and it <b>grows with " +
      "piston speed</b>. That's the main reason power flattens out near redline. Lighter-duty parts lose less, " +
      "but the engine survives less torque.",
    controls: Object.entries(INTERNALS).map(([key, part]) => ({
      key, label: part.label, type: "choice", options: Object.entries(part.options).map(([k, o]) => [k, o.label]),
    })),
    figures(d, a) {
      const n = a.rpm.length - 1;
      const dur = durability(d);
      return [
        fig(`Friction at ${f0(a.rpm[0])}`, `${f0(a.fric[0])} N·m · ${pct(a.fric[0] / a.ind[0])}`, "Share of the combustion torque lost"),
        fig("Friction at redline", `${f0(a.fric[n])} N·m · ${pct(a.fric[n] / a.ind[n])}`, "Share of the combustion torque lost"),
        fig("Engine braking", `${f0(closedThrottleDrag(d, 3000))} N·m @ 3,000 · ${f0(closedThrottleDrag(d, redline(d)))} @ redline`,
          `Throttle shut: friction plus ${f0(pumpingTorque(d))} N·m of pumping against the closed throttle. Exported to BeamNG as the engine's friction, dynamicFriction and engineBrakeTorque.`),
        fig("Torque rating", `${dur.toFixed(2)}×`, "How much of the standard torque the internals take before BeamNG damages the engine (the Fit panel checks it)",
          dur < 0.9 ? "warn" : null),
      ];
    },
    notes(d) {
      const out = [];
      const red = redline(d);
      const dur = durability(d);
      if (dur < 0.9) {
        out.push(warn(`Internals rated for ${pct(dur)} of standard torque`,
          "Lighter-duty parts save friction but survive less. Check the Fit panel: past the rating, BeamNG starts damaging the engine."));
      }
      const durableChoice = { rings: "standard", bearings: "large", oil: "10w40", sump: "wet" };
      for (const k of Object.keys(INTERNALS)) {
        if (d[k] === durableChoice[k]) continue;
        const saved = frictionTorque(resolve({ ...d, [k]: durableChoice[k] }), red) - frictionTorque(d, red);
        const o = INTERNALS[k].options[d[k]];
        const cost = o.durability < 0 ? `, −${pct(-o.durability)} durability` : o.durability > 0 ? `, +${pct(o.durability)} durability` : "";
        out.push(info(`${o.label} ${INTERNALS[k].label.toLowerCase()}: −${f0(saved)} N·m at redline${cost}`,
          `Compared with the most durable ${INTERNALS[k].label.toLowerCase()}.`));
      }
      const sf = springFriction(d);
      if (sf > 0.03) {
        out.push(info("Stiffer valve springs for this cam add friction",
          "Your cam's duration and lift need stiffer springs to keep the valves following the cam, and pushing them open costs torque."));
      } else if (sf < -0.03) {
        out.push(info("Mild cam: soft valve springs, a little less friction"));
      }
      return out;
    },
    background() {
      return [
        "Friction grows with piston speed, so it takes a small share at low rpm and a big one near redline.",
        "The most durable parts (standard rings, large bearings, 10W-40, wet sump) have the most friction and survive the most torque.",
        "Friction is also engine braking: with the throttle shut it slows the engine, along with the pumping against the closed throttle. " +
        "The export gives BeamNG this engine's own friction and engine braking, so slicker internals brake less and drop revs more slowly in the game too.",
      ];
    },
  },
  {
    id: "compression",
    title: "Compression",
    tagline: "Squeezing more out of every drop, until it knocks",
    intro:
      "The <b>compression ratio</b> is how much the piston squeezes the mixture: cylinder volume at the bottom " +
      "of the stroke divided by the volume at the top. Squeezing harder lets the burning gas expand further, so " +
      "<b>more of the fuel's energy becomes work</b>, and torque rises everywhere. The catch is <b>knock</b>: " +
      "squeeze too hard and the last of the mixture explodes on its own before the flame reaches it. The ECU " +
      "hears it and pulls the ignition timing back, which costs torque. Better fuel (higher octane) resists knock.",
    controls: [
      { key: "compression", label: "Compression ratio", type: "range", min: 7, max: 14, step: 0.1, fmt: (v) => `${v.toFixed(1)}:1` },
      { key: "fuel", label: "Fuel", type: "choice", options: Object.entries(FUELS).map(([k, f]) => [k, f.label]) },
      { key: "injection", label: "Fuel injection", type: "choice", options: Object.entries(INJECTION).map(([k, f]) => [k, f.label]) },
    ],
    figures(d, a) {
      const eff = indicatedEfficiency(d), ref = indicatedEfficiency({ ...d, compression: 10.5 });
      const worst = Math.max(...a.knock), margin = a.knockLimit / worst - 1;
      return [
        fig("Fuel energy to work", pct(eff), `${eff >= ref ? "+" : "−"}${Math.abs((eff / ref - 1) * 100).toFixed(1)}% against 10.5:1`),
        fig("Knock margin", margin >= 0 ? `${(margin * 100).toFixed(0)}%` : "knocking",
          `Worst point reaches ${worst.toFixed(1)} against a limit of ${a.knockLimit.toFixed(1)} on ${FUELS[d.fuel].label}`,
          margin < 0 ? "crit" : margin < 0.03 ? "warn" : null),
      ];
    },
    notes(d, a) {
      const out = [];
      const i = a.knock.indexOf(Math.max(...a.knock));
      const worst = a.knock[i], margin = a.knockLimit / worst - 1;
      const knocking = a.rpm.filter((r, k) => a.lost[k] > 0);
      if (knocking.length) {
        out.push(crit(`Knocks ${f0(knocking[0])}–${f0(knocking[knocking.length - 1])} rpm: −${f0(a.knockLost)} N·m`,
          `Worst at ${f0(a.rpm[i])} rpm, where the cylinder is fullest. The ECU pulls timing to stop it, losing torque. ` +
          "Lower the compression, use better fuel, or make the cylinders smaller."));
      } else if (margin < 0.03) {
        out.push(warn("On the edge of knock",
          `Only ${(margin * 100).toFixed(1)}% margin at ${f0(a.rpm[i])} rpm: hot weather, worse fuel or more airflow would tip it over.`));
      } else if (margin > 0.05) {
        out.push(info("Room for more compression",
          `${(margin * 100).toFixed(0)}% knock margin on ${FUELS[d.fuel].label}: more compression would add torque everywhere.`));
      }
      if (d.injection === "direct") {
        const port = { ...d, injection: "port" };
        const worstPort = Math.max(...a.rpm.map((r) => knockIndex(port, r)));
        const crPort = d.compression * fuelLimit(d) / worstPort, crDi = d.compression * a.knockLimit / worst;
        out.push(info(`Direct injection: clean up to ${f1(crDi)}:1 here, against ${f1(crPort)}:1 with port injection`,
          "The fuel evaporates inside the cylinder and cools the charge, so the mixture resists knock and the cylinder fills a " +
          "little better. Its high-pressure pump costs a little friction."));
      } else if (knocking.length) {
        out.push(info("Direct injection would take about 1 to 1.5 points more compression before knocking",
          "Pick it under Fuel injection: the cooler charge resists knock, which is how modern turbo engines run 10:1 on pump fuel."));
      }
      if (d.bore > 90) {
        out.push(info(`${d.bore} mm bores: +${((Math.pow(d.bore / 86, 0.6) - 1) * 100).toFixed(0)}% knock tendency`,
          "The flame takes longer to cross a wide cylinder, giving the far side time to go off. That's one reason big-bore engines run lower compression."));
      }
      return out;
    },
    background() {
      return [
        "Typical ratios: road engines on regular fuel 9.5 to 10.5:1, modern direct-injection engines on premium 11 to 13:1, " +
        "race engines on race fuel 13:1 and up.",
        "<b>Direct injection</b> sprays the fuel straight into the cylinder late in the cycle. As it evaporates it cools the " +
        "charge: the mixture resists knock (about 1 to 1.5 points of compression's worth here) and the cylinder fills about 2% better. " +
        "Port injection sprays into the intake port, where the fuel evaporates before it gets in. BeamNG has no injection " +
        "model, so the export carries it in the torque table and, with a turbo, in the boost's efficiency.",
        "Ethanol (E85) resists knock very well, but Crankcase doesn't yet model the extra fuel it needs.",
      ];
    },
  },
  {
    id: "induction",
    title: "Forced induction",
    tagline: "Turbos and superchargers: pushing in more air than the engine could draw",
    intro:
      "Forced induction pushes air into the engine, so each cylinder takes in <b>more air than its own suction " +
      "could</b>, and more air burns more fuel. A <b>turbo</b> is spun by the exhaust: free power, but it needs " +
      "exhaust flow first, so it builds with rpm and lags behind the throttle. A <b>supercharger</b> is driven " +
      "by a belt from the crank: boost straight away, but it costs power to turn. <b>Twincharging</b> uses a " +
      "supercharger low down and hands over to a turbo. Either way, a fuller cylinder knocks sooner, so boost " +
      "usually means lower compression or better fuel.",
    controls: [
      { key: "induction", label: "Induction", type: "choice", relayout: true,
        options: Object.entries(INDUCTIONS).map(([k, o]) => [k, o.label]) },
      { key: "turboLayout", label: "Turbo layout", type: "choice", relayout: true,
        options: Object.entries(TURBO_LAYOUTS).map(([k, o]) => [k, o.label]), show: (d) => d.induction === "turbo" },
      { key: "scType", label: "Supercharger", type: "choice", relayout: true,
        options: Object.entries(SUPERCHARGERS).map(([k, o]) => [k, o.label]), show: (d) => hasSupercharger(d) },
      { key: "boost", label: "Boost", type: "range", min: 3, max: 30, step: 0.5,
        fmt: (v) => `${v.toFixed(1)} psi (${(v * 0.0689476).toFixed(2)} bar)`, show: (d) => d.induction !== "none" },
      { key: "spoolRpm", label: (d) => (d.turboLayout === "sequential" ? "Small turbo full boost from" : "Full boost from (turbo size)"), type: "range", min: 1500, max: (d) => Math.max(2000, redline(d) - 500), step: 100,
        fmt: (v) => `${f0(v)} rpm`, show: (d) => d.induction === "turbo" },
      { key: "handoverRpm", label: (d) => (d.induction === "twincharged" ? "Supercharger hands over to the turbo at" : "Big turbo joins at"), type: "range", min: 2000, max: (d) => Math.max(2500, redline(d) - 300), step: 100,
        fmt: (v) => `${f0(v)} rpm`, show: (d) => d.induction === "twincharged" || (d.induction === "turbo" && d.turboLayout === "sequential") },
    ],
    figures(d, a) {
      if (d.induction === "none") {
        return [fig("Induction", "naturally aspirated"), fig("Peak torque", `${f0(a.peakTorque)} N·m @ ${f0(a.peakTorqueRpm)}`)];
      }
      const na = analyseEngine(naturallyAspirated(d), 100);
      const full = fullBoostRpm(d);
      const worst = Math.max(...a.knock), margin = a.knockLimit / worst - 1;
      const out = [
        fig("Induction", inductionLabel(d)),
        fig(d.induction === "supercharger" ? "Peak boost" : "Boost", `${d.boost.toFixed(1)} psi`,
          hasTurbo(d) ? `Wastegate opens at ${turboSpec(d).wastegateStart} psi; BeamNG holds the boost about 0.5 psi above that. The in-game slider starts there.`
            : "The most the supercharger makes, at the top of its range: its boost follows its own speed, and so the engine's."),
        fig("Full boost from", full ? `${f0(full)} rpm` : "never", "Where steady full-throttle boost first reaches the target.", full ? null : "crit"),
      ];
      if (hasSupercharger(d)) {
        const lossKw = Math.max(...a.rpm.map((r) => superchargerDrive(d, r) * r / 9549.3));
        out.push(fig("Drive loss", `up to ${f0(lossKw)} kW`, "Power the belt takes to turn the supercharger: it grows with its speed."));
      }
      if (d.induction === "turbo") {
        const spec = turboSpec(d);
        out.push(fig("Boost builds", `${spec.pressureRatePSI} psi/s · ${f2(boostRiseTime(d))} s to full`,
          "Once the revs allow it, how quickly the boost can rise after you open the throttle: the turbo's lag. Bigger turbos are slower; twins and twin-scroll respond quicker."));
      } else {
        out.push(fig("Response", d.induction === "twincharged" ? "instant, then turbo" : "instant", "A supercharger is geared to the crank: its boost is there as soon as the throttle opens."));
      }
      out.push(
        fig("Peak torque", `${f0(a.peakTorque)} N·m @ ${f0(a.peakTorqueRpm)} · +${pct(a.peakTorque / na.peakTorque - 1)}`, `Naturally aspirated: ${f0(na.peakTorque)} N·m`),
        fig("Peak power", `${f0(a.peakPower)} kW @ ${f0(a.peakPowerRpm)} · +${pct(a.peakPower / na.peakPower - 1)}`, `Naturally aspirated: ${f0(na.peakPower)} kW`),
        fig("Knock margin", margin >= 0 ? `${(margin * 100).toFixed(0)}%` : "knocking",
          `Under boost, worst point ${worst.toFixed(1)} against ${a.knockLimit.toFixed(1)} for ${FUELS[d.fuel].label}`,
          margin < 0 ? "crit" : margin < 0.03 ? "warn" : null),
      );
      return out;
    },
    notes(d, a) {
      const out = [];
      if (d.induction === "none") return out;
      const knocking = a.rpm.filter((r, k) => a.lost[k] > 0);
      if (knocking.length) {
        // knock rises in step with the compression ratio, so the highest clean ratio follows directly
        const worst = Math.max(...a.knock);
        const cr = Math.floor((d.compression * a.knockLimit / worst) * 10) / 10;
        const clean = cr >= 7 ? cr : null;
        out.push(crit(`Knocks under boost: −${f0(a.knockLost)} N·m · ` + (clean ? `clean at ${clean.toFixed(1)}:1` : "lower the boost or use better fuel"),
          `It knocks from ${f0(knocking[0])} to ${f0(knocking[knocking.length - 1])} rpm. ` +
          "Boost fills the cylinder further, and a fuller cylinder squeezes the mixture harder, so it goes off on its own. " +
          "The ECU pulls timing and the torque is lost (the export makes the game deliver only what's left). " +
          (clean ? `At this boost it runs clean at about <b>${clean.toFixed(1)}:1</b> on ${FUELS[d.fuel].label}; ` : "") +
          "or use better fuel, or less boost."));
      }
      if (!fullBoostRpm(d)) {
        out.push(crit("Full boost never arrives below redline",
          "The turbo is too big for this engine's exhaust flow, or its full-boost rpm is past the redline. Bring it down."));
      }
      const red = redline(d);
      if (d.induction === "turbo") {
        const effTop = boostEfficiency(d, red);
        if (effTop < 0.85) {
          out.push(info(`Small turbo: ${pct(effTop)} efficient at redline, the top end fades`,
            "A turbo sized for early boost can't flow enough air at high rpm: it heats the charge and the gain falls away. " +
            "A later full-boost point (a bigger turbo), or a sequential pair, keeps pulling to redline."));
        }
        if (boostRiseTime(d) > 0.45) {
          out.push(info(`Laggy: ${f2(boostRiseTime(d))} s for the boost to build`,
            "A big turbo takes longer to spin up after you open the throttle, even above its full-boost rpm. Twins or twin-scroll respond quicker."));
        }
        if (d.turboLayout === "sequential") {
          let dip = Infinity, at = 0;
          for (let r = d.handoverRpm - 600; r <= d.handoverRpm + 600; r += 25) { const b = steadyBoost(d, r); if (b < dip) { dip = b; at = r; } }
          if (dip < d.boost - 0.3) out.push(info(`Hand-over around ${f0(at)} rpm: boost dips to ${dip.toFixed(1)} psi`,
            "As the small turbo runs out of breath and the big one comes in, steady boost sags a little. Accelerating hard through it, " +
            "real sequential cars feel a bigger step for a moment (the big turbo still spinning up): the game shows that only as its usual boost lag."));
        }
      }
      if (hasSupercharger(d)) {
        let loss = 0, at = 0;
        for (const r of a.rpm) { const l = superchargerLoss(d, r) * turboFactor(d, r); if (l > loss) { loss = l; at = r; } }
        out.push(info(`Supercharger takes up to ${pct(loss)} of the torque to drive (at ${f0(at)} rpm)`,
          "The belt turns it whether the engine needs boost or not, and harder the faster it spins. " +
          (d.scType === "roots" ? "A roots blower costs the most at high rpm." : d.scType === "centrifugal" ? "A centrifugal costs the least, but gives little down low." : "A twin-screw is the most efficient positive-displacement type.")));
        if (d.scType === "centrifugal") {
          const r = 3000, b = steadyBoost(d, r);
          if (b < 0.5 * d.boost) out.push(info(`Little boost down low: ${b.toFixed(1)} psi at 3,000 rpm`, "A centrifugal's boost climbs with its speed: like a turbo with no lag, but its full boost only arrives near redline."));
        }
      }
      if (overlap(d) > 45 && hasTurbo(d)) {
        out.push(info(`Long cam overlap (${overlap(d)}°) under boost`,
          "With both valves open around TDC, boost blows some fresh charge straight out of the exhaust. Turbo engines usually run less overlap. Crankcase doesn't take this off the torque yet."));
      }
      return out;
    },
    background(d, a, ctx) {
      const fam = familyFor(ctx?.profile ?? PROFILES[DEFAULT_PROFILE], d.layout);
      const out = [];
      if (hasTurbo(d)) {
        out.push(`<b>${(TURBO_LAYOUTS[d.turboLayout] ?? TURBO_LAYOUTS.single).label} turbo</b>: ${(TURBO_LAYOUTS[d.turboLayout] ?? TURBO_LAYOUTS.single).note}.`,
          "<b>How BeamNG runs a turbo</b>: exhaust power (from the engine's speed, load and airflow) spins the turbine against " +
          "back pressure and friction; the turbine speed gives the boost from the compressor's map; the wastegate holds it at " +
          "its setting; the engine's torque is multiplied by about 6% per psi, times the turbo's efficiency at that rpm. Boost " +
          "can rise only so fast, which is the lag. A pair of turbos is one turbo device in the game, tuned to behave like the pair.");
      }
      if (hasSupercharger(d)) {
        const t = SUPERCHARGERS[d.scType] ?? SUPERCHARGERS.roots;
        out.push(`<b>${t.label} supercharger</b>: ${t.note}.`,
          "<b>How BeamNG runs a supercharger</b>: the blower turns at engine rpm times its pulley ratio; its boost is its speed " +
          "times a shape for its type; it adds about 6% torque per psi and takes a share of the torque, growing with its speed, to drive.");
      }
      if (d.induction === "twincharged") {
        out.push("<b>Twincharged</b>: the supercharger's clutch starts letting go at 65% of the hand-over rpm and is out by the " +
          "hand-over, while the turbo (full boost at the hand-over) takes its place. Below that the turbo only tops the supercharger up to the design's boost.");
      }
      out.push(
        "Crankcase uses the game's own sums, so the curves here are what the game makes. " +
        `<b>In the game</b> it's a part for the intake slot, <i>Crankcase: your design</i>, built on the ${hasTurbo(d) ? fam?.intake?.turboLabel ?? "stock turbo" : "stock intake"} ` +
        "for its pipework, intercooler, nodes and sounds, with the design's own turbos or blower as its model; the exported config fits it. " +
        (hasTurbo(d) ? "The boost stays adjustable on the in-game slider. " : "") +
        "Knock at the design's boost is built into the part, so the game makes the torque shown here (BeamNG has no knock).",
        "<b>Exhaust</b>: these numbers include the exhaust set in the Exhaust section. After a turbo, the same pipe costs more: " +
        "the gas flow is bigger and the pressure in the pipe is felt back through the turbine.",
      );
      return out;
    },
  },
  {
    id: "exhaust",
    title: "Exhaust",
    tagline: "Getting the gas out: back pressure and tuned headers",
    intro:
      "Every gram of air that goes in has to come out as exhaust, and the exhaust system resists it. The pressure it " +
      "takes to push the gas out, the <b>back pressure</b>, grows with the square of the gas speed, so it costs " +
      "little low down and a lot near redline, and far more with boost. The piston pays it on every exhaust stroke, and " +
      "the gas it leaves behind takes room the fresh charge would have had. <b>Tubular headers</b> do the opposite " +
      "around one rpm: each pulse's echo arrives as suction just as the valves overlap and helps empty the cylinder.",
    controls: [
      { key: "manifold", label: "Manifold", type: "choice", relayout: true, options: Object.entries(MANIFOLDS).map(([k, m]) => [k, m.label]) },
      { key: "primary", label: "Header primary length", type: "range", min: PRIMARY_LIMITS.min, max: PRIMARY_LIMITS.max, step: 1,
        fmt: (v, d) => `${v} cm → ${f0(headerTunedRpm({ ...d, primary: v }))} rpm`, show: (d) => d.manifold === "headers" },
      { key: "pipes", label: "Pipes", type: "choice", options: Object.entries(PIPES).map(([k, p]) => [k, p.label]) },
      { key: "pipe", label: "Pipe diameter", type: "range", min: PIPE_LIMITS.min, max: PIPE_LIMITS.max, step: 1,
        fmt: (v) => `${v} mm (${(v / 25.4).toFixed(2)}")` },
      { key: "cat", label: "Catalytic converter", type: "choice", options: Object.entries(CATS).map(([k, c]) => [k, c.label]) },
      { key: "muffler", label: "Muffler", type: "choice", options: Object.entries(MUFFLERS).map(([k, m]) => [k, m.label]) },
    ],
    figures(d, a) {
      const free = analyseEngine(freeFlowing(d), 100);
      const pr = a.peakPowerRpm, red = a.redline;
      const bp = backPressure(d, pr), bpRed = backPressure(d, red);
      const rec = recommendedPipe(d);
      const out = [
        fig("Back pressure", `${f1(bp / 1000)} kPa @ ${f0(pr)} · ${f1(bpRed / 1000)} @ redline`,
          `${f1(bp / 6894.76)} psi at peak power. Stock road cars run about 15 to 30 kPa at peak power; race exhausts under 10.`,
          bp > 45e3 ? "crit" : bp > 30e3 ? "warn" : null),
        fig("Peak power", `${f0(a.peakPower)} kW · ${a.peakPower >= free.peakPower ? "+" : "−"}${f1(Math.abs(a.peakPower / free.peakPower - 1) * 100)}%`,
          `Against a free-flowing exhaust (${f0(free.peakPower)} kW): what this exhaust costs or, with tuned headers, gives`),
        fig("Pipe for this engine", `${rec} mm (${(rec / 25.4).toFixed(2)}")${PIPES[d.pipes].count > 1 ? " each" : ""}`,
          `Keeps the gas at about ${PIPE_SPEED} m/s at redline. Yours: ${d.pipe} mm.`,
          d.pipe < rec * 0.85 ? "warn" : null),
      ];
      if (d.manifold === "headers") {
        out.push(fig("Headers tuned to", `${f0(headerTunedRpm(d))} rpm`, `${d.primary} cm primaries with a ${d.duration}° cam (Smith's rule: 850 × exhaust duration ÷ length in inches + 3)`));
      }
      out.push(fig("Sound", { chambered: "quiet", turbo: "moderate", straight: "loud", none: "very loud" }[d.muffler] + (d.cat === "none" ? ", pops on overrun" : ""),
        "In the game: how much the muffler damps the tailpipe, and how often it backfires on the overrun."));
      return out;
    },
    notes(d, a) {
      const out = [];
      const free = analyseEngine(freeFlowing(d), 100);
      const loss = 1 - a.peakPower / free.peakPower;
      const rec = recommendedPipe(d);
      if (loss > 0.08) {
        out.push(crit(`The exhaust costs ${pct(loss)} of the power`,
          `Back pressure reaches ${f1(backPressure(d, a.redline) / 1000)} kPa at redline. ` +
          (d.pipe < rec ? `A ${rec} mm pipe${PIPES[d.pipes].count > 1 ? " pair" : ""} would suit this engine` : "A freer muffler or cat would help") +
          (d.layout === "v" && d.pipes === "single" ? "; a V engine usually runs one pipe per bank." : ".")));
      } else if (loss > 0.03) {
        out.push(warn(`The exhaust costs ${pct(loss)} of the power`, "Normal for a quiet road exhaust. A bigger pipe or a freer muffler gets some back."));
      }
      if (d.pipe > rec * 1.3) {
        out.push(info(`Pipe oversized for this engine (${d.pipe} mm vs ${rec} mm)`,
          "The gas slows down in a pipe that big and loses some of the scavenging low down: a little low-rpm torque for no gain at the top."));
      }
      if (d.manifold === "headers") {
        const t = headerTunedRpm(d);
        if (t > a.redline) out.push(warn(`Headers tuned above the redline (${f0(t)} rpm)`, "Longer primaries bring the tuning down into the rev range."));
        else out.push(info(`Headers help most around ${f0(t)} rpm`, "Longer primaries tune lower, shorter ones higher, like intake runners. With the runners and cam near the same rpm the peak gets sharper."));
        if (hasTurbo(d)) out.push(info("A turbo blunts the headers' tuning",
          "The turbine sits in the way of the pulses. " + (d.turboLayout === "twinscroll" ? "Twin-scroll keeps the pulses apart, so it keeps half of it." : "Twin-scroll would keep more of it.")));
      }
      if (hasTurbo(d) && d.pipe < rec) {
        out.push(info("After a turbo, a small pipe costs about twice as much",
          "The pressure in the pipe is felt back through the turbine. Turbo cars usually run 3 inch (76 mm) or more from the turbine back."));
      }
      if (d.cat === "none") out.push(info("No catalytic converter: not road legal", "Fine for a race car; it pops and bangs on the overrun in the game."));
      return out;
    },
    background(d, a, ctx) {
      const fam = familyFor(ctx?.profile ?? PROFILES[DEFAULT_PROFILE], d.layout);
      return [
        "<b>Back pressure</b> = loss coefficient × ½ × gas density × gas speed². Each part adds to the loss coefficient: " +
        `${Object.values(MANIFOLDS).map((m) => `${m.label.toLowerCase()} ${m.zeta}`).join(", ")}; ` +
        `${Object.values(CATS).map((c) => `${c.label.toLowerCase()} ${c.zeta}`).join(", ")}; ` +
        `mufflers from ${MUFFLERS.chambered.zeta} (chambered) to 0; and the pipe's own friction (about 1 for 3 m of 2.25-inch pipe). ` +
        "Dual pipes halve the gas speed in each.",
        "It costs torque twice: the piston pushes against it on every exhaust stroke, and the exhaust left behind in the " +
        "cylinder (more with a long cam overlap) takes the fresh charge's room.",
        "<b>Headers</b>: Smith's rule gives the rpm a primary length suits: 850 × exhaust duration ÷ (length in inches + 3). " +
        "A cast manifold lets the pulses meet early and get in each other's way.",
        `<b>In the game</b> it's a part for the ${fam?.exhaust ? `car's exhaust slot (${fam.exhaust.slot})` : "car's exhaust slot"}, ` +
        "built on the stock exhaust's pipes and look: its torque change (torqueModExhaust, added before any boost multiplies it, as the " +
        "game's own exhausts do) and the muffler's sound come from the design. The engine and the exported config fit it.",
      ];
    },
  },
  {
    id: "gearing",
    title: "Gearing",
    tagline: "Turning the torque curve into push at the road",
    intro:
      "The engine only makes power in a band of rpm; the gearbox decides <b>which part of that band you use at " +
      "each road speed</b>. Each gear multiplies the torque (short gears push hard but run out of revs early, tall " +
      "ones reach high speed but push gently). The dashed line in the force chart is the ideal: an engine held at " +
      "<b>peak power at every speed</b>. Good gearing keeps the gear curves close to it.",
    controls: [
      { key: "gearCount", label: "Gears", type: "choice", relayout: true, options: [[4, "4"], [5, "5"], [6, "6"]] },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({
        key: `gear${n}`, label: `Gear ${n}`, type: "range", min: 0.5, max: 5, step: 0.01, // the game's gear sliders go to 5.0
        fmt: (v) => `${v.toFixed(2)}:1`, show: (d) => n <= d.gearCount,
      })),
      { key: "finalDrive", label: "Final drive", type: "range", min: 2, max: 6, step: 0.01, fmt: (v) => `${v.toFixed(2)}:1` },
      { key: "tire", label: "Tires", type: "choice", options: TIRES.map((t) => [t, t]) },
    ],
    figures(d, a, ctx) {
      const g = analyseGearing(d, ctx.car);
      return [
        fig("Top speed", `${f0(g.top)} km/h`, `In ${ORD[g.topGear - 1]} at ${f0(g.topRpm)} rpm; limited by ${g.limitedBy === "redline" ? "the rev limiter" : "drag"}`),
        fig("Shifts land at",
          g.shifts.map((s) => `<span class="${s.powerShare < 0.7 ? "crit" : s.powerShare < 0.8 ? "warn" : ""}">${pct(s.powerShare)}</span>`).join(" · "),
          "Share of peak power after each upshift from redline (aim for 80% or more): " +
          g.shifts.map((s) => `${s.from}→${s.to} at ${f0(s.rpm)} rpm`).join(", ")),
        fig("Best shifts", g.bestShifts.map((s) => s.early ? `<span class="info">${f0(s.rpm)}</span>` : "redline").join(" · "),
          "Upshift rpm for the hardest acceleration: where the next gear starts pulling harder, counting grip and the engine's inertia. " +
          g.bestShifts.map((s) => `${s.from}→${s.to} at ${f0(s.rpm)} rpm, ${f0(s.kmh)} km/h, landing at ${f0(s.landing)}`).join("; ") + "."),
        fig("0–100 km/h", Number.isFinite(g.zeroTo100) ? `${f1(g.zeroTo100)} s` : "never",
          `Estimate, shifting at the best shift points: ${shiftTime(d).toFixed(1)} s per shift (${SHIFT_STYLES[d.shift]?.label.toLowerCase() ?? "quick"}, set in Rotating mass), the car's grip, and the engine's inertia`),
        fig("100 km/h in top", `${f0(g.rpmAt100Top)} rpm`),
        fig("Ideal line covered", pct(g.coverage), "How much of the dashed constant-power line the gears reach, 20 km/h to top speed"),
      ];
    },
    notes(d, a, ctx) {
      const out = [];
      const g = analyseGearing(d, ctx.car);
      const pp = g.peakPowerRpm;
      for (const s of g.shifts) {
        if (s.powerShare >= 0.8) continue;
        const make = s.powerShare < 0.7 ? crit : warn;
        out.push(make(`${s.from}→${s.to} falls out of the power band (${pct(s.powerShare)})`,
          `Shifting at redline, the revs land at ${f0(s.rpm)} rpm. Below about 80% of peak power the car bogs after the shift: ` +
          "it's the dip between those two curves in the force chart. Close the ratio gap."));
      }
      const early = g.bestShifts.filter((s) => s.early);
      if (early.length) {
        out.push(info(`Shift before redline: ${early.map((s) => `${s.from}→${s.to} at ${f0(s.rpm)}`).join(", ")}`,
          "Past these points the next gear accelerates the car harder: the engine is beyond peak power, so the lower gear's push " +
          "is fading while the next gear's is still strong. Revving on to redline is slower. The dots on the rpm chart mark them."));
      }
      if (g.limitedBy === "redline") {
        out.push(warn(`Top speed on the rev limiter in ${ORD[g.topGear - 1]}`,
          `${f0(g.top)} km/h: the car could go faster but the engine runs out of revs. The top gear is short for top speed ` +
          "(fine if the car never gets there, like on a tight track)."));
      } else if (g.topRpm < pp * 0.9) {
        out.push(warn("Top gear too tall: drag wins below peak power",
          `Top speed comes at ${f0(g.topRpm)} rpm, well short of peak power at ${f0(pp)}. A shorter top gear (or final drive) would go faster.`));
      }
      if (g.rpmAt100Top > 3500) {
        out.push(info(`Busy at 100 km/h: ${f0(g.rpmAt100Top)} rpm in top`, "Loud and thirsty on the highway for a road car."));
      } else if (g.rpmAt100Top < 1800) {
        out.push(info(`Relaxed at 100 km/h: ${f0(g.rpmAt100Top)} rpm in top`, "Quiet cruising, but it'll need a downshift to pass."));
      }
      return out;
    },
    background(d, a, ctx) {
      return [
        "<b>Shift landing</b> = shift rpm × next ratio ÷ current ratio. Aim for every upshift to land at 80% of peak power or more.",
        "<b>Best shift point</b>: the speed where the next gear's push, less drag, over the car's mass (including the engine's inertia " +
        "in that gear) beats this gear's. While a gear can still spin the tyres it's kept. It's redline whenever the next gear never " +
        "catches up, which is usual on engines that hold their power to the limiter. It doesn't count the time a shift takes.",
        "<b>Top gear</b> works best with peak power at the drag-limited top speed. Taller is a cruising overdrive; shorter puts the car on the limiter.",
        "Closer ratios cover more of the ideal line but need more shifts; the gaps cost acceleration.",
        ctx.gearingNote,
      ];
    },
  },
  {
    id: "rotating",
    title: "Rotating mass",
    tagline: "Crank and flywheel: how quickly the engine picks up and drops revs",
    intro:
      "Everything that spins with the crank (the crank itself, the flywheel and the clutch) has to be " +
      "<b>spun up every time the revs rise</b>. Its moment of inertia sets how fast the engine revs in neutral, " +
      "how quickly the revs fall when you lift for a shift, and, through the gearing, how much extra mass " +
      "the car seems to carry: in a low gear the engine spins many times per wheel turn, so its inertia " +
      "<b>feels like tens of kilograms</b>. Lighter is quicker; heavier is smoother and easier to drive.",
    controls: [
      { key: "flywheel", label: "Flywheel", type: "choice", options: Object.entries(FLYWHEELS).map(([k, o]) => [k, o.label]) },
      { key: "crank", label: "Crank", type: "choice", options: Object.entries(CRANKS).map(([k, o]) => [k, o.label]) },
      { key: "shift", label: "Driver's shift speed", type: "choice",
        options: Object.entries(SHIFT_STYLES).map(([k, o]) => [k, `${o.label} ${o.time.toFixed(1)} s`]) },
    ],
    figures(d, a, ctx) {
      const ci = crankInertia(d), fi = flywheelInertia(d), I = totalInertia(d);
      const red = redline(d);
      const rs = ratios(d);
      const r = tireRadius(d.tire);
      const masses = rs.map((x) => equivalentMass(I, x * d.finalDrive, r));
      const out = [
        fig("Inertia", `${I.toFixed(3)} kg·m²`, `Crank and rotating assembly ${ci.toFixed(3)} + flywheel and clutch ${fi.toFixed(3)}`),
        fig("Free rev", `${f2(revUp(d, 1500).time)} s`, `Full throttle in neutral, 1,500 to ${f0(red)} rpm`),
      ];
      if (rs.length > 1) {
        const st = shiftTime(d);
        const after = red - dropIn(d, red, st), land = (red * rs[1]) / rs[0];
        const gap = after - land;
        out.push(fig("Revs at clutch-in", `${f0(after)} rpm · ${gap >= 0 ? "+" : "−"}${f0(Math.abs(gap))}`,
          `After a ${st.toFixed(1)} s shift from redline; 2nd wants ${f0(land)} rpm. Within about 300 rpm the clutch smooths it out.`,
          Math.abs(gap) > 300 ? "warn" : null));
        const m = matchTime(d, red, land);
        out.push(fig("Perfect 1→2 takes", Number.isFinite(m) ? `${f2(m)} s` : "over 3 s",
          "How long a shift would need to take for the revs to fall exactly to what 2nd wants. Shifts within about 0.1 s of this feel smooth."));
      }
      out.push(fig("Feels like", `${f0(masses[0])} kg in 1st · ${f0(masses[masses.length - 1])} kg in top`,
        "Extra mass at the wheels: " + masses.map((m, i) => `${ORD[i]} ${f0(m)} kg`).join(", ")));
      const g = analyseGearing(d, ctx.car);
      if (Number.isFinite(g.zeroTo100)) out.push(fig("0–100 km/h", `${f2(g.zeroTo100)} s`));
      return out;
    },
    notes(d, a, ctx) {
      const out = [];
      const red = redline(d);
      const rs = ratios(d);
      const I = totalInertia(d);
      if (rs.length > 1) {
        const land = (red * rs[1]) / rs[0];
        const st = shiftTime(d);
        const after = red - dropIn(d, red, st);
        if (after > land + 300) {
          out.push(warn(`Rev hang on 1→2: ${f0(after - land)} rpm too high at clutch-in`,
            `In a ${st.toFixed(1)} s shift the revs only fall to ${f0(after)}; 2nd wants ${f0(land)}. The clutch drags ` +
            "the engine down, which slows the shift and jolts the car. A lighter flywheel falls faster, or a slower shift gives it time."));
        } else if (after < land - 300) {
          out.push(warn(`Revs fall ${f0(land - after)} rpm below 2nd's before clutch-in`,
            `The clutch has to pick them back up to ${f0(land)}, so the car bogs for a moment. A heavier flywheel holds the revs, or a quicker shift catches them.`));
        } else {
          out.push(info("Revs meet 2nd gear as the clutch bites",
            `About ${f0(after)} rpm at clutch-in against ${f0(land)} wanted: a smooth, quick shift.`));
        }
      }
      const r = tireRadius(d.tire), m = ctx.car.mass;
      const first = equivalentMass(I, rs[0] * d.finalDrive, r);
      if (first > 0.3 * m) {
        out.push(info(`Heavy in low gears: +${pct(first / m)} of the car's mass in 1st`,
          "In a low gear the engine spins many times per wheel turn, so its inertia counts many times over. " +
          "Lightening the flywheel pays off most here, and hardly at all in top."));
      }
      if (d.flywheel === "ultra") {
        out.push(info("Ultra-light: harder to pull away, revs drop when you lift", FLYWHEELS.ultra.note));
      }
      const light = analyseGearing({ ...d, flywheel: "ultra" }, ctx.car);
      const heavy = analyseGearing({ ...d, flywheel: "dualmass" }, ctx.car);
      if (Number.isFinite(light.zeroTo100) && Number.isFinite(heavy.zeroTo100)) {
        out.push(info(`Flywheel range for 0–100: ${f2(light.zeroTo100)} s (ultra-light) to ${f2(heavy.zeroTo100)} s (dual-mass)`,
          "The Gearing section's estimate, counting the engine's inertia in every gear."));
      }
      return out;
    },
    background(d) {
      return [
        `<b>${FLYWHEELS[d.flywheel].label}</b>: ${FLYWHEELS[d.flywheel].note}. <b>Crank</b>: ${CRANKS[d.crank].note}.`,
        "Rev response is torque ÷ inertia: halving the inertia halves the free-rev time. With the throttle shut, the revs fall at " +
        `drag ÷ inertia: this engine's friction plus ${f0(pumpingTorque(d))} N·m of pumping, the same sum BeamNG uses (see Internals).`,
        "Through the gearing, inertia feels like mass at the wheels: I × (overall ratio ÷ tyre radius)².",
        `<b>Driver's shift speed</b> sets the shift mark: ${SHIFT_STYLES[d.shift]?.label.toLowerCase() ?? "quick"} is ${SHIFT_STYLES[d.shift]?.note ?? ""}. ` +
        "Slower shifts give a heavy flywheel time to fall; faster ones need a lighter one. The chart always shifts at redline: " +
        "an everyday driver shifts far earlier, so the revs have much less to fall, and the clutch slips a little to smooth the rest. " +
        "That's why road cars get heavy flywheels. It also sets the shift pauses in the Gearing section's 0–100 estimate.",
        "In BeamNG the crank's share goes on the engine, and the flywheel is its own part in the gearbox's flywheel slot, " +
        "set in the exported config. In a run, a lighter flywheel shows as faster rpm rises in low gears and quicker drops between shifts.",
      ];
    },
  },
];

export const LEVEL_ORDER = { crit: 0, warn: 1, info: 2 };

/** A section's notes, most urgent first. */
export function sectionNotes(section, d, a, ctx) {
  return (section.notes?.(d, a, ctx) ?? [])
    .map((n, i) => ({ ...n, i }))
    .sort((x, y) => LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level] || x.i - y.i)
    .map(({ i, ...n }) => n);
}

export const COMING = [];
