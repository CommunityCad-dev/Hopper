import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import {
  mdiArrowULeftTop, mdiTextureBox, mdiCodeBraces, mdiDotsHorizontal, mdiFan, mdiGauge, mdiInformationOutline, mdiIron,
  mdiLayersTriple, mdiPalette, mdiPillar, mdiPrinter3dNozzle, mdiSpeedometer, mdiThermometer, mdiWall,
} from '@mdi/js';

import { Icon } from './icons';

/**
 * Help for the material and print profile editors: a Simple view of the
 * settings people change, an Advanced view of all of them, icons and one-line
 * descriptions for Orca's groups, and short tooltips. The wording is ours, short
 * and plain; Orca's own tooltip text isn't copied (it's AGPL, the plugin Apache-2.0).
 */

export type EditorView = 'simple' | 'advanced';
const VIEW_KEY = 'ccad-editor-view';

export function savedView(): EditorView {
  try { return localStorage.getItem(VIEW_KEY) === 'advanced' ? 'advanced' : 'simple'; } catch { return 'simple'; }
}

export function ViewSwitch({ view, onChange }: { view: EditorView; onChange: (v: EditorView) => void }) {
  const pick = (v: EditorView) => {
    onChange(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  };
  return (
    <div class="seg view-switch" role="tablist" aria-label="How much to show">
      <button type="button" role="tab" aria-selected={view === 'simple'} onClick={() => pick('simple')}>Simple</button>
      <button type="button" role="tab" aria-selected={view === 'advanced'} onClick={() => pick('advanced')}>Advanced</button>
    </div>
  );
}

/** Orca's groups: an icon and what the group is for. */
export const GROUPS: Record<string, { icon: string; blurb: string }> = {
  // Materials
  Filament: { icon: mdiPrinter3dNozzle, blurb: 'What the filament is: type, colour, flow, how fast it can melt' },
  Temperature: { icon: mdiThermometer, blurb: 'Nozzle, bed and chamber heat' },
  Cooling: { icon: mdiFan, blurb: 'Part-cooling fan, and slowing down for small layers' },
  'Pressure advance': { icon: mdiGauge, blurb: 'Evens out flow at corners and speed changes' },
  Retraction: { icon: mdiArrowULeftTop, blurb: 'Pulling filament back on travel, against stringing' },
  'G-code': { icon: mdiCodeBraces, blurb: 'Commands run when this filament starts and ends' },
  Ironing: { icon: mdiIron, blurb: 'A smoothing pass over top surfaces' },
  'Multi-material': { icon: mdiPalette, blurb: 'Only for MMUs and tool changers' },
  // Print profiles
  Quality: { icon: mdiLayersTriple, blurb: 'Layer height, line widths, seams, precision' },
  Strength: { icon: mdiWall, blurb: 'Walls, top and bottom layers, infill' },
  Speed: { icon: mdiSpeedometer, blurb: 'Print speeds and accelerations; capped by printer.cfg' },
  Support: { icon: mdiPillar, blurb: 'Supports under overhangs, and rafts' },
  Multimaterial: { icon: mdiPalette, blurb: 'Only for MMUs and tool changers' },
  Others: { icon: mdiDotsHorizontal, blurb: 'Brim, skirt, sequence, special modes' },
};

interface Info { label: string; unit?: string; tip?: string }

/** Plain labels, units and tips. Settings not here show their Orca name. */
export const INFO: Record<string, Info> = {
  // Filament
  filament_type: { label: 'Type', tip: 'The plastic, e.g. PLA or PETG. Used for warnings and Orca\'s defaults.' },
  default_filament_colour: { label: 'Colour', tip: 'How it\'s drawn on the plate, as #RRGGBB.' },
  filament_vendor: { label: 'Brand' },
  filament_diameter: { label: 'Diameter', unit: 'mm', tip: '1.75 for almost every printer.' },
  filament_density: { label: 'Density', unit: 'g/cm³', tip: 'Turns length into grams for the filament estimate.' },
  filament_cost: { label: 'Cost', unit: 'per kg' },
  filament_flow_ratio: { label: 'Flow ratio', tip: 'Multiplies how much plastic is pushed. Lower it if top surfaces look over-full; raise it for gaps. Usually 0.95–1.0.' },
  filament_max_volumetric_speed: { label: 'Max volumetric speed', unit: 'mm³/s', tip: 'The most plastic the hotend can melt per second. Print speeds are slowed to stay under it. Too high: weak, under-extruded prints.' },
  filament_shrink: { label: 'Shrinkage (XY)', unit: '%', tip: 'Scales parts up to make up for the plastic shrinking as it cools. 100% is none.' },
  // Temperature
  nozzle_temperature_initial_layer: { label: 'Nozzle, first layer', unit: '°C', tip: 'Often 5 °C hotter than the rest, for adhesion.' },
  nozzle_temperature: { label: 'Nozzle', unit: '°C', tip: 'For every layer after the first.' },
  nozzle_temperature_range_low: { label: 'Nozzle range, low', unit: '°C', tip: 'The lowest this filament should print at. Used for warnings.' },
  nozzle_temperature_range_high: { label: 'Nozzle range, high', unit: '°C', tip: 'The highest this filament should print at. Used for warnings.' },
  chamber_temperature: { label: 'Chamber', unit: '°C', tip: 'Asked of your start macro on an enclosed printer. 0: no chamber heat.' },
  // Cooling
  fan_min_speed: { label: 'Fan, minimum', unit: '%', tip: 'Part-cooling fan for most of the print.' },
  fan_max_speed: { label: 'Fan, maximum', unit: '%', tip: 'Used on small, fast layers that need more cooling.' },
  close_fan_the_first_x_layers: { label: 'No fan for the first', unit: 'layers', tip: 'Keeps the first layers warm so they stick.' },
  overhang_fan_speed: { label: 'Overhang fan', unit: '%', tip: 'Fan speed while printing overhangs and bridges.' },
  slow_down_layer_time: { label: 'Slow down below', unit: 's', tip: 'Layers quicker than this are slowed, so each one cools before the next.' },
  // Pressure advance
  enable_pressure_advance: { label: 'Pressure advance', tip: 'Set it here instead of in printer.cfg. Off: Klipper\'s own setting is used.' },
  pressure_advance: { label: 'Pressure advance value', tip: 'Klipper\'s pressure_advance for this filament. Calibrate it: PLA on a direct drive is often 0.02–0.05.' },
  // Retraction
  filament_retraction_length: { label: 'Retraction length', unit: 'mm', tip: 'Overrides the printer\'s. Empty: the printer\'s own retraction is used (Klipper\'s firmware_retraction, if set).' },
  filament_retraction_speed: { label: 'Retraction speed', unit: 'mm/s' },
  filament_z_hop: { label: 'Z hop', unit: 'mm', tip: 'Lifts the nozzle on travel, so it doesn\'t drag across the print.' },
  // Print profile: quality
  layer_height: { label: 'Layer height', unit: 'mm', tip: 'Thinner is finer and slower. Up to 75% of the nozzle.' },
  initial_layer_print_height: { label: 'First layer height', unit: 'mm', tip: 'A thicker first layer forgives a slightly uneven bed.' },
  seam_position: { label: 'Seam', tip: 'Where each wall loop starts and ends: aligned, rear, nearest or random.' },
  // Strength
  wall_loops: { label: 'Walls', tip: 'Outline loops. More walls: stronger parts, more time.' },
  top_shell_layers: { label: 'Top layers', tip: 'Solid layers on top. Too few and infill shows through.' },
  bottom_shell_layers: { label: 'Bottom layers' },
  sparse_infill_density: { label: 'Infill', unit: '%', tip: 'How full the inside is. 15% is plenty for most parts.' },
  sparse_infill_pattern: { label: 'Infill pattern', tip: 'Gyroid is strong in every direction; grid and cubic are quick.' },
  // Support
  enable_support: { label: 'Supports', tip: 'Prints scaffolding under overhangs, removed afterwards.' },
  support_type: { label: 'Support type', tip: 'Tree supports touch the part less and come off cleaner.' },
  support_threshold_angle: { label: 'Overhang angle', unit: '°', tip: 'Overhangs steeper than this get support. Higher: more support.' },
  support_on_build_plate_only: { label: 'Only from the bed', tip: 'No supports standing on the part itself.' },
  // Others
  brim_type: { label: 'Brim', tip: 'Extra lines around the first layer that help it stick. Peel off afterwards.' },
  brim_width: { label: 'Brim width', unit: 'mm' },
  skirt_loops: { label: 'Skirt loops', tip: 'Lines around the part, not touching it, to prime the nozzle.' },
  skirt_distance: { label: 'Skirt distance', unit: 'mm' },
  // Speed
  outer_wall_speed: { label: 'Outer wall speed', unit: 'mm/s', tip: 'Slower outer walls look better.' },
  inner_wall_speed: { label: 'Inner wall speed', unit: 'mm/s' },
  sparse_infill_speed: { label: 'Infill speed', unit: 'mm/s' },
  default_acceleration: { label: 'Acceleration', unit: 'mm/s²', tip: 'Capped at max_accel in printer.cfg.' },
};

/** The bed temperatures Orca uses for this printer's plate (bed_surface in printer.cfg's facts). */
export function plateKeys(bedSurface: string | null | undefined): [string, string] {
  const base: Record<string, string> = {
    textured_pei: 'textured_plate_temp', smooth_pei: 'hot_plate_temp', pei: 'hot_plate_temp', glass: 'hot_plate_temp',
    cool_plate: 'cool_plate_temp', textured_cool_plate: 'textured_cool_plate_temp', engineering: 'eng_plate_temp',
    garolite: 'eng_plate_temp', g10: 'eng_plate_temp', supertack: 'supertack_plate_temp',
  };
  const key = base[bedSurface ?? ''] ?? 'textured_plate_temp';
  return [`${key}_initial_layer`, key];
}

export const PLATE_TEMP = /plate_temp/;

/** Simple view, in sections with icons: a title, its icon, its settings. */
export interface Section { title: string; icon: string; keys: string[] }

export function materialSections(bedSurface: string | null | undefined): Section[] {
  return [
    { title: 'Filament', icon: mdiPrinter3dNozzle, keys: ['filament_type', 'default_filament_colour'] },
    { title: 'Temperature', icon: mdiThermometer,
      keys: ['nozzle_temperature_initial_layer', 'nozzle_temperature', ...plateKeys(bedSurface), 'chamber_temperature'] },
    { title: 'Flow', icon: mdiGauge,
      keys: ['filament_max_volumetric_speed', 'filament_flow_ratio', 'enable_pressure_advance', 'pressure_advance'] },
    { title: 'Cooling', icon: mdiFan, keys: ['fan_min_speed', 'fan_max_speed'] },
    { title: 'Retraction', icon: mdiArrowULeftTop, keys: ['filament_retraction_length'] },
  ];
}

export const PROFILE_SECTIONS: Section[] = [
  { title: 'Quality', icon: mdiLayersTriple, keys: ['layer_height', 'initial_layer_print_height', 'seam_position'] },
  { title: 'Strength', icon: mdiWall,
    keys: ['wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density', 'sparse_infill_pattern'] },
  { title: 'Support', icon: mdiPillar, keys: ['enable_support', 'support_type', 'support_threshold_angle'] },
  { title: 'Bed adhesion', icon: mdiTextureBox, keys: ['brim_type', 'brim_width', 'skirt_loops'] },
];

/** Simple view, materials: in this order. The bed pair depends on the plate. */
export function materialEssentials(bedSurface: string | null | undefined): string[] {
  return ['filament_type', 'default_filament_colour', 'nozzle_temperature_initial_layer', 'nozzle_temperature',
    ...plateKeys(bedSurface), 'chamber_temperature', 'filament_max_volumetric_speed', 'filament_flow_ratio',
    'enable_pressure_advance', 'pressure_advance', 'fan_min_speed', 'fan_max_speed', 'filament_retraction_length'];
}

/** Simple view, print profiles: what the slicer's Process sidebar offers, and a little more. */
export const PROFILE_ESSENTIALS = ['layer_height', 'initial_layer_print_height', 'wall_loops', 'top_shell_layers',
  'bottom_shell_layers', 'sparse_infill_density', 'sparse_infill_pattern', 'enable_support', 'support_type',
  'support_threshold_angle', 'brim_type', 'brim_width', 'skirt_loops', 'seam_position'];

/** "No changes from X" / "1 change from X" / "3 changes from X". */
export function changeCount(n: number, parent: string): string {
  return n === 0 ? `No changes from ${parent}` : `${n} ${n === 1 ? 'change' : 'changes'} from ${parent}`;
}

export function labelFor(key: string, prefix = /^$/): string {
  if (INFO[key]) return INFO[key].label;
  if (PLATE_TEMP.test(key)) return plateLabel(key);
  const words = key.replace(prefix, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function plateLabel(key: string): string {
  const plate: Record<string, string> = {
    textured_plate: 'Textured PEI', hot_plate: 'Smooth PEI / high temp', cool_plate: 'Cool plate',
    textured_cool_plate: 'Textured cool plate', eng_plate: 'Engineering plate', supertack_plate: 'Supertack',
  };
  const name = Object.keys(plate).sort((a, b) => b.length - a.length).find((p) => key.startsWith(p));
  return `Bed, ${name ? plate[name] : key}${key.endsWith('_initial_layer') ? ', first layer' : ''}`;
}

export function tipFor(key: string): string | undefined {
  if (INFO[key]?.tip) return INFO[key].tip;
  if (PLATE_TEMP.test(key)) return 'Bed temperature on this kind of plate. Only your printer\'s plate is used.';
  return undefined;
}

export function unitFor(key: string): string | undefined {
  return INFO[key]?.unit ?? (PLATE_TEMP.test(key) || /temperature/.test(key) ? '°C' : undefined);
}

/** ⓘ beside a label: shows on hover (title) and opens below on tap. */
export function InfoTip({ tip }: { tip: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" class="info-tip" title={tip} aria-label="What this does" aria-expanded={open}
        onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}>
        <Icon path={mdiInformationOutline} size={15} />
      </button>
      {open && <span class="tip-text">{tip}</span>}
    </>
  );
}

/** A group's summary line in Advanced: icon, name, what it's for, counts. */
export function GroupSummary({ name, count, changed, children }: {
  name: string; count: number; changed: number; children?: ComponentChildren;
}) {
  const g = GROUPS[name];
  return (
    <summary class="group-summary">
      {g && <span class="group-icon"><Icon path={g.icon} size={20} /></span>}
      <span class="group-text">
        <span class="group-name">{name} <span class="sub">{count} settings{changed ? `, ${changed} changed` : ''}</span></span>
        {g && <span class="sub group-blurb">{g.blurb}</span>}
      </span>
      {children}
    </summary>
  );
}

export interface EditableSetting { key: string; inherited: string | null }

/** The Simple view: its sections, each with an icon, then their settings. */
export function SimpleSections<T extends EditableSetting>({ sections, settings, row }: {
  sections: Section[]; settings: T[]; row: (s: T) => ComponentChildren;
}) {
  return (
    <div class="essentials">
      <p class="sub">The settings most people change. Everything else is under Advanced.</p>
      {sections.map((sec) => {
        const list = sec.keys.map((k) => settings.find((s) => s.key === k)).filter((s): s is T => !!s);
        if (list.length === 0) return null;
        return (
          <div key={sec.title} class="simple-section">
            <div class="simple-head">
              <span class="group-icon"><Icon path={sec.icon} size={18} /></span>
              <span>{sec.title}</span>
            </div>
            {list.map(row)}
          </div>
        );
      })}
    </div>
  );
}

/** Common filament colours, as quick picks. */
export const SWATCHES: [string, string][] = [
  ['#FFFFFF', 'White'], ['#000000', 'Black'], ['#8E9089', 'Grey'], ['#A6A9AA', 'Silver'], ['#C12E1F', 'Red'],
  ['#F2754E', 'Orange'], ['#F4EE2A', 'Yellow'], ['#00AE42', 'Green'], ['#56B7E6', 'Light blue'], ['#0A2989', 'Blue'],
  ['#5E43B7', 'Purple'], ['#F55A74', 'Pink'], ['#7D6556', 'Brown'], ['#E8DCC6', 'Natural'],
];

const COLOUR_KEYS = /^(default_filament_colour|filament_colour)$/;

/** A colour: a swatch that opens the system picker, quick swatches, and the hex. */
function ColourField({ value, placeholder, label, onChange }: {
  value: string; placeholder: string; label: string; onChange: (v: string) => void;
}) {
  const hex = /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : '';
  return (
    <span class="colour-field">
      <span class="colour-top">
        <label class="colour-current" style={hex ? `background:${hex}` : undefined} title="Pick any colour">
          <input type="color" value={hex || '#F2754E'} aria-label={`${label}: pick any colour`}
            onInput={(e) => onChange((e.target as HTMLInputElement).value.toUpperCase())} />
        </label>
        <input value={value} placeholder={placeholder} aria-label={label}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
      </span>
      <span class="swatches" role="group" aria-label={`${label}: quick picks`}>
        {SWATCHES.map(([c, name]) => (
          <button key={c} type="button" class="swatch-pick" style={`background:${c}`} title={name}
            aria-label={name} aria-pressed={hex.toUpperCase() === c} onClick={() => onChange(c)} />
        ))}
      </span>
    </span>
  );
}

/** One setting: plain label and tip, the value with its unit, and a reset arrow once changed. */
export function SettingRow({ s, own, setOwn, multiline, prefix }: {
  s: EditableSetting; own: Record<string, string>; setOwn: (f: (o: Record<string, string>) => Record<string, string>) => void;
  multiline: boolean; prefix?: RegExp;
}) {
  const changed = s.key in own;
  // Orca's "nil" means not set here: the printer's own value is used.
  const unset = !changed && (s.inherited == null || s.inherited === 'nil');
  const value = changed ? own[s.key] : (unset ? '' : (s.inherited ?? ''));
  const placeholder = s.inherited === 'nil' ? 'Not set: the printer\'s own' : 'Orca default';
  const set = (v: string) => setOwn((o) => ({ ...o, [s.key]: v }));
  const tip = tipFor(s.key);
  const unit = unitFor(s.key);
  const reset = () => setOwn((o) => {
    const next = { ...o };
    delete next[s.key];
    return next;
  });
  return (
    <div class={`mat-row${changed ? ' changed' : ''}${multiline ? ' multi' : ''}`}>
      <div class="mat-label">
        <span>{labelFor(s.key, prefix)}{tip && <InfoTip tip={tip} />}</span>
        <code>{s.key}</code>
      </div>
      <span class="mat-value">
        {COLOUR_KEYS.test(s.key) ? (
          <ColourField value={value} placeholder={unset ? placeholder : ''} label={labelFor(s.key, prefix)} onChange={set} />
        ) : multiline ? (
          <textarea rows={3} value={value} placeholder={unset ? placeholder : ''} aria-label={labelFor(s.key, prefix)}
            onInput={(e) => set((e.target as HTMLTextAreaElement).value)} />
        ) : (
          <input value={value} placeholder={unset ? placeholder : ''} aria-label={labelFor(s.key, prefix)}
            onInput={(e) => set((e.target as HTMLInputElement).value)} />
        )}
        <span class="unit">{unit ?? ''}</span>
      </span>
      <button type="button" class="reset" aria-label={`Reset ${labelFor(s.key, prefix)}`}
        title={`Back to ${s.inherited ?? 'Orca default'}`} disabled={!changed} onClick={reset}>↺</button>
    </div>
  );
}
