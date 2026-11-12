# Installing

## What you need

- A Klipper printer with **Moonraker** and **Mainsail** or **Fluidd**, set up the usual
  way (for example with [KIAUH](https://github.com/dw-0/kiauh)).
- SSH access to the printer's host, and a user that can use `sudo`.
- A CommunityCAD account (sign in with Google or GitHub at
  [communitycad.dev](https://communitycad.dev)).
- For slicing on the printer: a **64-bit** Raspberry Pi OS (OrcaSlicer has no 32-bit
  build), about 700 MB free, and 2 GB of memory or more. With 1 GB, only small models
  slice. A Raspberry Pi 4 or 5 is a good fit.

## Install

```bash
cd ~ && wget https://github.com/CommunityCad-dev/Hopper/releases/latest/download/hopper.zip
unzip hopper.zip -d hopper && cd hopper
scripts/install-all.sh
```

The installer checks your device first and shows the result before changing
anything. It then shows the use-at-your-own-risk notice and asks before it goes on.
`scripts/install-all.sh --check` runs only the check.

Use the release download rather than a `git clone`: the source has no built interface.

| Script | Installs |
|---|---|
| `scripts/install-all.sh` | Hopper and slicing on the printer. **Start here.** |
| `scripts/install.sh` | Hopper only: browse, send G-code made elsewhere, share |
| `scripts/install-orca.sh` | Slicing, added to an existing install |

## Link your account

Open your printer's page (Mainsail or Fluidd) and find **Hopper** in the menu.
Choose **Connect**: the plugin shows a short code. Approve it on communitycad.dev from
your phone or computer. Nothing is typed on the printer, and the link can be removed
from your CommunityCAD account at any time.

## Updates

The installer adds the plugin to Moonraker's update manager. New releases appear in
Mainsail or Fluidd's update panel next to Klipper and Moonraker, and update the same way.

## Uninstall

```bash
cd ~/hopper
scripts/uninstall.sh                # everything install.sh added
scripts/install-orca.sh --remove    # just the slicer
```

Your own files stay: `~/printer_data/models`, `~/printer_data/projects`, and
`materials.cfg` / `print_profiles.cfg` beside `printer.cfg`.
