"""The slicer-settings allowlist.

Slicers embed their whole configuration in the G-code they produce, including the
printer's address, the Moonraker API key and custom start/end G-code, which people use
to store all sorts of things. These tests run against fixtures that deliberately carry
exactly those, and assert none of it survives.

Run with dev/run-component-tests.sh.
"""
from __future__ import annotations

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "component"))

import profile_allowlist as allowlist  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"

# Values planted in the fixtures that must never appear in anything we would upload.
SECRETS = (
    "192.0.2.44",
    "3f9a1c7e5b2d48a6",
    "orca-secret-key",
    "fluidd.local",
    "hunter2",
    "owner@example.com",
    "/usr/local/bin/upload.sh",
    "/dev/ttyUSB0",
    "spare key under the mat",
)


def settings_from(name: str) -> dict:
    return allowlist.extract_settings((FIXTURES / name).read_text().splitlines())


class TestPrusaSlicer(unittest.TestCase):
    def setUp(self):
        self.settings = settings_from("prusaslicer-sample.gcode")

    def test_useful_settings_survive(self):
        self.assertEqual(self.settings["layer_height"], "0.2")
        self.assertEqual(self.settings["nozzle_diameter"], "0.4")
        self.assertEqual(self.settings["fill_pattern"], "gyroid")
        self.assertEqual(self.settings["filament_type"], "PLA")
        self.assertEqual(self.settings["first_layer_bed_temperature"], "60")

    def test_no_secret_survives(self):
        blob = repr(self.settings)
        for secret in SECRETS:
            self.assertNotIn(secret, blob, f"{secret!r} leaked through the allowlist")

    def test_the_dangerous_keys_are_gone_by_name(self):
        for key in ("print_host", "printhost_apikey", "start_gcode", "end_gcode",
                    "notes", "post_process", "serial_port", "output_filename_format"):
            self.assertNotIn(key, self.settings)

    def test_comments_outside_the_block_are_ignored(self):
        # "; a stray note = not configuration" parses as key/value but is not config.
        self.assertNotIn("a stray note", repr(self.settings))


class TestOrca(unittest.TestCase):
    def setUp(self):
        self.settings = settings_from("orca-sample.gcode")

    def test_useful_settings_survive(self):
        self.assertEqual(self.settings["nozzle_diameter"], "0.6")
        self.assertEqual(self.settings["wall_loops"], "2")
        self.assertEqual(self.settings["sparse_infill_density"], "15%")
        self.assertEqual(self.settings["filament_type"], "PETG")

    def test_no_secret_survives(self):
        blob = repr(self.settings)
        for secret in SECRETS:
            self.assertNotIn(secret, blob, f"{secret!r} leaked through the allowlist")

    def test_machine_gcode_is_dropped(self):
        for key in ("machine_start_gcode", "machine_end_gcode", "printer_notes"):
            self.assertNotIn(key, self.settings)


class TestAllowlistItself(unittest.TestCase):
    def test_no_allowed_key_is_also_forbidden(self):
        clashes = [k for k in allowlist.ALLOWED_KEYS if allowlist.is_forbidden(k)]
        self.assertEqual(clashes, [], "a key is both allowed and forbidden")

    def test_unknown_keys_are_dropped_not_kept(self):
        # The safe direction: forgetting to allow a useful key costs a missing line
        # on a web page; forgetting to deny a dangerous one costs a credential.
        self.assertFalse(allowlist.is_allowed("some_future_setting"))

    def test_forbidden_matching_is_case_insensitive(self):
        for key in ("PRINT_HOST", "Printhost_APIKey", "Start_GCode"):
            self.assertTrue(allowlist.is_forbidden(key), key)

    def test_filter_settings_applies_the_same_rule(self):
        filtered = allowlist.filter_settings({
            "layer_height": "0.2",
            "print_host": "http://10.0.0.5",
            "PRINTHOST_APIKEY": "abc",
        })
        self.assertEqual(filtered, {"layer_height": "0.2"})

    def test_overlong_values_are_dropped(self):
        # A pasted custom G-code block is the shape this guards against.
        lines = ["; prusaslicer_config = begin",
                 "; layer_height = " + "9" * 500,
                 "; prusaslicer_config = end"]
        self.assertEqual(allowlist.extract_settings(lines), {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
