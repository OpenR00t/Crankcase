# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Crankcase contributors
"""Write the build settings that only release builds use, on top of
src-tauri/tauri.conf.json:

- the installers to make for this platform,
- the updater: the public half of the signing key, and where to look for
  new versions (this repository's latest GitHub release).

    python scripts/release_config.py --repo OWNER/NAME --pubkey KEY

The release workflow runs this with the repository it's running in and the
TAURI_UPDATER_PUBKEY variable, so neither is written into the code.
Writes src-tauri/tauri.release.conf.json (not committed).
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "tauri.release.conf.json"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True, help="OWNER/NAME of the GitHub repository")
    p.add_argument("--pubkey", required=True, help="updater public key (contents of the .pub file)")
    a = p.parse_args()
    targets = ["nsis"] if sys.platform == "win32" else ["appimage", "deb"]
    conf = {
        "bundle": {
            "targets": targets,
            "createUpdaterArtifacts": True,
            "windows": {"nsis": {"installMode": "currentUser"}},
        },
        "plugins": {
            "updater": {
                "pubkey": a.pubkey.strip(),
                "endpoints": [f"https://github.com/{a.repo}/releases/latest/download/latest.json"],
                "windows": {"installMode": "passive"},
            }
        },
    }
    OUT.write_text(json.dumps(conf, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({', '.join(targets)})")


if __name__ == "__main__":
    main()
