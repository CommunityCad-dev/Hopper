import { useState } from 'preact/hooks';

import { ApiError, saveProfile } from './api';
import type { ProcessInfo, ProfilesList } from './types';

type Tab = 'quality' | 'strength' | 'support' | 'others';


/** Orca's own labels for its values. */
const CHOICE_LABELS: Record<string, string> = {
  crosshatch: 'Cross Hatch', grid: 'Grid', gyroid: 'Gyroid', cubic: 'Cubic', adaptivecubic: 'Adaptive Cubic',
  rectilinear: 'Rectilinear', line: 'Line', triangles: 'Triangles', honeycomb: 'Honeycomb',
  '3dhoneycomb': '3D Honeycomb', lightning: 'Lightning', concentric: 'Concentric',
  'normal(auto)': 'Normal (auto)', 'tree(auto)': 'Tree (auto)',
  auto_brim: 'Auto', outer_only: 'Outer brim only', inner_only: 'Inner brim only',
  outer_and_inner: 'Outer and inner brim', no_brim: 'No-brim',
};

/** What each tab holds, with Orca's labels and units. */
const FIELDS: Record<Tab, [string, string, string?][]> = {
  quality: [['layer_height', 'Layer height', 'mm']],
  strength: [
    ['wall_loops', 'Wall loops'], ['top_shell_layers', 'Top shell layers'],
    ['bottom_shell_layers', 'Bottom shell layers'], ['sparse_infill_density', 'Sparse infill density', '%'],
    ['sparse_infill_pattern', 'Sparse infill pattern'],
  ],
  support: [
    ['enable_support', 'Enable support'], ['support_type', 'Type'],
    ['support_threshold_angle', 'Threshold angle', '°'], ['support_on_build_plate_only', 'On build plate only'],
  ],
  others: [
    ['brim_type', 'Brim type'], ['brim_width', 'Brim width', 'mm'],
    ['skirt_loops', 'Skirt loops'], ['skirt_distance', 'Skirt distance', 'mm'],
  ],
};

interface Props {
  info: ProcessInfo | null;
  error: string | null;
  profile: string;
  profiles: ProfilesList | null;
  process: Record<string, string>;
  disabled: boolean;
  onProfile: (name: string) => void;
  onProcess: (process: Record<string, string>) => void;
  /** After Save as profile / Update profile: the lists and values changed. */
  onProfilesChanged: () => void;
}

/** The value in effect: the user's change, else the preset's. */
export function effective(info: ProcessInfo | null, profile: string,
  process: Record<string, string>, key: string): string | undefined {
  return process[key] ?? info?.defaults[profile]?.[key];
}

/** The one-line summary under Process, as Orca's sidebar shows the essentials. */
export function processSummary(info: ProcessInfo | null, profile: string,
  process: Record<string, string>): string {
  const v = (k: string) => effective(info, profile, process, k);
  if (!info?.defaults[profile]) return profile;
  const brim = v('brim_type');
  return [
    `${v('layer_height')} mm`, `${v('wall_loops')} walls`, v('sparse_infill_density'),
    v('enable_support') === '1' ? 'supports' : 'no supports',
    brim && brim !== 'no_brim' ? 'brim' : '',
  ].filter(Boolean).join(' · ');
}

/**
 * Process, as in Orca's sidebar: a preset, then the settings the plugin lets
 * a user change, in Orca's tabs and words. A changed value has a reset arrow, as
 * in Orca. The Pi checks every value again; this only keeps typing honest.
 */
export function ProcessSettings({
  info, error, profile, profiles, process, disabled, onProfile, onProcess, onProfilesChanged,
}: Props) {
  const quality = profile;
  const [tab, setTab] = useState<Tab>('quality');
  const [naming, setNaming] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const custom = profiles?.custom.find((c) => c.name === profile);
  // Old projects carry their choices even where they equal the preset: only a real
  // difference counts as a change.
  const differs = (key: string) => key in process && process[key] !== info?.defaults[quality]?.[key];
  const changed = Object.keys(process).filter(differs).length;

  const set = (key: string, value: string) => {
    const next = { ...process };
    if (value === info?.defaults[quality]?.[key]) delete next[key];
    else next[key] = value;
    onProcess(next);
  };
  const reset = (key: string) => {
    const next = { ...process };
    delete next[key];
    onProcess(next);
  };

  // Save as profile / Update profile: the profile's values plus this
  // project's changes, into print_profiles.cfg; the project then just uses it.
  const save = async (name: string, create: boolean) => {
    setSaveNote(null);
    const base = custom ? { ...custom.values } : {};
    const values = { ...base, ...Object.fromEntries(Object.entries(process).filter(([k]) => differs(k))) };
    try {
      await saveProfile({ name, inherits: custom?.inherits ?? profile, values, create });
      setNaming(null);
      onProfilesChanged();
      onProfile(name);
      onProcess({});
      setSaveNote(`Saved to ${profiles?.path.split('/').pop() ?? 'print_profiles.cfg'} as “${name}”.`);
    } catch (err) {
      setSaveNote(err instanceof ApiError ? err.message : 'Could not save the profile.');
    }
  };

  const field = ([key, label, unit]: [string, string, string?]) => {
    const spec = info?.settings[key];
    if (!spec) return null;
    const value = effective(info, quality, process, key) ?? '';
    const isChanged = differs(key);
    let input;
    if (spec.type === 'bool') {
      input = (
        <input type="checkbox" class="switch" checked={value === '1'} disabled={disabled} aria-label={label}
          onChange={(e) => set(key, (e.target as HTMLInputElement).checked ? '1' : '0')} />
      );
    } else if (spec.type === 'choice') {
      input = (
        <select value={value} disabled={disabled} aria-label={label}
          onChange={(e) => set(key, (e.target as HTMLSelectElement).value)}>
          {(spec.choices ?? []).map((c) => <option key={c} value={c}>{CHOICE_LABELS[c] ?? c}</option>)}
        </select>
      );
    } else {
      const shown = spec.type === 'percent' ? value.replace('%', '') : value;
      input = (
        <span class="num">
          <input type="number" inputMode="decimal" value={shown} disabled={disabled} aria-label={label}
            min={spec.min} max={spec.max} step={spec.type === 'float' ? (key === 'layer_height' ? 0.01 : 0.5) : 1}
            onChange={(e) => {
              const el = e.target as HTMLInputElement;
              let n = Number(el.value);
              if (el.value === '' || Number.isNaN(n)) { el.value = shown; return; }
              n = Math.min(spec.max ?? n, Math.max(spec.min ?? n, n));
              if (spec.type !== 'float') n = Math.round(n);
              const text = spec.type === 'percent' ? `${n}%` : String(Number(n.toFixed(3)));
              el.value = spec.type === 'percent' ? String(n) : text;
              set(key, text);
            }} />
          {unit && <span class="unit">{unit}</span>}
        </span>
      );
    }
    return (
      <div key={key} class={`proc-row${isChanged ? ' changed' : ''}`}>
        <label>{label}</label>
        {input}
        <button type="button" class="reset" aria-label={`Reset ${label}`} title="Back to the preset's value"
          disabled={!isChanged || disabled} onClick={() => reset(key)}>↺</button>
      </div>
    );
  };

  return (
    <div class="proc">
      <div class="proc-preset">
        <select value={profile} disabled={disabled} aria-label="Print profile"
          onChange={(e) => {
            // A new profile brings its own layer height: drop that change, keep the rest.
            const { layer_height: _drop, ...rest } = process;
            onProfile((e.target as HTMLSelectElement).value);
            onProcess(rest);
            setSaveNote(null);
          }}>
          {!profiles?.defaults.some((d) => d.name === profile) && !custom && <option value={profile}>{profile}</option>}
          {(profiles?.custom.length ?? 0) > 0 && (
            <optgroup label="Custom">
              {profiles!.custom.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </optgroup>
          )}
          <optgroup label="Default">
            {(profiles?.defaults ?? []).map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </optgroup>
        </select>
        {changed > 0 && (
          <button type="button" class="btn ghost sm" disabled={disabled} onClick={() => onProcess({})}>
            Reset {changed}
          </button>
        )}
      </div>
      {changed > 0 && naming === null && (
        <div class="proc-save">
          {custom && (
            <button type="button" class="btn sm" disabled={disabled} onClick={() => void save(custom.name, false)}>
              Update “{custom.name}”
            </button>
          )}
          <button type="button" class="btn ghost sm" disabled={disabled} onClick={() => setNaming('')}>
            Save as profile…
          </button>
        </div>
      )}
      {naming !== null && (
        <div class="proc-save">
          <input value={naming} placeholder="Profile name" aria-label="New profile name" disabled={disabled}
            onInput={(e) => setNaming((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && naming.trim()) void save(naming.trim(), true); }} />
          <button type="button" class="btn sm" disabled={disabled || !naming.trim()}
            onClick={() => void save(naming.trim(), true)}>Save</button>
          <button type="button" class="btn ghost sm" onClick={() => setNaming(null)}>Cancel</button>
        </div>
      )}
      {saveNote && <p class="sub">{saveNote}</p>}
      <div class="subtabs" role="tablist" aria-label="Process">
        {([['quality', 'Quality'], ['strength', 'Strength'], ['support', 'Support'], ['others', 'Others']] as const)
          .map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {label}
              {FIELDS[k].some(([key]) => differs(key)) && <span class="dot" aria-label="changed" />}
            </button>
          ))}
      </div>
      {info ? FIELDS[tab].map(field) : <p class="sub">{error ?? 'Reading the presets…'}</p>}
      {info && (tab === 'support' || tab === 'others') && (
        <p class="sub">Changing these arranges the plate again when you slice, so everything fits.</p>
      )}
    </div>
  );
}
