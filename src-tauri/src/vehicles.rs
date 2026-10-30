// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Crankcase contributors
//
// Every vehicle file the game would load, wherever it lives: the game's own
// vehicle zips, mod zips, unpacked mods and the user's loose vehicles folder.
// Later sources override earlier ones, the same way the game layers mods over
// its own content. Only the text files Crankcase reads are indexed: .jbeam
// parts, .pc configs and .json info files under vehicles/.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Crankcase's own exports are left out, so they never become donors.
const OWN_MOD: &str = "crankcase";

#[derive(Clone, Debug)]
enum Loc {
    Zip(PathBuf, String),
    File(PathBuf),
}

#[derive(Default)]
pub struct Index {
    /// lower-case path -> (path as written, where it is)
    entries: HashMap<String, (String, Loc)>,
}

fn wanted(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.starts_with("vehicles/")
        && (p.ends_with(".jbeam") || p.ends_with(".pc") || p.ends_with(".json"))
}

fn zips_in(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// Mods switched off in the game's mod manager (mods/db.json), as /mods/... paths in lower case.
fn inactive_mods(user: &Path) -> HashSet<String> {
    let mut off = HashSet::new();
    let Ok(text) = fs::read_to_string(user.join("mods").join("db.json")) else {
        return off;
    };
    let Ok(db) = serde_json::from_str::<serde_json::Value>(&text) else {
        return off;
    };
    if let Some(mods) = db.get("mods").and_then(|m| m.as_object()) {
        for m in mods.values() {
            if m.get("active").and_then(|a| a.as_bool()) == Some(false) {
                if let Some(p) = m.get("fullpath").and_then(|p| p.as_str()) {
                    off.insert(p.replace('\\', "/").to_ascii_lowercase());
                }
            }
        }
    }
    off
}

impl Index {
    pub fn build(game: Option<&Path>, user: Option<&Path>) -> Index {
        let mut ix = Index::default();
        if let Some(game) = game {
            for z in zips_in(&game.join("content").join("vehicles")) {
                ix.add_zip(&z);
            }
        }
        if let Some(user) = user {
            let off = inactive_mods(user);
            let mods = user.join("mods");
            for (dir, prefix) in [(mods.clone(), "/mods/"), (mods.join("repo"), "/mods/repo/")] {
                for z in zips_in(&dir) {
                    let name = z
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if !off.contains(&format!("{prefix}{name}")) {
                        ix.add_zip(&z);
                    }
                }
            }
            if let Ok(it) = fs::read_dir(mods.join("unpacked")) {
                let mut dirs: Vec<PathBuf> = it
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect();
                dirs.sort();
                for d in dirs {
                    let name = d
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if name == OWN_MOD || off.contains(&format!("/mods/unpacked/{name}")) {
                        continue;
                    }
                    ix.add_tree(&d);
                }
            }
            // loose files in the user folder's own vehicles/ (how the game's editors save)
            ix.add_tree(user);
        }
        ix
    }

    fn add_zip(&mut self, zip: &Path) {
        let Ok(file) = fs::File::open(zip) else {
            return;
        };
        let Ok(archive) = zip::ZipArchive::new(file) else {
            return;
        };
        for name in archive.file_names() {
            let norm = name.replace('\\', "/");
            if wanted(&norm) {
                self.entries.insert(
                    norm.to_ascii_lowercase(),
                    (norm, Loc::Zip(zip.to_path_buf(), name.to_string())),
                );
            }
        }
    }

    /// Files under <root>/vehicles/.
    fn add_tree(&mut self, root: &Path) {
        let mut stack = vec![root.join("vehicles")];
        while let Some(dir) = stack.pop() {
            let Ok(it) = fs::read_dir(&dir) else { continue };
            for e in it.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(rel) = p.strip_prefix(root) {
                    let norm = rel.to_string_lossy().replace('\\', "/");
                    if wanted(&norm) {
                        self.entries
                            .insert(norm.to_ascii_lowercase(), (norm, Loc::File(p.clone())));
                    }
                }
            }
        }
    }

    /// Folders under vehicles/ with an info.json: the vehicles the game lists.
    pub fn vehicles(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .entries
            .values()
            .filter_map(|(path, _)| {
                let parts: Vec<&str> = path.split('/').collect();
                (parts.len() == 3
                    && parts[2].eq_ignore_ascii_case("info.json")
                    && !parts[1].eq_ignore_ascii_case("common"))
                .then(|| parts[1].to_string())
            })
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    pub fn read(&self, path: &str) -> Result<String, String> {
        let (_, loc) = self
            .entries
            .get(&path.replace('\\', "/").to_ascii_lowercase())
            .ok_or(format!("{path} isn't in the game or any mod"))?;
        read_loc(loc)
    }

    /// Every indexed file under vehicles/<dir>/, read in one pass per archive.
    pub fn bundle(&self, dir: &str) -> BTreeMap<String, String> {
        let prefix = format!("vehicles/{}/", dir.to_ascii_lowercase());
        let mut by_zip: HashMap<PathBuf, Vec<(String, String)>> = HashMap::new();
        let mut out = BTreeMap::new();
        for (key, (path, loc)) in &self.entries {
            if !key.starts_with(&prefix) {
                continue;
            }
            match loc {
                Loc::Zip(z, name) => by_zip
                    .entry(z.clone())
                    .or_default()
                    .push((path.clone(), name.clone())),
                Loc::File(_) => {
                    if let Ok(t) = read_loc(loc) {
                        out.insert(path.clone(), t);
                    }
                }
            }
        }
        for (z, items) in by_zip {
            let Ok(file) = fs::File::open(&z) else {
                continue;
            };
            let Ok(mut archive) = zip::ZipArchive::new(file) else {
                continue;
            };
            for (path, name) in items {
                if let Ok(mut item) = archive.by_name(&name) {
                    let mut bytes = Vec::new();
                    if item.read_to_end(&mut bytes).is_ok() {
                        out.insert(path, String::from_utf8_lossy(&bytes).into_owned());
                    }
                }
            }
        }
        out
    }
}

fn read_loc(loc: &Loc) -> Result<String, String> {
    let bytes = match loc {
        Loc::File(p) => fs::read(p).map_err(|e| format!("reading {}: {e}", p.display()))?,
        Loc::Zip(z, name) => {
            let file = fs::File::open(z).map_err(|e| format!("opening {}: {e}", z.display()))?;
            let mut archive =
                zip::ZipArchive::new(file).map_err(|e| format!("reading {}: {e}", z.display()))?;
            let mut item = archive
                .by_name(name)
                .map_err(|e| format!("{name} in {}: {e}", z.display()))?;
            let mut bytes = Vec::new();
            item.read_to_end(&mut bytes)
                .map_err(|e| format!("reading {name}: {e}"))?;
            bytes
        }
    };
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The game's English names for its vehicles (vehiclesData.<id>.Name -> "BX-Series").
pub fn vehicle_names(game: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let dir = game.join("locales").join("translations").join("en-US");
    let Ok(it) = fs::read_dir(dir) else {
        return out;
    };
    for e in it.flatten() {
        let Ok(text) = fs::read_to_string(e.path()) else {
            continue;
        };
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&text)
        else {
            continue;
        };
        for (k, v) in map {
            if k.starts_with("vehiclesData.") && k.ends_with(".Name") && k.matches('.').count() == 2
            {
                if let Some(s) = v.as_str() {
                    out.insert(k, s.to_string());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(path: &Path, files: &[(&str, &str)]) {
        let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, text) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(text.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn mods_override_the_game_and_own_exports_are_skipped() {
        let root = std::env::temp_dir().join(format!("crankcase-vehicles-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let game = root.join("game");
        let user = root.join("user");
        fs::create_dir_all(game.join("content/vehicles")).unwrap();
        fs::create_dir_all(user.join("mods/unpacked/crankcase/vehicles/bx")).unwrap();
        fs::create_dir_all(user.join("mods/unpacked/tuner/vehicles/bx")).unwrap();
        zip_with(
            &game.join("content/vehicles/bx.zip"),
            &[
                ("vehicles/bx/info.json", "{}"),
                ("vehicles/bx/bx_engine.jbeam", "game"),
                ("vehicles/bx/bx.dae", "mesh"),
            ],
        );
        zip_with(
            &game.join("content/vehicles/common.zip"),
            &[
                ("vehicles/common/info.json", "{}"),
                ("vehicles/common/a.jbeam", "c"),
            ],
        );
        zip_with(
            &user.join("mods/kit.zip"),
            &[
                ("vehicles/newcar/info.json", "{}"),
                ("vehicles/newcar/newcar.jbeam", "n"),
            ],
        );
        fs::create_dir_all(user.join("mods")).unwrap();
        zip_with(
            &user.join("mods/off.zip"),
            &[("vehicles/offcar/info.json", "{}")],
        );
        fs::write(
            user.join("mods/db.json"),
            r#"{"mods":{"off":{"active":false,"fullpath":"/mods/off.zip"}}}"#,
        )
        .unwrap();
        fs::write(
            user.join("mods/unpacked/tuner/vehicles/bx/bx_engine.jbeam"),
            "tuned",
        )
        .unwrap();
        fs::write(
            user.join("mods/unpacked/crankcase/vehicles/bx/crankcase_x.jbeam"),
            "ours",
        )
        .unwrap();

        let ix = Index::build(Some(&game), Some(&user));
        assert_eq!(ix.vehicles(), vec!["bx".to_string(), "newcar".to_string()]);
        assert_eq!(ix.read("vehicles/bx/bx_engine.jbeam").unwrap(), "tuned");
        assert_eq!(ix.read("vehicles/common/a.jbeam").unwrap(), "c");
        let b = ix.bundle("bx");
        assert_eq!(
            b.keys().cloned().collect::<Vec<_>>(),
            vec!["vehicles/bx/bx_engine.jbeam", "vehicles/bx/info.json"]
        );
        assert!(ix.read("vehicles/bx/crankcase_x.jbeam").is_err());
        assert!(ix.read("vehicles/bx/bx.dae").is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
