// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Reading MoTeC i2 log files (.ld), such as the runs Beamlog records in
// BeamNG.drive. The format isn't published; the layout here is the one found
// by reverse engineering:
//
//   0     u32 0x40, 4 bytes, u32 first channel header, u32 first data
//   36    u32 event pointer
//   86    u32 channel count
//   94    date (16 bytes), 16, time (16), 16, driver (64), vehicle (64), 64, venue (64)
//   event: name (64), session (64), comment (1024), u16 venue pointer
//   each channel header: u32 prev, next, data pointer, sample count; u16 id,
//   type, size, rate (Hz); i16 shift, multiplier, scale, decimal places;
//   name (32), short name (8), unit (12)
//
// value = (stored / scale x 10^-dec + shift) x multiplier

const text = (bytes, at, len) => {
  let s = "";
  for (let i = at; i < at + len && bytes[i]; i++) s += String.fromCharCode(bytes[i]);
  return s.trim();
};

/** Parse an .ld file: { date, time, vehicle, venue, session, channels: Map(name -> {unit, rate, data}) }. */
export function parseLd(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const u32 = (o) => view.getUint32(o, true);
  if (buffer.byteLength < 1762 || u32(0) !== 0x40) throw new Error("not a MoTeC .ld file");
  const out = {
    date: text(bytes, 94, 16), time: text(bytes, 126, 16), driver: text(bytes, 158, 64),
    vehicle: text(bytes, 222, 64), venue: text(bytes, 350, 64), session: "", channels: new Map(),
  };
  const ev = u32(36);
  if (ev && ev + 128 <= buffer.byteLength) out.session = text(bytes, ev + 64, 64);

  let p = u32(8), guard = 0;
  while (p && guard++ < 10000) {
    if (p + 84 > buffer.byteLength) throw new Error("the file is cut short");
    const next = u32(p + 4), at = u32(p + 8), n = u32(p + 12);
    const kind = view.getUint16(p + 18, true), size = view.getUint16(p + 20, true), rate = view.getUint16(p + 22, true);
    const shift = view.getInt16(p + 24, true), mul = view.getInt16(p + 26, true) || 1;
    const scale = view.getInt16(p + 28, true) || 1, dec = view.getInt16(p + 30, true);
    const name = text(bytes, p + 32, 32), unit = text(bytes, p + 72, 12);
    const read = kind === 7
      ? (size === 4 ? (i) => view.getFloat32(at + i * 4, true) : null)
      : size === 4 ? (i) => view.getInt32(at + i * 4, true)
      : size === 2 ? (i) => view.getInt16(at + i * 2, true) : null;
    if (read && at + n * size <= buffer.byteLength) {
      const k = Math.pow(10, -dec) / scale;
      const data = new Float64Array(n);
      for (let i = 0; i < n; i++) data[i] = (read(i) * k + shift) * mul;
      out.channels.set(name, { unit, rate, data });
    }
    p = next;
  }
  return out;
}

/** Lap marks (s from the start) from the .ldx beside an .ld. */
export function parseLdx(xml) {
  return [...String(xml || "").matchAll(/Time="([0-9.]+)"/g)].map((m) => Number(m[1]) / 1e6);
}
