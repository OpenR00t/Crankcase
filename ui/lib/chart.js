// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
// uPlot charts in the Gruvbox Cove look.

export const C = {
  bg0: "#282828", bg1: "#3c3836", bg2: "#504945", bg3: "#665c54", fg1: "#ebdbb2", fg3: "#bdae93",
  fg4: "#a89984", gray: "#928374", green: "#b8bb26", aqua: "#8ec07c", yellow: "#fabd2f",
  orange: "#fe8019", red: "#fb4934", blue: "#83a598", purple: "#d3869b",
};
const FONT = '11px "CaskaydiaCove Nerd Font", "Cascadia Code", Consolas, monospace';

function axis(o = {}) {
  return {
    stroke: C.fg4, font: FONT, labelFont: FONT, gap: 4, size: 50,
    grid: { stroke: C.bg1, width: 1 }, ticks: { stroke: C.bg2, width: 1, size: 4 }, ...o,
  };
}

/**
 * chart(el, { x, series: [{ label, values, color, dash, width, scale, points }],
 *             scales: { y: {label, range}, y2?: {label, range} }, height, marks: [{x, color, label}],
 *             bands: [{x0, x1, color}], onCursor(idx) })
 * Hovering shows every series' value at the cursor (turn off with tip: false). Per series:
 * name (shown instead of label), unit (default: its scale's label), fmt(v), sub(idx) for an
 * extra note, tip: false to leave it out. Chart: xTip(x) or xUnit for the header, sync: key
 * to move the cursor of charts sharing an x axis together. Clicking a chart pins the cursor
 * at that x (charts with the same pin key, or sync key, pin together) until clicked again;
 * the pin survives redraws.
 * Returns the uPlot instance; call .destroy() before redrawing.
 */
// pinned x value per key, and the live charts showing each key
const pins = new Map(), live = new Map();

function pinTo(u, x, topFrac) {
  u.cursor._lock = false;
  u.setCursor({ left: u.valToPos(x, "x"), top: topFrac * u.over.clientHeight });
  u.cursor._lock = true;
}

export function chart(el, o) {
  const key = o.pin || o.sync || el.id || null;
  const scales = { x: { time: false } };
  const axes = [axis({ size: 30, values: (u, v) => v.map(o.xFmt || ((n) => (n >= 1000 ? `${n / 1000}k` : n))) })];
  for (const [key, s] of Object.entries(o.scales)) {
    scales[key] = s.range ? { range: s.range } : { auto: true };
    axes.push(axis({
      scale: key, label: s.label, labelSize: 16, side: key === "y" ? 3 : 1,
      grid: key === "y" ? axis().grid : { show: false },
      values: s.fmt ? (u, v) => v.map(s.fmt) : undefined,
    }));
  }
  const marks = o.marks || [];
  const opts = {
    width: Math.max(240, el.clientWidth),
    height: o.height ?? 260,
    legend: { show: false },
    padding: [10, 8, 0, 0],
    cursor: { y: false, drag: { x: false, y: false }, points: { size: 6 }, ...(o.sync ? { sync: { key: o.sync } } : {}) },
    scales, axes,
    series: [
      { label: "rpm" },
      ...o.series.map((s) => ({
        label: s.label, scale: s.scale || "y", stroke: s.color, width: s.width ?? 2,
        dash: s.dash ? [6, 5] : undefined,
        // points: true draws markers only (measured data), no line between them
        ...(s.points
          ? { paths: () => null, points: { show: true, size: s.size ?? 6, stroke: s.color, fill: s.color, width: 1 } }
          : { points: { show: false } }),
      })),
    ],
    hooks: {
      destroy: [(u) => { live.get(key)?.delete(u); }],
      ready: [(u) => { const pin = key && pins.get(key); if (pin) pinTo(u, pin.x, pin.top); }],
      setCursor: [(u) => { if (o.onCursor) o.onCursor(u.cursor.idx); if (o.tip !== false) tip(u, o); }],
      draw: [(u) => {
        const ctx = u.ctx;
        ctx.save();
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        for (const m of marks) {
          const px = u.valToPos(m.x, "x", true);
          if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;
          ctx.strokeStyle = m.color; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
          ctx.beginPath(); ctx.moveTo(px, u.bbox.top); ctx.lineTo(px, u.bbox.top + u.bbox.height); ctx.stroke();
          if (m.label) {
            ctx.setLineDash([]); ctx.fillStyle = m.color; ctx.font = FONT.replace("11px", `${11 * devicePixelRatio}px`);
            ctx.fillText(m.label, px + 4 * devicePixelRatio, u.bbox.top + 12 * devicePixelRatio);
          }
        }
        for (const bd of o.bands || []) {
          const x0 = u.valToPos(bd.x0, "x", true), x1 = u.valToPos(bd.x1, "x", true);
          ctx.fillStyle = bd.color;
          ctx.fillRect(Math.min(x0, x1), u.bbox.top, Math.abs(x1 - x0), u.bbox.height);
        }
        for (const h of o.hlines || []) {
          const py = u.valToPos(h.y, h.scale || "y", true);
          ctx.strokeStyle = h.color; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
          ctx.beginPath(); ctx.moveTo(u.bbox.left, py); ctx.lineTo(u.bbox.left + u.bbox.width, py); ctx.stroke();
          if (h.label) {
            ctx.setLineDash([]); ctx.fillStyle = h.color; ctx.font = FONT.replace("11px", `${11 * devicePixelRatio}px`);
            ctx.fillText(h.label, u.bbox.left + 6 * devicePixelRatio, py - 4 * devicePixelRatio);
          }
        }
        ctx.restore();
      }],
    },
  };
  const u = new uPlot(opts, [o.x, ...o.series.map((s) => s.values)], el);
  u._tipOpts = o;
  if (key) {
    if (!live.has(key)) live.set(key, new Set());
    live.get(key).add(u);
    u.over.addEventListener("click", () => {
      const group = [...live.get(key)];
      if (pins.has(key)) {
        pins.delete(key);
        for (const c of group) { c.cursor._lock = false; c.over.classList.remove("pinned"); }
      } else if (u.cursor.idx != null) {
        const pin = { x: u.data[0][u.cursor.idx], top: (u.cursor.top ?? 0) / u.over.clientHeight };
        pins.set(key, pin);
        for (const c of group) { pinTo(c, pin.x, pin.top); c.over.classList.add("pinned"); }
      }
      for (const c of group) if (c._tipOpts.tip !== false) tip(c, c._tipOpts);
    });
    // scales are only laid out once the chart is ready, so re-pin then
    const pin = pins.get(key);
    if (pin) { u.over.classList.add("pinned"); u.cursor._lock = true; }
  }
  return u;
}

function num(v) {
  const a = Math.abs(v);
  return a >= 100 ? Math.round(v).toLocaleString("en-US") : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** Floating readout next to the cursor: x, then each series' value there. */
function tip(u, o) {
  let el = u.over.querySelector(".tip");
  if (!el) { el = document.createElement("div"); el.className = "tip"; u.over.appendChild(el); }
  const { idx, left, top } = u.cursor;
  if (idx == null || left == null || left < 0) { el.hidden = true; return; }
  const rows = [];
  o.series.forEach((s, i) => {
    const v = u.data[i + 1][idx];
    if (v == null || s.tip === false) return;
    const unit = s.unit ?? o.scales[s.scale || "y"]?.label ?? "";
    const sub = s.sub ? s.sub(idx) : "";
    rows.push(`<div><i style="background:${s.color}"></i><span>${s.name || s.label}</span>` +
      `<b>${s.fmt ? s.fmt(v) : num(v)}</b> ${unit}${sub ? ` <em>${sub}</em>` : ""}</div>`);
  });
  if (!rows.length) { el.hidden = true; return; }
  const x = u.data[0][idx];
  const pinned = u.over.classList.contains("pinned") ? `<em class="pin">pinned · click to release</em>` : "";
  el.innerHTML = `<h5>${o.xTip ? o.xTip(x) : `${num(x)} ${o.xUnit || "rpm"}`}${pinned}</h5>${rows.join("")}`;
  el.hidden = false;
  const w = el.offsetWidth, h = el.offsetHeight, W = u.over.clientWidth, H = u.over.clientHeight;
  el.style.left = `${left + 16 + w > W ? left - 16 - w : left + 16}px`;
  el.style.top = `${Math.max(0, Math.min(H - h, (top ?? H / 2) - h / 2))}px`;
}

/** Put series sampled on different rpm grids onto one shared grid (gaps as null). */
export function align(grids) {
  const xs = [...new Set(grids.flatMap((g) => g.x))].sort((a, b) => a - b);
  const out = grids.map((g) => {
    const m = new Map(g.x.map((x, i) => [x, i]));
    return g.ys.map((ys) => xs.map((x) => (m.has(x) ? ys[m.get(x)] : null)));
  });
  return { x: xs, ys: out };
}
