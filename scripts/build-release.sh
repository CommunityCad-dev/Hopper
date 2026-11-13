#!/usr/bin/env bash
# Build the release archive that Moonraker's update manager installs.
#
# Moonraker's `type: zip` (NetDeploy) downloads a GitHub release asset and unpacks it
# over the configured path, so the archive holds exactly what a printer needs to run
# the plugin -- and nothing it does not. No sources, no tests, no planning docs.
#
#   scripts/build-release.sh [version]
#
# Version defaults to the current git tag, or 0.0.0-dev outside a tagged checkout.
# Runs the same bundle-budget gate as a normal build: an oversized bundle must not be
# able to reach a printer just because it went out through a release.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="${1:-$(git describe --tags --exact-match 2>/dev/null || echo "0.0.0-dev")}"
OWNER="${RELEASE_OWNER:-CommunityCad-dev}"
PROJECT="${RELEASE_PROJECT:-Hopper}"
ASSET="${ASSET_NAME:-hopper.zip}"
OUT="${OUT_DIR:-dist}"

echo "building $PROJECT $VERSION for $OWNER"

( cd web && npm ci --silent && npm run build )

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# Files at the root of the zip, no wrapper folder: Moonraker extracts the asset
# straight into the configured path, so a wrapper would nest every update one level
# deeper. Mainsail and Fluidd ship the same way. Install: unzip hopper.zip -d hopper
ROOT="$STAGE/root"
mkdir -p "$ROOT"

# Everything a printer needs, and only that.
cp -a component nginx scripts LICENSE NOTICE README.md "$ROOT/"
mkdir -p "$ROOT/web"
cp -a web/dist "$ROOT/web/dist"
# The sourcemap is for developers and is three times the bundle's size.
rm -f "$ROOT/web/dist/"*.map
# The release builds nothing on the printer, so neither its build script nor the
# bundle-budget gate that only runs at build time belong in it.
rm -f "$ROOT/scripts/build-release.sh" "$ROOT/scripts/check-bundle.mjs"
# The one-command installer is its own release asset (below), not part of the zip.
rm -f "$ROOT/scripts/web-install.sh"
# Compiled Python is per-interpreter and would be stale the moment it shipped.
find "$ROOT" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$ROOT" -name '*.pyc' -delete 2>/dev/null || true

# What NetDeploy reads to decide whether an update is available. project_name and
# project_owner must match the `repo:` in moonraker.conf, or Moonraker overrides the
# configured value with these and says so.
cat >"$ROOT/release_info.json" <<JSON
{
  "project_name": "$PROJECT",
  "project_owner": "$OWNER",
  "version": "$VERSION",
  "asset_name": "$ASSET"
}
JSON

mkdir -p "$OUT"
rm -f "$OUT/$ASSET"
( cd "$ROOT" && zip -qr "$STAGE/$ASSET" . )
mv "$STAGE/$ASSET" "$OUT/$ASSET"

echo "wrote $OUT/$ASSET ($(du -h "$OUT/$ASSET" | cut -f1))"

# The one-command installer, attached to the release as install.sh. It downloads this
# version's zip, so the script and the zip it unpacks always match.
sed "s/__HOPPER_VERSION__/${VERSION#v}/g" scripts/web-install.sh >"$OUT/install.sh"
grep -q "local version=\"${VERSION#v}\"" "$OUT/install.sh" || { echo "install.sh: version not stamped"; exit 1; }
echo "wrote $OUT/install.sh (version ${VERSION#v})"
echo "contents:"
unzip -l "$OUT/$ASSET" | awk 'NR>3 && NF>3 {print "  " $4}' | head -20
