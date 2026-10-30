// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
// Asks the app whether a newer release is out and, if so, offers to install it.
// Only installed copies built for release can update; elsewhere this does nothing.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function checkForUpdate() {
  const tauri = window.__TAURI__?.core;
  if (!tauri) return;
  let update = null;
  try {
    update = await tauri.invoke("check_update");
  } catch {
    return; // offline, or the release page can't be reached: try next launch
  }
  if (!update) return;
  const box = document.createElement("div");
  box.className = "update-toast";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Update available");
  box.innerHTML =
    `<div><b>Crankcase ${esc(update.version)}</b> is available <span class="muted">(you have ${esc(update.current)})</span>.</div>` +
    (update.notes ? `<div class="notes">${esc(update.notes).slice(0, 400)}</div>` : "") +
    `<div class="row"><button class="btn primary small" data-install>Install and restart</button>` +
    `<button class="btn small" data-later>Later</button></div><div class="status"></div>`;
  document.body.append(box);
  box.querySelector("[data-later]").onclick = () => box.remove();
  box.querySelector("[data-install]").onclick = async () => {
    const status = box.querySelector(".status");
    box.querySelectorAll("button").forEach((b) => (b.disabled = true));
    status.textContent = "Downloading the update… Crankcase restarts when it's installed. Your design is kept.";
    try {
      await tauri.invoke("install_update");
    } catch (e) {
      status.textContent = `The update didn't install: ${e}. Try again later, or download it from the releases page.`;
      box.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  };
}
