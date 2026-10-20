"""What of a slicer's configuration may leave the printer.

Slicers embed their entire configuration in the G-code they produce, and that
configuration contains things that must never be uploaded anywhere: the printer's
address on the network, the Moonraker API key, local file paths, and custom start and
end G-code, which people routinely use to store secrets and machine-specific details.

So this is an **allowlist**, not a denylist. A key nobody thought about is dropped,
which is the safe direction: the cost of forgetting to allow a useful key is a missing
line on a web page, and the cost of forgetting to deny a dangerous one is a leaked
credential. The server keeps its own copy and re-applies it, so a compromised or
out-of-date plugin cannot widen what is accepted.
"""
from __future__ import annotations

import re
from typing import Dict, Iterable, Optional, Tuple

# Exactly the keys that describe how something was printed. Anything absent here is
# dropped, whether or not it looks harmless.
ALLOWED_KEYS = frozenset({
    # Layers
    "layer_height", "first_layer_height", "initial_layer_print_height",
    "adaptive_layer_height",
    # Nozzle and extrusion widths
    "nozzle_diameter", "extrusion_width", "first_layer_extrusion_width",
    "perimeter_extrusion_width", "external_perimeter_extrusion_width",
    "infill_extrusion_width", "solid_infill_extrusion_width",
    "top_infill_extrusion_width", "line_width", "initial_layer_line_width",
    "inner_wall_line_width", "outer_wall_line_width", "sparse_infill_line_width",
    # Walls, top and bottom
    "perimeters", "wall_loops", "top_solid_layers", "bottom_solid_layers",
    "top_shell_layers", "bottom_shell_layers", "top_shell_thickness",
    "bottom_shell_thickness", "spiral_vase", "spiral_mode",
    # Infill
    "fill_density", "sparse_infill_density", "fill_pattern",
    "sparse_infill_pattern", "top_fill_pattern", "bottom_fill_pattern",
    "infill_anchor", "infill_anchor_max",
    # Supports
    "support_material", "enable_support", "support_type", "support_style",
    "support_material_threshold", "support_threshold_angle",
    "support_material_auto", "support_material_buildplate_only",
    "support_base_pattern", "support_material_pattern",
    # Adhesion
    "brim_width", "brim_type", "skirts", "skirt_loops", "raft_layers",
    # Temperatures
    "temperature", "first_layer_temperature", "nozzle_temperature",
    "nozzle_temperature_initial_layer", "bed_temperature",
    "first_layer_bed_temperature", "hot_plate_temp", "hot_plate_temp_initial_layer",
    "chamber_temperature",
    # Speeds
    "perimeter_speed", "external_perimeter_speed", "infill_speed",
    "solid_infill_speed", "top_solid_infill_speed", "travel_speed",
    "first_layer_speed", "bridge_speed", "gap_fill_speed",
    "inner_wall_speed", "outer_wall_speed", "sparse_infill_speed",
    "internal_solid_infill_speed", "top_surface_speed", "initial_layer_speed",
    "max_print_speed", "max_volumetric_speed",
    # Cooling
    "fan_always_on", "cooling", "min_fan_speed", "max_fan_speed",
    "fan_min_speed", "fan_max_speed", "bridge_fan_speed",
    "disable_fan_first_layers", "close_fan_the_first_x_layers",
    "slow_down_layer_time", "slowdown_below_layer_time",
    # Retraction
    "retract_length", "retraction_length", "retract_speed", "retraction_speed",
    "retract_lift", "z_hop", "retract_before_travel",
    "retraction_minimum_travel", "wipe", "retract_restart_extra",
    # Filament
    "filament_type", "filament_diameter", "filament_settings_id",
    "filament_vendor", "filament_flow_ratio", "extrusion_multiplier",
    "filament_density", "filament_cost",
    # Identification of the slicer itself
    "slicer", "slicer_version", "printer_model", "printer_variant",
})

# Keys that must never be sent even if one is added to ALLOWED_KEYS by mistake.
# Belt and braces: the allowlist already excludes them, and the tests assert both.
#
# Substring matching, because slicers name these inconsistently and a leaked
# credential is not the place to be precise-but-wrong.
FORBIDDEN_SUBSTRINGS = (
    "host", "api_key", "apikey", "password", "passwd", "secret", "token",
    "url", "uri", "printhost", "webcam", "serial", "octoprint", "duet",
    "gcode",          # start/end/before/after/custom G-code blocks
    "notes", "output_filename_format",
    "path", "dir", "folder",
)

# `; key = value`, which is how both PrusaSlicer and Orca write their config block.
_SETTING = re.compile(r"^;\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$")

# Where each slicer's configuration block starts and ends.
_BLOCKS: Tuple[Tuple[str, str], ...] = (
    ("prusaslicer_config = begin", "prusaslicer_config = end"),
    ("CONFIG_BLOCK_START", "CONFIG_BLOCK_END"),
    ("SuperSlicer_config = begin", "SuperSlicer_config = end"),
)

MAX_VALUE_LENGTH = 200


def is_forbidden(key: str) -> bool:
    """True for keys that must never leave the printer, whatever else says."""
    lowered = key.lower()
    return any(bad in lowered for bad in FORBIDDEN_SUBSTRINGS)


def is_allowed(key: str) -> bool:
    return key.lower() in ALLOWED_KEYS and not is_forbidden(key.lower())


def extract_settings(lines: Iterable[str]) -> Dict[str, str]:
    """Pull the allowed settings out of a G-code file's configuration block.

    Reads only inside a recognised block: a `; key = value` comment elsewhere in the
    file is somebody's note, not configuration, and is none of our business.
    """
    settings: Dict[str, str] = {}
    in_block = False
    end_marker: Optional[str] = None

    for raw in lines:
        line = raw.rstrip("\n")
        if not in_block:
            for start, end in _BLOCKS:
                if start in line:
                    in_block, end_marker = True, end
                    break
            continue
        if end_marker and end_marker in line:
            in_block, end_marker = False, None
            continue

        match = _SETTING.match(line)
        if not match:
            continue
        key, value = match.group(1).strip(), match.group(2).strip()
        if not is_allowed(key):
            continue
        if not value or len(value) > MAX_VALUE_LENGTH:
            # Empty is noise; overlong is not a setting we understand, and is the
            # shape a pasted custom G-code block takes.
            continue
        settings[key.lower()] = value
    return settings


def filter_settings(settings: Dict[str, str]) -> Dict[str, str]:
    """Apply the allowlist to settings gathered from somewhere other than the file."""
    return {k.lower(): v for k, v in settings.items() if is_allowed(k)}
