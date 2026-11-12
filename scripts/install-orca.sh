#!/usr/bin/env bash
# Install OrcaSlicer for slicing on the printer. Pinned and checksum-verified,
# unpacked under $CCAD_HOME/orca, called headless by the Moonraker component.
#
# Orca runs as a separate program; the plugin only calls its command line.
# Its AppImage doesn't bundle the WebKitGTK stack it
# links, so those come from apt -- the only step that needs sudo.
#
#   scripts/install-orca.sh            install or repair; re-running changes nothing
#   scripts/install-orca.sh --remove   remove $CCAD_HOME/orca (apt packages stay)
#
# Measured on a Pi 4: about 500 MB installed, and up to 922 MB of memory to slice a big model.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

ORCA_VERSION="2.4.2"
ORCA_ASSET="OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V${ORCA_VERSION}.AppImage"
ORCA_URL="https://github.com/SoftFever/OrcaSlicer/releases/download/v${ORCA_VERSION}/${ORCA_ASSET}"
# From the release's published digest. Pinned here so a swapped download fails.
ORCA_SHA256="e1a07275a25f176626c55a5df39e91bc4476d8c28ee4a3192ff758e29dd5c3ba"
ORCA_HOME="$CCAD_HOME/orca"
ORCA_DIR="$ORCA_HOME/$ORCA_VERSION"
# ORCA_APT_PACKAGES: in common.sh, so install-all.sh's check uses the same list.

if [[ "${1:-}" == "--remove" ]]; then
    rm -rf "$ORCA_HOME"
    log "removed $ORCA_HOME. The apt packages stay: ${ORCA_APT_PACKAGES[*]}"
    exit 0
fi

# --- preflight -------------------------------------------------------------------------
arch="$(uname -m)"
[[ "$arch" == "aarch64" ]] || die "slicing on the printer needs 64-bit Pi OS (aarch64); this is $arch. OrcaSlicer has no 32-bit build. Nothing was changed."
command -v curl >/dev/null || die "curl not found. Nothing was changed."
command -v sha256sum >/dev/null || die "sha256sum not found. Nothing was changed."

# --- libraries ---------------------------------------------------------------------------
missing=()
for pkg in "${ORCA_APT_PACKAGES[@]}"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" || missing+=("$pkg")
done
if [[ ${#missing[@]} -gt 0 ]]; then
    log "installing libraries OrcaSlicer needs: ${missing[*]}"
    $SUDO apt-get install -y --no-install-recommends "${missing[@]}" \
        || die "apt-get install failed. Install them yourself: sudo apt-get install ${missing[*]}"
else
    log "libraries already installed"
fi

# --- OrcaSlicer --------------------------------------------------------------------------
mkdir -p "$ORCA_HOME"
if [[ -f "$ORCA_DIR/.verified" && -x "$ORCA_DIR/run-orca" ]]; then
    log "OrcaSlicer $ORCA_VERSION already installed at $ORCA_DIR"
else
    work="$(mktemp -d "$ORCA_HOME/.install.XXXXXX")"
    trap 'rm -rf "$work"' EXIT
    log "downloading OrcaSlicer $ORCA_VERSION (about 135 MB)"
    curl -fsSL --retry 3 -o "$work/$ORCA_ASSET" "$ORCA_URL" || die "download failed. Nothing was changed."
    actual="$(sha256sum "$work/$ORCA_ASSET" | cut -d' ' -f1)"
    [[ "$actual" == "$ORCA_SHA256" ]] || die "checksum mismatch (got $actual). The download was discarded; nothing was changed."
    log "checksum verified"
    chmod +x "$work/$ORCA_ASSET"
    ( cd "$work" && "./$ORCA_ASSET" --appimage-extract >/dev/null ) || die "could not unpack the AppImage. Nothing was changed."
    rm -rf "$ORCA_DIR"
    mv "$work/squashfs-root" "$ORCA_DIR"
    cat >"$ORCA_DIR/run-orca" <<EOF
#!/bin/bash
# Headless OrcaSlicer $ORCA_VERSION, as the Hopper component calls it.
# LC_ALL=C: Orca segfaults on some locales (its own AppRun sets the same).
export LC_ALL=C
export LD_LIBRARY_PATH="$ORCA_DIR/lib/orca-runtime:$ORCA_DIR/bin\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$ORCA_DIR/bin/orca-slicer" "\$@"
EOF
    chmod 755 "$ORCA_DIR/run-orca"
    echo "$ORCA_SHA256  $ORCA_ASSET" >"$ORCA_DIR/.verified"
    rm -rf "$work"
    trap - EXIT
    log "unpacked to $ORCA_DIR"
fi

# --- smoke test, then switch over --------------------------------------------------------
# Run where Orca can't litter: it writes a result.json into its working directory,
# even for --help.
help="$(cd "$ORCA_HOME" && env -u DISPLAY -u WAYLAND_DISPLAY timeout 60 "$ORCA_DIR/run-orca" --help 2>&1)" \
    || die "OrcaSlicer didn't start: $(printf '%s' "$help" | tail -2)"
rm -f "$ORCA_HOME/result.json"
grep -q "OrcaSlicer-$ORCA_VERSION" <<<"$help" || die "unexpected OrcaSlicer output: $(printf '%s' "$help" | head -1)"
log "OrcaSlicer $ORCA_VERSION runs headless"

ln -sfn "$ORCA_VERSION" "$ORCA_HOME/current"
# Older versions go only once this one is known to run.
for old in "$ORCA_HOME"/*/; do
    old="${old%/}"
    [[ "$(basename "$old")" == "$ORCA_VERSION" ]] && continue
    [[ -L "$old" ]] && continue
    rm -rf "$old" && log "removed old version $(basename "$old")"
done
log "ready: $ORCA_HOME/current/run-orca"
