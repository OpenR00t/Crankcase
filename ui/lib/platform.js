// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
// Desktop (Tauri) or plain browser. In the app, exports go straight into
// BeamNG's user folder; in a browser the file is downloaded instead.

const tauri = window.__TAURI__?.core;

export const isDesktop = !!tauri;

/** BeamNG's user folder, or null if it couldn't be found (browser: always null). */
export async function beamngFolder() {
  if (!tauri) return null;
  try { return await tauri.invoke("beamng_user_folder"); } catch { return null; }
}

/** Where the game is installed, or null if it couldn't be found (browser: always null). */
export async function gameFolder() {
  if (!tauri) return null;
  try { return await tauri.invoke("beamng_game_folder"); } catch { return null; }
}

/** Read one .jbeam file from a vehicle's zip in the game (desktop only). */
export async function readGameFile(zip, entry) {
  if (!tauri) throw new Error("reading the game's files needs the desktop app");
  return tauri.invoke("read_game_file", { zip, entry });
}

/** Write the file. Returns { path } in the app, { downloaded: name } in a browser. */
export async function exportFile(relativePath, text) {
  if (tauri) {
    const path = await tauri.invoke("export_jbeam", { relativePath, contents: text });
    return { path };
  }
  const name = relativePath.split("/").pop();
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { downloaded: name };
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`crankcase.${key}`); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`crankcase.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};

const RUN_FILTER = [{ name: "MoTeC log", extensions: ["ld"] }];

/**
 * Pick a recorded run (MoTeC .ld). Returns { name, ld: ArrayBuffer, ldx: string }
 * or null if cancelled. The desktop dialog starts in BeamNG's beamlog folder.
 */
export async function openRun() {
  if (tauri) {
    const user = await beamngFolder();
    const options = { multiple: false, directory: false, filters: RUN_FILTER, ...(user ? { defaultPath: `${user}/beamlog` } : {}) };
    let path = await tauri.invoke("plugin:dialog|open", { options });
    if (!path) return null;
    path = typeof path === "string" ? path : path.path;
    const ld = await tauri.invoke("read_run", { path });
    const ldx = await tauri.invoke("read_run_laps", { path }).catch(() => "");
    return { name: path.split(/[\\/]/).pop(), ld: ld instanceof ArrayBuffer ? ld : new Uint8Array(ld).buffer, ldx };
  }
  return new Promise((done) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".ld,.ldx", multiple: true });
    input.onchange = async () => {
      const files = [...input.files];
      const ld = files.find((f) => f.name.toLowerCase().endsWith(".ld"));
      if (!ld) return done(null);
      const ldx = files.find((f) => f.name.toLowerCase().endsWith(".ldx"));
      done({ name: ld.name, ld: await ld.arrayBuffer(), ldx: ldx ? await ldx.text() : "" });
    };
    input.click();
  });
}

const CRANK_FILTER = [{ name: "Crankcase engine", extensions: ["crank"] }];

/** Save a .crank file. Returns where it went, or null if cancelled. */
export async function saveCrank(name, text) {
  if (tauri) {
    const path = await tauri.invoke("plugin:dialog|save", { options: { defaultPath: name, filters: CRANK_FILTER } });
    if (!path) return null;
    return tauri.invoke("write_crank", { path, contents: text });
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** Pick and read a .crank file. Returns its text, or null if cancelled. */
export async function openCrank() {
  if (tauri) {
    const path = await tauri.invoke("plugin:dialog|open", { options: { multiple: false, directory: false, filters: CRANK_FILTER } });
    if (!path) return null;
    return tauri.invoke("read_crank", { path: typeof path === "string" ? path : path.path });
  }
  return new Promise((done) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".crank" });
    input.onchange = () => (input.files[0] ? input.files[0].text().then(done) : done(null));
    input.click();
  });
}
