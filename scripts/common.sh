# Shared settings/helpers for install.sh and uninstall.sh. Sourced, not executed.
# Every path/command is overridable via environment so the same scripts can target
# the dev harness nginx (see dev/) as well as the system nginx on a real Pi.

set -euo pipefail

# Repo root. The scripts live in scripts/, while web/ and nginx/ are siblings of it.
PLUGIN_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Built UI bundle. Produced by `npm run build` in web/ — never built on the printer.
CCAD_WEB_SRC="${CCAD_WEB_SRC:-$PLUGIN_SRC/web/dist}"

CCAD_HOME="${CCAD_HOME:-$HOME/communitycad}"
CCAD_WEB_DIR="$CCAD_HOME/web"
CCAD_BACKUPS="$CCAD_HOME/backups"
CCAD_STATE="$CCAD_HOME/install-state"

# The libraries OrcaSlicer links that a Pi OS Lite image doesn't have (Debian 13 names).
# install-orca.sh installs them; install-all.sh checks apt can.
ORCA_APT_PACKAGES=(libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libsoup-3.0-0
                   libglu1-mesa libmspack0t64 libsecret-1-0)

NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
NGINX_BIN="${NGINX_BIN:-nginx}"
NGINX_ARGS="${NGINX_ARGS:-}"
NGINX_RELOAD="${NGINX_RELOAD:-systemctl reload nginx}"
MAINSAIL_SITE="${MAINSAIL_SITE:-}"

HTTP_CONF="$NGINX_DIR/conf.d/communitycad.conf"
SERVER_CONF_DIR="$NGINX_DIR/communitycad"
SERVER_CONF="$SERVER_CONF_DIR/mainsail-server.conf"

# --- Moonraker -------------------------------------------------------------------------
# Source checkout (components live in $MOONRAKER_SRC/moonraker/components) and the API,
# which we use to restart Moonraker: it can restart itself, so installing needs no sudo.
MOONRAKER_SRC="${MOONRAKER_SRC:-$HOME/moonraker}"
MOONRAKER_API="${MOONRAKER_API:-http://127.0.0.1:7125}"
# Blank = discover every instance. Set to one or more config paths to target those only.
MOONRAKER_CONFIGS="${MOONRAKER_CONFIGS:-}"

# Print every moonraker.conf we can find, one per line.
# KIAUH multi-instance uses printer_1_data, printer_2_data, ...; a single install uses
# printer_data. Both are just directories under $HOME, so a glob finds them all.
find_moonraker_configs() {
    if [[ -n "$MOONRAKER_CONFIGS" ]]; then
        printf '%s\n' $MOONRAKER_CONFIGS
        return
    fi
    local d
    for d in "$HOME"/printer_data "$HOME"/printer_*_data; do
        [[ -f "$d/config/moonraker.conf" ]] && printf '%s\n' "$d/config/moonraker.conf"
    done
}

# The data_path Moonraker passes to components, derived from the config location.
data_path_for() { dirname "$(dirname "$1")"; }

MARK_BEGIN="# >>> communitycad (managed by communitycad install.sh; remove with uninstall.sh)"
MARK_END="# <<< communitycad"

if [[ -z "${SUDO+x}" ]]; then
    if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi
fi

TS="$(date +%Y%m%d-%H%M%S)"

log() { printf '[communitycad] %s\n' "$*"; }
die() { printf '[communitycad] ERROR: %s\n' "$*" >&2; exit 1; }

nginx_cmd() { $SUDO $NGINX_BIN $NGINX_ARGS "$@"; }
nginx_test() { nginx_cmd -t 2>&1; }
nginx_reload() { $SUDO $NGINX_RELOAD; }

# How many install/uninstall runs' backups to keep. They are small text files, but
# one directory per run accumulates forever otherwise.
CCAD_BACKUP_KEEP="${CCAD_BACKUP_KEEP:-10}"

# Delete all but the most recent $CCAD_BACKUP_KEEP backup directories.
#
# Runs after a successful change, never before: a backup is only expendable once the
# thing it protects against has already gone well.
rotate_backups() {
    [[ -d "$CCAD_BACKUPS" ]] || return 0
    local -a dirs
    mapfile -t dirs < <(find "$CCAD_BACKUPS" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -r)
    local i
    for ((i = CCAD_BACKUP_KEEP; i < ${#dirs[@]}; i++)); do
        rm -rf "${CCAD_BACKUPS:?}/${dirs[i]}"
    done
    if (( ${#dirs[@]} > CCAD_BACKUP_KEEP )); then
        log "rotated backups: kept the newest $CCAD_BACKUP_KEEP of ${#dirs[@]}"
    fi
}

# Copy a file into this run's backup dir, mirroring its absolute path.
backup_file() {
    local src="$1" dest
    [[ -e "$src" ]] || return 0
    dest="$CCAD_BACKUPS/$TS$(realpath "$src")"
    mkdir -p "$(dirname "$dest")"
    $SUDO cat "$src" >"$dest"
    printf '%s\n' "$dest"
}

site_root() {
    # First `root` directive in the file (Mainsail's static dir).
    $SUDO sed -nE 's/^[[:space:]]*root[[:space:]]+([^;]+);.*/\1/p' "$1" | head -n1
}

# Which interface a directory holds: "mainsail", "fluidd", or nothing.
#
# Both ship release_info.json naming themselves, which is the reliable signal; the
# <title> fallback covers older builds that predate it.
interface_in_dir() {
    local d="$1"
    [[ -f "$d/index.html" ]] || return 1
    if grep -qs '"project_name"[[:space:]]*:[[:space:]]*"mainsail"' "$d/release_info.json"; then
        printf 'mainsail\n'; return 0
    fi
    if grep -qs '"project_name"[[:space:]]*:[[:space:]]*"fluidd"' "$d/release_info.json"; then
        printf 'fluidd\n'; return 0
    fi
    if grep -qs '<title>Mainsail</title>' "$d/index.html"; then printf 'mainsail\n'; return 0; fi
    if grep -qsi '<title>fluidd</title>' "$d/index.html"; then printf 'fluidd\n'; return 0; fi
    return 1
}

is_mainsail_dir() { [[ "$(interface_in_dir "$1" 2>/dev/null)" == "mainsail" ]]; }
is_interface_dir() { interface_in_dir "$1" >/dev/null 2>&1; }

# Every server block nginx actually has, as: file<TAB>root<TAB>listen
#
# `nginx -T` dumps the effective configuration with a "# configuration file <path>:"
# marker before each file, so this finds server blocks wherever they are defined --
# sites-enabled, conf.d, or an include several levels deep. Globbing sites-enabled
# only works for the layout we happen to have seen, and KIAUH does not always use it.
#
# root and listen are read only at server level: a `root` inside a location belongs to
# that location, not the site.
# Non-zero when nginx cannot even parse its own configuration. Worth separating:
# a broken config makes discovery find nothing, and "no server block serves Mainsail"
# would be a confusing way to report a syntax error someone else introduced.
nginx_config_ok() { nginx_cmd -t >/dev/null 2>&1; }

nginx_servers() {
    nginx_cmd -T 2>/dev/null | awk '
        /^# configuration file .*:$/ {
            file = $4; sub(/:$/, "", file); next
        }
        {
            line = $0
            sub(/#.*/, "", line)              # strip comments before counting braces
            opens = gsub(/\{/, "{", line)
            closes = gsub(/\}/, "}", line)

            if (!inserver && line ~ /^[[:space:]]*server[[:space:]]*\{/) {
                inserver = 1; depth = 0; root = ""; listen = ""
            }
            if (inserver) {
                # Directly inside the server block, before any nested block opens.
                if (depth == 1) {
                    if (match(line, /^[[:space:]]*root[[:space:]]+[^;]+;/)) {
                        r = line; sub(/^[[:space:]]*root[[:space:]]+/, "", r); sub(/;.*/, "", r)
                        if (root == "") root = r
                    }
                    if (match(line, /^[[:space:]]*listen[[:space:]]+[^;]+;/)) {
                        l = line; sub(/^[[:space:]]*listen[[:space:]]+/, "", l); sub(/;.*/, "", l)
                        if (listen == "") listen = l
                    }
                }
                depth += opens - closes
                if (depth <= 0) {
                    if (root != "") printf "%s\t%s\t%s\n", file, root, listen
                    inserver = 0
                }
            }
        }
    '
}

# The nginx config file that defines Mainsail's server block.
find_mainsail_site() {
    if [[ -n "$MAINSAIL_SITE" ]]; then
        realpath "$MAINSAIL_SITE"
        return
    fi

    local file root listen
    local -a found=() other=()
    while IFS=$'\t' read -r file root listen; do
        [[ -n "$file" && -n "$root" ]] || continue
        if is_interface_dir "$root"; then
            # One file can define several server blocks (http and https for the same
            # site); count the file once.
            [[ " ${found[*]-} " == *" $file "* ]] || found+=("$file")
        else
            other+=("$root")
        fi
    done < <(nginx_servers)

    if [[ ${#found[@]} -eq 1 ]]; then
        printf '%s\n' "$(realpath "${found[0]}")"
        return
    fi

    if [[ ${#found[@]} -eq 0 ]] && ! nginx_config_ok; then
        die "nginx cannot parse its own configuration, so we cannot see its server blocks. Fix that first -- nothing here was changed:
$(nginx_test)"
    fi

    if [[ ${#found[@]} -eq 0 ]]; then
        die "no nginx server block serves Mainsail or Fluidd. Checked every file in 'nginx -T'$(
            [[ ${#other[@]} -gt 0 ]] && printf '; other roots seen: %s' "${other[*]}"
        ). Set MAINSAIL_SITE=/path/to/site to say which one."
    fi

    # Mainsail beside Fluidd is fine -- they are different roots in different files.
    # Two files both serving Mainsail is genuinely ambiguous, so stop and ask.
    die "found ${#found[@]} nginx files serving an interface (${found[*]}). Set MAINSAIL_SITE=/path/to/site to choose. Nothing was changed."
}

# How many server blocks the site file has, and how many carry our include.
#
# These must match. A site file can gain a server block after we installed -- an https
# vhost added later, or KIAUH regenerating the file -- and the old check ("is the
# marker anywhere in this file?") called that done, leaving the new block uninjected
# and re-running install unable to repair it.
count_server_blocks() { $SUDO grep -cE '^[[:space:]]*server[[:space:]]*\{' "$1" || true; }
count_our_includes() { $SUDO grep -cF "$MARK_BEGIN" "$1" || true; }

site_include_complete() {
    local blocks includes
    blocks="$(count_server_blocks "$1")"
    includes="$(count_our_includes "$1")"
    [[ "$blocks" -gt 0 && "$blocks" -eq "$includes" ]]
}

# Print $1 with our marked block removed from every server block it appears in.
# index(), not a regex: the markers contain parentheses, which a regex reads as a
# group, so a regex match silently never fires.
strip_our_include() {
    $SUDO awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
        index($0, b) { drop = 1; next }
        drop         { if (index($0, e)) drop = 0; next }
                     { print }
    ' "$1"
}

# Print $1 with our include added as the first statement of every server block.
add_our_include() {
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" -v inc="include $SERVER_CONF;" '
        { print }
        /^[[:space:]]*server[[:space:]]*\{[[:space:]]*$/ { print "    " b; print "    " inc; print "    " e }
    ' "$1"
}

# Base URL of the site for post-install verification (first `listen` port on this host).
site_url() {
    if [[ -n "${VERIFY_URL:-}" ]]; then printf '%s\n' "$VERIFY_URL"; return; fi
    local listen port
    listen="$($SUDO sed -nE 's/^[[:space:]]*listen[[:space:]]+([^; ]+).*/\1/p' "$1" | head -n1)"
    port="${listen##*:}"
    printf 'http://127.0.0.1:%s\n' "${port:-80}"
}
