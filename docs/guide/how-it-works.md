# How it works

```
Phone, tablet or PC browser
  └─ Mainsail or Fluidd page
       └─ <script src="/communitycad/inject.js">   (added by nginx)
            └─ the Hopper view, in its own Shadow DOM
                 │  same-origin calls only
                 ▼
Printer host: Moonraker
  └─ communitycad component  (/server/communitycad/*)
       │  holds the account link, reads printer info, downloads files, slices
       ▼
communitycad.dev API
```

**Mainsail and Fluidd are not modified.** nginx's `sub_filter` adds one script tag to
the page, and everything else happens inside that script. Uninstalling removes the tag
and the interface is back to stock.

**The browser talks only to the printer.** The Moonraker component makes every call to
CommunityCAD. The account link (a token) is kept on the printer, in
`~/printer_data/communitycad`, and never reaches the browser.

**The plugin can't break the printer.** Its errors are contained: Moonraker, the
interface and a running print carry on. It never flashes firmware, never edits
`printer.cfg`, and sends no commands to Klipper other than starting or queueing a file
you chose, after you confirm.

## Slicing on the printer

OrcaSlicer runs headless on the host: one slice at a time, at low priority, on two
cores, with a time limit. It doesn't run while the printer is printing. The printer's
own Klipper configuration describes the machine to the slicer (bed, limits, start
macro), and your material and print profiles live in `materials.cfg` and
`print_profiles.cfg` beside `printer.cfg`, where you can edit them by hand too.

Models you keep are in `~/printer_data/models`, and projects (Orca 3MF files) in
`~/printer_data/projects`, both visible in Mainsail's file manager.

## What is shared, and when

Nothing leaves the printer without a setting or a tap that says so.

- **Print profiles**: after a print of a CommunityCAD model, you can share the settings
  it printed with. Only settings on an allowlist are sent: no addresses, keys, file
  paths or custom G-code. The Share tab shows exactly what will be sent first.
- **Posts**: a photo you choose, and optionally a webcam snapshot or timelapse if you
  turned those on. Posts can be kept private until you publish them on CommunityCAD.
- **Private models** are never shared publicly.
- Your printer's name and kinematics are shared with a profile only if you allow it.

CommunityCAD itself is a separate service with its own terms; this plugin is the open
source part that runs on your printer.
