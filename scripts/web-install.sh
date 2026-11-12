#!/usr/bin/env bash
# Install Hopper for Klipper in one command, on the printer's Pi:
#
#   bash <(curl -fsSL https://github.com/CommunityCad-dev/Hopper/releases/latest/download/install.sh)
#
# Each release attaches this script as install.sh. It downloads that same release's
# hopper.zip into ~/hopper, then runs scripts/install-all.sh, which checks the device
# and asks before changing anything. Arguments are passed on to it:
#
#   bash <(curl -fsSL .../install.sh) --check      check this device only
#   curl -fsSL .../install.sh | bash -s -- --check  the same, piped
#
# Needs bash, python3 (Moonraker needs it, so it's there) and curl or wget. Not unzip.
# HOPPER_DIR changes where it goes (default ~/hopper).
#
# Everything is in one function, called on the last line: if the download is cut
# short, nothing runs.

hopper_web_install() {
    set -euo pipefail

    local version="__HOPPER_VERSION__"
    local repo="CommunityCad-dev/Hopper"
    local url="${HOPPER_ZIP_URL:-https://github.com/$repo/releases/download/v$version/hopper.zip}"
    [[ "$version" == "__HOPPER_VERSION__" && -z "${HOPPER_ZIP_URL:-}" ]] \
        && url="https://github.com/$repo/releases/latest/download/hopper.zip"
    local dest="${HOPPER_DIR:-$HOME/hopper}"

    say() { printf 'hopper: %s\n' "$*"; }
    die() { printf 'hopper: %s\n' "$*" >&2; exit 1; }

    [[ "$(id -u)" -ne 0 ]] || die "run this as your normal user, not root or sudo. It asks for sudo itself when it needs it. Nothing was changed."
    command -v python3 >/dev/null || die "python3 not found. Is this the printer's Pi, with Moonraker installed? Nothing was changed."

    # What's in the way. A release is replaced, the same as a Moonraker update;
    # anything else is someone's, and is left alone.
    if [[ -e "$dest" ]]; then
        if [[ -e "$dest/.git" ]]; then
            die "$dest is a git checkout. Update it with git pull and run scripts/install-all.sh there, or set HOPPER_DIR to install somewhere else. Nothing was changed."
        fi
        if ! grep -qs '"project_name": *"Hopper"' "$dest/release_info.json"; then
            die "$dest already exists and isn't a Hopper release. Move it, or set HOPPER_DIR to install somewhere else. Nothing was changed."
        fi
    fi

    # Global, not local: the EXIT trap runs after this function has returned.
    HOPPER_WORK="$(mktemp -d "$(dirname "$dest")/.hopper-install.XXXXXX")"
    trap 'rm -rf "$HOPPER_WORK"' EXIT
    local work="$HOPPER_WORK"

    say "downloading $url"
    if command -v curl >/dev/null; then
        curl -fsSL --retry 3 -o "$work/hopper.zip" "$url" || die "download failed. Nothing was changed."
    elif command -v wget >/dev/null; then
        wget -q --tries=3 -O "$work/hopper.zip" "$url" || die "download failed. Nothing was changed."
    else
        die "neither curl nor wget found. Nothing was changed."
    fi

    # python3's zipfile, keeping the executable bits that unzip would keep.
    python3 -I - "$work/hopper.zip" "$work/new" <<'PY' || die "the download isn't a valid Hopper release. Nothing was changed."
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        path = z.extract(info, out)
        mode = (info.external_attr >> 16) & 0o777
        if mode and not info.is_dir():
            os.chmod(path, mode)
PY
    [[ -x "$work/new/scripts/install-all.sh" ]] || die "the download isn't a valid Hopper release. Nothing was changed."

    if [[ -e "$dest" ]]; then
        mv "$dest" "$work/old"
    fi
    mv "$work/new" "$dest"
    say "unpacked into $dest"
    echo

    # Piped (curl ... | bash), stdin is the script itself, and the installer's
    # questions would read it as their answers. Give them the terminal instead.
    cd "$dest"
    if [[ ! -t 0 ]] && { : </dev/tty; } 2>/dev/null; then
        scripts/install-all.sh "$@" </dev/tty
    else
        scripts/install-all.sh "$@"
    fi
}

hopper_web_install "$@"
