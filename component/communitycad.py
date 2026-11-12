# Hopper for Klipper — Moonraker component.
#
# The Pi-side half of the plugin. The injected browser UI talks only to this
# component; this component makes every CommunityCAD API call. So the token never
# reaches the browser, and CommunityCAD needs no CORS changes.
#
# Project rule: nothing here may stop Moonraker or a print. Handlers
# raise ServerError, which Moonraker turns into an HTTP error for the caller and
# nothing more; the background link poller catches everything and stops itself.
from __future__ import annotations

import ast
import asyncio
import base64
import hashlib
import json
import logging
import math
import os
import pathlib
import re
import shutil
import socket
import time
import urllib.parse
import uuid
import zipfile
from typing import TYPE_CHECKING, Any, Dict, Optional, Tuple

from moonraker.common import RequestType

if TYPE_CHECKING:
    from moonraker.confighelper import ConfigHelper
    from moonraker.common import WebRequest
    from moonraker.components.http_client import HttpClient
    from moonraker.components.klippy_apis import KlippyAPI

COMPONENT_VERSION = "0.1.0-dev"
CLIENT_NAME = "communitycad-klipper"
PLUGIN_REPO = "https://github.com/CommunityCad-dev/Hopper"   # the public repo: docs, releases, issues

# Production. Development points this at a local backend.
DEFAULT_API_BASE = "https://communitycad.dev/api/v1"

# Least privilege: browsing and sending need only these. Sharing needs
# prints:write and posts:write as well.
LINK_SCOPES = "catalog:read download"
# Sharing asks for these on first use, through the platform's scope
# upgrade: approved on /link like a first link, and the
# printer keeps its token and its identity.
SHARE_SCOPES = ("prints:write", "posts:write")
SHARING_NOT_LIVE = "CommunityCAD doesn't take shares from printers yet. Your print stays in this list for later."
# Outbox: shares and posts that couldn't reach CommunityCAD wait on the Pi and
# are retried with these gaps, then every 6 hours. A refusal (4xx) isn't retried:
# the user sees why, with Retry and Delete.
OUTBOX_BACKOFF_S = (60, 300, 900, 3600, 6 * 3600)
OUTBOX_TICK_S = 30
AUTO_SHARE_DELAY_S = 60               # "Share automatically": the undo window after a print
AUTO_POST_WAIT_S = 900                # how long an automatic post waits for the timelapse to render
SHARE_MODES = ("ask", "auto", "off")
SHARE_VISIBILITIES = ("public", "private")
# OrcaSlicer is held off during a print until slicing alongside one has been measured.
PRINTING_WAIT = "The printer is printing. OrcaSlicer waits until it's done, so the print isn't affected. Try again then."
PRIVATE_MODEL_PROFILE = ("{title} is private on CommunityCAD, and a shared print profile would be public, "
                         "so it isn't shared. You can still post about it privately.")
PRIVATE_PROFILES_LIVE = False         # until CommunityCAD keeps private profiles, a private share skips the profile
# Posts, as the platform takes them.
POST_IMAGES_MAX = 4
POST_IMAGE_MAX_BYTES = 5 << 20
POST_CAPTION_MAX = 500
POST_VIDEO_MAX_BYTES = 50 << 20
UPLOAD_CHUNK = 32 * 256 * 1024        # 8 MiB: GCS resumable chunks must be multiples of 256 KiB
TIMELAPSES_KEPT = 50
PRINTS_KEPT = 50                      # finished prints of CommunityCAD files remembered for sharing
NOTIFY_PRINT_FINISHED = "communitycad:print_finished"

# The link code expires server-side (currently 10 min). Stop polling a little past
# whatever the server told us, so a stuck poller can never run forever.
LINK_POLL_GRACE_S = 30.0

NOTIFY_LINKED = "communitycad:linked"

# RFC 8628 reports progress through 400s, so these are normal traffic during a link
# and are logged at debug. A ten-minute link attempt polls ~120 times; at warning
# level that would bury everything else in the user's moonraker.log.
EXPECTED_POLL_ERRORS = frozenset({"authorization_pending", "slow_down"})

# The API reports the oldest plugin it still supports on every /v1 response.
# Older than this and some actions will start failing.
MIN_VERSION_HEADER = "X-Min-Plugin-Version"

# Server-side hiccups worth one more try on a read. 429 is not here: it carries its
# own Retry-After and is reported to the user instead.
TRANSIENT_STATUSES = frozenset({500, 502, 503, 504})
# Moonraker's default is 5 s. While the Pi's WiFi is busy with a big download, a new
# connection to CommunityCAD can take longer than that, which isn't "unreachable".
API_CONNECT_TIMEOUT_S = 10.0
DOWNLOAD_CONNECT_TIMEOUT_S = 15.0
GET_RETRY_DELAYS_S = (0.3, 1.0)

# How often to check that the nginx injection is still in place. The thing it guards
# against -- KIAUH regenerating Mainsail's site file, or a hand edit -- happens rarely
# and never urgently, so this is deliberately slow.
INJECTION_CHECK_INTERVAL_S = 900
ANNOUNCEMENT_FEED = "communitycad"

# What can go to the printer as-is. Anything else is a model, not a print job, and
# the UI offers "download to this device" instead.
SENDABLE_EXTS = (".gcode", ".gco", ".g", ".gcode.3mf")
SLICED_3MF_EXT = ".gcode.3mf"
DEFAULT_SEND_FOLDER = "communitycad"

# A sliced 3MF is a zip someone else made, opened on the printer's own Pi, so its
# extraction is bounded on every axis a hostile or broken archive could abuse.
# Bambu Studio and OrcaSlicer store each plate as Metadata/plate_<n>.gcode.
PLATE_ENTRY = re.compile(r"^Metadata/plate_(\d{1,3})\.gcode$")
MAX_3MF_ENTRIES = 10_000
MAX_PLATE_BYTES = 1 << 30           # one plate's G-code
MAX_PLATES_BYTES = 2 << 30          # all plates together
MAX_COMPRESSION_RATIO = 200         # G-code deflates ~5-20x; far beyond is a zip bomb
DISK_HEADROOM_BYTES = 256 << 20     # never fill the disk the printer runs from

# States in which a new print cannot start, so it goes to Moonraker's job queue
# instead. Sending always works; only starting has to wait.
BUSY_PRINT_STATES = frozenset({"printing", "paused"})

# A negative X/Y minimum larger than this share of the travel is a bed-centred
# origin, not overtravel. Real overtravel is a few millimetres.
CENTRED_ORIGIN_FRACTION = 0.1

# What the plugin may read from the printer. Each is asked separately, and
# nothing is read until the answer is yes. Neither ever leaves the Pi.
PERMISSION_SETTINGS = "printer_settings"     # the parsed printer.cfg
PERMISSION_HISTORY = "print_history"         # Moonraker's job history
PERMISSIONS = (PERMISSION_SETTINGS, PERMISSION_HISTORY)

# Models on the printer: files the printer can't run yet, kept for slicing.
# Stored under generated ids, never under a name that came from the catalog.
MODEL_EXTS = (".stl", ".obj", ".3mf", ".step", ".stp")
MODELS_CAP_BYTES = 2 << 30
MODEL_ID = re.compile(r"^[0-9a-f]{12}$")   # the first model store's ids, only for migrating it
MODELS_ROOT = "models"                      # printer_data/models, a Moonraker root
PROJECTS_ROOT = "projects"
THUMBS_DIR = ".thumbs"                # project thumbnails, as Moonraker keeps G-code ones
THUMB_MAX_BYTES = 512 << 10
# Sliced plates wait here until Send or Print plate puts them in the G-code files,
# as in Orca (reviewer, 2026-10-02). Under the projects root, so Moonraker serves
# them to Preview, and hidden, so no file list shows them.
STAGED_DIR = ".sliced"
GCODE_THUMB_MAX = 256 << 10           # per G-code thumbnail, base64-decoded                  # printer_data/projects, Orca 3MF projects
PROJECT_PRINTS_KEPT = 20

# Slicing on the printer, with OrcaSlicer as a separate program. The
# controls are deliberately few: the printer is
# detected, never asked; everything else is one of these choices.
DEFAULT_ORCA = "~/communitycad/orca/current/run-orca"
# What a slice says when OrcaSlicer isn't there: how to add it, and what it needs.
ORCA_MISSING = ("Slicing on the printer isn't installed. On the Pi, in the plugin's folder, run "
                "scripts/install-orca.sh (64-bit Raspberry Pi OS; scripts/install-all.sh --check "
                "says whether this device can).")
SLICE_TIMEOUT_S = 15 * 60
SLICE_CPUS = "2,3"                    # leave cores 0-1 to Klipper and Moonraker
SLICE_QUALITY = {                     # tuned for a 0.4 mm nozzle
    "draft": "0.24mm Draft @Voron", "standard": "0.20mm Standard @Voron",
    "fine": "0.12mm Fine @Voron",
}
SLICE_INFILL = (10, 15, 20, 30, 40)    # the old fixed choices; still accepted
# Process settings the plugin lets a user change: Orca's own keys, values in
# Orca's own string format, and checked here so a modified browser can't send
# anything else. layer_height's ceiling is a share of the nozzle, checked per slice.
PROCESS_SETTINGS: Dict[str, Dict[str, Any]] = {
    "layer_height": {"type": "float", "min": 0.05, "nozzle_share": 0.75},
    "wall_loops": {"type": "int", "min": 1, "max": 20},
    "top_shell_layers": {"type": "int", "min": 0, "max": 50},
    "bottom_shell_layers": {"type": "int", "min": 0, "max": 50},
    "sparse_infill_density": {"type": "percent", "min": 0, "max": 100},
    "sparse_infill_pattern": {"type": "choice", "choices": (
        "crosshatch", "grid", "gyroid", "cubic", "adaptivecubic", "rectilinear", "line",
        "triangles", "honeycomb", "3dhoneycomb", "lightning", "concentric")},
    "enable_support": {"type": "bool"},
    "support_type": {"type": "choice", "choices": ("normal(auto)", "tree(auto)")},
    "support_threshold_angle": {"type": "int", "min": 0, "max": 90},
    "support_on_build_plate_only": {"type": "bool"},
    "brim_type": {"type": "choice", "choices": (
        "auto_brim", "outer_only", "inner_only", "outer_and_inner", "no_brim")},
    "brim_width": {"type": "float", "min": 0, "max": 50},
    "skirt_loops": {"type": "int", "min": 0, "max": 20},
    "skirt_distance": {"type": "float", "min": 0, "max": 60},
}
# The first-use notice: no warranty, catalog files unchecked, the printer is
# the user's responsibility. Accepted once per printer, stored on the Pi, asked
# again when this version changes. Sending, saving from the catalog and starting
# prints check it here, so a modified browser can't skip it.
NOTICE_VERSION = "2026-10-03"
NOTICE_REQUIRED = "Read and accept the notice in Hopper on this printer first."
# Orca's bed models and textures are tens of KB; anything far larger isn't one.
BED_FILE_MAX = 4 << 20
# Orca's built-in values for keys a preset leaves unset.
PROCESS_FALLBACK = {"brim_type": "auto_brim"}
SLICE_MACHINE_BASE = "fdm_klipper_common"   # Orca's generic Klipper printer
SLICE_MACHINE_NAME = "CommunityCAD printer"
# Orca's own exit codes worth a plain explanation (src/OrcaSlicer.cpp, cli_errors).
ORCA_ERRORS = {
    -17: "The slicing settings don't fit this printer.",
    -51: "The model doesn't fit on this printer's bed.",
}

# File-type filter. The platform's printable types; a sliced .gcode.3mf is
# "gcode" there. Until the API filters by type the Pi
# filters, paging through the catalog within the API's own limits and caching the
# unfiltered list briefly so changing the filter or showing more costs nothing.
FILE_TYPES = ("gcode", "3mf", "stl", "obj")
SCAN_PAGE = 50
SCAN_MAX_OFFSET = 1000
SCAN_CONCURRENCY = 4
SCAN_TTL_S = 120.0
SCAN_CACHE_KEYS = 8

# Moonraker's own auth already gates these endpoints, and the catalog is public,
# so read proxies work signed out.
CATALOG_SEARCH_PARAMS = (
    "q", "sort", "limit", "offset", "printable_only", "fit", "fit_x", "fit_y", "fit_z", "mine",
)

logger = logging.getLogger(__name__)


class CommunityCADError(Exception):
    """A failure worth showing the user, already phrased for them."""

    def __init__(
        self,
        message: str,
        code: int = 502,
        reason: str = "error",
        retry_after: float = 0.0,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        # Machine-readable. For OAuth failures this is the RFC 8628 `error` value
        # verbatim, so callers branch on that and never on the prose.
        self.reason = reason
        self.retry_after = retry_after


class CommunityCAD:
    def __init__(self, config: ConfigHelper) -> None:
        self.server = config.get_server()
        self.eventloop = self.server.get_event_loop()

        self.api_base: str = config.get("api_base", DEFAULT_API_BASE).rstrip("/")

        data_path = pathlib.Path(self.server.get_app_arg("data_path"))
        self.root = data_path.joinpath("communitycad")
        self.creds_file = self.root.joinpath("credentials.json")
        self.settings_file = self.root.joinpath("settings.json")

        self._creds: Dict[str, Any] = {}
        self._settings: Dict[str, Any] = {}
        self._link: Optional[Dict[str, Any]] = None
        self._link_task: Optional[asyncio.Task] = None
        self._min_version: Optional[str] = None
        self._injection_entry_id: Optional[str] = None
        self._injection_task: Optional[asyncio.Task] = None
        self._scan_cache: Dict[str, tuple] = {}
        self.orca_path = pathlib.Path(os.path.expanduser(config.get("orca_path", DEFAULT_ORCA)))
        self._slice: Optional[Dict[str, Any]] = None
        self._register_models_root()
        self._orca_busy = False
        self._register_root(PROJECTS_ROOT, self._projects_dir)
        # A slice that was never sent doesn't outlive the component that made it.
        shutil.rmtree(self._projects_dir.joinpath(STAGED_DIR), ignore_errors=True)
        self.server.register_event_handler("history:history_changed", self._on_history_changed)
        # Only remembered when the user turned on "Offer timelapse in posts".
        self.server.register_event_handler("timelapse:timelapse_event", self._on_timelapse_event)
        self._printer_cache: Optional[Dict[str, Any]] = None
        self.server.register_event_handler("server:klippy_ready", self._on_klippy_ready)
        self._slice_proc: Optional[asyncio.subprocess.Process] = None
        # Repairs an install whose directory the installer created first.
        if self.root.exists():
            self._ensure_root()

        self.server.register_notification(NOTIFY_LINKED, "communitycad_linked")

        reg = self.server.register_endpoint
        reg("/server/communitycad/status", RequestType.GET, self._handle_status)
        reg("/server/communitycad/link/start", RequestType.POST, self._handle_link_start)
        reg("/server/communitycad/link/cancel", RequestType.POST, self._handle_link_cancel)
        reg("/server/communitycad/unlink", RequestType.POST, self._handle_unlink)
        reg("/server/communitycad/rename", RequestType.POST, self._handle_rename)
        reg("/server/communitycad/search", RequestType.GET, self._handle_search)
        reg("/server/communitycad/model", RequestType.GET, self._handle_model)
        reg("/server/communitycad/send", RequestType.POST, self._handle_send)
        reg("/server/communitycad/download-url", RequestType.POST, self._handle_download_url)
        reg("/server/communitycad/save-model", RequestType.POST, self._handle_save_model)
        reg("/server/communitycad/models", RequestType.GET, self._handle_models)
        reg("/server/communitycad/models/delete", RequestType.POST, self._handle_models_delete)
        reg("/server/communitycad/slice", RequestType.GET | RequestType.POST, self._handle_slice)
        reg("/server/communitycad/projects", RequestType.GET, self._handle_projects)
        reg("/server/communitycad/match", RequestType.GET, self._handle_match)
        reg("/server/communitycad/projects/create", RequestType.POST, self._handle_project_create)
        reg("/server/communitycad/projects/update", RequestType.POST, self._handle_project_update)
        reg("/server/communitycad/projects/delete", RequestType.POST, self._handle_project_delete)
        reg("/server/communitycad/projects/place", RequestType.POST, self._handle_project_place)
        reg("/server/communitycad/projects/thumbnail", RequestType.POST, self._handle_project_thumbnail)
        reg("/server/communitycad/slice/cancel", RequestType.POST, self._handle_slice_cancel)
        reg("/server/communitycad/slice/send", RequestType.POST, self._handle_slice_send)
        reg("/server/communitycad/permissions", RequestType.GET | RequestType.POST, self._handle_permissions)
        reg("/server/communitycad/printer", RequestType.GET, self._handle_printer)
        reg("/server/communitycad/materials", RequestType.GET, self._handle_materials)
        reg("/server/communitycad/process", RequestType.GET, self._handle_process)
        reg("/server/communitycad/notice", RequestType.GET | RequestType.POST, self._handle_notice)
        reg("/server/communitycad/scopes/upgrade", RequestType.POST, self._handle_scope_upgrade)
        reg("/server/communitycad/share/prints", RequestType.GET, self._handle_share_prints)
        reg("/server/communitycad/share/preview", RequestType.GET, self._handle_share_preview)
        reg("/server/communitycad/share/profile", RequestType.POST, self._handle_share_profile)
        reg("/server/communitycad/share/dismiss", RequestType.POST, self._handle_share_dismiss)
        reg("/server/communitycad/share/auto-cancel", RequestType.POST, self._handle_auto_cancel)
        reg("/server/communitycad/transfers", RequestType.GET, self._handle_transfers)
        reg("/server/communitycad/projects/markers", RequestType.GET | RequestType.POST, self._handle_project_markers)
        reg("/server/communitycad/outbox", RequestType.GET | RequestType.POST, self._handle_outbox)
        reg("/server/communitycad/webcams", RequestType.GET, self._handle_webcams)
        reg("/server/communitycad/webcam/snapshot", RequestType.GET, self._handle_webcam_snapshot)
        reg("/server/communitycad/posts/options", RequestType.GET, self._handle_post_options)
        reg("/server/communitycad/posts/create", RequestType.POST, self._handle_post_create)
        reg("/server/communitycad/profiles", RequestType.GET, self._handle_profiles)
        reg("/server/communitycad/profiles/save", RequestType.POST, self._handle_profile_save)
        reg("/server/communitycad/profiles/delete", RequestType.POST, self._handle_profile_delete)
        reg("/server/communitycad/profiles/hide", RequestType.POST, self._handle_profile_hide)
        reg("/server/communitycad/profiles/detail", RequestType.GET, self._handle_profile_detail)
        reg("/server/communitycad/orca/import", RequestType.POST, self._handle_orca_import)
        reg("/server/communitycad/orca/export", RequestType.GET, self._handle_orca_export)
        reg("/server/communitycad/bed", RequestType.GET, self._handle_bed)
        reg("/server/communitycad/materials/detail", RequestType.GET, self._handle_material_detail)
        reg("/server/communitycad/materials/save", RequestType.POST, self._handle_material_save)
        reg("/server/communitycad/materials/delete", RequestType.POST, self._handle_material_delete)
        reg("/server/communitycad/materials/import", RequestType.POST, self._handle_material_import)
        reg("/server/communitycad/materials/presets", RequestType.GET, self._handle_material_presets)
        reg("/server/communitycad/library", RequestType.GET, self._handle_library)
        reg("/server/communitycad/print", RequestType.POST, self._handle_print)
        reg("/server/communitycad/download-check", RequestType.GET, self._handle_download_check)
        reg(
            "/server/communitycad/settings",
            RequestType.GET | RequestType.POST,
            self._handle_settings,
        )

    async def component_init(self) -> None:
        self._load_state()
        self._injection_task = self.eventloop.create_task(self._watch_injection())
        self._outbox_task = self.eventloop.create_task(self._outbox_loop())
        logger.info(
            "[communitycad] %s ready, api_base=%s, linked=%s",
            COMPONENT_VERSION, self.api_base, bool(self._token),
        )

    # ------------------------------------------------------- injection health

    def _injection_healthy(self) -> Optional[bool]:
        """Is our script still being injected into the host interface?

        None means "cannot tell" -- no install state, or nginx's config is not
        readable -- and callers must stay silent rather than guess. A false alarm
        about the plugin being broken is worse than no alarm.
        """
        state = self._read_json(self.root.joinpath("install-state.json"))
        site = state.get("nginx_site")
        marker = state.get("marker")
        if not site or not marker:
            return None
        try:
            with open(site, "r", encoding="utf-8", errors="replace") as fh:
                return marker in fh.read()
        except OSError:
            return None

    async def _watch_injection(self) -> None:
        """Tell the user when the plugin is installed but no longer injected.

        This is the one failure our own UI cannot report, because our own UI is what
        has gone missing: nginx's site file was regenerated (KIAUH's reinstall or
        repair does this) and took our include with it. Moonraker's announcements are
        rendered by Mainsail itself, so they still reach the user.
        """
        try:
            while True:
                await asyncio.sleep(INJECTION_CHECK_INTERVAL_S)
                healthy = self._injection_healthy()
                if healthy is None:
                    continue
                if not healthy and self._injection_entry_id is None:
                    self._announce_injection_lost()
                elif healthy and self._injection_entry_id is not None:
                    self._withdraw_injection_notice()
        except asyncio.CancelledError:
            raise
        except Exception:
            # A watchdog that takes the component down would be worse than the
            # problem it watches for.
            logger.exception("[communitycad] injection watcher stopped")

    def _announcements(self) -> Any:
        return self.server.lookup_component("announcements", None)

    def _announce_injection_lost(self) -> None:
        announcements = self._announcements()
        if announcements is None:
            logger.warning("[communitycad] not injected into the interface any more")
            return
        try:
            entry = announcements.add_internal_announcement(
                "CommunityCAD is not showing in your interface",
                "The plugin is installed, but its entry was removed from the web "
                "server's configuration -- reinstalling or repairing Mainsail does "
                "this. Printing is unaffected. Run the plugin's install.sh again to "
                "restore it.",
                PLUGIN_REPO,
                "high",
                ANNOUNCEMENT_FEED,
            )
            self._injection_entry_id = entry.get("entry_id")
            logger.warning("[communitycad] injection missing; announced to the user")
        except Exception:
            logger.exception("[communitycad] could not raise the announcement")

    def _withdraw_injection_notice(self) -> None:
        """Take the notice back once the injection is restored.

        Reaches into the announcements component's entry manager, which is not a
        stable API, so a version that does not expose it simply keeps the notice --
        the user can dismiss it, and a stale notice is a smaller problem than a
        crash.
        """
        entry_id, self._injection_entry_id = self._injection_entry_id, None
        announcements = self._announcements()
        manager = getattr(announcements, "entry_mgr", None)
        remove = getattr(manager, "remove_entry", None)
        if entry_id is None or remove is None:
            return
        try:
            result = remove(entry_id)
            # remove_entry returns an Awaitable, which may already be a scheduled
            # Task. create_task() rejects those -- it wants a coroutine -- so only
            # schedule what is not running yet.
            if asyncio.iscoroutine(result):
                self.eventloop.create_task(result)
            logger.info("[communitycad] injection restored; notice withdrawn")
        except Exception:
            logger.exception("[communitycad] could not withdraw the notice")

    # ---------------------------------------------------------------- storage

    @property
    def _token(self) -> Optional[str]:
        return self._creds.get("access_token")

    def _load_state(self) -> None:
        """Read what is on disk. Corrupt files are logged and ignored rather than
        raised: a bad settings file must not stop the component from loading."""
        self._creds = self._read_json(self.creds_file)
        self._settings = self._read_json(self.settings_file)

    def _read_json(self, path: pathlib.Path) -> Dict[str, Any]:
        try:
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except Exception:
            logger.exception("[communitycad] ignoring unreadable %s", path.name)
            return {}

    def _ensure_root(self) -> None:
        """Our directory exists and is owner-only.

        mkdir's mode applies only when it creates the directory. The installer
        creates it first, with the umask's 0775, to write install-state.json, so the
        mode has to be set rather than assumed. A failure here is logged, not
        raised: it must never stop Moonraker loading.
        """
        try:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            if self.root.stat().st_mode & 0o777 != 0o700:
                os.chmod(self.root, 0o700)
        except OSError:
            logger.exception("[communitycad] could not make %s owner-only", self.root)

    def _write_json(self, path: pathlib.Path, data: Dict[str, Any], mode: int) -> None:
        """Atomic write: temp file in the same directory, then rename. A power cut
        mid-write leaves the previous file intact rather than a truncated token."""
        self._ensure_root()
        tmp = path.with_suffix(path.suffix + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
                fh.flush()
                os.fsync(fh.fileno())
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
        os.replace(tmp, path)
        os.chmod(path, mode)

    def _save_credentials(self) -> None:
        # 0600: the token is bearer credentials for the user's whole account.
        self._write_json(self.creds_file, self._creds, 0o600)

    def _save_settings(self) -> None:
        self._write_json(self.settings_file, self._settings, 0o644)

    def _clear_credentials(self) -> None:
        self._creds = {}
        self.creds_file.unlink(missing_ok=True)

    # ----------------------------------------------------------- printer info

    def _default_printer_name(self) -> str:
        configured = self._settings.get("printer_name")
        if configured:
            return str(configured)
        try:
            return socket.gethostname() or "Klipper printer"
        except Exception:
            return "Klipper printer"

    # --------------------------------------------- reading the printer

    def _permission(self, key: str) -> Optional[bool]:
        """True or False once the user has answered; None while they haven't."""
        value = (self._settings.get("permissions") or {}).get(key)
        return value if isinstance(value, bool) else None

    def _on_klippy_ready(self) -> None:
        # The config may have changed with this restart: read it again on next use.
        self._printer_cache = None
        if self.orca_path.is_file():
            # Orca's presets for this printer take a couple of seconds to read on a
            # Pi 4: read them now, at low cost, rather than when someone is waiting.
            self.server.get_event_loop().create_task(self._warm_profiles())

    async def _warm_profiles(self) -> None:
        try:
            await self._default_profiles()
        except Exception:
            logger.debug("[communitycad] couldn't read Orca's presets ahead of time", exc_info=True)

    async def _printer_config(self) -> Dict[str, Any]:
        """The printer's own settings: read once per Klipper start, straight from the
        parsed printer.cfg, and only after the user allowed it.

        Returns {"toolhead": {...}, "settings": {...}}, or {} when not allowed or
        Klippy isn't ready. Everything that needs printer settings goes through here,
        so there are no per-request queries to Klipper.
        """
        if self._permission(PERMISSION_SETTINGS) is not True:
            return {}
        if self._printer_cache is None:
            kapis: KlippyAPI = self.server.lookup_component("klippy_apis")
            result = await kapis.query_objects(
                {"toolhead": ["axis_minimum", "axis_maximum"], "configfile": ["settings"]},
                default={},
            )
            if not isinstance(result, dict):
                return {}
            settings = (result.get("configfile") or {}).get("settings") or {}
            if not settings:
                return {}          # Klippy not ready yet: don't cache an empty answer
            self._printer_cache = {"toolhead": dict(result.get("toolhead") or {}),
                                   "settings": settings}
        return self._printer_cache

    async def _printer_info(self) -> Optional[Dict[str, Any]]:
        """This printer as the slicer sees it, from printer.cfg; None without
        permission or before Klipper is ready."""
        cfg = await self._printer_config()
        if not cfg:
            return None
        header = ""
        try:
            config_dir = self.server.lookup_component("file_manager").get_directory("config")
            with open(os.path.join(config_dir, "printer.cfg"), "r", errors="replace") as fh:
                header = "".join(line for _, line in zip(range(80), fh))
        except Exception:
            pass
        return printer_from_config(cfg["settings"], header)

    async def _handle_printer(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        allowed = self._permission(PERMISSION_SETTINGS) is True
        return {"allowed": allowed, "printer": await self._printer_info() if allowed else None}

    async def _query_toolhead(self) -> Dict[str, Any]:
        """Axis limits from the toolhead, plus kinematics from the parsed config.

        Klipper's toolhead status has no kinematics field; it only exists in
        configfile.settings.
        """
        cfg = await self._printer_config()
        if not cfg:
            return {}
        toolhead = dict(cfg["toolhead"])
        toolhead["kinematics"] = _config_kinematics({"configfile": {"settings": cfg["settings"]}})
        return toolhead

    async def _detect_build_volume(self) -> Optional[Dict[str, Any]]:
        """Build volume from Klipper's axis limits, or None when unavailable.

        None is a normal state, not an error: Klippy may be starting, in an error
        state, or the printer may simply not be configured yet. The UI shows every
        model in that case rather than filtering on a guess.
        """
        try:
            toolhead = await self._query_toolhead()
            axis_min = toolhead.get("axis_minimum")
            axis_max = toolhead.get("axis_maximum")
            if not axis_min or not axis_max:
                return None
            dims = [
                _printable_span(float(axis_min[i]), float(axis_max[i]), is_z=(i == 2))
                for i in range(3)
            ]
            if any(d <= 0 for d in dims):
                return None
            kinematics = str(toolhead.get("kinematics") or "")
            return {
                "x": dims[0], "y": dims[1], "z": dims[2],
                "kinematics": kinematics,
                # Delta beds are circular, so a rectangular fit test would be wrong.
                # Report the size, but tell the UI not to filter on it.
                "fit_filtering": not kinematics.startswith("delta"),
                "source": "detected",
            }
        except Exception:
            logger.exception("[communitycad] build volume detection failed")
            return None

    async def _effective_build_volume(self) -> Optional[Dict[str, Any]]:
        """The user's override if set, else what Klipper reports.

        The override exists because axis limits can include overtravel, so the
        detected figure is often a little larger than the usable bed.
        """
        override = self._settings.get("build_volume")
        if isinstance(override, dict) and all(k in override for k in ("x", "y", "z")):
            try:
                return {
                    "x": float(override["x"]),
                    "y": float(override["y"]),
                    "z": float(override["z"]),
                    "kinematics": str(override.get("kinematics") or ""),
                    "fit_filtering": bool(override.get("fit_filtering", True)),
                    "source": "override",
                }
            except (TypeError, ValueError):
                logger.warning("[communitycad] ignoring malformed build_volume override")
        return await self._detect_build_volume()

    # -------------------------------------------------------------- api calls

    def _headers(self, authed: bool) -> Dict[str, str]:
        headers = {
            "Accept": "application/json",
            "User-Agent": f"{CLIENT_NAME}/{COMPONENT_VERSION}",
        }
        if authed and self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    async def _api(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        authed: bool = False,
        timeout: float = 15.0,
        raw: Optional[bytes] = None,
        content_type: Optional[str] = None,
    ) -> Any:
        """One CommunityCAD call, with the plugin's failure rules. `raw`
        sends bytes as they are (a multipart post) instead of JSON."""
        client: HttpClient = self.server.lookup_component("http_client")
        url = f"{self.api_base}{path}"
        # Reads are retried on a transient failure: the API answered about 1 search in
        # 20 with a 500 on 2026-09-30, and the file-type filter makes ~13 reads per
        # scan. Writes never are -- issuing a download link spends a download.
        delays = GET_RETRY_DELAYS_S if method == "GET" else ()
        attempt = 0
        while True:
            try:
                headers = self._headers(authed)
                if raw is not None:
                    headers = {**headers, "Content-Type": content_type or "application/octet-stream"}
                resp = await client.request(
                    method, url, body=raw if raw is not None else body, headers=headers,
                    request_timeout=timeout, connect_timeout=API_CONNECT_TIMEOUT_S, enable_cache=False,
                )
            except Exception as exc:
                resp, failed = None, exc
            else:
                # Moonraker's client doesn't raise when the connection itself fails
                # (refused, timed out, no DNS): it returns a bodiless 500 carrying the
                # exception. A real HTTP error has its own status code; this doesn't (or
                # is Tornado's 599). Treat it as unreachable, not as a server error.
                transport = getattr(resp, "error", None)
                failed = transport if transport is not None and getattr(transport, "code", 599) == 599 else None
            if failed is not None:
                if attempt < len(delays):
                    await asyncio.sleep(delays[attempt])
                    attempt += 1
                    continue
                logger.warning("[communitycad] %s %s failed: %s", method, path, failed)
                raise CommunityCADError(
                    "Can't reach CommunityCAD. Your printer works as normal.",
                    code=503, reason="unreachable",
                ) from failed
            if resp.status_code in TRANSIENT_STATUSES and attempt < len(delays):
                logger.info("[communitycad] %s %s -> %s, retrying",
                            method, path, resp.status_code)
                await asyncio.sleep(delays[attempt])
                attempt += 1
                continue
            break

        status = resp.status_code
        advertised = resp.headers.get(MIN_VERSION_HEADER)
        if advertised:
            self._min_version = str(advertised)

        # A 401 on an authenticated call means the token was revoked on the site.
        # Drop it locally so the UI can offer Reconnect. Scope problems are 403 by
        # design, precisely so they are not mistaken for this.
        if status == 401 and authed:
            logger.warning("[communitycad] token rejected, clearing local credentials")
            self._clear_credentials()
            raise CommunityCADError(
                "This printer was disconnected from your account.",
                code=401, reason="unlinked",
            )

        try:
            payload = resp.json()
        except Exception:
            payload = None

        if status == 429:
            retry_after = 0.0
            try:
                retry_after = float(resp.headers.get("Retry-After", 0) or 0)
            except (TypeError, ValueError):
                pass
            wait = f" Try again in {plain_wait(retry_after)}." if retry_after > 0 else ""
            raise CommunityCADError(
                "CommunityCAD is rate limiting this printer." + (wait or " Try again shortly."),
                code=429, reason="rate_limited", retry_after=retry_after,
            )

        if status >= 400:
            reason = "error"
            message = ""
            hint = 0.0
            if isinstance(payload, dict):
                # OAuth/RFC 8628 bodies: {"error", "error_description", "interval"}.
                # FastAPI's own errors use "detail".
                if payload.get("error"):
                    reason = str(payload["error"])
                    message = str(payload.get("error_description") or reason)
                    try:
                        hint = float(payload.get("interval") or 0)
                    except (TypeError, ValueError):
                        hint = 0.0
                elif payload.get("detail"):
                    message = str(payload["detail"])
            level = logging.DEBUG if reason in EXPECTED_POLL_ERRORS else logging.WARNING
            logger.log(level, "[communitycad] %s %s -> %s %s", method, path, status, reason)
            raise CommunityCADError(
                message or f"CommunityCAD returned {status}.",
                code=status, reason=reason, retry_after=hint,
            )

        return payload

    # ------------------------------------------------------------- link flow

    async def _poll_for_token(self, device_code: str, interval: float, deadline: float) -> None:
        """Background half of the device-code flow (RFC 8628).

        Catches everything: this runs detached, so an escaping exception would be an
        unhandled task error in Moonraker's loop.
        """
        try:
            while True:
                if time.monotonic() > deadline:
                    self._fail_link("The code expired. Start again.")
                    return
                await asyncio.sleep(interval)
                try:
                    payload = await self._api(
                        "POST", "/auth/device/token", body={"device_code": device_code},
                    )
                except CommunityCADError as exc:
                    # RFC 8628 signals progress through errors, so these are normal.
                    if exc.reason == "authorization_pending":
                        continue
                    if exc.reason == "slow_down":
                        # The server may name the new interval; otherwise back off.
                        interval = exc.retry_after if exc.retry_after > interval else interval + 5.0
                        continue
                    if exc.reason == "access_denied":
                        self._fail_link("The request was denied on CommunityCAD.")
                        return
                    if exc.reason in ("expired_token", "invalid_grant"):
                        self._fail_link("The code expired. Start again.")
                        return
                    if exc.reason == "unreachable":
                        continue  # transient; keep trying until the deadline
                    self._fail_link(exc.message)
                    return

                if isinstance(payload, dict) and payload.get("upgraded"):
                    self._complete_upgrade(payload)
                    return
                if isinstance(payload, dict) and payload.get("access_token"):
                    self._complete_link(payload)
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[communitycad] link poller crashed")
            self._fail_link("Linking failed. Try again.")

    def _complete_link(self, payload: Dict[str, Any]) -> None:
        self._creds = {
            "access_token": payload["access_token"],
            "token_id": payload.get("token_id"),
            "username": payload.get("username"),
            "scope": payload.get("scope"),
            "linked_at": time.time(),
        }
        self._save_credentials()
        self._link = None
        self._link_task = None
        logger.info("[communitycad] linked as %s", self._creds.get("username"))
        self.server.send_event(NOTIFY_LINKED, {
            "linked": True,
            "username": self._creds.get("username"),
        })

    def _complete_upgrade(self, payload: Dict[str, Any]) -> None:
        """A scope upgrade was approved: same token, more scopes."""
        self._creds["scope"] = payload.get("scope") or self._creds.get("scope")
        self._save_credentials()
        self._link = None
        self._link_task = None
        logger.info("[communitycad] permissions now: %s", self._creds.get("scope"))
        self.server.send_event(NOTIFY_LINKED, {"linked": True, "username": self._creds.get("username"),
                                               "upgraded": True})

    async def _sharing_api(self, method: str, path: str, body: Dict[str, Any]) -> Any:
        """A sharing call. If CommunityCAD doesn't offer the route yet, it 404s:
        say that plainly instead of passing the site's "Not Found" on."""
        try:
            return await self._api(method, path, body=body, authed=True)
        except CommunityCADError as exc:
            if exc.code == 404:
                raise self.server.error(SHARING_NOT_LIVE, 503) from exc
            raise self.server.error(exc.message, exc.code) from exc

    def _scopes(self) -> list:
        return str(self._creds.get("scope") or "").split()

    def _can_share(self) -> bool:
        return bool(self._token) and all(s in self._scopes() for s in SHARE_SCOPES)

    async def _handle_scope_upgrade(self, web_request: WebRequest) -> Dict[str, Any]:
        """Ask the account owner to add the sharing permissions to this printer's
        token. Already held: done. Otherwise the user approves a code on
        /link, exactly like the first link, and the printer keeps its identity."""
        del web_request
        if not self._token:
            raise self.server.error("Connect this printer to CommunityCAD first.", 409)
        self._cancel_link_task()
        payload = await self._sharing_api("POST", "/auth/tokens/current/scopes", {"scope": " ".join(SHARE_SCOPES)})
        self._creds["scope"] = payload.get("scope") or self._creds.get("scope")
        self._save_credentials()
        if payload.get("status") == "granted" or not payload.get("device_code"):
            return {"status": "granted", "scope": self._scopes(), "can_share": self._can_share()}
        interval = float(payload.get("interval") or 5)
        expires_in = float(payload.get("expires_in") or 600)
        self._link = {
            "pending": True, "error": None, "upgrade": True,
            "added": payload.get("added_scopes") or list(SHARE_SCOPES),
            "user_code": payload["user_code"],
            "verification_uri": payload["verification_uri"],
            "verification_uri_complete": payload["verification_uri_complete"],
            "expires_at": time.time() + expires_in,
        }
        deadline = time.monotonic() + expires_in + LINK_POLL_GRACE_S
        self._link_task = self.eventloop.create_task(
            self._poll_for_token(payload["device_code"], interval, deadline))
        return {"status": "approval_required", "added": self._link["added"],
                "user_code": self._link["user_code"], "verification_uri": self._link["verification_uri"],
                "verification_uri_complete": self._link["verification_uri_complete"],
                "expires_in": int(expires_in)}

    def _fail_link(self, message: str) -> None:
        if self._link is not None:
            self._link["error"] = message
            self._link["pending"] = False
        self._link_task = None
        logger.info("[communitycad] link failed: %s", message)
        self.server.send_event(NOTIFY_LINKED, {"linked": False, "error": message})

    def _cancel_link_task(self) -> None:
        if self._link_task is not None and not self._link_task.done():
            self._link_task.cancel()
        self._link_task = None

    async def _handle_download_check(self, web_request: WebRequest) -> Dict[str, Any]:
        """What sending this would cost, without issuing anything.

        The user should never be surprised by a download being spent, so the UI asks
        before offering to send.
        """
        if not self._token:
            return {"linked": False}
        args = web_request.get_args()
        model_id = int(args["model_id"])
        query = ""
        if args.get("file_id") is not None:
            query = f"?file_id={int(args['file_id'])}"
        result = await self._guard(
            self._api("GET", f"/catalog/models/{model_id}/download-check{query}", authed=True)
        )
        if isinstance(result, dict):
            result["linked"] = True
        return result

    # -------------------------------------------------- printer match check

    async def _printer_profile(self) -> Dict[str, Any]:
        """What we know about this printer, for comparing against a G-code file.

        Every field is optional. Klippy may be down, or the printer unconfigured, and
        a check we cannot make must not become a warning -- see _match_report.
        """
        profile: Dict[str, Any] = {"nozzle_diameter": None, "kinematics": None}
        try:
            cfg = await self._printer_config()
            settings = cfg.get("settings") or {}
            result = {"configfile": {"settings": settings}}
            extruder = settings.get("extruder") or {}
            nozzle = extruder.get("nozzle_diameter")
            if nozzle:
                profile["nozzle_diameter"] = float(nozzle)
            profile["kinematics"] = _config_kinematics(result) or None
        except Exception:
            logger.debug("[communitycad] could not read the printer profile", exc_info=True)
        return profile

    async def _match_report(self, filename: str) -> Dict[str, Any]:
        """Compare a stored G-code file against this printer.

        Pre-sliced G-code only works on the printer it was sliced for: a mismatched
        file can drive the toolhead into the bed or melt the wrong filament. So this
        reports per check, and says plainly which checks it could not make rather
        than implying everything is fine.
        """
        checks: list = []

        def note(name: str, status: str, detail: str) -> None:
            checks.append({"check": name, "status": status, "detail": detail})

        metadata: Dict[str, Any] = {}
        try:
            file_manager = self.server.lookup_component("file_manager")
            storage = file_manager.get_metadata_storage()
            metadata = storage.get(filename, {}) or {}
        except Exception:
            logger.debug("[communitycad] no metadata for %s", filename, exc_info=True)

        if not metadata:
            note("metadata", "unknown",
                 "No slicer information in this file, so nothing could be checked.")
            return {"ok": True, "confident": False, "checks": checks, "filename": filename}

        profile = await self._printer_profile()
        volume = await self._effective_build_volume()

        # Height against the build volume: the check that prevents a crash.
        height = metadata.get("object_height")
        if height is None:
            note("height", "unknown", "The file does not state how tall the print is.")
        elif volume is None:
            note("height", "unknown",
                 f"The print is {float(height):.0f} mm tall, but this printer's build "
                 "volume is unknown.")
        elif float(height) > float(volume["z"]):
            note("height", "warn",
                 f"The print is {float(height):.0f} mm tall, taller than this "
                 f"printer's {float(volume['z']):.0f} mm.")
        else:
            note("height", "ok",
                 f"{float(height):.0f} mm tall, fits the {float(volume['z']):.0f} mm height.")

        # Nozzle: a file sliced for 0.8 on a 0.4 head under-extrudes badly.
        gcode_nozzle = metadata.get("nozzle_diameter")
        printer_nozzle = profile.get("nozzle_diameter")
        if gcode_nozzle is None:
            note("nozzle", "unknown", "The file does not state a nozzle size.")
        elif printer_nozzle is None:
            note("nozzle", "unknown",
                 f"Sliced for a {gcode_nozzle} mm nozzle; this printer's nozzle size "
                 "is unknown.")
        elif abs(float(gcode_nozzle) - float(printer_nozzle)) > 0.01:
            note("nozzle", "warn",
                 f"Sliced for a {gcode_nozzle} mm nozzle, but this printer has "
                 f"{printer_nozzle} mm.")
        else:
            note("nozzle", "ok", f"{gcode_nozzle} mm nozzle matches.")

        # What the file says it was sliced for: printer, bed, firmware.
        try:
            gpath = pathlib.Path(self.server.lookup_component("file_manager").get_directory("gcodes")).joinpath(filename)
            header = await self.server.get_event_loop().run_in_thread(read_gcode_header, gpath)
        except Exception:
            header = {}
        printer = await self._printer_info()
        name = ((printer or {}).get("identity") or {}).get("name")
        for check, status, detail in header_checks(header, name, volume):
            note(check, status, detail)

        slicer = metadata.get("slicer")
        if slicer:
            note("slicer", "ok", f"Sliced with {slicer} {metadata.get('slicer_version') or ''}".strip())

        warned = [c for c in checks if c["status"] == "warn"]
        unknown = [c for c in checks if c["status"] == "unknown"]
        materials = gcode_materials(header)
        return {
            # What the file was sliced for: the confirm asks for it to be loaded.
            "materials": materials,
            "ok": not warned,
            # False when something could not be checked, so the UI can say "we could
            # not verify this" instead of "this is fine".
            "confident": not unknown,
            "checks": checks,
            "filename": filename,
        }

    def _notice_accepted(self) -> bool:
        accepted = self._settings.get("notice") or {}
        return isinstance(accepted, dict) and accepted.get("version") == NOTICE_VERSION

    def _require_notice(self) -> None:
        if not self._notice_accepted():
            raise self.server.error(NOTICE_REQUIRED, 403)

    async def _handle_notice(self, web_request: WebRequest) -> Dict[str, Any]:
        """Accept the first-use notice for this printer: the version shown, and
        when. A stale version (the page was open across an update) is refused."""
        if web_request.get_request_type() == RequestType.POST:
            if web_request.get_args().get("withdraw"):
                # Show it again: the next send or print waits for a new accept.
                self._settings.pop("notice", None)
                self._save_settings()
                return {"version": NOTICE_VERSION, "accepted": False, "at": None}
            if str(web_request.get_args().get("version") or "") != NOTICE_VERSION:
                raise self.server.error("The notice changed since this page loaded. Reload and read it again.", 409)
            self._settings["notice"] = {"version": NOTICE_VERSION, "at": time.time()}
            self._save_settings()
        return {"version": NOTICE_VERSION, "accepted": self._notice_accepted(),
                "at": (self._settings.get("notice") or {}).get("at")}

    async def _handle_print(self, web_request: WebRequest) -> Dict[str, Any]:
        """Start a print, or queue it if the printer is busy.

        `confirm` is required and must be true. A print starting because a request
        was malformed is the single worst thing this plugin could do, so the caller
        has to say so explicitly -- there is no default.
        """
        self._require_notice()
        filename = web_request.get_str("filename", "").strip().lstrip("/")
        if not filename:
            raise self.server.error("Which file?", 400)
        if not web_request.get_boolean("confirm", False):
            raise self.server.error(
                "Starting a print needs an explicit confirmation.", 400
            )

        state: Optional[str] = None
        try:
            kapis: KlippyAPI = self.server.lookup_component("klippy_apis")
            result = await kapis.query_objects({"print_stats": None}, default={})
            state = str((result.get("print_stats") or {}).get("state") or "") or None
        except Exception:
            logger.debug("[communitycad] could not read the print state", exc_info=True)

        if state is None:
            # Klippy is down, halted, or the printer is unconfigured. Say that, rather
            # than trying anyway and passing its internal error back to the user.
            raise self.server.error(
                "The printer isn't ready, so nothing was started. Your file is saved "
                "in G-code files and you can print it from there once it is.",
                409,
            )

        if state in BUSY_PRINT_STATES:
            # Busy: queue it rather than refuse, which is what the user meant.
            try:
                job_queue = self.server.lookup_component("job_queue")
                await job_queue.queue_job(filename, check_exists=True)
            except Exception as exc:
                raise self.server.error(f"Could not add it to the queue: {exc}", 500) from exc
            logger.info("[communitycad] queued %s (printer is %s)", filename, state)
            return {"queued": True, "started": False, "printer_state": state}

        try:
            await self.server.lookup_component("klippy_apis").start_print(filename)
        except Exception as exc:
            logger.warning("[communitycad] could not start %s: %s", filename, exc)
            raise self.server.error(
                f"The printer would not start this file: {exc}. It is still saved in "
                "G-code files.",
                409,
            ) from exc
        logger.info("[communitycad] started %s", filename)
        return {"queued": False, "started": True, "printer_state": state}

    # ------------------------------------------------------------- sending

    @property
    def _library_file(self) -> pathlib.Path:
        return self.root.joinpath("library.json")

    def _file_type(self) -> str:
        """The browse filter last chosen on this printer; "" means all types."""
        value = str(self._settings.get("file_type") or "")
        return value if value in FILE_TYPES else ""

    def _send_folder(self) -> str:
        """Where sent files go, relative to the G-code files. "" is the top level.

        Re-validated on read too: settings.json is a file on disk, and a value that
        didn't come through the settings endpoint must not steer a write anywhere.
        """
        value = self._settings.get("send_folder", DEFAULT_SEND_FOLDER)
        try:
            return clean_send_folder(value)
        except ValueError:
            return DEFAULT_SEND_FOLDER

    def _record_in_library(self, filename: str, entry: Dict[str, Any]) -> None:
        """Remember which model a G-code file came from.

        Sharing needs this to know what a finished print was of. Keyed by the name
        the file ended up with, which is what Moonraker's history reports.
        """
        library = self._read_json(self._library_file)
        library[filename] = entry
        self._write_json(self._library_file, library, 0o644)

    async def _handle_library(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        return {"files": self._read_json(self._library_file)}

    async def _catalog_file(self, model_id: int, file_id: int) -> tuple:
        """A model's catalog detail, one file's entry in it, and its bare name."""
        detail = await self._guard(
            self._api("GET", f"/catalog/models/{model_id}", authed=True)
        )
        for entry in (detail.get("files") or []):
            if entry.get("id") == file_id:
                name = os.path.basename(str(entry.get("path") or "")).strip()
                if not name:
                    raise self.server.error("That file has no usable name.", 422)
                return detail, entry, name
        raise self.server.error("That file is not part of this model.", 404)

    async def _download_url(self, model_id: int, file_id: int) -> str:
        """A short-lived presigned URL for one file. Issuing it is what spends a
        download, under the platform's rules: the first file of a model to this
        printer today counts, the rest of that model's files are free."""
        url_info = await self._guard(
            self._api(
                "POST",
                f"/catalog/models/{model_id}/files/{file_id}/download-url",
                # An explicit empty object, not None: Moonraker's client only sets
                # Content-Type when there is a body, and a POST arriving without one
                # is rejected by the API.
                body={},
                authed=True,
            )
        )
        url = url_info.get("url")
        if not url:
            raise self.server.error("CommunityCAD did not return a download link.", 502)
        return str(url)

    async def _download_to_tmp(self, url: str, entry: Dict[str, Any], name: str,
                               key: Optional[str] = None) -> tuple:
        """Download a presigned link into our own temp dir, size-checked.

        Returns (tmp_dir, path, bytes). A download that fails or comes up short is
        removed before raising, so nothing partial is ever handed on. While it runs,
        its progress is in self._transfers under `key`.
        """
        expected = entry.get("size_bytes")
        tmp_dir = self.root.joinpath("tmp")
        tmp_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp_path = tmp_dir.joinpath(f"{uuid.uuid4().hex}.part")

        transfers = self.__dict__.setdefault("_transfers", {})
        if key:
            transfers[key] = {"name": name, "received": 0, "total": int(expected or 0), "started": time.time()}

        def progress(_pct: int, total: int, received: int) -> None:
            if key and key in transfers:
                transfers[key].update(received=int(received), total=int(total))

        client: HttpClient = self.server.lookup_component("http_client")
        try:
            await client.download_file(
                url, "application/octet-stream",
                destination_path=tmp_path,
                download_size=int(expected) if expected else -1,
                progress_callback=progress,
                # The file storage can be slow to answer over a busy WiFi link: more
                # time to connect than Moonraker's 5 s, and two more tries.
                connect_timeout=DOWNLOAD_CONNECT_TIMEOUT_S, attempts=3, retry_pause_time=2.0,
                request_timeout=600.0,
            )
        except Exception as exc:
            if key:
                transfers.pop(key, None)
            tmp_path.unlink(missing_ok=True)
            logger.warning("[communitycad] download failed for %s: %s", name, exc)
            raise self.server.error(
                "The download did not finish. Nothing was added to your files.", 502
            ) from exc

        if key:
            transfers.pop(key, None)
        actual = tmp_path.stat().st_size if tmp_path.exists() else 0
        if expected and actual != int(expected):
            tmp_path.unlink(missing_ok=True)
            raise self.server.error(
                f"The download was incomplete ({actual} of {expected} bytes). "
                "Nothing was added to your files.",
                502,
            )
        return tmp_dir, tmp_path, actual

    # ------------------------------------------------- models on the printer

    @property
    def _models_dir(self) -> pathlib.Path:
        """printer_data/models: a Moonraker file root, beside gcodes and config."""
        return self.root.parent.joinpath(MODELS_ROOT)

    @property
    def _models_file(self) -> pathlib.Path:
        """Catalog details for files in the models folder, keyed by file name."""
        return self.root.joinpath("models.json")

    def _register_models_root(self) -> None:
        """Hand printer_data/models to Moonraker as a file root, as moonraker-timelapse
        does with its folder: upload, download, listing, delete and path checks are
        then Moonraker's own, through its standard file API."""
        try:
            self._models_dir.mkdir(parents=True, exist_ok=True)
            self._migrate_models_store()
            file_manager = self.server.lookup_component("file_manager")
            file_manager.register_directory(MODELS_ROOT, str(self._models_dir), full_access=True)
        except Exception:
            logger.exception("[communitycad] could not register %s", self._models_dir)

    def _migrate_models_store(self) -> None:
        """The first model store kept models as <id>.<ext> inside our own folder. Move them to real names
        in printer_data/models, once."""
        old_dir = self.root.joinpath("models")
        if not old_dir.is_dir():
            return
        old_index = self._read_json(self._models_file)
        index: Dict[str, Any] = {}
        for key, entry in old_index.items():
            source = old_dir.joinpath(str(entry.get("path", "")))
            if not MODEL_ID.match(key) or not source.is_file():
                if not MODEL_ID.match(key) and isinstance(entry, dict):
                    index[key] = entry          # already new-style
                continue
            name = unique_name(self._models_dir, str(entry.get("filename") or source.name))
            shutil.move(str(source), str(self._models_dir.joinpath(name)))
            index[name] = {**entry, "id": name, "path": name, "filename": name}
        self._write_json(self._models_file, index, 0o600)
        shutil.rmtree(old_dir, ignore_errors=True)
        logger.info("[communitycad] moved %d models to %s", len(index), self._models_dir)

    def _model_entry(self, name: str) -> Optional[Dict[str, Any]]:
        """One file in the models folder, by its plain name, or None. Never a path."""
        if not name or name != os.path.basename(name) or name.startswith("."):
            return None
        path = self._models_dir.joinpath(name)
        if not path.is_file():
            return None
        meta = self._read_json(self._models_file).get(name) or {}
        stat = path.stat()
        return {
            **meta,
            "id": name, "path": name, "filename": name,
            "bytes": stat.st_size,
            "saved_at": meta.get("saved_at") or stat.st_mtime,
            "usable": name.lower().endswith(MODEL_EXTS) and not name.lower().endswith(SENDABLE_EXTS),
            "uploaded": not meta,
        }

    def _models_index(self) -> Dict[str, Any]:
        """Every file in the models folder, with catalog details where we have them."""
        if not self._models_dir.is_dir():
            return {}
        entries = {}
        for path in self._models_dir.iterdir():
            entry = self._model_entry(path.name)
            if entry is not None:
                entries[path.name] = entry
        return entries

    def _free_bytes(self) -> Optional[int]:
        """Free space where our files live; None if it can't be measured. Measured
        on the nearest existing folder, since ours may not exist before a first save."""
        path = self.root
        while not path.exists() and path != path.parent:
            path = path.parent
        try:
            return shutil.disk_usage(path).free
        except OSError:
            return None

    def _models_summary(self, index: Dict[str, Any]) -> Dict[str, Any]:
        free = self._free_bytes()
        return {
            "root": MODELS_ROOT,
            "used_bytes": sum(int(e.get("bytes") or 0) for e in index.values()),
            "cap_bytes": MODELS_CAP_BYTES,
            "free_disk_bytes": free,
        }

    async def _handle_transfers(self, web_request: WebRequest) -> Dict[str, Any]:
        """Downloads from CommunityCAD running now, for the progress bar:
        {"model_id:file_id": {name, received, total, started}}."""
        del web_request
        return {"transfers": dict(self.__dict__.get("_transfers", {}))}

    async def _handle_save_model(self, web_request: WebRequest) -> Dict[str, Any]:
        """One save per catalog file at a time: a second request for the same file
        (Save, then Print before it finished) waits for the first and then finds it
        saved, instead of asking CommunityCAD for another download."""
        key = (web_request.get_int("model_id", 0), web_request.get_int("file_id", 0))
        locks = self.__dict__.setdefault("_save_locks", {})
        lock = locks.setdefault(key, asyncio.Lock())
        try:
            async with lock:
                return await self._save_model(web_request)
        finally:
            if not lock.locked() and not getattr(lock, "_waiters", None):
                locks.pop(key, None)

    async def _save_model(self, web_request: WebRequest) -> Dict[str, Any]:
        """Put a catalog model file (STL, OBJ, unsliced 3MF, STEP) in printer_data/models.

        Same download path as a send -- presigned link, temp file, size check -- but
        into the models folder instead of the G-code files, which take G-code only.
        A file of the same name already there is never replaced: the new one gets -2.
        """
        self._require_notice()
        if not self._token:
            raise self.server.error("Connect this printer to CommunityCAD first.", 409)
        model_id = web_request.get_int("model_id")
        file_id = web_request.get_int("file_id")
        index = self._models_index()
        # Already saved from the catalog and still there: nothing to fetch, not even
        # the model's details, so it works offline and costs CommunityCAD nothing.
        for existing in index.values():
            if existing.get("model_id") == model_id and existing.get("file_id") == file_id:
                return {"model": existing, "already": True, **self._models_summary(index)}
        detail, entry, name = await self._catalog_file(model_id, file_id)
        lower = name.lower()
        if lower.endswith(SENDABLE_EXTS):
            raise self.server.error(
                f"{name} is ready to print. Save it to the printer's G-code files instead.", 422)
        if not lower.endswith(MODEL_EXTS):
            raise self.server.error(f"{name} isn't a model file the printer can slice.", 422)
        size = int(entry.get("size_bytes") or 0)
        used = sum(int(e.get("bytes") or 0) for e in index.values())
        if used + size > MODELS_CAP_BYTES:
            raise self.server.error(
                "Models on this printer is full (2 GB). Delete some models to make room.", 507)
        free = self._free_bytes()
        if free is not None and size + DISK_HEADROOM_BYTES > free:
            raise self.server.error("There isn't enough free space on the printer for this model.", 507)

        # Checked before the link is issued: issuing it is what spends a download.
        url = await self._download_url(model_id, file_id)
        _, tmp_path, actual = await self._download_to_tmp(url, entry, name, key=f"{model_id}:{file_id}")

        # A 3MF that carries its own slicing settings is a project, not raw geometry:
        # it goes to Projects.
        if lower.endswith(".3mf") and await self.server.get_event_loop().run_in_thread(
                is_3mf_project, tmp_path):
            self._projects_dir.mkdir(parents=True, exist_ok=True)
            stored = unique_name(self._projects_dir, name)
            shutil.move(str(tmp_path), str(self._projects_dir.joinpath(stored)))
            self._save_project_meta(stored, {
                "origin": "catalog", "created": time.time(), "model_id": model_id,
                "file_id": file_id, "title": detail.get("title"), "slug": detail.get("slug"),
                "thumbnail_url": detail.get("thumbnail_url"),
            })
            return {"project": self._project_entry(stored), **self._models_summary(self._models_index())}

        self._models_dir.mkdir(parents=True, exist_ok=True)
        stored = unique_name(self._models_dir, name)
        try:
            shutil.move(str(tmp_path), str(self._models_dir.joinpath(stored)))
        except OSError as exc:
            tmp_path.unlink(missing_ok=True)
            raise self.server.error(f"Could not save {name} on the printer: {exc}", 500) from exc

        meta = self._read_json(self._models_file)
        meta[stored] = {
            "model_id": model_id,
            "file_id": file_id,
            "title": detail.get("title"),
            "slug": detail.get("slug"),
            "thumbnail_url": detail.get("thumbnail_url"),
            "saved_at": time.time(),
        }
        self._write_json(self._models_file, meta, 0o600)
        logger.info("[communitycad] saved %s to %s", name, self._models_dir.joinpath(stored))
        record = self._model_entry(stored)
        return {"model": record, **self._models_summary(self._models_index())}

    async def _handle_models(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        index = self._models_index()
        # Drop catalog details for files deleted through Moonraker's own API.
        meta = self._read_json(self._models_file)
        stale = [k for k in meta if k not in index]
        if stale:
            for k in stale:
                meta.pop(k, None)
            self._write_json(self._models_file, meta, 0o600)
        models = sorted(index.values(), key=lambda e: e.get("saved_at") or 0, reverse=True)
        return {"models": models, **self._models_summary(index)}

    async def _handle_models_delete(self, web_request: WebRequest) -> Dict[str, Any]:
        name = web_request.get_str("id")
        entry = self._model_entry(name)
        if entry is None:
            raise self.server.error("That model isn't on this printer.", 404)
        self._models_dir.joinpath(name).unlink(missing_ok=True)
        meta = self._read_json(self._models_file)
        if meta.pop(name, None) is not None:
            self._write_json(self._models_file, meta, 0o600)
        return {"deleted": name, **self._models_summary(self._models_index())}

    # ------------------------------------------------------------ projects

    @property
    def _projects_dir(self) -> pathlib.Path:
        """printer_data/projects: real OrcaSlicer projects, a Moonraker file root."""
        return self.root.parent.joinpath(PROJECTS_ROOT)

    @property
    def _projects_file(self) -> pathlib.Path:
        return self.root.joinpath("projects.json")

    def _register_root(self, root: str, path: pathlib.Path) -> None:
        try:
            path.mkdir(parents=True, exist_ok=True)
            self.server.lookup_component("file_manager").register_directory(
                root, str(path), full_access=True)
        except Exception:
            logger.exception("[communitycad] could not register %s", path)

    def _project_entry(self, name: str) -> Optional[Dict[str, Any]]:
        """One .3mf in the projects folder, by plain name, with what we know of it."""
        if (not name or name != os.path.basename(name) or name.startswith(".")
                or not name.lower().endswith(".3mf")):
            return None
        path = self._projects_dir.joinpath(name)
        if not path.is_file():
            return None
        meta = self._read_json(self._projects_file).get(name) or {}
        options = meta.get("options")
        if isinstance(options, dict) and ("process" not in options or "profile" not in options):
            # Made before free process settings: the fixed choices shown as the overrides they are,
            # and the quality as the default profile it always meant.
            meta = {**meta, "options": {
                "material": options.get("material", "PLA"),
                "profile": options.get("profile") or SLICE_QUALITY.get(str(options.get("quality")), DEFAULT_PROFILE),
                "process": options["process"] if "process" in options else legacy_process(options)}}
        stat = path.stat()
        thumb = self._thumb_path(name)
        thumbnail = None
        if thumb.is_file():
            # Served by Moonraker like G-code thumbnails; the query busts the browser cache.
            thumbnail = {"url": f"/server/files/{PROJECTS_ROOT}/{THUMBS_DIR}/{thumb.name}?v={int(thumb.stat().st_mtime)}",
                         "stale": meta.get("thumb_of") != (meta.get("updated") or stat.st_mtime)}
        return {
            **meta,
            "thumbnail": thumbnail,
            "id": name, "filename": name, "name": os.path.splitext(name)[0],
            "bytes": stat.st_size,
            "created": meta.get("created") or stat.st_mtime,
            "updated": meta.get("updated") or stat.st_mtime,
            # Made here from Models, saved from the catalog, or uploaded from a device.
            "origin": meta.get("origin") or "upload",
        }

    def _projects_index(self) -> Dict[str, Any]:
        if not self._projects_dir.is_dir():
            return {}
        out = {}
        for path in self._projects_dir.iterdir():
            entry = self._project_entry(path.name)
            if entry is not None:
                out[path.name] = entry
        return out

    def _save_project_meta(self, name: str, meta: Dict[str, Any]) -> None:
        index = self._read_json(self._projects_file)
        index[name] = {**index.get(name, {}), **meta, "updated": time.time()}
        self._write_json(self._projects_file, index, 0o600)

    def _project_sliced(self, name: str, opts: Dict[str, Any], gcodes: list) -> None:
        self._save_project_meta(name, {"options": opts, "last_slice": {"at": time.time(), "gcodes": gcodes}})

    def _on_history_changed(self, data: Dict[str, Any]) -> None:
        """A print finished: if it was a plate of one of our projects, remember how
        it went. Only with the user's permission to read print history."""
        try:
            if data.get("action") != "finished" or self._permission(PERMISSION_HISTORY) is not True:
                return
            job = data.get("job") or {}
            filename = str(job.get("filename") or "")
            self._record_finished_print(filename, job)
            index = self._read_json(self._projects_file)
            for name, meta in index.items():
                if filename in ((meta.get("last_slice") or {}).get("gcodes") or []):
                    prints = list(meta.get("prints") or [])
                    prints.append({"gcode": filename, "status": job.get("status"),
                                   "at": job.get("end_time") or time.time(),
                                   "duration": job.get("print_duration")})
                    meta["prints"] = prints[-PROJECT_PRINTS_KEPT:]
                    self._write_json(self._projects_file, index, 0o600)
                    return
        except Exception:
            logger.exception("[communitycad] could not record a print for a project")

    # ------------------------------------------------------------ sharing

    @property
    def _prints_file(self) -> pathlib.Path:
        return self.root.joinpath("prints.json")

    def _plate_models(self, project: Optional[str], plate: int) -> tuple:
        """The CommunityCAD models (with files and copies) on one plate of a project,
        and the count of the user's own parts. ([], 0) when the project file
        says nothing about plates: then the older whole-project list is used."""
        if not project:
            return [], 0
        path = self._projects_dir.joinpath(project)
        try:
            with zipfile.ZipFile(path) as z:
                xml = z.read("Metadata/model_settings.config").decode("utf-8", "replace")
        except (OSError, KeyError, zipfile.BadZipFile):
            return [], 0
        files = plate_contents(xml).get(plate) or {}
        return credited_models(files, self._read_json(self._models_file))

    def _catalog_models_of(self, project: Optional[str], library: Dict[str, Any]) -> list:
        """The CommunityCAD models a file prints, so a share credits the right one:
        a catalog file's own model, or the catalog models a project was made from."""
        out = []
        if library.get("model_id"):
            out.append({"model_id": library["model_id"], "title": library.get("title"),
                        "slug": library.get("slug")})
        meta = self._read_json(self._projects_file).get(project or "") or {}
        if meta.get("model_id"):
            out.append({"model_id": meta["model_id"], "title": meta.get("title"), "slug": meta.get("slug")})
        models = self._read_json(self._models_file)
        for source in meta.get("sources") or []:
            m = models.get(source.get("model")) or {}
            if m.get("model_id"):
                out.append({"model_id": m["model_id"], "title": m.get("title"), "slug": m.get("slug")})
        seen, unique = set(), []
        for m in out:
            if m["model_id"] not in seen:
                seen.add(m["model_id"])
                unique.append(m)
        return unique

    def _record_finished_print(self, filename: str, job: Dict[str, Any]) -> None:
        """A finished print of a CommunityCAD file, remembered for the Share tab.
        Called only with the user's permission to read print history."""
        entry = self._read_json(self._library_file).get(filename) or {}
        models = entry.get("models") or (
            [{"model_id": entry["model_id"], "title": entry.get("title"), "slug": entry.get("slug")}]
            if entry.get("model_id") else [])
        if not models:
            return
        prints = self._read_json(self._prints_file)
        job_id = str(job.get("job_id") or f"t{int(time.time())}")
        prints[job_id] = {
            "job_id": job_id, "filename": filename, "status": job.get("status"),
            "end_time": job.get("end_time") or time.time(), "print_duration": job.get("print_duration"),
            "filament_used": job.get("filament_used"), "models": models, "shared": None,
            "own_parts": int(entry.get("own_parts") or 0), "plate": entry.get("plate"),
        }
        if self._share_mode() == "auto" and job.get("status") == "completed":
            # Shared by the Pi after the undo window, so it happens with every tab closed.
            prints[job_id]["auto"] = {"state": "pending", "at": time.time() + AUTO_SHARE_DELAY_S}
        newest = sorted(prints.values(), key=lambda p: p.get("end_time") or 0)[-PRINTS_KEPT:]
        self._write_json(self._prints_file, {p["job_id"]: p for p in newest}, 0o600)
        self.server.send_event(NOTIFY_PRINT_FINISHED, {"job_id": job_id, "filename": filename,
                                                       "title": models[0].get("title")})

    async def _share_payload(self, record: Dict[str, Any], model_id: int) -> Dict[str, Any]:
        """Exactly what a profile share sends: allowlisted settings from the
        file's config block, the slicer from Moonraker's metadata, the printer's name
        and kinematics, the material, and how the print went. Nothing else."""
        filename = record["filename"]
        file_manager = self.server.lookup_component("file_manager")
        path = pathlib.Path(file_manager.get_directory("gcodes")).joinpath(filename)
        settings: Dict[str, str] = {}
        if path.is_file():
            def read() -> Dict[str, str]:
                with path.open("r", encoding="utf-8", errors="replace") as f:
                    return allowlist_module().extract_settings(f)
            settings = await self.server.get_event_loop().run_in_thread(read)
        try:
            meta = file_manager.get_metadata_storage().get(filename, {}) or {}
        except Exception:
            meta = {}
        material: Dict[str, Any] = {
            "type": settings.get("filament_type") or meta.get("filament_type"),
            "vendor": settings.get("filament_vendor"),
            "color": (settings.get("filament_colour") or settings.get("filament_color") or "").split(";")[0] or None,
        }
        spool = await self._spoolman_material()
        if spool:
            material.update({k: v for k, v in spool.items() if v})
        # Only what CommunityCAD keeps: the preview must be what's saved.
        keep = await self._platform_allowlist()
        not_shared = sorted(k for k in settings if keep is not None and k not in keep)
        settings = {k: v for k, v in settings.items() if k not in not_shared}
        config = await self._printer_config()
        kinematics = ((config.get("settings") or {}).get("printer") or {}).get("kinematics")
        status = str(record.get("status") or "")
        filament = record.get("filament_used")
        return {
            "model_id": int(model_id),
            "printer_name": self._default_printer_name(),
            "printer_kinematics": kinematics,
            "slicer": meta.get("slicer"),
            "slicer_version": meta.get("slicer_version"),
            "material": {k: str(v)[:40] for k, v in material.items() if v} or None,
            "settings": settings,
            "result": status if status in ("completed", "cancelled", "error") else "error",
            "print_duration_s": int(record["print_duration"]) if record.get("print_duration") else None,
            "filament_used_mm": round(float(filament), 1) if filament else None,
            "_not_shared": not_shared,
        }

    async def _spoolman_material(self) -> Optional[Dict[str, Any]]:
        """The active spool's vendor, material and colour, when Spoolman is set up in
        Moonraker; None otherwise (then the G-code's filament type is used)."""
        try:
            spoolman = self.server.lookup_component("spoolman", None)
        except Exception:
            spoolman = None
        if spoolman is None or not getattr(spoolman, "spool_id", None):
            return None
        try:
            client = self.server.lookup_component("http_client")
            url = f"{spoolman.spoolman_url.rstrip('/')}/v1/spool/{spoolman.spool_id}"
            resp = await client.get(url, connect_timeout=3., request_timeout=5.)
            spool = resp.json() if not resp.has_error() else {}
            filament = spool.get("filament") or {}
            return {"type": filament.get("material"), "vendor": (filament.get("vendor") or {}).get("name"),
                    "color": ("#" + filament["color_hex"]) if filament.get("color_hex") else None}
        except Exception:
            logger.debug("[communitycad] couldn't read the active spool", exc_info=True)
            return None

    def _shareable_prints(self) -> list:
        prints = self._read_json(self._prints_file)
        return sorted(prints.values(), key=lambda p: p.get("end_time") or 0, reverse=True)

    async def _handle_share_prints(self, web_request: WebRequest) -> Dict[str, Any]:
        """Recent finished prints of CommunityCAD files, for the Share tab."""
        del web_request
        waiting = {(i.get("data") or {}).get("job_id"): {"id": i["id"], "state": i.get("state"),
                                                          "error": i.get("error"), "next_at": i.get("next_at")}
                   for i in self._outbox_items() if i.get("kind") == "profile"}
        prints = [{**p, "outbox": waiting.get(p["job_id"])} for p in self._shareable_prints()]
        return {"prints": prints, "can_share": self._can_share(),
                "history_allowed": self._permission(PERMISSION_HISTORY) is True,
                "prompt": self._share_mode() == "ask", "mode": self._share_mode(),
                "visibility": self._share_visibility(), "private_profiles": PRIVATE_PROFILES_LIVE}

    def _share_mode(self) -> str:
        """After a print finishes: ask, share automatically, or don't. The
        old on/off "share_prompt" carries over as ask/off."""
        mode = self._settings.get("share_after_print")
        if mode in SHARE_MODES:
            return mode
        return "ask" if self._settings.get("share_prompt", True) else "off"

    def _share_visibility(self) -> str:
        value = self._settings.get("share_visibility")
        return value if value in SHARE_VISIBILITIES else "public"

    def _set_auto(self, job_id: str, **changes: Any) -> Optional[Dict[str, Any]]:
        prints = self._read_json(self._prints_file)
        record = prints.get(job_id)
        if record is None or not record.get("auto"):
            return None
        record["auto"].update(changes)
        self._write_json(self._prints_file, prints, 0o600)
        return record

    async def _auto_share_due(self) -> None:
        """Automatic shares whose time has come: pending ones after the undo
        window, and posts waiting for a timelapse once it's there or the wait ends."""
        now = time.time()
        for record in self._shareable_prints():
            auto = record.get("auto") or {}
            if auto.get("state") in ("pending", "timelapse") and (auto.get("at") or 0) <= now:
                try:
                    await self._auto_share(record)
                except Exception as exc:
                    logger.exception("[communitycad] automatic share of %s failed", record["job_id"])
                    self._set_auto(record["job_id"], state="failed", error=str(exc)[:200])

    def _auto_blocked(self) -> Optional[str]:
        if not self._notice_accepted():
            return "The first-use notice hasn't been accepted."
        if not self._token:
            return "This printer isn't linked to CommunityCAD."
        if not self._can_share():
            return "Sharing needs two more permissions. Add them in the Share tab."
        return None

    async def _auto_share(self, record: Dict[str, Any]) -> None:
        job_id = record["job_id"]
        auto = record.get("auto") or {}
        blocked = self._auto_blocked()
        if blocked:
            self._set_auto(job_id, state="skipped", error=blocked)
            return
        private = self._share_visibility() == "private"
        if auto.get("state") == "pending":
            # The profile first, so a post can carry it.
            if not record.get("shared") and (not private or PRIVATE_PROFILES_LIVE):
                payload = await self._share_payload(record, self._share_model(record, {}))
                if private:
                    payload["visibility"] = "private"
                data = {"job_id": job_id, "payload": payload, "title": (record.get("models") or [{}])[0].get("title")}
                try:
                    await self._deliver_profile(data)
                except CommunityCADError as exc:
                    if not self._transient(exc):
                        self._set_auto(job_id, state="failed", error=exc.message)
                        return
                    self._outbox_add("profile", data, exc.message)
            snapshot = None
            if self._setting("post_webcam", False):
                try:
                    snapshot = await self._webcam_snapshot()
                except Exception:
                    logger.info("[communitycad] no webcam photo for the automatic post of %s", job_id)
            if snapshot:
                self.root.joinpath("auto").mkdir(mode=0o700, exist_ok=True)
                self.root.joinpath("auto", f"{job_id}.{snapshot[0]}").write_bytes(snapshot[1])
            if self._setting("post_timelapse", False) and self._timelapse_for(record) is None:
                self._set_auto(job_id, state="timelapse", at=time.time() + AUTO_POST_WAIT_S,
                               snapshot=f"{job_id}.{snapshot[0]}" if snapshot else None)
                return
            auto["snapshot"] = f"{job_id}.{snapshot[0]}" if snapshot else None
        record = self._read_json(self._prints_file).get(job_id) or record
        await self._auto_post(record, auto.get("snapshot") or (record.get("auto") or {}).get("snapshot"))

    async def _auto_post(self, record: Dict[str, Any], snapshot: Optional[str]) -> None:
        """The post of an automatic share: the webcam photo and/or the timelapse.
        No picture, no post: the profile share stands on its own."""
        job_id = record["job_id"]
        images = []
        if snapshot:
            path = self.root.joinpath("auto", snapshot)
            if path.is_file():
                images.append((snapshot.rsplit(".", 1)[1], path.read_bytes()))
                path.unlink()
        video = self._timelapse_for(record)
        if video and video["too_big"]:
            video = None
        if not images and not video:
            self._set_auto(job_id, state="done", posted=False)
            return
        title = (record.get("models") or [{}])[0].get("title") or "This print"
        caption = f"{title}, printed on {self._default_printer_name()}."[:POST_CAPTION_MAX]
        try:
            await self._start_post(job_id, record, self._share_model(record, {}), caption, images, video,
                                   publish=self._share_visibility() == "public",
                                   attach_profile=bool(self._setting("post_attach_profile", True)))
        except Exception as exc:
            message = getattr(exc, "message", None) or str(exc)
            self._set_auto(job_id, state="failed", error=str(message)[:200])
            return
        self._set_auto(job_id, state="done", posted=True)

    async def _handle_auto_cancel(self, web_request: WebRequest) -> Dict[str, Any]:
        """Don't share this one: stops an automatic share that hasn't gone yet."""
        job_id = str(web_request.get_args().get("job_id") or "")
        record = self._read_json(self._prints_file).get(job_id) or {}
        state = (record.get("auto") or {}).get("state")
        if state not in ("pending", "timelapse"):
            raise self.server.error("That print isn't waiting to be shared.", 409)
        if state == "timelapse":
            snapshot = (record.get("auto") or {}).get("snapshot")
            if snapshot:
                self.root.joinpath("auto", snapshot).unlink(missing_ok=True)
        self._set_auto(job_id, state="cancelled")
        return {"cancelled": job_id}

    def _print_record(self, job_id: str) -> Dict[str, Any]:
        record = self._read_json(self._prints_file).get(job_id)
        if record is None:
            raise self.server.error("That print isn't in the Share list.", 404)
        return record

    def _share_model(self, record: Dict[str, Any], args: Dict[str, Any]) -> int:
        ids = [m["model_id"] for m in record.get("models") or []]
        try:
            chosen = int(args.get("model_id") or ids[0])
        except (TypeError, ValueError, IndexError):
            raise self.server.error("Which model was printed?", 422) from None
        if chosen not in ids:
            raise self.server.error("That model isn't part of this print.", 422)
        return chosen

    async def _handle_share_preview(self, web_request: WebRequest) -> Dict[str, Any]:
        """What Share profile would send, shown before sending: exactly the
        payload, after CommunityCAD's own allowlist, with what it doesn't take
        listed, and the plate's picture."""
        args = web_request.get_args()
        record = self._print_record(str(args.get("job_id") or ""))
        payload = await self._share_payload(record, self._share_model(record, args))
        return {"payload": payload, "not_shared": payload.pop("_not_shared", []),
                "image": self._plate_image(record.get("filename") or "")}

    async def _platform_allowlist(self) -> Optional[set]:
        """The setting keys CommunityCAD keeps on a print profile, fetched once an
        hour. None when it can't be read: then our own allowlist stands alone."""
        cached = getattr(self, "_platform_keys", None)
        if cached and time.time() - cached[0] < 3600:
            return cached[1]
        try:
            data = await self._api("GET", "/prints/profile-allowlist")
            keys = set(data.get("keys") or [])
        except Exception:
            logger.debug("[communitycad] couldn't read CommunityCAD's allowlist", exc_info=True)
            return cached[1] if cached else None
        if keys:
            self._platform_keys = (time.time(), keys)
        return keys or None

    def _plate_image(self, filename: str) -> Optional[str]:
        """The largest thumbnail Moonraker extracted from the G-code, as a path
        it serves, for the share preview."""
        try:
            meta = self.server.lookup_component("file_manager").get_metadata_storage().get(filename, {}) or {}
        except Exception:
            return None
        thumbs = sorted(meta.get("thumbnails") or [], key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))
        if not thumbs or not thumbs[-1].get("relative_path"):
            return None
        folder = os.path.dirname(filename)
        rel = os.path.join(folder, thumbs[-1]["relative_path"]) if folder else thumbs[-1]["relative_path"]
        return "/server/files/gcodes/" + "/".join(urllib.parse.quote(p) for p in rel.split("/"))

    async def _handle_share_profile(self, web_request: WebRequest) -> Dict[str, Any]:
        """Share the print profile of a finished print. Exactly the preview's
        payload; the server keeps only its own allowlist and says what it dropped."""
        args = web_request.get_args()
        self._require_notice()
        if not self._token:
            raise self.server.error("Connect this printer to CommunityCAD first.", 409)
        if not self._can_share():
            raise self.server.error("Sharing needs two more permissions. Add them in the Share tab.", 403)
        job_id = str(args.get("job_id") or "")
        record = self._print_record(job_id)
        payload = await self._share_payload(record, self._share_model(record, args))
        data = {"job_id": job_id, "payload": payload,
                "title": next((m.get("title") for m in record.get("models") or []
                               if m["model_id"] == payload["model_id"]), None)}
        try:
            shared = await self._deliver_profile(data)
        except CommunityCADError as exc:
            if exc.code == 404:
                raise self.server.error(SHARING_NOT_LIVE, 503) from exc
            if self._transient(exc):
                # Kept on the Pi and sent when CommunityCAD answers again.
                item = self._outbox_add("profile", data, exc.message)
                return {"queued": True, "outbox_id": item["id"], "message": exc.message}
            raise self.server.error(exc.message, exc.code) from exc
        return {"shared": shared}

    # ------------------------------------------------------------ outbox

    @property
    def _outbox_dir(self) -> pathlib.Path:
        return self.root.joinpath("outbox")

    def _outbox_items(self) -> list:
        items = []
        if self._outbox_dir.is_dir():
            for d in sorted(self._outbox_dir.iterdir()):
                item = self._read_json(d.joinpath("item.json"))
                if item:
                    items.append(item)
        return items

    def _outbox_save(self, item: Dict[str, Any]) -> None:
        folder = self._outbox_dir.joinpath(item["id"])
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._write_json(folder.joinpath("item.json"), item, 0o600)

    def _outbox_add(self, kind: str, data: Dict[str, Any], error: str) -> Dict[str, Any]:
        item = {"id": f"{int(time.time())}-{uuid.uuid4().hex[:6]}", "kind": kind, "data": data,
                "created": time.time(), "attempts": 1, "next_at": time.time() + OUTBOX_BACKOFF_S[0],
                "state": "waiting", "error": error}
        self._outbox_save(item)
        logger.info("[communitycad] %s kept in the outbox: %s", kind, error)
        return item

    @staticmethod
    def _transient(exc: CommunityCADError) -> bool:
        """Worth trying again later: unreachable, busy or failing, not a refusal."""
        return exc.reason in ("unreachable", "rate_limited") or exc.code >= 500 or exc.code in (408, 429)

    async def _outbox_loop(self) -> None:
        """Deliver what's due, forever, quietly. Catches everything: it runs detached."""
        while True:
            try:
                await asyncio.sleep(OUTBOX_TICK_S)
                await self._auto_share_due()
                if self._token:
                    for item in self._outbox_items():
                        if item.get("state") == "waiting" and item.get("next_at", 0) <= time.time():
                            await self._outbox_deliver(item)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[communitycad] outbox pass failed")

    async def _outbox_deliver(self, item: Dict[str, Any]) -> bool:
        """One try at one item. True when it went through (and is removed)."""
        try:
            if item["kind"] == "profile":
                await self._deliver_profile(item["data"])
            elif item["kind"] == "post":
                await self._deliver_post(item)
            else:
                raise CommunityCADError("Unknown kind of upload.", code=400)
        except CommunityCADError as exc:
            item["attempts"] = int(item.get("attempts") or 0) + 1
            item["error"] = exc.message
            if self._transient(exc):
                gap = OUTBOX_BACKOFF_S[min(item["attempts"] - 1, len(OUTBOX_BACKOFF_S) - 1)]
                item["next_at"] = time.time() + gap
                item["state"] = "waiting"
            else:
                item["state"] = "failed"
            self._outbox_save(item)
            return False
        shutil.rmtree(self._outbox_dir.joinpath(item["id"]), ignore_errors=True)
        logger.info("[communitycad] delivered %s %s from the outbox", item["kind"], item["id"])
        return True

    async def _model_public(self, model_id: int) -> bool:
        """Is this model public on CommunityCAD? Asked before anything about it
        is shared, and cached ten minutes. Raises when it can't be read: a share
        never goes out on a guess."""
        cache = self.__dict__.setdefault("_visibility_cache", {})
        hit = cache.get(model_id)
        if hit and time.time() - hit[0] < 600:
            return hit[1]
        detail = await self._api("GET", f"/catalog/models/{model_id}", authed=True)
        public = (detail or {}).get("visibility", "public") == "public"
        cache[model_id] = (time.time(), public)
        return public

    async def _deliver_profile(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Send a profile share and remember the result on its print."""
        # Keys starting with "_" are ours (the preview's notes), never sent.
        body = {k: v for k, v in data["payload"].items() if not k.startswith("_")}
        # A private model's profile is never shared publicly. Until CommunityCAD
        # keeps private profiles, that means not at all.
        if not (body.get("visibility") == "private" and PRIVATE_PROFILES_LIVE) \
                and not await self._model_public(int(body["model_id"])):
            raise CommunityCADError(PRIVATE_MODEL_PROFILE.format(title=data.get("title") or "This model"),
                                    code=409, reason="private_model")
        result = await self._api("POST", "/prints/profiles", body=body, authed=True)
        shared = {"profile_id": (result.get("profile") or {}).get("id"), "model_id": data["payload"]["model_id"],
                  "model_url": result.get("model_url"), "print_count": result.get("print_count"),
                  "dropped": result.get("dropped_settings") or [], "at": time.time()}
        prints = self._read_json(self._prints_file)
        if data.get("job_id") in prints:
            prints[data["job_id"]]["shared"] = shared
            self._write_json(self._prints_file, prints, 0o600)
        if shared["dropped"]:
            logger.warning("[communitycad] the server dropped settings our allowlist sent: %s", shared["dropped"])
        return shared

    # ------------------------------------------------------------ posts

    def _setting(self, key: str, default: Any) -> Any:
        return self._settings.get(key, default)

    def _on_timelapse_event(self, data: Dict[str, Any]) -> None:
        """moonraker-timelapse finished a video: which print it's of. Nothing is
        kept, and the timelapse folder is never read, unless the user turned on
        "Offer timelapse in posts"."""
        try:
            if not self._setting("post_timelapse", False):
                return
            if data.get("action") != "render" or data.get("status") != "success" or not data.get("filename"):
                return
            known = self._read_json(self.root.joinpath("timelapses.json"))
            known[str(data.get("printfile") or "")] = {"filename": str(data["filename"]), "at": time.time()}
            newest = sorted(known.items(), key=lambda kv: kv[1].get("at") or 0)[-TIMELAPSES_KEPT:]
            self._write_json(self.root.joinpath("timelapses.json"), dict(newest), 0o600)
            printfile = os.path.basename(str(data.get("printfile") or ""))
            for record in self._shareable_prints():
                if ((record.get("auto") or {}).get("state") == "timelapse"
                        and os.path.basename(record.get("filename") or "") == printfile):
                    self._set_auto(record["job_id"], at=time.time())   # the next tick posts it
        except Exception:
            logger.exception("[communitycad] could not note a timelapse")

    def _timelapse_dir(self) -> Optional[pathlib.Path]:
        try:
            component = self.server.lookup_component("timelapse", None)
        except Exception:
            component = None
        folder = getattr(component, "out_dir", None)
        return pathlib.Path(folder) if folder else None

    def _timelapse_for(self, record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The rendered timelapse of this print, if the setting is on and one exists."""
        if not self._setting("post_timelapse", False):
            return None
        folder = self._timelapse_dir()
        if folder is None:
            return None
        known = self._read_json(self.root.joinpath("timelapses.json"))
        filename = record.get("filename") or ""
        hit = known.get(filename) or next(
            (v for k, v in known.items() if k and os.path.basename(k) == os.path.basename(filename)), None)
        if not hit:
            return None
        name = os.path.basename(str(hit["filename"]))
        path = folder.joinpath(name)
        if not path.is_file():
            return None
        size = path.stat().st_size
        return {"filename": name, "size_bytes": size, "too_big": size > POST_VIDEO_MAX_BYTES,
                "url": f"/server/files/timelapse/{name}"}

    async def _handle_webcams(self, web_request: WebRequest) -> Dict[str, Any]:
        """The webcams Moonraker knows (names only), for the setting."""
        del web_request
        try:
            cams = self.server.lookup_component("webcam").get_webcams()
            return {"webcams": [{"name": name} for name in cams]}
        except Exception:
            return {"webcams": []}

    async def _handle_webcam_snapshot(self, web_request: WebRequest) -> Dict[str, Any]:
        """One webcam snapshot, for a post photo the user sees before posting. Never
        taken unless the user turned on "Use webcam for post photos"."""
        del web_request
        kind, data = await self._webcam_snapshot()
        return {"type": kind, "data": base64.b64encode(data).decode()}

    async def _webcam_snapshot(self) -> Tuple[str, bytes]:
        """One snapshot from the chosen webcam. Refuses unless the user turned on
        "Use webcam for post photos": the webcam isn't even looked up otherwise."""
        if not self._setting("post_webcam", False):
            raise self.server.error("Using the webcam for post photos is off in Settings.", 403)
        try:
            cams = self.server.lookup_component("webcam").get_webcams()
        except Exception:
            cams = {}
        name = self._setting("post_webcam_name", None)
        cam = cams.get(name) if name else next(iter(cams.values()), None)
        if cam is None:
            raise self.server.error("No webcam is set up in Moonraker.", 404)
        try:
            url = await cam.get_snapshot_url(True)
            resp = await self.server.lookup_component("http_client").get(
                url, connect_timeout=3., request_timeout=8.)
        except Exception as exc:
            raise self.server.error("The webcam didn't answer.", 502) from exc
        if resp.has_error() or not resp.content or len(resp.content) > POST_IMAGE_MAX_BYTES:
            raise self.server.error("The webcam didn't give a usable picture.", 502)
        kind = image_type(resp.content)
        if kind is None:
            raise self.server.error("The webcam's snapshot isn't a picture.", 502)
        return kind, resp.content

    async def _handle_post_options(self, web_request: WebRequest) -> Dict[str, Any]:
        """What a post for this print can include: the timelapse (when offered) and
        the profile (when shared)."""
        record = self._print_record(str(web_request.get_args().get("job_id") or ""))
        return {"timelapse": self._timelapse_for(record),
                "webcam": bool(self._setting("post_webcam", False)),
                "profile_id": (record.get("shared") or {}).get("profile_id"),
                "attach_profile": bool(self._setting("post_attach_profile", True)),
                "posted": record.get("posted")}

    async def _handle_post_create(self, web_request: WebRequest) -> Dict[str, Any]:
        """Make a post for a finished print: photos the user chose (or a webcam
        snapshot they saw), an optional timelapse the Pi uploads itself, a caption,
        the print profile when attached. Publish or save as a draft. Something that
        can't reach CommunityCAD waits in the outbox."""
        args = web_request.get_args()
        self._require_notice()
        if not self._token:
            raise self.server.error("Connect this printer to CommunityCAD first.", 409)
        if not self._can_share():
            raise self.server.error("Posting needs two more permissions. Add them in the Share tab.", 403)
        job_id = str(args.get("job_id") or "")
        record = self._print_record(job_id)
        model_id = self._share_model(record, args)
        caption = str(args.get("caption") or "").strip()
        if len(caption) > POST_CAPTION_MAX:
            raise self.server.error(f"Captions can be up to {POST_CAPTION_MAX} characters.", 422)
        images = []
        for raw in (args.get("images") or [])[:POST_IMAGES_MAX + 1]:
            try:
                data = base64.b64decode(str((raw or {}).get("data") or ""), validate=True)
            except (ValueError, AttributeError):
                data = b""
            kind = image_type(data)
            if kind is None or len(data) > POST_IMAGE_MAX_BYTES:
                raise self.server.error("Photos must be JPEG, PNG or WebP, up to 5 MB each.", 422)
            images.append((kind, data))
        if len(images) > POST_IMAGES_MAX:
            raise self.server.error(f"Posts can have up to {POST_IMAGES_MAX} photos.", 422)
        video = None
        if args.get("timelapse"):
            video = self._timelapse_for(record)
            if video is None:
                raise self.server.error("There's no timelapse of this print to include.", 404)
            if video["too_big"]:
                raise self.server.error("That timelapse is over 50 MB, the most a post takes.", 422)
        if not images and not video:
            raise self.server.error("Add a photo or the timelapse.", 422)
        return await self._start_post(job_id, record, model_id, caption, images, video,
                                      publish=bool(args.get("publish")),
                                      attach_profile=bool(args.get("attach_profile")))

    async def _start_post(self, job_id: str, record: Dict[str, Any], model_id: int, caption: str,
                          images: list, video: Optional[Dict[str, Any]], publish: bool,
                          attach_profile: bool) -> Dict[str, Any]:
        """Create a post now, its timelapse uploading after; or keep it in the outbox
        when CommunityCAD can't be reached."""
        profile_id = (record.get("shared") or {}).get("profile_id") if attach_profile else None
        # A post about a private model is only ever a draft.
        # Offline, or it can't be read: a draft, never a guess at public.
        try:
            kept_draft = publish and not await self._model_public(model_id)
        except CommunityCADError:
            kept_draft = publish
        if kept_draft:
            publish = False
        fields = {"model_id": str(model_id), "publish": "true" if publish else "false",
                  "caption": caption}
        if profile_id:
            fields["print_profile_id"] = str(profile_id)
        item = {"id": f"{int(time.time())}-{uuid.uuid4().hex[:6]}", "kind": "post",
                "created": time.time(), "attempts": 0, "next_at": 0, "state": "waiting", "error": None,
                "data": {"job_id": job_id, "title": record["models"][0].get("title") if record.get("models") else None,
                         "stage": "create", "fields": fields,
                         "images": [f"image-{i}.{k}" for i, (k, _) in enumerate(images)],
                         "video": str(self._timelapse_dir().joinpath(video["filename"])) if video else None}}
        folder = self._outbox_dir.joinpath(item["id"])
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        for name, (_, data) in zip(item["data"]["images"], images):
            folder.joinpath(name).write_bytes(data)
        self._outbox_save(item)
        # Create it now; a timelapse then uploads in the background from the Pi.
        try:
            created = await self._post_create_stage(item)
        except CommunityCADError as exc:
            if exc.code == 404 and "Model" not in exc.message:
                shutil.rmtree(folder, ignore_errors=True)
                raise self.server.error(SHARING_NOT_LIVE, 503) from exc
            if self._transient(exc):
                item["attempts"], item["error"] = 1, exc.message
                item["next_at"] = time.time() + OUTBOX_BACKOFF_S[0]
                self._outbox_save(item)
                return {"queued": True, "outbox_id": item["id"], "message": exc.message}
            shutil.rmtree(folder, ignore_errors=True)
            raise self.server.error(exc.message, exc.code) from exc
        if item["data"]["stage"] == "video":
            self.eventloop.create_task(self._outbox_deliver(item))
        else:
            shutil.rmtree(folder, ignore_errors=True)
        message = created.get("message")
        if kept_draft:
            message = "Kept private: the model is private on CommunityCAD, so the post isn't published."
        return {"post": created.get("post"), "message": message,
                "video_uploading": item["data"]["stage"] == "video"}

    async def _post_create_stage(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """POST /v1/posts (multipart). Records the post on its print and moves the
        item on to the video stage when there's a timelapse."""
        data = item["data"]
        folder = self._outbox_dir.joinpath(item["id"])
        fields = dict(data["fields"])
        if data.get("video"):
            fields["video_size_bytes"] = str(pathlib.Path(data["video"]).stat().st_size)
        files = [("images", name, IMAGE_TYPES[name.rsplit(".", 1)[1]], folder.joinpath(name).read_bytes())
                 for name in data["images"]]
        body, ctype = multipart_body(fields, files)
        result = await self._api("POST", "/posts", authed=True, raw=body, content_type=ctype, timeout=120.0)
        post = result.get("post") or {}
        self._remember_post(data["job_id"], post, result.get("message"))
        if result.get("upload") and data.get("video"):
            data.update({"stage": "video", "post_id": post.get("id"), "upload": result["upload"]})
            self._outbox_save(item)
        return result

    async def _deliver_post(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Outbox delivery for a post: create it if that hadn't gone through, then
        upload the timelapse (resuming where it stopped) and settle the video."""
        data = item["data"]
        result: Dict[str, Any] = {}
        if data.get("stage") == "create":
            result = await self._post_create_stage(item)
        if data.get("stage") == "video":
            await upload_resumable(self._storage_client(), data["upload"],
                                   pathlib.Path(data["video"]), resume=int(item.get("attempts") or 0) > 0)
            result = await self._api("POST", f"/posts/{data['post_id']}/video/complete", authed=True, body={},
                                     timeout=120.0)
            self._remember_post(data["job_id"], result.get("post") or {}, result.get("message"))
        return result

    def _storage_client(self) -> Any:
        return StorageClient()

    def _remember_post(self, job_id: str, post: Dict[str, Any], message: Optional[str]) -> None:
        prints = self._read_json(self._prints_file)
        if job_id in prints and post:
            prints[job_id]["posted"] = {"post_id": post.get("id"), "status": post.get("status"),
                                        "url": post.get("url"), "edit_url": post.get("edit_url"),
                                        "message": message, "at": time.time()}
            self._write_json(self._prints_file, prints, 0o600)

    async def _handle_outbox(self, web_request: WebRequest) -> Dict[str, Any]:
        """GET: what's waiting. POST {id, action: retry|delete}."""
        if web_request.get_request_type() == RequestType.POST:
            args = web_request.get_args()
            item_id = str(args.get("id") or "")
            if not re.fullmatch(r"[0-9a-f-]{8,40}", item_id):
                raise self.server.error("Unknown upload.", 404)
            folder = self._outbox_dir.joinpath(item_id)
            item = self._read_json(folder.joinpath("item.json"))
            if not item:
                raise self.server.error("That upload isn't waiting any more.", 404)
            if args.get("action") == "delete":
                shutil.rmtree(folder, ignore_errors=True)
                return {"deleted": item_id}
            self._require_notice()
            if not await self._outbox_deliver(item):
                item = self._read_json(folder.joinpath("item.json"))
                raise self.server.error(item.get("error") or "It didn't go through.", 502)
            return {"delivered": item_id}
        return {"items": [{k: v for k, v in i.items() if k != "data"} | {
            "job_id": (i.get("data") or {}).get("job_id"), "title": (i.get("data") or {}).get("title")}
            for i in self._outbox_items()]}

    async def _handle_share_dismiss(self, web_request: WebRequest) -> Dict[str, Any]:
        """Not now / remove from the Share list."""
        job_id = str(web_request.get_args().get("job_id") or "")
        prints = self._read_json(self._prints_file)
        if prints.pop(job_id, None) is not None:
            self._write_json(self._prints_file, prints, 0o600)
        return {"dismissed": job_id}

    async def _pause_macros(self) -> Dict[str, Any]:
        """Which of PAUSE and M600 this printer has, from printer.cfg. Unknown
        without permission to read the printer's settings."""
        if self._permission(PERMISSION_SETTINGS) is not True:
            return {"known": False, "pause": None, "filament": None}
        try:
            settings = (await self._printer_config()).get("settings") or {}
        except Exception:
            return {"known": False, "pause": None, "filament": None}
        pause = _macro(settings, ("pause",))
        m600 = _macro(settings, ("m600",))
        return {"known": True, "pause": pause[0] if pause else None,
                "filament": m600[0] if m600 else (pause[0] if pause else None)}

    async def _handle_project_markers(self, web_request: WebRequest) -> Dict[str, Any]:
        """GET: a project's pauses and filament changes, and the macros they'd run.
        POST {project, markers}: replace them, in the project's 3MF."""
        args = web_request.get_args()
        name = str(args.get("project") or "")
        entry = self._project_entry(name)
        if entry is None:
            raise self.server.error("That project isn't on this printer.", 404)
        path = self._projects_dir.joinpath(name)
        macros = await self._pause_macros()
        if web_request.get_request_type() == RequestType.POST:
            if not macros["known"]:
                raise self.server.error("Allow reading this printer's settings first, so the plugin can check "
                                        "printer.cfg has a PAUSE macro.", 409)
            raw = args.get("markers")
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except ValueError:
                    raw = None
            volume = await self._effective_build_volume() or {}
            try:
                markers = clean_layer_markers(raw, float(volume.get("z") or 500), macros["filament"])
            except ValueError as exc:
                raise self.server.error(str(exc), 422) from exc
            if any(m["kind"] == "pause" for m in markers) and not macros["pause"]:
                raise self.server.error("printer.cfg has no PAUSE macro, so the printer couldn't pause. "
                                        "Mainsail's mainsail.cfg has one.", 422)
            if any(m["kind"] == "filament" for m in markers) and not macros["filament"]:
                raise self.server.error("printer.cfg has neither an M600 nor a PAUSE macro, so the printer "
                                        "couldn't stop for a filament change.", 422)
            if self._orca_busy:
                raise self.server.error("OrcaSlicer is busy with this project. Try again in a moment.", 409)
            await self.server.get_event_loop().run_in_thread(write_layer_markers, path, markers)
            self._save_project_meta(name, {"markers": markers})
        return {"markers": await self.server.get_event_loop().run_in_thread(read_layer_markers, path),
                "macros": macros}

    async def _handle_projects(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        index = self._projects_index()
        meta = self._read_json(self._projects_file)
        stale = [k for k in meta if k not in index]
        if stale:
            for k in stale:
                meta.pop(k, None)
            self._write_json(self._projects_file, meta, 0o600)
        projects = sorted(index.values(), key=lambda e: e.get("updated") or 0, reverse=True)
        return {"projects": projects, "root": PROJECTS_ROOT,
                "history_allowed": self._permission(PERMISSION_HISTORY) is True}

    async def _guard_orca(self) -> None:
        if self._orca_busy or (self._slice is not None and self._slice["state"] == "slicing"):
            raise self.server.error("OrcaSlicer is busy. Try again in a moment.", 409)
        if not self.orca_path.is_file():
            raise self.server.error(
                ORCA_MISSING, 503)
        if await self._print_state() in BUSY_PRINT_STATES:
            raise self.server.error(
                PRINTING_WAIT, 409)

    async def _export_project(self, name: str, sources: list, opts: Dict[str, Any],
                              material: Dict[str, Any], base: Optional[pathlib.Path] = None,
                              orientations: Optional[Dict[str, list]] = None,
                              spacing: Optional[float] = None) -> None:
        """Build printer_data/projects/<name> as a real Orca project: the models
        (and copies), arranged the way Orca arranges -- extra plates when they don't
        fit -- with this printer and the chosen settings. Nothing is sliced."""
        volume = await self._effective_build_volume()
        if not volume:
            raise self.server.error(
                "Projects need this printer's bed size. Allow reading the printer's settings in "
                "Settings, or type the bed size there.", 409)
        profile = await self._printer_profile()
        printer = await self._printer_info()
        work = self.root.joinpath("tmp", f"project-{uuid.uuid4().hex[:8]}")
        self._orca_busy = True
        try:
            work.mkdir(mode=0o700, parents=True, exist_ok=True)
            out = work.joinpath("out")
            out.mkdir()
            presets = await self._write_presets(work, volume, profile.get("nozzle_diameter") or 0.4,
                                                material, opts, printer)
            args = ["--arrange", "1", "--orient", "0",
                    "--load-settings", f"{presets['machine']};{presets['process']}",
                    "--load-filaments", str(presets["filament"]),
                    "--export-3mf", "project.3mf", "--outputdir", str(out)]
            inputs = ([str(base)] if base else []) + [str(self._models_dir.joinpath(m)) for m, _ in sources]
            if any(c != 1 for _, c in sources) and not base:
                args += ["--clone-objects", ",".join(str(c) for _, c in sources)]
            try:
                code, err = await self._orca(args + inputs, work)
            except asyncio.TimeoutError as exc:
                raise self.server.error("Making the project took too long and was stopped.", 504) from exc
            made = out.joinpath("project.3mf")
            if code != 0 or not made.is_file():
                raise self.server.error(self._orca_failure(out, code, err), 422)
            if orientations:
                # Models laid on a face keep that face down: tilt them again,
                # then let Orca arrange around their new footprints.
                tilted = await self.server.get_event_loop().run_in_thread(
                    reapply_orientations, made, orientations)
                if tilted:
                    again = work.joinpath("again")
                    again.mkdir()
                    code, err = await self._orca(
                        ["--arrange", "1", "--orient", "0",
                         "--load-settings", f"{presets['machine']};{presets['process']}",
                         "--load-filaments", str(presets["filament"]),
                         "--export-3mf", "project.3mf", "--outputdir", str(again), str(made)], work)
                    if code != 0 or not again.joinpath("project.3mf").is_file():
                        raise self.server.error(self._orca_failure(again, code, err), 422)
                    made = again.joinpath("project.3mf")
            if spacing is not None:
                # A chosen spacing: the plugin packs the plate; Orca can't be told it.
                process = json.loads(pathlib.Path(presets["process"]).read_text())
                brim = float(process.get("brim_width") or 0) if process.get("brim_type") != "no_brim" else 0.0
                loops = int(float(process.get("skirt_loops") or 0))
                # Room at the edges for the skirt, and Orca's own small border.
                margin = 1.0 + (float(process.get("skirt_distance") or 0) + loops * 0.5 if loops else 0.0)
                try:
                    await self.server.get_event_loop().run_in_thread(
                        pack_3mf, made, (float(volume["x"]), float(volume["y"])), float(spacing), brim, margin)
                except ValueError as exc:
                    raise self.server.error(str(exc), 422) from exc
            markers = (self._read_json(self._projects_file).get(name) or {}).get("markers")
            if markers:
                # Pauses and filament changes live in the project: put them back.
                await self.server.get_event_loop().run_in_thread(write_layer_markers, made, markers)
            self._projects_dir.mkdir(parents=True, exist_ok=True)
            os.replace(made, self._projects_dir.joinpath(name))
        finally:
            self._orca_busy = False
            shutil.rmtree(work, ignore_errors=True)

    def _project_options(self, args: Dict[str, Any], current: Optional[Dict[str, Any]] = None,
                         nozzle: float = 0.4) -> tuple:
        """Validated slicing choices and the material: {material, quality, process},
        where process holds the user's changes to the preset. The old fixed
        choices (infill, supports, brim) are still accepted, as overrides."""
        current = current or {}
        materials, _ = self._materials()
        # Nothing chosen yet: the material used last on this printer, else PLA.
        last = self._settings.get("last_material")
        material_name = str(args.get("material") or args.get("filament") or current.get("material")
                            or (last if last in materials else None) or "PLA")
        profile = self._choose_profile(args, current)
        legacy: Dict[str, Any] = {}
        if "infill" in args:
            try:
                legacy["infill"] = int(args["infill"])
            except (TypeError, ValueError):
                legacy["infill"] = -1
            if legacy["infill"] not in SLICE_INFILL:
                raise self.server.error("Those slicing options aren't available.", 422)
        for key in ("supports", "brim"):
            if key in args:
                value = args[key]
                legacy[key] = value if isinstance(value, bool) else (
                    str(value).lower() in ("auto", "on", "true", "1") if key == "supports"
                    else str(value).lower() not in ("off", "false", "0"))
        if "process" in args:
            raw = args["process"]
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except ValueError:
                    raw = None
        else:
            raw = current.get("process")
            if raw is None:
                raw = legacy_process({k: current[k] for k in ("infill", "supports", "brim") if k in current})
        try:
            process = {**check_process(raw, nozzle), **legacy_process(legacy)}
        except ValueError as exc:
            raise self.server.error(str(exc), 422) from exc
        if material_name not in materials:
            raise self.server.error(f'There\'s no material called "{material_name}" in materials.cfg.', 422)
        opts = {"material": material_name, "profile": profile, "process": process}
        return opts, {**materials[material_name], "name": material_name}

    def _choose_profile(self, args: Dict[str, Any], current: Dict[str, Any]) -> str:
        """The print profile for a slice or project: asked for, else the
        project's, else the printer's default. Old `quality` keys still work."""
        if args.get("profile"):
            name = str(args["profile"]).strip()
        elif args.get("quality"):
            quality = str(args["quality"]).lower()
            if quality not in SLICE_QUALITY:
                raise self.server.error("Those slicing options aren't available.", 422)
            name = SLICE_QUALITY[quality]
        else:
            name = (current.get("profile") or SLICE_QUALITY.get(str(current.get("quality") or ""))
                    or self._settings.get("default_profile") or DEFAULT_PROFILE)
        if self._profile_exists(name):
            return name
        if not args.get("profile") and not args.get("quality"):
            # The project's own profile was deleted or renamed in print_profiles.cfg:
            # fall back to the printer's default rather than refuse to slice.
            for fallback in (self._settings.get("default_profile"), DEFAULT_PROFILE):
                if fallback and self._profile_exists(fallback):
                    return fallback
        raise self.server.error(f'There\'s no print profile called "{name}".', 422)

    def _profile_exists(self, name: str) -> bool:
        if name in self._profiles()[0]:
            return True
        try:
            return name in self._orca_profiles().process_names()
        except Exception:
            return name in SLICE_QUALITY.values()      # Orca not installed: nothing to check against

    def _profile_for(self, name: str) -> Any:
        """A profile name as slice_presets takes it: a custom section, or the name."""
        customs, _ = self._profiles()
        return {**customs[name], "name": name} if name in customs else name

    def _project_spacing(self, args: Dict[str, Any], entry: Optional[Dict[str, Any]] = None) -> Optional[float]:
        """The gap between models when arranging: mm, or None for Orca's own."""
        if "spacing" not in args:
            return (entry or {}).get("spacing")
        raw = args.get("spacing")
        if raw is None or str(raw).strip() == "":
            return None
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = -1.0
        if not 0 <= value <= ARRANGE_SPACING_MAX:
            raise self.server.error(f"Spacing must be from 0 to {ARRANGE_SPACING_MAX:g} mm.", 422)
        return value

    def _project_sources(self, raw: Any) -> list:
        """[(model file, copies)] from [{model, copies}] or plain names."""
        sources = []
        for item in raw or []:
            name = item.get("model") if isinstance(item, dict) else item
            copies = item.get("copies", 1) if isinstance(item, dict) else 1
            entry = self._model_entry(str(name or ""))
            if entry is None or not entry["usable"]:
                raise self.server.error(f"{name} isn't a model on this printer.", 404)
            try:
                copies = int(copies)
            except (TypeError, ValueError):
                copies = 0
            if not 1 <= copies <= 50:
                raise self.server.error("Copies must be from 1 to 50.", 422)
            sources.append((entry["filename"], copies))
        if not sources:
            raise self.server.error("A project needs at least one model.", 422)
        return sources

    async def _handle_project_create(self, web_request: WebRequest) -> Dict[str, Any]:
        """A new project from one or more models: Slice on a model always makes
        a new one; several selected models go into the same one."""
        args = web_request.get_args()
        await self._guard_orca()
        sources = self._project_sources(args.get("models"))
        nozzle = (await self._printer_profile()).get("nozzle_diameter") or 0.4
        opts, material = self._project_options(args, None, nozzle)
        first = os.path.splitext(sources[0][0])[0]
        default = first if len(sources) == 1 else f"{first} + {len(sources) - 1} more"
        title = str(args.get("name") or default).strip()[:64]
        name = unique_name(self._projects_dir, re.sub(r"[/\\]", "-", title) + ".3mf")
        await self._export_project(name, sources, opts, material)
        self._save_project_meta(name, {
            "origin": "models", "created": time.time(), "options": opts,
            "sources": [{"model": m, "copies": c} for m, c in sources],
        })
        return {"project": self._project_entry(name)}

    async def _handle_project_update(self, web_request: WebRequest) -> Dict[str, Any]:
        """Change a project: its models and copies, its choices, its name."""
        args = web_request.get_args()
        name = str(args.get("project") or "")
        entry = self._project_entry(name)
        if entry is None:
            raise self.server.error("That project isn't on this printer.", 404)
        nozzle = (await self._printer_profile()).get("nozzle_diameter") or 0.4
        opts, material = self._project_options(args, entry.get("options"), nozzle)
        own = entry.get("origin") == "models"
        spacing = self._project_spacing(args, entry)
        sources = None
        if "models" in args:
            await self._guard_orca()
            sources = self._project_sources(args["models"])
            if own:
                await self._export_project(name, sources, opts, material,
                                           orientations=entry.get("orientations"), spacing=spacing)
            else:
                # Someone else's project: keep it and add the models to it.
                added = [s for s in sources if s[0] not in {x.get("model") for x in entry.get("sources") or []}]
                if added:
                    original = self._projects_dir.joinpath(name)
                    keep = self.root.joinpath("tmp", f"base-{uuid.uuid4().hex[:8]}.3mf")
                    keep.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    shutil.copy2(original, keep)
                    try:
                        await self._export_project(name, added, opts, material, base=keep, spacing=spacing)
                    finally:
                        keep.unlink(missing_ok=True)
        meta: Dict[str, Any] = {"options": opts, "spacing": spacing}
        if sources is not None:
            meta["sources"] = [{"model": m, "copies": c} for m, c in sources]
            # Re-arranged: the last slice no longer matches the plate.
            # Kept, marked stale, so a print of it still counts towards this project.
            if entry.get("last_slice"):
                meta["last_slice"] = {**entry["last_slice"], "stale": True}
        self._save_project_meta(name, meta)
        new_title = str(args.get("rename") or "").strip()[:64]
        if new_title and new_title != entry["name"]:
            new_name = unique_name(self._projects_dir, re.sub(r"[/\\]", "-", new_title) + ".3mf")
            os.replace(self._projects_dir.joinpath(name), self._projects_dir.joinpath(new_name))
            if self._thumb_path(name).is_file():
                os.replace(self._thumb_path(name), self._thumb_path(new_name))
            index = self._read_json(self._projects_file)
            index[new_name] = index.pop(name, {})
            self._write_json(self._projects_file, index, 0o600)
            name = new_name
        return {"project": self._project_entry(name)}

    async def _handle_match(self, web_request: WebRequest) -> Dict[str, Any]:
        """The match check for a file already in the G-code files, so a project's
        last slice can be printed again without slicing."""
        filename = web_request.get_str("filename")
        file_manager = self.server.lookup_component("file_manager")
        root = pathlib.Path(file_manager.get_directory("gcodes")).resolve()
        target = root.joinpath(filename).resolve()
        if root not in target.parents or not target.is_file():
            raise self.server.error("That file isn't in the G-code files.", 404)
        return {"filename": filename, "match": await self._match_report(filename),
                "printer_state": await self._print_state()}

    async def _handle_project_place(self, web_request: WebRequest) -> Dict[str, Any]:
        """Turn, lay on a face, or move models on the plate: their build items'
        transforms in the project 3MF, each dropped onto the bed here. Nothing else
        in the file changes. A tilt is remembered per model file, so rebuilding the
        project (copies, added models) keeps it."""
        args = web_request.get_args()
        name = str(args.get("project") or "")
        entry = self._project_entry(name)
        if entry is None:
            raise self.server.error("That project isn't on this printer.", 404)
        await self._guard_orca()
        changes: Dict[tuple, list] = {}
        for change in args.get("changes") or []:
            try:
                key = (str(int(change["object"])), int(change.get("instance", 0)))
                transform = [float(x) for x in change["transform"]]
            except (KeyError, TypeError, ValueError):
                raise self.server.error("A placement needs a model and its transform.", 422) from None
            changes[key] = transform
        if not changes:
            raise self.server.error("Nothing to place.", 422)
        path = self._projects_dir.joinpath(name)
        try:
            written = await self.server.get_event_loop().run_in_thread(place_in_3mf, path, changes)
        except ValueError as exc:
            raise self.server.error(str(exc), 422) from exc
        except (OSError, zipfile.BadZipFile, KeyError) as exc:
            raise self.server.error("Couldn't change this project's file.", 422) from exc
        meta: Dict[str, Any] = {}
        if entry.get("last_slice"):
            meta["last_slice"] = {**entry["last_slice"], "stale": True}
        if entry.get("origin") == "models":
            with zipfile.ZipFile(path) as z:
                sources = object_sources(z.read("Metadata/model_settings.config").decode("utf-8", "replace")
                                         if "Metadata/model_settings.config" in z.namelist() else "")
            tilts = dict(entry.get("orientations") or {})
            for (obj, _), t in written.items():
                source = sources.get(obj)
                if not source:
                    continue
                # Tilted when the model's up axis no longer points up.
                if abs(t[8] - 1.0) > 1e-4:
                    tilts[source] = [round(x, 9) for x in t[:9]]
                else:
                    tilts.pop(source, None)
            meta["orientations"] = tilts
        self._save_project_meta(name, meta)
        return {"project": self._project_entry(name)}

    def _thumb_path(self, name: str) -> pathlib.Path:
        return self._projects_dir.joinpath(THUMBS_DIR, os.path.splitext(name)[0] + ".png")

    async def _handle_project_thumbnail(self, web_request: WebRequest) -> Dict[str, Any]:
        """A picture of a project's first plate, rendered by the browser:
        Orca's CLI can't render. Kept in projects/.thumbs, as Moonraker keeps G-code
        thumbnails, and marked with the project's version it shows."""
        args = web_request.get_args()
        name = str(args.get("project") or "")
        entry = self._project_entry(name)
        if entry is None:
            raise self.server.error("That project isn't on this printer.", 404)
        try:
            data = base64.b64decode(str(args.get("png") or ""), validate=True)
        except ValueError:
            data = b""
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > THUMB_MAX_BYTES:
            raise self.server.error("A thumbnail must be a PNG under 512 KB.", 422)
        path = self._thumb_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        # Saved without touching `updated`, so the thumbnail itself doesn't make it stale.
        index = self._read_json(self._projects_file)
        index.setdefault(name, {})["thumb_of"] = entry["updated"]
        self._write_json(self._projects_file, index, 0o600)
        return {"project": self._project_entry(name)}

    async def _handle_project_delete(self, web_request: WebRequest) -> Dict[str, Any]:
        name = web_request.get_str("project")
        if self._project_entry(name) is None:
            raise self.server.error("That project isn't on this printer.", 404)
        self._projects_dir.joinpath(name).unlink(missing_ok=True)
        self._thumb_path(name).unlink(missing_ok=True)
        index = self._read_json(self._projects_file)
        if index.pop(name, None) is not None:
            self._write_json(self._projects_file, index, 0o600)
        return {"deleted": name}

    # ------------------------------------------------------------ materials

    def _materials_path(self) -> pathlib.Path:
        """materials.cfg, beside printer.cfg in the printer's config folder."""
        try:
            config_dir = self.server.lookup_component("file_manager").get_directory("config")
        except Exception:
            config_dir = ""
        base = pathlib.Path(config_dir) if config_dir else self.root.parent.joinpath("config")
        return base.joinpath(MATERIALS_FILE)

    def _materials_text(self) -> str:
        path = self._materials_path()
        if not path.exists():
            text = MATERIALS_HEADER + "".join(
                "\n" + format_material(name, parent, {}) for name, parent in DEFAULT_MATERIALS)
            path.parent.mkdir(parents=True, exist_ok=True)
            self._write_text_atomic(path, text)
            logger.info("[communitycad] created %s with the generic materials", path)
            return text
        return path.read_text()

    def _write_text_atomic(self, path: pathlib.Path, text: str) -> None:
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_text(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)

    def _materials(self) -> tuple:
        return parse_materials(self._materials_text())

    # ------------------------------------------------------------ print profiles

    def _profiles_path(self) -> pathlib.Path:
        """print_profiles.cfg, beside printer.cfg, so klipper-backup keeps it."""
        return self._materials_path().with_name(PROFILES_FILE)

    def _profiles_text(self) -> str:
        path = self._profiles_path()
        try:
            return path.read_text()
        except OSError:
            return ""

    def _profiles(self) -> tuple:
        return parse_profiles(self._profiles_text())

    async def _default_profiles(self) -> list:
        """Orca's presets for this printer: resolving all of them takes over a second
        on a Pi 4, and they only change with the printer or an Orca update."""
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        printer = await self._printer_info()
        nozzle = float((await self._printer_profile()).get("nozzle_diameter") or 0.4)
        key = (((printer or {}).get("identity") or {}).get("name"), nozzle, id(profiles))
        cache = getattr(self, "_default_profiles_cache", None)
        if not cache or cache[0] != key:
            names = await self.server.get_event_loop().run_in_thread(default_profiles, profiles, key[0], nozzle)
            values = {n: process_defaults(profiles, n) for n in names}
            values.update({q: process_defaults(profiles, q) for q in SLICE_QUALITY})
            cache = (key, names, values)
            self._default_profiles_cache = cache
        return [cache[1], cache[2]]

    async def _handle_profiles(self, web_request: WebRequest) -> Dict[str, Any]:
        """Default profiles (Orca's own for this printer, read-only) and custom ones
        (print_profiles.cfg), as Orca lists System and User presets."""
        del web_request
        customs, problems = self._profiles()
        every: list = []
        if self.orca_path.is_file():
            every = (await self._default_profiles())[0]
        hidden = [n for n in self._hidden_profiles() if n in every]
        defaults = [n for n in every if n not in hidden]
        chosen = self._settings.get("default_profile")
        if chosen not in customs and chosen not in defaults:
            chosen = DEFAULT_PROFILE if DEFAULT_PROFILE in defaults else (
                defaults[0] if defaults else next(iter(customs), None))
        return {
            "path": str(self._profiles_path()),
            "defaults": [{"name": n} for n in defaults],
            "hidden": [{"name": n} for n in hidden],
            "custom": [{"name": n, "inherits": c["inherits"], "changed": len(c["values"]), "line": c["line"],
                        "values": c["values"]} for n, c in customs.items()],
            "default_profile": chosen,
            "problems": problems,
        }

    async def _handle_profile_save(self, web_request: WebRequest) -> Dict[str, Any]:
        """Write one [profile] to print_profiles.cfg: Save as profile / Update profile
        from a project, or an edit. Every other byte of the file stays."""
        args = web_request.get_args()
        name = str(args.get("name") or "").strip()
        inherits = str(args.get("inherits") or "").strip()
        values = args.get("values") or {}
        old_name = str(args.get("old_name") or "") or None
        if not isinstance(values, dict) or not all(isinstance(v, str) for v in values.values()):
            raise self.server.error("values must be Orca settings as text.", 422)
        if not MATERIAL_NAME.match(name):
            raise self.server.error(
                "Use a name of up to 64 letters, numbers, spaces and . _ - + ( ) @ / & #.", 422)
        blocked = sorted(set(values) & PROFILE_BLOCKED)
        if blocked:
            raise self.server.error(f"These can't be set in a profile: {', '.join(blocked)}", 422)
        unknown = sorted(set(values) - set(orca_process_keys()))
        if unknown:
            raise self.server.error(f"Not OrcaSlicer process settings: {', '.join(unknown)}", 422)
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        if name in profiles:
            raise self.server.error(f'"{name}" is one of Orca\'s own presets. Choose another name.', 409)
        if inherits not in profiles.process_names():
            raise self.server.error(f'"{inherits}" isn\'t an OrcaSlicer process preset.', 422)
        text = self._profiles_text() or PROFILES_HEADER
        customs, _ = parse_profiles(text)
        renaming = bool(old_name) and old_name != name
        if (args.get("create") or renaming) and name in customs:
            raise self.server.error(f'There\'s already a profile called "{name}".', 409)
        block = format_profile(name, inherits, {str(k): v for k, v in values.items()})
        text = replace_section(text, "profile", old_name if renaming and old_name in customs else name, block)
        self._write_text_atomic(self._profiles_path(), text)
        return {"saved": name}

    async def _handle_profile_detail(self, web_request: WebRequest) -> Dict[str, Any]:
        """Every Orca process setting of one profile: its value, its parent's,
        whether it changes it, and Orca's tab for it. A default profile is shown
        read-only, as a starting point."""
        name = web_request.get_str("name")
        customs, problems = self._profiles()
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        if name in customs:
            parent, own, readonly = customs[name]["inherits"], customs[name]["values"], False
            line = customs[name]["line"]
        elif name in profiles.process_names():
            parent, own, readonly, line = name, {}, True, None
        else:
            raise self.server.error(f'There\'s no print profile called "{name}".', 404)
        try:
            base = await self.server.get_event_loop().run_in_thread(profiles.resolve, parent, "Voron")
            parent_ok = True
        except ValueError:
            base, parent_ok = {}, False
        settings = []
        for key in orca_process_keys():
            if key in PROFILE_BLOCKED:
                continue
            inherited = display_value(base.get(key)) if key in base else None
            mine = own.get(key)
            settings.append({"key": key, "group": process_group(key),
                             "value": mine if mine is not None else inherited,
                             "inherited": inherited, "changed": mine is not None,
                             "common": key in PROCESS_SETTINGS})
        return {"name": name, "inherits": parent, "inherits_known": parent_ok, "readonly": readonly,
                "settings": settings,
                "problems": [p for p in problems if line and p.startswith(f"line {line}")]}

    def _hidden_profiles(self) -> list:
        """Orca's default profiles the user removed. They can't be deleted, being
        Orca's own presets, so they're left out of every list instead."""
        hidden = self._settings.get("hidden_profiles")
        return [str(n) for n in hidden] if isinstance(hidden, list) else []

    async def _handle_profile_hide(self, web_request: WebRequest) -> Dict[str, Any]:
        """POST {name, hidden}: remove one of Orca's default profiles from the lists,
        or bring it back. Never the last profile left; the default for new
        projects moves on when it's the one removed."""
        args = web_request.get_args()
        name = str(args.get("name") or "")
        hide = bool(args.get("hidden", True))
        every = (await self._default_profiles())[0] if self.orca_path.is_file() else []
        if name not in every:
            raise self.server.error(f'"{name}" isn\'t one of Orca\'s default profiles for this printer.', 404)
        hidden = [n for n in self._hidden_profiles() if n in every and n != name]
        moved = None
        if hide:
            customs, _ = self._profiles()
            left = [n for n in every if n not in hidden and n != name] + list(customs)
            if not left:
                raise self.server.error("That's the last print profile. Make another one before removing it.", 409)
            hidden.append(name)
            if (self._settings.get("default_profile") or DEFAULT_PROFILE) == name:
                moved = left[0]
                self._settings["default_profile"] = moved
        self._settings["hidden_profiles"] = hidden
        self._save_settings()
        return {"hidden": hidden, "default_profile": self._settings.get("default_profile"), "moved_to": moved}

    async def _handle_profile_delete(self, web_request: WebRequest) -> Dict[str, Any]:
        name = web_request.get_str("name")
        text = self._profiles_text()
        customs, _ = parse_profiles(text)
        if name not in customs:
            raise self.server.error(f'There\'s no custom profile called "{name}".', 404)
        self._write_text_atomic(self._profiles_path(), replace_section(text, "profile", name, None))
        return {"deleted": name}

    def _orca_profiles(self) -> OrcaProfiles:
        cached = getattr(self, "_profiles_cache", None)
        if cached is None:
            profiles_dir = self.orca_path.resolve().parent.joinpath("resources", "profiles")
            if not profiles_dir.is_dir():
                raise self.server.error(
                    ORCA_MISSING, 503)
            cached = OrcaProfiles(profiles_dir)
            self._profiles_cache = cached
        return cached

    async def _handle_bed(self, web_request: WebRequest) -> Dict[str, Any]:
        """The bed Orca draws for this printer: its model and texture, read from
        the Orca installed on this Pi. Never shipped with the plugin. Empty when the
        printer isn't recognised or Orca isn't installed: the UI draws a plain plate."""
        del web_request
        empty: Dict[str, Any] = {"name": None, "model": None, "texture": None, "texture_type": None}
        printer = await self._printer_info()
        name = ((printer or {}).get("identity") or {}).get("name")
        if not name or not self.orca_path.is_file():
            return empty
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        files = profiles.bed_files(name)
        out = {**empty, "name": name}
        if files["model"] and files["model"].stat().st_size <= BED_FILE_MAX:
            out["model"] = base64.b64encode(files["model"].read_bytes()).decode()
        texture = files["texture"]
        if texture and texture.stat().st_size <= BED_FILE_MAX:
            out["texture"] = base64.b64encode(texture.read_bytes()).decode()
            out["texture_type"] = "image/svg+xml" if texture.suffix.lower() == ".svg" else "image/png"
        return out

    async def _handle_process(self, web_request: WebRequest) -> Dict[str, Any]:
        """The settings the plugin lets a user change, with each preset's own
        values, so the UI can show them and mark what was changed."""
        del web_request
        if not self.orca_path.is_file():
            raise self.server.error(
                ORCA_MISSING, 503)
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        nozzle = float((await self._printer_profile()).get("nozzle_diameter") or 0.4)
        settings = {}
        for key, spec in PROCESS_SETTINGS.items():
            entry = {k: (list(v) if isinstance(v, tuple) else v) for k, v in spec.items() if k != "nozzle_share"}
            if "nozzle_share" in spec:
                entry["max"] = round(nozzle * spec["nozzle_share"], 3)
            settings[key] = entry
        # Each profile's own values, defaults and customs alike, keyed by name;
        # the old quality keys stay for older UIs.
        values = dict((await self._default_profiles())[1])
        customs, _ = self._profiles()
        for n in customs:
            try:
                values[n] = process_defaults(profiles, self._profile_for(n))
            except ValueError:
                continue
        return {"nozzle": nozzle, "settings": settings, "defaults": values}

    async def _handle_materials(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        materials, problems = self._materials()
        return {
            "path": str(self._materials_path()),
            "materials": [
                {"name": name, "inherits": m["inherits"], "changed": len(m["values"]), "line": m["line"],
                 **material_look(name, m)}
                for name, m in materials.items()
            ],
            "problems": problems,
        }

    async def _handle_material_detail(self, web_request: WebRequest) -> Dict[str, Any]:
        """Every Orca filament setting for one material: its value, its parent's
        value, and whether this material changes it."""
        name = web_request.get_str("name")
        materials, problems = self._materials()
        material = materials.get(name)
        if material is None:
            raise self.server.error(f'There\'s no material called "{name}".', 404)
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        parent = material["inherits"]
        try:
            base = profiles.resolve(parent) if parent else profiles.resolve("fdm_filament_common")
            parent_ok = True
        except ValueError:
            base, parent_ok = {}, False
        settings = []
        for key in orca_filament_keys():
            inherited = display_value(base.get(key)) if key in base else None
            own = material["values"].get(key)
            settings.append({
                "key": key,
                "group": filament_group(key),
                "value": own if own is not None else inherited,
                "inherited": inherited,
                "changed": own is not None,
            })
        return {"name": name, "inherits": parent, "inherits_known": parent_ok,
                "settings": settings,
                "problems": [p for p in problems if f"line {material['line']}" in p]}

    def _save_material(self, name: str, inherits: str, values: Dict[str, str],
                       old_name: Optional[str] = None, create: bool = False) -> None:
        if not MATERIAL_NAME.match(name or ""):
            raise self.server.error(
                "Use a name of up to 64 letters, numbers, spaces and . _ - + ( ) @ / & #.", 422)
        known = set(orca_filament_keys())
        unknown = sorted(set(values) - known)
        if unknown:
            raise self.server.error(f"Not OrcaSlicer filament settings: {', '.join(unknown)}", 422)
        for key, value in values.items():
            if not isinstance(value, str):
                raise self.server.error(f"{key} must be text.", 422)
        if inherits and inherits not in self._orca_profiles():
            raise self.server.error(f'"{inherits}" isn\'t an OrcaSlicer filament preset.', 422)
        text = self._materials_text()
        materials, _ = parse_materials(text)
        renaming = bool(old_name) and old_name != name
        if (create or renaming) and name in materials:
            raise self.server.error(f'There\'s already a material called "{name}".', 409)
        block = format_material(name, inherits, values)
        if renaming and old_name in materials:
            text = replace_material(text, old_name, block)
        else:
            text = replace_material(text, name, block)
        self._write_text_atomic(self._materials_path(), text)

    async def _handle_material_save(self, web_request: WebRequest) -> Dict[str, Any]:
        args = web_request.get_args()
        name = str(args.get("name") or "").strip()
        values = args.get("values") or {}
        if not isinstance(values, dict):
            raise self.server.error("values must be an object of Orca settings.", 422)
        await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        self._save_material(name, str(args.get("inherits") or "").strip(),
                            {str(k): v for k, v in values.items()},
                            old_name=str(args.get("old_name") or "") or None,
                            create=bool(args.get("create")))
        return {"saved": name}

    async def _handle_material_delete(self, web_request: WebRequest) -> Dict[str, Any]:
        name = web_request.get_str("name")
        text = self._materials_text()
        materials, _ = parse_materials(text)
        if name not in materials:
            raise self.server.error(f'There\'s no material called "{name}".', 404)
        if len(materials) == 1:
            raise self.server.error("Keep at least one material, or slicing has nothing to use.", 409)
        self._write_text_atomic(self._materials_path(), replace_material(text, name, None))
        return {"deleted": name}

    async def _handle_material_import(self, web_request: WebRequest) -> Dict[str, Any]:
        """An OrcaSlicer filament preset (.json) becomes a [material], unchanged.

        A user preset keeps its parent and its own values. A full export with no
        known parent keeps every filament setting it carries.
        """
        args = web_request.get_args()
        preset = args.get("preset")
        if isinstance(preset, str):
            try:
                preset = json.loads(preset)
            except ValueError as exc:
                raise self.server.error("That file isn't valid JSON.", 422) from exc
        if not isinstance(preset, dict) or preset.get("type", "filament") != "filament":
            raise self.server.error("That isn't an OrcaSlicer filament preset.", 422)
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        name = str(args.get("name") or preset.get("name") or "").strip()
        parent = str(preset.get("inherits") or "")
        if parent and parent not in profiles:
            parent = ""
        known = set(orca_filament_keys())
        values = {k: display_value(v) for k, v in preset.items() if k in known}
        skipped = sorted(k for k in preset if k not in known and k not in (
            "name", "inherits", "type", "from", "setting_id", "filament_id", "instantiation",
            "version", "is_custom_defined", "filament_settings_id", "compatible_printers",
            "compatible_printers_condition", "compatible_prints", "compatible_prints_condition"))
        self._save_material(name, parent, values, create=True)
        return {"saved": name, "inherits": parent, "settings": len(values), "skipped": skipped}

    async def _handle_orca_import(self, web_request: WebRequest) -> Dict[str, Any]:
        """Presets exported from desktop OrcaSlicer: a .json, a .zip or a bundle.
        Process presets become [profile]s in print_profiles.cfg, filament presets
        [material]s in materials.cfg; printer presets are skipped, since the printer
        comes from printer.cfg. Without `apply` it only says what it would do."""
        args = web_request.get_args()
        try:
            data = base64.b64decode(str(args.get("data") or ""), validate=True)
        except ValueError:
            raise self.server.error("The file didn't arrive whole. Try again.", 422) from None
        try:
            presets = read_preset_files(str(args.get("filename") or "preset.json"), data)
        except ValueError as exc:
            raise self.server.error(str(exc), 422) from exc
        loop = self.server.get_event_loop()
        profiles = await loop.run_in_thread(self._orca_profiles)
        defaults = (await self._default_profiles())[0]
        customs, _ = self._profiles()
        materials, _ = self._materials()
        items, seen = [], set()
        for path, preset in presets:
            kind = preset_kind(path, preset)
            name = safe_preset_name(preset.get("name") or pathlib.Path(path).stem)
            if kind == "machine":
                items.append({"kind": "printer", "name": name, "action": "skip",
                              "note": "the printer comes from printer.cfg"})
                continue
            if kind not in ("process", "filament") or (kind, name) in seen:
                continue
            seen.add((kind, name))
            plan = await loop.run_in_thread(
                (lambda pr=preset: plan_process_import(profiles, pr, defaults)) if kind == "process"
                else (lambda pr=preset: plan_filament_import(profiles, pr)))
            exists = name in (customs if kind == "process" else materials)
            if kind == "process" and name in profiles:
                name = f"{name} (mine)"[:64]
                exists = name in customs
            items.append({"kind": "profile" if kind == "process" else "material", "name": name,
                          "action": "replace" if exists else "add", "inherits": plan["inherits"],
                          "settings": len(plan["values"]), "dropped": plan["dropped"],
                          "skipped": plan["skipped"], "note": plan["note"], "_values": plan["values"]})
        if not any(i["action"] != "skip" for i in items):
            raise self.server.error("No process or filament presets were found in that file.", 422)
        if args.get("apply"):
            text = self._profiles_text() or PROFILES_HEADER
            for item in items:
                if item["kind"] == "profile":
                    text = replace_section(text, "profile", item["name"],
                                           format_profile(item["name"], item["inherits"], item["_values"]))
            if any(i["kind"] == "profile" for i in items):
                self._write_text_atomic(self._profiles_path(), text)
            for item in items:
                if item["kind"] == "material":
                    self._save_material(item["name"], item["inherits"], item["_values"])
        for item in items:
            item.pop("_values", None)
        return {"items": items, "applied": bool(args.get("apply"))}

    async def _handle_orca_export(self, web_request: WebRequest) -> Dict[str, Any]:
        """Custom profiles and materials as OrcaSlicer user presets, for
        desktop Orca's File > Import > Import Configs: one as a .json, or all of
        them as a .zip with process/ and filament/ folders."""
        args = web_request.get_args()
        kind = str(args.get("kind") or "all")
        name = str(args.get("name") or "")
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        version = self.orca_path.resolve().parent.name + ".0"
        customs, _ = self._profiles()
        materials, _ = self._materials()
        chosen = []
        if kind in ("all", "profile"):
            chosen += [("process", n, c) for n, c in customs.items() if kind == "all" or n == name]
        if kind in ("all", "material"):
            chosen += [("filament", n, m) for n, m in materials.items() if kind == "all" or n == name]
        if not chosen:
            raise self.server.error("There's nothing to export.", 404)
        files = [(f"{'process' if k == 'process' else 'filament'}/{n}.json",
                  json.dumps(orca_user_preset(k, n, e["inherits"], e["values"], profiles, version), indent=4))
                 for k, n, e in chosen]
        if kind != "all":
            path, text = files[0]
            return {"filename": f"{name}.json", "data": base64.b64encode(text.encode()).decode()}
        import io
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for path, text in files:
                z.writestr(path, text)
        return {"filename": "CommunityCAD presets.zip", "data": base64.b64encode(buf.getvalue()).decode()}

    async def _handle_material_presets(self, web_request: WebRequest) -> Dict[str, Any]:
        """Orca filament presets a material can inherit from, for the editor."""
        del web_request
        profiles = await self.server.get_event_loop().run_in_thread(self._orca_profiles)
        return {"presets": sorted(profiles.filaments)}

    # ------------------------------------------------------------- slicing

    async def _print_state(self) -> Optional[str]:
        try:
            kapis: KlippyAPI = self.server.lookup_component("klippy_apis")
            result = await kapis.query_objects({"print_stats": None}, default={})
            return str((result.get("print_stats") or {}).get("state") or "") or None
        except Exception:
            return None

    def _slice_view(self) -> Dict[str, Any]:
        job = self._slice
        if job is None:
            return {"state": "idle"}
        view = {k: v for k, v in job.items() if not k.startswith("_")}
        if job["state"] == "slicing":
            view["elapsed_s"] = round(time.monotonic() - job["_t0"], 1)
        return view

    async def _handle_slice(self, web_request: WebRequest) -> Dict[str, Any]:
        """GET: the current or last slice. POST: start one.

        One at a time, never while printing (slicing during a print hasn't been
        measured yet), at low priority on two cores, with a time limit.
        """
        if web_request.get_request_type() != RequestType.POST:
            return self._slice_view()

        if self._slice is not None and self._slice["state"] == "slicing":
            raise self.server.error("Already slicing. Wait for it to finish, or cancel it.", 409)
        args = web_request.get_args()
        if self._orca_busy:
            raise self.server.error("OrcaSlicer is busy with a project. Try again in a moment.", 409)
        project_name = str(args.get("project") or "") or None
        if project_name:
            entry = self._project_entry(project_name)
            if entry is None:
                raise self.server.error("That project isn't on this printer.", 404)
            key = project_name
            source_path = self._projects_dir.joinpath(project_name)
            own_project = entry.get("origin") == "models"
            display_name = os.path.splitext(project_name)[0]
        else:
            key = str(args.get("id") or "")
            entry = self._model_entry(key)
            if entry is None:
                raise self.server.error("That model isn't on this printer.", 404)
            if not entry["usable"]:
                raise self.server.error(f"{key} isn't a model file the printer can slice.", 422)
            source_path = self._models_dir.joinpath(key)
            own_project = False
            display_name = str(entry.get("filename") or key)
        nozzle = (await self._printer_profile()).get("nozzle_diameter") or 0.4
        options, material = self._project_options(
            args, (entry.get("options") if project_name else None), nozzle)
        if self._settings.get("last_material") != options["material"]:
            self._settings["last_material"] = options["material"]
            self._save_settings()

        if not self.orca_path.is_file():
            raise self.server.error(
                ORCA_MISSING, 503)
        state = await self._print_state()
        if state in BUSY_PRINT_STATES:
            raise self.server.error(
                "The printer is printing. Slicing waits until the print is done, so it "
                "can't affect it.", 409)
        volume = await self._effective_build_volume()
        if not volume:
            if self._permission(PERMISSION_SETTINGS) is not True:
                raise self.server.error(
                    "Slicing needs this printer's bed size. Allow reading the printer's settings "
                    "in Settings, or type the bed size there.", 409)
            raise self.server.error(
                "This printer's bed size isn't known, so it can't be sliced for. Set it in Settings.", 409)
        profile = await self._printer_profile()
        printer = await self._printer_info()

        self._slice = {
            "id": uuid.uuid4().hex[:12],
            "model": key,
            "filename": entry.get("filename"),
            "state": "slicing",
            "options": options,
            "_material": material,
            "_printer": printer,
            "_t0": time.monotonic(),
        }
        job = self._slice
        run_entry = {**entry, "_source": str(source_path), "_own": own_project,
                     "_project": project_name, "_name": display_name}
        self.server.get_event_loop().create_task(
            self._run_slice(job, run_entry, volume, profile.get("nozzle_diameter") or 0.4))
        return self._slice_view()

    async def _handle_slice_send(self, web_request: WebRequest) -> Dict[str, Any]:
        """Send one sliced plate to the printer's G-code files (Orca's Send; Print plate
        is this, then the usual confirm). Never starts a print. Thumbnails rendered by
        the browser go into the G-code as Orca writes them, so Mainsail shows them:
        Orca's CLI can't render."""
        args = web_request.get_args()
        job = self._slice
        if job is None or job.get("state") != "done" or not job.get("_send"):
            raise self.server.error("There's no slice waiting to be sent. Slice again.", 409)
        try:
            number = int(args.get("plate", 1))
        except (TypeError, ValueError):
            number = -1
        # Where it goes: this send's choice, else the printer's default (Settings).
        # "" is the top of the G-code files; a folder is created if it's new.
        folder = self._send_folder()
        if "folder" in args:
            try:
                folder = clean_send_folder(args.get("folder"))
            except ValueError as exc:
                raise self.server.error(str(exc), 422) from exc
        plate = next((p for p in job.get("plates") or [] if p["plate"] == number), None)
        if plate is None:
            raise self.server.error("That plate isn't in this slice.", 404)
        if plate.get("gcode"):
            return {"plate": plate, "printer_state": await self._print_state()}
        info = job["_send"]
        source = pathlib.Path(info["dir"]).joinpath(f"plate_{number}.gcode")
        if not source.is_file():
            raise self.server.error("This slice is gone from the printer. Slice again.", 409)
        thumbs = []
        for t in (args.get("thumbnails") or [])[:4]:
            try:
                w, h = int(t["width"]), int(t["height"])
                data = base64.b64decode(str(t["png"]), validate=True)
            except (KeyError, TypeError, ValueError):
                raise self.server.error("A thumbnail needs a width, a height and a PNG.", 422) from None
            if not (16 <= w <= 1024 and 16 <= h <= 1024) or not data.startswith(b"\x89PNG\r\n\x1a\n") \
                    or len(data) > GCODE_THUMB_MAX:
                raise self.server.error("Thumbnails must be PNGs from 16 to 1024 px, under 256 KB.", 422)
            thumbs.append((w, h, data))
        loop = self.server.get_event_loop()
        if thumbs:
            await loop.run_in_thread(insert_gcode_thumbnails, source, thumbs)
        file_manager = self.server.lookup_component("file_manager")
        gdir = pathlib.Path(file_manager.get_directory("gcodes")).joinpath(folder)
        stem = info["base"] if info["single"] else f"{os.path.splitext(info['base'])[0]}-plate{number}"
        filename = sliced_filename(stem, job["options"]["material"], info["detail"], gdir)
        await file_manager.finalize_upload({
            "filename": filename, "root": "gcodes", "path": folder,
            "tmp_file_path": str(source), "print": "false",
        })
        stored = f"{folder}/{filename}" if folder else filename
        on_plate, own_parts = await loop.run_in_thread(self._plate_models, info["project"], number)
        self._record_in_library(stored, {
            **info["library"], "project": info["project"], "plate": number, "bytes": None,
            # What was on this plate, not every model in the project.
            "models": on_plate if on_plate or own_parts else self._catalog_models_of(info["project"], info["library"]),
            "own_parts": own_parts,
            "sent_at": time.time(), "sliced": {**job["options"], "project": info["foreign"], "orca": True},
        })
        plate["gcode"] = stored
        plate["match"] = await self._match_report(stored)
        if info["project"]:
            entry = self._project_entry(info["project"])
            previous = (entry or {}).get("last_slice") or {}
            sent = list(previous.get("gcodes") or []) if previous.get("job") == job["id"] else []
            self._save_project_meta(info["project"], {"options": job["options"], "last_slice": {
                "at": time.time(), "job": job["id"], "gcodes": sent + [stored]}})
        logger.info("[communitycad] sent plate %d as %s", number, stored)
        return {"plate": plate, "printer_state": await self._print_state()}

    async def _handle_slice_cancel(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        proc = self._slice_proc
        if self._slice is not None and self._slice["state"] == "slicing" and proc is not None:
            self._slice["_cancelled"] = True
            _kill_group(proc)
        return self._slice_view()

    def _finish_slice(self, job: Dict[str, Any], state: str, **fields: Any) -> None:
        job.update(fields)
        job["state"] = state
        job["seconds"] = round(time.monotonic() - job["_t0"], 1)

    async def _orca(self, args: list, work: pathlib.Path) -> tuple:
        """Run OrcaSlicer as a separate program: low priority, cores 2-3, a time
        limit, its own process group so stopping it stops everything it started.
        Returns (exit code, stderr); raises asyncio.TimeoutError after the limit."""
        prefix = ["nice", "-n", "19"]
        if shutil.which("ionice"):
            prefix += ["ionice", "-c3"]
        if shutil.which("taskset") and (os.cpu_count() or 1) >= 4:
            prefix += ["taskset", "-c", SLICE_CPUS]
        env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
        self._slice_proc = await asyncio.create_subprocess_exec(
            *prefix, str(self.orca_path), *args, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE, cwd=str(work), env=env, start_new_session=True)
        try:
            _, err = await asyncio.wait_for(self._slice_proc.communicate(), SLICE_TIMEOUT_S)
        except asyncio.TimeoutError:
            _kill_group(self._slice_proc)
            await self._slice_proc.wait()
            raise
        finally:
            proc, self._slice_proc = self._slice_proc, None
        return proc.returncode, err

    @staticmethod
    def _orca_failure(out: pathlib.Path, code: Optional[int], err: bytes) -> str:
        """A plain message for an Orca run that produced nothing."""
        result: Dict[str, Any] = {}
        try:
            result = json.loads(out.joinpath("result.json").read_text())
        except (OSError, ValueError):
            pass
        rc = result.get("return_code", code)
        # Orca names the exact setting it rejects on stderr: pass it on.
        detail = [ln.strip() for ln in (err or b"").decode("utf-8", "replace").splitlines()
                  if ":" in ln and not ln.lower().startswith("param values")][-3:]
        if code is not None and code < 0 and not result:
            return "OrcaSlicer stopped unexpectedly on this model. Nothing was saved."
        message = ORCA_ERRORS.get(rc) or (
            f"OrcaSlicer couldn't slice this model ({result.get('error_string') or rc}).")
        if "Invalid parameter" in str(result.get("error_string")):
            message += " " + "; ".join(detail)
        if "unprintable area" in str(result.get("error_string")):
            # Orca's wording mentions multi-extruder printers whatever the printer.
            message = ("Part of the print would be outside the bed: usually the skirt or brim "
                       "of a model near the edge. Arrange the plate again, or make the skirt or "
                       "brim smaller.")
        logger.warning("[communitycad] orca failed: exit %s, %s: %s",
                       code, result.get("error_string"), (err or b"")[-300:])
        return message

    async def _write_presets(self, work: pathlib.Path, volume: Dict[str, Any], nozzle: float,
                             material: Dict[str, Any], opts: Dict[str, Any],
                             printer: Optional[Dict[str, Any]]) -> Dict[str, pathlib.Path]:
        loop = self.server.get_event_loop()
        profiles = await loop.run_in_thread(self._orca_profiles)
        presets = await loop.run_in_thread(
            slice_presets, profiles, volume, float(nozzle), material,
            self._profile_for(opts.get("profile") or SLICE_QUALITY.get(str(opts.get("quality")), DEFAULT_PROFILE)),
            opts.get("process") or {}, printer)
        paths = {}
        for name, preset in presets.items():
            paths[name] = work.joinpath(f"{name}.json")
            paths[name].write_text(json.dumps(preset))
        return paths

    async def _run_slice(self, job: Dict[str, Any], entry: Dict[str, Any],
                         volume: Dict[str, Any], nozzle: float) -> None:
        """Run Orca on a model or a project and hand every plate's G-code to the
        G-code files.

        Every failure, a crash included, ends as a plain message with nothing left
        in the G-code files and the work folder removed.
        """
        work = self.root.joinpath("tmp", f"slice-{job['id']}")
        try:
            work.mkdir(mode=0o700, parents=True, exist_ok=True)
            out = work.joinpath("out")
            out.mkdir()
            opts = job["options"]
            loop = self.server.get_event_loop()
            pr = job.get("_printer") or {}
            job["printer"] = (pr.get("identity") or {}).get("name")
            job["assumed"] = ([f"a {DEFAULT_BED_SURFACE.replace('_', ' ')} bed: add variable_bed_surface "
                               f"to [gcode_macro {FACTS_MACRO}] in printer.cfg to change it"]
                              if pr.get("bed_surface_assumed", True) else [])
            presets = await self._write_presets(work, volume, nozzle, job["_material"], opts, pr)

            source = pathlib.Path(entry["_source"])
            own = bool(entry.get("_own"))
            foreign = source.suffix == ".3mf" and not own and is_3mf_project(source)
            job["project"] = foreign
            args = ["--slice", "0", "--outputdir", str(out)]
            if foreign:
                # Someone else's project keeps its own settings; only the printer is
                # swapped (bringing the creator's intent over this printer's tuning is planned).
                args += ["--load-settings", str(presets["machine"])]
            else:
                if not own:
                    args += ["--arrange", "1", "--orient", "0"]
                args += ["--load-settings", f"{presets['machine']};{presets['process']}",
                         "--load-filaments", str(presets["filament"])]
            args.append(str(source))
            try:
                code, err = await self._orca(args, work)
            except asyncio.TimeoutError:
                self._finish_slice(job, "failed", error="Slicing took too long and was stopped.")
                return
            if job.get("_cancelled"):
                self._finish_slice(job, "cancelled")
                return

            plates = sorted(out.glob("plate_*.gcode"),
                            key=lambda p: int(re.sub(r"\D", "", p.stem) or 0))
            if code != 0 or not plates:
                self._finish_slice(job, "failed", error=self._orca_failure(out, code, err))
                return

            base = str(entry.get("_name") or entry.get("filename") or "model")
            # The layer height actually sliced: the project's change, else the profile's.
            layer = (opts.get("process") or {}).get("layer_height") or \
                json.loads(pathlib.Path(presets["process"]).read_text()).get("layer_height") or "0.2"
            detail = "project" if foreign else f"{float(layer):.2f}mm"
            # Only the newest slice waits to be sent: one slice at a time, as in Orca.
            staged_root = self._projects_dir.joinpath(STAGED_DIR)
            shutil.rmtree(staged_root, ignore_errors=True)
            staged = staged_root.joinpath(job["id"])
            staged.mkdir(parents=True, exist_ok=True)
            results = []
            capped_total = 0
            for gcode in plates:
                number = int(re.sub(r"\D", "", gcode.stem) or 1)
                capped_total += await loop.run_in_thread(
                    clamp_gcode_limits, gcode, pr.get("max_accel"), pr.get("max_velocity"))
                summary = await loop.run_in_thread(gcode_summary, gcode)
                target = staged.joinpath(f"plate_{number}.gcode")
                shutil.move(str(gcode), target)
                results.append({"plate": number, "gcode": None, "summary": summary,
                                "staged": f"{PROJECTS_ROOT}/{STAGED_DIR}/{job['id']}/{target.name}"})
            job["_send"] = {
                "base": base, "detail": detail, "single": len(plates) == 1, "foreign": foreign,
                "library": {k: entry.get(k) for k in ("model_id", "file_id", "title", "slug")},
                "project": entry.get("_project"), "dir": str(staged),
            }
            if capped_total:
                job["capped"] = (f"{capped_total} acceleration or speed settings were above this "
                                 f"printer's limits ({pr.get('max_accel'):g} mm/s², "
                                 f"{pr.get('max_velocity'):g} mm/s) and were lowered to them")
            self._finish_slice(job, "done", summary=results[0]["summary"], plates=results,
                               printer_state=await self._print_state())
            logger.info("[communitycad] sliced %s into %d plate(s)", base, len(results))
        except Exception as exc:
            logger.exception("[communitycad] slicing failed")
            self._finish_slice(job, "failed", error=f"Slicing failed: {exc}")
        finally:
            self._slice_proc = None
            shutil.rmtree(work, ignore_errors=True)

    async def _handle_download_url(self, web_request: WebRequest) -> Dict[str, Any]:
        """A link the browser can download one file from, for "Download to this device".

        Model files (STL, STEP, unsliced 3MF) can't go to the printer until there is
        a slicer on it, so this is how they reach a slicer. Only the presigned
        URL crosses to the browser -- never the token -- and it is not logged.
        """
        if not self._token:
            raise self.server.error("Connect this printer to CommunityCAD first.", 409)
        model_id = web_request.get_int("model_id")
        file_id = web_request.get_int("file_id")
        _, entry, name = await self._catalog_file(model_id, file_id)
        url = await self._download_url(model_id, file_id)
        return {"url": url, "filename": name, "size_bytes": entry.get("size_bytes")}

    async def _handle_send(self, web_request: WebRequest) -> Dict[str, Any]:
        """Download one file from CommunityCAD and put it in the printer's G-code files.

        The same path a slicer upload takes: the file lands in a temp file well
        outside the G-code folder, is checked, and only then handed to Moonraker's
        file manager, which moves it into place and scans its metadata. A download
        that dies half way leaves a stray temp file and nothing else -- never a
        truncated file sitting in the print queue looking ready.

        Deliberately does not start prints. That needs the printer-match check, which
        is a separate piece of work; shipping a start path before its safety check
        exists is exactly the kind of thing the project rules forbid.
        """
        self._require_notice()
        if not self._token:
            raise self.server.error("Connect this printer to CommunityCAD first.", 409)

        model_id = web_request.get_int("model_id")
        file_id = web_request.get_int("file_id")

        detail, entry, name = await self._catalog_file(model_id, file_id)
        if not name.lower().endswith(SENDABLE_EXTS):
            raise self.server.error(
                f"{name} is a model file, not a print job. Download it and slice it, "
                "then send the G-code.",
                422,
            )

        url = await self._download_url(model_id, file_id)
        tmp_dir, tmp_path, actual = await self._download_to_tmp(url, entry, name, key=f"{model_id}:{file_id}")

        # A sliced 3MF carries one G-code file per plate; everything else is one
        # G-code file already. From here on both are a list of files to hand over.
        if name.lower().endswith(SLICED_3MF_EXT):
            stem = name[: -len(SLICED_3MF_EXT)]
            try:
                free = shutil.disk_usage(tmp_dir).free
                plates = await self.server.get_event_loop().run_in_thread(
                    extract_plates, tmp_path, tmp_dir, free)
            except PlateError as exc:
                raise self.server.error(str(exc), 422) from exc
            finally:
                tmp_path.unlink(missing_ok=True)
            single = len(plates) == 1
            items = [
                (f"{stem}.gcode" if single else f"{stem}-plate{number}.gcode", path, size, number)
                for number, path, size in plates
            ]
        else:
            items = [(name, tmp_path, actual, None)]

        folder = self._send_folder()
        file_manager = self.server.lookup_component("file_manager")
        saved: list = []
        try:
            for index, (filename, path, size, plate) in enumerate(items):
                try:
                    # finalize_upload removes the temp file itself on failure.
                    result = await file_manager.finalize_upload({
                        "filename": filename,
                        "root": "gcodes",
                        "path": folder,
                        "tmp_file_path": str(path),
                        "print": "false",
                    })
                except Exception as exc:
                    logger.exception("[communitycad] could not add %s to the G-code files", filename)
                    raise self.server.error(
                        f"Could not add {filename} to your files: {exc}", 500) from exc

                stored = f"{folder}/{filename}" if folder else filename
                entry = {
                    "model_id": model_id,
                    "file_id": file_id,
                    "title": detail.get("title"),
                    "slug": detail.get("slug"),
                    "bytes": size,
                    "sent_at": time.time(),
                }
                if plate is not None:
                    entry["plate"] = plate
                self._record_in_library(stored, entry)
                logger.info("[communitycad] sent %s to the G-code files", stored)
                saved.append({
                    "filename": stored,
                    "bytes": size,
                    "plate": plate,
                    # Reported here so the UI can warn before offering to start
                    # anything. Metadata is scanned during finalize_upload.
                    "match": await self._match_report(stored),
                    "upload": result,
                })
        finally:
            # Plates not handed over (a later one failed) must not linger as temp files.
            for _, path, _, _ in items[len(saved):]:
                pathlib.Path(path).unlink(missing_ok=True)

        first = saved[0]
        return {
            "filename": first["filename"],
            "bytes": first["bytes"],
            "print_started": False,
            # So the confirm can say "Add to queue" when the printer is busy.
            "printer_state": await self._print_state(),
            "match": first["match"],
            "upload": first["upload"],
            # Every file this send produced: one, or one per plate of a sliced 3MF.
            "files": [{k: f[k] for k in ("filename", "bytes", "plate", "match")} for f in saved],
        }

    # ------------------------------------------------------------- handlers

    async def _handle_status(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        volume = await self._effective_build_volume()
        pending = None
        if self._link is not None and self._link.get("pending"):
            pending = {
                "user_code": self._link["user_code"],
                "verification_uri": self._link["verification_uri"],
                "verification_uri_complete": self._link["verification_uri_complete"],
                "expires_at": self._link["expires_at"],
                "upgrade": bool(self._link.get("upgrade")),
                "added": self._link.get("added"),
            }
        return {
            "component_version": COMPONENT_VERSION,
            "api_base": self.api_base,
            "linked": bool(self._token),
            "account": {"username": self._creds.get("username"), "scopes": self._scopes(),
                        "can_share": self._can_share()} if self._token else None,
            "printer_name": self._default_printer_name(),
            "build_volume": volume,
            "link_pending": pending,
            "link_error": (self._link or {}).get("error"),
            "default_tab": self._settings.get("default_tab", "fits"),
            "send_folder": self._send_folder(),
            "file_type": self._file_type(),
            # None until the user has answered; nothing is read before a yes.
            "permissions": {k: self._permission(k) for k in PERMISSIONS},
            "notice": {"version": NOTICE_VERSION, "accepted": self._notice_accepted()},
            "share_prompt": self._share_mode() == "ask",
            "share_after_print": self._share_mode(),
            "share_visibility": self._share_visibility(),
            # Too old means "Update available", pointing at the
            # interface's update manager. Null until the API has told us.
            "min_plugin_version": self._min_version,
            "update_required": is_outdated(COMPONENT_VERSION, self._min_version),
            # null when we cannot tell, which the UI must not render as a problem.
            "injection_healthy": self._injection_healthy(),
        }

    async def _handle_link_start(self, web_request: WebRequest) -> Dict[str, Any]:
        if self._token:
            raise self.server.error("This printer is already linked.", 409)
        self._cancel_link_task()

        device_name = web_request.get_str("device_name", self._default_printer_name())
        payload = await self._guard(self._api(
            "POST", "/auth/device/code",
            body={
                "client_name": CLIENT_NAME,
                "client_version": COMPONENT_VERSION,
                "device_name": device_name,
                "scope": LINK_SCOPES,
            },
        ))

        interval = float(payload.get("interval") or 5)
        expires_in = float(payload.get("expires_in") or 600)
        self._link = {
            "pending": True,
            "error": None,
            "user_code": payload["user_code"],
            "verification_uri": payload["verification_uri"],
            "verification_uri_complete": payload["verification_uri_complete"],
            "expires_at": time.time() + expires_in,
        }
        deadline = time.monotonic() + expires_in + LINK_POLL_GRACE_S
        self._link_task = self.eventloop.create_task(
            self._poll_for_token(payload["device_code"], interval, deadline)
        )
        return {
            "user_code": self._link["user_code"],
            "verification_uri": self._link["verification_uri"],
            "verification_uri_complete": self._link["verification_uri_complete"],
            "expires_in": int(expires_in),
            "interval": int(interval),
        }

    async def _handle_link_cancel(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        self._cancel_link_task()
        self._link = None
        return {"cancelled": True}

    async def _handle_unlink(self, web_request: WebRequest) -> Dict[str, Any]:
        del web_request
        self._cancel_link_task()
        self._link = None
        if not self._token:
            return {"linked": False}
        revoked = True
        try:
            # Revoke on the server so the token dies everywhere, not just here.
            await self._api("DELETE", "/auth/tokens/current", authed=True)
        except CommunityCADError as exc:
            # Already-invalid tokens and an unreachable site both end the same way:
            # the local copy goes. Leaving it behind would strand the user.
            revoked = exc.reason == "unlinked"
            logger.warning("[communitycad] remote revoke failed: %s", exc.message)
        self._clear_credentials()
        self.server.send_event(NOTIFY_LINKED, {"linked": False})
        return {"linked": False, "revoked_remotely": revoked}

    async def _handle_rename(self, web_request: WebRequest) -> Dict[str, Any]:
        """Rename this printer as it appears in the user's Connected printers list.

        The name lives on the token server-side, so renaming is an API call, not a
        local setting. Kept locally too so the UI can show it while offline.
        """
        name = web_request.get_str("name", "").strip()
        if not name:
            raise self.server.error("A printer name is required.", 400)
        if not self._token:
            raise self.server.error("This printer is not linked.", 409)
        await self._guard(
            self._api("PATCH", "/auth/tokens/current", body={"name": name}, authed=True)
        )
        self._settings["printer_name"] = name
        self._save_settings()
        return {"printer_name": name}

    async def _handle_search(self, web_request: WebRequest) -> Any:
        args = web_request.get_args()
        params: Dict[str, Any] = {
            k: args[k] for k in CATALOG_SEARCH_PARAMS if args.get(k) is not None
        }
        # My models: the account's own, private ones included. Only with a
        # token: without one the platform answers 401, which must never read as
        # "this printer was unlinked".
        if str(params.get("mine", "")).lower() in ("1", "true"):
            if not self._token:
                raise self.server.error("Connect this printer to CommunityCAD to see your own models.", 409)
            params["mine"] = 1
        else:
            params.pop("mine", None)

        # Fill the fit box from the printer unless the caller set it explicitly, so
        # "fits your printer" needs nothing from the browser.
        if not any(k in params for k in ("fit_x", "fit_y", "fit_z")):
            volume = await self._effective_build_volume()
            if volume and volume.get("fit_filtering"):
                params["fit_x"], params["fit_y"], params["fit_z"] = (
                    volume["x"], volume["y"], volume["z"],
                )
            elif params.get("fit") == "only":
                # No usable volume: showing nothing would be worse than showing all.
                params["fit"] = "any"

        try:
            types = parse_file_types(args.get("types"))
        except ValueError as exc:
            raise self.server.error(str(exc), 422) from exc
        if types:
            return await self._filtered_search(params, types)

        return await self._search_page(params)

    async def _search_page(self, params: Dict[str, Any]) -> Dict[str, Any]:
        query = "&".join(f"{k}={_quote(v)}" for k, v in params.items())
        path = "/catalog/search" + (f"?{query}" if query else "")
        return await self._guard(self._api("GET", path, authed=bool(self._token)))

    async def _filtered_search(self, params: Dict[str, Any], types: frozenset) -> Dict[str, Any]:
        """One page of search results that have a file of one of `types`."""
        try:
            offset = max(0, int(params.pop("offset", 0)))
            limit = min(SCAN_PAGE, max(1, int(params.pop("limit", 20))))
        except (TypeError, ValueError) as exc:
            raise self.server.error("limit and offset must be numbers.", 422) from exc
        items, truncated = await self._scan_catalog(params)
        matching = [
            item for item in items
            if types.intersection(item.get("printable_types") or ())
        ]
        return {
            "items": matching[offset:offset + limit],
            "total": len(matching),
            "limit": limit,
            "offset": offset,
            "types": sorted(types),
            # More results than the API lets anyone page through; the filter only
            # saw the first SCAN_MAX_OFFSET + SCAN_PAGE of them.
            "truncated": truncated,
        }

    async def _scan_catalog(self, params: Dict[str, Any]) -> tuple:
        """Every result for a query (within the API's paging limit), in order.

        Cached per query for SCAN_TTL_S, so switching the type filter or showing
        more results doesn't page through the catalog again.
        """
        key = json.dumps(params, sort_keys=True, default=str)
        hit = self._scan_cache.get(key)
        now = time.monotonic()
        if hit and now - hit[0] < SCAN_TTL_S:
            return hit[1], hit[2]

        first = await self._search_page({**params, "limit": SCAN_PAGE, "offset": 0})
        total = int(first.get("total") or 0)
        pages: Dict[int, list] = {0: list(first.get("items") or [])}
        last = min(total - 1, SCAN_MAX_OFFSET)
        offsets = list(range(SCAN_PAGE, last + 1, SCAN_PAGE)) if last >= SCAN_PAGE else []
        gate = asyncio.Semaphore(SCAN_CONCURRENCY)

        async def fetch(offset: int) -> None:
            async with gate:
                page = await self._search_page({**params, "limit": SCAN_PAGE, "offset": offset})
                pages[offset] = list(page.get("items") or [])

        await asyncio.gather(*(fetch(o) for o in offsets))

        seen: set = set()
        items: list = []
        for offset in sorted(pages):
            for item in pages[offset]:
                if item.get("id") not in seen:  # results can shift between pages
                    seen.add(item.get("id"))
                    items.append(item)
        truncated = total > SCAN_MAX_OFFSET + SCAN_PAGE

        self._scan_cache[key] = (now, items, truncated)
        if len(self._scan_cache) > SCAN_CACHE_KEYS:
            oldest = min(self._scan_cache, key=lambda k: self._scan_cache[k][0])
            del self._scan_cache[oldest]
        return items, truncated

    async def _handle_model(self, web_request: WebRequest) -> Any:
        model_id = web_request.get_int("id")
        return await self._guard(
            self._api("GET", f"/catalog/models/{model_id}", authed=bool(self._token))
        )

    async def _handle_settings(self, web_request: WebRequest) -> Dict[str, Any]:
        if web_request.get_request_type() == RequestType.POST:
            args = web_request.get_args()
            if "build_volume" in args:
                self._settings["build_volume"] = args["build_volume"]
            if "default_tab" in args:
                self._settings["default_tab"] = args["default_tab"]
            if "printer_name" in args:
                self._settings["printer_name"] = args["printer_name"]
            if "file_type" in args:
                value = str(args["file_type"] or "").strip().lower()
                if value and value not in FILE_TYPES:
                    raise self.server.error(f"Unknown file type: {value}", 422)
                self._settings["file_type"] = value
            if "send_folder" in args:
                try:
                    self._settings["send_folder"] = clean_send_folder(args["send_folder"])
                except ValueError as exc:
                    raise self.server.error(str(exc), 422) from exc
            if "share_prompt" in args:
                self._settings["share_prompt"] = bool(args["share_prompt"])
                self._settings["share_after_print"] = "ask" if args["share_prompt"] else "off"
            if "share_after_print" in args:
                if args["share_after_print"] not in SHARE_MODES:
                    raise self.server.error("After a print: ask, auto or off.", 422)
                self._settings["share_after_print"] = args["share_after_print"]
            if "share_visibility" in args:
                if args["share_visibility"] not in SHARE_VISIBILITIES:
                    raise self.server.error("Who can see it: public or private.", 422)
                self._settings["share_visibility"] = args["share_visibility"]
            for key in ("post_webcam", "post_timelapse", "post_attach_profile"):
                if key in args:
                    self._settings[key] = bool(args[key])
            if "post_webcam_name" in args:
                self._settings["post_webcam_name"] = str(args["post_webcam_name"] or "")[:64] or None
            if "default_profile" in args:
                self._settings["default_profile"] = self._choose_profile(
                    {"profile": args["default_profile"]}, {})
            self._save_settings()
        return {
            "build_volume": self._settings.get("build_volume"),
            "default_tab": self._settings.get("default_tab", "fits"),
            "printer_name": self._default_printer_name(),
            "send_folder": self._send_folder(),
            "file_type": self._file_type(),
            "default_profile": self._settings.get("default_profile"),
            "share_prompt": self._share_mode() == "ask",
            "share_after_print": self._share_mode(),
            "share_visibility": self._share_visibility(),
            "post_webcam": self._settings.get("post_webcam", False),
            "post_webcam_name": self._settings.get("post_webcam_name"),
            "post_timelapse": self._settings.get("post_timelapse", False),
            "post_attach_profile": self._settings.get("post_attach_profile", True),
            "detected_build_volume": await self._detect_build_volume(),
        }

    async def _handle_permissions(self, web_request: WebRequest) -> Dict[str, Any]:
        """GET the answers; POST {printer_settings, print_history} with true/false.

        Enforced here, on the Pi, so a modified browser can't read around it.
        Turning one off also forgets what was read under it.
        """
        if web_request.get_request_type() == RequestType.POST:
            args = web_request.get_args()
            current = dict(self._settings.get("permissions") or {})
            for key in PERMISSIONS:
                if key in args:
                    value = args[key]
                    if not isinstance(value, bool):
                        raise self.server.error(f"{key} must be true or false.", 422)
                    current[key] = value
            self._settings["permissions"] = current
            self._save_settings()
            if current.get(PERMISSION_SETTINGS) is not True:
                self._printer_cache = None
        return {k: self._permission(k) for k in PERMISSIONS}

    async def _guard(self, coro: Any) -> Any:
        """Turn our own error type into Moonraker's, so the UI gets a clean status
        and message instead of a traceback."""
        try:
            return await coro
        except CommunityCADError as exc:
            raise self.server.error(exc.message, exc.code) from exc


class OrcaProfiles:
    """Orca's bundled presets, flattened.

    System presets carry only their own overrides and `inherits` a parent; given
    to the CLI as files they fail its compatibility check (exit -17). Flattened --
    the whole chain merged, `from: system` kept, the printer named in
    `compatible_printers` -- they slice.

    Names are scoped by vendor, as in Orca: several vendors define their own
    `fdm_klipper_common`, with different start G-code. A parent is looked up in its
    child's vendor first; a top-level lookup names the vendor it wants.
    """

    def __init__(self, profiles_dir: pathlib.Path) -> None:
        self.dir = profiles_dir
        self._names: Dict[str, Dict[str, pathlib.Path]] = {}
        self.filaments: list = []
        self._process: list = []
        vendors = sorted(p.stem for p in profiles_dir.glob("*.json") if profiles_dir.joinpath(p.stem).is_dir())
        for vendor in vendors:
            try:
                index = json.loads(profiles_dir.joinpath(vendor + ".json").read_text())
            except (OSError, ValueError):
                continue
            for key in ("machine_model_list", "machine_list", "process_list", "filament_list"):
                for entry in index.get(key, []):
                    name = entry.get("name")
                    if not name:
                        continue
                    by_vendor = self._names.setdefault(name, {})
                    by_vendor.setdefault(vendor, profiles_dir.joinpath(vendor, entry["sub_path"]))
                    if key == "process_list" and name not in self._process:
                        self._process.append(name)
                    if (key == "filament_list" and "@" in name and not name.startswith("fdm_")
                            and len(by_vendor) == 1):
                        self.filaments.append(name)

    def __contains__(self, name: str) -> bool:
        return name in self._names

    def process_names(self) -> list:
        return list(self._process)

    def _path(self, name: str, vendor: Optional[str]) -> tuple:
        by_vendor = self._names.get(name)
        if not by_vendor:
            raise ValueError(f"unknown Orca preset: {name}")
        for choice in (vendor, "OrcaFilamentLibrary"):
            if choice in by_vendor:
                return choice, by_vendor[choice]
        first = sorted(by_vendor)[0]
        return first, by_vendor[first]

    def bed_files(self, model_name: str) -> Dict[str, Optional[pathlib.Path]]:
        """The bed model and texture Orca draws for a printer model, as named by
        its machine_model file. Only plain file names inside that vendor's folder,
        with the extensions Orca uses; anything else is ignored."""
        out: Dict[str, Optional[pathlib.Path]] = {"model": None, "texture": None}
        for vendor, path in sorted((self._names.get(model_name) or {}).items()):
            try:
                data = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if data.get("type") != "machine_model":
                continue
            folder = self.dir.joinpath(vendor)
            for key, field, exts in (("model", "bed_model", (".stl",)),
                                     ("texture", "bed_texture", (".svg", ".png"))):
                name = str(data.get(field) or "")
                if (name and name == os.path.basename(name) and not name.startswith(".")
                        and name.lower().endswith(exts) and folder.joinpath(name).is_file()):
                    out[key] = folder.joinpath(name)
            break
        return out

    def resolve(self, name: str, vendor: Optional[str] = None, depth: int = 0) -> Dict[str, Any]:
        if depth > 20:
            raise ValueError(f"Orca preset inherits too deeply: {name}")
        found_in, path = self._path(name, vendor)
        preset = json.loads(path.read_text())
        parent = preset.get("inherits")
        merged = self.resolve(parent, found_in, depth + 1) if parent else {}
        merged.update(preset)
        merged["inherits"] = ""
        merged["from"] = "system"
        return merged


# ------------------------------------------------- the printer, from printer.cfg
# The slicer's printer comes from this printer's own Klipper config, mods
# included. Everything here is pure, so it can be
# tested against fixture configs.

START_MACROS = ("print_start", "start_print")
END_MACROS = ("print_end", "end_print")
START_PARAMS = {
    # What a start macro's params are commonly called, and the Orca value for each.
    "bed": (("BED", "BED_TEMP", "BEDTEMP", "BED_TEMPERATURE", "TEMP_BED"),
            "[bed_temperature_initial_layer_single]"),
    "extruder": (("EXTRUDER", "EXTRUDER_TEMP", "EXTRUDERTEMP", "HOTEND", "HOTEND_TEMP",
                  "NOZZLE", "NOZZLE_TEMP", "TEMP_EXTRUDER"), "[nozzle_temperature_initial_layer]"),
    "chamber": (("CHAMBER", "CHAMBER_TEMP", "CHAMBER_TEMPERATURE"), None),
}
PROCESS_ACCELERATIONS = ("default_acceleration", "initial_layer_acceleration",
                         "inner_wall_acceleration", "outer_wall_acceleration",
                         "top_surface_acceleration", "travel_acceleration",
                         "sparse_infill_acceleration", "internal_solid_infill_acceleration",
                         "bridge_acceleration")


def _num(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _macro(settings: Dict[str, Any], names: tuple) -> Optional[tuple]:
    """(name as the user wrote it, its gcode) for the first macro found."""
    for key, section in settings.items():
        if key.startswith("gcode_macro ") and key[len("gcode_macro "):].lower() in names:
            return key[len("gcode_macro "):].upper(), str((section or {}).get("gcode") or "")
    return None


def start_gcode_for(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Orca start/end G-code that calls this printer's own macros the way they read
    their parameters, and leaves heating to them when they heat.

    Orca adds no temperature commands of its own for Klipper (GCode.cpp skips them
    for gcfKlipper), so whatever the macro doesn't do has to be in this template.
    """
    start = _macro(settings, START_MACROS)
    end = _macro(settings, END_MACROS)
    info: Dict[str, Any] = {"start_macro": None, "end_macro": end[0] if end else None,
                            "params": {}, "heats_bed": False, "heats_nozzle": False}
    if start is None:
        return {**info, "start_gcode": None, "end_gcode": end[0] if end else None}
    name, body = start
    upper = body.upper()
    used = set(re.findall(r"params\.([A-Za-z_][A-Za-z0-9_]*)", body))
    used |= set(re.findall(r"params\[[\'\"]([A-Za-z_][A-Za-z0-9_]*)[\'\"]\]", body))
    used = {u.upper() for u in used}
    params = {role: next((c for c in cands if c in used), None) for role, (cands, _) in START_PARAMS.items()}
    heats_bed = bool(re.search(r"\bM1[49]0\b|SET_HEATER_TEMPERATURE\s+HEATER=HEATER_BED", upper))
    heats_nozzle = bool(re.search(r"\bM10[49]\b|SET_HEATER_TEMPERATURE\s+HEATER=EXTRUDER\b", upper))
    lines = []
    # Heat first only what the macro doesn't heat itself, and only if it can't be told.
    if not (heats_bed and params["bed"]):
        lines.append("M190 S[bed_temperature_initial_layer_single]")
    if not (heats_nozzle and params["extruder"]):
        lines.append("M109 S[nozzle_temperature_initial_layer]")
    call = name
    if params["bed"]:
        call += f" {params['bed']}=[bed_temperature_initial_layer_single]"
    if params["extruder"]:
        call += f" {params['extruder']}=[nozzle_temperature_initial_layer]"
    if params["chamber"]:
        # Only when a material asks for a chamber temperature: otherwise the macro's
        # own default stands, rather than being overridden with 0.
        call += (f"{{if chamber_temperature[0] > 0}} {params['chamber']}="
                 f"{{chamber_temperature[0]}}{{endif}}")
    lines.append(call)
    return {**info, "start_macro": name, "params": {k: v for k, v in params.items() if v},
            "heats_bed": heats_bed, "heats_nozzle": heats_nozzle,
            "start_gcode": "\n".join(lines), "end_gcode": end[0] if end else None}


def identify_printer(settings: Dict[str, Any], header: str = "") -> Dict[str, Any]:
    """Which printer this is, from its config's own shape: a fingerprint, not a
    guess. Only matches we're sure of are named; everything else is a Klipper
    printer described by what it is."""
    kin = str((settings.get("printer") or {}).get("kinematics") or "")
    x = _num((settings.get("stepper_x") or {}).get("position_max")) or 0
    z_steppers = sum(1 for k in settings if re.fullmatch(r"stepper_z\d*", k))
    evidence: list = []
    name, family = None, None
    if kin == "corexy" and z_steppers == 3 and "z_tilt" in settings:
        family = "Voron Trident"
        evidence.append("CoreXY with 3 Z motors and z_tilt")
    elif kin == "corexy" and z_steppers == 4 and "quad_gantry_level" in settings:
        family = "Voron 2.4"
        evidence.append("CoreXY with 4 Z motors and quad_gantry_level")
    elif kin == "corexz":
        family = "Voron Switchwire"
        evidence.append("CoreXZ kinematics")
    elif kin == "corexy" and z_steppers == 1 and 0 < x <= 130:
        family = "Voron 0"
        evidence.append("CoreXY, one Z motor, 120 mm class bed")
    # The shape alone can't tell a Voron from a printer built like one (a Sovol SV08
    # is a 2.4 layout). If the config names another maker, don't claim it's a Voron.
    other = re.search(r"\b(sovol|creality|qidi|elegoo|ratrig|rat rig|prusa|anycubic|flashforge)\b",
                      header, re.I)
    if family and other:
        evidence.append(f"shaped like a {family}, but printer.cfg mentions {other.group(1)}")
        family = None
    if family in ("Voron Trident", "Voron 2.4"):
        size = min((250, 300, 350), key=lambda s: abs(s - x))
        if abs(size - x) <= 15:
            name = f"{family} {size}"
            evidence.append(f"{x:g} mm bed: the {size} size")
    elif family:
        name = family
    for hint in re.findall(r"^#+\s*(.*(?:voron|trident|stealthburner|nitehawk|sovol|creality|"
                           r"qidi|elegoo|ratrig|prusa)[^\n]*)", header, re.I | re.M)[:3]:
        evidence.append(f"printer.cfg says: {hint.strip()[:80]}")
    return {"name": name, "family": family, "evidence": evidence}


# Facts printer.cfg can't say on its own, which the owner adds as variables of a
# [gcode_macro _COMMUNITYCAD]: Klipper rejects unknown options in its own
# sections, and a variable-only macro is the Klipper-native place, the pattern
# Mainsail uses for _CLIENT_VARIABLE. The plugin shows the lines; it never writes
# printer.cfg.
FACTS_MACRO = "_COMMUNITYCAD"
BED_SURFACES = {
    # our word: Orca's plate type, which picks the bed temperature from the material
    "textured_pei": "Textured PEI Plate", "smooth_pei": "High Temp Plate",
    "pei": "High Temp Plate", "glass": "High Temp Plate", "cool_plate": "Cool Plate",
    "textured_cool_plate": "Textured Cool Plate", "engineering": "Engineering Plate",
    "garolite": "Engineering Plate", "g10": "Engineering Plate", "supertack": "Supertack Plate",
}
DEFAULT_BED_SURFACE = "textured_pei"
FACTS = {
    "bed_surface": {"example": '"textured_pei"',
                    "help": "one of " + ", ".join(sorted(BED_SURFACES)) + "; sets bed temperatures"},
    "hotend": {"example": '"revo_voron_40w"', "help": "your hotend, e.g. revo_voron_40w; a hint for defaults"},
    "part_cooling": {"example": '"stock"', "help": '"stock" or "strong" (e.g. CPAP)'},
}


def printer_facts(settings: Dict[str, Any]) -> Dict[str, Any]:
    """The owner's facts from [gcode_macro _COMMUNITYCAD], parsed as Klipper parses
    macro variables (Python literals). Bad values are reported, never fatal."""
    section = settings.get("gcode_macro " + FACTS_MACRO.lower())
    facts: Dict[str, Any] = {}
    problems: list = []
    for key in FACTS:
        raw = (section or {}).get("variable_" + key)
        if raw is None:
            continue
        try:
            value = ast.literal_eval(str(raw))
        except (ValueError, SyntaxError):
            problems.append(f"variable_{key}: {raw} isn't a value Klipper can read; put text in quotes")
            continue
        if key == "bed_surface" and str(value).lower() not in BED_SURFACES:
            problems.append(f"variable_bed_surface: {value!r} isn't one of {', '.join(sorted(BED_SURFACES))}")
            continue
        facts[key] = str(value).lower() if isinstance(value, str) else value
    missing = [k for k in FACTS if k not in facts]
    lines = None
    if missing:
        body = [f"variable_{k}: {FACTS[k]['example']}    # {FACTS[k]['help']}" for k in missing]
        if section is None:
            lines = "\n".join([f"[gcode_macro {FACTS_MACRO}]",
                               "description: Printer facts for the CommunityCAD slicer (not a command)",
                               *body, "gcode:"])
        else:
            lines = "\n".join(body)
    return {"facts": facts, "missing": missing, "problems": problems,
            "macro_present": section is not None, "add_lines": lines}


def printer_from_config(settings: Dict[str, Any], header: str = "") -> Dict[str, Any]:
    """Everything the slicer takes from printer.cfg."""
    printer = settings.get("printer") or {}
    extruder = settings.get("extruder") or {}
    bed = settings.get("heater_bed") or {}
    enclosed_by = [k for k in settings
                   if re.fullmatch(r"(temperature_sensor|heater_generic) .*chamber.*", k)]
    profile = {
        "identity": identify_printer(settings, header),
        "kinematics": str(printer.get("kinematics") or ""),
        "max_velocity": _num(printer.get("max_velocity")),
        "max_accel": _num(printer.get("max_accel")),
        "max_z_velocity": _num(printer.get("max_z_velocity")),
        "square_corner_velocity": _num(printer.get("square_corner_velocity")),
        "nozzle_diameter": _num(extruder.get("nozzle_diameter")),
        "filament_diameter": _num(extruder.get("filament_diameter")),
        "pressure_advance": _num(extruder.get("pressure_advance")),
        "hotend_max_temp": _num(extruder.get("max_temp")),
        "bed_max_temp": _num(bed.get("max_temp")),
        "firmware_retraction": "firmware_retraction" in settings,
        "input_shaper": "input_shaper" in settings,
        "enclosed": bool(enclosed_by),
        "enclosed_by": enclosed_by,
    }
    profile.update(start_gcode_for(settings))
    profile["facts"] = printer_facts(settings)
    surface = profile["facts"]["facts"].get("bed_surface")
    profile["bed_surface"] = surface or DEFAULT_BED_SURFACE
    profile["bed_surface_assumed"] = surface is None
    return profile


_SVL = re.compile(r"^(\s*SET_VELOCITY_LIMIT\b)(.*)$", re.I)
_SVL_PARAM = re.compile(r"\b(ACCEL|VELOCITY)=([0-9.]+)", re.I)
_M204 = re.compile(r"^(\s*M204\b)(.*)$", re.I)
_M204_PARAM = re.compile(r"\b([SPT])([0-9.]+)")


def clamp_gcode_limits(path: pathlib.Path, max_accel: Optional[float],
                       max_velocity: Optional[float]) -> int:
    """Cap every SET_VELOCITY_LIMIT and M204 in a G-code file at the printer's own
    limits, in place. Returns how many lines changed; all others are byte-identical.

    A safety net on the output: Klipper accepts SET_VELOCITY_LIMIT above the
    max_accel in printer.cfg, and a 3MF project's own accelerations never pass
    through the preset clamp in apply_printer.
    """
    if not max_accel and not max_velocity:
        return 0
    limits = {"ACCEL": max_accel, "VELOCITY": max_velocity}
    changed = 0
    tmp = path.with_name(path.name + ".clamp")

    def cap(value: str, limit: Optional[float]) -> str:
        v = _num(value)
        return f"{limit:g}" if limit and v is not None and v > limit else value

    with open(path, "rb") as src, open(tmp, "wb") as dst:
        for raw in src:
            text = raw.decode("utf-8", "surrogateescape")
            body = text.rstrip("\r\n")
            ending = text[len(body):]
            line = body
            new = line
            m = _SVL.match(line)
            if m:
                new = m.group(1) + _SVL_PARAM.sub(
                    lambda p: f"{p.group(1)}={cap(p.group(2), limits[p.group(1).upper()])}", m.group(2))
            elif max_accel:
                m = _M204.match(line)
                if m:
                    new = m.group(1) + _M204_PARAM.sub(
                        lambda p: f"{p.group(1)}{cap(p.group(2), max_accel)}", m.group(2))
            if new != line:
                changed += 1
            dst.write((new + ending).encode("utf-8", "surrogateescape"))
    if changed:
        os.replace(tmp, path)
    else:
        tmp.unlink(missing_ok=True)
    return changed


def apply_printer(machine: Dict[str, Any], process: Dict[str, Any],
                  printer: Dict[str, Any]) -> None:
    """Fit Orca's presets to this printer's own limits and macros, in place.

    Orca sets per-feature accelerations with SET_VELOCITY_LIMIT, which Klipper
    accepts above the max_accel in printer.cfg, so every acceleration and speed is
    clamped to the config's limits: a preset tuned for a faster printer can't push
    this one past what its owner set.
    """
    vmax, amax = printer.get("max_velocity"), printer.get("max_accel")
    if vmax:
        machine["machine_max_speed_x"] = machine["machine_max_speed_y"] = [f"{vmax:g}", f"{vmax:g}"]
        for key, value in list(process.items()):
            if key.endswith("_speed") and "fan" not in key and "ironing" not in key:
                v = _num(value[0] if isinstance(value, list) else value)
                if v is not None and v > vmax:
                    process[key] = [f"{vmax:g}"] if isinstance(value, list) else f"{vmax:g}"
    if amax:
        for key in ("machine_max_acceleration_x", "machine_max_acceleration_y",
                    "machine_max_acceleration_extruding", "machine_max_acceleration_travel"):
            machine[key] = [f"{amax:g}", f"{amax:g}"]
        for key in PROCESS_ACCELERATIONS:
            if key in process:
                value = process[key]
                v = _num(value[0] if isinstance(value, list) else value)
                if v is not None and v > amax:
                    process[key] = [f"{amax:g}"] if isinstance(value, list) else f"{amax:g}"
    if printer.get("max_z_velocity"):
        machine["machine_max_speed_z"] = [f"{printer['max_z_velocity']:g}"] * 2
    if printer.get("firmware_retraction"):
        # The printer's own [firmware_retraction] values apply (G10/G11). Klipper's
        # firmware retraction doesn't wipe, and Orca refuses the two together.
        machine["use_firmware_retraction"] = "1"
        machine["wipe"] = ["0"] * max(1, len(machine.get("wipe") or [0]))
    if printer.get("start_gcode"):
        machine["machine_start_gcode"] = printer["start_gcode"]
    if printer.get("end_gcode"):
        machine["machine_end_gcode"] = printer["end_gcode"]


def material_preset(profiles: OrcaProfiles, material: Dict[str, Any]) -> Dict[str, Any]:
    """An Orca filament preset for one [material]: its parent, then its own values."""
    parent = material.get("inherits") or ""
    if parent and parent not in profiles:
        raise ValueError(f'"{parent}" isn\'t an OrcaSlicer filament preset on this printer')
    preset = profiles.resolve(parent) if parent else profiles.resolve("fdm_filament_common")
    for key, text in material.get("values", {}).items():
        preset[key] = orca_value(preset.get(key, [""]), text)
    return preset


def profile_preset(profiles: OrcaProfiles, profile: Any) -> Dict[str, Any]:
    """The Orca process preset for a print profile: a default's name (or one
    of the old quality keys), or a custom {"inherits", "values"} from
    print_profiles.cfg, its values over its parent's."""
    if isinstance(profile, dict):
        parent = profile.get("inherits") or DEFAULT_PROFILE
        if parent not in profiles:
            raise ValueError(f'"{parent}" isn\'t an OrcaSlicer process preset on this printer')
        preset = profiles.resolve(parent, "Voron")
        for key, text in (profile.get("values") or {}).items():
            if key not in PROFILE_BLOCKED:
                preset[key] = orca_value(preset.get(key, ""), text)
        return preset
    name = SLICE_QUALITY.get(str(profile), str(profile))
    return profiles.resolve(name, "Voron")


def slice_presets(profiles: OrcaProfiles, volume: Dict[str, Any], nozzle: float,
                  material: Dict[str, Any], profile: Any, overrides: Dict[str, str],
                  printer: Optional[Dict[str, Any]] = None) -> Dict[str, Dict[str, Any]]:
    """The machine, process and filament presets for one slice.

    The machine is Orca's generic Klipper printer with this printer's bed, height
    and nozzle: detected, never asked. Its start G-code is
    `PRINT_START EXTRUDER= BED=`, which the common Klipper macros read.
    """
    printer = printer or {}
    # A recognised printer starts from Orca's preset for it, which fills what the
    # config can't say; the config's own values still win (apply_printer, below).
    matched = None
    name = (printer.get("identity") or {}).get("name")
    if name and f"{name} {nozzle:g} nozzle" in profiles:
        matched = f"{name} {nozzle:g} nozzle"
    machine = profiles.resolve(matched or SLICE_MACHINE_BASE, "Voron")
    x, y, z = (round(float(volume[k]), 1) for k in ("x", "y", "z"))
    machine.update({
        "name": SLICE_MACHINE_NAME,
        "printer_model": "",
        "printable_area": ["0x0", f"{x:g}x0", f"{x:g}x{y:g}", f"0x{y:g}"],
        "printable_height": f"{z:g}",
        "nozzle_diameter": [f"{nozzle:g}"],
    })
    process = profile_preset(profiles, profile)
    for key, value in PROCESS_FALLBACK.items():
        process.setdefault(key, value)
    # The user's changes, already checked by check_process.
    process.update({k: v for k, v in overrides.items() if k in PROCESS_SETTINGS})
    process.update({
        # Without this Orca uses the cool-plate temperature: 35 C for PLA. From the
        # owner's variable_bed_surface, else textured PEI.
        "curr_bed_type": BED_SURFACES.get(str((printer or {}).get("bed_surface") or DEFAULT_BED_SURFACE),
                                          "Textured PEI Plate"),
        "compatible_printers": [SLICE_MACHINE_NAME],
        "compatible_printers_condition": "",
    })
    apply_printer(machine, process, printer)
    fil = material_preset(profiles, material)
    if printer.get("firmware_retraction") and "filament_wipe" in fil:
        fil["filament_wipe"] = ["nil"]          # same reason as the machine's wipe
    fil.update({"name": material.get("name") or fil.get("name"),
                "compatible_printers": [SLICE_MACHINE_NAME], "compatible_printers_condition": ""})
    machine["printer_model"] = ""
    return {"machine": machine, "process": process, "filament": fil}


def _kill_group(proc: Any) -> None:
    """Stop a process started with start_new_session, and anything it started."""
    import signal
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def unique_name(folder: pathlib.Path, name: str) -> str:
    """name, or name-2, name-3 ... if a file of that name is already in folder."""
    name = os.path.basename(name) or "model"
    stem, ext = os.path.splitext(name)
    candidate, n = name, 2
    while folder.joinpath(candidate).exists():
        candidate = f"{stem}-{n}{ext}"
        n += 1
    return candidate


def sliced_filename(source: str, filament: str, detail: str, folder: pathlib.Path) -> str:
    """A name for sliced G-code that never replaces a file already there.

    Moonraker's upload replaces an existing file of the same name without asking,
    and a model's own G-code is often called the same as its STL. So the name says
    what it is, as slicers do (`bracket_PLA_0.20mm.gcode`), and gets -2, -3, ...
    if that's taken.
    """
    stem = os.path.splitext(os.path.basename(source))[0] or "model"
    material = re.sub(r"[^A-Za-z0-9.+]+", "-", filament).strip("-") or "material"
    base = f"{stem}_{material}_{detail}"
    name = f"{base}.gcode"
    n = 2
    while folder.joinpath(name).exists():
        name = f"{base}-{n}.gcode"
        n += 1
    return name


def is_3mf_project(path: pathlib.Path) -> bool:
    """A 3MF that carries its own slicing settings (Bambu Studio, OrcaSlicer)."""
    try:
        with zipfile.ZipFile(path) as zf:
            return "Metadata/project_settings.config" in zf.namelist()
    except (zipfile.BadZipFile, OSError):
        return False


GCODE_SUMMARY = {
    "print_time": re.compile(r"^; estimated printing time \(normal mode\) = (.+)$"),
    "filament_g": re.compile(r"^; (?:total )?filament (?:used|weight) \[g\] = ([\d.]+)"),
    "layers": re.compile(r"^; total layers count = (\d+)"),
}


def gcode_summary(path: pathlib.Path) -> Dict[str, Any]:
    """Print time, filament and layers from the comments Orca writes at the end."""
    found: Dict[str, Any] = {}
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - (256 << 10)))
        tail = fh.read().decode("utf-8", "replace")
    for line in tail.splitlines():
        for key, pattern in GCODE_SUMMARY.items():
            m = pattern.match(line.strip())
            if m and key not in found:
                found[key] = m.group(1)
    return found


# ---------------------------------------------------------------- materials.cfg
# Materials: one [material <name>] per OrcaSlicer filament preset, in the
# printer's own config folder beside printer.cfg. A direct translation of Orca:
# `inherits` names the Orca parent and every other key is Orca's own setting name.

MATERIALS_FILE = "materials.cfg"
MATERIAL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.+()@/&#-]{0,63}$")
MATERIALS_HEADER = """\
# Materials for Hopper's slicer. Not a Klipper file: nothing
# [include]s it, and Klipper never reads it.
#
# Each [material <name>] is one OrcaSlicer filament preset. `inherits` names the
# Orca preset it starts from; every other line is an Orca filament setting, by
# Orca's own name and in Orca's own format, and overrides the inherited value.
# Edit here, in Mainsail, or from the plugin's Settings > Materials.
"""
DEFAULT_MATERIALS = [
    ("PLA", "Generic PLA @System"), ("PETG", "Generic PETG @System"),
    ("ABS", "Generic ABS @System"), ("ASA", "Generic ASA @System"),
    ("TPU", "Generic TPU @System"),
]
MATERIAL_SECTION = re.compile(r"^\[material\s+([^\]]+?)\s*\]\s*$")
_ORCA_FILAMENT_KEYS: Optional[list] = None


# Print profiles: Orca process presets. Defaults are Orca's own system
# presets for this printer; custom ones live in print_profiles.cfg, the user's
# own, with any Orca process setting except these: post_process runs programs on
# the Pi, and the plugin manages file names and which printer a preset is for.
PROFILES_FILE = "print_profiles.cfg"
PROFILE_BLOCKED = frozenset({"post_process", "filename_format", "compatible_printers",
                             "compatible_printers_condition", "inherits", "print_settings_id"})
PROFILES_HEADER = """\
# Print profiles for Hopper's slicer. Not a Klipper file: nothing
# [include]s it, and Klipper never reads it.
#
# Each [profile <name>] is one OrcaSlicer process preset. `inherits` names the Orca
# preset it starts from (e.g. 0.20mm Standard @Voron); every other line is an Orca
# process setting, by Orca's own name and in Orca's own format, and overrides the
# inherited value. Speeds and accelerations are still capped at printer.cfg's
# max_velocity and max_accel. Edit here, in Mainsail, or from the plugin.
"""
DEFAULT_PROFILE = "0.20mm Standard @Voron"
_ORCA_PROCESS_KEYS: Optional[list] = None


def orca_process_keys() -> list:
    """Orca's process setting names (src/libslic3r/Preset.cpp)."""
    global _ORCA_PROCESS_KEYS
    if _ORCA_PROCESS_KEYS is None:
        here = pathlib.Path(__file__).resolve().parent
        data = json.loads(here.joinpath("orca_process_intent.json").read_text())
        _ORCA_PROCESS_KEYS = list(data["classes"])
    return _ORCA_PROCESS_KEYS


def parse_profiles(text: str) -> tuple:
    """Parse print_profiles.cfg."""
    return parse_sections(text, "profile", set(orca_process_keys()) - PROFILE_BLOCKED, "process",
                          PROFILE_BLOCKED)


def format_profile(name: str, inherits: str, values: Dict[str, str]) -> str:
    return format_section("profile", name, inherits, values, orca_process_keys())


def default_profiles(profiles: "OrcaProfiles", printer_name: Optional[str], nozzle: float) -> list:
    """Orca's system process presets for this printer and nozzle, finest first, as
    Orca lists them. An unrecognised printer gets the plugin's Voron three."""
    names = []
    machine = f"{printer_name} {nozzle:g} nozzle" if printer_name else None
    if machine and machine in profiles:
        for name in profiles.process_names():
            try:
                preset = profiles.resolve(name, "Voron")
            except ValueError:
                continue
            if preset.get("instantiation") == "false":
                continue
            if machine in (preset.get("compatible_printers") or []):
                names.append(name)
    if not names:
        names = [n for n in SLICE_QUALITY.values() if n in profiles]
    return sorted(names, key=lambda n: (float(re.match(r"[\d.]+", n).group()) if re.match(r"[\d.]+", n) else 99, n))


# Import from and export to OrcaSlicer. Orca exports presets as a single
# .json, a .zip of them, or a bundle (.orca_printer: printer/, filament/, process/
# and bundle_structure.json; .orca_filament: <vendor>/<name>.json).
IMPORT_MAX_BYTES = 20 << 20
IMPORT_MAX_PRESETS = 500
PRESET_META_KEYS = frozenset({
    "name", "inherits", "type", "from", "setting_id", "filament_id", "instantiation", "version",
    "is_custom_defined", "filament_settings_id", "print_settings_id", "printer_settings_id",
    "compatible_printers", "compatible_printers_condition", "compatible_prints",
    "compatible_prints_condition", "renamed_from", "updated_time", "user_id", "base_id"})
SAFE_NAME = re.compile(r"[^A-Za-z0-9 _.+()@/&#-]")


def preset_kind(path: str, preset: Dict[str, Any]) -> Optional[str]:
    """process, filament or machine: from the preset's own type, else where the
    bundle keeps it, else which *_settings_id it carries."""
    kind = str(preset.get("type") or "").lower()
    if kind in ("process", "filament", "machine"):
        return kind
    folder = path.replace("\\", "/").split("/")[0].lower() if "/" in path else ""
    if folder in ("process", "filament"):
        return folder
    if folder == "printer":
        return "machine"
    for key, kind in (("print_settings_id", "process"), ("filament_settings_id", "filament"),
                      ("printer_settings_id", "machine")):
        if key in preset:
            return kind
    return None


def read_preset_files(name: str, data: bytes) -> list:
    """[(path, preset dict)] from an Orca export: a .json, or any zip of them.
    Raises ValueError with a plain message."""
    if len(data) > IMPORT_MAX_BYTES:
        raise ValueError("That file is bigger than any Orca preset export (20 MB).")
    out = []
    if data[:2] == b"PK":
        import io
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                infos = [i for i in z.infolist() if i.filename.lower().endswith(".json")
                         and not i.filename.endswith("bundle_structure.json") and not i.is_dir()]
                if len(infos) > IMPORT_MAX_PRESETS:
                    raise ValueError("That bundle has more presets than the plugin reads at once (500).")
                for info in infos:
                    if info.file_size > 2 << 20:
                        continue
                    try:
                        preset = json.loads(z.read(info).decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if isinstance(preset, dict):
                        out.append((info.filename, preset))
        except zipfile.BadZipFile as exc:
            raise ValueError("That zip file can't be read.") from exc
    else:
        try:
            preset = json.loads(data.decode("utf-8", "replace"))
        except ValueError as exc:
            raise ValueError("That isn't an OrcaSlicer preset (.json) or preset bundle.") from exc
        if not isinstance(preset, dict):
            raise ValueError("That isn't an OrcaSlicer preset.")
        out.append((name, preset))
    if not out:
        raise ValueError("No OrcaSlicer presets were found in that file.")
    return out


def safe_preset_name(name: str) -> str:
    clean = SAFE_NAME.sub("-", str(name or "").strip()).strip(" -")[:64]
    return clean if clean and clean[0].isalnum() else ("Imported " + clean)[:64].strip()


def nearest_default(profiles: "OrcaProfiles", defaults: list, layer: Any) -> str:
    """The default profile whose layer height is closest: the base a profile made
    for another printer is re-based on."""
    try:
        target = float(str(layer).split(",")[0])
    except ValueError:
        target = 0.2
    def height(name: str) -> float:
        m = re.match(r"[\d.]+", name)
        return float(m.group()) if m else 0.2
    return min(defaults or [DEFAULT_PROFILE], key=lambda n: (abs(height(n) - target), n != DEFAULT_PROFILE))


def plan_process_import(profiles: "OrcaProfiles", preset: Dict[str, Any], defaults: list) -> Dict[str, Any]:
    """An Orca process preset as a [profile]: its parent if it's one of this
    printer's defaults; otherwise flattened (parent + its own values) and re-based
    on the nearest default, keeping every value that differs. post_process never
    comes in."""
    known = set(orca_process_keys()) - PROFILE_BLOCKED
    own = {k: v for k, v in preset.items() if k in known}
    dropped = sorted(k for k in PROFILE_BLOCKED & set(preset)
                     if k == "post_process" and display_value(preset[k]).strip())
    skipped = sorted(k for k in preset if k not in known and k not in PROFILE_BLOCKED
                     and k not in PRESET_META_KEYS)
    parent = str(preset.get("inherits") or "")
    note = None
    if parent in defaults:
        values = {k: display_value(v) for k, v in own.items()}
        base = parent
    else:
        flat: Dict[str, Any] = {}
        if parent and parent in profiles:
            try:
                flat = profiles.resolve(parent)
            except ValueError:
                flat = {}
        flat.update(own)
        base = nearest_default(profiles, defaults, flat.get("layer_height", "0.2"))
        reference = profiles.resolve(base, "Voron")
        values = {k: display_value(v) for k, v in flat.items()
                  if k in known and display_value(v) != display_value(reference.get(k))}
        note = (f"made for {parent}: re-based on {base}, keeping its own values" if parent
                else f"re-based on {base}, keeping its own values")
    return {"inherits": base, "values": values, "dropped": dropped, "skipped": skipped, "note": note}


def plan_filament_import(profiles: "OrcaProfiles", preset: Dict[str, Any]) -> Dict[str, Any]:
    known = set(orca_filament_keys())
    parent = str(preset.get("inherits") or "")
    if parent and parent not in profiles:
        parent = ""
    values = {k: display_value(v) for k, v in preset.items() if k in known}
    skipped = sorted(k for k in preset if k not in known and k not in PRESET_META_KEYS)
    return {"inherits": parent, "values": values, "dropped": [], "skipped": skipped,
            "note": None if parent or not preset.get("inherits") else
            f"its parent {preset.get('inherits')} isn't on this printer: kept whole"}


def orca_user_preset(kind: str, name: str, inherits: str, values: Dict[str, str],
                     profiles: "OrcaProfiles", version: str) -> Dict[str, Any]:
    """A [profile] or [material] as Orca's own user-preset JSON, which desktop
    Orca's File > Import > Import Configs reads."""
    base: Dict[str, Any] = {}
    if inherits and inherits in profiles:
        try:
            base = profiles.resolve(inherits, "Voron" if kind == "process" else None)
        except ValueError:
            base = {}
    out: Dict[str, Any] = {"type": kind, "name": name, "inherits": inherits, "from": "User",
                           "instantiation": "true", "version": version}
    out["print_settings_id" if kind == "process" else "filament_settings_id"] = (
        name if kind == "process" else [name])
    for key, text in values.items():
        out[key] = orca_value(base.get(key, [""] if kind == "filament" else ""), text)
    return out


_ALLOWLIST_MODULE: Any = None


def allowlist_module() -> Any:
    """profile_allowlist.py beside this file. Moonraker links only this file
    into its components, so the module is loaded from the real folder, under a
    private name."""
    global _ALLOWLIST_MODULE
    if _ALLOWLIST_MODULE is None:
        import importlib.util
        path = pathlib.Path(__file__).resolve().parent.joinpath("profile_allowlist.py")
        spec = importlib.util.spec_from_file_location("communitycad_profile_allowlist", path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        _ALLOWLIST_MODULE = module
    return _ALLOWLIST_MODULE


IMAGE_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}


def image_type(data: bytes) -> Optional[str]:
    """jpg, png or webp from the file's own signature; None for anything else."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def multipart_body(fields: Dict[str, str], files: list) -> tuple:
    """multipart/form-data: text fields, then (field, filename, type, bytes) files."""
    boundary = "ccad" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                f"{value}\r\n").encode()
    for name, filename, ctype, data in files:
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; "
                f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
        out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


class StorageClient:
    """Plain HTTP to the storage upload URL, with redirects off: a GCS resumable
    upload answers 308 for "chunk received, send the next", which Moonraker's
    client would try to follow as a redirect."""

    class Response:
        def __init__(self, code: int, headers: Any) -> None:
            self.status_code = code
            self.headers = headers

    async def request(self, method: str, url: str, body: bytes, headers: Dict[str, str],
                      connect_timeout: float, request_timeout: float) -> "StorageClient.Response":
        from tornado.httpclient import AsyncHTTPClient, HTTPRequest
        resp = await AsyncHTTPClient().fetch(HTTPRequest(
            url, method=method, body=body, headers=headers, follow_redirects=False,
            connect_timeout=connect_timeout, request_timeout=request_timeout), raise_error=False)
        if resp.code == 599:
            raise OSError(str(resp.error))
        return StorageClient.Response(resp.code, resp.headers)


async def upload_resumable(client: Any, upload: Dict[str, Any], path: pathlib.Path, resume: bool = False) -> None:
    """Upload a file to the storage target the platform gave: "gcs-resumable"
    in 8 MiB chunks, resuming from where the last attempt stopped, or one "put".
    Never through the API, and never through the phone. Raises CommunityCADError."""
    size = path.stat().st_size
    base = dict(upload.get("headers") or {})
    method = str(upload.get("method") or "PUT")

    async def put(body: bytes, extra: Dict[str, str]) -> Any:
        try:
            return await client.request(method, upload["url"], body=body, headers={**base, **extra},
                                        connect_timeout=10., request_timeout=180.)
        except Exception as exc:
            raise CommunityCADError("The timelapse upload was cut off.", code=503, reason="unreachable") from exc

    if upload.get("protocol") != "gcs-resumable":
        resp = await put(path.read_bytes(), {})
        if resp.status_code not in (200, 201):
            raise CommunityCADError(f"Storage refused the timelapse ({resp.status_code}).",
                                    code=503 if resp.status_code >= 500 else resp.status_code)
        return

    def next_byte(resp: Any) -> int:
        got = str(resp.headers.get("Range") or "")
        m = re.match(r"bytes=0-(\d+)", got)
        return int(m.group(1)) + 1 if m else 0

    start = 0
    if resume:
        resp = await put(b"", {"Content-Range": f"bytes */{size}"})
        if resp.status_code in (200, 201):
            return
        if resp.status_code != 308:
            raise CommunityCADError("The timelapse upload expired; it starts again.", code=410)
        start = next_byte(resp)
    with path.open("rb") as f:
        while start < size:
            f.seek(start)
            chunk = f.read(UPLOAD_CHUNK)
            end = start + len(chunk) - 1
            resp = await put(chunk, {"Content-Range": f"bytes {start}-{end}/{size}"})
            if resp.status_code in (200, 201):
                return
            if resp.status_code == 308:
                start = next_byte(resp) or end + 1
                continue
            raise CommunityCADError(f"Storage refused the timelapse ({resp.status_code}).",
                                    code=503 if resp.status_code >= 500 else resp.status_code)


def orca_filament_keys() -> list:
    """Orca's filament setting names (generated by dev/gen_orca_filament_options.py)."""
    global _ORCA_FILAMENT_KEYS
    if _ORCA_FILAMENT_KEYS is None:
        here = pathlib.Path(__file__).resolve().parent
        data = json.loads(here.joinpath("orca_filament_options.json").read_text())
        _ORCA_FILAMENT_KEYS = list(data["keys"])
    return _ORCA_FILAMENT_KEYS


def parse_sections(text: str, word: str, known: set, what: str, blocked: frozenset = frozenset()) -> tuple:
    """Parse a materials.cfg-style file of `[<word> <name>]` sections. Returns
    ({name: {"inherits", "values", "line"}}, problems).

    Klipper's config style: `key: value` or `key = value`, and indented lines
    continue the previous value. Lines starting with # or ; are comments at the top
    level only: inside an indented block they're part of the value, because G-code
    uses ; for its own comments. Problems are reported, never fatal.
    """
    header = re.compile(r"^\[%s\s+([^\]]+?)\s*\]\s*$" % re.escape(word))
    sections: Dict[str, Dict[str, Any]] = {}
    problems: list = []
    current: Optional[Dict[str, Any]] = None
    key: Optional[str] = None
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        if not line.strip():
            key = None if current is None else key
            continue
        if raw[:1] in (" ", "\t") and current is not None and key is not None:
            value = current["values"][key]
            current["values"][key] = (value + "\n" if value else "") + line.strip()
            continue
        stripped = line.strip()
        if stripped[0] in "#;":
            continue
        section = header.match(stripped)
        if section:
            name = section.group(1)
            if name in sections:
                problems.append(f"line {number}: [{word} {name}] appears twice; the first is used")
                current = {"inherits": "", "values": {}, "line": number}
            else:
                current = sections.setdefault(name, {"inherits": "", "values": {}, "line": number})
            key = None
            continue
        if stripped.startswith("["):
            current, key = None, None
            problems.append(f"line {number}: {stripped} isn't a [{word} ...] section; ignored")
            continue
        if current is None:
            problems.append(f"line {number}: setting outside any [{word}] section; ignored")
            continue
        m = re.match(r"^([A-Za-z0-9_]+)\s*[:=]\s*(.*)$", stripped)
        if not m:
            problems.append(f"line {number}: can't read this line; ignored")
            key = None
            continue
        key, value = m.group(1), m.group(2).strip()
        if key == "inherits":
            current["inherits"] = value
            key = None
        elif key in blocked:
            problems.append(f"line {number}: {key} can't be set here; ignored")
            key = None
        elif key not in known:
            problems.append(f"line {number}: {key} isn't an OrcaSlicer {what} setting; ignored")
            key = None
        else:
            current["values"][key] = value
    return sections, problems


def parse_materials(text: str) -> tuple:
    """Parse materials.cfg."""
    return parse_sections(text, "material", set(orca_filament_keys()), "filament")


def format_section(word: str, name: str, inherits: str, values: Dict[str, str], order: list) -> str:
    lines = [f"[{word} {name}]"]
    if inherits:
        lines.append(f"inherits: {inherits}")
    for key in order:
        if key not in values:
            continue
        value = str(values[key])
        if "\n" in value:
            lines.append(f"{key}:")
            lines.extend(f"    {part}" if part.strip() else "" for part in value.split("\n"))
        else:
            lines.append(f"{key}: {value}")
    return "\n".join(lines) + "\n"


def format_material(name: str, inherits: str, values: Dict[str, str]) -> str:
    return format_section("material", name, inherits, values, orca_filament_keys())


def replace_material(text: str, name: str, block: Optional[str]) -> str:
    return replace_section(text, "material", name, block)


def replace_section(text: str, word: str, name: str, block: Optional[str]) -> str:
    """Replace (or remove, with block=None) one section, leaving every other byte.

    A section runs from its header to the next section header. Comment lines at
    its end are kept with it: they usually introduce whatever follows.
    """
    header = re.compile(r"^\[%s\s+([^\]]+?)\s*\]\s*$" % re.escape(word))
    lines = text.splitlines(keepends=True)
    start = None
    for i, line in enumerate(lines):
        m = header.match(line.strip())
        if m and m.group(1) == name:
            start = i
            break
    if start is None:
        if block is None:
            return text
        sep = "" if not text or text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n")
        return text + sep + block
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].strip().startswith("[") and lines[j][:1] not in (" ", "\t"):
            end = j
            break
    # Leave trailing blank and comment lines to whatever comes next.
    while end > start + 1 and (not lines[end - 1].strip()
                               or (lines[end - 1].lstrip()[:1] in "#" and lines[end - 1][:1] not in (" ", "\t"))):
        end -= 1
    new = [] if block is None else [block]
    rest = lines[end:]
    if block is None:
        while rest and not rest[0].strip():
            rest = rest[1:]
    return "".join(lines[:start] + new + rest)


MATERIAL_GROUPS = [
    # Roughly OrcaSlicer's filament tabs, so settings are where an Orca user looks.
    ("Pressure advance", re.compile(r"pressure_advance")),
    ("G-code", re.compile(r"_gcode$")),
    ("Ironing", re.compile(r"ironing")),
    ("Retraction", re.compile(r"retract|z_hop|filament_wipe|deretraction|retraction_distances")),
    ("Multi-material", re.compile(r"ramming|loading|unloading|toolchange|cooling_moves|stamping|"
                                  r"tower|purge|flush|change_length|cooling_before|extruder_variant|"
                                  r"cooling_initial|cooling_final")),
    ("Temperature", re.compile(r"temperature|plate_temp|chamber|bed_type")),
    ("Cooling", re.compile(r"fan|slow_down|cooling|air_filtration|exhaust")),
]


# Orca's process tabs, in Orca's order; first match wins.
PROCESS_GROUPS = [
    ("Speed", re.compile(r"(_speed$|_speed_z$|acceleration|_jerk$|junction_deviation|^accel_to_decel|"
                         r"^enable_overhang_speed$|^slow_down_layers$|^slowdown_for_curled|^small_perimeter|"
                         r"max_volumetric_extrusion_rate_slope|^extrusion_rate_smoothing)")),
    ("Support", re.compile(r"^(support_|tree_support_|raft_|enable_support|enforce_support|"
                           r"independent_support_layer_height|bridge_no_support)")),
    ("Multimaterial", re.compile(r"(wipe_tower|prime_tower|^prime_volume|^flush_into|^wiping_volumes|"
                                 r"^ooze_prevention|^standby_temperature|^interlocking|^single_extruder_multi|"
                                 r"^enable_tower|^mmu_|^interface_shells|_filament$|_filament_id$|^preheat)")),
    ("Strength", re.compile(r"(^wall_loops|^alternate_extra_wall|shell|infill|^top_surface_density|"
                            r"^bottom_surface_density|^extra_solid|^ensure_vertical|^lightning_|^gyroid|"
                            r"^lateral_lattice|^fill_multiline|^skeleton_|^skin_|^minimum_sparse|"
                            r"^align_infill|^symmetric_infill|_surface_pattern$|^gap_fill|^detect_narrow)")),
    ("Others", re.compile(r"^(skirt_|brim_|combine_brims|draft_shield|single_loop_draft|min_skirt|spiral_mode|"
                          r"slicing_mode|print_sequence|print_order|fuzzy_skin|gcode_|exclude_object|"
                          r"reduce_infill_retraction|timelapse|notes|process_change|hole_to_polyhole|zaa_|"
                          r"make_overhang_printable|calib_)")),
]


def process_group(key: str) -> str:
    """Which of Orca's process tabs a setting lives on; Quality otherwise."""
    for name, pattern in PROCESS_GROUPS:
        if pattern.search(key):
            return name
    return "Quality"


def filament_group(key: str) -> str:
    for name, pattern in MATERIAL_GROUPS:
        if pattern.search(key):
            return name
    return "Filament"


def orca_value(base_value: Any, text: str) -> Any:
    """A materials.cfg value in the shape Orca's JSON uses for that key."""
    if isinstance(base_value, list):
        if len(base_value) > 1 and "," in text and "\n" not in text:
            return [part.strip() for part in text.split(",")]
        return [text]
    return text


MATERIAL_TYPES = ("PETG", "PLA", "ABS", "ASA", "TPU", "PCTG", "PC", "PA", "PET", "PVA", "HIPS")


def check_process(raw: Any, nozzle: float = 0.4) -> Dict[str, str]:
    """Process overrides from the browser, checked and in Orca's string format.

    Raises ValueError with a plain message for an unknown key or a bad value.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("Process settings must be a set of names and values.")
    out: Dict[str, str] = {}
    for key, value in raw.items():
        spec = PROCESS_SETTINGS.get(key)
        if spec is None:
            raise ValueError(f"{key} isn't a setting the plugin can change. Use desktop Orca for it.")
        kind = spec["type"]
        text = str(value).strip()
        if kind == "bool":
            if isinstance(value, bool):
                out[key] = "1" if value else "0"
            elif text in ("0", "1"):
                out[key] = text
            else:
                raise ValueError(f"{key} must be on or off.")
            continue
        if kind == "choice":
            if text not in spec["choices"]:
                raise ValueError(f"{text} isn't a choice for {key}.")
            out[key] = text
            continue
        try:
            number = float(text.rstrip("%"))
        except ValueError:
            raise ValueError(f"{key} must be a number.") from None
        high = spec.get("max", round(nozzle * spec.get("nozzle_share", 1), 3))
        if not spec["min"] <= number <= high or (kind in ("int", "percent") and number != int(number)):
            raise ValueError(f"{key} must be {'a whole number ' if kind != 'float' else ''}"
                             f"from {spec['min']:g} to {high:g}.")
        out[key] = (f"{int(number)}%" if kind == "percent" else str(int(number)) if kind == "int"
                    else f"{number:g}")
    return out


def legacy_process(opts: Dict[str, Any]) -> Dict[str, str]:
    """The overrides behind the old fixed choices (infill, supports, brim), so
    older projects slice exactly as they did."""
    out: Dict[str, str] = {}
    if "infill" in opts:
        out["sparse_infill_density"] = f"{int(opts['infill'])}%"
    if "supports" in opts:
        out["enable_support"] = "1" if opts["supports"] else "0"
        out["support_type"] = "tree(auto)"
    if "brim" in opts:
        out["brim_type"] = "auto_brim" if opts["brim"] else "no_brim"
    return out


def process_defaults(profiles: "OrcaProfiles", profile: Any) -> Dict[str, str]:
    """A profile's own values for every setting the quick editor offers."""
    preset = profile_preset(profiles, profile)
    out = {}
    for key in PROCESS_SETTINGS:
        value = preset.get(key, PROCESS_FALLBACK.get(key))
        if isinstance(value, list):
            value = value[0] if value else None
        if value is not None:
            out[key] = str(value)
    return out


def material_look(name: str, material: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """What the plate viewer draws a material with: its own colour when
    materials.cfg sets Orca's default_filament_colour, and its type, so the UI can
    fall back to a colour per type. The type comes from filament_type, else from
    the preset names: "Generic PETG @System" is PETG."""
    values = material.get("values") or {}
    colour = str(values.get("default_filament_colour") or "").strip()
    kind = str(values.get("filament_type") or "").strip().upper()
    if not kind:
        words = re.findall(r"[A-Za-z]+", f"{material.get('inherits') or ''} {name}".upper())
        kind = next((t for t in MATERIAL_TYPES if t in words), "")
    return {"colour": colour if re.fullmatch(r"#[0-9A-Fa-f]{6}", colour) else None, "type": kind or None}


def display_value(value: Any) -> str:
    if isinstance(value, list):
        return ",".join(str(v) for v in value) if len(value) > 1 else (str(value[0]) if value else "")
    return "" if value is None else str(value)


def parse_file_types(value: Any) -> frozenset:
    """The `types` search argument: comma-separated FILE_TYPES. Empty means no filter."""
    if value is None or value == "":
        return frozenset()
    parts = {p.strip().lower() for p in str(value).split(",") if p.strip()}
    unknown = parts.difference(FILE_TYPES)
    if unknown:
        raise ValueError(
            f"Unknown file type: {', '.join(sorted(unknown))}. "
            f"Use {', '.join(FILE_TYPES)}.")
    return frozenset(parts)


FOLDER_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$")


def clean_send_folder(value: Any) -> str:
    """A safe folder inside the G-code files, or ValueError saying why not.

    Up to three levels of plain names. Never absolute, never "..", so a setting can
    only ever choose a place inside the printer's G-code files.
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("The folder must be text.")
    parts = [p for p in value.strip().strip("/").split("/") if p.strip()]
    if len(parts) > 3:
        raise ValueError("Use at most three folder levels.")
    for part in parts:
        part = part.strip()
        if part in (".", "..") or not FOLDER_PART.match(part):
            raise ValueError(
                f'"{part}" can\'t be used as a folder name. Use letters, numbers, '
                "spaces, dots, dashes and underscores.")
    return "/".join(p.strip() for p in parts)


class PlateError(Exception):
    """A sliced 3MF we won't extract, with a reason fit to show the user."""


# ------------------------------------------------------------ placement
# A model's placement on the plate is its build item's transform in the project 3MF,
# as in desktop Orca: 12 numbers, row vectors (p' = p . M), the last three the
# translation. Orca's CLI crashes on a model sunk below the bed (its "sinking" check
# asks for the desktop window), so every placement written here is dropped onto
# the bed exactly, from the model's own points.

def tf_matrix(t: list) -> list:
    return [list(t[0:3]) + [0.0], list(t[3:6]) + [0.0], list(t[6:9]) + [0.0], list(t[9:12]) + [1.0]]


def tf_list(m: list) -> list:
    return m[0][:3] + m[1][:3] + m[2][:3] + m[3][:3]


def tf_mul(a: list, b: list) -> list:
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def parse_transform(text: Optional[str]) -> list:
    values = [float(x) for x in (text or "").split()]
    if len(values) != 12:
        return [1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0, 0, 0, 0]
    return values


def is_rotation(t: list, tolerance: float = 1e-3) -> bool:
    """A rigid placement: the linear part is a proper rotation, no scale or mirror."""
    if len(t) != 12 or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in t):
        return False
    rows = [t[0:3], t[3:6], t[6:9]]
    for i in range(3):
        for j in range(3):
            dot = sum(rows[i][k] * rows[j][k] for k in range(3))
            if abs(dot - (1.0 if i == j else 0.0)) > tolerance:
                return False
    det = (rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1])
           - rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0])
           + rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]))
    return det > 0


_ITEM = re.compile(r'<item\b[^>]*?objectid="(\d+)"[^>]*>')
_VERTEX = re.compile(r'<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"')


def project_items(root_xml: str) -> Dict[tuple, list]:
    """{(object id, instance number): transform} for every build item."""
    out: Dict[tuple, list] = {}
    counts: Dict[str, int] = {}
    for m in _ITEM.finditer(root_xml):
        obj = m.group(1)
        inst = counts.get(obj, 0)
        counts[obj] = inst + 1
        t = re.search(r'transform="([^"]*)"', m.group(0))
        out[(obj, inst)] = parse_transform(t.group(1) if t else None)
    return out


def object_points(archive: zipfile.ZipFile, root_path: str, object_id: str) -> list:
    """An object's vertices in its own space (its components' transforms applied),
    following Orca's split files (p:path)."""
    texts: Dict[str, str] = {}

    def text(path: str) -> str:
        if path not in texts:
            texts[path] = archive.read(path).decode("utf-8", "replace")
        return texts[path]

    def walk(path: str, obj: str, m: list, depth: int) -> list:
        xml = text(path)
        start = re.search(r'<object\b[^>]*\bid="%s"[^>]*>' % re.escape(obj), xml)
        if not start or depth > 8:
            return []
        end = xml.find("</object>", start.end())
        body = xml[start.end(): end if end >= 0 else len(xml)]
        points = []
        if "<mesh" in body:
            for vx, vy, vz in _VERTEX.findall(body):
                p = [float(vx), float(vy), float(vz), 1.0]
                points.append(tuple(sum(p[k] * m[k][j] for k in range(4)) for j in range(3)))
        for c in re.finditer(r"<component\b[^>]*>", body):
            tag = c.group(0)
            ref = re.search(r'objectid="(\d+)"', tag)
            sub = re.search(r'p:path="/?([^"]+)"', tag)
            tf = re.search(r'transform="([^"]*)"', tag)
            if ref:
                points += walk(sub.group(1) if sub else path, ref.group(1),
                               tf_mul(tf_matrix(parse_transform(tf.group(1) if tf else None)), m), depth + 1)
        return points

    identity = tf_matrix(parse_transform(None))
    return walk(root_path, object_id, identity, 0)


def dropped(points: list, transform: list) -> list:
    """transform with its Z translation set so the lowest point sits on the bed."""
    if not points:
        return transform
    m = tf_matrix(transform)
    lowest = min(p[0] * m[0][2] + p[1] * m[1][2] + p[2] * m[2][2] for p in points)
    out = list(transform)
    out[11] = -lowest
    return out


def write_item_transforms(root_xml: str, changes: Dict[tuple, list]) -> str:
    """root_xml with the given build items' transforms replaced."""
    counts: Dict[str, int] = {}

    def sub(m: "re.Match") -> str:
        obj = m.group(1)
        inst = counts.get(obj, 0)
        counts[obj] = inst + 1
        new = changes.get((obj, inst))
        if new is None:
            return m.group(0)
        value = " ".join(f"{x:.9g}" for x in new)
        tag = m.group(0)
        if 'transform="' in tag:
            return re.sub(r'transform="[^"]*"', f'transform="{value}"', tag, count=1)
        return tag.replace("<item", f'<item transform="{value}"', 1)

    return _ITEM.sub(sub, root_xml)


def object_sources(settings_xml: str) -> Dict[str, str]:
    """{object id: the model file it came from}, from Orca's model_settings.config."""
    out = {}
    for m in re.finditer(r'<object id="(\d+)">(.*?)</object>', settings_xml or "", re.S):
        src = re.search(r'key="source_file" value="([^"]*)"', m.group(2))
        if src:
            out[m.group(1)] = src.group(1)
    return out


def plain_wait(seconds: float) -> str:
    """74335 -> "about 21 hours", 90 -> "2 minutes", 20 -> "20 seconds"."""
    s = max(0, int(seconds))
    if s < 60:
        return f"{s} seconds"
    if s < 3600:
        m = round(s / 60)
        return f"{m} minute{'s' if m != 1 else ''}"
    h = round(s / 3600)
    return f"about {h} hour{'s' if h != 1 else ''}"


# --- what a G-code file was sliced for ----------------------------------------
# The match check used to compare only height and nozzle, so a file sliced in Bambu
# Studio for an X1 Carbon passed as "no problems found" on a Voron. These read what
# the file says it's for: the printer, its bed, and firmware commands Klipper lacks.
HEADER_KEYS = ("printer_model", "printer_settings_id", "printable_area", "bed_shape", "gcode_flavor",
               "filament_settings_id", "filament_type")
# Bambu Lab firmware only: AMS changes, its own job markers, calibration.
BAMBU_COMMANDS = re.compile(r"^\s*(M620|M621|M622|M623|M1002|M960|M9833|G29\.1|M970|M975)\b", re.M)
OWN_PRINTER_ID = "CommunityCAD printer"   # printer_settings_id of the plugin's own slices


def read_gcode_header(path: pathlib.Path) -> Dict[str, Any]:
    """What a G-code file says about the printer it was sliced for: the config keys
    above (from the top and the end of the file, where slicers put them) and the
    Bambu-only commands it uses."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            head = fh.read(256 * 1024)
            tail = b""
            if size > 256 * 1024:
                fh.seek(max(256 * 1024, size - 512 * 1024))
                tail = fh.read()
    except OSError:
        return {}
    text = (head + b"\n" + tail).decode("utf-8", "replace")
    out: Dict[str, Any] = {}
    for key in HEADER_KEYS:
        m = re.search(r"^;\s*%s\s*=\s*(.*)$" % key, text, re.M)
        if m:
            out[key] = m.group(1).strip()
    found = sorted(set(BAMBU_COMMANDS.findall(head.decode("utf-8", "replace"))))
    if found:
        out["bambu_commands"] = found
    return out


def bed_from_header(header: Dict[str, Any]) -> Optional[tuple]:
    """(width, depth) of the bed the file was sliced for, from printable_area or
    PrusaSlicer's bed_shape ("0x0,256x0,256x256,0x256")."""
    raw = header.get("printable_area") or header.get("bed_shape") or ""
    xs, ys = [], []
    for pt in raw.split(","):
        try:
            x, y = pt.strip().split("x")
            xs.append(float(x)); ys.append(float(y))
        except ValueError:
            continue
    if len(xs) < 3:
        return None
    return (max(xs) - min(xs), max(ys) - min(ys))


def gcode_materials(header: Dict[str, Any]) -> list:
    """The materials a G-code file was sliced for, by name where the slicer gave one
    ("Generic ABS"), else by type ("ABS"); one per filament, repeats dropped."""
    for key in ("filament_settings_id", "filament_type"):
        raw = str(header.get(key) or "")
        names = [n.strip().strip('"').strip() for n in raw.split(";")]
        names = [n for n in dict.fromkeys(names) if n]
        if names:
            return names
    return []


def header_checks(header: Dict[str, Any], printer_name: Optional[str],
                  volume: Optional[Dict[str, Any]]) -> list:
    """(check, status, detail) for the printer, its bed and its firmware."""
    out = []
    model = (header.get("printer_model") or "").strip()
    settings_id = (header.get("printer_settings_id") or "").strip()
    if settings_id == OWN_PRINTER_ID:
        out.append(("printer", "ok", "Sliced for this printer by CommunityCAD."))
    elif model or settings_id:
        named = model or re.sub(r"\s+\d+(\.\d+)?\s*nozzle.*$|\s+-\s+.*$", "", settings_id)
        if not printer_name:
            out.append(("printer", "unknown", f"Sliced for a {named}; this printer's model isn't known."))
        else:
            a, b = named.lower(), printer_name.lower()
            same = a in b or b in a or (
                set(re.findall(r"[a-z0-9]+", a)) >= set(re.findall(r"[a-z0-9]+", b)) - {"printer"})
            if same:
                out.append(("printer", "ok", f"Sliced for a {named}."))
            else:
                out.append(("printer", "warn", f"Sliced for a {named}; this printer is a {printer_name}."))
    bed = bed_from_header(header)
    if bed and volume:
        if bed[0] > float(volume["x"]) + 0.5 or bed[1] > float(volume["y"]) + 0.5:
            out.append(("bed", "warn", f"Sliced for a {bed[0]:.0f} × {bed[1]:.0f} mm bed, bigger than this "
                                       f"printer's {float(volume['x']):.0f} × {float(volume['y']):.0f} mm."))
        else:
            out.append(("bed", "ok", f"Sliced for a {bed[0]:.0f} × {bed[1]:.0f} mm bed, which this printer covers."))
    if header.get("bambu_commands"):
        out.append(("firmware", "warn", "Made for Bambu Lab firmware: it uses commands Klipper doesn't have ("
                    + ", ".join(header["bambu_commands"][:4]) + "), so the print would stop or go wrong."))
    return out


def plate_contents(settings_xml: str) -> Dict[int, Dict[str, int]]:
    """{plate number: {source model file: copies}}, from Orca's model_settings.config
   : which object sits on which plate, and the file each object came from."""
    sources = object_sources(settings_xml)
    out: Dict[int, Dict[str, int]] = {}
    for m in re.finditer(r"<plate>(.*?)</plate>", settings_xml or "", re.S):
        number = re.search(r'key="plater_id" value="(\d+)"', m.group(1))
        if not number:
            continue
        files: Dict[str, int] = {}
        for obj in re.findall(r'<model_instance>.*?key="object_id" value="(\d+)".*?</model_instance>', m.group(1), re.S):
            src = sources.get(obj)
            if src:
                files[src] = files.get(src, 0) + 1
        out[int(number.group(1))] = files
    return out


def credited_models(files: Dict[str, int], saved: Dict[str, Any]) -> tuple:
    """The CommunityCAD models on a plate, each once with the files printed and their
    copies, and how many of the user's own parts were there too."""
    models: Dict[int, Dict[str, Any]] = {}
    own = 0
    for name, copies in files.items():
        entry = saved.get(name) or saved.get(os.path.basename(name)) or {}
        if not entry.get("model_id"):
            own += copies
            continue
        m = models.setdefault(int(entry["model_id"]), {
            "model_id": int(entry["model_id"]), "title": entry.get("title"), "slug": entry.get("slug"), "files": []})
        m["files"].append({"file_id": entry.get("file_id"), "filename": entry.get("filename") or name,
                           "copies": copies})
    return list(models.values()), own


def rewrite_3mf(path: pathlib.Path, replace: Dict[str, bytes]) -> None:
    """Write a copy of the zip with some entries replaced, then swap it in."""
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:6]}.tmp")
    try:
        with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                data = replace.get(info.filename)
                zout.writestr(info, data if data is not None else zin.read(info.filename))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def place_in_3mf(path: pathlib.Path, changes: Dict[tuple, list]) -> Dict[tuple, list]:
    """Apply placements to a project file, each dropped onto the bed. Returns what
    was written. Raises ValueError for an unknown model or a placement that isn't
    a plain rotation and move."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        root_path = next((n for n in names if n.lower() == "3d/3dmodel.model"), "3D/3dmodel.model")
        root_xml = z.read(root_path).decode("utf-8", "replace")
        items = project_items(root_xml)
        written = {}
        for key, transform in changes.items():
            if key not in items:
                raise ValueError("That model isn't in this project.")
            if not is_rotation(transform):
                raise ValueError("A placement can only turn and move a model.")
            if any(abs(x) > 100000 for x in transform[9:12]):
                raise ValueError("That placement is far off the plate.")
            written[key] = dropped(object_points(z, root_path, key[0]), transform)
    rewrite_3mf(path, {root_path: write_item_transforms(root_xml, written).encode()})
    return written


def reapply_orientations(path: pathlib.Path, orientations: Dict[str, list]) -> int:
    """After a rebuild, turn every copy of a remembered model back onto its face:
    the remembered rotation, the current spot, dropped onto the bed. Returns how
    many models were turned."""
    with zipfile.ZipFile(path) as z:
        settings = z.read("Metadata/model_settings.config").decode("utf-8", "replace") \
            if "Metadata/model_settings.config" in z.namelist() else ""
        root_path = next((n for n in z.namelist() if n.lower() == "3d/3dmodel.model"), "3D/3dmodel.model")
        items = project_items(z.read(root_path).decode("utf-8", "replace"))
    sources = object_sources(settings)
    changes = {}
    for (obj, inst), t in items.items():
        tilt = orientations.get(sources.get(obj, ""))
        if tilt and len(tilt) == 9:
            changes[(obj, inst)] = list(tilt) + t[9:12]
    if changes:
        place_in_3mf(path, changes)
    return len(changes)


# ------------------------------------------------------------ layer pauses
# Orca keeps per-layer G-code in Metadata/custom_gcode_per_layer.xml, so desktop
# Orca shows the same markers. Checked with Orca 2.4.2's CLI on a Pi 4:
#   - type 1 (pause) runs the printer's machine_pause_gcode: PAUSE on our presets;
#   - type 4 (custom) runs the G-code in its `extra` attribute (`gcode` is ignored);
#   - type 0 (a single-extruder colour change) emits nothing on these presets.
# So "Change filament here" is a custom M600, or PAUSE where there's no M600.
# Either runs at the change to that layer, before it prints.

LAYER_GCODE_FILE = "Metadata/custom_gcode_per_layer.xml"
LAYER_MARKERS_MAX = 50
LAYER_PAUSE, LAYER_CUSTOM = 1, 4
FILAMENT_GCODES = ("M600", "PAUSE")


def _layer_xml(z: zipfile.ZipFile) -> Optional[str]:
    if LAYER_GCODE_FILE not in z.namelist():
        return None
    text = z.read(LAYER_GCODE_FILE)[:200_000].decode("utf-8", "replace")
    # Entities are never needed here and are how XML bombs work.
    return None if "<!ENTITY" in text or "<!DOCTYPE" in text else text


def _plate_ids(z: zipfile.ZipFile) -> set:
    if "Metadata/model_settings.config" not in z.namelist():
        return set()
    text = z.read("Metadata/model_settings.config").decode("utf-8", "replace")
    return {int(n) for n in re.findall(r'key="plater_id" value="(\d+)"', text)}


def _is_ours(layer: Any) -> Optional[str]:
    """"pause" or "filament" for a marker the plugin manages, else None (kept as is)."""
    try:
        kind = int(layer.get("type", "-1"))
    except ValueError:
        return None
    if kind == LAYER_PAUSE:
        return "pause"
    if kind == LAYER_CUSTOM and (layer.get("extra") or "").strip().upper() in FILAMENT_GCODES:
        return "filament"
    return None


def read_layer_markers(path: pathlib.Path) -> list:
    """The pauses and filament changes in a project, plate by plate, lowest first."""
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(path) as z:
        text = _layer_xml(z)
    if not text:
        return []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    out = []
    for plate in root.iter("plate"):
        info = plate.find("plate_info")
        try:
            plate_id = int(info.get("id")) if info is not None else 1
        except (TypeError, ValueError):
            continue
        for layer in plate.iter("layer"):
            kind = _is_ours(layer)
            try:
                z_mm = round(float(layer.get("top_z")), 3)
            except (TypeError, ValueError):
                continue
            if kind:
                out.append({"plate": plate_id, "z": z_mm, "kind": kind,
                            "gcode": (layer.get("extra") or "").strip().upper() if kind == "filament" else "PAUSE"})
    return sorted(out, key=lambda m: (m["plate"], m["z"]))


def write_layer_markers(path: pathlib.Path, markers: list) -> int:
    """Replace the project's pauses and filament changes with `markers`, keeping
    any other per-layer G-code the project had. Markers on plates the project
    doesn't have are dropped. Returns how many were written."""
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(path) as z:
        text = _layer_xml(z)
        plates = _plate_ids(z)
    root = None
    if text:
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            root = None
    if root is None:
        root = ET.Element("custom_gcodes_per_layer")
    by_plate = {}
    for plate in root.findall("plate"):
        info = plate.find("plate_info")
        try:
            by_plate[int(info.get("id"))] = plate
        except (AttributeError, TypeError, ValueError):
            continue
        for layer in list(plate.findall("layer")):
            if _is_ours(layer):
                plate.remove(layer)
    written = 0
    for m in sorted(markers, key=lambda m: (m["plate"], m["z"])):
        if plates and m["plate"] not in plates:
            continue
        plate = by_plate.get(m["plate"])
        if plate is None:
            plate = ET.SubElement(root, "plate")
            ET.SubElement(plate, "plate_info", id=str(m["plate"]))
            ET.SubElement(plate, "mode", value="SingleExtruder")
            by_plate[m["plate"]] = plate
        pause = m["kind"] == "pause"
        layer = ET.Element("layer", top_z=f"{m['z']:g}", type=str(LAYER_PAUSE if pause else LAYER_CUSTOM),
                           extruder="1", color="", extra="" if pause else m["gcode"],
                           gcode="PAUSE" if pause else m["gcode"])
        mode = plate.find("mode")
        if mode is not None:
            plate.insert(list(plate).index(mode), layer)
        else:
            plate.append(layer)
        written += 1
    for plate in list(root.findall("plate")):
        if plate.find("layer") is None:
            root.remove(plate)
    keep = root.find("plate") is not None
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n") if keep else None
    tmp = path.with_name(path.name + ".tmp")
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename != LAYER_GCODE_FILE:
                zout.writestr(info, zin.read(info.filename))
        if xml:
            zout.writestr(LAYER_GCODE_FILE, xml)
    os.replace(tmp, path)
    return written


def clean_layer_markers(raw: Any, height: float, filament_gcode: Optional[str]) -> list:
    """Markers as the browser sends them, checked: plate, height, kind. One per
    layer and plate; the newest wins."""
    if not isinstance(raw, list) or len(raw) > LAYER_MARKERS_MAX:
        raise ValueError(f"Up to {LAYER_MARKERS_MAX} pauses and filament changes per project.")
    out: Dict[tuple, Dict[str, Any]] = {}
    for item in raw:
        try:
            plate, z_mm, kind = int(item["plate"]), round(float(item["z"]), 3), str(item["kind"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("Each pause needs a plate, a height and a kind.") from None
        if plate < 1 or plate > 99 or not (0 < z_mm <= max(height, 1.0)) or kind not in ("pause", "filament"):
            raise ValueError("That pause isn't on the plate.")
        out[(plate, z_mm)] = {"plate": plate, "z": z_mm, "kind": kind,
                              "gcode": "PAUSE" if kind == "pause" else (filament_gcode or "PAUSE")}
    return sorted(out.values(), key=lambda m: (m["plate"], m["z"]))


# ------------------------------------------------------------ spacing
# Orca's CLI arranges with its spacing hard-coded to 0 (src/OrcaSlicer.cpp:
# arrange_cfg.min_obj_distance = 0), so a chosen spacing is packed here: each
# model's footprint (brim included), the gap between them, plate after plate on
# Orca's grid, each plate's group centred as Orca centres it. Orca honours the
# plate lists written into model_settings.config (checked against Orca's CLI).

ARRANGE_SPACING_MAX = 100.0
PLATE_GAP = 0.2                      # Orca's LOGICAL_PART_PLATE_GAP: plates 1.2 beds apart


def plate_columns(count: int) -> int:
    """Orca's PartPlateList::compute_colum_count."""
    value = math.sqrt(count)
    rounded = round(value)
    return int(rounded + 1 if value > rounded else rounded)


def compact_pack(sizes: list, width: float, depth: float) -> list:
    """Rectangles (w, d) into width x depth plates, grouped tightly as Orca groups
    them: biggest first, each next one tried against every edge of those already
    placed, keeping the spot that leaves the group smallest and squarest and
    nearest its middle. What doesn't fit goes to the next plate. Returns
    [(plate, x, y, group_w, group_d)] in the input order, x and y from the
    group's corner. Raises ValueError when one rectangle alone doesn't fit."""
    for w, d in sizes:
        if w > width + 1e-6 or d > depth + 1e-6:
            raise ValueError("A model is too big for the bed with that spacing.")
    out: list = [None] * len(sizes)
    left = sorted(range(len(sizes)), key=lambda i: -(sizes[i][0] * sizes[i][1]))
    plate = 0
    eps = 1e-6
    while left:
        placed: list = []                      # (i, x, y, w, d)
        box = [0.0, 0.0, 0.0, 0.0]             # the group's x0, y0, x1, y1
        rest = []
        for i in left:
            w, d = sizes[i]
            if not placed:
                placed.append((i, 0.0, 0.0, w, d))
                box = [0.0, 0.0, w, d]
                continue
            spots = set()
            for _, px, py, pw, pd in placed:
                for x in (px + pw, px - w):            # beside it, either side
                    spots.add((x, py))
                    spots.add((x, py + pd - d))
                for y in (py + pd, py - d):            # above or below it
                    spots.add((px, y))
                    spots.add((px + pw - w, y))
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            best = None
            for x, y in spots:
                if any(x < qx + qw - eps and qx < x + w - eps and y < qy + qd - eps and qy < y + d - eps
                       for _, qx, qy, qw, qd in placed):
                    continue
                gx0, gy0 = min(box[0], x), min(box[1], y)
                gx1, gy1 = max(box[2], x + w), max(box[3], y + d)
                gw, gd = gx1 - gx0, gy1 - gy0
                if gw > width + eps or gd > depth + eps:
                    continue
                score = (round(max(gw, gd), 3), round(gw * gd, 1),
                         abs(x + w / 2 - cx) + abs(y + d / 2 - cy))
                if best is None or score < best[0]:
                    best = (score, x, y, (gx0, gy0, gx1, gy1))
            if best is None:
                rest.append(i)
                continue
            _, x, y, nb = best
            placed.append((i, x, y, w, d))
            box = list(nb)
        gw, gd = box[2] - box[0], box[3] - box[1]
        for i, x, y, _, _ in placed:
            out[i] = (plate, x - box[0], y - box[1], gw, gd)
        left = rest
        plate += 1
    return out


def pack_3mf(path: pathlib.Path, bed: tuple, spacing: float, brim: float = 0.0, margin: float = 0.0) -> int:
    """Arrange a project's models with `spacing` mm between them, at least `margin`
    from the bed's edges. Writes positions and plate lists. Returns the number of
    plates.

    The spacing is between the models themselves, as a user measures it. A brim of
    `brim` mm only widens it where two brims would otherwise overlap, and keeps the
    edges clear, so a brim Orca decides not to print (auto) costs no room."""
    bw, bd = bed
    spacing = max(spacing, 2 * brim)
    margin = margin + brim
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        root_path = next((n for n in names if n.lower() == "3d/3dmodel.model"), "3D/3dmodel.model")
        root_xml = z.read(root_path).decode("utf-8", "replace")
        settings = z.read("Metadata/model_settings.config").decode("utf-8", "replace") \
            if "Metadata/model_settings.config" in names else ""
        items = project_items(root_xml)
        feet = {}
        for key, t in items.items():
            pts = object_points(z, root_path, key[0])
            m = tf_matrix(t)
            xs = [p[0] * m[0][0] + p[1] * m[1][0] + p[2] * m[2][0] for p in pts] or [0.0]
            ys = [p[0] * m[0][1] + p[1] * m[1][1] + p[2] * m[2][1] for p in pts] or [0.0]
            feet[key] = (min(xs), min(ys), max(xs), max(ys), pts)
    keys = sorted(items)
    half = spacing / 2
    sizes = [(feet[k][2] - feet[k][0] + spacing, feet[k][3] - feet[k][1] + spacing) for k in keys]
    usable_w, usable_d = bw - 2 * margin + spacing, bd - 2 * margin + spacing
    spots = compact_pack(sizes, usable_w, usable_d)
    plates = max(s[0] for s in spots) + 1 if spots else 1
    cols = plate_columns(plates)
    changes: Dict[tuple, list] = {}
    for area in range(plates):
        members = [i for i, s in enumerate(spots) if s[0] == area]
        # Centre the group on the plate, as Orca does.
        used_w, used_d = spots[members[0]][3], spots[members[0]][4]
        off_x = margin - half + (usable_w - used_w) / 2
        off_y = margin - half + (usable_d - used_d) / 2
        ox = (area % cols) * bw * (1 + PLATE_GAP)
        oy = -(area // cols) * bd * (1 + PLATE_GAP)
        for i in members:
            key = keys[i]
            x0, y0 = feet[key][0], feet[key][1]
            t = list(items[key])
            t[9] = ox + off_x + spots[i][1] + half - x0
            t[10] = oy + off_y + spots[i][2] + half - y0
            changes[key] = dropped(feet[key][4], t)
    # Orca's own instance ids are kept; new ones continue after the highest.
    ids = {(o, int(i)): v for o, i, v in re.findall(
        r'object_id" value="(\d+)"/>\s*<metadata key="instance_id" value="(\d+)"/>\s*'
        r'<metadata key="identify_id" value="(\d+)"', settings)}
    next_id = max([int(v) for v in ids.values()] or [0]) + 1
    first = re.search(r"<plate>.*?</plate>", settings, re.S)
    head = first.group(0).split("<model_instance>")[0] if first else (
        '<plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n'
        '    <metadata key="locked" value="false"/>\n')
    blocks = []
    for area in range(plates):
        h = re.sub(r'(key="plater_id" value=")\d+', lambda m: m.group(1) + str(area + 1), head)
        h = re.sub(r'(key="gcode_file" value=")[^"]*', r"\1", h)
        inst = []
        for i, s in enumerate(spots):
            if s[0] != area:
                continue
            obj, n = keys[i]
            ident = ids.get((obj, n))
            if ident is None:
                ident, next_id = str(next_id), next_id + 1
            inst.append(f'    <model_instance>\n      <metadata key="object_id" value="{obj}"/>\n'
                        f'      <metadata key="instance_id" value="{n}"/>\n'
                        f'      <metadata key="identify_id" value="{ident}"/>\n    </model_instance>\n')
        blocks.append(h.rstrip() + "\n" + "".join(inst) + "  </plate>")
    settings = re.sub(r"\s*<plate>.*?</plate>", "", settings, flags=re.S)
    anchor = "<assemble>" if "<assemble>" in settings else "</config>"
    settings = settings.replace(anchor, "\n  ".join(blocks) + "\n  " + anchor, 1)
    rewrite_3mf(path, {root_path: write_item_transforms(root_xml, changes).encode(),
                       "Metadata/model_settings.config": settings.encode()})
    return plates


def gcode_thumbnail_block(thumbs: list) -> str:
    """Thumbnails as Orca and PrusaSlicer write them, which Moonraker reads:
    `; thumbnail begin WxH <length>`, base64 in 78-character comment lines."""
    out = ["; THUMBNAIL_BLOCK_START"]
    for w, h, data in thumbs:
        b64 = base64.b64encode(data).decode()
        out += [";", f"; thumbnail begin {w}x{h} {len(b64)}"]
        out += [f"; {b64[i:i + 78]}" for i in range(0, len(b64), 78)]
        out += ["; thumbnail end"]
    out += [";", "; THUMBNAIL_BLOCK_END", ""]
    return "\n".join(out) + "\n"


def insert_gcode_thumbnails(path: pathlib.Path, thumbs: list) -> None:
    """Put thumbnails after the G-code's header block (where Orca puts them),
    replacing any already there. Streams, so a large file isn't held in memory."""
    tmp = path.with_name(path.name + ".thumbs.tmp")
    block = gcode_thumbnail_block(thumbs)
    placed = False
    skipping = False
    try:
        with path.open("r", encoding="utf-8", errors="surrogateescape", newline="") as src, \
                tmp.open("w", encoding="utf-8", errors="surrogateescape", newline="") as dst:
            for n, line in enumerate(src):
                bare = line.strip()
                if bare == "; THUMBNAIL_BLOCK_START":
                    skipping = True
                    continue
                if skipping:
                    skipping = bare != "; THUMBNAIL_BLOCK_END"
                    continue
                if not placed and n == 0 and not bare.startswith("; HEADER_BLOCK_START"):
                    dst.write(block)
                    placed = True
                dst.write(line)
                if not placed and bare == "; HEADER_BLOCK_END":
                    dst.write(block)
                    placed = True
            if not placed:
                dst.write(block)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def extract_plates(archive: pathlib.Path, dest_dir: pathlib.Path,
                   free_bytes: int) -> list:
    """Extract every plate's G-code from a sliced 3MF into dest_dir.

    Returns [(plate_number, path, bytes)] in plate order. Raises PlateError, having
    removed anything it wrote, if the file isn't a sliced 3MF or breaks a limit.
    Sizes are counted while copying rather than trusted from the zip's headers,
    which a crafted archive can lie in. Runs in a worker thread: it blocks.
    """
    written: list = []
    try:
        try:
            zf = zipfile.ZipFile(archive)
        except (zipfile.BadZipFile, OSError) as exc:
            raise PlateError("This 3MF file is damaged and can't be opened.") from exc
        with zf:
            infos = zf.infolist()
            if len(infos) > MAX_3MF_ENTRIES:
                raise PlateError("This 3MF file has too many parts to open safely.")
            names = {i.filename for i in infos}
            plates = sorted(
                ((int(m.group(1)), i) for i in infos
                 for m in [PLATE_ENTRY.match(i.filename)] if m),
                key=lambda pair: pair[0],
            )
            if not plates:
                raise PlateError(
                    "This 3MF has no sliced plates in it, so there's no G-code to "
                    "send. Download it and slice it instead.")
            declared = sum(i.file_size for _, i in plates)
            if declared > MAX_PLATES_BYTES:
                raise PlateError("The G-code in this 3MF is too large to extract.")
            if declared + DISK_HEADROOM_BYTES > free_bytes:
                raise PlateError(
                    "There isn't enough free space on the printer to extract this 3MF.")
            total = 0
            for number, info in plates:
                if info.file_size > MAX_PLATE_BYTES or (
                    info.compress_size
                    and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
                ):
                    raise PlateError(f"Plate {number} in this 3MF is too large to extract.")
                out = dest_dir.joinpath(f"{uuid.uuid4().hex}.plate{number}.part")
                written.append(out)
                digest = hashlib.md5()
                size = 0
                with zf.open(info) as src, open(out, "wb") as dst:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        size += len(chunk)
                        total += len(chunk)
                        if (size > info.file_size or size > MAX_PLATE_BYTES
                                or total > MAX_PLATES_BYTES):
                            raise PlateError(
                                f"Plate {number} in this 3MF is larger than it claims.")
                        digest.update(chunk)
                        dst.write(chunk)
                md5_name = info.filename + ".md5"
                if md5_name in names:
                    expected = zf.read(md5_name)[:64].decode("ascii", "ignore").strip().lower()
                    if expected and expected != digest.hexdigest():
                        raise PlateError(
                            f"Plate {number} in this 3MF failed its checksum, so it may be "
                            "corrupt. Nothing was added to your files.")
                written[-1] = (number, out, size)
        return written
    except BaseException:
        for item in written:
            path = item[1] if isinstance(item, tuple) else item
            pathlib.Path(path).unlink(missing_ok=True)
        raise


def _config_kinematics(result: Any) -> str:
    """printer.kinematics from a configfile query, or "" when it isn't there."""
    try:
        settings = (result.get("configfile") or {}).get("settings") or {}
        return str((settings.get("printer") or {}).get("kinematics") or "")
    except AttributeError:
        return ""


def _printable_span(axis_min: float, axis_max: float, is_z: bool) -> float:
    """How much of an axis's travel can hold a print.

    Klipper's axis limits are travel limits, not the bed. A small negative minimum is
    overtravel (probing below the bed, an endstop past its edge) and counting it
    would mark models that are too big as fitting. Nothing prints below Z 0. On
    X and Y a large negative minimum means the origin is the bed's centre, as on
    deltas, and then the whole span is the bed.
    """
    span = axis_max - axis_min
    if axis_min < 0 and (is_z or -axis_min <= CENTRED_ORIGIN_FRACTION * span):
        span = axis_max
    return round(span, 2)


def _version_core(version: str) -> tuple:
    """The numeric (major, minor, patch) of a version, ignoring any suffix.

    A build called "0.1.0-dev" is this plugin built from source at 0.1.0, not a
    pre-release that predates it. Strict semver would rank it below 0.1.0 and nag
    every developer to update; comparing the numeric core is what we actually mean.
    """
    core = version.strip().split("+", 1)[0].split("-", 1)[0]
    parts = []
    for chunk in core.split(".")[:3]:
        try:
            parts.append(int(chunk))
        except ValueError:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def is_outdated(current: str, minimum: Optional[str]) -> bool:
    """True when the API has moved past what this plugin can speak."""
    if not minimum:
        return False
    try:
        return _version_core(current) < _version_core(minimum)
    except Exception:
        return False


def _quote(value: Any) -> str:
    from urllib.parse import quote

    if isinstance(value, bool):
        return "true" if value else "false"
    return quote(str(value), safe="")


def load_component(config: ConfigHelper) -> CommunityCAD:
    return CommunityCAD(config)
