#!/usr/bin/env bash
# Build the Chrome Web Store zip from git branch `main` (student edition).
# manifest.json is at the zip root. Tests, README, and git metadata are excluded.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(git -C "$ROOT" show main:vu-deadlines/manifest.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
OUT_DIR="$ROOT/store"
OUT="$OUT_DIR/vu-deadlines-${VERSION}-chrome.zip"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/vu-deadlines-pack.XXXXXX")"

cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"
git -C "$ROOT" archive main:vu-deadlines | tar -x -C "$STAGE"

rm -rf "$STAGE/tests"
rm -f "$STAGE/README.md"

python3 - "$STAGE" <<'PY'
import json, pathlib, sys

DESCRIPTION = (
    "Track VULMS assignment, quiz, and GDB due dates locally. "
    "Unofficial. Not affiliated with VU."
)
FOOTER = "Unofficial. Your VULMS data stays in this browser."
FOOTER_OLD = "Your VULMS data stays in this browser."

stage = pathlib.Path(sys.argv[1])
manifest_path = stage / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if len(DESCRIPTION) > 132:
    raise SystemExit("manifest description exceeds 132 characters")
manifest["name"] = "VU Deadlines"
manifest["short_name"] = "VU Deadlines"
manifest["description"] = DESCRIPTION
if "action" in manifest and isinstance(manifest["action"], dict):
    manifest["action"]["default_title"] = "VU Deadlines"
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

popup = stage / "popup.html"
text = popup.read_text(encoding="utf-8")
if FOOTER in text:
    pass
elif FOOTER_OLD in text:
    text = text.replace(FOOTER_OLD, FOOTER, 1)
    popup.write_text(text, encoding="utf-8")
else:
    raise SystemExit("popup.html footer text not found")
PY

# Zip file names only; no enclosing folder.
rm -f "$OUT"
(
  cd "$STAGE"
  zip -X -r "$OUT" . -x "*.DS_Store" -x "**/.DS_Store"
)

python3 - "$OUT" <<'PY'
import json, zipfile, sys

path = sys.argv[1]
required = {
    "manifest.json",
    "sw.js",
    "parser.js",
    "storage.js",
    "notifications.js",
    "content.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
}
forbidden_prefixes = ("tests/",)
forbidden_names = {"README.md", "todoist.js", ".git"}

with zipfile.ZipFile(path) as zf:
    names = zf.namelist()
    if any(name.startswith("vu-deadlines/") for name in names):
        raise SystemExit("zip is nested; manifest.json must be at the zip root")
    missing = sorted(required - set(names))
    if missing:
        raise SystemExit("zip missing: " + ", ".join(missing))
    bad = [
        name for name in names
        if name in forbidden_names or name.startswith(forbidden_prefixes) or "todoist" in name.lower()
    ]
    if bad:
        raise SystemExit("zip contains excluded files: " + ", ".join(bad))
    manifest = json.loads(zf.read("manifest.json"))
    if manifest.get("manifest_version") != 3:
        raise SystemExit("manifest_version must be 3")
    if manifest.get("name") != "VU Deadlines":
        raise SystemExit("expected name VU Deadlines")
    if len(manifest.get("description", "")) > 132:
        raise SystemExit("description too long")
    if "todoist" in json.dumps(manifest).lower():
        raise SystemExit("student zip still mentions Todoist")
    if manifest.get("host_permissions") != ["https://vulms.vu.edu.pk/*"]:
        raise SystemExit("unexpected host_permissions")
    print("package ok")
    print("files:", len(names))
    print("description chars:", len(manifest["description"]))
PY

echo "Wrote $OUT"
ls -lh "$OUT"
