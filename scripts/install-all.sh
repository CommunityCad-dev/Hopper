#!/usr/bin/env bash
# Install Hopper for Klipper with slicing on the printer: the plugin, then
# OrcaSlicer. The way to install for most people.
#
# It checks this device first and changes nothing until you've seen the result:
#   - Hopper needs nginx with sub_filter, a Mainsail or Fluidd site, and Moonraker.
#   - Slicing on the printer also needs a 64-bit OS, OrcaSlicer's libraries from apt,
#     enough memory and disk, and GitHub for the download.
# If only slicing can't be installed, it says why and offers Hopper on its own.
#
#   scripts/install-all.sh            check, then install both (asks before changing anything)
#   scripts/install-all.sh --check    check only; changes nothing
#   scripts/install-all.sh --accept   agree to the notice without being asked (scripted installs)
#   scripts/install-all.sh --no-orca  Hopper only: the same as scripts/install.sh
#
# The two parts on their own: scripts/install.sh (Hopper) and scripts/install-orca.sh
# (slicing on the printer, added later). scripts/uninstall.sh removes both.
set -uo pipefail
HERE="$(dirname "${BASH_SOURCE[0]}")"
source "$HERE/common.sh"
set +e   # checks report failures; they don't stop the script

CHECK_ONLY=0
ACCEPTED=0
NO_ORCA=0
PASS=()   # arguments for install.sh
for arg in "$@"; do
    case "$arg" in
        --check) CHECK_ONLY=1 ;;
        --accept) ACCEPTED=1; PASS+=("$arg") ;;
        --no-orca) NO_ORCA=1 ;;
        -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) PASS+=("$arg") ;;
    esac
done

# Overridable so the check can be tested without the hardware (dev/test_install_all.sh).
ARCH="${CCAD_CHECK_ARCH:-$(dpkg --print-architecture 2>/dev/null || uname -m)}"
MEM_MB="${CCAD_CHECK_MEM_MB:-$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)}"
FREE_MB="${CCAD_CHECK_FREE_MB:-$(df -Pm "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')}"
ORCA_NEED_MB=700          # about 500 MB installed, plus the download while unpacking
ORCA_MIN_MEM_MB=900       # a big model needed 922 MB to slice; below this, slicing isn't offered
ORCA_GOOD_MEM_MB=1900     # below this (a 1 GB board), small models slice and big ones may not

plugin_ok=1
orca_ok=1
orca_warn=()
row() {   # row <✓|⚠|✗> <text>
    printf '  %s %s\n' "$1" "$2"
}

echo
echo "Checking this device"
echo
echo "Hopper:"
if command -v "$NGINX_BIN" >/dev/null; then
    # nginx -V needs no root; nginx -T (the site search) usually does. In --check, never
    # wait on a sudo password: say so, and the install itself checks again.
    if $NGINX_BIN -V 2>&1 | grep -q -- '--with-http_sub_module'; then
        row ✓ "nginx with sub_filter"
    else
        row ✗ "nginx was built without sub_filter, which the plugin needs (on Debian 11 that's nginx-light: install nginx-core or nginx-full)"
        plugin_ok=0
    fi
    if [[ -z "$SUDO" ]] || $SUDO -n true 2>/dev/null; then
        site="$( (find_mainsail_site) 2>&1 )" && site_ok=1 || site_ok=0
        if [[ $site_ok -eq 1 ]]; then
            row ✓ "$(interface_in_dir "$(site_root "$site")" 2>/dev/null || echo interface) site: $site"
        else
            row ✗ "no Mainsail or Fluidd site found: ${site##*ERROR: }"
            plugin_ok=0
        fi
    else
        row ⚠ "Mainsail or Fluidd site: checked during install (reading nginx's configuration needs sudo)"
    fi
else
    row ✗ "nginx isn't installed. Install Mainsail or Fluidd first (KIAUH does this)"
    plugin_ok=0
fi
# A git checkout has no built interface: web/dist only comes in release downloads.
if [[ -f "$CCAD_WEB_SRC/inject.js" ]]; then
    row ✓ "the plugin's interface is built"
else
    row ✗ "no built interface in $CCAD_WEB_SRC. Install from the release download, not a git checkout (or build it: cd web && npm ci && npm run build, which needs Node.js)"
    plugin_ok=0
fi
if [[ -n "$(find_moonraker_configs)" ]]; then
    row ✓ "Moonraker: $(find_moonraker_configs | wc -l) instance(s)"
else
    row ✗ "no moonraker.conf under ~/printer_data. Install Klipper and Moonraker first (KIAUH does this)"
    plugin_ok=0
fi

echo
echo "Slicing on the printer (OrcaSlicer $(grep -m1 '^ORCA_VERSION=' "$HERE/install-orca.sh" | cut -d'"' -f2)):"
if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
    row ✓ "64-bit OS ($ARCH)"
else
    row ✗ "64-bit Raspberry Pi OS is needed; this is $ARCH. OrcaSlicer has no 32-bit build (a 64-bit kernel with a 32-bit system counts as 32-bit). Reflash with 64-bit Pi OS to slice on the printer"
    orca_ok=0
fi
if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
    unavailable=()
    for pkg in "${ORCA_APT_PACKAGES[@]}"; do
        dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" && continue
        cand="$(apt-cache policy "$pkg" 2>/dev/null | awk '/Candidate:/ {print $2}')"
        [[ -n "$cand" && "$cand" != "(none)" ]] || unavailable+=("$pkg")
    done
    if [[ ${#unavailable[@]} -eq 0 ]]; then
        row ✓ "OrcaSlicer's libraries available from apt"
    else
        row ✗ "apt can't find ${unavailable[*]}. These are Debian 13 (trixie) names: an older system needs updating first"
        orca_ok=0
    fi
fi
if [[ -n "$MEM_MB" ]]; then
    if (( MEM_MB < ORCA_MIN_MEM_MB )); then
        row ✗ "${MEM_MB} MB of memory: too little to slice (a large model needs about 1 GB)"
        orca_ok=0
    elif (( MEM_MB < ORCA_GOOD_MEM_MB )); then
        row ⚠ "${MEM_MB} MB of memory: small models slice, large ones may fail. 2 GB or more is better"
        orca_warn+=("memory")
    else
        row ✓ "${MEM_MB} MB of memory"
    fi
fi
if [[ -n "$FREE_MB" ]]; then
    if (( FREE_MB < ORCA_NEED_MB )); then
        row ✗ "${FREE_MB} MB free in $HOME: OrcaSlicer needs about ${ORCA_NEED_MB} MB"
        orca_ok=0
    else
        row ✓ "${FREE_MB} MB free in $HOME"
    fi
fi
if [[ -n "${CCAD_CHECK_OFFLINE:-}" ]] || ! curl -fsSI --max-time 8 https://github.com >/dev/null 2>&1; then
    row ✗ "can't reach github.com, where OrcaSlicer is downloaded from"
    orca_ok=0
else
    row ✓ "github.com reachable"
fi

echo
if [[ $plugin_ok -eq 0 ]]; then
    echo "Hopper can't be installed on this device yet: see the ✗ above. Nothing was changed."
    exit 1
fi
if [[ $NO_ORCA -eq 1 ]]; then
    plan="Hopper only (--no-orca)"
elif [[ $orca_ok -eq 1 ]]; then
    plan="Hopper and slicing on the printer"
else
    plan="Hopper only: slicing on the printer can't be installed here (see the ✗ above)"
fi
echo "Result: $plan."
if [[ $CHECK_ONLY -eq 1 ]]; then
    echo "Check only: nothing was changed."
    exit 0
fi

if [[ $NO_ORCA -eq 0 && $orca_ok -eq 0 ]]; then
    echo "Without it you can browse, send G-code made elsewhere and share; slicing needs a"
    echo "compatible device, or install it later with scripts/install-orca.sh."
    if [[ $ACCEPTED -ne 1 ]]; then
        [[ -t 0 ]] || die "not confirmed. Run it in a terminal, or pass --accept to install Hopper without slicing. Nothing was changed."
        read -r -p "Install Hopper without slicing on the printer? [y/N] " answer
        [[ "$answer" == "y" || "$answer" == "Y" ]] || die "not installed. Nothing was changed."
    else
        log "--accept: installing Hopper without slicing on the printer"
    fi
    NO_ORCA=1
fi

set -e
"$HERE/install.sh" "${PASS[@]}"
if [[ $NO_ORCA -eq 0 ]]; then
    echo
    log "now slicing on the printer: OrcaSlicer (sudo for its libraries; about 135 MB to download)"
    "$HERE/install-orca.sh" || die "Hopper is installed, but OrcaSlicer didn't finish (see above). Run scripts/install-orca.sh to try again; everything else works meanwhile."
fi
echo
log "done. Open your printer's page and choose Hopper."
[[ ${#orca_warn[@]} -gt 0 ]] && log "note: this device has ${MEM_MB} MB of memory, so large models may fail to slice."
exit 0
