# CommunityCAD for Klipper

Browse [CommunityCAD](https://communitycad.dev) models from inside Mainsail or Fluidd,
send them to your printer, and share the result back — from your phone, without a PC.

The plugin adds its own view to your printer interface. It does not fork or modify
Mainsail or Fluidd: an nginx `sub_filter` adds one `<script>` tag, and everything the
plugin does happens inside that script and a Moonraker component. Uninstalling returns
the interface to stock, byte for byte.

**Status: beta**, with invited testers. Things will change, and feedback is very welcome.

What you can do with it:

- **Browse and search** CommunityCAD models, with a "fits your printer" check against
  your build volume.
- **Send** a model or G-code to the printer, and start it after a confirm that checks the
  file was made for this printer and that the right material is loaded.
- **Slice on the printer** with OrcaSlicer, using your own material and print profiles,
  then print. No PC needed.
- **Share back**: after a print, share its print profile and a post with a photo, publicly
  or kept private.

Guides: [install](docs/guide/install.md) · [how it works](docs/guide/how-it-works.md) ·
[troubleshooting](docs/guide/troubleshooting.md) · [contributing](CONTRIBUTING.md)

## Install

On the printer's Raspberry Pi, over SSH, download the latest release and run the installer:

```bash
cd ~ && wget https://github.com/CommunityCad-dev/communitycad-klipper/releases/latest/download/communitycad-klipper.zip
unzip communitycad-klipper.zip && cd communitycad-klipper
scripts/install-all.sh
```

Use the release download, not a `git clone`: a checkout of the source has no built
interface (that's made at release time), and the installer's check says so.

That installs CommunityCAD **and** slicing on the printer (OrcaSlicer, run headless on the
Pi), so you can pick a model on your phone, slice it with your own profiles and print it,
with no PC. It checks your device first and changes nothing until you've seen the result:

```
CommunityCAD:
  ✓ nginx with sub_filter
  ✓ mainsail site: /etc/nginx/sites-available/mainsail
  ✓ Moonraker: 1 instance(s)
Slicing on the printer (OrcaSlicer 2.4.2):
  ✓ 64-bit OS (arm64)
  ✓ OrcaSlicer's libraries available from apt
  ✓ 7645 MB of memory
  ...
```

`scripts/install-all.sh --check` runs only the check. If your device can run CommunityCAD
but not the slicer, it says why and offers CommunityCAD on its own.

**What slicing on the printer needs:** 64-bit Raspberry Pi OS (OrcaSlicer has no 32-bit
build), about 700 MB free, and 2 GB of memory or more (1 GB slices small models only).
Tested on a Pi 4 with Debian 13 (trixie).

**The three ways to install**

| Script | Installs | Needs sudo for |
|---|---|---|
| `scripts/install-all.sh` | CommunityCAD and slicing on the printer, after a compatibility check. **Start here.** | nginx, and OrcaSlicer's libraries |
| `scripts/install.sh` | CommunityCAD only: browse, send G-code made elsewhere, share | nginx |
| `scripts/install-orca.sh` | Slicing on the printer, added to an existing install | OrcaSlicer's libraries |

`scripts/uninstall.sh` removes everything the first two add; `scripts/install-orca.sh --remove`
removes just the slicer.

## Use at your own risk

This plugin comes with no warranty (see [LICENSE](LICENSE), sections 7 and 8).

- Models and G-code on CommunityCAD are made by other people. CommunityCAD doesn't check
  them for safety, and a file made for another printer can damage yours.
- The checks the plugin shows (printer match, fit) are aids, not guarantees.
- You are responsible for your printer. Watch every print, especially the first layer.
- The plugin never flashes firmware, never edits `printer.cfg`, and sends no commands to
  your printer other than starting or queueing a file you chose.

Accounts on CommunityCAD are Google or GitHub sign-ins; there are no passwords. A printer is
linked by approving a short code from your phone or computer, so nothing is typed on the printer.

The installer shows this and asks before changing anything (`--accept` skips the question
for scripted installs). The plugin asks once more, per printer, before its first send.

**What install changes**, and `scripts/uninstall.sh` removes:

- an nginx include in your Mainsail or Fluidd site, plus two snippet files (backed up first);
- a `[communitycad]` section in `moonraker.conf`, and the component linked into Moonraker;
- files under `~/communitycad` (the UI, OrcaSlicer if installed) and
  `~/printer_data/communitycad` (settings, the printer's link token).

Your own files are kept on uninstall: `~/printer_data/models`, `~/printer_data/projects`,
and `materials.cfg` / `print_profiles.cfg` beside `printer.cfg`.

## Feedback

In the plugin, **More → About → Feedback**: pick Bug, Feature request,
Enhancement or General, and it opens a new issue here with your text filled in,
for you to check and send. You can also [open an issue](../../issues/new/choose)
directly.

## Layout

```
component/       Moonraker component: holds the token, talks to CommunityCAD, slices
web/             the injected UI (Preact + TypeScript + Vite)
nginx/           the sub_filter snippets
scripts/         install, uninstall, health check and release scripts
dev/             the component's unit tests and their fixtures
docs/guide/      install, how it works, troubleshooting
```

## Building the UI

Needs Node 20.19 or newer. Nothing is built on the printer at install time.

```bash
cd web
npm ci
npm run typecheck
npm run build      # writes web/dist/inject.js, fails if over the 200 KB gzipped budget
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how
they're handled and how to run the tests.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The licence covers this plugin only. CommunityCAD itself is a separate, closed-source
platform; using its API is governed by the CommunityCAD API terms.
