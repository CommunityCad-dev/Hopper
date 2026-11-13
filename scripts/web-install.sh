#!/usr/bin/env bash
# Install or uninstall Hopper for Klipper in one command, on the printer's Pi:
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
# --uninstall runs scripts/uninstall.sh from ~/hopper instead, then deletes ~/hopper:
#
#   bash <(curl -fsSL .../install.sh) --uninstall           keeps this printer's link and settings
#   bash <(curl -fsSL .../install.sh) --uninstall --purge   removes those too
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
    # Not stamped (run from a checkout): the latest release. The placeholder is split
    # so the release's stamping, which replaces it everywhere, can't rewrite this test.
    [[ "$version" == "__HOPPER_""VERSION__" && -z "${HOPPER_ZIP_URL:-}" ]] \
        && url="https://github.com/$repo/releases/latest/download/hopper.zip"
    local dest="${HOPPER_DIR:-$HOME/hopper}"

    say() { printf 'hopper: %s\n' "$*"; }
    die() { printf 'hopper: %s\n' "$*" >&2; exit 1; }

    local mode=install arg
    local args=()
    for arg in "$@"; do
        if [[ "$arg" == "--uninstall" ]]; then mode=uninstall; else args+=("$arg"); fi
    done

    [[ "$(id -u)" -ne 0 ]] || die "run this as your normal user, not root or sudo. It asks for sudo itself when it needs it. Nothing was changed."
    command -v python3 >/dev/null || die "python3 not found. Is this the printer's Pi, with Moonraker installed? Nothing was changed."

    # What's in the way. A release is replaced, the same as a Moonraker update;
    # anything else is someone's, and is left alone.
    if [[ -e "$dest" ]]; then
        if [[ -e "$dest/.git" ]]; then
            [[ $mode == uninstall ]] && die "$dest is a git checkout. Run scripts/uninstall.sh there yourself. Nothing was changed."
            die "$dest is a git checkout. Update it with git pull and run scripts/install-all.sh there, or set HOPPER_DIR to install somewhere else. Nothing was changed."
        fi
        if ! grep -qs '"project_name": *"Hopper"' "$dest/release_info.json"; then
            [[ $mode == uninstall ]] && die "$dest isn't a Hopper release, so it was left alone. If Hopper is installed elsewhere, set HOPPER_DIR to that folder. Nothing was changed."
            die "$dest already exists and isn't a Hopper release. Move it, or set HOPPER_DIR to install somewhere else. Nothing was changed."
        fi
    fi

    # Uninstalling with ~/hopper already there needs no download.
    if [[ $mode == uninstall && -e "$dest" ]]; then
        hopper_uninstall_from "$dest" "${args[@]}"
        return
    fi

    # Global, not local: the EXIT trap runs after this function has returned.
    HOPPER_WORK="$(mktemp -d "$(dirname "$dest")/.hopper-install.XXXXXX")"
    trap 'rm -rf "$HOPPER_WORK"' EXIT
    local work="$HOPPER_WORK"

    [[ $mode == uninstall ]] && say "$dest isn't here, so downloading the release for its uninstaller"
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

    if [[ $mode == uninstall ]]; then
        # Uninstalled from $dest itself: Moonraker's component link points into it,
        # and uninstall.sh only removes a link to its own copy.
        hopper_uninstall_from "$dest" "${args[@]}"
        return
    fi

    cd "$dest"
    hopper_with_terminal scripts/install-all.sh "${args[@]}"
}

# Piped (curl ... | bash), stdin is the script itself, and the installer's
# questions would read it as their answers. Give them the terminal instead.
hopper_with_terminal() {
    if [[ ! -t 0 ]] && { : </dev/tty; } 2>/dev/null; then
        "$@" </dev/tty
    else
        "$@"
    fi
}

# Run a release's uninstall.sh, then delete the release: nothing uses it once Hopper
# is gone. If the uninstall fails, the folder stays so it can be run again.
hopper_uninstall_from() {
    local dir="$1"; shift
    [[ -x "$dir/scripts/uninstall.sh" ]] || die "$dir has no scripts/uninstall.sh. Nothing was changed."
    cd "$dir"
    hopper_with_terminal scripts/uninstall.sh "$@" \
        || die "the uninstall stopped (see above). $dir was kept, so you can run its scripts/uninstall.sh again."
    cd "$(dirname "$dir")"
    rm -rf "$dir"
    say "removed $dir. Hopper is uninstalled."
}

hopper_web_install "$@"
