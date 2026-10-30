// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Crankcase's window. The engine model and the interface are plain web code
// in ../ui; this side only finds BeamNG.drive on disk, reads the vehicle files
// (game and mods) that car detection and exports build on, writes exported
// parts into the user folder, and reads and writes .crank design files picked
// in the file dialogs. Release builds also update themselves from the
// project's GitHub releases.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

mod vehicles;
use vehicles::Index;

/// Exports may only land inside this mod's own folder.
const EXPORT_ROOT: &str = "mods/unpacked/crankcase/";

/// BeamNG.drive's user folder: CRANKCASE_BEAMNG_USER if set, otherwise the
/// game's default location for this platform.
fn find_user_folder() -> Option<PathBuf> {
    if let Ok(p) = env::var("CRANKCASE_BEAMNG_USER") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return Some(p);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(local) = env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        candidates.push(local.join("BeamNG").join("BeamNG.drive").join("current"));
        candidates.push(local.join("BeamNG.drive").join("current"));
    }
    if let Ok(home) = env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".local/share/BeamNG/BeamNG.drive/current"));
    }
    candidates.into_iter().find(|p| p.is_dir())
}

#[tauri::command]
fn beamng_user_folder() -> Option<String> {
    find_user_folder().map(|p| p.display().to_string())
}

/// Steam library folders: the Steam install itself plus every library listed
/// in its libraryfolders.vdf.
fn steam_libraries() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Ok(p) = env::var(var) {
            roots.push(PathBuf::from(p).join("Steam"));
        }
    }
    if let Ok(home) = env::var("HOME") {
        roots.push(PathBuf::from(&home).join(".steam/steam"));
        roots.push(PathBuf::from(&home).join(".local/share/Steam"));
    }
    let mut libs = Vec::new();
    for root in roots {
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        if let Ok(text) = fs::read_to_string(&vdf) {
            for line in text.lines() {
                let parts: Vec<&str> = line.split('"').collect();
                // a line like:   "path"   "X:\\Games\\SteamLibrary"
                if parts.len() >= 4 && parts[1] == "path" {
                    libs.push(PathBuf::from(parts[3].replace("\\\\", "\\")));
                }
            }
        }
        libs.push(root);
    }
    libs
}

/// BeamNG.drive's install folder: CRANKCASE_BEAMNG_GAME if set, otherwise
/// searched for in the Steam libraries.
fn find_game_folder() -> Option<PathBuf> {
    let is_game = |p: &Path| p.join("content").join("vehicles").is_dir();
    if let Ok(p) = env::var("CRANKCASE_BEAMNG_GAME") {
        let p = PathBuf::from(p);
        if is_game(&p) {
            return Some(p);
        }
    }
    steam_libraries()
        .into_iter()
        .map(|lib| lib.join("steamapps").join("common").join("BeamNG.drive"))
        .find(|p| is_game(p))
}

#[tauri::command]
fn beamng_game_folder() -> Option<String> {
    find_game_folder().map(|p| p.display().to_string())
}

/// A .jbeam part or .pc config under vehicles/, checked before use.
fn valid_vehicle_entry(entry: &str) -> Result<(), String> {
    // engine parts to borrow from, and stock vehicle configs to start a config from
    let ok = entry.starts_with("vehicles/")
        && (entry.ends_with(".jbeam") || entry.ends_with(".pc"))
        && !entry.contains("..");
    if ok {
        Ok(())
    } else {
        Err(format!("not a vehicle file: {entry}"))
    }
}

/// The vehicle index, built on first use and rebuilt when the car list is refreshed.
static INDEX: Mutex<Option<Arc<Index>>> = Mutex::new(None);

fn index(rebuild: bool) -> Arc<Index> {
    let mut slot = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    if rebuild || slot.is_none() {
        let game = find_game_folder();
        let user = find_user_folder();
        *slot = Some(Arc::new(Index::build(game.as_deref(), user.as_deref())));
    }
    slot.clone().unwrap_or_default()
}

#[derive(serde::Serialize)]
struct VehicleEntry {
    id: String,
    /// the vehicle's info.json, for its name, brand and type
    info: String,
}

/// Every vehicle in the game and in active mods, with its info.json. Rescans the folders.
#[tauri::command]
fn list_vehicles() -> Vec<VehicleEntry> {
    let ix = index(true);
    ix.vehicles()
        .into_iter()
        .map(|id| {
            let info = ix
                .read(&format!("vehicles/{id}/info.json"))
                .unwrap_or_default();
            VehicleEntry { id, info }
        })
        .collect()
}

fn valid_vehicle_dir(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && !id.contains("..")
    {
        Ok(())
    } else {
        Err(format!("not a vehicle folder: {id}"))
    }
}

/// Every part, config and info file of one vehicle folder (or "common"), as path -> text.
#[tauri::command]
fn vehicle_bundle(id: String) -> Result<std::collections::BTreeMap<String, String>, String> {
    valid_vehicle_dir(&id)?;
    Ok(index(false).bundle(&id))
}

/// The game's English vehicle names, for vehicles that name themselves with translation keys.
#[tauri::command]
fn vehicle_names() -> std::collections::BTreeMap<String, String> {
    find_game_folder()
        .map(|g| vehicles::vehicle_names(&g))
        .unwrap_or_default()
}

/// One .jbeam or .pc file from wherever the game would load it (mods over the game).
#[tauri::command]
fn read_vehicle_file(entry: String) -> Result<String, String> {
    valid_vehicle_entry(&entry)?;
    index(false).read(&entry)
}

/// A relative path made only of normal components, inside the export root.
fn safe_relative(rel: &str) -> Result<PathBuf, String> {
    // the engine part, its model, and a vehicle config with its info file
    let allowed = [".jbeam", ".dae", ".pc", ".json"];
    if !rel.starts_with(EXPORT_ROOT) || !allowed.iter().any(|ext| rel.ends_with(ext)) {
        return Err(format!("refusing to write outside {EXPORT_ROOT}"));
    }
    let path = Path::new(rel);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("refusing a path with '..' or a root".into());
    }
    Ok(path.to_path_buf())
}

#[tauri::command]
fn export_jbeam(relative_path: String, contents: String) -> Result<String, String> {
    let root = find_user_folder()
        .ok_or("BeamNG's user folder wasn't found. Set CRANKCASE_BEAMNG_USER to it.")?;
    let target = root.join(safe_relative(&relative_path)?);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    fs::write(&target, contents).map_err(|e| format!("writing {}: {e}", target.display()))?;
    Ok(target.display().to_string())
}

/// .crank files are small JSON; anything else (or anything huge) is refused.
const CRANK_MAX_BYTES: u64 = 1_000_000;

fn crank_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    match p.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("crank") => Ok(p),
        _ => Err("only .crank files can be opened or saved here".into()),
    }
}

#[tauri::command]
fn read_crank(path: String) -> Result<String, String> {
    let p = crank_path(&path)?;
    let size = fs::metadata(&p)
        .map_err(|e| format!("{}: {e}", p.display()))?
        .len();
    if size > CRANK_MAX_BYTES {
        return Err("that file is too large to be a .crank design".into());
    }
    fs::read_to_string(&p).map_err(|e| format!("reading {}: {e}", p.display()))
}

#[tauri::command]
fn write_crank(path: String, contents: String) -> Result<String, String> {
    let p = crank_path(&path)?;
    fs::write(&p, contents).map_err(|e| format!("writing {}: {e}", p.display()))?;
    Ok(p.display().to_string())
}

/// Recorded runs (MoTeC .ld, e.g. from Beamlog) are read whole; anything else is refused.
const RUN_MAX_BYTES: u64 = 512_000_000;

fn run_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    match p.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("ld") => Ok(p),
        _ => Err("only MoTeC .ld files can be opened as runs".into()),
    }
}

#[tauri::command]
fn read_run(path: String) -> Result<tauri::ipc::Response, String> {
    let p = run_path(&path)?;
    let size = fs::metadata(&p)
        .map_err(|e| format!("{}: {e}", p.display()))?
        .len();
    if size > RUN_MAX_BYTES {
        return Err("that log is too large to open here".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("reading {}: {e}", p.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The lap marks beside a run (its .ldx), or nothing if there isn't one.
#[tauri::command]
fn read_run_laps(path: String) -> Result<String, String> {
    let p = run_path(&path)?.with_extension("ldx");
    Ok(fs::read_to_string(p).unwrap_or_default())
}

/// What the page shows when an update is available.
#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

/// Whether this build was made with an updater configuration (release builds).
fn updater_configured(app: &AppHandle) -> bool {
    app.config().plugins.0.contains_key("updater")
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !updater_configured(&app) {
        return Ok(None);
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download the update (checked against the signing key), install it and restart.
/// On Windows the installer closes the app itself.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    if !updater_configured(&app) {
        return Err("This build doesn't update itself.".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No update is available any more.")?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // the updater needs its settings (signing key, where to look),
            // which only release builds carry
            if updater_configured(app.handle()) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            beamng_user_folder,
            beamng_game_folder,
            list_vehicles,
            vehicle_bundle,
            vehicle_names,
            read_vehicle_file,
            export_jbeam,
            read_crank,
            write_crank,
            read_run,
            read_run_laps,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Crankcase");
}

#[cfg(test)]
mod tests {
    use super::{crank_path, run_path, safe_relative, valid_vehicle_dir, valid_vehicle_entry};

    #[test]
    fn only_plain_vehicle_folders_are_bundled() {
        assert!(valid_vehicle_dir("bx").is_ok());
        assert!(valid_vehicle_dir("common").is_ok());
        assert!(valid_vehicle_dir("../settings").is_err());
        assert!(valid_vehicle_dir("a/b").is_err());
        assert!(valid_vehicle_dir("").is_err());
    }

    #[test]
    fn only_crank_files_are_opened_or_saved() {
        assert!(crank_path("designs/v8.crank").is_ok());
        assert!(crank_path("designs/V8.CRANK").is_ok());
        assert!(crank_path("designs/v8.json").is_err());
        assert!(crank_path("designs/v8").is_err());
    }

    #[test]
    fn only_vehicle_jbeam_files_are_read() {
        assert!(valid_vehicle_entry("vehicles/bx/bx_engine_i4_large.jbeam").is_ok());
        assert!(valid_vehicle_entry("vehicles/common/etk/etk_engine_i6.jbeam").is_ok());
        assert!(valid_vehicle_entry("vehicles/../settings/a.jbeam").is_err());
        assert!(valid_vehicle_entry("vehicles/bx/a.dae").is_err());
        assert!(valid_vehicle_entry("settings/a.jbeam").is_err());
        assert!(valid_vehicle_entry("vehicles/bx/200bx_type_l_M.pc").is_ok());
    }

    #[test]
    fn only_the_mod_folder_is_writable() {
        assert!(safe_relative("mods/unpacked/crankcase/vehicles/bx/crankcase_a.jbeam").is_ok());
        assert!(safe_relative("mods/unpacked/crankcase/../../settings/x.jbeam").is_err());
        assert!(safe_relative("mods/unpacked/other/vehicles/bx/a.jbeam").is_err());
        assert!(safe_relative("mods/unpacked/crankcase/vehicles/bx/a.dae").is_ok());
        assert!(safe_relative("mods/unpacked/crankcase/vehicles/bx/a.txt").is_err());
        assert!(run_path("C:/logs/run.ld").is_ok());
        assert!(run_path("C:/logs/run.LD").is_ok());
        assert!(run_path("C:/logs/run.csv").is_err());
        assert!(safe_relative("mods/unpacked/crankcase/vehicles/bx/crankcase_a.pc").is_ok());
        assert!(safe_relative("mods/unpacked/crankcase/vehicles/bx/info_crankcase_a.json").is_ok());
    }
}
