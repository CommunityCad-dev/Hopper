/** Shapes returned by the Moonraker component. Read off live responses, not docs. */

export interface Creator {
  username: string;
  display_name: string | null;
}

/**
 * Every field a grid card needs, so browsing never fetches detail per card.
 *
 * `bbox` values are null for models whose geometry could not be measured — a few
 * percent of the catalog. That is a normal state shown as "size unknown",
 * never an error.
 */
export interface BoundingBox {
  x: number | null;
  y: number | null;
  z: number | null;
  /** "declared" when the file stated its units, "assumed_mm" when we guessed. */
  source: 'declared' | 'assumed_mm' | null;
}

export interface ModelCard {
  id: number;
  slug: string;
  title: string;
  thumbnail_url: string | null;
  creator: Creator;
  license_name: string | null;
  bbox: BoundingBox;
  has_printable: boolean;
  printable_types: string[];
  total_size_bytes: number | null;
  like_count: number;
  download_count: number;
  print_count: number;
  /** "public" or "private"; more values may come. */
  visibility?: string;
}

export interface SearchResult {
  items: ModelCard[];
  total: number;
  limit: number;
  offset: number;
}

export interface ModelFile {
  id: number;
  path: string;
  role: string;
  size_bytes: number;
  /** File extension as the platform sees it ("stl", "gcode", "jpg", "" for none). */
  type?: string;
  /** The platform's own judgement: a file someone would print or slice. */
  printable?: boolean;
  printable_type?: string | null;
}

export interface ModelDetail extends ModelCard {
  description: string | null;
  readme_markdown: string | null;
  files: ModelFile[];
  images: { url: string; caption: string | null }[];
  tags?: string[];
  source_url?: string | null;
  original_author?: string | null;
}

export interface BuildVolume {
  x: number;
  y: number;
  z: number;
  kinematics: string;
  /** False for delta beds: circular, so a rectangular fit test would be wrong. */
  fit_filtering: boolean;
  source: 'detected' | 'override';
}

export interface LinkPending {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_at: number;
  /** Adding permissions to an existing link, not a first link. */
  upgrade?: boolean;
  added?: string[];
}

export interface MatchCheck {
  check: string;
  status: 'ok' | 'warn' | 'unknown';
  detail: string;
}

export interface MatchReport {
  ok: boolean;
  /** False when something could not be checked — never render that as verified. */
  confident: boolean;
  checks: MatchCheck[];
  filename: string;
  /** What the file was sliced for, one per filament; empty when it doesn't say. */
  materials?: string[];
}

export interface DownloadLink {
  url: string;
  filename: string;
  size_bytes?: number | null;
}

export interface DownloadCheck {
  linked: boolean;
  /** True when sending would use one of the user's allowance. */
  would_count?: boolean;
  reason?: 'counted' | 'same_destination_today' | 'over_limit' | 'issue_cap_reached' | 'own_model';
  allowed?: boolean;
  daily_remaining?: number | null;
  weekly_remaining?: number | null;
  reset_at?: string | null;
}

export interface Status {
  component_version: string;
  api_base: string;
  linked: boolean;
  account: { username: string | null; scopes?: string[]; can_share?: boolean } | null;
  printer_name: string;
  build_volume: BuildVolume | null;
  link_pending: LinkPending | null;
  link_error: string | null;
  default_tab: 'fits' | 'all';
  /** Where sent files go, inside the G-code files. "" is the top level. */
  send_folder?: string;
  /** Browse filter last chosen on this printer: "" (all), gcode, 3mf, stl or obj. */
  file_type?: string;
  /** null until the user has answered; nothing is read before a yes. */
  permissions?: Permissions;
  /** The first-use notice: accepted for this version, on this printer? */
  notice?: { version: string; accepted: boolean };
  /** Ask to share when a print of a CommunityCAD model finishes. */
  share_prompt?: boolean;
  share_after_print?: 'ask' | 'auto' | 'off';
  share_visibility?: 'public' | 'private';
  post_webcam?: boolean;
  post_webcam_name?: string | null;
  post_timelapse?: boolean;
  post_attach_profile?: boolean;
  /** Oldest plugin the API still supports; null until it has told us. */
  min_plugin_version: string | null;
  update_required: boolean;
}

/** A model file kept on the printer for slicing. */
export interface StoredModel {
  id: string;
  filename: string;
  path: string;
  model_id?: number;
  file_id?: number;
  title?: string | null;
  slug?: string | null;
  thumbnail_url?: string | null;
  bytes: number;
  saved_at: number;
  /** STL, OBJ, STEP or unsliced 3MF; anything else is listed but never sliced. */
  usable: boolean;
  /** Uploaded from a device rather than saved from the catalog. */
  uploaded: boolean;
}

export interface ModelsList {
  models: StoredModel[];
  used_bytes: number;
  cap_bytes: number;
  free_disk_bytes: number | null;
}

export interface SliceOptions {
  /** A [material] name from materials.cfg. */
  material: string;
  /** The print profile this starts from: an Orca default or a custom one. */
  profile: string;
  /** Changes to the preset, by Orca's key, in Orca's format. */
  process: Record<string, string>;
}

/** The settings the plugin lets a user change, and each preset's values. */
export interface ProcessInfo {
  nozzle: number;
  settings: Record<string, {
    type: 'float' | 'int' | 'percent' | 'choice' | 'bool';
    min?: number; max?: number; choices?: string[];
  }>;
  /** Each profile's own values, by profile name. */
  defaults: Record<string, Record<string, string>>;
}

/** Print profiles: Orca's own for this printer, and the user's in print_profiles.cfg. */
export interface ProfilesList {
  path: string;
  defaults: { name: string }[];
  /** Orca's defaults the user removed: out of every list, restorable. */
  hidden?: { name: string }[];
  custom: { name: string; inherits: string; changed: number; line: number; values: Record<string, string> }[];
  default_profile: string | null;
  problems: string[];
}

/** The current or last slice on this printer. */
export interface SliceJob {
  state: 'idle' | 'slicing' | 'done' | 'failed' | 'cancelled';
  id?: string;
  model?: string;
  filename?: string;
  options?: SliceOptions;
  project?: boolean;
  elapsed_s?: number;
  seconds?: number;
  error?: string;
  gcode?: string;
  summary?: { print_time?: string; filament_g?: string; layers?: string };
  /** The printer it was sliced for, when recognised from printer.cfg. */
  printer?: string | null;
  /** Defaults used because a fact is missing from printer.cfg. */
  assumed?: string[];
  /** One entry per plate. */
  plates?: SlicedPlate[];
  /** Settings lowered to the printer's limits. */
  capped?: string;
  printer_state?: string | null;
  match?: MatchReport;
}

/** materials.cfg: one OrcaSlicer filament preset per [material]. */
export interface MaterialSummary {
  name: string;
  inherits: string;
  changed: number;
  line: number;
  /** Orca's default_filament_colour from materials.cfg, when set. */
  colour?: string | null;
  /** PLA, PETG...: from filament_type or the preset names. */
  type?: string | null;
}

export interface MaterialsList {
  path: string;
  materials: MaterialSummary[];
  problems: string[];
}

export interface MaterialSetting {
  key: string;
  group: string;
  value: string | null;
  inherited: string | null;
  changed: boolean;
}

export interface MaterialDetail {
  name: string;
  inherits: string;
  inherits_known: boolean;
  settings: MaterialSetting[];
  problems: string[];
}

export interface Permissions {
  printer_settings: boolean | null;
  print_history: boolean | null;
}

/** This printer as the slicer sees it, from printer.cfg. */
export interface PrinterInfo {
  identity: { name: string | null; family: string | null; evidence: string[] };
  kinematics: string;
  max_velocity: number | null;
  max_accel: number | null;
  nozzle_diameter: number | null;
  hotend_max_temp: number | null;
  bed_max_temp: number | null;
  firmware_retraction: boolean;
  enclosed: boolean;
  start_macro: string | null;
  end_macro: string | null;
  params: Record<string, string>;
  heats_bed: boolean;
  heats_nozzle: boolean;
  /** Owner-added facts from [gcode_macro _COMMUNITYCAD]. */
  facts: {
    facts: Record<string, string | number | boolean>;
    missing: string[];
    problems: string[];
    macro_present: boolean;
    add_lines: string | null;
  };
  bed_surface: string;
  bed_surface_assumed: boolean;
}

/** A project: a real Orca 3MF in printer_data/projects. */
export interface ProjectEntry {
  id: string;
  filename: string;
  name: string;
  bytes: number;
  created: number;
  updated: number;
  /** Made here from Models, saved from the catalog, or uploaded from a device. */
  origin: 'models' | 'catalog' | 'upload';
  sources?: { model: string; copies: number }[];
  options?: SliceOptions;
  /** `stale`: the plate was re-arranged since, so these files no longer match it. */
  last_slice?: { at: number; gcodes: string[]; stale?: boolean };
  /** Gap between models when arranging, mm; null for Orca's own arrange. */
  spacing?: number | null;
  prints?: { gcode: string; status: string; at: number; duration?: number }[];
  title?: string | null;
  thumbnail_url?: string | null;
  /** A picture of the first plate, from the slicer view; stale once it changed. */
  thumbnail?: { url: string; stale: boolean } | null;
}

export interface ProjectsList {
  projects: ProjectEntry[];
  root: string;
  history_allowed: boolean;
}

/** A pause or filament change at a layer, as kept in the project's 3MF. */
export interface LayerMarker {
  plate: number;
  /** The layer's top, in mm: it runs at the change to this layer, before it prints. */
  z: number;
  kind: 'pause' | 'filament';
  /** What the printer runs: PAUSE, or M600 for a filament change where printer.cfg has it. */
  gcode?: string;
}

export interface LayerMarkers {
  markers: LayerMarker[];
  /** The printer's macros: null when printer.cfg has none, unknown without permission. */
  macros: { known: boolean; pause: string | null; filament: string | null };
}

export interface SlicedPlate {
  plate: number;
  /** In the G-code files once sent (Send or Print plate); null while it waits. */
  gcode: string | null;
  /** Where it waits after slicing, for Preview: a Moonraker path under projects/.sliced. */
  staged?: string;
  summary: { print_time?: string; filament_g?: string; layers?: string };
  /** The check against this printer, made when it's sent. */
  match?: MatchReport;
}

/** One preset in an OrcaSlicer import, before or after it's written. */
export interface OrcaImportItem {
  kind: 'profile' | 'material' | 'printer';
  name: string;
  action: 'add' | 'replace' | 'skip';
  inherits?: string;
  settings?: number;
  dropped?: string[];
  skipped?: string[];
  note?: string | null;
}

/** Every Orca process setting of one print profile. */
export interface ProfileDetail {
  name: string;
  inherits: string;
  inherits_known: boolean;
  readonly: boolean;
  settings: { key: string; group: string; value: string | null; inherited: string | null; changed: boolean; common: boolean }[];
  problems: string[];
}

/** What a profile share sends, exactly. */
export interface SharePayload {
  model_id: number;
  printer_name: string | null;
  printer_kinematics: string | null;
  slicer: string | null;
  slicer_version: string | null;
  material: Record<string, string> | null;
  settings: Record<string, string>;
  result: 'completed' | 'cancelled' | 'error';
  print_duration_s: number | null;
  filament_used_mm: number | null;
}

export interface SharePrint {
  job_id: string;
  filename: string;
  status: string | null;
  end_time: number | null;
  print_duration: number | null;
  /** The CommunityCAD models on the plate that printed, each with its files and copies. */
  models: {
    model_id: number; title: string | null; slug: string | null;
    files?: { file_id: number | null; filename: string; copies: number }[];
  }[];
  /** The user's own parts on the plate, not from CommunityCAD: never sent. */
  own_parts?: number;
  shared: { profile_id: number | null; model_url: string | null; print_count: number | null; dropped: string[] } | null;
  /** The post made from this print. */
  posted?: { post_id: number | null; status: string | null; url: string | null; edit_url: string | null; message: string | null } | null;
  /** Kept on the Pi until CommunityCAD answers. */
  outbox?: { id: string; state: 'waiting' | 'failed'; error: string | null; next_at: number | null } | null;
  /** "Share automatically": the Pi shares it when `at` comes, unless stopped. */
  auto?: {
    state: 'pending' | 'timelapse' | 'done' | 'cancelled' | 'skipped' | 'failed';
    at?: number; error?: string | null; posted?: boolean;
  } | null;
}

export interface SharePrints {
  prints: SharePrint[];
  can_share: boolean;
  history_allowed: boolean;
  prompt: boolean;
  /** After a print finishes. */
  mode: 'ask' | 'auto' | 'off';
  visibility: 'public' | 'private';
  /** Whether CommunityCAD takes private profiles yet. */
  private_profiles: boolean;
}

/** What a post about a print can include. */
export interface PostOptions {
  timelapse: { filename: string; size_bytes: number; too_big: boolean; url: string } | null;
  webcam: boolean;
  profile_id: number | null;
  attach_profile: boolean;
  posted: SharePrint['posted'];
}
