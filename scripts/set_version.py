# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Crankcase contributors
"""Set Crankcase's version everywhere it's written down, or check they agree.

    python scripts/set_version.py 0.2.0           # before tagging a release
    python scripts/set_version.py --check         # prints the version; fails if the files disagree
    python scripts/set_version.py --check v0.2.0  # ...or if it isn't this tag
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAURI = ROOT / "src-tauri" / "tauri.conf.json"
CARGO = ROOT / "src-tauri" / "Cargo.toml"
PACKAGE = ROOT / "package.json"
CARGO_RE = re.compile(r'(?m)^(version\s*=\s*")([^"]+)(")')


def current() -> dict:
    return {
        "tauri.conf.json": json.loads(TAURI.read_text(encoding="utf-8"))["version"],
        "Cargo.toml": CARGO_RE.search(CARGO.read_text(encoding="utf-8")).group(2),
        "package.json": json.loads(PACKAGE.read_text(encoding="utf-8"))["version"],
    }


def write_json(path: Path, key: str, value: str):
    data = json.loads(path.read_text(encoding="utf-8"))
    data[key] = value
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def set_version(v: str):
    if not re.fullmatch(r"\d+\.\d+\.\d+", v):
        sys.exit(f"not a version: {v} (expected e.g. 0.2.0)")
    write_json(TAURI, "version", v)
    write_json(PACKAGE, "version", v)
    CARGO.write_text(CARGO_RE.sub(lambda m: m.group(1) + v + m.group(3), CARGO.read_text(encoding="utf-8"), count=1),
                     encoding="utf-8")
    print(f"version set to {v}")


def check(tag):
    found = current()
    versions = set(found.values())
    if len(versions) != 1:
        sys.exit("versions disagree: " + ", ".join(f"{k} {v}" for k, v in found.items()))
    v = versions.pop()
    if tag is not None and tag.lstrip("v") != v:
        sys.exit(f"tag {tag} doesn't match the version in the files ({v})")
    print(v)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--check"]:
        check(args[1] if len(args) > 1 else None)
    elif len(args) == 1:
        set_version(args[0])
    else:
        sys.exit(__doc__)
