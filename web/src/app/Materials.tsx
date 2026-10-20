import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  ApiError, deleteMaterial, getPrinter, importMaterial, listMaterials, materialDetail, materialPresets, saveMaterial,
} from './api';
import { SkeletonRows } from './Skeleton';
import {
  GroupSummary, PLATE_TEMP, SettingRow, SimpleSections, ViewSwitch, changeCount, materialSections, plateKeys, savedView,
} from './settingsGuide';
import type { EditorView } from './settingsGuide';
import { ICONS, Icon } from './icons';
import type { MaterialDetail, MaterialSetting, MaterialsList } from './types';

/**
 * Materials: printer_data/config/materials.cfg, one OrcaSlicer filament preset
 * per [material]. The list is laid out like Models and Mainsail's G-Code Files.
 */
export function Materials({ onEditing }: {
  /** A panel in Settings: told when an editor opens, so Settings gives it the page. */
  onEditing?: (open: boolean) => void;
} = {}) {
  const [data, setData] = useState<MaterialsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditingState] = useState<{ name: string; create: boolean } | null>(null);
  const setEditing = (next: { name: string; create: boolean } | null) => {
    setEditingState(next);
    onEditing?.(next !== null);
  };
  const [confirming, setConfirming] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError(null);
    listMaterials()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read materials.cfg.'));
  }, []);
  useEffect(load, [load]);

  const remove = async (name: string) => {
    try {
      await deleteMaterial(name);
      setConfirming(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that material.');
    }
  };

  const importFile = async (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    const picked = input.files?.[0];
    input.value = '';
    if (!picked) return;
    setError(null);
    try {
      const result = await importMaterial(await picked.text());
      setNote(
        `Imported "${result.saved}": ${result.settings} settings` +
          (result.inherits ? `, based on ${result.inherits}` : '') +
          (result.skipped.length ? `. Not filament settings, skipped: ${result.skipped.join(', ')}` : '.'),
      );
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import that file.');
    }
  };

  if (editing) {
    return (
      <MaterialEditor
        name={editing.name}
        create={editing.create}
        onDone={(saved) => {
          setEditing(null);
          if (saved) setNote(`Saved "${saved}" to materials.cfg.`);
          load();
        }}
      />
    );
  }

  return (
    <section class="panel settings-card" aria-label="Materials" id="ccad-materials">
      <div class="panel-head">
        <Icon path={ICONS.cube} />
        <span>Materials</span>
      </div>
      <div class="panel-tools">
        <button class="btn sm" type="button" onClick={() => setEditing({ name: '', create: true })}>
          New material
        </button>
        <button class="btn ghost sm" type="button" onClick={() => file.current?.click()}>
          Import from OrcaSlicer
        </button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={importFile} />
        <button class="icon-btn" type="button" title="Refresh" aria-label="Refresh" onClick={load}>
          <Icon path={ICONS.refresh} />
        </button>
      </div>
      <div class="panel-info">
        <span>
          Kept in <strong title={data?.path}>{data?.path.split('/').pop() ?? 'materials.cfg'}</strong>, beside printer.cfg. Editable in Mainsail too.
        </span>
      </div>
      {note && <p class="sub" style="margin:8px 16px">{note}</p>}
      {error && <div class="msg warn" style="margin:8px 16px"><p>{error}</p></div>}
      {!data && !error && <SkeletonRows />}
      {data && data.problems.length > 0 && (
        <div class="msg warn" style="margin:8px 16px;text-align:left">
          <p><strong>materials.cfg has lines the slicer ignores:</strong></p>
          {data.problems.map((p) => <p key={p} class="sub">{p}</p>)}
        </div>
      )}
      <div class="table-scroll">
        <table class="files-table">
          <thead>
            <tr>
              <th>Name</th>
              <th class="wide-only">Based on</th>
              <th>Settings</th>
              <th class="actions-col" />
            </tr>
          </thead>
          <tbody>
            {(data?.materials ?? []).map((m) => (
              <tr key={m.name}>
                <td class="name">{m.name}</td>
                <td class="from wide-only">{m.inherits || 'none'}</td>
                <td class="nowrap sub">{m.changed ? `${m.changed} changed` : 'As in Orca'}</td>
                <td class="actions-col nowrap">
                  {confirming === m.name ? (
                    <>
                      <button class="btn sm" type="button" onClick={() => void remove(m.name)}>Delete</button>{' '}
                      <button class="btn ghost sm" type="button" onClick={() => setConfirming(null)}>Keep</button>
                    </>
                  ) : (
                    <>
                      <button class="btn sm" type="button" onClick={() => setEditing({ name: m.name, create: false })}>
                        Edit
                      </button>{' '}
                      <button class="icon-btn sm" type="button" title="Delete" aria-label={`Delete ${m.name}`}
                        onClick={() => setConfirming(m.name)}>
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
    </section>
  );
}


const MULTILINE = /_gcode$|_notes$|ramming_parameters$/;
const GROUP_ORDER = ['Filament', 'Temperature', 'Cooling', 'Pressure advance', 'Retraction', 'G-code',
  'Ironing', 'Multi-material'];

function MaterialEditor({ name, create, onDone }: {
  name: string; create: boolean; onDone: (saved: string | null) => void;
}) {
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [newName, setNewName] = useState(name);
  const [inherits, setInherits] = useState('Generic PLA @System');
  const [own, setOwn] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<string[]>([]);
  const [presetQuery, setPresetQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<EditorView>(savedView);
  // The bed temperatures that matter are the ones for this printer's plate.
  const [bedSurface, setBedSurface] = useState<string | null>(null);
  useEffect(() => { getPrinter().then((r) => setBedSurface(r.printer?.bed_surface ?? null)).catch(() => undefined); }, []);

  useEffect(() => {
    materialPresets().then((r) => setPresets(r.presets)).catch(() => undefined);
    // A new material shows a generic PLA's settings until a parent is chosen.
    const source = create ? null : name;
    if (!source) return;
    materialDetail(source)
      .then((d) => {
        setDetail(d);
        setInherits(d.inherits);
        setOwn(Object.fromEntries(d.settings.filter((s) => s.changed).map((s) => [s.key, s.value ?? ''])));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read that material.'));
  }, [name, create]);

  // For a new material, read a template's settings for display: the existing PLA.
  useEffect(() => {
    if (!create) return;
    materialDetail('PLA').then(setDetail).catch(() => undefined);
  }, [create]);

  const matches = useMemo(() => {
    const q = presetQuery.trim().toLowerCase();
    if (!q) return [];
    return presets.filter((p) => p.toLowerCase().includes(q)).slice(0, 30);
  }, [presets, presetQuery]);

  const settings: MaterialSetting[] = detail?.settings ?? [];
  const groups = GROUP_ORDER.map((g) => [g, settings.filter((s) => s.group === g)] as const)
    .filter(([, list]) => list.length > 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveMaterial({
        name: newName.trim(), inherits, values: own,
        old_name: create ? undefined : name, create,
      });
      onDone(result.saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="panel">
      <div class="panel-head">
        <button class="icon-btn sm" type="button" aria-label="Back to materials" onClick={() => onDone(null)}>←</button>
        <span>{create ? 'New material' : name}</span>
      </div>
      <div class="slice-body">
        <div class="field">
          <label>Name</label>
          <input value={newName} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label>Based on (OrcaSlicer filament preset, <code>inherits</code>)</label>
          <div class="sub">{inherits || 'none: only the settings below'}{detail && !detail.inherits_known && inherits
            ? ' (not found in this OrcaSlicer)' : ''}</div>
          <input placeholder="Search Orca's presets, e.g. Polymaker PETG" value={presetQuery}
            onInput={(e) => setPresetQuery((e.target as HTMLInputElement).value)} />
          {matches.length > 0 && (
            <div class="preset-list">
              {matches.map((p) => (
                <button key={p} class="link-btn" type="button" onClick={() => { setInherits(p); setPresetQuery(''); }}>
                  {p}
                </button>
              ))}
            </div>
          )}
          {inherits !== (detail?.inherits ?? inherits) && (
            <div class="sub">Inherited values below update after saving.</div>
          )}
        </div>

        <div class="editor-view">
          <ViewSwitch view={view} onChange={setView} />
          {view === 'advanced' && (
            <label class="sub">
              <input type="checkbox" checked={onlyChanged}
                onChange={(e) => setOnlyChanged((e.target as HTMLInputElement).checked)} /> Only changed settings
            </label>
          )}
        </div>

        {view === 'simple' ? (
          <SimpleSections sections={materialSections(bedSurface)} settings={settings}
            row={(s) => <SettingRow key={s.key} s={s} own={own} setOwn={setOwn} multiline={false} prefix={/^filament_/} />} />
        ) : groups.map(([group, list]) => {
          const shown = onlyChanged ? list.filter((s) => s.key in own) : list;
          if (shown.length === 0) return null;
          const changedHere = list.filter((s) => s.key in own).length;
          // Temperature: this printer's plate first; the other plates out of the way.
          const mine = plateKeys(bedSurface);
          const otherPlates = group === 'Temperature' ? shown.filter((s) => PLATE_TEMP.test(s.key) && !mine.includes(s.key)) : [];
          const main = shown.filter((s) => !otherPlates.includes(s));
          const row = (s: MaterialSetting) => (
            <SettingRow key={s.key} s={s} own={own} setOwn={setOwn} multiline={MULTILINE.test(s.key)} prefix={/^filament_/} />
          );
          return (
            <details key={group} class="mat-group" open={changedHere > 0 && group !== 'Multi-material'}>
              <GroupSummary name={group} count={list.length} changed={changedHere} />
              {main.map(row)}
              {otherPlates.length > 0 && (
                <details class="mat-subgroup">
                  <summary class="sub">Other build plates ({otherPlates.length})</summary>
                  {otherPlates.map(row)}
                </details>
              )}
            </details>
          );
        })}

        {error && <div class="msg warn"><p>{error}</p></div>}
        <div class="foot sticky-foot">
          <button class="btn" type="button" disabled={busy || !newName.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save to materials.cfg'}
          </button>
          <span class="sub">{changeCount(Object.keys(own).length, inherits || 'nothing')}</span>
        </div>
      </div>
    </div>
  );
}
