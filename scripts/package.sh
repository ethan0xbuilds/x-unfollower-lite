#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
OUT_DIR="$ROOT/dist"
ZIP_NAME="x-unfollower-lite-${VERSION}.zip"
OUT="$OUT_DIR/$ZIP_NAME"

mkdir -p "$OUT_DIR"
rm -f "$OUT"

# Zip extension payload only (no git, dist, docs-only clutter optional keep)
zip -r "$OUT" \
  manifest.json \
  background.js \
  LICENSE \
  PRIVACY.md \
  README.md \
  _locales \
  content \
  icons \
  lib \
  popup \
  -x "*.DS_Store" -x "**/.DS_Store"

echo "Packed: $OUT"
unzip -l "$OUT" | tail -n 5
