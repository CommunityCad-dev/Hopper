"""Unit tests for the Moonraker component's pure logic.

Run with Moonraker's own interpreter, which has its dependencies:

    dev/run-component-tests.sh

These cover the parts that must be right before a printer is involved: the build-volume
maths, the settings override, the token file's permissions, and the mapping from API
responses to the plugin's failure behaviour. The live half — a real toolhead, a
real approved link — is tested on a printer.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import os
import pathlib
import sys
import tempfile
import unittest
from typing import Any, Dict, Optional

MOONRAKER = os.environ.get("MOONRAKER_PATH", os.path.expanduser("~/moonraker"))
sys.path.insert(0, MOONRAKER)
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "component"))

import communitycad  # noqa: E402
from communitycad import CommunityCAD, CommunityCADError  # noqa: E402


class FakeResponse:
    def __init__(self, status: int, payload: Any = None, headers: Optional[Dict] = None):
        self.status_code = status
        self._payload = payload
        self.headers = headers or {}

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeHttpClient:
    def __init__(self) -> None:
        self.responses: list[FakeResponse] = []
        self.calls: list[tuple] = []
        self.raise_on_request: Optional[Exception] = None

    async def request(self, method, url, body=None, headers=None, **kwargs):
        self.calls.append((method, url, body, headers))
        if self.raise_on_request is not None:
            raise self.raise_on_request
        return self.responses.pop(0)


class FakeKlippyApis:
    """Answers like Klipper: only the objects asked for, and kinematics only in
    configfile.settings. The old fake put kinematics on the toolhead, which real
    Klipper never does, and that is how a kinematics bug once got past these tests."""

    def __init__(self, toolhead: Optional[Dict] = None, raises: bool = False,
                 settings: Optional[Dict] = None):
        self.toolhead = toolhead
        self.raises = raises
        self.settings = settings
        self.queries: list = []

    async def query_objects(self, objects, default=None):
        self.queries.append(objects)
        if self.raises:
            raise RuntimeError("klippy not ready")
        result: Dict[str, Any] = {}
        if "toolhead" in objects and self.toolhead is not None:
            result["toolhead"] = self.toolhead
        if "configfile" in objects and self.settings is not None:
            result["configfile"] = {"settings": self.settings}
        return result


class FakeEventLoop:
    def create_task(self, coro):
        coro.close()  # never actually poll in unit tests
        return None

    async def run_in_thread(self, callback, *args):
        return callback(*args)


class FakeServer:
    def register_event_handler(self, event, callback):
        self.event_handlers = getattr(self, "event_handlers", {})
        self.event_handlers.setdefault(event, []).append(callback)

    def __init__(self, data_path: str) -> None:
        self.data_path = data_path
        self.components: Dict[str, Any] = {}
        self.events: list[tuple] = []
        self.notifications: list[tuple] = []
        self.endpoints: list[tuple] = []

    def get_event_loop(self):
        return FakeEventLoop()

    def get_app_arg(self, name):
        assert name == "data_path"
        return self.data_path

    _MISSING = object()

    def lookup_component(self, name, default=_MISSING):
        # As Moonraker's: a default instead of an error when one is given.
        if name not in self.components and default is not FakeServer._MISSING:
            return default
        return self.components[name]

    def register_notification(self, *args):
        self.notifications.append(args)

    def register_endpoint(self, path, req_type, callback):
        self.endpoints.append((path, req_type, callback))

    def send_event(self, event, *args):
        self.events.append((event, args))

    def error(self, message, code=500):
        return RuntimeError(f"{code}: {message}")


class FakeConfig:
    def __init__(self, server: FakeServer, values: Optional[Dict] = None):
        self._server = server
        self._values = values or {}

    def get_server(self):
        return self._server

    def get(self, key, default=None):
        return self._values.get(key, default)


class ComponentTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_path = self._tmp.name
        self.server = FakeServer(self.data_path)
        self.http = FakeHttpClient()
        self.server.components["http_client"] = self.http
        self.server.components["klippy_apis"] = FakeKlippyApis()
        self.comp = CommunityCAD(FakeConfig(self.server))
        self.comp._settings["notice"] = {"version": communitycad.NOTICE_VERSION}  # accepted
        # Most tests are about what's done with printer settings, not the ask,
        # which TestPermissions covers.
        self.comp._settings["permissions"] = {"printer_settings": True, "print_history": True}

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def set_toolhead(self, toolhead, raises=False):
        self.comp._printer_cache = None
        # Tests describe a printer as one dict; split it the way Klipper does.
        settings = None
        if toolhead is not None:
            toolhead = dict(toolhead)
            kinematics = toolhead.pop("kinematics", None)
            settings = {"printer": {"kinematics": kinematics}} if kinematics else {}
        self.server.components["klippy_apis"] = FakeKlippyApis(toolhead, raises, settings)


class TestBuildVolume(ComponentTestCase):
    CARTESIAN = {
        "axis_minimum": [0.0, 0.0, 0.0, 0.0],
        "axis_maximum": [235.0, 235.0, 250.0, 0.0],
        "kinematics": "cartesian",
    }

    async def test_dimensions_are_max_minus_min(self):
        self.set_toolhead(self.CARTESIAN)
        vol = await self.comp._detect_build_volume()
        self.assertEqual((vol["x"], vol["y"], vol["z"]), (235.0, 235.0, 250.0))
        self.assertEqual(vol["source"], "detected")
        self.assertTrue(vol["fit_filtering"])

    async def test_probe_overtravel_below_z0_is_not_printable(self):
        # A Voron Trident 350: position_min -8 on Z lets the probe go below
        # the bed. Counting it reported 258 mm and marked too-tall models as fitting.
        self.set_toolhead({
            "axis_minimum": [0.0, 0.0, -8.0, 0.0],
            "axis_maximum": [350.0, 350.0, 250.0, 0.0],
            "kinematics": "corexy",
        })
        vol = await self.comp._detect_build_volume()
        self.assertEqual((vol["x"], vol["y"], vol["z"]), (350.0, 350.0, 250.0))

    async def test_xy_overtravel_past_the_bed_edge_is_not_printable(self):
        self.set_toolhead({
            "axis_minimum": [-5.0, -5.0, 0.0, 0.0],
            "axis_maximum": [355.0, 355.0, 340.0, 0.0],
            "kinematics": "corexy",
        })
        vol = await self.comp._detect_build_volume()
        self.assertEqual((vol["x"], vol["y"], vol["z"]), (355.0, 355.0, 340.0))

    async def test_bed_centred_origin_keeps_the_whole_span(self):
        # A large negative minimum is a centred origin, not overtravel.
        self.set_toolhead({
            "axis_minimum": [-150.0, -150.0, -2.0, 0.0],
            "axis_maximum": [150.0, 150.0, 300.0, 0.0],
            "kinematics": "cartesian",
        })
        vol = await self.comp._detect_build_volume()
        self.assertEqual((vol["x"], vol["y"], vol["z"]), (300.0, 300.0, 300.0))

    async def test_positive_minimum_is_unchanged(self):
        self.set_toolhead({
            "axis_minimum": [5.0, 0.0, 0.0, 0.0],
            "axis_maximum": [225.0, 235.0, 250.0, 0.0],
            "kinematics": "cartesian",
        })
        vol = await self.comp._detect_build_volume()
        self.assertEqual((vol["x"], vol["y"], vol["z"]), (220.0, 235.0, 250.0))

    async def test_delta_disables_fit_filtering(self):
        # Delta beds are circular, so a rectangular fit test would wrongly exclude
        # models that do fit, and include ones that do not.
        self.set_toolhead({
            "axis_minimum": [-150.0, -150.0, 0.0, 0.0],
            "axis_maximum": [150.0, 150.0, 300.0, 0.0],
            "kinematics": "delta",
        })
        vol = await self.comp._detect_build_volume()
        self.assertFalse(vol["fit_filtering"])

    async def test_kinematics_come_from_the_config_not_the_toolhead(self):
        # Real Klipper has no toolhead.kinematics. A real printer reported "" until
        # this read printer.kinematics from configfile.settings.
        self.server.components["klippy_apis"] = FakeKlippyApis(
            {"axis_minimum": [0.0, 0.0, -8.0, 0.0],
             "axis_maximum": [350.0, 350.0, 250.0, 0.0],
             "kinematics": "delta"},  # ignored: Klipper never sends this
            settings={"printer": {"kinematics": "corexy"}},
        )
        vol = await self.comp._detect_build_volume()
        self.assertEqual(vol["kinematics"], "corexy")

    async def test_delta_from_the_config_disables_fit_filtering(self):
        self.server.components["klippy_apis"] = FakeKlippyApis(
            {"axis_minimum": [-150.0, -150.0, 0.0, 0.0],
             "axis_maximum": [150.0, 150.0, 300.0, 0.0]},
            settings={"printer": {"kinematics": "delta"}},
        )
        vol = await self.comp._detect_build_volume()
        self.assertEqual(vol["kinematics"], "delta")
        self.assertFalse(vol["fit_filtering"])

    async def test_missing_printer_section_leaves_kinematics_unknown(self):
        self.server.components["klippy_apis"] = FakeKlippyApis(
            {"axis_minimum": [0.0, 0.0, 0.0, 0.0],
             "axis_maximum": [235.0, 235.0, 250.0, 0.0]},
            settings={"extruder": {"nozzle_diameter": 0.4}},
        )
        vol = await self.comp._detect_build_volume()
        self.assertEqual(vol["kinematics"], "")

    async def test_asks_klipper_only_for_the_fields_it_uses(self):
        self.set_toolhead(self.CARTESIAN)
        await self.comp._detect_build_volume()
        query = self.server.components["klippy_apis"].queries[-1]
        self.assertEqual(query["toolhead"], ["axis_minimum", "axis_maximum"])
        self.assertEqual(query["configfile"], ["settings"])

    async def test_klippy_not_ready_is_none_not_an_error(self):
        self.set_toolhead(None, raises=True)
        self.assertIsNone(await self.comp._detect_build_volume())

    async def test_missing_axis_fields_is_none(self):
        self.set_toolhead({"kinematics": "cartesian"})
        self.assertIsNone(await self.comp._detect_build_volume())

    async def test_zero_sized_axis_is_rejected(self):
        self.set_toolhead({
            "axis_minimum": [0.0, 0.0, 0.0, 0.0],
            "axis_maximum": [0.0, 235.0, 250.0, 0.0],
            "kinematics": "cartesian",
        })
        self.assertIsNone(await self.comp._detect_build_volume())

    async def test_override_wins_over_detection(self):
        # Axis limits can include overtravel, so the user can correct them.
        self.set_toolhead(self.CARTESIAN)
        self.comp._settings["build_volume"] = {"x": 200, "y": 200, "z": 200}
        vol = await self.comp._effective_build_volume()
        self.assertEqual((vol["x"], vol["y"], vol["z"]), (200.0, 200.0, 200.0))
        self.assertEqual(vol["source"], "override")

    async def test_malformed_override_falls_back_to_detected(self):
        self.set_toolhead(self.CARTESIAN)
        self.comp._settings["build_volume"] = {"x": "wide", "y": 200, "z": 200}
        vol = await self.comp._effective_build_volume()
        self.assertEqual(vol["source"], "detected")


class TestCredentialStorage(ComponentTestCase):
    async def test_token_file_is_owner_only(self):
        self.comp._creds = {"access_token": "ccad_secret", "username": "someone"}
        self.comp._save_credentials()
        mode = self.comp.creds_file.stat().st_mode & 0o777
        self.assertEqual(mode, 0o600, "the token is account credentials; 0600 only")
        self.assertEqual(self.comp.root.stat().st_mode & 0o777, 0o700)

    async def test_a_directory_the_installer_made_is_tightened(self):
        # Install.sh created it 0775 before the component loaded, and
        # mkdir(mode=0o700, exist_ok=True) left it that way.
        self.comp.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.comp.root, 0o775)
        self.comp._creds = {"access_token": "ccad_secret"}
        self.comp._save_credentials()
        self.assertEqual(self.comp.root.stat().st_mode & 0o777, 0o700)

    async def test_loading_repairs_an_existing_loose_directory(self):
        # Existing installs are fixed on the next Moonraker restart, before any write.
        self.comp.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.comp.root, 0o775)
        CommunityCAD(FakeConfig(self.server))
        self.assertEqual(self.comp.root.stat().st_mode & 0o777, 0o700)

    async def test_save_is_atomic_and_leaves_no_temp_file(self):
        self.comp._creds = {"access_token": "ccad_a"}
        self.comp._save_credentials()
        self.comp._creds = {"access_token": "ccad_b"}
        self.comp._save_credentials()
        with self.comp.creds_file.open() as fh:
            self.assertEqual(json.load(fh)["access_token"], "ccad_b")
        leftovers = list(self.comp.root.glob("*.tmp"))
        self.assertEqual(leftovers, [], "atomic write left a temp file behind")

    async def test_unreadable_credentials_do_not_stop_loading(self):
        self.comp.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.comp.creds_file.write_text("{ this is not json")
        self.comp._load_state()
        self.assertEqual(self.comp._creds, {})

    async def test_clear_removes_the_file(self):
        self.comp._creds = {"access_token": "ccad_x"}
        self.comp._save_credentials()
        self.comp._clear_credentials()
        self.assertFalse(self.comp.creds_file.exists())
        self.assertIsNone(self.comp._token)


class TestApiErrorMapping(ComponentTestCase):
    async def test_rfc8628_error_body_sets_machine_reason(self):
        self.http.responses.append(FakeResponse(400, {
            "error": "authorization_pending",
            "error_description": "The user hasn't approved this device yet.",
            "interval": 5,
        }))
        with self.assertRaises(CommunityCADError) as ctx:
            await self.comp._api("POST", "/auth/device/token", body={"device_code": "x"})
        self.assertEqual(ctx.exception.reason, "authorization_pending")
        self.assertEqual(ctx.exception.retry_after, 5.0)

    async def test_fastapi_detail_body_is_used_as_the_message(self):
        self.http.responses.append(FakeResponse(404, {"detail": "Model not found"}))
        with self.assertRaises(CommunityCADError) as ctx:
            await self.comp._api("GET", "/catalog/models/1")
        self.assertEqual(ctx.exception.message, "Model not found")
        self.assertEqual(ctx.exception.code, 404)

    async def test_401_on_an_authed_call_drops_the_local_token(self):
        # A revoked token must not be kept, or the plugin is stuck.
        self.comp._creds = {"access_token": "ccad_revoked"}
        self.comp._save_credentials()
        self.http.responses.append(FakeResponse(401, {"detail": "Invalid token"}))
        with self.assertRaises(CommunityCADError) as ctx:
            await self.comp._api("GET", "/catalog/search", authed=True)
        self.assertEqual(ctx.exception.reason, "unlinked")
        self.assertIsNone(self.comp._token)
        self.assertFalse(self.comp.creds_file.exists())

    async def test_401_on_an_unauthed_call_keeps_the_token(self):
        # A public endpoint answering 401 says nothing about our credentials.
        self.comp._creds = {"access_token": "ccad_fine"}
        self.http.responses.append(FakeResponse(401, {"detail": "nope"}))
        with self.assertRaises(CommunityCADError):
            await self.comp._api("GET", "/catalog/search", authed=False)
        self.assertEqual(self.comp._token, "ccad_fine")

    async def test_429_carries_retry_after(self):
        self.http.responses.append(FakeResponse(429, {"detail": "slow down"}, {"Retry-After": "30"}))
        with self.assertRaises(CommunityCADError) as ctx:
            await self.comp._api("GET", "/catalog/search")
        self.assertEqual(ctx.exception.reason, "rate_limited")
        self.assertEqual(ctx.exception.retry_after, 30.0)
        self.assertIn("30 seconds", ctx.exception.message)

    async def test_unreachable_says_the_printer_still_works(self):
        self.http.raise_on_request = OSError("no route to host")
        with self.assertRaises(CommunityCADError) as ctx:
            await self.comp._api("GET", "/catalog/search")
        self.assertEqual(ctx.exception.reason, "unreachable")
        self.assertIn("printer works as normal", ctx.exception.message)

    async def test_token_is_sent_only_when_authed(self):
        self.comp._creds = {"access_token": "ccad_tok"}
        self.http.responses.append(FakeResponse(200, {}))
        await self.comp._api("GET", "/catalog/search", authed=True)
        self.assertEqual(self.http.calls[-1][3]["Authorization"], "Bearer ccad_tok")
        self.http.responses.append(FakeResponse(200, {}))
        await self.comp._api("GET", "/catalog/search", authed=False)
        self.assertNotIn("Authorization", self.http.calls[-1][3])


class TestSearchFitParams(ComponentTestCase):
    def _last_url(self) -> str:
        return self.http.calls[-1][1]

    async def test_fit_box_is_filled_from_the_printer(self):
        self.set_toolhead(TestBuildVolume.CARTESIAN)
        self.http.responses.append(FakeResponse(200, {"items": [], "total": 0}))
        await self.comp._handle_search(FakeWebRequest({"q": "bracket"}))
        url = self._last_url()
        self.assertIn("fit_x=235.0", url)
        self.assertIn("fit_z=250.0", url)

    async def test_caller_supplied_fit_is_not_overridden(self):
        self.set_toolhead(TestBuildVolume.CARTESIAN)
        self.http.responses.append(FakeResponse(200, {"items": [], "total": 0}))
        await self.comp._handle_search(FakeWebRequest({"fit_x": 100, "fit_y": 100, "fit_z": 100}))
        self.assertIn("fit_x=100", self._last_url())
        self.assertNotIn("235", self._last_url())

    async def test_fit_only_downgrades_when_the_volume_is_unknown(self):
        # Showing an empty catalogue would be worse than showing everything.
        self.set_toolhead(None, raises=True)
        self.http.responses.append(FakeResponse(200, {"items": [], "total": 0}))
        await self.comp._handle_search(FakeWebRequest({"fit": "only"}))
        self.assertIn("fit=any", self._last_url())

    async def test_delta_does_not_get_a_fit_box(self):
        self.set_toolhead({
            "axis_minimum": [-150.0, -150.0, 0.0, 0.0],
            "axis_maximum": [150.0, 150.0, 300.0, 0.0],
            "kinematics": "delta",
        })
        self.http.responses.append(FakeResponse(200, {"items": [], "total": 0}))
        await self.comp._handle_search(FakeWebRequest({}))
        self.assertNotIn("fit_x", self._last_url())

    async def test_unknown_params_are_not_forwarded(self):
        self.set_toolhead(TestBuildVolume.CARTESIAN)
        self.http.responses.append(FakeResponse(200, {"items": [], "total": 0}))
        await self.comp._handle_search(FakeWebRequest({"q": "a", "evil": "../../etc/passwd"}))
        self.assertNotIn("evil", self._last_url())
        self.assertNotIn("passwd", self._last_url())


class TestInjectionHealth(ComponentTestCase):
    """Is our script still injected into the host interface?

    The important cases are the ones that must return None. The component announces
    a problem to the user through Moonraker when this is False, so guessing False
    would tell people the plugin is broken when it is not.
    """

    MARKER = "# >>> communitycad (managed by communitycad install.sh)"

    def write_state(self, site_path, marker=None):
        self.comp.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.comp.root.joinpath("install-state.json").write_text(
            json.dumps({"nginx_site": str(site_path), "marker": marker or self.MARKER})
        )

    def site(self, contents):
        path = pathlib.Path(self.data_path) / "site.conf"
        path.write_text(contents)
        return path

    async def test_marker_present_is_healthy(self):
        self.write_state(self.site(f"server {{\n    {self.MARKER}\n}}\n"))
        self.assertIs(self.comp._injection_healthy(), True)

    async def test_marker_absent_is_unhealthy(self):
        self.write_state(self.site("server {\n    listen 80;\n}\n"))
        self.assertIs(self.comp._injection_healthy(), False)

    async def test_no_install_state_says_nothing(self):
        # Installed by hand, or never installed by our script. Not our place to judge.
        self.assertIsNone(self.comp._injection_healthy())

    async def test_unreadable_site_says_nothing(self):
        self.write_state("/etc/nginx/definitely-not-here.conf")
        self.assertIsNone(self.comp._injection_healthy())

    async def test_state_without_a_marker_says_nothing(self):
        self.comp.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.comp.root.joinpath("install-state.json").write_text('{"nginx_site": "/tmp/x"}')
        self.assertIsNone(self.comp._injection_healthy())

    async def test_status_reports_it(self):
        self.write_state(self.site("server {}\n"))
        status = await self.comp._handle_status(FakeWebRequest({}))
        self.assertIs(status["injection_healthy"], False)


class TestVersionCheck(ComponentTestCase):
    def test_equal_versions_are_fine(self):
        self.assertFalse(communitycad.is_outdated("0.1.0", "0.1.0"))

    def test_a_dev_build_of_the_minimum_is_not_outdated(self):
        # "0.1.0-dev" is this plugin built from source at 0.1.0, not a pre-release
        # that predates it. Strict semver would nag every developer to update.
        self.assertFalse(communitycad.is_outdated("0.1.0-dev", "0.1.0"))

    def test_older_minor_is_outdated(self):
        self.assertTrue(communitycad.is_outdated("0.1.0", "0.2.0"))

    def test_newer_is_not_outdated(self):
        self.assertFalse(communitycad.is_outdated("1.2.0", "0.9.0"))

    def test_no_header_means_no_opinion(self):
        self.assertFalse(communitycad.is_outdated("0.1.0", None))

    def test_unparseable_version_never_nags(self):
        self.assertFalse(communitycad.is_outdated("0.1.0", "not-a-version"))

    async def test_header_is_captured_from_any_response(self):
        self.http.responses.append(FakeResponse(200, {}, {"X-Min-Plugin-Version": "9.9.9"}))
        await self.comp._api("GET", "/catalog/search")
        status = await self.comp._handle_status(FakeWebRequest({}))
        self.assertEqual(status["min_plugin_version"], "9.9.9")
        self.assertTrue(status["update_required"])


class FakeFileManager:
    """Stands in for Moonraker's file manager. finalize_upload is the same call a
    slicer upload makes, so the component is exercised on the real path."""

    def __init__(self, fail: bool = False):
        self.calls: list = []
        self.fail = fail
        self.gcodes = tempfile.mkdtemp(prefix="ccad-gcodes-")
        self.config = tempfile.mkdtemp(prefix="ccad-config-")

    def get_directory(self, root="gcodes"):
        return self.config if root == "config" else self.gcodes

    def register_directory(self, root, path, full_access=False):
        self.registered = getattr(self, "registered", []) + [(root, path, full_access)]
        return True

    async def finalize_upload(self, form_args):
        self.calls.append(form_args)
        if self.fail:
            raise RuntimeError("disk full")
        return {"result": form_args["filename"]}


def make_3mf(path, plates, md5=None, extra=0):
    """A sliced 3MF shaped like Bambu Studio / OrcaSlicer output."""
    import hashlib, zipfile
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr("Metadata/slice_info.config", "<config/>")
        for number, body in plates.items():
            zf.writestr(f"Metadata/plate_{number}.gcode", body)
            if md5 is not None:
                digest = md5.get(number) or hashlib.md5(body).hexdigest().upper()
                zf.writestr(f"Metadata/plate_{number}.gcode.md5", digest)
        for i in range(extra):
            zf.writestr(f"Auxiliaries/{i}.txt", "x")
    return path


class TestModelsOnThePrinter(ComponentTestCase):
    """Models on the printer: the slicer's input store, never the G-code files."""
    STL = {"id": 8, "path": "cad/bracket.stl", "size_bytes": 5, "role": "cad"}
    GCODE = {"id": 7, "path": "cad/bracket.gcode", "size_bytes": 4, "role": "export"}

    def setUp(self):
        super().setUp()
        self.fm = FakeFileManager()
        self.server.components["file_manager"] = self.fm
        self.comp._creds = {"access_token": "ccad_tok"}

        async def download(url, content_type, destination_path=None, **kwargs):
            pathlib.Path(destination_path).write_bytes(b"solid")
            return pathlib.Path(destination_path)

        self.http.download_file = download

    def detail(self, *files):
        return {"id": 5, "title": "Bracket", "slug": "bracket",
                "thumbnail_url": "https://img.example/b.png", "files": list(files)}

    async def save(self, file_id=8, entry=None):
        self.http.responses.append(FakeResponse(200, self.detail(entry or self.STL)))
        self.http.responses.append(FakeResponse(200, {"url": "https://example/x"}))
        return await self.comp._handle_save_model(FakeWebRequest({"model_id": 5, "file_id": file_id}))

    async def test_a_model_file_lands_in_printer_data_models_under_its_name(self):
        result = await self.save()
        model = result["model"]
        self.assertEqual((model["filename"], model["title"], model["bytes"]), ("bracket.stl", "Bracket", 5))
        self.assertEqual(self.comp._models_dir, pathlib.Path(self.data_path).joinpath("models"))
        self.assertEqual(self.comp._models_dir.joinpath("bracket.stl").read_bytes(), b"solid")
        self.assertEqual(self.fm.calls, [], "nothing goes to the G-code files")
        self.assertEqual(list(self.comp.root.joinpath("tmp").iterdir()), [])

    async def test_saving_the_same_catalog_file_again_costs_nothing(self):
        await self.save()
        calls = len(self.http.calls)
        again = await self.comp._handle_save_model(FakeWebRequest({"model_id": 5, "file_id": 8}))
        self.assertTrue(again["already"])
        self.assertEqual(self.http.calls[calls:], [], "no request at all: not even the model's details")
        self.assertEqual(len((await self.comp._handle_models(FakeWebRequest({})))["models"]), 1)

    async def test_two_saves_of_one_file_at_once_download_once(self):
        """Save, then Print before the save finished. The second waits for the
        first and finds it saved: no second download link, no network."""
        async def slow(url, content_type, destination_path=None, **kwargs):
            await asyncio.sleep(0.05)
            pathlib.Path(destination_path).write_bytes(b"solid")
            return pathlib.Path(destination_path)
        self.http.download_file = slow
        self.http.responses += [FakeResponse(200, self.detail(self.STL)), FakeResponse(200, {"url": "https://example/x"})]
        first, second = await asyncio.gather(
            self.comp._handle_save_model(FakeWebRequest({"model_id": 5, "file_id": 8})),
            self.comp._handle_save_model(FakeWebRequest({"model_id": 5, "file_id": 8})))
        self.assertFalse(first.get("already"))
        self.assertTrue(second["already"])
        self.assertEqual(sum("download-url" in c[1] for c in self.http.calls), 1, "one download link, not two")
        self.assertEqual(self.comp.__dict__.get("_save_locks"), {}, "no lock left behind")

    async def test_progress_is_reported_while_downloading_and_cleared_after(self):
        """The download bar reads /transfers while a file comes in."""
        seen = []
        async def reporting(url, content_type, destination_path=None, progress_callback=None, **kwargs):
            progress_callback(40, 5, 2)
            seen.append((await self.comp._handle_transfers(FakeWebRequest({})))["transfers"])
            pathlib.Path(destination_path).write_bytes(b"solid")
            return pathlib.Path(destination_path)
        self.http.download_file = reporting
        await self.save()
        self.assertEqual({k: (v["received"], v["total"], v["name"]) for k, v in seen[0].items()},
                         {"5:8": (2, 5, "bracket.stl")})
        self.assertEqual((await self.comp._handle_transfers(FakeWebRequest({})))["transfers"], {}, "cleared when done")

    async def test_a_name_already_taken_gets_a_suffix_never_replaced(self):
        self.comp._models_dir.joinpath("bracket.stl").write_bytes(b"mine")
        result = await self.save()
        self.assertEqual(result["model"]["filename"], "bracket-2.stl")
        self.assertEqual(self.comp._models_dir.joinpath("bracket.stl").read_bytes(), b"mine")

    async def test_files_uploaded_through_moonraker_are_listed_too(self):
        self.comp._models_dir.joinpath("from-phone.stl").write_bytes(b"solid p")
        self.comp._models_dir.joinpath("notes.txt").write_text("hi")
        listed = {m["filename"]: m for m in (await self.comp._handle_models(FakeWebRequest({})))["models"]}
        self.assertTrue(listed["from-phone.stl"]["uploaded"])
        self.assertTrue(listed["from-phone.stl"]["usable"])
        self.assertFalse(listed["notes.txt"]["usable"], "listed, never sliced")

    async def test_models_folder_is_a_moonraker_root(self):
        comp = CommunityCAD(FakeConfig(self.server))
        roots = {root: (path, full) for root, path, full in self.fm.registered}
        self.assertEqual(roots["models"], (str(comp._models_dir), True))
        self.assertEqual(roots["projects"], (str(comp._projects_dir), True))

    async def test_the_old_id_store_moves_to_real_names(self):
        old = self.comp.root.joinpath("models")
        old.mkdir(parents=True)
        old.joinpath("e7929c7bef30.stl").write_bytes(b"solid c")
        self.comp._write_json(self.comp._models_file, {"e7929c7bef30": {
            "id": "e7929c7bef30", "filename": "cube.stl", "path": "e7929c7bef30.stl",
            "model_id": 142, "file_id": 3212, "title": "Flashforge", "saved_at": 5}}, 0o600)
        comp = CommunityCAD(FakeConfig(self.server))
        self.assertFalse(old.exists())
        entry = comp._model_entry("cube.stl")
        self.assertEqual((entry["model_id"], entry["title"]), (142, "Flashforge"))
        self.assertEqual(comp._models_dir.joinpath("cube.stl").read_bytes(), b"solid c")

    async def test_gcode_is_sent_not_stored(self):
        with self.assertRaises(Exception) as ctx:
            await self.save(file_id=7, entry=self.GCODE)
        self.assertIn("G-code files", str(ctx.exception))
        self.assertFalse(any("download-url" in c[1] for c in self.http.calls))

    async def test_a_full_store_is_refused_before_a_download_is_spent(self):
        big = dict(self.STL, size_bytes=communitycad.MODELS_CAP_BYTES + 1)
        with self.assertRaises(Exception) as ctx:
            await self.save(entry=big)
        self.assertIn("full", str(ctx.exception))
        self.assertFalse(any("download-url" in c[1] for c in self.http.calls))

    async def test_delete_removes_the_file_and_its_details(self):
        await self.save()
        await self.comp._handle_models_delete(FakeWebRequest({"id": "bracket.stl"}, method="POST"))
        self.assertFalse(self.comp._models_dir.joinpath("bracket.stl").exists())
        self.assertNotIn("bracket.stl", self.comp._read_json(self.comp._models_file))

    async def test_only_plain_names_in_the_folder_are_accepted(self):
        await self.save()
        self.comp.root.joinpath("secret.json").write_text("{}")
        for bad in ("../communitycad/secret.json", "/etc/passwd", "", ".hidden", "nope.stl"):
            with self.subTest(bad=bad):
                self.assertIsNone(self.comp._model_entry(bad))
                with self.assertRaises(Exception):
                    await self.comp._handle_models_delete(FakeWebRequest({"id": bad}, method="POST"))
        self.assertTrue(self.comp.root.joinpath("secret.json").exists())

    async def test_details_of_files_deleted_elsewhere_are_dropped(self):
        await self.save()
        self.comp._models_dir.joinpath("bracket.stl").unlink()   # e.g. via Moonraker's API
        await self.comp._handle_models(FakeWebRequest({}))
        self.assertEqual(self.comp._read_json(self.comp._models_file), {})

    async def test_unlinked_saves_nothing(self):
        self.comp._creds = {}
        with self.assertRaises(Exception):
            await self.comp._handle_save_model(FakeWebRequest({"model_id": 5, "file_id": 8}))
        self.assertEqual(self.http.calls, [])


ORCA_RESOURCES = pathlib.Path.home().joinpath("communitycad/orca/current/resources")
FAKE_ORCA = """#!/bin/bash
# Stands in for OrcaSlicer: behaves as $FAKE_ORCA_MODE says.
out=""; prev=""
for a in "$@"; do [ "$prev" = "--outputdir" ] && out="$a"; prev="$a"; done
echo "$@" > "$out/../argv"
exp=""; prev=""
for a in "$@"; do [ "$prev" = "--export-3mf" ] && exp="$a"; prev="$a"; done
if [ -n "$exp" ] && [ "$FAKE_ORCA_MODE" = "ok" ]; then
  python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('Metadata/project_settings.config','{}'); z.close()" "$out/$exp"
  exit 0
fi
case "$FAKE_ORCA_MODE" in
  ok)    for n in $(seq 1 ${FAKE_PLATES:-1}); do
           printf 'G28\n; filament used [g] = 3.90\n; total layers count = 100\n; estimated printing time (normal mode) = 12m 3s\n' > "$out/plate_$n.gcode"
         done
         echo '{"return_code": 0, "error_string": "Success."}' > "$out/result.json" ;;
  fail)  echo '{"return_code": -17, "error_string": "process not compatible"}' > "$out/result.json"; exit 239 ;;
  crash) kill -SEGV $$ ;;
  hang)  sleep 30 ;;
esac
"""


@unittest.skipUnless(ORCA_RESOURCES.is_dir(), "needs OrcaSlicer's presets (scripts/install-orca.sh)")
class _SlicingCase(ComponentTestCase):
    """Slice v1: Orca as a separate program, every failure a plain message."""

    def setUp(self):
        super().setUp()
        orca_dir = pathlib.Path(self._tmp.name, "orca")
        orca_dir.mkdir()
        orca_dir.joinpath("resources").symlink_to(ORCA_RESOURCES)
        self.orca = orca_dir.joinpath("run-orca")
        self.orca.write_text(FAKE_ORCA)
        self.orca.chmod(0o755)
        self.comp = CommunityCAD(FakeConfig(self.server, {"orca_path": str(self.orca)}))
        self.comp._settings["notice"] = {"version": communitycad.NOTICE_VERSION}  # accepted
        self.fm = FakeFileManager()
        self.server.components["file_manager"] = self.fm
        self.set_toolhead({"axis_minimum": [0, 0, -8, 0], "axis_maximum": [350, 350, 250, 0],
                           "kinematics": "corexy"})
        # A model already in printer_data/models.
        self.comp._models_dir.mkdir(parents=True, exist_ok=True)
        self.comp._models_dir.joinpath("bracket.stl").write_bytes(b"solid x")
        self.comp._write_json(self.comp._models_file, {"bracket.stl": {
            "model_id": 5, "file_id": 8, "title": "Bracket", "saved_at": 1}}, 0o600)
        self.entry = self.comp._model_entry("bracket.stl")
        self.slept = []

    async def run_slice(self, mode, **opts):
        os.environ["FAKE_ORCA_MODE"] = mode
        options = {"material": "PLA", "quality": "standard", "process": {}, **opts}
        job = {"id": "job1", "model": "bracket.stl", "state": "slicing", "options": options,
               "_material": {"name": "PLA", "inherits": "Generic PLA @System", "values": {}},
               "_t0": 0.0}
        import time as _t
        job["_t0"] = _t.monotonic()
        entry = {**self.entry, "_source": str(self.comp._models_dir.joinpath("bracket.stl"))}
        await self.comp._run_slice(job, entry, {"x": 350, "y": 350, "z": 250}, 0.4)
        return job

    async def send(self, job, plate=1, thumbnails=None, **extra):
        """Orca's Send: the plate goes to the G-code files (Print plate is this, then a confirm)."""
        self.comp._slice = job
        r = await self.comp._handle_slice_send(FakeWebRequest(
            {"plate": plate, **({"thumbnails": thumbnails} if thumbnails else {}), **extra}, method="POST"))
        return r["plate"]

    def leftovers(self):
        tmp = self.comp.root.joinpath("tmp")
        return list(tmp.iterdir()) if tmp.exists() else []


class TestSlicing(_SlicingCase):
    """Slice v1: Orca as a separate program, every failure a plain message."""

    async def test_a_slice_waits_until_it_is_sent_as_in_orca(self):
        job = await self.run_slice("ok")
        self.assertEqual(job["state"], "done", job.get("error"))
        self.assertEqual(job["summary"], {"filament_g": "3.90", "layers": "100", "print_time": "12m 3s"})
        self.assertEqual(self.fm.calls, [], "slicing alone puts nothing in the G-code files")
        plate = job["plates"][0]
        self.assertIsNone(plate["gcode"])
        self.assertEqual(plate["staged"], "projects/.sliced/job1/plate_1.gcode")
        self.assertTrue(self.comp._projects_dir.joinpath(".sliced", "job1", "plate_1.gcode").is_file())
        sent = await self.send(job)
        self.assertEqual(sent["gcode"], "communitycad/bracket_PLA_0.20mm.gcode")
        self.assertEqual(self.fm.calls[0]["print"], "false", "sending never starts a print")
        self.assertIn("checks", sent["match"])
        library = json.loads(self.comp.root.joinpath("library.json").read_text())
        self.assertTrue(library["communitycad/bracket_PLA_0.20mm.gcode"]["sliced"]["orca"])
        again = await self.send(job)
        self.assertEqual(again["gcode"], sent["gcode"])
        self.assertEqual(len(self.fm.calls), 1, "sending twice doesn't make a second file")

    async def test_each_send_can_choose_a_folder_or_the_top_of_gcode_files(self):
        job = await self.run_slice("ok")
        self.assertEqual((await self.send(job, folder=""))["gcode"], "bracket_PLA_0.20mm.gcode")
        self.assertEqual(self.fm.calls[-1]["path"], "")
        job = await self.run_slice("ok")
        self.assertEqual((await self.send(job, folder="Voron/parts"))["gcode"], "Voron/parts/bracket_PLA_0.20mm.gcode")
        job = await self.run_slice("ok")
        for bad in ("../etc", "a/b/c/d", 5):
            with self.subTest(bad=bad), self.assertRaises(Exception):
                await self.send(job, folder=bad)

    async def test_a_new_slice_replaces_the_one_waiting(self):
        await self.run_slice("ok")
        self.comp._slice = None
        job2 = await self.run_slice("ok")
        job2["id"] = "job2"
        self.assertEqual(sorted(p.name for p in self.comp._projects_dir.joinpath(".sliced").iterdir()), ["job1"],
                         "the staged folder is the newest slice's only")

    async def test_a_sent_file_never_replaces_an_existing_one(self):
        folder = pathlib.Path(self.fm.gcodes, "communitycad")
        folder.mkdir(parents=True)
        folder.joinpath("bracket_PLA_0.20mm.gcode").write_text("someone else's")
        job = await self.run_slice("ok")
        self.assertEqual((await self.send(job))["gcode"], "communitycad/bracket_PLA_0.20mm-2.gcode")

    async def test_thumbnails_go_into_the_gcode_as_orca_writes_them(self):
        import base64
        job = await self.run_slice("ok")
        staged = self.comp._projects_dir.joinpath(".sliced", "job1", "plate_1.gcode")
        staged.write_text("; HEADER_BLOCK_START\n; generated by OrcaSlicer\n; HEADER_BLOCK_END\nG28\n")
        png = b"\x89PNG\r\n\x1a\n" + bytes(range(200))
        captured = {}
        real = self.fm.finalize_upload

        async def keep(form):
            captured["text"] = pathlib.Path(form["tmp_file_path"]).read_text()
            return await real(form)
        self.fm.finalize_upload = keep
        await self.send(job, thumbnails=[{"width": 48, "height": 48, "png": base64.b64encode(png).decode()},
                                         {"width": 300, "height": 300, "png": base64.b64encode(png).decode()}])
        text = captured["text"]
        self.assertLess(text.index("; HEADER_BLOCK_END"), text.index("; THUMBNAIL_BLOCK_START"))
        self.assertLess(text.index("; THUMBNAIL_BLOCK_END"), text.index("G28"))
        import re
        for w in (48, 300):
            m = re.search(r"; thumbnail begin %dx%d (\d+)\n((?:; .*\n)+?); thumbnail end" % (w, w), text)
            data = "".join(line[2:] for line in m.group(2).splitlines())
            self.assertEqual(len(data), int(m.group(1)), "Moonraker checks the stated length")
            self.assertEqual(base64.b64decode(data), png)
        self.assertTrue(all(len(l) <= 80 for l in text.splitlines()))

    async def test_bad_thumbnails_and_unknown_plates_are_refused(self):
        job = await self.run_slice("ok")
        for bad in ([{"width": 48, "height": 48, "png": "bm90IGEgcG5n"}], [{"width": 4, "height": 4, "png": ""}]):
            with self.subTest(bad=bad), self.assertRaises(Exception):
                await self.send(job, thumbnails=bad)
        with self.assertRaises(Exception):
            await self.send(job, plate=7)
        self.assertEqual(self.fm.calls, [])

    async def test_overrides_win_over_the_preset_and_unknown_keys_never_reach_orca(self):
        profiles = communitycad.OrcaProfiles(ORCA_RESOURCES.joinpath("profiles"))
        pla = {"name": "PLA", "inherits": "Generic PLA @System", "values": {}}
        base = communitycad.slice_presets(profiles, {"x": 350, "y": 350, "z": 250}, 0.4, pla, "standard", {})
        self.assertEqual(base["process"]["brim_type"], "auto_brim", "Orca's own default when the preset is silent")
        p = communitycad.slice_presets(profiles, {"x": 350, "y": 350, "z": 250}, 0.4, pla, "standard",
                                       {"wall_loops": "5", "top_shell_layers": "7", "skirt_loops": "2",
                                        "post_process": "/bin/evil"})
        self.assertEqual((p["process"]["wall_loops"], p["process"]["top_shell_layers"], p["process"]["skirt_loops"]),
                         ("5", "7", "2"))
        self.assertNotEqual(p["process"].get("post_process"), "/bin/evil")

    async def test_presets_carry_this_printer_and_the_chosen_options(self):
        profiles = communitycad.OrcaProfiles(ORCA_RESOURCES.joinpath("profiles"))
        petg = {"name": "My PETG", "inherits": "Generic PETG @System",
                "values": {"nozzle_temperature": "245", "pressure_advance": "0.055"}}
        p = communitycad.slice_presets(profiles, {"x": 350, "y": 300, "z": 250}, 0.4, petg, "fine",
                                       communitycad.legacy_process({"infill": 40, "supports": True,
                                                                    "brim": False}))
        self.assertEqual(p["machine"]["printable_area"], ["0x0", "350x0", "350x300", "0x300"])
        self.assertEqual(p["machine"]["printable_height"], "250")
        self.assertIn("PRINT_START", p["machine"]["machine_start_gcode"])
        self.assertEqual(p["process"]["sparse_infill_density"], "40%")
        self.assertEqual(p["process"]["enable_support"], "1")
        self.assertEqual(p["process"]["brim_type"], "no_brim")
        self.assertEqual(p["process"]["curr_bed_type"], "Textured PEI Plate",
                         "otherwise Orca uses the cool-plate temperature")
        self.assertEqual(p["process"]["compatible_printers"], [communitycad.SLICE_MACHINE_NAME])
        self.assertEqual(p["filament"]["name"], "My PETG")
        self.assertEqual(p["filament"]["nozzle_temperature"], ["245"], "Orca's list shape")
        self.assertEqual(p["filament"]["pressure_advance"], ["0.055"])
        self.assertEqual(p["filament"]["filament_type"], ["PETG"], "the rest comes from the parent")
        self.assertTrue(all(x["from"] == "system" and x["inherits"] == "" for x in p.values()))

    async def test_orcas_refusal_is_a_plain_message_and_saves_nothing(self):
        job = await self.run_slice("fail")
        self.assertEqual(job["state"], "failed")
        self.assertIn("don't fit this printer", job["error"])
        self.assertEqual(self.fm.calls, [])
        self.assertEqual(self.leftovers(), [], "the work folder is removed")

    async def test_a_crash_is_a_plain_message_and_saves_nothing(self):
        job = await self.run_slice("crash")
        self.assertEqual(job["state"], "failed")
        self.assertIn("stopped unexpectedly", job["error"])
        self.assertEqual(self.fm.calls, [])
        self.assertEqual(self.leftovers(), [])

    async def test_a_slice_that_runs_too_long_is_stopped(self):
        real = communitycad.SLICE_TIMEOUT_S
        communitycad.SLICE_TIMEOUT_S = 1
        try:
            job = await self.run_slice("hang")
        finally:
            communitycad.SLICE_TIMEOUT_S = real
        self.assertEqual(job["state"], "failed")
        self.assertIn("too long", job["error"])
        self.assertEqual(self.leftovers(), [])

    async def test_runs_at_low_priority_on_two_cores(self):
        # The command line Orca saw is the one after nice/ionice/taskset, so check
        # the wrapper is in the process tree by asking the component what it ran.
        calls = []
        real = communitycad.asyncio.create_subprocess_exec

        async def spy(*argv, **kw):
            calls.append(argv)
            return await real(*argv, **kw)

        communitycad.asyncio.create_subprocess_exec = spy
        try:
            await self.run_slice("ok")
        finally:
            communitycad.asyncio.create_subprocess_exec = real
        argv = calls[0]
        self.assertEqual(argv[:3], ("nice", "-n", "19"))
        if (os.cpu_count() or 1) >= 4:
            self.assertIn("taskset", argv)

    async def test_refused_while_printing(self):
        self.server.components["klippy_apis"] = FakeKlippyPrint(state="printing")
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_slice(FakeWebRequest({"id": "bracket.stl"}, method="POST"))
        self.assertIn("printing", str(ctx.exception))
        self.assertIsNone(self.comp._slice)

    def test_off_the_bed_is_explained_without_orcas_multi_extruder_wording(self):
        out = self.comp.root.joinpath("out-test")
        out.mkdir(parents=True)
        out.joinpath("result.json").write_text(json.dumps({"return_code": -100, "error_string":
            "Found G-code in unprintable area of multi-extruder printers after slicing."}))
        message = self.comp._orca_failure(out, 1, b"")
        self.assertIn("outside the bed", message)
        self.assertNotIn("multi-extruder", message)

    async def test_one_slice_at_a_time(self):
        self.comp._slice = {"state": "slicing", "_t0": 0.0}
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_slice(FakeWebRequest({"id": "bracket.stl"}, method="POST"))
        self.assertIn("Already slicing", str(ctx.exception))

    async def test_options_and_ids_are_validated(self):
        for args in ({"id": "../../x"}, {"id": "bracket.stl", "infill": 99},
                     {"id": "bracket.stl", "material": "nylon"},
                     {"id": "bracket.stl", "quality": "ultra"}):
            with self.subTest(args=args), self.assertRaises(Exception):
                await self.comp._handle_slice(FakeWebRequest(args, method="POST"))

    def test_process_settings_are_checked_and_put_in_orcas_format(self):
        ok = communitycad.check_process({"layer_height": "0.28", "wall_loops": 4, "sparse_infill_density": "25%",
                                         "enable_support": True, "support_type": "tree(auto)",
                                         "brim_type": "no_brim", "skirt_loops": "2"}, 0.4)
        self.assertEqual(ok, {"layer_height": "0.28", "wall_loops": "4", "sparse_infill_density": "25%",
                              "enable_support": "1", "support_type": "tree(auto)", "brim_type": "no_brim",
                              "skirt_loops": "2"})
        bad = [{"layer_height": "0.32"},             # past 75% of a 0.4 nozzle
               {"wall_loops": 0}, {"wall_loops": "2.5"}, {"sparse_infill_density": "120%"},
               {"support_type": "organic"}, {"enable_support": "maybe"},
               {"machine_start_gcode": "G28"},       # not on the list, whatever it is
               {"post_process": "/bin/sh"}]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                communitycad.check_process(raw, 0.4)
        self.assertEqual(communitycad.check_process({"layer_height": "0.45"}, 0.6), {"layer_height": "0.45"})

    def test_projects_made_before_61_keep_their_choices(self):
        self.assertEqual(communitycad.legacy_process({"infill": 30, "supports": True, "brim": False}),
                         {"sparse_infill_density": "30%", "enable_support": "1", "support_type": "tree(auto)",
                          "brim_type": "no_brim"})

    async def test_the_slice_uses_the_overrides_and_names_the_real_layer_height(self):
        job = await self.run_slice("ok", process={"layer_height": "0.16"})
        self.assertEqual(job["state"], "done", job.get("error"))
        self.assertEqual((await self.send(job))["gcode"], "communitycad/bracket_PLA_0.16mm.gcode")

    async def test_not_installed_says_how_to_install(self):
        self.orca.unlink()
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_slice(FakeWebRequest({"id": "bracket.stl"}, method="POST"))
        self.assertIn("install-orca.sh", str(ctx.exception))


HAND_EDITED = """# My materials, edited in Mainsail
[material PLA]
inherits: Generic PLA @System
# tuned 2026-09
nozzle_temperature: 215
textured_plate_temp = 60

# PETG below came from Polymaker's page
[material Polymaker PETG]
inherits: Generic PETG @System
filament_start_gcode:
    ; Polymaker PETG
    SET_FAN_SPEED FAN=nevermore SPEED=0.5
pressure_advance: 0.055
"""


class TestMaterialsFile(unittest.TestCase):
    """materials.cfg: Orca filament presets in Klipper's config style."""

    def test_reads_orca_names_continuations_and_both_separators(self):
        materials, problems = communitycad.parse_materials(HAND_EDITED)
        self.assertEqual(problems, [])
        self.assertEqual(list(materials), ["PLA", "Polymaker PETG"])
        pla = materials["PLA"]
        self.assertEqual(pla["inherits"], "Generic PLA @System")
        self.assertEqual(pla["values"], {"nozzle_temperature": "215", "textured_plate_temp": "60"})
        petg = materials["Polymaker PETG"]["values"]
        self.assertEqual(petg["filament_start_gcode"],
                         "; Polymaker PETG\nSET_FAN_SPEED FAN=nevermore SPEED=0.5",
                         "; inside a G-code block is G-code, not a comment")
        self.assertEqual(petg["pressure_advance"], "0.055")

    def test_unknown_keys_and_stray_lines_are_reported_with_their_line(self):
        _, problems = communitycad.parse_materials(
            "speed: 3\n[material X]\nnozzle_temprature: 200\n[printer]\n")
        self.assertTrue(any(p.startswith("line 1:") for p in problems))
        self.assertTrue(any("line 3: nozzle_temprature isn't an OrcaSlicer" in p for p in problems))
        self.assertTrue(any("line 4: [printer]" in p for p in problems))

    def test_editing_one_material_leaves_every_other_byte(self):
        block = communitycad.format_material("PLA", "Generic PLA @System", {"nozzle_temperature": "205"})
        out = communitycad.replace_material(HAND_EDITED, "PLA", block)
        self.assertIn("nozzle_temperature: 205", out)
        before, after = HAND_EDITED.split("# PETG below", 1), out.split("# PETG below", 1)
        self.assertEqual(after[1], before[1], "the other material and its comment are untouched")
        self.assertTrue(out.startswith("# My materials, edited in Mainsail\n[material PLA]"))

    def test_a_new_material_is_appended_and_delete_removes_only_it(self):
        block = communitycad.format_material("ASA", "Generic ASA @System", {})
        added = communitycad.replace_material(HAND_EDITED, "ASA", block)
        self.assertTrue(added.startswith(HAND_EDITED))
        self.assertEqual(communitycad.replace_material(added, "ASA", None).rstrip("\n"),
                         HAND_EDITED.rstrip("\n"))

    def test_format_round_trips_through_parse(self):
        values = {"nozzle_temperature": "245", "filament_start_gcode": "; a\nM117 b",
                  "filament_notes": "dry 4h at 65"}
        text = communitycad.format_material("X", "Generic PETG @System", values)
        parsed, problems = communitycad.parse_materials(text)
        self.assertEqual(problems, [])
        self.assertEqual(parsed["X"]["values"], values)

    def test_keys_are_orcas_own(self):
        keys = communitycad.orca_filament_keys()
        for k in ("nozzle_temperature", "pressure_advance", "filament_flow_ratio",
                  "filament_max_volumetric_speed", "filament_start_gcode", "textured_plate_temp"):
            self.assertIn(k, keys)
        self.assertNotIn("inherits", keys)
        self.assertNotIn("compatible_printers", keys)


@unittest.skipUnless(ORCA_RESOURCES.is_dir(), "needs OrcaSlicer's presets (scripts/install-orca.sh)")
class TestMaterialsEndpoints(ComponentTestCase):
    def setUp(self):
        super().setUp()
        orca_dir = pathlib.Path(self._tmp.name, "orca")
        orca_dir.mkdir()
        orca_dir.joinpath("resources").symlink_to(ORCA_RESOURCES)
        orca_dir.joinpath("run-orca").write_text("#!/bin/sh\n")
        self.comp = CommunityCAD(FakeConfig(self.server, {"orca_path": str(orca_dir / "run-orca")}))
        self.comp._settings["notice"] = {"version": communitycad.NOTICE_VERSION}  # accepted
        self.fm = FakeFileManager()
        self.server.components["file_manager"] = self.fm
        self.path = pathlib.Path(self.fm.config, "materials.cfg")

    async def call(self, handler, args=None, method="GET"):
        return await getattr(self.comp, handler)(FakeWebRequest(args or {}, method=method))

    async def test_first_use_creates_the_file_with_the_generics_beside_printer_cfg(self):
        result = await self.call("_handle_materials")
        self.assertEqual(result["path"], str(self.path))
        self.assertEqual([m["name"] for m in result["materials"]], ["PLA", "PETG", "ABS", "ASA", "TPU"])
        self.assertIn("Not a Klipper file", self.path.read_text())

    async def test_detail_shows_every_orca_setting_with_its_inherited_value(self):
        await self.call("_handle_material_save", {"name": "PLA", "inherits": "Generic PLA @System",
                                                  "values": {"nozzle_temperature": "205"}}, "POST")
        detail = await self.call("_handle_material_detail", {"name": "PLA"})
        by_key = {s["key"]: s for s in detail["settings"]}
        self.assertEqual(len(by_key), len(communitycad.orca_filament_keys()))
        self.assertEqual((by_key["nozzle_temperature"]["value"], by_key["nozzle_temperature"]["inherited"],
                          by_key["nozzle_temperature"]["changed"]), ("205", "220", True))
        self.assertEqual(by_key["filament_type"]["value"], "PLA")
        self.assertFalse(by_key["filament_type"]["changed"])
        self.assertEqual(by_key["pressure_advance"]["group"], "Pressure advance")

    async def test_save_refuses_names_keys_and_parents_that_dont_exist(self):
        bad = [{"name": "../x", "inherits": "Generic PLA @System"},
               {"name": "Ok", "inherits": "Generic PLA @System", "values": {"speed": "3"}},
               {"name": "Ok", "inherits": "Not A Preset"},
               {"name": "Ok", "values": {"nozzle_temperature": 205}}]
        for args in bad:
            with self.subTest(args=args), self.assertRaises(Exception):
                await self.call("_handle_material_save", args, "POST")

    async def test_rename_and_delete(self):
        await self.call("_handle_materials")
        await self.call("_handle_material_save", {"old_name": "TPU", "name": "TPU 95A",
                                                  "inherits": "Generic TPU @System"}, "POST")
        names = [m["name"] for m in (await self.call("_handle_materials"))["materials"]]
        self.assertIn("TPU 95A", names)
        self.assertNotIn("TPU", names)
        await self.call("_handle_material_delete", {"name": "TPU 95A"}, "POST")
        self.assertNotIn("TPU 95A", self.path.read_text())

    async def test_an_orca_export_imports_unchanged(self):
        # Shaped like OrcaSlicer's own exported user filament preset.
        orca = {"type": "filament", "name": "Sunlu PLA+ (mine)", "inherits": "Generic PLA @System",
                "from": "User", "filament_settings_id": ["Sunlu PLA+ (mine)"],
                "nozzle_temperature": ["210"], "filament_flow_ratio": ["0.97"],
                "filament_start_gcode": ["; Sunlu\nM117 PLA+"], "some_future_key": ["1"]}
        result = await self.call("_handle_material_import", {"preset": json.dumps(orca)}, "POST")
        self.assertEqual(result["saved"], "Sunlu PLA+ (mine)")
        self.assertEqual(result["skipped"], ["some_future_key"])
        materials, _ = communitycad.parse_materials(self.path.read_text())
        m = materials["Sunlu PLA+ (mine)"]
        self.assertEqual(m["inherits"], "Generic PLA @System")
        self.assertEqual(m["values"], {"nozzle_temperature": "210", "filament_flow_ratio": "0.97",
                                       "filament_start_gcode": "; Sunlu\nM117 PLA+"})

    async def test_the_list_carries_each_materials_colour_and_type(self):
        self.path.write_text("[material Silk]\ninherits: Generic PLA @System\ndefault_filament_colour: #C0FFEE\n\n"
                             "[material Mine]\ninherits: Generic PETG @System\ndefault_filament_colour: red\n\n"
                             "[material Nylon]\ninherits: Generic PLA @System\nfilament_type: PA\n")
        looks = {m["name"]: (m["colour"], m["type"]) for m in (await self.call("_handle_materials"))["materials"]}
        self.assertEqual(looks, {"Silk": ("#C0FFEE", "PLA"), "Mine": (None, "PETG"), "Nylon": (None, "PA")})

    async def test_creating_a_name_that_exists_is_refused(self):
        await self.call("_handle_materials")
        with self.assertRaises(Exception):
            await self.call("_handle_material_save", {"name": "PLA", "create": True,
                                                      "inherits": "Generic PLA @System"}, "POST")

    async def test_the_last_material_cant_be_deleted(self):
        self.path.write_text("[material Only]\ninherits: Generic PLA @System\n")
        with self.assertRaises(Exception):
            await self.call("_handle_material_delete", {"name": "Only"}, "POST")


@unittest.skipUnless(ORCA_RESOURCES.is_dir(), "needs OrcaSlicer's presets (scripts/install-orca.sh)")
class TestProfileEndpoints(TestMaterialsEndpoints):
    """Profiles listed, saved beside printer.cfg, chosen for projects."""

    def setUp(self):
        super().setUp()
        self.ppath = pathlib.Path(self.fm.config, "print_profiles.cfg")

    async def test_save_list_and_delete_a_custom_profile(self):
        r = await self.call("_handle_profiles")
        self.assertEqual(r["custom"], [])
        self.assertIn("0.20mm Standard @Voron", [d["name"] for d in r["defaults"]])
        self.assertFalse(self.ppath.exists(), "no file until there's something to keep")
        await self.call("_handle_profile_save", {"name": "My strong", "inherits": "0.20mm Standard @Voron",
                                                 "values": {"wall_loops": "5", "inner_wall_speed": "150"}}, "POST")
        self.assertTrue(self.ppath.read_text().startswith("# Print profiles"))
        r = await self.call("_handle_profiles")
        self.assertEqual([(c["name"], c["values"]) for c in r["custom"]],
                         [("My strong", {"wall_loops": "5", "inner_wall_speed": "150"})])
        process = await self.call("_handle_process")
        self.assertEqual(process["defaults"]["My strong"]["wall_loops"], "5")
        await self.call("_handle_profile_delete", {"name": "My strong"}, "POST")
        self.assertEqual((await self.call("_handle_profiles"))["custom"], [])

    async def test_a_default_can_be_hidden_and_restored(self):
        """Orca's defaults can't be deleted, so they're hidden from the lists."""
        every = [d["name"] for d in (await self.call("_handle_profiles"))["defaults"]]
        gone = next(n for n in every if n != "0.20mm Standard @Voron")
        r = await self.call("_handle_profile_hide", {"name": gone}, "POST")
        self.assertIsNone(r["moved_to"], "not the default, so the default stays")
        listed = await self.call("_handle_profiles")
        self.assertNotIn(gone, [d["name"] for d in listed["defaults"]])
        self.assertEqual([h["name"] for h in listed["hidden"]], [gone])
        opts, _ = self.comp._project_options({}, {"profile": gone})
        self.assertEqual(opts["profile"], gone, "a project using it still slices with it")
        await self.call("_handle_profile_hide", {"name": gone, "hidden": False}, "POST")
        self.assertEqual([d["name"] for d in (await self.call("_handle_profiles"))["defaults"]], every)

    async def test_hiding_the_default_moves_it_and_the_last_one_stays(self):
        every = [d["name"] for d in (await self.call("_handle_profiles"))["defaults"]]
        r = await self.call("_handle_profile_hide", {"name": "0.20mm Standard @Voron"}, "POST")
        self.assertEqual(r["moved_to"], every[0] if every[0] != "0.20mm Standard @Voron" else every[1])
        self.assertEqual((await self.call("_handle_profiles"))["default_profile"], r["moved_to"])
        for name in every[:-1]:
            await self.call("_handle_profile_hide", {"name": name}, "POST")
        with self.assertRaises(Exception) as ctx:
            await self.call("_handle_profile_hide", {"name": every[-1]}, "POST")
        self.assertIn("last print profile", str(ctx.exception))
        with self.assertRaises(Exception):
            await self.call("_handle_profile_hide", {"name": "Not an Orca preset"}, "POST")

    async def test_detail_shows_every_setting_on_orcas_tabs(self):
        await self.call("_handle_profile_save", {"name": "Mine", "inherits": "0.20mm Standard @Voron",
                                                 "values": {"wall_loops": "5", "outer_wall_speed": "150"}}, "POST")
        d = await self.call("_handle_profile_detail", {"name": "Mine"})
        by = {s["key"]: s for s in d["settings"]}
        self.assertFalse(d["readonly"])
        self.assertEqual((by["wall_loops"]["value"], by["wall_loops"]["inherited"], by["wall_loops"]["changed"]),
                         ("5", "3", True))
        self.assertEqual((by["wall_loops"]["group"], by["outer_wall_speed"]["group"], by["support_type"]["group"],
                          by["skirt_loops"]["group"], by["layer_height"]["group"]),
                         ("Strength", "Speed", "Support", "Others", "Quality"))
        self.assertTrue(by["layer_height"]["common"])
        self.assertNotIn("post_process", by)
        default = await self.call("_handle_profile_detail", {"name": "0.12mm Fine @Voron"})
        self.assertTrue(default["readonly"])
        self.assertFalse(any(s["changed"] for s in default["settings"]))

    async def test_refused_names_and_keys(self):
        bad = [{"name": "0.20mm Standard @Voron", "inherits": "0.20mm Standard @Voron"},   # Orca's own
               {"name": "X", "inherits": "0.20mm Standard @Voron", "values": {"post_process": "x"}},
               {"name": "X", "inherits": "0.20mm Standard @Voron", "values": {"nozzle_temperature": "200"}},
               {"name": "X", "inherits": "Generic PLA @System"},
               {"name": "../x", "inherits": "0.20mm Standard @Voron"}]
        for args in bad:
            with self.subTest(args=args), self.assertRaises(Exception):
                await self.call("_handle_profile_save", args, "POST")

    async def test_projects_choose_a_profile_and_old_quality_keys_still_work(self):
        await self.call("_handle_materials")
        await self.call("_handle_profile_save", {"name": "Mine", "inherits": "0.24mm Draft @Voron",
                                                 "values": {}}, "POST")
        opts, _ = self.comp._project_options({"profile": "Mine"})
        self.assertEqual(opts["profile"], "Mine")
        opts, _ = self.comp._project_options({"quality": "fine"})
        self.assertEqual(opts["profile"], "0.12mm Fine @Voron")
        opts, _ = self.comp._project_options({}, {"quality": "draft"})
        self.assertEqual(opts["profile"], "0.24mm Draft @Voron")
        with self.assertRaises(Exception):
            self.comp._project_options({"profile": "Nope"})
        await self.call("_handle_settings", {"default_profile": "Mine"}, "POST")
        self.assertEqual(self.comp._project_options({})[0]["profile"], "Mine", "the printer's default")
        opts, _ = self.comp._project_options({}, {"profile": "Deleted since"})
        self.assertEqual(opts["profile"], "Mine", "a project's deleted profile falls back to the default")

    async def test_new_projects_start_from_the_last_material_used(self):
        """Quick print and new projects use the material sliced with last."""
        await self.call("_handle_materials")
        self.assertEqual(self.comp._project_options({})[0]["material"], "PLA", "PLA before anything was used")
        self.comp._settings["last_material"] = "PETG"
        self.assertEqual(self.comp._project_options({})[0]["material"], "PETG")
        self.assertEqual(self.comp._project_options({}, {"material": "ABS"})[0]["material"], "ABS",
                         "a project's own material wins")
        self.comp._settings["last_material"] = "Deleted since"
        self.assertEqual(self.comp._project_options({})[0]["material"], "PLA", "a deleted one falls back")


def orca_bundle() -> bytes:
    """Shaped like desktop Orca's Export Preset Bundle (.orca_printer)."""
    import io, zipfile
    files = {
        "bundle_structure.json": {"bundle_type": "printer config bundle", "printer_preset_name": "Mine"},
        "printer/Voron Trident 350 - mine.json": {"type": "machine", "name": "Voron Trident 350 - mine",
                                                  "printer_settings_id": "Voron Trident 350 - mine"},
        "process/My fast.json": {"type": "process", "name": "My fast", "from": "User",
                                      "inherits": "0.20mm Standard @Voron", "print_settings_id": "My fast",
                                      "wall_loops": "4", "outer_wall_speed": "200", "post_process": ["/bin/evil"],
                                      "some_future_key": "1"},
        "process/From my Bambu.json": {"type": "process", "name": "From my Bambu", "from": "User",
                                       "inherits": "0.20mm Standard @BBL X2D", "wall_loops": "6"},
        "filament/My PETG.json": {"type": "filament", "name": "My PETG", "from": "User",
                                  "inherits": "Generic PETG @System", "nozzle_temperature": ["245"],
                                  "filament_settings_id": ["My PETG"]},
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for path, body in files.items():
            z.writestr(path, json.dumps(body))
    return buf.getvalue()


@unittest.skipUnless(ORCA_RESOURCES.is_dir(), "needs OrcaSlicer's presets (scripts/install-orca.sh)")
class TestOrcaImportExport(TestMaterialsEndpoints):
    """A creator's own Orca presets in, and back out to desktop Orca."""

    async def importing(self, data, apply=False, filename="Mine.orca_printer"):
        import base64
        return await self.call("_handle_orca_import", {"filename": filename, "apply": apply,
                                                       "data": base64.b64encode(data).decode()}, "POST")

    async def test_preview_changes_nothing_then_apply_writes_both_files(self):
        await self.call("_handle_materials")
        before = self.path.read_text()
        r = await self.importing(orca_bundle())
        items = {(i["kind"], i["name"]): i for i in r["items"]}
        self.assertEqual(items[("printer", "Voron Trident 350 - mine")]["action"], "skip")
        fast = items[("profile", "My fast")]
        self.assertEqual((fast["action"], fast["inherits"], fast["dropped"], fast["skipped"]),
                         ("add", "0.20mm Standard @Voron", ["post_process"], ["some_future_key"]))
        bambu = items[("profile", "From my Bambu")]
        self.assertEqual(bambu["inherits"], "0.20mm Standard @Voron")
        self.assertIn("re-based", bambu["note"])
        self.assertEqual(items[("material", "My PETG")]["action"], "add")
        self.assertFalse(pathlib.Path(self.fm.config, "print_profiles.cfg").exists(), "a preview writes nothing")
        self.assertEqual(self.path.read_text(), before)

        await self.importing(orca_bundle(), apply=True)
        profiles, _ = communitycad.parse_profiles(pathlib.Path(self.fm.config, "print_profiles.cfg").read_text())
        self.assertEqual(profiles["My fast"]["values"], {"wall_loops": "4", "outer_wall_speed": "200"})
        self.assertEqual(profiles["From my Bambu"]["values"]["wall_loops"], "6", "the creator's own value kept")
        materials, _ = communitycad.parse_materials(self.path.read_text())
        self.assertEqual(materials["My PETG"]["values"]["nozzle_temperature"], "245")
        again = await self.importing(orca_bundle())
        self.assertEqual({i["action"] for i in again["items"] if i["kind"] != "printer"}, {"replace"})

    async def test_exported_presets_import_back_unchanged(self):
        import base64
        await self.call("_handle_materials")
        await self.importing(orca_bundle(), apply=True)
        out = await self.call("_handle_orca_export", {"kind": "all"})
        self.assertTrue(out["filename"].endswith(".zip"))
        import io, zipfile
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(out["data"]))) as z:
            fast = json.loads(z.read("process/My fast.json"))
            petg = json.loads(z.read("filament/My PETG.json"))
        self.assertEqual((fast["type"], fast["from"], fast["inherits"], fast["wall_loops"]),
                         ("process", "User", "0.20mm Standard @Voron", "4"))
        self.assertEqual(petg["nozzle_temperature"], ["245"], "Orca's list shape for filaments")
        one = await self.call("_handle_orca_export", {"kind": "profile", "name": "My fast"})
        self.assertEqual(json.loads(base64.b64decode(one["data"]))["name"], "My fast")
        r = await self.importing(base64.b64decode(out["data"]), filename="CommunityCAD presets.zip")
        self.assertEqual({(i["kind"], i["action"]) for i in r["items"]}, {("profile", "replace"), ("material", "replace")})

    async def test_not_presets_are_refused(self):
        for data in (b"not json", b"PK\x03\x04broken", json.dumps({"type": "machine", "name": "x"}).encode()):
            with self.subTest(data=data[:10]), self.assertRaises(Exception):
                await self.importing(data, filename="x.json")


class TestNotice(ComponentTestCase):
    """Nothing reaches or starts on the printer before the first-use notice
    is accepted, enforced on the Pi; a new notice version asks again."""

    def setUp(self):
        super().setUp()
        self.comp._settings.pop("notice", None)

    async def test_send_save_and_print_are_refused_until_accepted(self):
        for handler, args in (("_handle_send", {"model_id": 1, "file_id": 2}),
                              ("_handle_save_model", {"model_id": 1, "file_id": 2}),
                              ("_handle_print", {"filename": "a.gcode", "confirm": True})):
            with self.subTest(handler=handler), self.assertRaises(Exception) as ctx:
                await getattr(self.comp, handler)(FakeWebRequest(args, method="POST"))
            self.assertIn("accept the notice", str(ctx.exception))

    async def test_accepting_is_stored_and_a_new_version_asks_again(self):
        status = await self.comp._handle_notice(FakeWebRequest({}))
        self.assertFalse(status["accepted"])
        with self.assertRaises(Exception):
            await self.comp._handle_notice(FakeWebRequest({"version": "1999-01-01"}, method="POST"))
        r = await self.comp._handle_notice(FakeWebRequest({"version": communitycad.NOTICE_VERSION}, method="POST"))
        self.assertTrue(r["accepted"])
        self.assertTrue(self.comp._notice_accepted())
        r = await self.comp._handle_notice(FakeWebRequest({"withdraw": True}, method="POST"))
        self.assertFalse(r["accepted"])
        await self.comp._handle_notice(FakeWebRequest({"version": communitycad.NOTICE_VERSION}, method="POST"))
        self.comp._settings["notice"]["version"] = "2026-01-01"
        self.assertFalse(self.comp._notice_accepted(), "an older acceptance doesn't count for a new notice")


class TestScopeUpgrade(ComponentTestCase):
    """A printer linked for browsing gains the sharing permissions without
    re-linking."""

    def setUp(self):
        super().setUp()
        self.comp._creds = {"access_token": "ccad_tok", "username": "maker", "token_id": 7,
                            "scope": "catalog:read download"}

    async def test_approval_flow_keeps_the_token_and_adds_the_scopes(self):
        self.http.responses.append(FakeResponse(200, {
            "status": "approval_required", "scope": "catalog:read download",
            "added_scopes": ["prints:write", "posts:write"], "device_code": "dc", "user_code": "ABCD-EFGH",
            "verification_uri": "https://communitycad.dev/link",
            "verification_uri_complete": "https://communitycad.dev/link?code=ABCD-EFGH",
            "interval": 5, "expires_in": 600}))
        self.comp.eventloop.create_task = lambda coro: coro.close()   # no background poller in a test
        r = await self.comp._handle_scope_upgrade(FakeWebRequest({}, method="POST"))
        self.assertEqual((r["status"], r["user_code"], r["added"]),
                         ("approval_required", "ABCD-EFGH", ["prints:write", "posts:write"]))
        call = self.http.calls[-1]
        self.assertIn("/auth/tokens/current/scopes", str(call))
        status = await self.comp._handle_status(FakeWebRequest({}))
        self.assertTrue(status["link_pending"]["upgrade"])
        self.assertFalse(status["account"]["can_share"])
        self.comp._complete_upgrade({"upgraded": True, "access_token": None, "token_id": 7,
                                     "scope": "catalog:read download prints:write posts:write"})
        self.assertEqual(self.comp._creds["access_token"], "ccad_tok", "same token, same identity")
        self.assertTrue(self.comp._can_share())
        self.assertTrue((await self.comp._handle_status(FakeWebRequest({})))["account"]["can_share"])

    async def test_already_granted_needs_no_approval(self):
        self.http.responses.append(FakeResponse(200, {
            "status": "granted", "scope": "catalog:read download prints:write posts:write", "added_scopes": []}))
        r = await self.comp._handle_scope_upgrade(FakeWebRequest({}, method="POST"))
        self.assertEqual(r["status"], "granted")
        self.assertTrue(r["can_share"])

    async def test_unlinked_printer_is_told_to_connect(self):
        self.comp._creds = {}
        with self.assertRaises(Exception):
            await self.comp._handle_scope_upgrade(FakeWebRequest({}, method="POST"))

    async def test_a_platform_without_sharing_yet_is_said_plainly(self):
        self.http.responses.append(FakeResponse(404, {"detail": "Not Found"}))
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_scope_upgrade(FakeWebRequest({}, method="POST"))
        self.assertIn("doesn't take shares from printers yet", str(ctx.exception))


SHARED_GCODE = """; HEADER_BLOCK_START
; generated by OrcaSlicer 2.4.2
; HEADER_BLOCK_END
G28
G1 X10 Y10 E1
; CONFIG_BLOCK_START
; layer_height = 0.2
; wall_loops = 3
; filament_type = PETG
; print_host = 192.0.2.44
; printhost_apikey = 3f9a1c7e5b2d48a6
; machine_start_gcode = PRINT_START BED=[bed_temperature_initial_layer_single]
; CONFIG_BLOCK_END
"""


class AlwaysPublic(dict):
    """A visibility cache that knows every model is public, unless set otherwise."""
    def get(self, key, default=None):
        return super().get(key, (float("inf"), True))


class TestShareProfile(ComponentTestCase):
    """A finished print of a CommunityCAD file, shared in one tap, with only
    allowlisted settings; the sharing scopes and the first-use notice are required."""

    def setUp(self):
        super().setUp()
        self.fm = FakeFileManager()
        self.server.components["file_manager"] = self.fm
        self.comp._settings["permissions"] = {"printer_settings": True, "print_history": True}
        self.comp._settings["notice"] = {"version": communitycad.NOTICE_VERSION}
        self.comp._creds = {"access_token": "ccad_tok", "username": "maker",
                            "scope": "catalog:read download prints:write posts:write"}
        folder = pathlib.Path(self.fm.gcodes, "communitycad")
        folder.mkdir(parents=True, exist_ok=True)
        folder.joinpath("bracket.gcode").write_text(SHARED_GCODE)
        self.comp._record_in_library("communitycad/bracket.gcode", {"model_id": 142, "title": "Bracket", "slug": "bracket"})
        # CommunityCAD's own allowlist: known up front, so no fetch is queued.
        self.comp._platform_keys = (float("inf"), None)
        # Every model public unless a test says otherwise, so no fetch is queued.
        self.comp._visibility_cache = AlwaysPublic()

    def finish(self, filename="communitycad/bracket.gcode", status="completed"):
        self.comp._on_history_changed({"action": "finished", "job": {
            "job_id": "0000A1", "filename": filename, "status": status, "end_time": 1000.0,
            "print_duration": 3600.4, "filament_used": 4321.06}})

    async def test_a_finished_print_is_listed_and_the_preview_holds_no_secrets(self):
        self.finish()
        self.finish("someone-elses.gcode")
        listed = (await self.comp._handle_share_prints(FakeWebRequest({})))["prints"]
        self.assertEqual([p["filename"] for p in listed], ["communitycad/bracket.gcode"], "only CommunityCAD files")
        payload = (await self.comp._handle_share_preview(FakeWebRequest({"job_id": "0000A1"})))["payload"]
        self.assertEqual((payload["model_id"], payload["result"], payload["print_duration_s"], payload["filament_used_mm"]),
                         (142, "completed", 3600, 4321.1))
        self.assertEqual(payload["material"], {"type": "PETG"})
        text = json.dumps(payload)
        for secret in ("192.0.2.44", "3f9a1c7e5b2d48a6", "PRINT_START"):
            self.assertNotIn(secret, text)
        self.assertEqual(payload["settings"].get("layer_height"), "0.2")

    async def test_nothing_is_recorded_without_permission_to_read_history(self):
        self.comp._settings["permissions"]["print_history"] = False
        self.finish()
        self.assertEqual((await self.comp._handle_share_prints(FakeWebRequest({})))["prints"], [])

    async def test_share_sends_the_preview_and_remembers_the_result(self):
        self.finish()
        preview = (await self.comp._handle_share_preview(FakeWebRequest({"job_id": "0000A1"})))["payload"]
        self.http.responses.append(FakeResponse(201, {
            "profile": {"id": 77}, "dropped_settings": [], "print_count": 3,
            "model_url": "https://communitycad.dev/models/bracket-142"}))
        r = await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}, method="POST"))
        method, url, body, _ = self.http.calls[-1]
        self.assertEqual((method, url.endswith("/prints/profiles")), ("POST", True))
        self.assertEqual(body, preview, "what was shown is what was sent")
        self.assertEqual((r["shared"]["profile_id"], r["shared"]["print_count"]), (77, 3))
        listed = (await self.comp._handle_share_prints(FakeWebRequest({})))["prints"]
        self.assertEqual(listed[0]["shared"]["model_url"], "https://communitycad.dev/models/bracket-142")

    async def test_sharing_needs_the_scopes_and_the_notice(self):
        self.finish()
        self.comp._creds["scope"] = "catalog:read download"
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}, method="POST"))
        self.assertIn("permissions", str(ctx.exception))
        self.comp._creds["scope"] += " prints:write posts:write"
        self.comp._settings.pop("notice")
        with self.assertRaises(Exception):
            await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}, method="POST"))
        self.assertEqual(self.http.calls, [], "nothing left the Pi")

    async def test_a_project_slice_credits_its_catalog_models(self):
        self.comp._write_json(self.comp._models_file, {
            "a.stl": {"model_id": 5, "title": "A"}, "mine.stl": {"uploaded": True}}, 0o600)
        self.comp._save_project_meta("p.3mf", {"origin": "models", "sources": [
            {"model": "a.stl", "copies": 2}, {"model": "mine.stl", "copies": 1}]})
        self.assertEqual(self.comp._catalog_models_of("p.3mf", {}), [{"model_id": 5, "title": "A", "slug": None}])


class TestUnreachable(TestShareProfile):
    """A refused connection comes back from Moonraker's client as a bodiless 500
    with the exception attached. It's "can't reach CommunityCAD", and the share waits."""

    async def test_a_refused_connection_is_unreachable_and_the_share_waits(self):
        self.finish()
        failed = FakeResponse(500)
        failed.error = ConnectionRefusedError(111, "Connection refused")
        self.http.responses.append(failed)
        r = await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}, method="POST"))
        self.assertTrue(r["queued"])
        self.assertIn("Can't reach CommunityCAD", r["message"])

    async def test_a_real_server_error_is_still_a_server_error(self):
        self.finish()
        class HTTPClientError(Exception):
            code = 500
        real = FakeResponse(500, {"detail": "boom"})
        real.error = HTTPClientError()
        self.http.responses.append(real)
        r = await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}, method="POST"))
        self.assertTrue(r["queued"], "a 500 is transient too, so it waits")
        self.assertEqual(r["message"], "boom", "but its own message is kept")


class TestPlateShare(TestShareProfile):
    """A share is the plate that printed, previewed as CommunityCAD keeps it."""

    SETTINGS = ('<config>\n<object id="2"><part id="1"><metadata key="source_file" value="Holder_V0.stl"/></part></object>\n'
                '<object id="4"><part id="3"><metadata key="source_file" value="Connector_V0.stl"/></part></object>\n'
                '<object id="6"><part id="5"><metadata key="source_file" value="mine.stl"/></part></object>\n'
                '<plate><metadata key="plater_id" value="1"/>'
                '<model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance>'
                '<model_instance><metadata key="object_id" value="4"/><metadata key="instance_id" value="0"/></model_instance>'
                '<model_instance><metadata key="object_id" value="4"/><metadata key="instance_id" value="1"/></model_instance>'
                '</plate>\n<plate><metadata key="plater_id" value="2"/>'
                '<model_instance><metadata key="object_id" value="6"/><metadata key="instance_id" value="0"/></model_instance>'
                '</plate></config>')

    def test_whats_on_each_plate(self):
        self.assertEqual(communitycad.plate_contents(self.SETTINGS),
                         {1: {"Holder_V0.stl": 1, "Connector_V0.stl": 2}, 2: {"mine.stl": 1}})

    def test_two_models_each_credited_once_and_own_parts_counted(self):
        saved = {"Holder_V0.stl": {"model_id": 716, "file_id": 11, "title": "Holder_V0"},
                 "Connector_V0.stl": {"model_id": 715, "file_id": 12, "title": "Connector_V0"},
                 "mine.stl": {"uploaded": True}}
        models, own = communitycad.credited_models({"Holder_V0.stl": 1, "Connector_V0.stl": 2, "mine.stl": 1}, saved)
        self.assertEqual(own, 1)
        self.assertEqual({m["model_id"]: [(f["file_id"], f["copies"]) for f in m["files"]] for m in models},
                         {716: [(11, 1)], 715: [(12, 2)]})

    def test_one_upload_with_two_files_is_one_model(self):
        saved = {"a.stl": {"model_id": 9, "file_id": 1, "title": "Kit"}, "b.stl": {"model_id": 9, "file_id": 2, "title": "Kit"}}
        models, own = communitycad.credited_models({"a.stl": 1, "b.stl": 3}, saved)
        self.assertEqual((len(models), own), (1, 0))
        self.assertEqual([(f["file_id"], f["copies"]) for f in models[0]["files"]], [(1, 1), (2, 3)])

    async def test_the_preview_is_what_communitycad_keeps(self):
        self.finish()
        self.comp._platform_keys = (float("inf"), {"layer_height"})
        r = await self.comp._handle_share_preview(FakeWebRequest({"job_id": "0000A1"}))
        self.assertEqual(set(r["payload"]["settings"]), {"layer_height"})
        self.assertTrue(r["not_shared"], "what CommunityCAD doesn't take is listed")
        self.assertNotIn("_not_shared", r["payload"])
        self.http.responses.append(FakeResponse(201, {"profile": {"id": 3}, "dropped_settings": [], "print_count": 1,
                                                      "model_url": "u"}))
        await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}, method="POST"))
        sent = self.http.calls[-1][2]
        self.assertEqual(sent, r["payload"], "sent exactly what was previewed")
        self.assertFalse(any(k.startswith("_") for k in sent))


class TestMyModels(ComponentTestCase):
    """The account's own models, private ones included."""

    async def test_mine_goes_with_the_token(self):
        self.comp._creds = {"access_token": "ccad_tok"}
        self.http.responses.append(FakeResponse(200, {"items": [{"id": 1, "visibility": "private"}], "total": 1}))
        r = await self.comp._handle_search(FakeWebRequest({"mine": "1", "fit": "any"}))
        method, url, _, headers = self.http.calls[-1]
        self.assertIn("mine=1", url)
        self.assertIn("ccad_tok", str(headers))
        self.assertEqual(r["items"][0]["visibility"], "private")

    async def test_unlinked_asks_to_connect_and_calls_nothing(self):
        self.comp._creds = {}
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_search(FakeWebRequest({"mine": "1"}))
        self.assertIn("Connect this printer", str(ctx.exception))
        self.assertEqual(self.http.calls, [])

    async def test_mine_off_is_not_sent(self):
        self.http.responses.append(FakeResponse(200, {"items": [], "total": 0}))
        await self.comp._handle_search(FakeWebRequest({"mine": "0", "q": "x"}))
        self.assertNotIn("mine", self.http.calls[-1][1])


class TestOutbox(TestShareProfile):
    """A share that can't reach CommunityCAD waits on the Pi and goes later."""

    def setUp(self):
        super().setUp()
        self._sleep = communitycad.asyncio.sleep

        async def no_sleep(_):
            return None
        communitycad.asyncio.sleep = no_sleep

    def tearDown(self):
        communitycad.asyncio.sleep = self._sleep
        super().tearDown()

    async def share(self):
        return await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}, method="POST"))

    async def test_no_network_queues_it_and_it_goes_when_the_network_is_back(self):
        self.finish()
        self.http.raise_on_request = OSError("network is unreachable")
        r = await self.share()
        self.assertTrue(r["queued"])
        listed = (await self.comp._handle_share_prints(FakeWebRequest({})))["prints"][0]
        self.assertEqual(listed["outbox"]["state"], "waiting")
        self.assertGreater(listed["outbox"]["next_at"], communitycad.time.time())
        item = self.comp._outbox_items()[0]
        item["next_at"] = 0
        self.comp._outbox_save(item)
        self.http.raise_on_request = None
        self.http.responses.append(FakeResponse(201, {"profile": {"id": 9}, "dropped_settings": [],
                                                      "print_count": 1, "model_url": "https://x/m"}))
        self.assertTrue(await self.comp._outbox_deliver(item))
        self.assertEqual(self.comp._outbox_items(), [])
        listed = (await self.comp._handle_share_prints(FakeWebRequest({})))["prints"][0]
        self.assertEqual((listed["shared"]["profile_id"], listed["outbox"]), (9, None))

    async def test_a_busy_server_backs_off_and_a_refusal_waits_for_the_user(self):
        self.finish()
        self.http.responses.append(FakeResponse(503, {}))      # POSTs aren't retried inline
        r = await self.share()
        self.assertTrue(r["queued"])
        item = self.comp._outbox_items()[0]
        first_gap = item["next_at"] - communitycad.time.time()
        self.http.responses.append(FakeResponse(503, {}))
        await self.comp._outbox_deliver(item)
        item = self.comp._outbox_items()[0]
        self.assertGreater(item["next_at"] - communitycad.time.time(), first_gap + 100, "backs off")
        self.http.responses.append(FakeResponse(422, {"detail": "Model not found"}))
        await self.comp._outbox_deliver(item)
        item = self.comp._outbox_items()[0]
        self.assertEqual((item["state"], item["error"]), ("failed", "Model not found"))
        r = await self.comp._handle_outbox(FakeWebRequest({"id": item["id"], "action": "delete"}, method="POST"))
        self.assertEqual(self.comp._outbox_items(), [])

    async def test_manual_retry_reports_why_it_failed(self):
        self.finish()
        self.http.raise_on_request = OSError("down")
        await self.share()
        item = self.comp._outbox_items()[0]
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_outbox(FakeWebRequest({"id": item["id"], "action": "retry"}, method="POST"))
        self.assertIn("Can't reach CommunityCAD", str(ctx.exception))


JPEG = b"\xff\xd8\xff\xe0" + b"photo" * 50


class FakeStorage:
    """A GCS resumable session: 308 with the Range received so far, 200 at the end.
    `cut_after` drops the connection after that many chunks."""

    def __init__(self, size, cut_after=None):
        self.size, self.got, self.cut_after, self.puts = size, 0, cut_after, []

    async def request(self, method, url, body, headers, connect_timeout, request_timeout):
        self.puts.append(headers.get("Content-Range"))
        if self.cut_after is not None and len([p for p in self.puts if "*" not in p]) > self.cut_after:
            self.cut_after = None
            raise OSError("connection reset")
        rng = headers["Content-Range"]
        if not rng.startswith("bytes */"):
            start, end = (int(x) for x in rng.split()[1].split("/")[0].split("-"))
            assert start == self.got, (start, self.got)
            self.got = end + 1
        done = self.got >= self.size
        return communitycad.StorageClient.Response(200 if done else 308,
                                                   {} if self.got == 0 else {"Range": f"bytes=0-{self.got - 1}"})


class TestPosts(TestShareProfile):
    """Posts with photos or the timelapse, publish or draft, privacy settings
    respected, and the outbox for anything that doesn't get through."""

    def setUp(self):
        super().setUp()
        self.tl = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tl)

        class Timelapse:
            out_dir = str(self.tl) + "/"
        self.server.components["timelapse"] = Timelapse()

    async def create(self, **args):
        if "0000A1" not in self.comp._read_json(self.comp._prints_file):
            self.finish()
        return await self.comp._handle_post_create(FakeWebRequest({"job_id": "0000A1", **args}, method="POST"))

    def test_multipart_and_image_types(self):
        import email
        body, ctype = communitycad.multipart_body({"model_id": "142", "caption": "Hi"},
                                                  [("images", "image-0.jpg", "image/jpeg", JPEG)])
        msg = email.message_from_bytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body)
        parts = {p.get_param("name", header="content-disposition"): p for p in msg.get_payload()}
        self.assertEqual(parts["caption"].get_payload(), "Hi")
        self.assertEqual(parts["images"].get_payload(decode=True), JPEG)
        self.assertEqual([communitycad.image_type(x) for x in (JPEG, b"\x89PNG\r\n\x1a\nxx", b"RIFF0000WEBPx", b"GIF89a")],
                         ["jpg", "png", "webp", None])

    async def test_a_photo_post_is_sent_and_remembered(self):
        import base64
        self.http.responses.append(FakeResponse(201, {"post": {"id": 5, "status": "published",
            "url": "https://communitycad.dev/p/5", "edit_url": "https://communitycad.dev/p/5/edit"}, "message": None}))
        r = await self.create(caption="First print", publish=True,
                              images=[{"data": base64.b64encode(JPEG).decode()}])
        method, url, body, headers = self.http.calls[-1]
        self.assertTrue(url.endswith("/posts"))
        self.assertIn("multipart/form-data", headers["Content-Type"])
        self.assertIn(JPEG, body)
        self.assertIn(b'name="publish"\r\n\r\ntrue', body)
        self.assertEqual(r["post"]["url"], "https://communitycad.dev/p/5")
        listed = (await self.comp._handle_share_prints(FakeWebRequest({})))["prints"][0]
        self.assertEqual(listed["posted"]["post_id"], 5)
        self.assertEqual(self.comp._outbox_items(), [], "nothing left waiting")

    async def test_a_post_about_a_private_model_is_only_a_draft(self):
        """Publish on a private model saves a draft, and says so."""
        import base64
        self.comp._visibility_cache = {142: (float("inf"), False)}
        self.http.responses.append(FakeResponse(201, {"post": {"id": 6, "status": "draft",
            "url": None, "edit_url": "https://communitycad.dev/p/6/edit"}, "message": None}))
        r = await self.create(caption="First print", publish=True,
                              images=[{"data": base64.b64encode(JPEG).decode()}])
        self.assertIn(b'name="publish"\r\n\r\nfalse', self.http.calls[-1][2])
        self.assertIn("Kept private", r["message"])

    async def test_a_post_needs_a_picture_and_refuses_other_files(self):
        import base64
        for args in ({"caption": "no media"}, {"images": [{"data": base64.b64encode(b"GIF89a....").decode()}]},
                     {"images": [{"data": base64.b64encode(JPEG).decode()}] * 5}, {"caption": "x" * 501,
                     "images": [{"data": base64.b64encode(JPEG).decode()}]}):
            with self.subTest(args=str(args)[:40]), self.assertRaises(Exception):
                await self.create(**args)
        self.assertEqual(self.http.calls, [])

    async def test_the_timelapse_is_offered_only_when_turned_on(self):
        self.finish()
        event = {"action": "render", "status": "success", "filename": "timelapse_bracket.mp4",
                 "printfile": "communitycad/bracket.gcode"}
        self.tl.joinpath("timelapse_bracket.mp4").write_bytes(b"\x00" * 1000)
        self.comp._on_timelapse_event(event)
        self.assertIsNone((await self.comp._handle_post_options(FakeWebRequest({"job_id": "0000A1"})))["timelapse"])
        self.comp._settings["post_timelapse"] = True
        self.assertIsNone((await self.comp._handle_post_options(FakeWebRequest({"job_id": "0000A1"})))["timelapse"],
                          "nothing was noted while it was off")
        self.comp._on_timelapse_event(event)
        tl = (await self.comp._handle_post_options(FakeWebRequest({"job_id": "0000A1"})))["timelapse"]
        self.assertEqual((tl["filename"], tl["size_bytes"]), ("timelapse_bracket.mp4", 1000))

    async def test_a_timelapse_post_uploads_from_the_pi_then_completes(self):
        self.comp._settings["post_timelapse"] = True
        self.tl.joinpath("timelapse_bracket.mp4").write_bytes(b"v" * 1000)
        self.comp._on_timelapse_event({"action": "render", "status": "success",
                                       "filename": "timelapse_bracket.mp4", "printfile": "communitycad/bracket.gcode"})
        storage = FakeStorage(1000)
        self.comp._storage_client = lambda: storage
        self.http.responses.append(FakeResponse(201, {"post": {"id": 6, "status": "uploading", "url": "u", "edit_url": "e"},
            "upload": {"protocol": "gcs-resumable", "url": "https://storage/x", "method": "PUT", "headers": {},
                       "size_bytes": 1000, "complete_url": "/v1/posts/6/video/complete"}}))
        self.comp.eventloop.create_task = lambda coro: coro.close()
        r = await self.create(timelapse=True, publish=True)
        self.assertTrue(r["video_uploading"])
        self.assertIn(b'name="video_size_bytes"\r\n\r\n1000', self.http.calls[-1][2])
        item = self.comp._outbox_items()[0]
        self.assertEqual(item["data"]["stage"], "video")
        self.http.responses.append(FakeResponse(200, {"post": {"id": 6, "status": "published", "url": "u", "edit_url": "e"}}))
        self.assertTrue(await self.comp._outbox_deliver(item))
        self.assertEqual(storage.got, 1000)
        self.assertTrue(self.http.calls[-1][1].endswith("/posts/6/video/complete"))
        self.assertEqual((await self.comp._handle_share_prints(FakeWebRequest({})))["prints"][0]["posted"]["status"],
                         "published")

    async def test_a_cut_upload_resumes_where_it_stopped(self):
        path = self.tl.joinpath("v.mp4")
        path.write_bytes(b"x" * 2500)
        old = communitycad.UPLOAD_CHUNK
        communitycad.UPLOAD_CHUNK = 1024
        self.addCleanup(setattr, communitycad, "UPLOAD_CHUNK", old)
        storage = FakeStorage(2500, cut_after=1)
        upload = {"protocol": "gcs-resumable", "url": "u", "headers": {}}
        with self.assertRaises(communitycad.CommunityCADError):
            await communitycad.upload_resumable(storage, upload, path)
        self.assertEqual(storage.got, 1024)
        await communitycad.upload_resumable(storage, upload, path, resume=True)
        self.assertEqual(storage.got, 2500)
        self.assertEqual(storage.puts[-3:], ["bytes */2500", "bytes 1024-2047/2500", "bytes 2048-2499/2500"])

    async def test_the_webcam_is_never_read_while_its_setting_is_off(self):
        class Webcams:
            def get_webcams(self_inner):
                raise AssertionError("the webcam was looked up")
        self.server.components["webcam"] = Webcams()
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_webcam_snapshot(FakeWebRequest({}))
        self.assertIn("off in Settings", str(ctx.exception))

    async def test_a_post_that_cant_get_through_waits_with_its_photos(self):
        import base64
        self.http.raise_on_request = OSError("down")
        r = await self.create(images=[{"data": base64.b64encode(JPEG).decode()}], caption="later")
        self.assertTrue(r["queued"])
        item = self.comp._outbox_items()[0]
        self.assertEqual(self.comp._outbox_dir.joinpath(item["id"], "image-0.jpg").read_bytes(), JPEG)
        self.http.raise_on_request = None
        self.http.responses.append(FakeResponse(201, {"post": {"id": 7, "status": "draft", "url": "u", "edit_url": "e"}}))
        self.assertTrue(await self.comp._outbox_deliver(item))
        self.assertFalse(self.comp._outbox_dir.joinpath(item["id"]).exists())



class TestAutoShare(TestPosts):
    """After a print, ask (the default), share automatically after an undo
    window, or don't; public or private; only completed prints; run by the Pi."""

    PROFILE_OK = {"profile": {"id": 77}, "dropped_settings": [], "print_count": 1, "model_url": "m"}

    def due(self):
        prints = self.comp._read_json(self.comp._prints_file)
        for p in prints.values():
            if p.get("auto"):
                p["auto"]["at"] = 0
        self.comp._write_json(self.comp._prints_file, prints, 0o600)

    def auto(self):
        return self.comp._read_json(self.comp._prints_file)["0000A1"].get("auto")

    async def test_ask_is_the_default_and_the_old_setting_carries_over(self):
        self.finish()
        listed = await self.comp._handle_share_prints(FakeWebRequest({}))
        self.assertEqual((listed["mode"], listed["prompt"], listed["visibility"]), ("ask", True, "public"))
        self.assertIsNone(self.auto(), "nothing is scheduled when asking")
        self.comp._settings["share_prompt"] = False
        self.assertEqual(self.comp._share_mode(), "off")

    async def test_automatic_waits_for_the_undo_window_then_shares_the_profile(self):
        self.comp._settings["share_after_print"] = "auto"
        self.finish()
        self.assertEqual(self.auto()["state"], "pending")
        await self.comp._auto_share_due()
        self.assertEqual(self.http.calls, [], "nothing before the window ends")
        self.due()
        self.http.responses.append(FakeResponse(201, self.PROFILE_OK))
        await self.comp._auto_share_due()
        self.assertTrue(self.http.calls[-1][1].endswith("/prints/profiles"))
        self.assertEqual(self.auto()["state"], "done")
        self.assertFalse(self.auto()["posted"], "no picture, no post")
        self.assertEqual(len(self.http.calls), 1)

    async def test_dont_share_this_one_stops_it(self):
        self.comp._settings["share_after_print"] = "auto"
        self.finish()
        await self.comp._handle_auto_cancel(FakeWebRequest({"job_id": "0000A1"}, method="POST"))
        self.due()
        await self.comp._auto_share_due()
        self.assertEqual((self.auto()["state"], self.http.calls), ("cancelled", []))

    async def test_only_completed_prints_are_shared_automatically(self):
        self.comp._settings["share_after_print"] = "auto"
        self.finish(status="cancelled")
        self.assertIsNone(self.auto())

    async def test_nothing_goes_without_the_notice(self):
        self.comp._settings["share_after_print"] = "auto"
        self.finish()
        self.comp._settings.pop("notice")
        self.due()
        await self.comp._auto_share_due()
        self.assertEqual((self.auto()["state"], self.http.calls), ("skipped", []))

    async def test_private_makes_a_draft_and_skips_the_public_profile(self):
        self.comp._settings.update({"share_after_print": "auto", "share_visibility": "private", "post_webcam": True})

        async def snap():
            return "jpg", JPEG
        self.comp._webcam_snapshot = snap
        self.finish()
        self.due()
        self.http.responses.append(FakeResponse(201, {"post": {"id": 9, "status": "draft", "url": "u", "edit_url": "e"}}))
        await self.comp._auto_share_due()
        urls = [c[1] for c in self.http.calls]
        self.assertFalse(any(u.endswith("/prints/profiles") for u in urls), "profiles can't be private yet")
        self.assertIn(b'name="publish"\r\n\r\nfalse', self.http.calls[-1][2])
        self.assertIn(JPEG, self.http.calls[-1][2])
        self.assertEqual(self.auto()["state"], "done")

    async def test_a_timelapse_post_waits_for_the_render(self):
        self.comp._settings.update({"share_after_print": "auto", "post_timelapse": True})
        self.comp.eventloop.create_task = lambda coro: coro.close()
        self.finish()
        self.due()
        self.http.responses.append(FakeResponse(201, self.PROFILE_OK))
        await self.comp._auto_share_due()
        self.assertEqual(self.auto()["state"], "timelapse")
        self.assertGreater(self.auto()["at"], 1000, "waits for the render")
        self.tl.joinpath("timelapse_bracket.mp4").write_bytes(b"v" * 1000)
        self.comp._on_timelapse_event({"action": "render", "status": "success",
                                       "filename": "timelapse_bracket.mp4", "printfile": "communitycad/bracket.gcode"})
        self.http.responses.append(FakeResponse(201, {"post": {"id": 6, "status": "uploading", "url": "u", "edit_url": "e"},
            "upload": {"protocol": "gcs-resumable", "url": "https://storage/x", "method": "PUT", "headers": {},
                       "size_bytes": 1000, "complete_url": "/v1/posts/6/video/complete"}}))
        await self.comp._auto_share_due()
        self.assertIn(b'name="video_size_bytes"\r\n\r\n1000', self.http.calls[-1][2])
        self.assertIn(b'name="print_profile_id"\r\n\r\n77', self.http.calls[-1][2])
        self.assertEqual(self.auto()["state"], "done")

    async def test_settings_take_only_known_values(self):
        for args in ({"share_after_print": "always"}, {"share_visibility": "friends"}):
            with self.subTest(args=args), self.assertRaises(Exception):
                await self.comp._handle_settings(FakeWebRequest(args, method="POST"))
        r = await self.comp._handle_settings(FakeWebRequest({"share_after_print": "auto",
                                                              "share_visibility": "private"}, method="POST"))
        self.assertEqual((r["share_after_print"], r["share_visibility"]), ("auto", "private"))

class TestPermissions(ComponentTestCase):
    """Ask before reading: nothing from printer.cfg until the user says yes,
    read once per Klipper start after that, and enforced on the Pi."""

    def setUp(self):
        super().setUp()
        self.comp._settings["permissions"] = {}
        self.set_toolhead({"axis_minimum": [0, 0, 0, 0], "axis_maximum": [235, 235, 250, 0],
                           "kinematics": "cartesian"})

    def queries(self):
        return self.server.components["klippy_apis"].queries

    async def test_nothing_is_read_before_an_answer(self):
        self.assertIsNone(await self.comp._detect_build_volume())
        self.assertEqual((await self.comp._printer_profile())["nozzle_diameter"], None)
        self.assertEqual(self.queries(), [], "not a single query to Klipper")
        status = await self.comp._handle_status(FakeWebRequest({}))
        self.assertEqual(status["permissions"], {"printer_settings": None, "print_history": None})

    async def test_not_now_reads_nothing_either(self):
        await self.comp._handle_permissions(FakeWebRequest(
            {"printer_settings": False, "print_history": False}, method="POST"))
        self.assertIsNone(await self.comp._detect_build_volume())
        self.assertEqual(self.queries(), [])

    async def test_yes_reads_once_per_klipper_start(self):
        await self.comp._handle_permissions(FakeWebRequest({"printer_settings": True}, method="POST"))
        for _ in range(5):
            vol = await self.comp._detect_build_volume()
            await self.comp._printer_profile()
        self.assertEqual(vol["x"], 235)
        self.assertEqual(len(self.queries()), 1, "one read, however many requests")
        self.comp._on_klippy_ready()
        await self.comp._detect_build_volume()
        self.assertEqual(len(self.queries()), 2, "read again after a Klipper restart")

    async def test_turning_it_off_forgets_what_was_read(self):
        await self.comp._handle_permissions(FakeWebRequest({"printer_settings": True}, method="POST"))
        await self.comp._detect_build_volume()
        await self.comp._handle_permissions(FakeWebRequest({"printer_settings": False}, method="POST"))
        self.assertIsNone(self.comp._printer_cache)
        self.assertIsNone(await self.comp._detect_build_volume())

    async def test_the_answers_are_independent_and_must_be_booleans(self):
        result = await self.comp._handle_permissions(FakeWebRequest({"print_history": True}, method="POST"))
        self.assertEqual(result, {"printer_settings": None, "print_history": True})
        with self.assertRaises(Exception):
            await self.comp._handle_permissions(FakeWebRequest({"printer_settings": "yes"}, method="POST"))

    async def test_a_typed_bed_size_works_without_permission(self):
        self.comp._settings["build_volume"] = {"x": 200, "y": 200, "z": 180}
        vol = await self.comp._effective_build_volume()
        self.assertEqual((vol["x"], vol["source"]), (200.0, "override"))
        self.assertEqual(self.queries(), [])


FIXTURES = pathlib.Path(__file__).resolve().parent.joinpath("fixtures")


def klipper_config(kin="cartesian", bed=(235, 235, 250), z=1, levelling=None, start=None,
                   end=None, extra=None):
    """A minimal parsed Klipper config, shaped like configfile.settings."""
    cfg = {
        "printer": {"kinematics": kin, "max_velocity": 300.0, "max_accel": 3000.0,
                    "max_z_velocity": 5.0},
        "stepper_x": {"position_min": 0.0, "position_max": float(bed[0])},
        "stepper_y": {"position_min": 0.0, "position_max": float(bed[1])},
        "extruder": {"nozzle_diameter": 0.4, "filament_diameter": 1.75, "max_temp": 260.0},
        "heater_bed": {"max_temp": 110.0},
    }
    for i in range(z):
        cfg["stepper_z" + (str(i) if i else "")] = {"position_max": float(bed[2])}
    if levelling:
        cfg[levelling] = {}
    if start:
        cfg[f"gcode_macro {start[0]}"] = {"gcode": start[1]}
    if end:
        cfg[f"gcode_macro {end}"] = {"gcode": "G28"}
    cfg.update(extra or {})
    return cfg


class TestPrinterFromConfig(unittest.TestCase):
    """The slicer's printer, from printer.cfg, mods included."""

    def test_a_trident_350_with_its_own_limits_and_macro(self):
        settings = json.loads(FIXTURES.joinpath("printer-trident350.json").read_text())
        header = "## Voron Design Trident 250/300/350mm BigTreeTech OctoPus V1 TMC2209 UART config\n"
        p = communitycad.printer_from_config(settings, header)
        self.assertEqual(p["identity"]["name"], "Voron Trident 350")
        self.assertEqual((p["max_velocity"], p["max_accel"]), (300.0, 6000.0))
        self.assertTrue(p["firmware_retraction"])
        self.assertTrue(p["enclosed"])
        self.assertEqual(p["params"], {"bed": "BED", "extruder": "EXTRUDER", "chamber": "CHAMBER"})
        # The macro heats bed and nozzle itself: the slicer only calls it.
        self.assertTrue(p["start_gcode"].startswith("PRINT_START BED=[bed_temperature_initial_layer_single]"))
        self.assertNotIn("M190", p["start_gcode"])
        self.assertNotIn("M109", p["start_gcode"])
        self.assertIn("{if chamber_temperature[0] > 0} CHAMBER=", p["start_gcode"])
        self.assertEqual(p["end_gcode"], "PRINT_END")

    def test_a_voron_24_is_recognised_by_its_four_z_and_qgl(self):
        p = communitycad.printer_from_config(klipper_config("corexy", (300, 300, 280), 4, "quad_gantry_level"))
        self.assertEqual(p["identity"]["name"], "Voron 2.4 300")

    def test_a_printer_shaped_like_a_voron_but_named_otherwise_isnt_called_one(self):
        cfg = klipper_config("corexy", (350, 350, 345), 4, "quad_gantry_level")
        p = communitycad.printer_from_config(cfg, "# Sovol SV08 printer configuration\n")
        self.assertIsNone(p["identity"]["name"])
        self.assertTrue(any("sovol" in e.lower() for e in p["identity"]["evidence"]))

    def test_a_klipper_ender_gets_its_own_macro_names_and_preheat(self):
        start = ("START_PRINT", "{% set b = params.BED_TEMP|int %}{% set e = params.EXTRUDER_TEMP|int %}\n"
                                "G28\nBED_MESH_CALIBRATE")
        p = communitycad.printer_from_config(klipper_config(start=start, end="END_PRINT"))
        self.assertIsNone(p["identity"]["name"])
        self.assertEqual(p["params"], {"bed": "BED_TEMP", "extruder": "EXTRUDER_TEMP"})
        lines = p["start_gcode"].splitlines()
        # This macro doesn't heat, so the slicer heats first, then calls it.
        self.assertEqual(lines[0], "M190 S[bed_temperature_initial_layer_single]")
        self.assertEqual(lines[1], "M109 S[nozzle_temperature_initial_layer]")
        self.assertTrue(lines[2].startswith("START_PRINT BED_TEMP=["))
        self.assertEqual(p["end_gcode"], "END_PRINT")

    def test_no_start_macro_leaves_orcas_default(self):
        p = communitycad.printer_from_config(klipper_config())
        self.assertIsNone(p["start_gcode"])
        self.assertIsNone(p["start_macro"])

    def test_limits_clamp_every_speed_and_acceleration(self):
        machine = {"machine_max_speed_x": ["500", "500"]}
        process = {"default_acceleration": ["10000"], "outer_wall_acceleration": ["5000"],
                   "travel_acceleration": "12000", "travel_speed": ["600"], "outer_wall_speed": ["200"],
                   "small_perimeter_speed": ["50%"], "fan_max_speed": ["100"]}
        communitycad.apply_printer(machine, process, {"max_velocity": 300.0, "max_accel": 6000.0,
                                                      "firmware_retraction": True})
        self.assertEqual(process["default_acceleration"], ["6000"])
        self.assertEqual(process["outer_wall_acceleration"], ["5000"], "below the limit: kept")
        self.assertEqual(process["travel_acceleration"], "6000")
        self.assertEqual(process["travel_speed"], ["300"])
        self.assertEqual(process["outer_wall_speed"], ["200"])
        self.assertEqual(process["small_perimeter_speed"], ["50%"], "percentages left alone")
        self.assertEqual(process["fan_max_speed"], ["100"], "fans aren't motion")
        self.assertEqual(machine["machine_max_speed_x"], ["300", "300"])
        self.assertEqual(machine["use_firmware_retraction"], "1")
        self.assertEqual(machine["wipe"], ["0"], "Orca refuses firmware retraction with wipe")


class TestClampGcode(unittest.TestCase):
    """The output never asks Klipper for more than printer.cfg allows."""

    def run_clamp(self, text, accel=6000.0, velocity=300.0):
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d, "x.gcode")
            path.write_bytes(text.encode())
            n = communitycad.clamp_gcode_limits(path, accel, velocity)
            return n, path.read_text()

    def test_too_high_is_capped_and_the_rest_untouched(self):
        src = ("; header\nSET_VELOCITY_LIMIT ACCEL=20000\nG1 X10 F30000\n"
               "SET_VELOCITY_LIMIT ACCEL=3000 SQUARE_CORNER_VELOCITY=5\n"
               "SET_VELOCITY_LIMIT VELOCITY=500 ACCEL=9000\nM204 S12000\nM204 P2000 T8000\n")
        n, out = self.run_clamp(src)
        self.assertEqual(n, 4)
        self.assertEqual(out.splitlines(), [
            "; header", "SET_VELOCITY_LIMIT ACCEL=6000", "G1 X10 F30000",
            "SET_VELOCITY_LIMIT ACCEL=3000 SQUARE_CORNER_VELOCITY=5",
            "SET_VELOCITY_LIMIT VELOCITY=300 ACCEL=6000", "M204 S6000", "M204 P2000 T6000"])

    def test_nothing_above_the_limits_leaves_the_file_alone(self):
        src = "SET_VELOCITY_LIMIT ACCEL=5000\nM204 S3000\n"
        n, out = self.run_clamp(src)
        self.assertEqual((n, out), (0, src))

    def test_unknown_limits_change_nothing(self):
        src = "SET_VELOCITY_LIMIT ACCEL=20000\n"
        self.assertEqual(self.run_clamp(src, None, None), (0, src))


class TestPrinterFacts(unittest.TestCase):
    """Facts the config can't say, added by the owner as macro variables."""

    def facts(self, variables=None):
        cfg = klipper_config()
        if variables is not None:
            cfg["gcode_macro _communitycad"] = {"gcode": "", **{f"variable_{k}": v for k, v in variables.items()}}
        return communitycad.printer_from_config(cfg)

    def test_values_are_read_as_klipper_reads_them(self):
        p = self.facts({"bed_surface": '"smooth_pei"', "hotend": '"revo_voron_40w"', "part_cooling": '"stock"'})
        self.assertEqual(p["facts"]["facts"], {"bed_surface": "smooth_pei", "hotend": "revo_voron_40w",
                                               "part_cooling": "stock"})
        self.assertEqual(p["facts"]["missing"], [])
        self.assertEqual((p["bed_surface"], p["bed_surface_assumed"]), ("smooth_pei", False))

    def test_no_macro_offers_the_whole_macro_to_paste(self):
        p = self.facts()
        lines = p["facts"]["add_lines"]
        self.assertTrue(lines.startswith("[gcode_macro _COMMUNITYCAD]"))
        self.assertTrue(lines.rstrip().endswith("gcode:"), "Klipper needs the gcode line")
        for line in lines.splitlines()[2:-1]:
            name, value = line.split("#")[0].split(":", 1)
            self.assertTrue(name.startswith("variable_") and name == name.lower(), "lowercase variable_ names")
            import ast
            ast.literal_eval(value.strip())          # every value is a Python literal, as Klipper requires
        self.assertEqual((p["bed_surface"], p["bed_surface_assumed"]), ("textured_pei", True))

    def test_a_partial_macro_offers_only_the_missing_lines(self):
        p = self.facts({"bed_surface": '"glass"'})
        self.assertEqual(p["facts"]["missing"], ["hotend", "part_cooling"])
        self.assertFalse(p["facts"]["add_lines"].startswith("["), "just the variable lines to add")

    def test_bad_values_are_reported_not_fatal(self):
        p = self.facts({"bed_surface": "textured_pei", "hotend": '"x"'})   # unquoted text
        self.assertTrue(any("put text in quotes" in x for x in p["facts"]["problems"]))
        p = self.facts({"bed_surface": '"lava"'})
        self.assertTrue(any("isn't one of" in x for x in p["facts"]["problems"]))
        self.assertTrue(p["bed_surface_assumed"])


def orca_like_3mf(path, offset=(0.0, -5.0, 3.0)):
    """A two-object project shaped like Orca's: a 20 x 20 x 10 box mesh in its own
    file, used by both objects through components whose transform carries an
    offset (Orca's source offset), placed by build items."""
    verts = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x in (-10, 10) for y in (-10, 10) for z in (-5, 5))
    mesh = ('<?xml version="1.0"?><model><resources><object id="1" type="model"><mesh><vertices>'
            + verts + '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
            '</resources><build/></model>')
    ox, oy, oz = offset
    comp = f"1 0 0 0 1 0 0 0 1 {ox} {oy} {oz}"
    root = ('<?xml version="1.0"?><model xmlns:p="x"><resources>'
            f'<object id="2" type="model"><components><component p:path="/3D/Objects/box.model" objectid="1" transform="{comp}"/></components></object>'
            f'<object id="3" type="model"><components><component p:path="/3D/Objects/box.model" objectid="1" transform="{comp}"/></components></object>'
            '</resources><build>'
            '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 2" printable="1"/>'
            '<item objectid="3" transform="1 0 0 0 1 0 0 0 1 200 100 2" printable="1"/>'
            '</build></model>')
    settings = ('<config><object id="2"><part id="1"><metadata key="source_file" value="box.stl"/></part></object>'
                '<object id="3"><part id="1"><metadata key="source_file" value="box.stl"/></part></object></config>')
    import zipfile
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("3D/3dmodel.model", root)
        z.writestr("3D/Objects/box.model", mesh)
        z.writestr("Metadata/model_settings.config", settings)
        z.writestr("Metadata/project_settings.config", "{}")


# Lay on face: 90 degrees about X, as rows (p' = p . M): (x, y, z) -> (x, -z, y).
TILT_X = [1, 0, 0, 0, 0, 1, 0, -1, 0]


class TestLayerMarkers(unittest.TestCase):
    """Pauses and filament changes, written where and how Orca keeps them."""

    ORCA_COLOUR_CHANGE = ('<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n<plate>\n'
                          '<plate_info id="1"/>\n<layer top_z="6" type="0" extruder="1" color="#00FF00" '
                          'extra="" gcode="M600"/>\n<mode value="SingleExtruder"/>\n</plate>\n'
                          '</custom_gcodes_per_layer>\n')

    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.path = self.dir.joinpath("p.3mf")
        orca_like_3mf(self.path)

    def xml(self):
        import zipfile
        with zipfile.ZipFile(self.path) as z:
            return z.read(communitycad.LAYER_GCODE_FILE).decode() if communitycad.LAYER_GCODE_FILE in z.namelist() else None

    def test_a_pause_and_a_filament_change_round_trip_as_orca_writes_them(self):
        markers = communitycad.clean_layer_markers(
            [{"plate": 1, "z": 2, "kind": "pause"}, {"plate": 1, "z": 4.2, "kind": "filament"}], 250, "M600")
        self.assertEqual(communitycad.write_layer_markers(self.path, markers), 2)
        xml = self.xml()
        self.assertIn('top_z="2" type="1"', xml, "a pause is Orca's type 1")
        self.assertIn('top_z="4.2" type="4" extruder="1" color="" extra="M600"', xml,
                      "a filament change is custom G-code in `extra`, which Orca's CLI runs")
        self.assertEqual([(m["z"], m["kind"], m["gcode"]) for m in communitycad.read_layer_markers(self.path)],
                         [(2.0, "pause", "PAUSE"), (4.2, "filament", "M600")])

    def test_other_layer_gcode_is_kept_and_an_empty_list_removes_ours(self):
        import zipfile
        with zipfile.ZipFile(self.path, "a") as z:
            z.writestr(communitycad.LAYER_GCODE_FILE, self.ORCA_COLOUR_CHANGE)
        communitycad.write_layer_markers(self.path, communitycad.clean_layer_markers(
            [{"plate": 1, "z": 2, "kind": "pause"}], 250, "M600"))
        self.assertIn('type="0"', self.xml(), "Orca's own colour change survives")
        communitycad.write_layer_markers(self.path, [])
        self.assertNotIn('type="1"', self.xml())
        self.assertIn('type="0"', self.xml())

    def test_no_markers_at_all_leaves_no_file(self):
        communitycad.write_layer_markers(self.path, communitycad.clean_layer_markers(
            [{"plate": 1, "z": 2, "kind": "pause"}], 250, None))
        communitycad.write_layer_markers(self.path, [])
        self.assertIsNone(self.xml())

    def test_markers_are_checked(self):
        for bad in ([{"plate": 0, "z": 2, "kind": "pause"}], [{"plate": 1, "z": 0, "kind": "pause"}],
                    [{"plate": 1, "z": 300, "kind": "pause"}], [{"plate": 1, "z": 2, "kind": "eject"}],
                    [{"plate": 1, "kind": "pause"}], "nope", [{"plate": 1, "z": 1, "kind": "pause"}] * 51):
            with self.subTest(bad=str(bad)[:40]), self.assertRaises(ValueError):
                communitycad.clean_layer_markers(bad, 250, "M600")
        same = communitycad.clean_layer_markers([{"plate": 1, "z": 2, "kind": "pause"},
                                                 {"plate": 1, "z": 2.0, "kind": "filament"}], 250, None)
        self.assertEqual([(m["kind"], m["gcode"]) for m in same], [("filament", "PAUSE")],
                         "one per layer; with no M600, a filament change is PAUSE")

    def test_an_xml_bomb_is_not_read(self):
        import zipfile
        with zipfile.ZipFile(self.path, "a") as z:
            z.writestr(communitycad.LAYER_GCODE_FILE, '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>'
                       '<custom_gcodes_per_layer><plate><plate_info id="1"/><layer top_z="2" type="1"/></plate>'
                       '</custom_gcodes_per_layer>')
        self.assertEqual(communitycad.read_layer_markers(self.path), [])


class TestPlainWait(unittest.TestCase):
    """A rate limit says how long in words, not "74335s"."""

    def test_waits_in_words(self):
        self.assertEqual([communitycad.plain_wait(x) for x in (20, 90, 3600, 74335)],
                         ["20 seconds", "2 minutes", "about 1 hour", "about 21 hours"])


class TestPrivateModels(TestShareProfile):
    """Nothing about a private model goes public: no profile share (profiles
    can't be private on CommunityCAD yet), and a post is only ever a draft."""

    def private(self):
        self.comp._visibility_cache = {142: (float("inf"), False)}

    async def test_a_private_models_profile_is_not_shared(self):
        self.private()
        self.finish()
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}))
        self.assertIn("Bracket is private on CommunityCAD", str(ctx.exception))
        self.assertFalse(any(u.endswith("/prints/profiles") for _, u, *_ in self.http.calls), "nothing sent")

    async def test_unknown_visibility_shares_nothing(self):
        self.comp._visibility_cache = {}
        self.http.responses.extend([FakeResponse(503, {"detail": "down"}), FakeResponse(503, {"detail": "down"})])
        self.finish()
        # CommunityCAD down: kept for later, and asked again before it goes.
        result = await self.comp._handle_share_profile(FakeWebRequest({"job_id": "0000A1"}))
        self.assertTrue(result.get("queued"))
        self.assertFalse(any(u.endswith("/prints/profiles") for _, u, *_ in self.http.calls), "nothing sent")

    async def test_a_public_models_visibility_is_asked_once(self):
        self.comp._visibility_cache = {}
        self.http.responses.append(FakeResponse(200, {"id": 142, "visibility": "public"}))
        self.assertTrue(await self.comp._model_public(142))
        self.assertTrue(await self.comp._model_public(142))
        self.assertEqual(len(self.http.calls), 1)


class TestGcodeMaterials(unittest.TestCase):
    """The confirm names what a file was sliced for."""

    def test_names_then_types_one_each(self):
        m = communitycad.gcode_materials
        self.assertEqual(m({"filament_settings_id": '"Generic ABS"', "filament_type": "ABS"}), ["Generic ABS"])
        self.assertEqual(m({"filament_type": "PLA;PLA;PETG"}), ["PLA", "PETG"])
        self.assertEqual(m({}), [])


class TestSlicedFor(unittest.TestCase):
    """What a G-code file was sliced for. A Bambu Studio file for an X1 Carbon
    passed as "no problems found" on a Voron, because only height and nozzle were
    compared. These are the real header lines of that file and of the plugin's own."""

    BAMBU = ("; HEADER_BLOCK_START\n; BambuStudio 01.08.02.56\n; HEADER_BLOCK_END\n; CONFIG_BLOCK_START\n"
             "; gcode_flavor = marlin\n; printable_area = 0x0,256x0,256x256,0x256\n"
             "; printer_model = Bambu Lab X1 Carbon\n"
             "; printer_settings_id = Bambu Lab X1 Carbon 0.4 nozzle - UNIVERSAL MARKER\n; CONFIG_BLOCK_END\n"
             "M1002 gcode_claim_action : 2\nG28\nM620 S0A\nG1 X10 Y10\n")
    OWN = ("; generated by OrcaSlicer 2.4.2\nG28\nG1 X10 Y10\n; CONFIG_BLOCK_START\n; gcode_flavor = klipper\n"
           "; printable_area = 0x0,350x0,350x350,0x350\n; printer_model = \n"
           "; printer_settings_id = CommunityCAD printer\n; CONFIG_BLOCK_END\n")
    VOLUME = {"x": 350, "y": 350, "z": 250}

    def header(self, text):
        d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        f = d.joinpath("f.gcode")
        f.write_text(text)
        return communitycad.read_gcode_header(f)

    def statuses(self, text, name="Voron Trident 350", volume=VOLUME):
        return {c: (st, detail) for c, st, detail in communitycad.header_checks(self.header(text), name, volume)}

    def test_a_bambu_file_warns_on_printer_and_firmware(self):
        r = self.statuses(self.BAMBU)
        self.assertEqual(r["printer"][0], "warn")
        self.assertIn("Bambu Lab X1 Carbon; this printer is a Voron Trident 350", r["printer"][1])
        self.assertEqual(r["firmware"][0], "warn")
        self.assertIn("M1002", r["firmware"][1])
        self.assertEqual(r["bed"][0], "ok", "256 x 256 fits inside 350 x 350")

    def test_the_plugins_own_slices_pass(self):
        r = self.statuses(self.OWN)
        self.assertEqual((r["printer"][0], r["bed"][0]), ("ok", "ok"))
        self.assertNotIn("firmware", r)

    def test_a_bigger_bed_warns(self):
        r = self.statuses(self.OWN.replace("350x0,350x350,0x350", "400x0,400x400,0x400"), volume={"x": 300, "y": 300})
        self.assertEqual(r["bed"][0], "warn")
        self.assertIn("400 × 400 mm bed, bigger than this printer's 300 × 300", r["bed"][1])

    def test_same_printer_passes_and_another_voron_warns(self):
        same = self.OWN.replace("CommunityCAD printer", "Voron Trident 350 0.4 nozzle")
        self.assertEqual(self.statuses(same)["printer"][0], "ok")
        other = self.OWN.replace("CommunityCAD printer", "Voron 2.4 350 0.4 nozzle")
        self.assertEqual(self.statuses(other)["printer"][0], "warn")

    def test_unknown_printer_or_silent_file(self):
        self.assertEqual(self.statuses(self.BAMBU, name=None)["printer"][0], "unknown")
        silent = "G28\nG1 X10 Y10\n"
        self.assertEqual(self.statuses(silent), {}, "a file that names nothing adds no line")

    def test_prusaslicer_bed_shape(self):
        self.assertEqual(communitycad.bed_from_header({"bed_shape": "0x0,250x0,250x210,0x210"}), (250.0, 210.0))


class TestPlacement(unittest.TestCase):
    """Placements are build-item transforms, always dropped onto the bed."""

    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.path = self.dir.joinpath("p.3mf")
        orca_like_3mf(self.path)

    def items(self):
        import zipfile
        with zipfile.ZipFile(self.path) as z:
            return communitycad.project_items(z.read("3D/3dmodel.model").decode())

    def test_only_turns_and_moves_are_placements(self):
        self.assertTrue(communitycad.is_rotation([0, 1, 0, -1, 0, 0, 0, 0, 1, 5, 6, 7]))
        self.assertTrue(communitycad.is_rotation(TILT_X + [0, 0, 0]))
        for bad in ([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0],      # scaled
                    [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],     # mirrored
                    [1, 0, 0, 0, 1, 0, 0, 0, float("nan"), 0, 0, 0], [1, 0, 0]):
            self.assertFalse(communitycad.is_rotation(bad), bad)

    def test_a_tilt_counts_the_offset_the_tilt_turns_into_height(self):
        # The box spans y -15..5 in object space (its offset is -5). Tilted, that y
        # becomes height, -15..5, so it must be raised by 15: ignoring the offset
        # gives 10 and leaves it sunk 5 mm, which crashes Orca's CLI.
        written = communitycad.place_in_3mf(self.path, {("2", 0): TILT_X + [100, 100, 0]})
        self.assertAlmostEqual(written[("2", 0)][11], 15.0)
        self.assertAlmostEqual(self.items()[("2", 0)][11], 15.0)
        self.assertEqual(self.items()[("3", 0)][9:12], [200, 100, 2], "other models untouched")

    def test_a_move_keeps_the_model_on_the_bed(self):
        communitycad.place_in_3mf(self.path, {("3", 0): [1, 0, 0, 0, 1, 0, 0, 0, 1, 50, 60, 40]})
        self.assertEqual(self.items()[("3", 0)], [1, 0, 0, 0, 1, 0, 0, 0, 1, 50, 60, 2.0])

    def test_unknown_models_and_scaling_are_refused_and_change_nothing(self):
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            communitycad.place_in_3mf(self.path, {("9", 0): TILT_X + [0, 0, 0]})
        with self.assertRaises(ValueError):
            communitycad.place_in_3mf(self.path, {("2", 0): [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]})
        self.assertEqual(self.path.read_bytes(), before)

    def test_a_rebuild_turns_every_copy_of_a_tilted_model_back(self):
        turned = communitycad.reapply_orientations(self.path, {"box.stl": TILT_X})
        self.assertEqual(turned, 2)
        for key in (("2", 0), ("3", 0)):
            self.assertEqual(self.items()[key][:9], TILT_X)
            self.assertAlmostEqual(self.items()[key][11], 15.0)


class TestSpacing(unittest.TestCase):
    """With a spacing chosen, the plugin packs the plate (Orca's CLI can't)."""

    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.path = self.dir.joinpath("p.3mf")
        orca_like_3mf(self.path)

    def footprints(self):
        import zipfile
        with zipfile.ZipFile(self.path) as z:
            root = z.read("3D/3dmodel.model").decode()
            settings = z.read("Metadata/model_settings.config").decode()
            out = {}
            for key, t in communitycad.project_items(root).items():
                pts = communitycad.object_points(z, "3D/3dmodel.model", key[0])
                xs = [p[0] + t[9] for p in pts]
                ys = [p[1] + t[10] for p in pts]
                zs = [p[2] + t[11] for p in pts]
                out[key[0]] = (min(xs), max(xs), min(ys), max(ys), min(zs))
        return out, settings

    def test_models_are_the_chosen_gap_apart_and_on_the_bed(self):
        plates = communitycad.pack_3mf(self.path, (100, 100), 12.0)
        f, settings = self.footprints()
        self.assertEqual(plates, 1)
        a, b = sorted(f.values(), key=lambda v: (v[0], v[2]))
        gap = max(b[0] - a[1], b[2] - a[3])
        self.assertAlmostEqual(gap, 12.0, places=4, msg="the gap between footprints")
        self.assertAlmostEqual(a[4], 0.0, places=6)
        self.assertTrue(all(0 <= v[0] and v[1] <= 100 and 0 <= v[2] and v[3] <= 100 for v in f.values()))
        self.assertEqual(settings.count("<plate>"), 1)

    def test_what_doesnt_fit_goes_to_the_next_plate_on_orcas_grid(self):
        plates = communitycad.pack_3mf(self.path, (40, 40), 10.0)
        f, settings = self.footprints()
        self.assertEqual(plates, 2)
        self.assertEqual(settings.count("<plate>"), 2)
        self.assertIn('plater_id" value="2"', settings)
        xs = sorted(v[0] for v in f.values())
        self.assertAlmostEqual(xs[1] - xs[0], 48.0, places=4, msg="plate 2 is 1.2 beds along, the same spot")

    def test_the_gap_is_between_models_and_brims_only_widen_it_to_not_overlap(self):
        communitycad.pack_3mf(self.path, (100, 100), 30.0, brim=5.0)
        f, _ = self.footprints()
        a, b = sorted(f.values(), key=lambda v: (v[0], v[2]))
        self.assertAlmostEqual(max(b[0] - a[1], b[2] - a[3]), 30.0, places=4, msg="30 mm between the models")
        communitycad.pack_3mf(self.path, (100, 100), 0.0, brim=5.0, margin=8.0)
        f, _ = self.footprints()
        a, b = sorted(f.values(), key=lambda v: (v[0], v[2]))
        self.assertAlmostEqual(max(b[0] - a[1], b[2] - a[3]), 10.0, places=4, msg="two 5 mm brims touch")
        self.assertGreaterEqual(min(v[0] for v in f.values()), 8.0 + 5.0 - 1e-6, "edge clear of the brim")

    def test_many_models_group_in_a_square_in_the_middle_not_a_line(self):
        spots = communitycad.compact_pack([(30, 30)] * 9, 370, 370)
        xs = sorted({round(s[1]) for s in spots})
        ys = sorted({round(s[2]) for s in spots})
        self.assertEqual((len(xs), len(ys)), (3, 3), "a 3 x 3 group, as Orca would pack nine squares")
        self.assertEqual({s[0] for s in spots}, {0})
        self.assertEqual((spots[0][3], spots[0][4]), (90, 90), "the group's size, centred by pack_3mf")

    def test_small_models_fill_in_beside_a_big_one(self):
        spots = communitycad.compact_pack([(100, 100)] + [(30, 30)] * 4, 370, 370)
        gw, gd = spots[0][3], spots[0][4]
        self.assertLessEqual(max(gw, gd), 130, "around the big part, not in a row of their own")
        boxes = [(x, y, x + w, y + d) for (_, x, y, *_), (w, d) in zip(spots, [(100, 100)] + [(30, 30)] * 4)]
        for a in range(len(boxes)):
            for b in range(a + 1, len(boxes)):
                A, B = boxes[a], boxes[b]
                self.assertFalse(A[0] < B[2] and B[0] < A[2] and A[1] < B[3] and B[1] < A[3], "no overlaps")

    def test_a_model_too_big_for_the_bed_is_refused_and_nothing_changes(self):
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            communitycad.pack_3mf(self.path, (15, 15), 10.0)   # a 20 mm model
        self.assertEqual(self.path.read_bytes(), before)


MY_PROFILES = """# my tuned profiles
[profile My PETG strong]
inherits: 0.20mm Standard @Voron
wall_loops: 5
outer_wall_speed = 120
default_acceleration: 20000
post_process: /usr/bin/evil
machine_gcode: G28
"""


class TestProfilesFile(unittest.TestCase):
    """print_profiles.cfg: Orca process presets, the user's own."""

    def test_any_process_setting_but_post_process_and_non_process_keys(self):
        profiles, problems = communitycad.parse_profiles(MY_PROFILES)
        p = profiles["My PETG strong"]
        self.assertEqual(p["inherits"], "0.20mm Standard @Voron")
        self.assertEqual(p["values"], {"wall_loops": "5", "outer_wall_speed": "120", "default_acceleration": "20000"})
        self.assertTrue(any("post_process can't be set here" in x for x in problems))
        self.assertTrue(any("machine_gcode isn't an OrcaSlicer process setting" in x for x in problems))

    def test_format_and_replace_keep_every_other_byte(self):
        text = MY_PROFILES + "\n[profile Other]\ninherits: 0.12mm Fine @Voron\n"
        block = communitycad.format_profile("My PETG strong", "0.20mm Standard @Voron", {"wall_loops": "6"})
        new = communitycad.replace_section(text, "profile", "My PETG strong", block)
        self.assertTrue(new.startswith("# my tuned profiles\n"))
        self.assertIn("[profile Other]\ninherits: 0.12mm Fine @Voron", new)
        self.assertEqual(communitycad.parse_profiles(new)[0]["My PETG strong"]["values"], {"wall_loops": "6"})


@unittest.skipUnless(ORCA_RESOURCES.is_dir(), "needs OrcaSlicer's presets (scripts/install-orca.sh)")
class TestProfilesWithOrca(unittest.TestCase):
    def setUp(self):
        self.profiles = communitycad.OrcaProfiles(ORCA_RESOURCES.joinpath("profiles"))

    def test_defaults_are_orcas_own_presets_for_this_printer(self):
        self.assertEqual(communitycad.default_profiles(self.profiles, "Voron Trident 350", 0.4),
                         ["0.08mm Extra Fine @Voron", "0.12mm Fine @Voron", "0.15mm Optimal @Voron",
                          "0.20mm Standard @Voron", "0.24mm Draft @Voron", "0.28mm Extra Draft @Voron"])
        self.assertEqual(communitycad.default_profiles(self.profiles, None, 0.4),
                         ["0.12mm Fine @Voron", "0.20mm Standard @Voron", "0.24mm Draft @Voron"])

    def test_a_custom_profile_is_used_as_written_capped_only_by_printer_cfg(self):
        custom, _ = communitycad.parse_profiles(MY_PROFILES)
        pla = {"name": "PLA", "inherits": "Generic PLA @System", "values": {}}
        printer = {"max_accel": 6000, "max_velocity": 300}
        p = communitycad.slice_presets(self.profiles, {"x": 350, "y": 350, "z": 250}, 0.4, pla,
                                       custom["My PETG strong"], {"skirt_loops": "2"}, printer)["process"]
        self.assertEqual(p["wall_loops"], "5")
        self.assertEqual(p["outer_wall_speed"], "120")
        self.assertEqual(p["skirt_loops"], "2", "the project's own change on top")
        self.assertLessEqual(float(p["default_acceleration"]), 6000, "printer.cfg's max_accel still caps it")
        self.assertNotEqual(p.get("post_process"), "/usr/bin/evil")


class TestBedFiles(unittest.TestCase):
    """The bed Orca draws for a printer, from its machine_model file, and nothing else."""

    def make(self, model_json):
        root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        vendor = root.joinpath("Acme")
        vendor.joinpath("machine").mkdir(parents=True)
        root.joinpath("Acme.json").write_text(json.dumps({"machine_model_list": [
            {"name": "Acme 300", "sub_path": "machine/Acme 300.json"}]}))
        vendor.joinpath("machine", "Acme 300.json").write_text(json.dumps({"type": "machine_model", **model_json}))
        vendor.joinpath("plate.stl").write_bytes(b"solid")
        vendor.joinpath("logo.svg").write_text("<svg/>")
        root.joinpath("secret.stl").write_bytes(b"x")
        return communitycad.OrcaProfiles(root), vendor

    def test_the_models_bed_and_texture_are_found(self):
        profiles, vendor = self.make({"bed_model": "plate.stl", "bed_texture": "logo.svg"})
        self.assertEqual(profiles.bed_files("Acme 300"),
                         {"model": vendor.joinpath("plate.stl"), "texture": vendor.joinpath("logo.svg")})
        self.assertEqual(profiles.bed_files("Unknown"), {"model": None, "texture": None})

    def test_names_outside_the_vendor_folder_or_of_other_types_are_ignored(self):
        profiles, _ = self.make({"bed_model": "../secret.stl", "bed_texture": "plate.stl"})
        self.assertEqual(profiles.bed_files("Acme 300"), {"model": None, "texture": None})


@unittest.skipUnless(ORCA_RESOURCES.is_dir(), "needs OrcaSlicer's presets (scripts/install-orca.sh)")
class TestSliceForThisPrinter(unittest.TestCase):
    def test_a_recognised_printer_starts_from_orcas_preset_for_it(self):
        profiles = communitycad.OrcaProfiles(ORCA_RESOURCES.joinpath("profiles"))
        settings = json.loads(FIXTURES.joinpath("printer-trident350.json").read_text())
        printer = communitycad.printer_from_config(settings, "")
        pla = {"name": "PLA", "inherits": "Generic PLA @System", "values": {"filament_wipe": "1"}}
        p = communitycad.slice_presets(profiles, {"x": 350, "y": 350, "z": 250}, 0.4, pla,
                                       "standard", {}, printer)
        self.assertEqual(p["machine"]["machine_max_acceleration_x"], ["6000", "6000"])
        self.assertTrue(p["machine"]["machine_start_gcode"].startswith("PRINT_START"))
        self.assertEqual(p["filament"]["filament_wipe"], ["nil"],
                         "a material's wipe can't fight firmware retraction")
        self.assertEqual(p["process"]["curr_bed_type"], "Textured PEI Plate", "assumed until the owner says")
        settings["gcode_macro _communitycad"] = {"gcode": "", "variable_bed_surface": '"smooth_pei"'}
        smooth = communitycad.slice_presets(profiles, {"x": 350, "y": 350, "z": 250}, 0.4, pla, "standard",
                                            {}, communitycad.printer_from_config(settings, ""))
        self.assertEqual(smooth["process"]["curr_bed_type"], "High Temp Plate")
        self.assertTrue(all(float(p["process"][k][0] if isinstance(p["process"][k], list) else p["process"][k]) <= 6000
                            for k in communitycad.PROCESS_ACCELERATIONS if k in p["process"]))


@unittest.skipUnless(ORCA_RESOURCES.is_dir(), "needs OrcaSlicer's presets (scripts/install-orca.sh)")
class TestProjects(_SlicingCase):
    """Projects: Orca 3MF projects in printer_data/projects."""

    def setUp(self):
        super().setUp()
        self.comp._settings["permissions"] = {"printer_settings": True, "print_history": True}
        self.comp._models_dir.joinpath("bolt.stl").write_bytes(b"solid b")
        os.environ["FAKE_ORCA_MODE"] = "ok"
        os.environ.pop("FAKE_PLATES", None)

    def tearDown(self):
        os.environ.pop("FAKE_PLATES", None)
        super().tearDown()

    async def create(self, models, **extra):
        return await self.comp._handle_project_create(FakeWebRequest({"models": models, **extra}, method="POST"))

    async def test_slice_on_one_model_makes_a_new_project_named_after_it(self):
        p = (await self.create([{"model": "bracket.stl"}]))["project"]
        self.assertEqual((p["filename"], p["origin"]), ("bracket.3mf", "models"))
        self.assertTrue(self.comp._projects_dir.joinpath("bracket.3mf").is_file())
        again = (await self.create([{"model": "bracket.stl"}]))["project"]
        self.assertEqual(again["filename"], "bracket-2.3mf", "always a new project, never replaced")

    async def test_several_models_share_one_project_and_copies_reach_orca(self):
        calls = []
        real = communitycad.asyncio.create_subprocess_exec

        async def spy(*argv, **kw):
            calls.append(argv)
            return await real(*argv, **kw)

        communitycad.asyncio.create_subprocess_exec = spy
        try:
            p = (await self.create([{"model": "bracket.stl", "copies": 3}, {"model": "bolt.stl"}]))["project"]
        finally:
            communitycad.asyncio.create_subprocess_exec = real
        self.assertEqual(p["filename"], "bracket + 1 more.3mf")
        self.assertEqual(p["sources"], [{"model": "bracket.stl", "copies": 3}, {"model": "bolt.stl", "copies": 1}])
        argv = calls[-1]
        self.assertEqual(argv[argv.index("--clone-objects") + 1], "3,1")
        self.assertIn("--export-3mf", argv)
        self.assertNotIn("--slice", argv, "making a project slices nothing")

    async def test_bad_models_and_copies_are_refused(self):
        for models in ([], [{"model": "../x.stl"}], [{"model": "bracket.stl", "copies": 0}],
                       [{"model": "bracket.stl", "copies": 51}], [{"model": "nope.stl"}]):
            with self.subTest(models=models), self.assertRaises(Exception):
                await self.create(models)

    async def test_no_project_is_made_while_printing(self):
        self.server.components["klippy_apis"] = FakeKlippyPrint(state="printing")
        with self.assertRaises(Exception) as ctx:
            await self.create([{"model": "bracket.stl"}])
        self.assertIn("printing", str(ctx.exception))
        self.assertFalse(self.comp._projects_dir.joinpath("bracket.3mf").exists())

    async def test_every_plate_becomes_its_own_file(self):
        await self.create([{"model": "bracket.stl"}])
        os.environ["FAKE_PLATES"] = "2"
        entry = self.comp._project_entry("bracket.3mf")
        job = {"id": "p1", "model": "bracket.3mf", "state": "slicing", "_t0": 0.0,
               "options": {"material": "PLA", "quality": "standard", "process": {}},
               "_material": {"name": "PLA", "inherits": "Generic PLA @System", "values": {}}}
        await self.comp._run_slice(job, {**entry, "_source": str(self.comp._projects_dir / "bracket.3mf"),
                                         "_own": True, "_project": "bracket.3mf", "_name": "bracket"},
                                   {"x": 350, "y": 350, "z": 250}, 0.4)
        self.assertEqual(job["state"], "done", job.get("error"))
        self.assertEqual([p["plate"] for p in job["plates"]], [1, 2])
        self.assertIsNone(self.comp._project_entry("bracket.3mf").get("last_slice"), "nothing sent yet")
        sent = [(await self.send(job, plate=n))["gcode"] for n in (1, 2)]
        self.assertEqual(sent, ["communitycad/bracket-plate1_PLA_0.20mm.gcode",
                                "communitycad/bracket-plate2_PLA_0.20mm.gcode"])
        self.assertEqual(self.comp._project_entry("bracket.3mf")["last_slice"]["gcodes"], sent)

    async def test_a_finished_print_is_recorded_on_its_project_only_with_permission(self):
        await self.create([{"model": "bracket.stl"}])
        self.comp._project_sliced("bracket.3mf", {}, ["communitycad/b_PLA.gcode"])
        event = {"action": "finished", "job": {"filename": "communitycad/b_PLA.gcode",
                                               "status": "completed", "end_time": 5, "print_duration": 600}}
        self.comp._settings["permissions"] = {"printer_settings": True, "print_history": False}
        self.comp._on_history_changed(event)
        self.assertIsNone(self.comp._project_entry("bracket.3mf").get("prints"))
        self.comp._settings["permissions"]["print_history"] = True
        self.comp._on_history_changed(event)
        self.assertEqual(self.comp._project_entry("bracket.3mf")["prints"][0]["status"], "completed")

    async def test_the_match_check_runs_for_files_in_the_gcode_folder_only(self):
        pathlib.Path(self.fm.gcodes, "communitycad").mkdir(parents=True, exist_ok=True)
        pathlib.Path(self.fm.gcodes, "communitycad", "a.gcode").write_text("G28\n")
        self.server.components["file_manager"].get_metadata_storage = lambda: FakeMetadataStorage({})
        ok = await self.comp._handle_match(FakeWebRequest({"filename": "communitycad/a.gcode"}))
        self.assertIn("checks", ok["match"])
        for bad in ("../../etc/passwd", "communitycad/nope.gcode", "/etc/passwd"):
            with self.subTest(bad=bad), self.assertRaises(Exception):
                await self.comp._handle_match(FakeWebRequest({"filename": bad}))

    async def test_placing_tilts_remembers_the_face_and_marks_the_slice_stale(self):
        await self.create([{"model": "bracket.stl"}])
        orca_like_3mf(self.comp._projects_dir.joinpath("bracket.3mf"))
        self.comp._project_sliced("bracket.3mf", {"material": "PLA"}, ["communitycad/b.gcode"])
        r = await self.comp._handle_project_place(FakeWebRequest({"project": "bracket.3mf", "changes": [
            {"object": 2, "instance": 0, "transform": TILT_X + [100, 100, 0]}]}, method="POST"))
        self.assertEqual(r["project"]["orientations"], {"box.stl": TILT_X})
        self.assertTrue(r["project"]["last_slice"]["stale"])
        r = await self.comp._handle_project_place(FakeWebRequest({"project": "bracket.3mf", "changes": [
            {"object": 2, "instance": 0, "transform": [1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 100, 0]}]}, method="POST"))
        self.assertEqual(r["project"]["orientations"], {}, "back on its usual face: nothing to remember")
        with self.assertRaises(Exception):
            await self.comp._handle_project_place(FakeWebRequest({"project": "bracket.3mf", "changes": [
                {"object": 2, "transform": [3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0]}]}, method="POST"))

    async def test_spacing_is_checked_and_remembered(self):
        await self.create([{"model": "bracket.stl"}])
        r = await self.comp._handle_project_update(FakeWebRequest(
            {"project": "bracket.3mf", "spacing": "6"}, method="POST"))
        self.assertEqual(r["project"]["spacing"], 6.0)
        r = await self.comp._handle_project_update(FakeWebRequest({"project": "bracket.3mf"}, method="POST"))
        self.assertEqual(r["project"]["spacing"], 6.0, "kept when not sent")
        r = await self.comp._handle_project_update(FakeWebRequest(
            {"project": "bracket.3mf", "spacing": ""}, method="POST"))
        self.assertIsNone(r["project"]["spacing"], "empty: Orca's own arrange")
        for bad in ("-1", "101", "lots"):
            with self.subTest(bad=bad), self.assertRaises(Exception):
                await self.comp._handle_project_update(FakeWebRequest(
                    {"project": "bracket.3mf", "spacing": bad}, method="POST"))

    async def test_a_thumbnail_is_kept_in_thumbs_and_follows_the_project(self):
        import base64
        await self.create([{"model": "bracket.stl"}])
        png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 100).decode()
        r = await self.comp._handle_project_thumbnail(FakeWebRequest({"project": "bracket.3mf", "png": png}, method="POST"))
        thumb = r["project"]["thumbnail"]
        self.assertTrue(thumb["url"].startswith("/server/files/projects/.thumbs/bracket.png?v="))
        self.assertFalse(thumb["stale"])
        names = [p["filename"] for p in (await self.comp._handle_projects(FakeWebRequest({})))["projects"]]
        self.assertEqual(names, ["bracket.3mf"], ".thumbs isn't a project")
        self.comp._save_project_meta("bracket.3mf", {"options": {"material": "PLA"}})
        self.assertTrue(self.comp._project_entry("bracket.3mf")["thumbnail"]["stale"], "changed since")
        r = await self.comp._handle_project_update(FakeWebRequest({"project": "bracket.3mf", "rename": "Shelf"}, method="POST"))
        self.assertIn("/.thumbs/Shelf.png", r["project"]["thumbnail"]["url"])
        await self.comp._handle_project_delete(FakeWebRequest({"project": "Shelf.3mf"}, method="POST"))
        self.assertEqual(list(self.comp._projects_dir.joinpath(".thumbs").iterdir()), [])
        for bad in ("bm90IGEgcG5n", "", base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * (600 << 10)).decode()):
            await self.create([{"model": "bracket.stl"}])
            with self.subTest(size=len(bad)), self.assertRaises(Exception):
                await self.comp._handle_project_thumbnail(FakeWebRequest({"project": "bracket.3mf", "png": bad}, method="POST"))

    async def test_an_old_projects_choices_are_shown_as_overrides(self):
        await self.create([{"model": "bracket.stl"}])
        self.comp._save_project_meta("bracket.3mf", {"options": {
            "material": "PLA", "quality": "fine", "infill": 20, "supports": False, "brim": True}})
        options = self.comp._project_entry("bracket.3mf")["options"]
        self.assertEqual(options, {"material": "PLA", "profile": "0.12mm Fine @Voron", "process": {
            "sparse_infill_density": "20%", "enable_support": "0", "support_type": "tree(auto)",
            "brim_type": "auto_brim"}})

    async def test_rearranging_marks_the_last_slice_stale_but_keeps_it(self):
        await self.create([{"model": "bracket.stl"}])
        self.comp._project_sliced("bracket.3mf", {"material": "PLA"}, ["communitycad/bracket_PLA_0.20mm.gcode"])
        r = await self.comp._handle_project_update(FakeWebRequest(
            {"project": "bracket.3mf", "models": [{"model": "bracket.stl", "copies": 2}]}, method="POST"))
        self.assertTrue(r["project"]["last_slice"]["stale"])
        self.assertEqual(r["project"]["last_slice"]["gcodes"], ["communitycad/bracket_PLA_0.20mm.gcode"])

    async def test_rename_and_delete(self):
        await self.create([{"model": "bracket.stl"}])
        r = await self.comp._handle_project_update(FakeWebRequest(
            {"project": "bracket.3mf", "rename": "Shelf brackets"}, method="POST"))
        self.assertEqual(r["project"]["filename"], "Shelf brackets.3mf")
        await self.comp._handle_project_delete(FakeWebRequest({"project": "Shelf brackets.3mf"}, method="POST"))
        self.assertEqual((await self.comp._handle_projects(FakeWebRequest({})))["projects"], [])


class TestTransientRetries(ComponentTestCase):
    """Reads survive the API's occasional 500 (about 1 in 20 searches, 2026-09-30)."""

    def setUp(self):
        super().setUp()
        self.slept = []

        async def no_sleep(delay):
            self.slept.append(delay)

        self._real_sleep = communitycad.asyncio.sleep
        communitycad.asyncio.sleep = no_sleep

    def tearDown(self):
        communitycad.asyncio.sleep = self._real_sleep
        super().tearDown()

    async def test_a_read_that_fails_once_succeeds_on_retry(self):
        self.http.responses += [FakeResponse(500, {}), FakeResponse(200, {"items": [], "total": 0})]
        result = await self.comp._api("GET", "/catalog/search")
        self.assertEqual(result["total"], 0)
        self.assertEqual(len(self.http.calls), 2)
        self.assertEqual(self.slept, [0.3])

    async def test_a_read_gives_up_after_two_retries(self):
        self.http.responses += [FakeResponse(503, {})] * 3
        with self.assertRaises(communitycad.CommunityCADError):
            await self.comp._api("GET", "/catalog/search")
        self.assertEqual(len(self.http.calls), 3)

    async def test_a_write_is_never_retried(self):
        # A retried download-url could spend a second download.
        self.http.responses += [FakeResponse(500, {}), FakeResponse(200, {"url": "x"})]
        with self.assertRaises(communitycad.CommunityCADError):
            await self.comp._api("POST", "/catalog/models/5/files/8/download-url", body={})
        self.assertEqual(len(self.http.calls), 1)

    async def test_a_client_error_is_not_retried(self):
        self.http.responses += [FakeResponse(404, {"detail": "Model not found"})]
        with self.assertRaises(communitycad.CommunityCADError):
            await self.comp._api("GET", "/catalog/models/1")
        self.assertEqual(len(self.http.calls), 1)


class TestFileTypeFilter(ComponentTestCase):
    """Filter by file type on the Pi until the API can."""

    def catalog(self, n, types_for):
        """A fake /catalog/search over n models, answering by offset and limit."""
        models = [{"id": i, "title": f"m{i}", "printable_types": types_for(i)} for i in range(n)]
        self.searches = []

        async def request(method, url, body=None, headers=None, **kwargs):
            from urllib.parse import parse_qs, urlparse
            q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
            self.searches.append(q)
            off, lim = int(q.get("offset", 0)), int(q.get("limit", 20))
            return FakeResponse(200, {"items": models[off:off + lim], "total": n,
                                      "limit": lim, "offset": off})

        self.http.request = request

    async def search(self, **args):
        return await self.comp._handle_search(FakeWebRequest(args))

    async def test_only_models_with_that_type_come_back(self):
        # Every 7th model has a 3MF: rare, and spread across several API pages.
        self.catalog(120, lambda i: ["stl", "3mf"] if i % 7 == 0 else ["stl"])
        result = await self.search(types="3mf", limit=50)
        self.assertEqual([m["id"] for m in result["items"]], list(range(0, 120, 7)))
        self.assertEqual(result["total"], 18)
        self.assertFalse(result["truncated"])

    async def test_the_filtered_list_is_paged_by_the_pi(self):
        self.catalog(120, lambda i: ["gcode"] if i % 2 else ["stl"])
        page2 = await self.search(types="gcode", limit=10, offset=10)
        self.assertEqual([m["id"] for m in page2["items"]], list(range(21, 41, 2)))
        self.assertEqual((page2["total"], page2["offset"], page2["limit"]), (60, 10, 10))

    async def test_several_types_match_any_of_them(self):
        self.catalog(10, lambda i: ["obj"] if i == 3 else ["stl"] if i == 5 else [])
        result = await self.search(types="obj,stl")
        self.assertEqual([m["id"] for m in result["items"]], [3, 5])

    async def test_the_scan_is_cached_so_changing_the_filter_is_free(self):
        self.catalog(120, lambda i: ["stl"])
        await self.search(types="stl")
        scanned = len(self.searches)
        self.assertEqual(scanned, 3, "120 models at 50 a page")
        await self.search(types="3mf")
        await self.search(types="stl", offset=20)
        self.assertEqual(len(self.searches), scanned, "same query: no new requests")
        await self.search(types="stl", q="bracket")
        self.assertGreater(len(self.searches), scanned, "a new query scans again")

    async def test_the_scan_stays_within_the_apis_offset_limit(self):
        self.catalog(3000, lambda i: ["stl"])
        result = await self.search(types="stl")
        self.assertTrue(result["truncated"])
        self.assertLessEqual(max(int(q["offset"]) for q in self.searches), 1000)
        self.assertTrue(all(int(q["limit"]) <= 50 for q in self.searches))

    async def test_an_unknown_type_is_refused(self):
        self.catalog(1, lambda i: [])
        with self.assertRaises(Exception) as ctx:
            await self.search(types="exe")
        self.assertIn("Unknown file type", str(ctx.exception))
        self.assertEqual(self.searches, [])

    async def test_no_filter_is_one_plain_request_as_before(self):
        self.catalog(120, lambda i: ["stl"])
        result = await self.search(limit=20)
        self.assertEqual(len(self.searches), 1)
        self.assertNotIn("truncated", result)

    async def test_the_chosen_type_is_kept_per_printer(self):
        result = await self.comp._handle_settings(
            FakeWebRequest({"file_type": "3mf"}, method="POST"))
        self.assertEqual(result["file_type"], "3mf")
        with self.assertRaises(Exception):
            await self.comp._handle_settings(FakeWebRequest({"file_type": "exe"}, method="POST"))
        self.assertEqual(self.comp._file_type(), "3mf")


class TestSendFolder(ComponentTestCase):
    """The sending folder can only ever point inside the G-code files."""

    def test_clean_values_are_kept_and_tidied(self):
        clean = communitycad.clean_send_folder
        self.assertEqual(clean("communitycad"), "communitycad")
        self.assertEqual(clean(" /prints/voron/ "), "prints/voron")
        self.assertEqual(clean(""), "", "empty means the top of the G-code files")
        self.assertEqual(clean("a//b"), "a/b")

    def test_anything_that_could_escape_is_refused(self):
        for bad in ("..", "a/../b", "../../config", ".hidden", "a/./b",
                    "a/b/c/d", "con;rm -rf", "x" * 70, 5):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                communitycad.clean_send_folder(bad)

    async def test_the_endpoint_saves_a_good_folder_and_refuses_a_bad_one(self):
        result = await self.comp._handle_settings(
            FakeWebRequest({"send_folder": "prints/voron"}, method="POST"))
        self.assertEqual(result["send_folder"], "prints/voron")
        with self.assertRaises(Exception):
            await self.comp._handle_settings(
                FakeWebRequest({"send_folder": "../config"}, method="POST"))
        self.assertEqual(self.comp._send_folder(), "prints/voron", "a refused value changes nothing")

    def test_a_tampered_settings_file_falls_back_to_the_default(self):
        self.comp._settings["send_folder"] = "../../config"
        self.assertEqual(self.comp._send_folder(), communitycad.DEFAULT_SEND_FOLDER)


class TestExtractPlates(unittest.TestCase):
    """Opening a stranger's zip on the printer's own Pi: bounded on every axis."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self._tmp.name)
        self.free = 10 << 30

    def tearDown(self):
        self._tmp.cleanup()

    def leftovers(self):
        return sorted(p.name for p in self.dir.glob("*.part"))

    def test_plates_come_out_in_order_with_their_contents(self):
        a = make_3mf(self.dir / "a.gcode.3mf", {2: b"G1 X2", 1: b"G1 X1", 10: b"G1 X10"})
        plates = communitycad.extract_plates(a, self.dir, self.free)
        self.assertEqual([n for n, _, _ in plates], [1, 2, 10])
        self.assertEqual(plates[0][1].read_bytes(), b"G1 X1")
        self.assertEqual(plates[2][2], len(b"G1 X10"))

    def test_a_matching_checksum_passes_and_a_wrong_one_leaves_nothing(self):
        ok = make_3mf(self.dir / "ok.gcode.3mf", {1: b"G1 X1"}, md5={})
        self.assertEqual(len(communitycad.extract_plates(ok, self.dir, self.free)), 1)
        for p in self.dir.glob("*.part"):
            p.unlink()
        bad = make_3mf(self.dir / "bad.gcode.3mf", {1: b"G1 X1", 2: b"G1 X2"},
                       md5={2: "0" * 32})
        with self.assertRaises(communitycad.PlateError) as ctx:
            communitycad.extract_plates(bad, self.dir, self.free)
        self.assertIn("checksum", str(ctx.exception))
        self.assertEqual(self.leftovers(), [], "plate 1 was extracted first and must be removed")

    def test_a_3mf_without_plates_is_a_model_not_a_print_job(self):
        import zipfile
        with zipfile.ZipFile(self.dir / "m.3mf", "w") as zf:
            zf.writestr("3D/3dmodel.model", "<model/>")
        with self.assertRaises(communitycad.PlateError) as ctx:
            communitycad.extract_plates(self.dir / "m.3mf", self.dir, self.free)
        self.assertIn("no sliced plates", str(ctx.exception))

    def test_not_a_zip_is_refused_plainly(self):
        junk = self.dir / "j.gcode.3mf"
        junk.write_bytes(b"not a zip")
        with self.assertRaises(communitycad.PlateError) as ctx:
            communitycad.extract_plates(junk, self.dir, self.free)
        self.assertIn("damaged", str(ctx.exception))

    def test_too_many_entries_is_refused(self):
        a = make_3mf(self.dir / "a.gcode.3mf", {1: b"G1"}, extra=communitycad.MAX_3MF_ENTRIES)
        with self.assertRaises(communitycad.PlateError):
            communitycad.extract_plates(a, self.dir, self.free)

    def test_a_zip_bomb_is_refused_before_writing(self):
        # 50 MB of zeros deflates to ~50 KB: a ratio no real G-code reaches.
        a = make_3mf(self.dir / "bomb.gcode.3mf", {1: b"\0" * (50 << 20)})
        with self.assertRaises(communitycad.PlateError) as ctx:
            communitycad.extract_plates(a, self.dir, self.free)
        self.assertIn("too large", str(ctx.exception))
        self.assertEqual(self.leftovers(), [])

    def test_not_enough_disk_is_refused_before_writing(self):
        a = make_3mf(self.dir / "a.gcode.3mf", {1: b"G1 X1" * 1000})
        with self.assertRaises(communitycad.PlateError) as ctx:
            communitycad.extract_plates(a, self.dir, communitycad.DISK_HEADROOM_BYTES)
        self.assertIn("free space", str(ctx.exception))
        self.assertEqual(self.leftovers(), [])

    def test_a_plate_bigger_than_its_header_says_is_refused(self):
        # A crafted archive can understate a member's size; count while copying.
        a = make_3mf(self.dir / "liar.gcode.3mf", {1: b"G1 X1" * 1000})
        real_open = communitycad.zipfile.ZipFile.infolist

        def lying_infolist(zf):
            infos = real_open(zf)
            for i in infos:
                if i.filename.endswith("plate_1.gcode"):
                    i.file_size = 10
            return infos

        communitycad.zipfile.ZipFile.infolist = lying_infolist
        try:
            with self.assertRaises(Exception):
                communitycad.extract_plates(a, self.dir, self.free)
        finally:
            communitycad.zipfile.ZipFile.infolist = real_open
        self.assertEqual(self.leftovers(), [])


class TestDownloadToDevice(ComponentTestCase):
    """"Download to this device": a presigned link for the browser, never the token."""
    STL = {"id": 8, "path": "cad/bench.stl", "size_bytes": 1234, "role": "cad"}
    PRESIGNED = "https://storage.example/bench.stl?X-Goog-Signature=abc"

    def setUp(self):
        super().setUp()
        self.comp._creds = {"access_token": "ccad_tok"}

    def detail(self, *files):
        return {"id": 5, "title": "Bench", "slug": "bench", "files": list(files)}

    async def test_a_model_file_gets_a_link_and_nothing_else(self):
        self.http.responses.append(FakeResponse(200, self.detail(self.STL)))
        self.http.responses.append(FakeResponse(200, {"url": self.PRESIGNED}))
        result = await self.comp._handle_download_url(
            FakeWebRequest({"model_id": 5, "file_id": 8}))
        self.assertEqual(result, {"url": self.PRESIGNED, "filename": "bench.stl",
                                  "size_bytes": 1234})
        self.assertNotIn("ccad_tok", json.dumps(result), "the token must never reach the browser")
        method, url, _, headers = self.http.calls[-1]
        self.assertEqual(method, "POST")
        self.assertTrue(url.endswith("/catalog/models/5/files/8/download-url"))
        self.assertIn("ccad_tok", json.dumps(headers), "the Pi authenticates the request itself")

    async def test_unlinked_printer_is_told_to_connect_and_spends_nothing(self):
        self.comp._creds = {}
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_download_url(FakeWebRequest({"model_id": 5, "file_id": 8}))
        self.assertIn("Connect this printer", str(ctx.exception))
        self.assertEqual(self.http.calls, [])

    async def test_unknown_file_is_refused_before_a_link_is_issued(self):
        # Issuing the link is what spends a download, so a bad id must not get that far.
        self.http.responses.append(FakeResponse(200, self.detail(self.STL)))
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_download_url(FakeWebRequest({"model_id": 5, "file_id": 999}))
        self.assertIn("not part of this model", str(ctx.exception))
        self.assertFalse(any("download-url" in c[1] for c in self.http.calls))

    async def test_no_link_from_the_platform_is_an_error_not_an_empty_link(self):
        self.http.responses.append(FakeResponse(200, self.detail(self.STL)))
        self.http.responses.append(FakeResponse(200, {}))
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_download_url(FakeWebRequest({"model_id": 5, "file_id": 8}))
        self.assertIn("did not return a download link", str(ctx.exception))


class TestSendToPrinter(ComponentTestCase):
    GCODE = {"id": 7, "path": "cad/bench.gcode", "size_bytes": 4, "role": "export"}
    STL = {"id": 8, "path": "cad/bench.stl", "size_bytes": 4, "role": "cad"}

    def setUp(self):
        super().setUp()
        self.fm = FakeFileManager()
        self.server.components["file_manager"] = self.fm
        self.comp._creds = {"access_token": "ccad_tok"}

    def detail(self, *files):
        return {"id": 5, "title": "Bench", "slug": "bench", "files": list(files)}

    async def test_unlinked_printer_is_told_to_connect(self):
        self.comp._creds = {}
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 7}))
        self.assertIn("Connect this printer", str(ctx.exception))

    async def test_a_model_file_is_refused_with_a_reason(self):
        # An STL is a model, not a print job. Refusing it early also
        # means no download is spent finding that out.
        self.http.responses.append(FakeResponse(200, self.detail(self.STL)))
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 8}))
        self.assertIn("not a print job", str(ctx.exception))
        self.assertEqual(self.fm.calls, [], "nothing should reach the printer")

    async def test_unknown_file_id_is_refused(self):
        self.http.responses.append(FakeResponse(200, self.detail(self.GCODE)))
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 999}))
        self.assertIn("not part of this model", str(ctx.exception))

    async def test_a_short_download_never_reaches_the_printer(self):
        # The guarantee that matters: a truncated file must not end up sitting in the
        # print queue looking ready.
        self.http.responses.append(FakeResponse(200, self.detail(self.GCODE)))
        self.http.responses.append(FakeResponse(200, {"url": "https://example/x.gcode"}))

        async def short_download(url, content_type, destination_path=None, **kwargs):
            pathlib.Path(destination_path).write_bytes(b"xy")  # 2 of 4 bytes
            return pathlib.Path(destination_path)

        self.http.download_file = short_download
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 7}))
        self.assertIn("incomplete", str(ctx.exception))
        self.assertEqual(self.fm.calls, [])
        self.assertEqual(list(self.comp.root.joinpath("tmp").glob("*.part")), [],
                         "a failed download should not leave a temp file behind")

    async def test_a_good_send_lands_and_is_recorded(self):
        self.http.responses.append(FakeResponse(200, self.detail(self.GCODE)))
        self.http.responses.append(FakeResponse(200, {"url": "https://example/x.gcode"}))

        async def good_download(url, content_type, destination_path=None, **kwargs):
            pathlib.Path(destination_path).write_bytes(b"G1XY")
            return pathlib.Path(destination_path)

        self.http.download_file = good_download
        result = await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 7}))

        self.assertEqual(result["filename"], "communitycad/bench.gcode")
        self.assertFalse(result["print_started"], "sending must never start a print")
        self.assertIn("printer_state", result, "the confirm needs it to offer Add to queue")
        form = self.fm.calls[0]
        self.assertEqual(form["root"], "gcodes")
        self.assertEqual(form["path"], "communitycad")
        self.assertEqual(form["print"], "false")
        # Sharing needs to know which model a finished print came from.
        library = json.loads(self.comp.root.joinpath("library.json").read_text())
        self.assertEqual(library["communitycad/bench.gcode"]["model_id"], 5)
        self.assertEqual(library["communitycad/bench.gcode"]["title"], "Bench")


    def sliced(self, plates, path="exports/4-cubes.gcode.3mf", md5=None):
        """Catalog entry and download stub for a sliced 3MF with these plates."""
        src = pathlib.Path(self._tmp.name) / "src.gcode.3mf"
        make_3mf(src, plates, md5=md5)
        entry = {"id": 9, "path": path, "size_bytes": src.stat().st_size, "role": "export"}
        self.http.responses.append(FakeResponse(200, self.detail(entry)))
        self.http.responses.append(FakeResponse(200, {"url": "https://example/x.gcode.3mf"}))

        async def download(url, content_type, destination_path=None, **kwargs):
            pathlib.Path(destination_path).write_bytes(src.read_bytes())
            return pathlib.Path(destination_path)

        self.http.download_file = download

    async def test_a_one_plate_3mf_lands_as_plain_gcode(self):
        self.sliced({1: b"G1 X1"})
        result = await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 9}))
        self.assertEqual(result["filename"], "communitycad/4-cubes.gcode")
        self.assertEqual([f["plate"] for f in result["files"]], [1])
        self.assertEqual([c["filename"] for c in self.fm.calls], ["4-cubes.gcode"])
        self.assertFalse(result["print_started"])

    async def test_every_plate_lands_and_is_recorded(self):
        self.sliced({1: b"G1 X1", 2: b"G1 X2"})
        result = await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 9}))
        self.assertEqual([f["filename"] for f in result["files"]],
                         ["communitycad/4-cubes-plate1.gcode", "communitycad/4-cubes-plate2.gcode"])
        library = json.loads(self.comp.root.joinpath("library.json").read_text())
        self.assertEqual(library["communitycad/4-cubes-plate2.gcode"]["plate"], 2)
        self.assertEqual(library["communitycad/4-cubes-plate2.gcode"]["file_id"], 9)
        tmp = self.comp.root.joinpath("tmp")
        self.assertFalse(any(p.name.endswith(".part") and "plate" not in p.name
                             for p in tmp.iterdir()), "the 3MF itself must be removed")

    async def test_a_3mf_that_fails_its_checksum_adds_nothing(self):
        self.sliced({1: b"G1 X1"}, md5={1: "0" * 32})
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 9}))
        self.assertIn("checksum", str(ctx.exception))
        self.assertEqual(self.fm.calls, [], "nothing should reach the printer")
        self.assertEqual(list(self.comp.root.joinpath("tmp").iterdir()), [])

    async def test_a_failed_plate_leaves_no_temp_files_behind(self):
        self.sliced({1: b"G1 X1", 2: b"G1 X2"})
        self.fm.fail = True
        with self.assertRaises(Exception):
            await self.comp._handle_send(FakeWebRequest({"model_id": 5, "file_id": 9}))
        self.assertEqual(list(self.comp.root.joinpath("tmp").iterdir()), [])


class FakeMetadataStorage:
    def __init__(self, data=None):
        self._data = data or {}

    def get(self, filename, default=None):
        return self._data.get(filename, default)


class FakeJobQueue:
    def __init__(self):
        self.queued = []

    async def queue_job(self, filenames, check_exists=True, **kwargs):
        self.queued.append(filenames)


class FakeKlippyPrint:
    """Klippy with a print state and a start_print that can refuse."""

    def __init__(self, state=None, nozzle=None, start_fails=False):
        self.state = state
        self.nozzle = nozzle
        self.start_fails = start_fails
        self.started = []

    async def query_objects(self, objects, default=None):
        if "print_stats" in objects:
            return {"print_stats": {"state": self.state}} if self.state else {}
        settings = {"extruder": {"nozzle_diameter": self.nozzle}} if self.nozzle else {}
        return {"configfile": {"settings": settings}, "toolhead": {}}

    async def start_print(self, filename, **kwargs):
        if self.start_fails:
            raise RuntimeError("Printer is halted")
        self.started.append(filename)
        return "ok"


class TestPrinterMatch(ComponentTestCase):
    """Pre-sliced G-code only works on the printer it was sliced for, and a
    mismatched file can drive the toolhead into the bed. The point of these tests is
    that a check we *cannot* make never reads as a pass."""

    def setup_match(self, metadata, nozzle=None, volume=None):
        fm = FakeFileManager()
        fm.get_metadata_storage = lambda: FakeMetadataStorage({"f.gcode": metadata})
        self.server.components["file_manager"] = fm
        self.server.components["klippy_apis"] = FakeKlippyPrint(nozzle=nozzle)
        if volume:
            self.comp._settings["build_volume"] = volume

    async def test_profile_kinematics_come_from_the_config(self):
        # The profile used to read toolhead.kinematics, which Klipper never sends.
        self.server.components["klippy_apis"] = FakeKlippyApis(
            {}, settings={"printer": {"kinematics": "corexy"},
                          "extruder": {"nozzle_diameter": 0.4}})
        profile = await self.comp._printer_profile()
        self.assertEqual(profile, {"nozzle_diameter": 0.4, "kinematics": "corexy"})

    async def test_too_tall_is_a_warning(self):
        self.setup_match({"object_height": 300, "slicer": "Orca"},
                         volume={"x": 235, "y": 235, "z": 250})
        report = await self.comp._match_report("f.gcode")
        self.assertFalse(report["ok"])
        self.assertIn("taller", [c["detail"] for c in report["checks"] if c["status"] == "warn"][0])

    async def test_fits_is_fine(self):
        self.setup_match({"object_height": 100, "slicer": "Orca"},
                         volume={"x": 235, "y": 235, "z": 250})
        report = await self.comp._match_report("f.gcode")
        self.assertTrue(report["ok"])

    async def test_nozzle_mismatch_is_a_warning(self):
        self.setup_match({"nozzle_diameter": 0.8, "slicer": "Orca"}, nozzle=0.4)
        report = await self.comp._match_report("f.gcode")
        self.assertFalse(report["ok"])

    async def test_matching_nozzle_is_fine(self):
        self.setup_match({"nozzle_diameter": 0.4, "slicer": "Orca"}, nozzle=0.4)
        report = await self.comp._match_report("f.gcode")
        self.assertTrue(report["ok"])

    async def test_unknowns_are_not_reported_as_a_pass(self):
        # Nothing comparable: ok stays true because we found no problem, but
        # `confident` is false so the UI must not claim the file was verified.
        self.setup_match({"slicer": "Cura"})
        report = await self.comp._match_report("f.gcode")
        self.assertTrue(report["ok"])
        self.assertFalse(report["confident"])

    async def test_no_metadata_at_all(self):
        self.setup_match({})
        report = await self.comp._match_report("f.gcode")
        self.assertFalse(report["confident"])


class TestStartPrint(ComponentTestCase):
    def setUp(self):
        super().setUp()
        self.queue = FakeJobQueue()
        self.server.components["job_queue"] = self.queue

    async def test_confirm_is_required(self):
        self.server.components["klippy_apis"] = FakeKlippyPrint(state="standby")
        for args in ({"filename": "a.gcode"}, {"filename": "a.gcode", "confirm": False}):
            with self.assertRaises(Exception) as ctx:
                await self.comp._handle_print(FakeWebRequest(args))
            self.assertIn("explicit confirmation", str(ctx.exception))

    async def test_idle_printer_starts(self):
        klippy = FakeKlippyPrint(state="standby")
        self.server.components["klippy_apis"] = klippy
        result = await self.comp._handle_print(
            FakeWebRequest({"filename": "a.gcode", "confirm": True}))
        self.assertTrue(result["started"])
        self.assertEqual(klippy.started, ["a.gcode"])

    async def test_busy_printer_queues_instead(self):
        self.server.components["klippy_apis"] = FakeKlippyPrint(state="printing")
        result = await self.comp._handle_print(
            FakeWebRequest({"filename": "a.gcode", "confirm": True}))
        self.assertTrue(result["queued"])
        self.assertFalse(result["started"])
        self.assertEqual(self.queue.queued, ["a.gcode"])

    async def test_klippy_down_says_so_and_starts_nothing(self):
        klippy = FakeKlippyPrint(state=None)
        self.server.components["klippy_apis"] = klippy
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_print(
                FakeWebRequest({"filename": "a.gcode", "confirm": True}))
        self.assertIn("isn't ready", str(ctx.exception))
        self.assertEqual(klippy.started, [])

    async def test_a_refusing_printer_is_reported_not_swallowed(self):
        klippy = FakeKlippyPrint(state="standby", start_fails=True)
        self.server.components["klippy_apis"] = klippy
        with self.assertRaises(Exception) as ctx:
            await self.comp._handle_print(
                FakeWebRequest({"filename": "a.gcode", "confirm": True}))
        self.assertIn("still saved", str(ctx.exception))


class FakeWebRequest:
    def __init__(self, args: Dict[str, Any], method: str = "GET"):
        self._args = args
        self._method = method

    def get_request_type(self):
        return communitycad.RequestType.POST if self._method == "POST" else communitycad.RequestType.GET

    def get_args(self):
        return self._args

    def get_str(self, key, default=None):
        return str(self._args.get(key, default))

    def get_int(self, key, default=None):
        return int(self._args.get(key, default))

    def get_boolean(self, key, default=False):
        return bool(self._args.get(key, default))


if __name__ == "__main__":
    unittest.main(verbosity=2)
