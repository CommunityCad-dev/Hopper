# Contributing

Thanks for helping. Hopper for Klipper is in beta, so bug reports from real
printers are the most useful thing you can send.

## Issues

[Open an issue](../../issues/new/choose) and pick a template: bug, feature request,
enhancement or general. For a bug, say what you did, what you expected and what
happened, and include:

- your interface (Mainsail or Fluidd) and its version;
- the plugin version (**About** tab in the plugin);
- the lines mentioning `communitycad` from `~/printer_data/logs/moonraker.log`.

The plugin's **About → Feedback** opens the same form with some of this filled in.

Please don't post your printer's address, API keys or link codes in an issue.

## Pull requests

Welcome. Development happens in a separate working copy, and each release here is
published from it as a single commit, so a pull request isn't merged here directly.
It's applied there, tested on a real printer, and released, and you're credited in
that release's notes. The pull request is then closed with a link to the release.

Small, focused changes are easiest to take. For anything bigger, open an issue first
so we can agree on the approach.

## Building and testing

The UI needs Node 20.19 or newer:

```bash
cd web
npm ci
npm run typecheck
npm run build      # web/dist/inject.js; fails above the 200 KB gzipped budget
```

The component's unit tests run with Moonraker's own Python, so they need a Moonraker
install (a Klipper host, or a Moonraker checkout with its virtualenv):

```bash
dev/run-component-tests.sh
# elsewhere: MOONRAKER_PATH=~/moonraker MOONRAKER_PYTHON=~/moonraker-env/bin/python dev/run-component-tests.sh
```

## Ground rules

These keep the plugin safe to install on someone's printer:

- Never modify Mainsail or Fluidd. The plugin adds one script tag through nginx and
  does everything else inside it.
- The CommunityCAD token stays on the printer. The browser talks only to Moonraker.
- A print never starts without an explicit confirm from the user.
- Nothing is shared without a setting or a tap that says so. Shared slicer settings go
  through an allowlist.
- A plugin error must never affect Moonraker, the interface or a running print.
- Comments explain why, in plain words. Keep interface text short and plain.

Contributions are licensed under Apache-2.0, as the rest of the plugin.
