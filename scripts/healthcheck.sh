#!/usr/bin/env bash
# Is the injection actually working right now?
#
# Three things can silently stop it without anything visibly breaking:
#
#   1. Mainsail's nginx site is regenerated -- by KIAUH's reinstall/repair, or by
#      hand -- and our include goes with it.
#   2. A Mainsail update changes Workbox's precache manifest format, so the sw.js
#      rewrite stops matching. PWA users then keep a stale page forever, while a
#      plain browser looks fine.
#   3. gzip_static gets enabled with pre-compressed files present, which makes
#      sub_filter skip the response for every gzip-accepting client -- that is,
#      every browser -- while plain curl still shows the injection.
#
#   4. A rebuilt UI that was never copied to where nginx serves it.
#
# None of these announce themselves, which is why this exists. Exits non-zero and
# says what to do.
#
#   scripts/healthcheck.sh            check and report
#   scripts/healthcheck.sh --quiet    exit status only, for a timer or a cron job
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

QUIET=0
for arg in "$@"; do
    [[ "$arg" == "--quiet" || "$arg" == "-q" ]] && QUIET=1
done
say() { [[ $QUIET -eq 1 ]] || log "$*"; }

problems=0
note() { problems=$((problems + 1)); log "PROBLEM: $*"; }

SITE="$(find_mainsail_site)" || exit 2
ROOT="$(site_root "$SITE")"
URL="$(site_url "$SITE")"
say "site $SITE (root $ROOT, version $(cat "$ROOT/.version" 2>/dev/null || echo unknown))"

# 1. The include, in every server block the file has.
if site_include_complete "$SITE"; then
    say "ok: include present in all $(count_server_blocks "$SITE") server block(s)"
else
    note "our include is in $(count_our_includes "$SITE") of $(count_server_blocks "$SITE") server block(s) in $SITE. Something rewrote it. Re-run scripts/install.sh to repair."
fi

# 2. What is actually served.
page="$(curl -fsS "$URL/" 2>/dev/null || true)"
if [[ -z "$page" ]]; then
    note "could not fetch $URL/ -- is nginx running?"
elif grep -q '/communitycad/inject.js' <<<"$page"; then
    say "ok: the page carries the script tag"
else
    if site_include_complete "$SITE"; then
        # The config is right and the page still is not injected, which is the
        # genuinely puzzling case worth calling out as such.
        note "$URL/ does not carry the script tag, even though the include is in place. Has nginx been reloaded?"
    else
        note "$URL/ does not carry the script tag, which follows from the missing include above."
    fi
fi

# 3. The same page as a browser asks for it. gzip_static serves a pre-compressed file
# as-is and sub_filter skips it, so this can fail while the plain fetch passes.
#
# Only meaningful when the plain fetch DID carry the tag: if it did not, the injection
# is missing for everyone and the problems above already say why. Reporting
# gzip_static then sends the reader after the wrong thing.
if grep -q '/communitycad/inject.js' <<<"$page" 2>/dev/null; then
    gz="$(curl -fsS --compressed "$URL/" 2>/dev/null || true)"
    if [[ -n "$gz" ]] && ! grep -q '/communitycad/inject.js' <<<"$gz"; then
        note "the page is injected for a plain request but NOT for a gzip-accepting one. That is gzip_static: every real browser would miss the injection. Set 'gzip_static off;' for Mainsail's server."
    fi
fi

# 4. The service worker rewrite, which is what keeps PWA users current.
sw="$(curl -fsS "$URL/sw.js" 2>/dev/null || true)"
if [[ -z "$sw" ]]; then
    note "could not fetch $URL/sw.js"
elif grep -q 'ccad1-' <<<"$sw"; then
    say "ok: sw.js is rewritten, so PWA users pick up changes"
elif grep -qE '\{url:"index\.html",revision:"|\{"revision":"' <<<"$sw"; then
    note "sw.js has a Workbox manifest but our rewrite did not apply. The two interfaces use different manifest shapes; check the sub_filter for /sw.js and the search string in the http snippet."
else
    note "sw.js no longer contains the pattern we rewrite. A Mainsail update probably changed Workbox's manifest format; PWA users will keep a stale page. The search string is in nginx/communitycad-server.conf."
fi

# 5. The bundle itself.
if curl -fsS -o /dev/null "$URL/communitycad/inject.js" 2>/dev/null; then
    say "ok: inject.js is served"
else
    note "$URL/communitycad/inject.js is not reachable. Check that nginx can read $CCAD_WEB_DIR."
fi

# 6. The bundle is the one last built. nginx serves a copy, so a rebuild that
#    wasn't copied over looks healthy above while the page runs old code.
if [[ -f "$CCAD_WEB_SRC/inject.js" && -f "$CCAD_WEB_DIR/inject.js" ]] \
        && ! cmp -s "$CCAD_WEB_SRC/inject.js" "$CCAD_WEB_DIR/inject.js" \
        && [[ "$CCAD_WEB_SRC/inject.js" -nt "$CCAD_WEB_DIR/inject.js" ]]; then
    note "the served UI is older than the build in $CCAD_WEB_SRC. Run scripts/update-ui.sh."
else
    say "ok: the served UI is the latest build"
fi

if [[ $problems -eq 0 ]]; then
    say "healthy"
    exit 0
fi
log "$problems problem(s) found"
exit 1
