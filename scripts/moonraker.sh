# Moonraker wiring for install.sh / uninstall.sh. Sourced, not executed.
#
# Two things per instance: a symlink so Moonraker can import the component, and a
# [communitycad] section in its moonraker.conf. Both are marked and idempotent, and
# the config is backed up before any edit.
#
# Restarting goes through Moonraker's own API rather than systemctl: Moonraker can
# restart itself, so a normal user can install without sudo. If the API cannot be
# reached we say what to run instead rather than failing the install -- the files are
# already correct by then, and a restart is all that is outstanding.

component_link_path() { printf '%s/moonraker/components/communitycad.py' "$MOONRAKER_SRC"; }

# Where updates come from: GitHub releases, installed by Moonraker's `type: zip`.
CCAD_REPO="${CCAD_REPO:-CommunityCad-dev/communitycad-klipper}"

# Is this a release install, or a git checkout someone is developing in?
#
# Moonraker's zip updater refuses to manage a path inside a git repo -- it would be
# fighting whoever owns that checkout. So a development install gets the component and
# nothing else, and is updated with `git pull`, which is what its owner expects anyway.
is_release_install() {
    ! git -C "$PLUGIN_SRC" rev-parse --show-toplevel >/dev/null 2>&1
}

moonraker_section() {
    printf '%s\n' "$MARK_BEGIN" "[communitycad]" "# api_base: https://communitycad.dev/api/v1" ""
    if is_release_install; then
        printf '%s\n' \
            "[update_manager communitycad]" \
            "type: zip" \
            "channel: stable" \
            "repo: $CCAD_REPO" \
            "path: $PLUGIN_SRC" \
            "managed_services: moonraker"
    else
        printf '%s\n' \
            "# No [update_manager communitycad] here: this is a git checkout, and" \
            "# Moonraker's zip updater will not manage a path inside a repo. Update" \
            "# it with git pull, then re-run scripts/install.sh."
    fi
    printf '%s\n' "$MARK_END"
}

link_component() {
    local link src
    link="$(component_link_path)"
    src="$PLUGIN_SRC/component/communitycad.py"
    [[ -f "$src" ]] || die "component source missing at $src"
    if [[ ! -d "$(dirname "$link")" ]]; then
        log "WARNING: no Moonraker components dir at $(dirname "$link"); skipping the component"
        return 1
    fi
    if [[ -L "$link" && "$(readlink -f "$link")" == "$(readlink -f "$src")" ]]; then
        return 0   # already ours
    fi
    if [[ -e "$link" && ! -L "$link" ]]; then
        die "$link exists and is not a symlink. Refusing to overwrite a real file. Nothing was changed."
    fi
    ln -sfn "$src" "$link"
    log "linked component -> $link"
    return 0
}

unlink_component() {
    local link src
    link="$(component_link_path)"
    src="$PLUGIN_SRC/component/communitycad.py"
    # Only remove a link that points at our own source, never someone else's file.
    if [[ -L "$link" && "$(readlink -f "$link")" == "$(readlink -f "$src")" ]]; then
        rm -f "$link"
        log "removed component link $link"
    fi
}

add_moonraker_section() {
    local conf="$1"
    if grep -qF "$MARK_BEGIN" "$conf"; then
        log "[communitycad] already in $conf"
        return 1
    fi
    local backup
    backup="$(backup_file "$conf")"
    log "backed up -> $backup"
    { printf '\n'; moonraker_section; } >>"$conf"
    log "added [communitycad] to $conf"
    return 0
}

remove_moonraker_section() {
    local conf="$1"
    grep -qF "$MARK_BEGIN" "$conf" || return 1
    local backup
    backup="$(backup_file "$conf")"
    log "backed up -> $backup"
    # Drop our marked block and the blank line we added before it, so the file comes
    # back byte-identical to what it was before install.
    #
    # index(), not `$0 ~ b`: the markers contain parentheses, which a regex reads as a
    # group, so a regex match silently never fires and the block survives while this
    # function reports success.
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
        index($0, b)               { held = ""; holding = 0; drop = 1; next }
        drop                       { if (index($0, e)) drop = 0; next }
        /^[[:space:]]*$/           { if (holding) print held; held = $0; holding = 1; next }
                                   { if (holding) { print held; holding = 0 } print }
        END                        { if (holding) print held }
    ' "$backup" >"$conf"
    if grep -qF "$MARK_BEGIN" "$conf"; then
        cp "$backup" "$conf"
        die "failed to remove the [communitycad] block from $conf; restored it unchanged"
    fi
    log "removed [communitycad] from $conf"
    return 0
}

# Is the component actually running? Config on disk is not the same as loaded: a
# config added but never followed by a restart leaves an install that looks complete
# and does nothing. Cheap to check, and the check is what makes install.sh honest.
component_loaded() {
    curl -fsS -m 5 "$MOONRAKER_API/server/info" 2>/dev/null | grep -q '"communitycad"'
}

# Wait for Moonraker to come back after a restart, up to ~60s.
wait_for_component() {
    local i
    for i in $(seq 1 30); do
        sleep 2
        component_loaded && return 0
    done
    return 1
}

# Record what the nginx half did, where the component can read it.
#
# The component cannot discover nginx's layout itself, and should not try. This is
# the one fact it needs to answer "am I actually injected?", which is what lets it
# warn the user through Moonraker's announcements when the answer is no -- the only
# surface left when our own UI is the thing that is missing.
write_install_state() {
    # The dev harness installs into a sandbox nginx, and must not overwrite the state
    # describing the real one. Both run against the same Moonraker data path, so
    # whichever ran last would otherwise win, and the component would end up watching
    # a throwaway site file -- and eventually announce a problem that is not real.
    if [[ "${CCAD_DEV:-0}" == "1" ]]; then
        return 0
    fi
    local data_path="$1" dir
    dir="$data_path/communitycad"
    # Owner-only, as the component expects: it also holds the account token. The
    # component tightens an existing directory too, but nothing should rely on that.
    mkdir -p "$dir"
    chmod 700 "$dir"
    cat >"$dir/install-state.json" <<JSON
{
  "nginx_site": "$SITE",
  "marker": "$MARK_BEGIN",
  "web_dir": "$CCAD_WEB_DIR",
  "installed_at": "$(date -Is)"
}
JSON
    chmod 644 "$dir/install-state.json"
}

remove_install_state() {
    rm -f "$1/communitycad/install-state.json"
}

restart_moonraker() {
    if curl -fsS -m 10 -X POST "$MOONRAKER_API/machine/services/restart?service=moonraker" >/dev/null 2>&1; then
        log "Moonraker restarting"
        return 0
    fi
    log "WARNING: could not reach Moonraker at $MOONRAKER_API to restart it."
    log "         Restart it yourself:  sudo systemctl restart moonraker"
    return 1
}
