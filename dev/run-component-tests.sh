#!/usr/bin/env bash
# Component unit tests, run with Moonraker's own interpreter, which already has its
# dependencies.
#
# The pattern is deliberately `test_component*.py`: other test_* files may need a
# different interpreter (a browser test suite, for example).
set -euo pipefail
MOONRAKER_PATH="${MOONRAKER_PATH:-$HOME/moonraker}"
MOONRAKER_PYTHON="${MOONRAKER_PYTHON:-$HOME/moonraker-env/bin/python}"
[[ -x "$MOONRAKER_PYTHON" ]] || { echo "no Moonraker python at $MOONRAKER_PYTHON"; exit 1; }
[[ -d "$MOONRAKER_PATH" ]]   || { echo "no Moonraker source at $MOONRAKER_PATH"; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")/.."
MOONRAKER_PATH="$MOONRAKER_PATH" exec "$MOONRAKER_PYTHON" \
    -m unittest discover -s dev -p 'test_component*.py' -v "$@"
