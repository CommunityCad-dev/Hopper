# Troubleshooting

**Check the install first.** On the printer:

```bash
~/communitycad-klipper/scripts/healthcheck.sh
```

It checks the nginx injection, the Moonraker component and that the served interface is
the current one, and says what to fix.

## CommunityCAD is missing from the menu

Reinstalling or repairing Mainsail or Fluidd (with KIAUH, for example) replaces the web
server's configuration and removes the plugin's script tag. Printing isn't affected. Run
the installer again:

```bash
cd ~/communitycad-klipper && scripts/install.sh
```

Then reload the page.

## "Can't reach CommunityCAD"

The printer couldn't reach communitycad.dev. Your printer works as normal. Check the
printer's internet connection; shares made while offline are kept on the printer and
sent when it's back.

## Slicing isn't offered

Slicing needs a 64-bit OS and enough memory. `scripts/install-all.sh --check` says what's
missing. It also doesn't run during a print: try again when the print finishes.

## The 3D view of the plate doesn't show

The browser has turned off 3D graphics (WebGL) for the page. Press **Try again**, or
reload the page. Slicing still works without the view.

## Logs

The plugin writes to Moonraker's log:

```bash
grep -i communitycad ~/printer_data/logs/moonraker.log | tail -50
```

Include those lines when you [open an issue](https://github.com/CommunityCad-dev/communitycad-klipper/issues/new/choose).
