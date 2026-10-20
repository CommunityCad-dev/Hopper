#!/usr/bin/env bash
# Put the UI just built (web/dist) where nginx serves it, on an installed printer.
#
# nginx serves a copy in $CCAD_HOME/web, not web/dist, so a rebuild is invisible
# until it's copied there. Only the bundle is copied: nginx, its config and
# Moonraker are untouched, so this needs no sudo and is safe while printing. The
# previous bundle is kept beside it as inject.js.prev.
#
#   (cd web && npm run build) && scripts/update-ui.sh
#
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

src="$CCAD_WEB_SRC/inject.js"
dest="$CCAD_WEB_DIR/inject.js"
[[ -f "$src" ]] || die "no built UI at $src. Build it first: (cd web && npm run build)."
[[ -d "$CCAD_WEB_DIR" ]] || die "$CCAD_WEB_DIR doesn't exist: the plugin isn't installed here. Run scripts/install.sh."
if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
    log "already current: $dest"
    exit 0
fi
[[ -f "$dest" ]] && cp -p "$dest" "$dest.prev"
install -m 644 "$src" "$dest"
log "updated $dest ($(wc -c < "$dest") bytes). Reload the page to use it."
