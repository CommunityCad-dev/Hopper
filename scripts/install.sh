#!/usr/bin/env bash
# Inject the Hopper script into Mainsail via nginx sub_filter.
# Idempotent: re-running changes nothing if already installed (the web files are refreshed).
# Never touches Mainsail's own files. Backs up every nginx file it changes to $CCAD_HOME/backups.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
source "$(dirname "${BASH_SOURCE[0]}")/moonraker.sh"

# --with-moonraker=no installs only the nginx injection, for a host that serves the
# interface but runs no Moonraker of its own.
WITH_MOONRAKER=1
ACCEPTED=0
for arg in "$@"; do
    case "$arg" in
        --with-moonraker=no|--no-moonraker) WITH_MOONRAKER=0 ;;
        --accept) ACCEPTED=1 ;;
        -h|--help)
            printf 'usage: install.sh [--no-moonraker] [--accept]\n'
            printf '  --accept  agree to the notice below without being asked (scripted installs)\n'
            printf '  MOONRAKER_CONFIGS="a/moonraker.conf b/moonraker.conf" targets those instances only\n'
            exit 0 ;;
    esac
done

# --- the notice: before anything is changed ----------------------------------------
cat <<'NOTICE'

Hopper for Klipper comes with no warranty. Use it at your own risk.

- Models and G-code on CommunityCAD are made by other people. CommunityCAD does not
  check them for safety, and a file made for another printer can damage yours.
- The checks the plugin shows (printer match, fit) are aids, not guarantees.
- You are responsible for your printer. Watch every print, especially the first layer.
- The plugin never flashes firmware, never edits printer.cfg, and sends no commands to
  your printer other than starting or queueing a file you chose.

What install changes: an nginx include in your interface's site, a [communitycad]
section in moonraker.conf, and files under ~/communitycad and ~/printer_data/communitycad.
scripts/uninstall.sh removes all of it. Terms: https://communitycad.dev/terms

NOTICE
if [[ $ACCEPTED -ne 1 ]]; then
    if [[ ! -t 0 ]]; then
        die "not accepted. Run it in a terminal and answer y, or pass --accept to agree to the notice above. Nothing was changed."
    fi
    read -r -p "Install, accepting the above? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || die "not accepted. Nothing was changed."
fi

# --- preflight -------------------------------------------------------------------------
command -v "$NGINX_BIN" >/dev/null || die "nginx binary '$NGINX_BIN' not found"
if ! nginx_cmd -V 2>&1 | grep -q -- '--with-http_sub_module'; then
    die "this nginx was built without ngx_http_sub_module (sub_filter), so the injection cannot work. Nothing was changed. On Debian 11 this means nginx-light; install nginx-core or nginx-full."
fi

SITE="$(find_mainsail_site)"
ROOT="$(site_root "$SITE")"
INTERFACE="$(interface_in_dir "$ROOT")"
log "$INTERFACE site: $SITE (root $ROOT, version $(cat "$ROOT/.version" 2>/dev/null || echo unknown))"

# Mainsail and Fluidd ship different Workbox precache manifests, so the service-worker
# rewrite is not the same string for both. Getting this wrong is silent: the injection
# works for ordinary loads and PWA users keep a stale page forever.
case "$INTERFACE" in
    mainsail)
        SW_MATCH='{url:"index.html",revision:"'
        SW_REPLACE='{url:"index.html",revision:"ccad1-'
        ;;
    fluidd)
        # Revision comes first here, so there is nothing to anchor on but the revision
        # itself; index.html is the manifest's first entry, so sub_filter_once hits it.
        SW_MATCH='"revision":"'
        SW_REPLACE='"revision":"ccad1-'
        ;;
    *)
        die "unrecognised interface at $ROOT. Nothing was changed."
        ;;
esac

# gzip_static serves index.html.gz as-is; sub_filter skips encoded responses, so injection
# would silently not happen. Mainsail releases ship no .gz files today; refuse if they appear.
if $SUDO grep -rqsE '^[[:space:]]*gzip_static[[:space:]]+(on|always)' "$NGINX_DIR"; then
    if [[ -e "$ROOT/index.html.gz" || -e "$ROOT/sw.js.gz" ]]; then
        die "gzip_static is enabled and $ROOT contains index.html.gz/sw.js.gz; sub_filter would be bypassed. Set 'gzip_static off;' for Mainsail's server (see REPORT.md, criterion B). Nothing was changed."
    fi
    log "WARNING: gzip_static is enabled somewhere under $NGINX_DIR. Fine today (no .gz files), but injection will stop if pre-compressed files ever appear."
fi

# --- web files (ours, outside Mainsail's dir) ------------------------------------------
mkdir -p "$CCAD_WEB_DIR" "$CCAD_BACKUPS"
chmod 755 "$CCAD_HOME" "$CCAD_WEB_DIR"
if [[ ! -f "$CCAD_WEB_SRC/inject.js" ]]; then
    die "no built UI at $CCAD_WEB_SRC/inject.js. Build it first: (cd web && npm ci && npm run build). Nothing was changed."
fi
install -m 644 "$CCAD_WEB_SRC/inject.js" "$CCAD_WEB_DIR/inject.js"

# --- nginx config ----------------------------------------------------------------------
BACKED_UP=()
changed=0

# Write $2 (content) to $1 as root, backing up an existing different version first.
put_conf() {
    local dest="$1" content="$2"
    if [[ -e "$dest" ]] && [[ "$($SUDO cat "$dest")" == "$content" ]]; then return 0; fi
    [[ -e "$dest" ]] && BACKED_UP+=("$(backup_file "$dest")")
    $SUDO mkdir -p "$(dirname "$dest")"
    printf '%s\n' "$content" | $SUDO tee "$dest" >/dev/null
    changed=1
}

put_conf "$HTTP_CONF" "$(sed "s|@CCAD_SW_MATCH@|$SW_MATCH|g" "$PLUGIN_SRC/nginx/communitycad-http.conf")"
put_conf "$SERVER_CONF" "$(sed -e "s|@CCAD_WEB_DIR@|$CCAD_WEB_DIR|g" -e "s|@CCAD_SW_REPLACE@|$SW_REPLACE|g" "$PLUGIN_SRC/nginx/communitycad-server.conf")"

SITE_BACKUP=""
if site_include_complete "$SITE"; then
    log "include present in all $(count_server_blocks "$SITE") server block(s) of $SITE"
else
    blocks="$(count_server_blocks "$SITE")"
    have="$(count_our_includes "$SITE")"
    [[ "$blocks" -gt 0 ]] || die "no 'server {' line found in $SITE. Nothing was changed."
    if [[ "$have" -gt 0 ]]; then
        # Partially applied: the file gained a server block since we installed, or
        # something rewrote part of it. Strip what we have and redo it cleanly,
        # rather than leaving blocks unserved that re-running cannot fix.
        log "include is in $have of $blocks server block(s); re-applying"
    fi
    SITE_BACKUP="$(backup_file "$SITE")"
    BACKED_UP+=("$SITE_BACKUP")
    strip_our_include "$SITE_BACKUP" >"$CCAD_HOME/.site-stripped"
    add_our_include "$CCAD_HOME/.site-stripped" | $SUDO tee "$SITE" >/dev/null
    rm -f "$CCAD_HOME/.site-stripped"
    if ! site_include_complete "$SITE"; then
        $SUDO cp "$SITE_BACKUP" "$SITE"
        die "could not add the include to every server block in $SITE; restored it unchanged"
    fi
    changed=1
fi

for b in "${BACKED_UP[@]}"; do log "backed up -> $b"; done

if [[ $changed -eq 1 ]]; then
    if ! out="$(nginx_test)"; then
        printf '%s\n' "$out" >&2
        log "nginx -t failed, rolling back"
        [[ -n "$SITE_BACKUP" ]] && $SUDO cp "$SITE_BACKUP" "$SITE"
        $SUDO rm -f "$HTTP_CONF" "$SERVER_CONF"
        $SUDO rmdir "$SERVER_CONF_DIR" 2>/dev/null || true
        die "install aborted; nginx config restored"
    fi
    nginx_reload
    log "nginx reloaded"
    # Only after success: uninstall uses this to compare against the pre-install site file.
    [[ -n "$SITE_BACKUP" ]] && printf 'SITE=%s\nSITE_ORIGINAL=%s\n' "$SITE" "$SITE_BACKUP" >"$CCAD_STATE"
else
    log "nginx config already up to date"
fi

# --- Moonraker -------------------------------------------------------------------------
# After nginx, so a Moonraker failure cannot leave the interface half-injected with no
# component behind it: by here the browser half is already known good.
if [[ $WITH_MOONRAKER -eq 1 ]]; then
    mapfile -t MR_CONFIGS < <(find_moonraker_configs)
    # More than one Klipper instance on this Pi (KIAUH multi-instance). Ask, because
    # installing for a printer the user did not mean to is worse than asking once.
    # Non-interactive (a script, an installer pipeline) takes them all, which is the
    # sensible default and what the plan specifies.
    if [[ ${#MR_CONFIGS[@]} -gt 1 && -t 0 && "${CCAD_ASSUME_ALL:-0}" != "1" ]]; then
        log "found ${#MR_CONFIGS[@]} Klipper instances:"
        for i in "${!MR_CONFIGS[@]}"; do
            log "  $((i + 1))) $(data_path_for "${MR_CONFIGS[i]}")"
        done
        printf '[communitycad] install for which? [Enter = all, or numbers like "1 3"]: '
        read -r reply || reply=""
        if [[ -n "${reply// /}" ]]; then
            chosen=()
            for n in $reply; do
                if [[ "$n" =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#MR_CONFIGS[@]} )); then
                    chosen+=("${MR_CONFIGS[n-1]}")
                else
                    die "'$n' is not one of the listed instances. Nothing was changed."
                fi
            done
            MR_CONFIGS=("${chosen[@]}")
        fi
    fi

    if [[ ${#MR_CONFIGS[@]} -eq 0 ]]; then
        log "WARNING: no moonraker.conf found under $HOME. Skipping the component."
        log "         Set MOONRAKER_CONFIGS=/path/to/moonraker.conf and re-run to wire it up."
    else
        log "Moonraker instances: ${#MR_CONFIGS[@]}"
        mr_changed=0
        if link_component; then
            for conf in "${MR_CONFIGS[@]}"; do
                dp="$(data_path_for "$conf")"
                log "  instance: $dp"
                write_install_state "$dp"
                add_moonraker_section "$conf" && mr_changed=1
            done
            if [[ $mr_changed -eq 0 ]]; then
                log "Moonraker config already up to date"
            fi
            # Restart when the config changed, and also when it did not but the
            # component is not running: that is the state left by a config added
            # without a restart, and it looks installed while doing nothing.
            if [[ $mr_changed -eq 1 ]] || ! component_loaded; then
                if restart_moonraker; then
                    if wait_for_component; then
                        log "component loaded"
                    else
                        log "WARNING: Moonraker restarted but the component did not load."
                        log "         Check ~/printer_data/logs/moonraker.log"
                    fi
                fi
            else
                log "component already loaded"
            fi
        fi
    fi
fi

# --- verify ----------------------------------------------------------------------------
URL="$(site_url "$SITE")"
sleep 0.5
if curl -fsS "$URL/" | grep -q '/communitycad/inject.js'; then log "verified: $URL/ contains the script tag"; else log "WARNING: script tag not found at $URL/"; fi
# 'ccad1-' is our marker in both interfaces' manifests, so this check does not care
# which one is installed.
if curl -fsS "$URL/sw.js" | grep -q 'ccad1-'; then log "verified: $URL/sw.js is rewritten"; else log "WARNING: sw.js not rewritten; PWA users may keep a stale page"; fi
curl -fsS -o /dev/null "$URL/communitycad/inject.js" && log "verified: $URL/communitycad/inject.js is served" || log "WARNING: inject.js not reachable (check that nginx can read $CCAD_WEB_DIR)"

# Keep the backup directory from growing without bound.
rotate_backups
