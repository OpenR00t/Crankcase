// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
import { analyse, DEFAULT_DESIGN, BUILDS, FUELS, hp, bandStats, redline, brakeTorque } from "./lib/engine.js";
import { SECTIONS, COMING, sectionNotes } from "./lib/sections.js";
import { fixCylinders, layoutName, mass } from "./lib/geometry.js";
import { resolve, migrate, DEFAULT_PARTS, valveLift } from "./lib/parts.js";
import { DEFAULT_GEARING, analyseGearing, ratios, rpmAt, spreadGears, rebase, gearForSpeed, steps } from "./lib/gearing.js";
import { toCrank, fromCrank, EXTENSION } from "./lib/crankfile.js";
import { slug } from "./lib/export.js";
import { PROFILES, DEFAULT_PROFILE, familyFor } from "./lib/profiles.js";
import { checkFit } from "./lib/fit.js";
import { buildEngine, exportRelativePath, infoRelativePath, donorFiles } from "./lib/export.js";
import { listCars, carDetector } from "./lib/cars.js";
import { buildConfig, gearboxFor } from "./lib/vehicleconfig.js";
import { chart, align, C } from "./lib/chart.js";
import * as platform from "./lib/platform.js";
import { parseLd, parseLdx } from "./lib/motec.js";
import { analyseRun } from "./lib/run.js";
import { revUp, revDrop, totalInertia } from "./lib/rotating.js";
import { steadyBoost, fullBoostRpm, naturallyAspirated, superchargerBoost, turboBoost } from "./lib/induction.js";
import { SHIFT_STYLES, shiftTime } from "./lib/gearing.js";
import { backPressure, headerTunedRpm, freeFlowing } from "./lib/exhaust.js";
import { LOCKS, applyChange, setLock, clearLock, lockList } from "./lib/locks.js";

const $ = (id) => document.getElementById(id);
const fmt0 = (v) => Math.round(v).toLocaleString("en-US");

/** A stored design (maybe from before parts existed) as a full, resolved design. */
const load = (stored) => resolve({ ...DEFAULT_PARTS, ...DEFAULT_GEARING, ...migrate({ ...DEFAULT_DESIGN, ...stored }) });

const state = {
  design: load(platform.store.get("design", {})),
  baseline: load(platform.store.get("baseline", null) || { name: "Default 2.4" }),
  section: platform.store.get("section", "displacement"),
  target: platform.store.get("target", DEFAULT_PROFILE),
  band: platform.store.get("band", [2500, 5500]),
  folder: null,
  game: null,
  run: null, // { name, data (parsed .ld), laps } — a run recorded in BeamNG, not saved
};
state.design.cylinders = fixCylinders(state.design);
state.baseline.cylinders = fixCylinders(state.baseline);
// cars in the game and mods are worked out from their files when picked; until the
// picked car is ready (or in a browser, where there are no game files) it's the BX
const cars = carDetector(platform);
const usable = (p) => p && p.support?.ok !== false;
const profile = () => (usable(cars.known(state.target)) ? cars.known(state.target) : PROFILES[DEFAULT_PROFILE]);
let charts = [];
let pending = false;

function save() {
  platform.store.set("design", state.design);
  platform.store.set("baseline", state.baseline);
  platform.store.set("section", state.section);
  platform.store.set("target", state.target);
  platform.store.set("band", state.band);
}

/* ---------- sections panel ---------- */
function renderSteps() {
  $("steps").innerHTML = SECTIONS.map((l, i) =>
    `<button data-id="${l.id}" class="${l.id === state.section ? "on" : ""}">` +
    `<span class="n">${i + 1}</span>${l.title}</button>`).join("");
  $("steps").querySelectorAll("button").forEach((b) => b.onclick = () => {
    state.section = b.dataset.id; save(); renderSteps(); renderSection(); redraw();
  });
  $("coming").hidden = !COMING.length;
  $("coming").innerHTML = COMING.length ? "<h3>Planned</h3>" + COMING.map(([t, d]) => `<div><b>${t}</b>: ${d}</div>`).join("") : "";
}

function controlValue(c, v) {
  if (c.fmt) return c.fmt(v, state.design);
  return `${Number.isInteger(c.step) || c.step >= 1 ? fmt0(v) : v} ${c.unit || ""}`.trim();
}

/* ---------- ratio tools (gearing): the arithmetic, done for you ---------- */
const tools = { gear: 1, rpm: null, kmh: 100, top: 1.0, msg: "", err: false };

function ratioTools(d) {
  const n = d.gearCount, red = Math.round(redline(d) / 50) * 50;
  if (tools.gear > n) tools.gear = n;
  const opts = Array.from({ length: n }, (_, i) => `<option value="${i + 1}" ${tools.gear === i + 1 ? "selected" : ""}>${ORD[i]}</option>`).join("");
  return `<div class="tools"><h4>Ratio tools</h4>` +
    `<div class="trow"><button class="btn" data-tool="even">Spread evenly</button><button class="btn" data-tool="progressive">Progressive</button></div>` +
    `<div class="hint">Fills 2nd to ${ORD[n - 2]} between your 1st and ${ORD[n - 1]}. Even: every step is (${ORD[n - 1]} ÷ 1st)<sup>1/${n - 1}</sup>. ` +
    `Progressive: the same spread, wider steps low and closer ones high.</div>` +
    `<div class="hint" id="toolSteps"></div>` +
    `<div class="trow">Set <select id="tGear">${opts}</select> to <input id="tRpm" type="number" step="50" value="${tools.rpm ?? red}"> rpm at ` +
    `<input id="tKmh" type="number" step="1" value="${tools.kmh}"> km/h <button class="btn" data-tool="speed">Set</button></div>` +
    `<div class="hint">overall ratio = rpm × tyre circumference × 0.06 ÷ km/h; gear = overall ÷ final drive. ` +
    `E.g. ${ORD[n - 1]} at 2,400 rpm at 100 km/h, or 1st at redline (${fmt0(red)}) at 70 km/h.</div>` +
    `<div class="trow">Rebase: make ${ORD[n - 1]} <input id="tTop" type="number" step="0.01" value="${tools.top.toFixed(2)}"> <button class="btn" data-tool="rebase">Rebase</button></div>` +
    `<div class="hint">Every gear × k and the final drive ÷ k, so the car is unchanged: only how the ratio is split between gearbox and axle moves.</div>` +
    `<div class="hint tmsg ${tools.err ? "err" : ""}" id="toolMsg">${tools.msg}</div></div>`;
}

function wireRatioTools() {
  const el = $("section");
  const keep = () => {
    tools.gear = Number($("tGear").value); tools.rpm = Number($("tRpm").value) || null;
    tools.kmh = Number($("tKmh").value) || 100; tools.top = Number($("tTop").value) || 1;
  };
  ["tGear", "tRpm", "tKmh", "tTop"].forEach((id) => { $(id).onchange = keep; });
  el.querySelectorAll("[data-tool]").forEach((b) => b.onclick = () => {
    keep();
    const d = state.design, t = b.dataset.tool;
    let res, msg;
    if (t === "even" || t === "progressive") {
      res = spreadGears(d, t);
      msg = `${t === "even" ? "Spread evenly" : "Progressive"}: middle gears set.`;
    } else if (t === "speed") {
      res = gearForSpeed(d, tools.rpm, tools.kmh);
      if (!res.error) {
        res.changes = { [`gear${tools.gear}`]: res.gear };
        msg = `${ORD[tools.gear - 1]} = ${res.overall.toFixed(2)} overall ÷ ${d.finalDrive.toFixed(2)} final = ${res.gear.toFixed(2)}.`;
      }
    } else {
      res = rebase(d, tools.top);
      if (!res.error) msg = `k = ${tools.top.toFixed(2)} ÷ ${d[`gear${d.gearCount}`].toFixed(2)}: gears × k, final drive ÷ k = ${res.changes.finalDrive.toFixed(2)}.`;
    }
    tools.err = !!res.error;
    tools.msg = res.error || msg;
    if (res.changes) Object.assign(state.design, res.changes);
    renderSection();
    changed();
  });
}

// Nothing in Crankcase is dragged and dropped. A drag that starts on selected text or a
// control shows the "not allowed" cursor and swallows the slider move, so none start.
document.addEventListener("dragstart", (e) => e.preventDefault());

/** A slider's limits: numbers, or worked out from the design. */
const lo = (c) => (typeof c.min === "function" ? c.min(state.design) : c.min);
const hi = (c) => (typeof c.max === "function" ? c.max(state.design) : c.max);

function renderSection() {
  const l = SECTIONS.find((x) => x.id === state.section) || SECTIONS[0];
  // fit is about the engine's size and mass: not shown where nothing changes them
  $("fitCard").hidden = ["gearing", "compression", "rotating", "exhaust"].includes(l.id);
  const d = state.design;
  const ctl = l.controls.filter((c) => !c.show || c.show(d)).map((c) => {
    if (c.type === "choice") {
      const options = typeof c.options === "function" ? c.options(d) : c.options;
      return `<div class="ctl"><div class="lab"><span>${typeof c.label === "function" ? c.label(d) : c.label}</span></div><div class="choices">` +
        options.map(([v, t]) => `<button data-key="${c.key}" data-v="${v}" class="${String(d[c.key]) === String(v) ? "on" : ""}">${t}</button>`).join("") +
        "</div></div>";
    }
    return `<div class="ctl"><div class="lab"><span>${typeof c.label === "function" ? c.label(d) : c.label}</span><span class="v" data-out="${c.key}" title="Click to type a value">${controlValue(c, d[c.key])}</span></div>` +
      `<input type="range" data-key="${c.key}" min="${lo(c)}" max="${hi(c)}" step="${c.step}" value="${d[c.key]}"></div>`;
  }).join("");
  $("section").innerHTML =
    `<h2>${l.title}</h2><div class="tag">${l.tagline}</div>` +
    `<div class="read">${l.intro}</div>` +
    `<div class="controls">${ctl}</div>` +
    (l.id === "gearing" ? ratioTools(d) : "") +
    `<div id="figs" class="figs"></div>` +
    `<ul id="readoutNotes" class="notes"></ul>` +
    `<details id="bg" class="bg read"${state.bgOpen ? " open" : ""}><summary>How it works</summary><div id="bgBody"></div></details>`;
  $("bg").ontoggle = () => { state.bgOpen = $("bg").open; };
  if (l.id === "gearing") wireRatioTools();
  $("section").querySelectorAll("input[type=range]").forEach((inp) => {
    const c = l.controls.find((x) => x.key === inp.dataset.key);
    inp.oninput = () => setControl(c, Number(inp.value), true);
  });
  // click a slider's value to type one in
  $("section").querySelectorAll(".lab .v[data-out]").forEach((out) => {
    out.onclick = () => {
      if (out.querySelector("input")) return;
      const c = l.controls.find((x) => x.key === out.dataset.out);
      const range = $("section").querySelector(`input[type=range][data-key="${c.key}"]`);
      const box = document.createElement("input");
      box.type = "number"; box.className = "typed"; box.step = c.step; box.min = lo(c); box.max = hi(c);
      box.value = state.design[c.key];
      out.textContent = ""; out.appendChild(box); box.focus(); box.select();
      let done = false;
      const finish = (apply) => {
        if (done) return; done = true;
        const v = Number(box.value);
        if (apply && box.value.trim() !== "" && Number.isFinite(v)) {
          const clamped = Math.min(hi(c), Math.max(lo(c), v));
          if (clamped !== v) out.title = `Kept within ${lo(c)} to ${hi(c)}`;
          out.textContent = "";
          setControl(c, Number((Math.round(clamped / c.step) * c.step).toFixed(6)), true);
        }
        out.textContent = controlValue(c, state.design[c.key]);
        range.value = state.design[c.key];
      };
      box.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
      box.onblur = () => finish(true);
    };
  });
  $("section").querySelectorAll(".choices button").forEach((b) => b.onclick = () => {
    const c = l.controls.find((x) => x.key === b.dataset.key);
    const v = b.dataset.v;
    if (!setControl(c, isNaN(Number(v)) ? v : Number(v), false)) return;
    if (c.relayout) { state.design.cylinders = fixCylinders(state.design); renderSection(); }
  });
}

/**
 * Set a control's value through the design locks: a held value moves the controls it's
 * tied to, a limit stops a slider at the last allowed setting. Returns whether it moved.
 */
function setControl(c, value, slider) {
  const r = applyChange(state.design, c.key, value, state.design.locks, { profile: profile() }, slider ? { step: c.step } : null);
  const moved = r.d !== state.design;
  if (moved) state.design = { ...r.d, locks: state.design.locks };
  syncControls();
  if (r.held) flashLock(r.held);
  else if (r.range) lockMessage(`That needs a ${r.range} outside the slider's range.`);
  if (moved) changed();
  return moved;
}

/** Every control in the section showing the design's current values (locks move several at once). */
function syncControls() {
  const d = state.design;
  $("section").querySelectorAll("input[type=range]").forEach((inp) => {
    const v = d[inp.dataset.key];
    if (Number(inp.value) !== v) inp.value = v;
  });
  const l = SECTIONS.find((x) => x.id === state.section) || SECTIONS[0];
  $("section").querySelectorAll(".lab .v[data-out]").forEach((out) => {
    if (out.querySelector("input")) return;
    const c = l.controls.find((x) => x.key === out.dataset.out);
    if (c) out.textContent = controlValue(c, d[c.key]);
  });
  $("section").querySelectorAll(".choices button").forEach((b) =>
    b.classList.toggle("on", String(d[b.dataset.key]) === b.dataset.v));
}

/* ---------- design locks ---------- */
const PADLOCK = (open) => `<svg viewBox="0 0 11 12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="5.5" width="9" height="6" rx="1.2" fill="currentColor" stroke="none"/>` +
  `<path d="${open ? "M3 5.5V3.6a2.5 2.5 0 0 1 5-.6" : "M3 5.5V3.6a2.5 2.5 0 0 1 5 0v1.9"}"/></svg>`;
let lockNote = { text: "", ok: false, timer: null };

function lockMessage(text, ok = false) {
  clearTimeout(lockNote.timer);
  lockNote = { text, ok, timer: setTimeout(() => { lockNote.text = ""; renderLocks(); }, 4000) };
  renderLocks();
}

function flashLock(key) {
  const el = $("locks").querySelector(`[data-lock="${key}"]`);
  if (!el) return;
  el.classList.remove("held"); void el.offsetWidth; el.classList.add("held");
  lockMessage(`Held by the ${LOCKS[key].label.toLowerCase()} lock`);
}

function renderLocks() {
  const items = lockList(state.design, state.design.locks, { profile: profile() });
  $("locks").innerHTML = `<span class="hd" title="Hold a value while you design: the sliders work around it">Locks</span>` +
    items.map((i) => `<span class="lock${i.on ? " on" : ""}${i.on && !i.met ? " unmet" : ""}" data-lock="${i.key}" role="button" tabindex="0" ` +
      `title="${(i.on ? (i.met ? "Locked. " : "Locked, but not met right now. ") : "Click to lock. ") + i.tip + (i.on && i.value ? " Click the value to type a target." : "")}">` +
      `${PADLOCK(!i.on)}<span>${i.label}</span>${i.on && i.value ? `<span class="lv">${i.value}</span>` : ""}</span>`).join("") +
    (lockNote.text ? `<span class="lmsg${lockNote.ok ? " ok" : ""}">${lockNote.text}</span>` : "");
  $("locks").querySelectorAll(".lock").forEach((el) => {
    const key = el.dataset.lock;
    el.onclick = (e) => {
      if (e.target.closest("input")) return;
      if (e.target.closest(".lv")) return typeLock(el, key);
      toggleLock(key);
    };
    el.onkeydown = (e) => { if (e.target === el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleLock(key); } };
  });
}

function applyLock(r) {
  if (r.error) { lockMessage(r.error); return false; }
  state.design = { ...r.d, locks: r.locks };
  if (r.message) lockMessage(r.message, true);
  syncControls();
  changed();
  return true;
}

function toggleLock(key) {
  const locks = state.design.locks ?? {};
  if (locks[key] != null && locks[key] !== false) {
    state.design = { ...state.design, locks: clearLock(locks, key) };
    changed();
    return;
  }
  applyLock(setLock(state.design, key, null, locks, { profile: profile() }));
}

/** Type a lock's target: 2.0 for a 2.0 L engine, 7000 for the redline. */
function typeLock(el, key) {
  const L = LOCKS[key], lv = el.querySelector(".lv");
  const box = document.createElement("input");
  box.type = "number"; box.step = L.step; box.value = Number(state.design.locks[key].toFixed(L.step < 1 ? 2 : 0));
  lv.replaceWith(box); box.focus(); box.select();
  let done = false;
  const finish = (apply) => {
    if (done) return; done = true;
    const v = Number(box.value);
    if (apply && box.value.trim() !== "" && Number.isFinite(v)) {
      applyLock(setLock(state.design, key, v, state.design.locks, { profile: profile() }));
    }
    renderLocks();
  };
  box.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  box.onclick = (e) => e.stopPropagation();
  box.onblur = () => finish(true);
}

function renderWhy(a) {
  const l = SECTIONS.find((x) => x.id === state.section) || SECTIONS[0];
  const ctx = { car: carFor(state.design), gearingNote: profile().gearingNote, profile: profile() };
  const d = state.design;
  $("figs").innerHTML = (l.figures?.(d, a, ctx) ?? []).map((f) =>
    `<div class="fig${f.tone ? " " + f.tone : ""}${f.tip ? " has-more" : ""}"${f.tip ? ' tabindex="0"' : ""}>` +
    `<span class="k">${f.label}</span><span class="val">${f.value}</span>` +
    (f.tip ? `<div class="more">${f.tip}</div>` : "") + "</div>").join("");
  const notes = sectionNotes(l, d, a, ctx);
  $("readoutNotes").innerHTML = notes.map((n) =>
    `<li class="note ${n.level}${n.more ? " has-more" : ""}"${n.more ? ' tabindex="0"' : ""}>` +
    `<span class="mark">${n.level === "crit" ? "!" : n.level === "warn" ? "▲" : "i"}</span>` +
    `<span class="t">${n.text}</span>` +
    (n.more ? `<div class="more">${n.more}</div>` : "") + "</li>").join("");
  $("readoutNotes").hidden = !notes.length;
  const bg = l.background?.(d, a, ctx) ?? [];
  $("bgBody").innerHTML = bg.map((t) => `<p>${t}</p>`).join("");
  $("bg").hidden = !bg.length;
  const st = $("toolSteps");
  if (st) st.innerHTML = `Steps now: ${steps(state.design).map((x, i) => `${i + 1}→${i + 2} <b>${x.toFixed(2)}</b>`).join(" · ")}`;
}

/** The target car for gearing, with its mass adjusted for this engine's weight. */
function carFor(d) {
  const prof = profile(), fam = familyFor(prof, d.layout);
  return { ...prof.car, mass: prof.car.mass + (mass(d) - fam.donorMass) };
}

/* ---------- stats ---------- */
function delta(v, b, unit, digits = 0) {
  const dv = v - b;
  if (Math.abs(dv) < Math.pow(10, -digits) / 2) return `<div class="d same">= baseline</div>`;
  return `<div class="d ${dv > 0 ? "up" : "down"}">${dv > 0 ? "+" : "−"}${Math.abs(dv).toFixed(digits)} ${unit}</div>`;
}

function renderStats(a, b) {
  const locks = state.design.locks ?? {};
  const pad = (key) => (locks[key] != null && locks[key] !== false ? `<svg class="pad" viewBox="0 0 11 12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="5.5" width="9" height="6" rx="1.2" fill="currentColor" stroke="none"/><path d="M3 5.5V3.6a2.5 2.5 0 0 1 5 0v1.9"/></svg>` : "");
  const s = (k, v, d, key) => `<div class="stat"><div class="k">${k}${key ? pad(key) : ""}</div><div class="v">${v}</div>${d}</div>`;
  const md = mass(state.design), mb = mass(state.baseline);
  $("stats").innerHTML = [
    s("Engine", `${layoutName(state.design)} <small>${a.litres.toFixed(2)} L</small>`, delta(a.litres, b.litres, "L", 2), "displacement"),
    s("Mass", `${fmt0(md)} <small>kg</small>`, delta(md, mb, "kg"), "mass"),
    s("Redline", `${fmt0(a.redline)} <small>rpm</small>`, delta(a.redline, b.redline, "rpm"), "redline"),
    s("Peak torque", `${fmt0(a.peakTorque)} <small>N·m @ ${fmt0(a.peakTorqueRpm)}</small>`, delta(a.peakTorque, b.peakTorque, "N·m")),
    s("Peak power", `${fmt0(a.peakPower)} <small>kW · ${fmt0(hp(a.peakPower))} hp</small>`, delta(a.peakPower, b.peakPower, "kW")),
    s("Specific output", `${fmt0(a.specificPower)} <small>kW/L</small>`, delta(a.specificPower, b.specificPower, "kW/L")),
  ].join("");
}

/* ---------- rpm band and hover readout ---------- */
/* ---------- a recorded run, compared with the design ---------- */
let runResult = null;

function runAnalysis() {
  if (!state.run) return null;
  try { return analyseRun(state.run.data, state.design, state.run.laps); } catch (e) { return { error: String(e.message || e) }; }
}

function renderRun(ra) {
  const card = $("runCard"), chip = $("runChip");
  chip.hidden = !state.run;
  card.hidden = !state.run;
  $("runLegend").hidden = !(ra && ra.torque && ra.torque.length);
  if (!state.run) return;
  const run = state.run.data;
  chip.querySelector(".txt").textContent = state.run.name;
  chip.title = `${run.vehicle} · ${run.date} ${run.time}`;
  $("runSub").textContent = `${run.vehicle || "unknown car"} · ${run.date} ${run.time}`;
  if (ra.error) { $("runBody").innerHTML = `<div class="warn">${ra.error}</div>`; return; }
  const f0 = (v) => (v == null ? "–" : fmt0(v));
  const pct = (a, b) => (a == null || !b ? null : ((a - b) / b) * 100);
  const cls = (p, tol) => (p == null ? "" : Math.abs(p) <= tol ? "ok" : "off");
  const sign = (p) => (p == null ? "–" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`);
  const parts = [];
  if (!ra.matches) {
    parts.push(`<div class="warn">This run isn't from this design's exported config (${run.vehicle || "no car name"}). ` +
      `The comparison below uses the design's numbers anyway.</div>`);
  }
  const offGears = ra.gears.filter((g) => g.ratio && g.designRatio && Math.abs(g.ratio / g.designRatio - 1) > 0.01);
  if (offGears.length) {
    parts.push(`<div class="warn">The run's gear ratios don't match the design's in ${offGears.map((g) => ORD[g.gear - 1] || g.gear).join(", ")}: ` +
      `the gearing was changed after this run was recorded, or the config was edited in BeamNG.</div>`);
  }
  // torque
  if (ra.torque.length) {
    const rows = ra.torque.map((t) => { const p = pct(t.logged, t.design);
      return `<tr><td>${fmt0(t.rpm)}</td><td>${f0(t.logged)}</td><td>${f0(t.design)}</td><td class="${cls(p, 5)}">${sign(p)}</td></tr>`; }).join("");
    const mean = ra.torque.reduce((s, t) => s + Math.abs(pct(t.logged, t.design)), 0) / ra.torque.length;
    parts.push(`<div><h4>Full-throttle torque</h4><table><tr><th>rpm</th><th>logged</th><th>design</th><th></th></tr>${rows}</table>` +
      `<div class="note">Average difference ${mean.toFixed(1)}%. Logged torque plus what the revs climbing took to spin up the engine's own crank and flywheel; ` +
      `moments where the clutch slipped or the rev limiter cut are left out. Only rpm the run held at full throttle, clutch in, appear: ` +
      `a pull from low revs in a tall gear covers the whole curve.</div></div>`);
  } else {
    parts.push(`<div><h4>Full-throttle torque</h4><div class="note">No full-throttle running in this run, so the torque curve can't be checked. A pull from low revs in a tall gear covers it.</div></div>`);
  }
  // gearing
  if (ra.gears.length) {
    const rows = ra.gears.map((g) => { const p = pct(g.ratio, g.designRatio);
      return `<tr><td>${ORD[g.gear - 1] || g.gear}</td><td>${g.ratio ? g.ratio.toFixed(3) : "–"}</td><td>${g.designRatio ? g.designRatio.toFixed(3) : "–"}</td>` +
        `<td class="${cls(p, 1)}">${sign(p)}</td><td>${f0(g.rpmPer100)}</td><td>${f0(g.design)}</td></tr>`; }).join("");
    parts.push(`<div><h4>Gearing</h4><table><tr><th>gear</th><th>ratio</th><th>design</th><th></th><th>rpm@100</th><th>design</th></tr>${rows}</table>` +
      `<div class="note">Ratio = engine speed ÷ driven-wheel speed (gear × final drive): checks the gearbox itself. ` +
      `rpm at 100 km/h also depends on the tyres and their slip, set up in BeamNG.</div></div>`);
  }
  // shifts and what the car did
  const sm = ra.summary;
  const shifts = ra.shifts.map((x) => `<tr><td>${x.from}→${x.to}</td><td>${f0(x.left)}</td><td>${f0(x.landed)}</td><td>${f0(x.kmh)}</td></tr>`).join("");
  const lapList = ra.laps.length >= 2 ? ra.laps.slice(1).map((t, i) => (t - ra.laps[i]).toFixed(2) + " s").join(", ") : null;
  parts.push(`<div><h4>What the car did</h4><table>` +
    `<tr><td>Length</td><td>${sm.duration.toFixed(1)} s</td></tr>` +
    `<tr><td>Top speed</td><td>${sm.topSpeed.toFixed(1)} km/h${sm.topRpm != null ? ` at ${f0(sm.topRpm)} rpm in ${ORD[sm.topGear - 1] || sm.topGear}` : ""}</td></tr>` +
    `<tr><td>0–100 km/h</td><td>${sm.zeroTo100 != null ? sm.zeroTo100.toFixed(2) + " s" : "–"}</td></tr>` +
    `<tr><td>Max water / oil</td><td>${f0(sm.water)} / ${f0(sm.oil)} °C</td></tr>` +
    (lapList ? `<tr><td>Laps</td><td>${lapList}</td></tr>` : "") + `</table>` +
    (shifts ? `<table style="margin-top:8px"><tr><th>upshift</th><th>left</th><th>landed</th><th>km/h</th></tr>${shifts}</table>` : "") +
    `<div class="note">These depend on the whole car as set up in BeamNG (tyres, aero, exhaust, mass), so they're shown as measured.</div></div>`);
  $("runBody").innerHTML = parts.join("");
}

async function openRun() {
  try {
    const picked = await platform.openRun();
    if (!picked) return;
    state.run = { name: picked.name, data: parseLd(picked.ld), laps: parseLdx(picked.ldx) };
    changed();
  } catch (e) {
    fileMessage(`Couldn't open the run: ${e.message || e}`, false);
    $("notesPanel").hidden = false;
  }
}
$("runBtn").onclick = openRun;
$("runClose").onclick = () => { state.run = null; changed(); };

function renderBand() {
  const [lo, hi] = state.band;
  const a = bandStats(state.design, lo, hi), b = bandStats(state.baseline, lo, hi);
  const cmp = (v, w, unit, digits = 0, lowerIsBetter = false) => {
    const dv = v - w;
    if (Math.abs(dv) < Math.pow(10, -digits) / 2) return `<span class="same">=</span>`;
    const good = lowerIsBetter ? dv < 0 : dv > 0;
    return `<span class="${good ? "up" : "down"}">${dv > 0 ? "+" : "−"}${Math.abs(dv).toFixed(digits)}${unit}</span>`;
  };
  $("bandStats").innerHTML =
    `<span><span class="k">Min torque</span><b>${fmt0(a.min)}</b> N·m ${cmp(a.min, b.min, "")}</span>` +
    `<span><span class="k">Max</span><b>${fmt0(a.max)}</b> N·m ${cmp(a.max, b.max, "")}</span>` +
    `<span><span class="k">Spread</span><b>${(a.spread * 100).toFixed(1)}%</b> ${cmp(a.spread * 100, b.spread * 100, " pts", 1, true)}</span>` +
    `<span><span class="k">Avg power</span><b>${fmt0(a.avgPower)}</b> kW ${cmp(a.avgPower, b.avgPower, "")}</span>`;
}

function setReadout(x, ys, idx, runTorque) {
  const el = $("readout");
  if (idx == null || x[idx] == null) { el.innerHTML = ""; return; }
  const v = (n) => (n == null ? "–" : fmt0(n));
  // the run's nearest logged bin (they're 250 rpm apart)
  let run = "";
  if (runTorque && runTorque.size) {
    const bin = Math.round(x[idx] / 250) * 250;
    if (runTorque.has(bin)) run = ` <span class="runv">· run ${fmt0(runTorque.get(bin))} N·m @ ${fmt0(bin)}</span>`;
  }
  el.innerHTML = `<b>${fmt0(x[idx])} rpm</b> · <b>${v(ys[0][idx])}</b> N·m <b>${v(ys[1][idx])}</b> kW` +
    ` <span class="base">· baseline ${v(ys[2][idx])} N·m ${v(ys[3][idx])} kW</span>${run}`;
}

$("bandLo").value = state.band[0];
$("bandHi").value = state.band[1];
for (const id of ["bandLo", "bandHi"]) {
  $(id).onchange = () => {
    let lo = Number($("bandLo").value) || 1000, hi = Number($("bandHi").value) || 1000;
    if (lo > hi) [lo, hi] = [hi, lo];
    lo = Math.max(1000, Math.round(lo / 50) * 50); hi = Math.min(9500, Math.round(hi / 50) * 50);
    state.band = [lo, hi]; $("bandLo").value = lo; $("bandHi").value = hi;
    changed();
  };
}

/* ---------- fit ---------- */
const ICONS = { ok: "✓", warn: "!", fail: "✗", info: "i" };

const SURFACE_COLOURS = { alloy: "#a89984", grey: "#665c54", dark: "#3c3836", cover: "#3c3836", chrome: "#d5c4a1" };

function fitSvg(view, fit) {
  // in the engine's own frame: side view is along the crank (nose at the left) against
  // height, top view along the crank against width; the anchor (gearbox face, bottom) is 0
  const bay = fit.bay;
  const W = 300, H = 180, pad = 16;
  const ys = [0.1, -bay.front - 0.12];
  const vs = view === "side" ? [bay.bottom - 0.08, bay.top + 0.08] : [-bay.halfWidth - 0.1, bay.halfWidth + 0.1];
  const s = Math.min((W - 2 * pad) / (ys[0] - ys[1]), (H - 2 * pad) / (vs[1] - vs[0]));
  const X = (y) => pad + (y - ys[1]) * s;
  const V = (v) => H - pad - (v - vs[0]) * s;
  const pt = (p) => (view === "side" ? [X(p[1]), V(p[2])] : [X(p[1]), V(p[0])]);
  // the model's faces, furthest first
  const depth = (q) => q.reduce((t, p) => t + (view === "side" ? -p[0] : p[2]), 0) / q.length;
  const faces = fit.parts.flatMap((part) => part.quads.map((q) => ({ q, c: SURFACE_COLOURS[part.material] })))
    .sort((a, b) => depth(a.q) - depth(b.q));
  const model = faces.map(({ q, c }) =>
    `<polygon points="${q.map((p) => pt(p).join(",")).join(" ")}" fill="${c}" stroke="${C.bg0}" stroke-width=".4"/>`).join("");
  const n = Object.fromEntries(fit.nodes.map((r) => [r[0], r]));
  const box = (ids) => ids.map((id) => pt([n[id][1], n[id][2], n[id][3]]).join(",")).join(" ");
  const outline = view === "side" ? ["e1r", "e2r", "e4r", "e3r"] : ["e3r", "e4r", "e4l", "e3l"];
  const colour = !fit.ok ? C.red : fit.checks.some((c) => c.level === "warn") ? C.yellow : C.green;
  const bayRect = view === "side"
    ? [X(-bay.front), V(bay.top), X(0) - X(-bay.front), V(bay.bottom) - V(bay.top)]
    : [X(-bay.front), V(bay.halfWidth), X(0) - X(-bay.front), V(-bay.halfWidth) - V(bay.halfWidth)];
  const orient = fit.frame?.orientation ?? "longitudinal";
  const limit = fit.toRadiator ? "radiator" : "bay limit";
  const nose = orient === "longitudinal" ? "front ←" : orient === "transverse" ? "crank nose ←" : "rear ←";
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <rect x="${bayRect[0]}" y="${bayRect[1]}" width="${bayRect[2]}" height="${bayRect[3]}" fill="none" stroke="${C.bg3}" stroke-dasharray="5 4"/>
    <line x1="${X(-bay.front)}" y1="${pad / 2}" x2="${X(-bay.front)}" y2="${H - pad / 2}" stroke="${C.blue}" stroke-width="1"/>
    <text x="${X(-bay.front) + 4}" y="${pad}" fill="${C.blue}" font-size="10">${limit}</text>
    ${model}
    <polygon points="${box(outline)}" fill="none" stroke="${colour}" stroke-width="1.2" stroke-dasharray="4 3"/>
    <text x="${W - pad}" y="${H - 4}" fill="${C.gray}" font-size="10" text-anchor="end">${nose}</text>
  </svg>`;
}

function renderFit(a) {
  const prof = profile();
  const fit = checkFit(state.design, prof, a);
  $("fitSub").textContent = `${layoutName(state.design)} in the ${prof.name} · ${prof.layoutNote}`;
  $("fitViews").innerHTML =
    `<figure><figcaption>Side</figcaption>${fitSvg("side", fit)}</figure>` +
    `<figure><figcaption>Top</figcaption>${fitSvg("top", fit)}</figure>`;
  $("fitChecks").innerHTML = fit.checks.map((c) =>
    `<li class="${c.level}"><span class="ic">${ICONS[c.level]}</span><span class="read">${c.text}</span></li>`).join("");
  $("exportBtn").disabled = !fit.ok;
  $("exportBtn").title = fit.ok ? "" : `Doesn't fit the ${prof.name}: see Fit`;
  return fit;
}

/* ---------- charts ---------- */
const ORD = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
/** Share of peak power the engine makes at an rpm, from the analysed curve. */
function powerShareAt(a, rpm) {
  const i = Math.max(0, Math.min(a.rpm.length - 1, Math.round((rpm - a.rpm[0]) / (a.rpm[1] - a.rpm[0]))));
  return a.power[i] / a.peakPower;
}
/** Engine rpm against road speed in each gear: the sawtooth you drive through. */
function rpmSawtooth(g, a) {
  const d = state.design, red = g.redline;
  const colours = [C.green, C.aqua, C.blue, C.purple, C.yellow, C.orange];
  const out = {
    x: g.speeds, xFmt: (v) => `${v}`, height: 190, xUnit: "km/h", sync: "gearing",
    title: "Engine rpm in each gear · km/h",
    legend: `<span><i class="sw" style="background:var(--orange)"></i>Redline</span><span><i class="sw" style="background:var(--aqua)"></i>Peak power</span>`,
    scales: { y: { label: "rpm", range: [0, Math.ceil((red + 500) / 1000) * 1000] } },
    series: g.rs.map((r, i) => ({
      label: `g${i + 1}`, name: ORD[i], color: colours[i],
      sub: (idx) => { const rpm = rpmAt(d, g.speeds[idx], r); return `${Math.round(powerShareAt(a, rpm) * 100)}% power`; },
      values: g.speeds.map((v) => { const rpm = rpmAt(d, v, r); return rpm <= red && rpm >= 800 ? rpm : null; }),
    })),
    hlines: [{ y: red, color: C.orange, label: "redline" }, { y: g.peakPowerRpm, color: C.aqua, label: "peak power" }],
  };
  // best shift points: a dot where each gear is best left
  const best = new Map(g.bestShifts.map((s) => [Math.round(s.kmh), s.rpm]));
  out.series.push({ label: "best", name: "Best shift", unit: "rpm", color: C.fg1, points: true, size: 7,
    values: g.speeds.map((v) => best.get(v) ?? null) });
  out.legend += `<span><i class="sw" style="background:var(--fg1)"></i>Best shift points</span>`;
  // the run: logged rpm against road speed, per gear, as points on the same km/h grid
  if (runResult && runResult.points && runResult.points.length) {
    const byGear = new Map();
    for (const p of runResult.points) {
      const k = Math.round(p.kmh);
      if (k < 0 || k >= g.speeds.length) continue;
      if (!byGear.has(p.gear)) byGear.set(p.gear, new Map());
      byGear.get(p.gear).set(k, p.rpm);
    }
    for (const [gear, pts] of [...byGear.entries()].sort((x, y) => x[0] - y[0])) {
      out.series.push({ label: `r${gear}`, name: `Run ${ORD[gear - 1] || gear}`, color: colours[(gear - 1) % colours.length],
        points: true, size: 4, values: g.speeds.map((v) => pts.get(v) ?? null) });
    }
    out.legend += `<span><i class="sw" style="background:var(--fg4)"></i>Dots: the run, logged in BeamNG</span>`;
  }
  return out;
}

/** Valve lift against crank angle for both cams, with the overlap shaded. */
function valveDiagram() {
  const d = state.design, bd = state.baseline;
  const x = [];
  for (let ang = -360; ang <= 360; ang += 4) x.push(ang);
  const lift = (des, v) => x.map((ang) => (des.duration != null ? valveLift(des, ang, v) : null));
  const both = x.filter((ang) => valveLift(d, ang, "intake") > 0.3 && valveLift(d, ang, "exhaust") > 0.3);
  return {
    x, height: 170, pin: "valves",
    title: "Valve lift through one cycle · exhaust closes, intake opens around TDC; the shaded band is the overlap",
    legend: `<span><i class="sw" style="background:var(--orange)"></i>Exhaust valve</span><span><i class="sw" style="background:var(--blue)"></i>Intake valve</span><span><i class="sw dash"></i>Baseline cam</span>`,
    xFmt: (v) => (v === 0 ? "TDC" : `${v}°`), xTip: (v) => (v === 0 ? "TDC" : `${v}° from TDC`),
    scales: { y: { label: "lift mm", range: [0, 15] } },
    series: [
      { label: "exh", name: "Exhaust", unit: "mm", values: lift(d, "exhaust"), color: C.orange },
      { label: "int", name: "Intake", unit: "mm", values: lift(d, "intake"), color: C.blue },
      { label: "exhB", name: "Base exh", unit: "mm", values: lift(bd, "exhaust"), color: C.fg4, dash: true, width: 1.2 },
      { label: "intB", name: "Base int", unit: "mm", values: lift(bd, "intake"), color: C.fg4, dash: true, width: 1.2 },
    ],
    bands: both.length ? [{ x0: both[0], x1: both[both.length - 1], color: "rgba(211, 134, 155, 0.18)" }] : [],
    marks: [{ x: 0, color: C.bg4, label: "TDC" }],
  };
}

/** Two (t, rpm) curves on one time grid, for uPlot. */
function onTimeGrid(curves, step, until) {
  const x = [];
  for (let t = 0; t <= until + 1e-9; t += step) x.push(Math.round(t * 1000) / 1000);
  const at = (c, t) => {
    if (t > c.t[c.t.length - 1]) return null;
    let i = 1;
    while (i < c.t.length - 1 && c.t[i] < t) i++;
    const t0 = c.t[i - 1], t1 = c.t[i];
    return c.rpm[i - 1] + (c.rpm[i] - c.rpm[i - 1]) * (t1 > t0 ? (t - t0) / (t1 - t0) : 0);
  };
  return { x, ys: curves.map((c) => x.map((t) => at(c, t))) };
}

/** Forced induction: boost against rpm, and the torque with and without it. */
function exhaustChart() {
  const d = state.design, bd = state.baseline;
  $("sectionChartTitle").textContent = "Back pressure";
  $("sectionChartSub").textContent = "kPa at full throttle · it grows with the square of the gas flow";
  const red = Math.max(redline(d), redline(bd));
  const x = [];
  for (let n = 1000; n <= red; n += 50) x.push(n);
  const mine = (dd, f) => x.map((n) => (n <= redline(dd) ? f(n) : null));
  const bp = mine(d, (n) => backPressure(d, n) / 1000), bb = mine(bd, (n) => backPressure(bd, n) / 1000);
  const top = Math.max(10, ...bp.filter((v) => v != null), ...bb.filter((v) => v != null)) * 1.15;
  $("sectionLegend").innerHTML = `<span><i class="sw" style="background:var(--orange)"></i>Back pressure</span><span><i class="sw dash"></i>Baseline</span>`;
  const free = freeFlowing(d);
  const t = mine(d, (n) => Math.max(0, brakeTorque(d, n))), tf = mine(d, (n) => Math.max(0, brakeTorque(free, n)));
  const marks = d.manifold === "headers" ? [{ x: headerTunedRpm(d), color: C.aqua, label: "headers" }] : [];
  return {
    x, xUnit: "rpm",
    scales: { y: { label: "kPa", range: [0, Math.ceil(top / 5) * 5] } },
    series: [
      { label: "bp", name: "Back pressure", unit: "kPa", fmt: (v) => v.toFixed(1), color: C.orange, values: bp },
      { label: "base", name: "Baseline", unit: "kPa", fmt: (v) => v.toFixed(1), color: C.fg4, dash: true, width: 1.5, values: bb },
    ],
    marks,
    pin: "backpressure",
    extra: {
      x, height: 200, xUnit: "rpm",
      title: "Torque with this exhaust and with a free-flowing one · N·m at the flywheel",
      legend: `<span><i class="sw" style="background:var(--green)"></i>This exhaust</span><span><i class="sw dash"></i>Free-flowing</span>`,
      scales: { y: { label: "N·m", range: [0, Math.ceil(Math.max(...tf.filter((v) => v != null), 1) * 1.15 / 50) * 50] } },
      series: [
        { label: "exh", name: "This exhaust", unit: "N·m", fmt: (v) => Math.round(v), color: C.green, values: t },
        { label: "free", name: "Free-flowing", unit: "N·m", fmt: (v) => Math.round(v), color: C.fg4, dash: true, width: 1.5, values: tf },
      ],
      marks,
      pin: "exhaustTorque",
    },
  };
}

function inductionChart(a, b) {
  const d = state.design, bd = state.baseline;
  const on = (x) => x.induction && x.induction !== "none";
  $("sectionChartTitle").textContent = "Boost";
  $("sectionChartSub").textContent = "psi at full throttle, steady · BeamNG's own turbo and supercharger sums";
  const red = Math.max(redline(d), redline(bd));
  const x = [];
  for (let n = 1000; n <= red; n += 50) x.push(n);
  const full = on(d) ? fullBoostRpm(d) : null;
  const twin = d.induction === "twincharged";
  $("sectionLegend").innerHTML = `<span><i class="sw" style="background:var(--orange)"></i>Boost</span>` +
    (twin ? `<span><i class="sw" style="background:var(--purple)"></i>Supercharger</span><span><i class="sw" style="background:var(--aqua)"></i>Turbo</span>` : "") +
    `<span><i class="sw dash"></i>Baseline</span>`;
  const top = Math.max(5, on(d) ? d.boost : 0, on(bd) ? bd.boost : 0) * 1.25 + 2;
  const na = naturallyAspirated(d);
  const naT = x.map((n) => (n <= redline(d) ? Math.max(0, brakeTorque(na, n)) : null));
  const bT = x.map((n) => (n <= redline(d) ? Math.max(0, brakeTorque(d, n)) : null));
  const mine = (f) => x.map((n) => (on(d) && n <= redline(d) ? f(n) : null));
  const marks = [];
  if (full) marks.push({ x: full, color: C.aqua, label: "full boost" });
  if (twin || (d.induction === "turbo" && d.turboLayout === "sequential")) marks.push({ x: d.handoverRpm, color: C.purple, label: "hand-over" });
  return {
    x, xUnit: "rpm",
    scales: { y: { label: "psi", range: [-3, Math.ceil(top)] } },
    series: [
      { label: "boost", name: "Boost", unit: "psi", fmt: (v) => v.toFixed(1), color: C.orange, values: mine((n) => steadyBoost(d, n)) },
      ...(twin ? [
        { label: "sc", name: "Supercharger", unit: "psi", fmt: (v) => v.toFixed(1), color: C.purple, width: 1.2, values: mine((n) => superchargerBoost(d, n)) },
        { label: "turbo", name: "Turbo", unit: "psi", fmt: (v) => v.toFixed(1), color: C.aqua, width: 1.2, values: mine((n) => turboBoost(d, n)) },
      ] : []),
      { label: "base", name: "Baseline", unit: "psi", fmt: (v) => v.toFixed(1), color: C.fg4, dash: true, width: 1.5,
        values: x.map((n) => (on(bd) && n <= redline(bd) ? steadyBoost(bd, n) : null)) },
    ],
    marks,
    hlines: on(d) ? [{ y: d.boost, color: C.bg4, label: `${d.boost} psi` }] : [],
    pin: "boost",
    extra: {
      x, height: 200, xUnit: "rpm",
      title: "Torque with and without forced induction · N·m at the flywheel, after any knock and drive loss",
      legend: `<span><i class="sw" style="background:var(--green)"></i>With it</span><span><i class="sw dash"></i>Naturally aspirated</span>`,
      scales: { y: { label: "N·m", range: [0, Math.ceil(Math.max(...bT.filter((v) => v != null), 1) * 1.15 / 50) * 50] } },
      series: [
        { label: "boosted", name: "With it", unit: "N·m", fmt: (v) => Math.round(v), color: C.green, values: bT },
        { label: "na", name: "NA", unit: "N·m", fmt: (v) => Math.round(v), color: C.fg4, dash: true, width: 1.5, values: naT },
      ],
      pin: "boostTorque",
    },
  };
}

/** The rotating-mass section's second chart: the revs with the throttle shut, through a shift. */
function revDropChart() {
  const d = state.design, bd = state.baseline;
  const red = redline(d), rs = ratios(d);
  const g = onTimeGrid([revDrop(d, red, 1), revDrop(bd, redline(bd), 1, totalInertia(bd))], 0.01, 1);
  const land = rs.length > 1 ? (red * rs[1]) / rs[0] : null;
  return {
    x: g.x, height: 190, xUnit: "s", xTip: (v) => `${v.toFixed(2)} s after lifting`, xFmt: (v) => `${v}s`,
    title: `Throttle shut at redline: the revs falling during a 1→2 shift · the clutch bites at ${shiftTime(d).toFixed(1)} s (${(SHIFT_STYLES[d.shift] ?? SHIFT_STYLES.quick).label.toLowerCase()} shift)`,
    legend: `<span><i class="sw" style="background:var(--yellow)"></i>Revs, throttle shut</span><span><i class="sw dash"></i>Baseline</span>` +
      (land ? `<span><i class="sw" style="background:var(--aqua)"></i>Where 2nd gear wants them</span>` : ""),
    scales: { y: { label: "rpm", range: [0, Math.ceil((Math.max(red, redline(bd)) + 500) / 1000) * 1000] } },
    series: [
      { label: "drop", name: "Revs", unit: "rpm", values: g.ys[0], color: C.yellow },
      { label: "base", name: "Baseline", unit: "rpm", values: g.ys[1], color: C.fg4, dash: true, width: 1.5 },
    ],
    marks: [{ x: shiftTime(d), color: C.orange, label: "clutch bites" }],
    hlines: land ? [{ y: land, color: C.aqua, label: `2nd wants ${Math.round(land).toLocaleString("en-US")}` }] : [],
    pin: "revdrop",
  };
}

function sectionChart(a, b) {
  const id = state.section;
  if (id === "rotating") {
    $("sectionChartTitle").textContent = "Free rev";
    $("sectionChartSub").textContent = "full throttle in neutral from 1,500 rpm · rev response is torque ÷ inertia";
    const up = revUp(state.design, 1500), ub = revUp(state.baseline, 1500, totalInertia(state.baseline));
    const until = Math.max(up.time, ub.time) * 1.05;
    const g = onTimeGrid([up, ub], until > 2 ? 0.02 : 0.01, until);
    $("sectionLegend").innerHTML = `<span><i class="sw" style="background:var(--green)"></i>Revs (this design)</span><span><i class="sw dash"></i>Baseline</span>`;
    return {
      x: g.x, xUnit: "s", xTip: (v) => `${v.toFixed(2)} s`, xFmt: (v) => `${v}s`,
      scales: { y: { label: "rpm", range: [0, Math.ceil((Math.max(redline(state.design), redline(state.baseline)) + 500) / 1000) * 1000] } },
      series: [
        { label: "up", name: "Revs", unit: "rpm", values: g.ys[0], color: C.green },
        { label: "base", name: "Baseline", unit: "rpm", values: g.ys[1], color: C.fg4, dash: true, width: 1.5 },
      ],
      marks: [{ x: up.time, color: C.green, label: `${up.time.toFixed(2)} s` }],
      extra: revDropChart(),
    };
  }
  if (id === "displacement") {
    $("sectionChartTitle").textContent = "Mean piston speed";
    $("sectionChartSub").textContent = "m/s · the build's limit sets the redline";
    const g = align([{ x: a.rpm, ys: [a.vp] }, { x: b.rpm, ys: [b.vp] }]);
    $("sectionLegend").innerHTML = `<span><i class="sw" style="background:var(--yellow)"></i>Piston speed</span><span><i class="sw dash"></i>Baseline</span>`;
    return {
      x: g.x, scales: { y: { label: "m/s", range: [0, 28] } },
      series: [
        { label: "piston", name: "Piston", values: g.ys[0][0], color: C.yellow },
        { label: "base", name: "Baseline", values: g.ys[1][0], color: C.fg4, dash: true, width: 1.5 },
      ],
      hlines: Object.values(BUILDS).map((bl) => ({
        y: bl.maxPistonSpeed, color: bl.label === BUILDS[state.design.build].label ? C.orange : C.bg3,
        label: `${bl.label} limit ${bl.maxPistonSpeed} m/s`,
      })),
      marks: [{ x: a.redline, color: C.orange, label: "redline" }],
    };
  }
  if (id === "breathing") {
    $("sectionChartTitle").textContent = "Volumetric efficiency";
    $("sectionChartSub").textContent = "% of the cylinder filled · the torque curve follows this shape";
    const pctArr = (xs) => xs.map((v) => v * 100);
    const g = align([{ x: a.rpm, ys: [pctArr(a.ve)] }, { x: b.rpm, ys: [pctArr(b.ve)] }]);
    $("sectionLegend").innerHTML = `<span><i class="sw" style="background:var(--blue)"></i>VE</span><span><i class="sw dash"></i>Baseline</span>` +
      `<span><i class="sw" style="background:var(--purple)"></i>Cam's best rpm</span><span><i class="sw" style="background:var(--aqua)"></i>Intake tuning</span>`;
    return {
      x: g.x, scales: { y: { label: "VE %", range: [30, 115] } },
      series: [
        { label: "ve", name: "VE", unit: "%", values: g.ys[0][0], color: C.blue },
        { label: "base", name: "Baseline", unit: "%", values: g.ys[1][0], color: C.fg4, dash: true, width: 1.5 },
      ],
      marks: [
        { x: a.camPeakRpm, color: C.purple, label: "cam" },
        { x: state.design.tuneRpm, color: C.aqua, label: "intake" },
      ],
      extra: valveDiagram(),
    };
  }
  if (id === "induction") return inductionChart(a, b);
  if (id === "exhaust") return exhaustChart();
  if (id === "gearing") {
    const g = analyseGearing(state.design, carFor(state.design));
    const colours = [C.green, C.aqua, C.blue, C.purple, C.yellow, C.orange];
    $("sectionChartTitle").textContent = "Push at the tires";
    $("sectionChartSub").textContent = "kN vs road speed · where a gear curve crosses the resistance line is that gear's top speed";
    const ord = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
    $("sectionLegend").innerHTML = g.rs.map((r, i) => `<span><i class="sw" style="background:${colours[i]}"></i>${ord[i]} (${r.toFixed(2)})</span>`).join("") +
      `<span><i class="sw dash"></i>Ideal (peak power)</span><span><i class="sw" style="background:var(--red)"></i>Drag + rolling</span>`;
    const top = Math.max(...g.force.flat().filter((v) => v != null), 1);
    return {
      x: g.speeds, xFmt: (v) => `${v}`, xUnit: "km/h", sync: "gearing",
      scales: { y: { label: "kN", range: [0, Math.ceil(top * 1.15)] } },
      series: [
        ...g.force.map((f, i) => ({ label: `g${i + 1}`, name: ORD[i], values: f, color: colours[i],
          sub: (idx) => `${Math.round(rpmAt(state.design, g.speeds[idx], g.rs[i])).toLocaleString("en-US")} rpm` })),
        { label: "ideal", values: g.ideal.map((v) => (v != null && v <= top * 1.15 ? v : null)), color: C.fg4, dash: true, width: 1.2, name: "Ideal" },
        { label: "resist", values: g.resist, color: C.red, width: 1.5, name: "Drag+roll" },
      ],
      marks: [{ x: g.top, color: C.bg4, label: `top ${Math.round(g.top)} km/h` }],
      extra: rpmSawtooth(g, a),
    };
  }
  if (id === "compression") {
    $("sectionChartTitle").textContent = "Knock";
    $("sectionChartSub").textContent = "knock index vs the fuel's limit · above the line the ECU pulls timing";
    const g = align([{ x: a.rpm, ys: [a.knock, a.lost] }, { x: b.rpm, ys: [b.knock] }]);
    $("sectionLegend").innerHTML = `<span><i class="sw" style="background:var(--orange)"></i>Knock index</span><span><i class="sw dash"></i>Baseline</span>` +
      `<span><i class="sw" style="background:var(--red)"></i>Torque lost to retarded timing (N·m)</span>`;
    const lim = a.knockLimit;
    return {
      x: g.x,
      scales: { y: { label: "knock index", range: [Math.min(lim - 4, 6), Math.max(lim + 1.5, ...a.knock.map((k) => k + 0.3))] }, y2: { label: "N·m lost", range: [0, Math.max(20, a.knockLost * 1.3)] } },
      series: [
        { label: "knock", name: "Knock", unit: `(limit ${lim})`, values: g.ys[0][0], color: C.orange },
        { label: "base", name: "Baseline", unit: "", values: g.ys[1][0], color: C.fg4, dash: true, width: 1.5 },
        { label: "lost", name: "Lost", unit: "N·m", values: g.ys[0][1], color: C.red, scale: "y2", width: 1.5 },
      ],
      hlines: [{ y: lim, color: C.red, label: `${FUELS[state.design.fuel].label} limit ${lim}` }],
    };
  }
  $("sectionChartTitle").textContent = "Where the torque goes";
  $("sectionChartSub").textContent = "N·m · combustion minus friction = what reaches the flywheel";
  $("sectionLegend").innerHTML = `<span><i class="sw" style="background:var(--fg4)"></i>Combustion (indicated)</span>` +
    `<span><i class="sw" style="background:var(--red)"></i>Friction</span><span><i class="sw" style="background:var(--green)"></i>At the flywheel</span>`;
  return {
    x: a.rpm, scales: { y: { label: "N·m" } },
    series: [
      { label: "ind", name: "Combustion", values: a.ind, color: C.fg4 },
      { label: "fric", name: "Friction", values: a.fric, color: C.red },
      { label: "brake", name: "Flywheel", values: a.torque, color: C.green },
    ],
  };
}

function redraw() {
  pending = false;
  // charts are rebuilt below; keep the page where it is while they are briefly gone
  const pane = document.querySelector(".content"), side = document.querySelector("aside.side");
  const keep = [pane?.scrollTop, side?.scrollTop];
  // hold each chart's height until its replacement is laid out, so the pane never gets shorter
  const held = [...document.querySelectorAll(".content .chart")];
  for (const el of held) el.style.minHeight = `${el.offsetHeight}px`;
  const a = analyse(state.design, 50), b = analyse(state.baseline, 50);
  renderStats(a, b);
  renderLocks();
  renderWhy(a);
  renderFit(a);
  $("baselineName").textContent = `baseline: ${state.baseline.name}`;
  charts.forEach((c) => c.destroy());
  charts = [];
  runResult = runAnalysis();
  const g = align([{ x: a.rpm, ys: [a.torque, a.power] }, { x: b.rpm, ys: [b.torque, b.power] }]);
  const runTorque = new Map((runResult?.torque || []).map((t) => [t.rpm, t.logged]));
  const runSeries = runTorque.size ? [{ label: "Tr", values: g.x.map((x) => runTorque.get(x) ?? null), color: C.orange, points: true, size: 7 }] : [];
  charts.push(chart($("mainChart"), {
    x: g.x, height: 300,
    scales: { y: { label: "N·m", range: [0, null] }, y2: { label: "kW", range: [0, null] } },
    series: [
      { label: "T", values: g.ys[0][0], color: C.green },
      { label: "P", values: g.ys[0][1], color: C.aqua, scale: "y2" },
      { label: "Tb", values: g.ys[1][0], color: C.green, dash: true, width: 1.2 },
      { label: "Pb", values: g.ys[1][1], color: C.aqua, dash: true, width: 1.2, scale: "y2" },
      ...runSeries,
    ],
    marks: [{ x: a.redline, color: C.bg4, label: "redline" }],
    bands: [{ x0: state.band[0], x1: state.band[1], color: "rgba(184, 187, 38, 0.06)" }],
    tip: false,
    onCursor: (idx) => setReadout(g.x, [g.ys[0][0], g.ys[0][1], g.ys[1][0], g.ys[1][1]], idx, runTorque),
  }));
  const lc = sectionChart(a, b);
  charts.push(chart($("sectionChart"), { height: 220, ...lc }));
  $("valveChart").hidden = !lc.extra;
  if (lc.extra) {
    $("extraTitle").textContent = lc.extra.title || "";
    $("extraLegend").innerHTML = lc.extra.legend || "";
    charts.push(chart($("valveChart").querySelector(".chart"), lc.extra));
  }
  renderBand();
  renderRun(runResult);
  const restore = () => { if (pane) pane.scrollTop = keep[0]; if (side) side.scrollTop = keep[1]; };
  restore();
  requestAnimationFrame(() => { for (const el of held) el.style.minHeight = ""; restore(); });
}

function changed() {
  state.design = resolve(state.design);
  save();
  if (!pending) { pending = true; requestAnimationFrame(redraw); }
}

/* ---------- design name, target, baseline ---------- */
$("name").value = state.design.name;
$("name").oninput = () => { state.design.name = $("name").value.trim() || "Untitled"; changed(); };
/* the target car list: every car and truck, marked as it's checked */
let carList = Object.values(PROFILES).map((p) => ({ id: p.id, name: p.name }));
function carLabel(c) {
  const p = cars.known(c.id);
  if (!p) return { text: c.name, title: "Not checked yet: picking it reads its files" };
  if (!p.support || p.support.ok) {
    const how = p.detected ? "Worked out from the car's files" : "Checked profile";
    return { text: c.name, title: [how, p.layoutNote, ...(p.support?.notes ?? [])].filter(Boolean).join("\n") };
  }
  return { text: `${c.name} (can't take an engine)`, title: p.support.reason, disabled: true };
}
function renderCarList() {
  const sel = $("target-car");
  sel.innerHTML = carList.map((c) => {
    const l = carLabel(c);
    return `<option value="${c.id}" title="${l.title.replace(/"/g, "&quot;")}" ${c.id === state.target ? "selected" : ""} ${l.disabled ? "disabled" : ""}>${l.text}</option>`;
  }).join("");
  if (!carList.some((c) => c.id === state.target)) sel.value = profile().id;
}
async function pickCar(id) {
  state.target = id;
  $("exportPanel").hidden = true;
  const c = carList.find((x) => x.id === id);
  $("target-car").disabled = true;
  try { await cars.detect(id, c?.name); } finally { $("target-car").disabled = false; }
  if (!usable(cars.known(id))) state.target = DEFAULT_PROFILE;
  renderCarList();
  changed();
}
$("target-car").onchange = () => pickCar($("target-car").value);
renderCarList();
async function loadCars() {
  if (!platform.isDesktop) return;
  try {
    const names = await cars.names();
    const found = await listCars(platform, names);
    if (!found.length) return;
    carList = found;
    renderCarList();
    await pickCar(carList.some((c) => c.id === state.target) ? state.target : DEFAULT_PROFILE);
    // check the rest in the background, so the list shows which cars can take an engine
    for (const c of carList) {
      await cars.detect(c.id, c.name);
      renderCarList();
    }
  } catch (e) {
    console.warn("car list", e);
  }
}
$("pinBtn").onclick = () => { state.baseline = { ...state.design }; changed(); };
$("resetBtn").onclick = () => {
  const name = state.design.name;
  state.design = resolve({ ...DEFAULT_DESIGN, ...DEFAULT_PARTS, ...DEFAULT_GEARING, name });
  renderSection(); changed();
};

/* ---------- .crank files and notes ---------- */
function fileMessage(text, ok = true) {
  $("notesPanel").hidden = false;
  $("fileMsg").className = `msg ${ok ? "ok" : "err"}`;
  $("fileMsg").textContent = text;
}

function showDesign() {
  $("name").value = state.design.name;
  $("notes").value = state.design.notes || "";
  renderSection();
  changed();
}

$("notes").oninput = () => { state.design.notes = $("notes").value; save(); };
$("notesBtn").onclick = () => { $("fileMsg").textContent = ""; $("notesPanel").hidden = !$("notesPanel").hidden; };
$("notesClose").onclick = () => { $("notesPanel").hidden = true; };
$("saveBtn").onclick = async () => {
  try {
    const where = await platform.saveCrank(`${slug(state.design.name)}.${EXTENSION}`, toCrank(state.design));
    if (where) fileMessage(`Saved: ${where}`);
  } catch (e) { fileMessage(`Couldn't save: ${e}`, false); }
};
async function openFile(asBaseline) {
  try {
    const text = await platform.openCrank();
    if (text == null) return;
    const d = fromCrank(text);
    if (asBaseline) { state.baseline = d; changed(); return; }
    state.design = d;
    showDesign();
    if (d.notes) { $("fileMsg").textContent = ""; $("notesPanel").hidden = false; }
  } catch (e) { fileMessage(`Couldn't open: ${e.message || e}`, false); }
}
$("openBtn").onclick = () => openFile(false);
$("openBaseBtn").onclick = () => openFile(true);
$("notes").value = state.design.notes || "";

/* ---------- export ---------- */
async function renderTarget() {
  const pill = $("target");
  if (!platform.isDesktop) {
    pill.className = "pill warn"; pill.querySelector(".txt").textContent = "Browser preview: export needs the desktop app";
    return;
  }
  [state.folder, state.game] = await Promise.all([platform.beamngFolder(), platform.gameFolder()]);
  const ok = state.folder && state.game;
  pill.className = ok ? "pill ok" : "pill warn";
  pill.querySelector(".txt").textContent = ok ? "BeamNG found"
    : !state.game ? "BeamNG install not found" : "BeamNG user folder not found";
  pill.title = [state.game && `Game: ${state.game}`, state.folder && `User folder: ${state.folder}`].filter(Boolean).join("\n");
}

function openExport() {
  const d = state.design, prof = profile(), fam = familyFor(prof, d.layout);
  const rel = exportRelativePath(d, prof), a = analyse(d);
  const box = prof.config && gearboxFor(d, prof.config);
  const gears = ratios(d).map((r) => r.toFixed(2)).join(" / ");
  const panel = $("exportPanel");
  panel.hidden = false;
  panel.innerHTML =
    `<h3>Export “${d.name}” to the ${prof.name}</h3>` +
    `<div class="read">Writes a complete engine for the <b>Engine</b> slot: your torque curve in N·m, ` +
    `rev limiter at <b>${fmt0(a.redline)} rpm</b>, and a block sized and weighted as your ${layoutName(d)} ` +
    `(${fmt0(mass(d))} kg), with its own ${layoutName(d)} model. Mounts, intake, exhaust and radiator come from the stock ${fam.donorLabel}.</div>` +
    (box ? `<div class="read">Also writes a <b>vehicle config</b> for the ${prof.name} with this engine and your gearing: ` +
      `${box.label} at ${gears}, Race Adjustable final drive at ${d.finalDrive.toFixed(2)}. ` +
      `The rest of the car is the stock config; tyres stay the car's own.</div>` : "") +
    `<code>${state.folder ? `${state.folder}/${rel}` : rel}</code>` +
    `<div class="read"><b>Then in BeamNG</b><ol>` +
    `<li>First export only: restart the game so it finds the new mod. If a new config doesn't show in the vehicle selector, restart once more.</li>` +
    (box ? `<li>Spawn the ${prof.name} config <b>Crankcase: ${d.name}</b> from the vehicle selector: engine and gearing already set.</li>` +
      `<li>Or, on any ${prof.name}: Vehicle Config → <b>Engine</b> → Crankcase: ${d.name} (keeps that car's gearbox).</li>`
      : `<li>Spawn a ${prof.name} and open Vehicle Config.</li><li><b>Engine</b> → Crankcase: ${d.name}</li>`) +
    `<li>Re-exporting the same name overwrites the files. A changed model may need a game restart to reload.</li></ol></div>` +
    `<div id="exportMsg" class="msg"></div>` +
    `<div class="row"><button id="exportCancel" class="btn">Close</button>` +
    `<button id="exportGo" class="btn primary" ${platform.isDesktop ? "" : "disabled"}>Write files</button></div>`;
  $("exportCancel").onclick = () => { panel.hidden = true; };
  $("exportGo").onclick = async () => {
    const msg = $("exportMsg");
    try {
      // read and build everything first, so a failure writes nothing
      const donor = await Promise.all(donorFiles(fam).map((f) => platform.readVehicleFile(f)));
      const built = buildEngine(d, prof, donor);
      const { text, dae } = built;
      const cfg = prof.config ? buildConfig(d, prof, await platform.readVehicleFile(prof.config.base), built) : null;
      await platform.exportFile(exportRelativePath(d, prof, "dae"), dae);
      const r = await platform.exportFile(rel, text);
      let notes = [];
      if (built.exhaustCarried) notes.push(`The ${prof.name}'s exhaust slot hangs off its stock intake, which the turbo replaces, so the turbo part carries the exhaust's torque; the pipes and sound are the stock turbo's.`);
      else if (!built.exhaust && d.manifold != null) notes.push(`No exhaust slot found on the ${fam.donorLabel}: the car keeps its own exhaust, so it makes a little less than shown.`);
      if (cfg) {
        await platform.exportFile(exportRelativePath(d, prof, "pc"), cfg.pc);
        await platform.exportFile(infoRelativePath(d, prof), cfg.info);
        notes = [...notes, ...cfg.notes];
      }
      msg.className = "msg ok";
      msg.innerHTML = `Written: ${r.path}, its .dae model${prof.config ? " and the vehicle config" : ""}.` +
        notes.map((n) => `<br><span class="note">Note: ${n}</span>`).join("");
    } catch (e) {
      msg.className = "msg err";
      msg.textContent = `Couldn't export: ${e}`;
    }
  };
}
$("exportBtn").onclick = () => ($("exportPanel").hidden ? openExport() : ($("exportPanel").hidden = true));

window.addEventListener("resize", () => changed());
renderSteps();
renderSection();
renderTarget();
redraw();
loadCars();
