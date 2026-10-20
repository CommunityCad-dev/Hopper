import { useCallback, useEffect, useState } from 'preact/hooks';

import { SkeletonRows } from './Skeleton';
import {
  GroupSummary, PROFILE_SECTIONS, SettingRow, SimpleSections, ViewSwitch, changeCount, labelFor, savedView,
} from './settingsGuide';
import type { EditorView } from './settingsGuide';
import { ApiError, deleteProfile, hideProfile, exportOrcaPresets, listProfiles, profileDetail, saveProfile, saveSettings } from './api';
import { ICONS, Icon } from './icons';
import type { ProfileDetail, ProfilesList } from './types';

/**
 * Print profiles: Orca's defaults for this printer, read-only, and the
 * user's own in print_profiles.cfg, with every Orca process setting editable as
 * the Materials page does filaments. Laid out like Materials and G-Code Files.
 */
export function Profiles({ onEditing }: {
  /** A panel in Settings: told when an editor opens, so Settings gives it the page. */
  onEditing?: (open: boolean) => void;
} = {}) {
  const [data, setData] = useState<ProfilesList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditingState] = useState<{ name: string; from?: string } | null>(null);
  const setEditing = (next: { name: string; from?: string } | null) => {
    setEditingState(next);
    onEditing?.(next !== null);
  };
  // The profile new projects start from.
  const saveDefault = async (name: string) => {
    setNote(null);
    try {
      await saveSettings({ default_profile: name });
      setData((d) => (d ? { ...d, default_profile: name } : d));
      setNote(`New projects start from “${name}”.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    }
  };
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listProfiles()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read the print profiles.'));
  }, []);
  useEffect(load, [load]);

  const remove = async (name: string) => {
    try {
      await deleteProfile(name);
      setConfirming(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that profile.');
    }
  };

  // Orca's defaults are its own presets: "removing" one leaves it out of the lists.
  const hide = async (name: string, hidden: boolean) => {
    setNote(null);
    try {
      const r = await hideProfile(name, hidden);
      setConfirming(null);
      setNote(hidden
        ? `Removed "${name}" from the lists.${r.moved_to ? ` New projects now start from "${r.moved_to}".` : ''}`
        : `"${name}" is back.`);
      load();
    } catch (err) {
      setConfirming(null);
      setError(err instanceof ApiError ? err.message : 'Could not change that.');
    }
  };

  const exportOne = async (name: string) => {
    try {
      const r = await exportOrcaPresets('profile', name);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))]));
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setNote(`Exported "${name}". In OrcaSlicer: File → Import → Import Configs.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not export.');
    }
  };

  if (editing) {
    return (
      <ProfileEditor name={editing.name} from={editing.from} existing={data?.custom.map((c) => c.name) ?? []}
        defaults={data?.defaults.map((d) => d.name) ?? []}
        onDone={(saved) => {
          setEditing(null);
          if (saved) setNote(`Saved "${saved}" to print_profiles.cfg.`);
          load();
        }} />
    );
  }

  return (
    <section class="panel settings-card" aria-label="Print profiles" id="ccad-profiles">
      <div class="panel-head">
        <Icon path={ICONS.cube} />
        <span>Print profiles</span>
      </div>
      {data && (
        <div class="panel-info default-pick">
          <label>New projects start from
            <select class="setting-select" value={data.default_profile ?? ''} aria-label="Default print profile"
              onChange={(e) => void saveDefault((e.target as HTMLSelectElement).value)}>
              {data.custom.length > 0 && (
                <optgroup label="Custom">
                  {data.custom.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </optgroup>
              )}
              <optgroup label="Default">
                {data.defaults.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
              </optgroup>
            </select>
          </label>
        </div>
      )}
      <div class="panel-tools">
        <button class="btn sm" type="button" onClick={() => setEditing({ name: '', from: data?.default_profile ?? undefined })}>
          New profile
        </button>
        <button class="icon-btn" type="button" title="Refresh" aria-label="Refresh" onClick={load}>
          <Icon path={ICONS.refresh} />
        </button>
      </div>
      <div class="panel-info">
        <span>Kept in <strong title={data?.path}>{data?.path.split('/').pop() ?? 'print_profiles.cfg'}</strong>, beside printer.cfg. Editable in Mainsail too.</span>
      </div>
      {note && <p class="sub" style="margin:8px 16px">{note}</p>}
      {error && <div class="msg warn" style="margin:8px 16px"><p>{error}</p></div>}
      {!data && !error && <SkeletonRows />}
      {data && data.problems.length > 0 && (
        <div class="msg warn" style="margin:8px 16px;text-align:left">
          <p><strong>print_profiles.cfg has lines the slicer ignores:</strong></p>
          {data.problems.map((p) => <p key={p} class="sub">{p}</p>)}
        </div>
      )}
      <div class="table-scroll">
        <table class="files-table">
          <thead>
            <tr><th>Custom</th><th class="wide-only">Based on</th><th>Settings</th><th class="actions-col" /></tr>
          </thead>
          <tbody>
            {(data?.custom ?? []).map((c) => (
              <tr key={c.name}>
                <td class="name">{c.name}{data?.default_profile === c.name && <div class="sub">new projects start here</div>}</td>
                <td class="from wide-only">{c.inherits}</td>
                <td class="nowrap sub">{c.changed ? `${c.changed} changed` : 'As in Orca'}</td>
                <td class="actions-col nowrap">
                  {confirming === c.name ? (
                    <>
                      <button class="btn sm" type="button" onClick={() => void remove(c.name)}>Delete</button>{' '}
                      <button class="btn ghost sm" type="button" onClick={() => setConfirming(null)}>Keep</button>
                    </>
                  ) : (
                    <>
                      <button class="btn sm" type="button" onClick={() => setEditing({ name: c.name })}>Edit</button>{' '}
                      <button class="icon-btn sm" type="button" title="Export to OrcaSlicer"
                        aria-label={`Export ${c.name}`} onClick={() => void exportOne(c.name)}>
                        <Icon path={ICONS.download} size={18} />
                      </button>
                      <button class="icon-btn sm" type="button" title="Delete" aria-label={`Delete ${c.name}`}
                        onClick={() => setConfirming(c.name)}>
                        <Icon path={ICONS.delete} size={18} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.custom.length === 0 && (
        <div class="panel-empty">
          <p>No custom profiles yet.</p>
          <p class="sub">Start one from a default below, use Save as profile in a project, or import yours from OrcaSlicer.</p>
        </div>
      )}
      <div class="table-scroll">
        <table class="files-table">
          <thead><tr><th>Default (OrcaSlicer, for this printer)</th><th class="actions-col" /></tr></thead>
          <tbody>
            {(data?.defaults ?? []).map((d) => (
              <tr key={d.name}>
                <td class="name">{d.name}{data?.default_profile === d.name && <div class="sub">new projects start here</div>}</td>
                <td class="actions-col nowrap">
                  {confirming === `default:${d.name}` ? (
                    <>
                      <button class="btn sm" type="button" onClick={() => void hide(d.name, true)}>Remove</button>{' '}
                      <button class="btn ghost sm" type="button" onClick={() => setConfirming(null)}>Keep</button>
                    </>
                  ) : (
                    <>
                      <button class="btn ghost sm" type="button" onClick={() => setEditing({ name: '', from: d.name })}>
                        New from this
                      </button>{' '}
                      <button class="icon-btn sm" type="button" title="Remove from the lists"
                        aria-label={`Remove ${d.name}`} onClick={() => setConfirming(`default:${d.name}`)}>
                        <Icon path={ICONS.delete} size={18} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(data?.hidden?.length ?? 0) > 0 && (
        <details class="hidden-defaults">
          <summary class="sub">{data!.hidden!.length} removed Orca {data!.hidden!.length === 1 ? 'profile' : 'profiles'}</summary>
          <ul>
            {data!.hidden!.map((h) => (
              <li key={h.name}>
                <span>{h.name}</span>
                <button class="btn ghost sm" type="button" onClick={() => void hide(h.name, false)}>Restore</button>
              </li>
            ))}
          </ul>
          <p class="sub">OrcaSlicer's own presets can't be deleted, only left out of the lists. Projects already using
            one keep it.</p>
        </details>
      )}
    </section>
  );
}


const GROUPS = ['Quality', 'Strength', 'Speed', 'Support', 'Multimaterial', 'Others'];
const MULTILINE = /_gcode$|^notes$/;

function ProfileEditor({ name, from, existing, defaults, onDone }: {
  name: string; from?: string; existing: string[]; defaults: string[]; onDone: (saved: string | null) => void;
}) {
  const create = !name;
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [newName, setNewName] = useState(name);
  const [inherits, setInherits] = useState(from ?? defaults[0] ?? '');
  const [own, setOwn] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<EditorView>(savedView);

  // An existing profile: its own values. A new one: its parent's, for display.
  useEffect(() => {
    profileDetail(create ? inherits : name)
      .then((d) => {
        setDetail(d);
        if (!create) {
          setInherits(d.inherits);
          setOwn(Object.fromEntries(d.settings.filter((s) => s.changed).map((s) => [s.key, s.value ?? ''])));
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read that profile.'));
  }, [name, create ? inherits : '']);

  const settings = detail?.settings ?? [];
  const needle = query.trim().toLowerCase();
  const visible = (key: string) => (!onlyChanged || key in own)
    && (!needle || key.includes(needle.replace(/ /g, '_')) || labelFor(key).toLowerCase().includes(needle));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await saveProfile({ name: newName.trim(), inherits, values: own,
        old_name: create ? undefined : name, create: create || undefined });
      onDone(r.saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const row = (s: ProfileDetail['settings'][number]) => (
    <SettingRow key={s.key} s={s} own={own} setOwn={setOwn} multiline={MULTILINE.test(s.key)} />
  );

  const taken = create && existing.includes(newName.trim());
  return (
    <div class="panel">
      <div class="panel-head">
        <button class="icon-btn sm" type="button" aria-label="Back to profiles" onClick={() => onDone(null)}>←</button>
        <span>{create ? 'New profile' : name}</span>
      </div>
      <div class="slice-body">
        <div class="field">
          <label>Name</label>
          <input value={newName} placeholder="e.g. PETG strong"
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)} />
          {taken && <div class="sub" style="color:#f6ad55">There's already a profile called that.</div>}
        </div>
        <div class="field">
          <label>Based on (an OrcaSlicer default, <code>inherits</code>)</label>
          <select class="setting-select" value={inherits} onChange={(e) => setInherits((e.target as HTMLSelectElement).value)}>
            {!defaults.includes(inherits) && <option value={inherits}>{inherits}</option>}
            {defaults.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {!create && inherits !== detail?.inherits && <div class="sub">Inherited values below update after saving.</div>}
        </div>
        <div class="editor-view">
          <ViewSwitch view={view} onChange={setView} />
        </div>
        {view === 'simple' ? (
          <SimpleSections sections={PROFILE_SECTIONS} settings={settings} row={row} />
        ) : (
          <>
            <div class="field">
              <input type="search" placeholder="Find a setting, e.g. seam or acceleration" value={query}
                aria-label="Find a setting" onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
              <label class="sub" style="margin-top:6px">
                <input type="checkbox" checked={onlyChanged}
                  onChange={(e) => setOnlyChanged((e.target as HTMLInputElement).checked)} /> Only changed settings
              </label>
            </div>
            {GROUPS.map((group) => {
              const list = settings.filter((s) => s.group === group);
              const shown = list.filter((s) => visible(s.key));
              if (shown.length === 0) return null;
              const changedHere = list.filter((s) => s.key in own).length;
              return (
                <details key={group} class="mat-group" open={!!needle || (changedHere > 0 && group !== 'Multimaterial')}>
                  <GroupSummary name={group} count={list.length} changed={changedHere} />
                  {shown.map(row)}
                </details>
              );
            })}
          </>
        )}
        <p class="sub">Speeds and accelerations are capped at printer.cfg's max_velocity and max_accel when slicing.</p>
        {error && <div class="msg warn"><p>{error}</p></div>}
        <div class="foot sticky-foot">
          <button class="btn" type="button" disabled={busy || !newName.trim() || taken} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save to print_profiles.cfg'}
          </button>
          <span class="sub">{changeCount(Object.keys(own).length, inherits)}</span>
        </div>
      </div>
    </div>
  );
}
