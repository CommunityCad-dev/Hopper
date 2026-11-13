#!/usr/bin/env bash
# Remove the Hopper injection. Idempotent. Backs up every nginx file it changes or
# removes to $CCAD_HOME/backups, then checks the served page is byte-identical to Mainsail's.
#
#   scripts/uninstall.sh           remove Hopper; keep this printer's link and settings
#   scripts/uninstall.sh --purge   also remove the link, settings and ~/communitycad (backups too)
#
# Never removed: models, projects, and materials.cfg / print_profiles.cfg beside printer.cfg.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
source "$(dirname "${BASH_SOURCE[0]}")/moonraker.sh"

# --no-moonraker removes only the nginx injection. The injection test suite uses this:
# it exercises nginx and has no interest in Moonraker, and tearing the component down
# on every run would restart Moonraker repeatedly for no reason.
WITH_MOONRAKER=1
PURGE=0
for arg in "$@"; do
    case "$arg" in
        --with-moonraker=no|--no-moonraker) WITH_MOONRAKER=0 ;;
        --purge) PURGE=1 ;;
    esac
done

# --- Moonraker ---------------------------------------------------------------------
# First, so the component stops being loaded before the UI that calls it disappears.
# Credentials and settings under <data_path>/communitycad/ are deliberately left in
# place: they are the user's, and a reinstall should not force them to link again.
if [[ $WITH_MOONRAKER -eq 1 ]]; then
    mr_changed=0
    while IFS= read -r conf; do
        [[ -n "$conf" ]] || continue
        remove_install_state "$(data_path_for "$conf")"
        remove_moonraker_section "$conf" && mr_changed=1
    done < <(find_moonraker_configs)
    unlink_component
    if [[ $mr_changed -eq 1 ]]; then
        restart_moonraker || true
    fi
fi

SITE=""
SITE_ORIGINAL=""
[[ -f "$CCAD_STATE" ]] && source "$CCAD_STATE"
if [[ -z "$SITE" ]]; then
    SITE="$(grep -lF "$MARK_BEGIN" "$NGINX_DIR"/sites-available/* 2>/dev/null | head -n1 || true)"
fi

changed=0
BACKED_UP=()

if [[ -n "$SITE" ]] && $SUDO grep -qF "$MARK_BEGIN" "$SITE"; then
    bk="$(backup_file "$SITE")"
    BACKED_UP+=("$bk")
    $SUDO awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
        index($0, b) { skip = 1; next }
        skip && index($0, e) { skip = 0; next }
        !skip { print }
    ' "$bk" | $SUDO tee "$SITE" >/dev/null
    changed=1
    if [[ -n "$SITE_ORIGINAL" && -f "$SITE_ORIGINAL" ]]; then
        if $SUDO cmp -s "$SITE" "$SITE_ORIGINAL"; then
            log "$SITE is byte-identical to its pre-install backup"
        else
            log "NOTE: $SITE differs from its pre-install backup ($SITE_ORIGINAL), presumably edited since install:"
            $SUDO diff "$SITE_ORIGINAL" "$SITE" || true
        fi
    fi
else
    log "no include found in nginx site config"
fi

for f in "$HTTP_CONF" "$SERVER_CONF"; do
    if [[ -e "$f" ]]; then
        BACKED_UP+=("$(backup_file "$f")")
        $SUDO rm -f "$f"
        changed=1
    fi
done
$SUDO rmdir "$SERVER_CONF_DIR" 2>/dev/null || true

for b in "${BACKED_UP[@]}"; do log "backed up -> $b"; done

if [[ $changed -eq 1 ]]; then
    if ! out="$(nginx_test)"; then
        printf '%s\n' "$out" >&2
        die "nginx -t failed after removal; backups are in $CCAD_BACKUPS/$TS. nginx was NOT reloaded."
    fi
    nginx_reload
    log "nginx reloaded"
fi

rm -rf "$CCAD_WEB_DIR"
rm -f "$CCAD_STATE"
log "removed $CCAD_WEB_DIR (backups kept in $CCAD_BACKUPS)"
# Files people saved or uploaded are theirs: never removed by uninstalling.
for dir in "$HOME"/printer_data*/models "$HOME"/printer_data*/projects; do
    [[ -d "$dir" ]] && log "kept your files in $dir (delete the folder yourself if you don't want them)"
done
if [[ -d "$CCAD_HOME/orca" ]]; then
    rm -rf "$CCAD_HOME/orca"
    log "removed OrcaSlicer ($CCAD_HOME/orca). Its apt libraries stay; see scripts/install-orca.sh"
fi

# --- verify the served page is stock ---------------------------------------------------
if [[ -n "$SITE" ]]; then
    URL="$(site_url "$SITE")"
    ROOT="$(site_root "$SITE")"
    sleep 0.5
    for f in index.html sw.js; do
        if curl -fsS "$URL/$f" | cmp -s - "$ROOT/$f"; then
            log "verified: served /$f is byte-identical to $ROOT/$f"
        else
            log "WARNING: served /$f differs from $ROOT/$f"
        fi
    done
fi

# Keep the backup directory from growing without bound.
rotate_backups

# --- purge -----------------------------------------------------------------------------
# Only when asked: the link and settings are what a reinstall would otherwise reuse.
if [[ $PURGE -eq 1 ]]; then
    while IFS= read -r conf; do
        [[ -n "$conf" ]] || continue
        dp="$(data_path_for "$conf")"
        if [[ -n "$dp" && -d "$dp/communitycad" ]]; then
            rm -rf "$dp/communitycad"
            log "purged this printer's link and settings ($dp/communitycad)"
        fi
    done < <(find_moonraker_configs)
    if [[ -n "$CCAD_HOME" && "$CCAD_HOME" != "$HOME" && -d "$CCAD_HOME" ]]; then
        rm -rf "$CCAD_HOME"
        log "purged $CCAD_HOME, backups included"
    fi
    log "The printer still shows as linked in your CommunityCAD account until you remove it there."
else
    log "kept this printer's link and settings, so a reinstall needs no new link (--purge removes them)"
fi
