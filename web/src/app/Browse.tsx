import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { ApiError, downloadCheck, saveSettings, search, setPermissions } from './api';
import { FILE_TYPE_CHOICES, describeDownloadCost, typeLabel } from './format';
import { ICONS, Icon } from './icons';
import { ModelCardView } from './ModelCard';
import { ConfirmSheet } from './ConfirmSheet';
import { addToPlate, loadPlate, plateProject, savePlate, sliceableFiles } from './plate';
import type { PlateState } from './plate';
import { Recent } from './Recent';
import type { BuildVolume, ModelCard, ModelFile, ProjectEntry } from './types';

const PAGE = 24;

interface Props {
  /** Reading the printer's settings isn't allowed yet: offer it where it's needed. */
  canAllow?: boolean;
  onAllowed?: () => void;
  onSettings?: () => void;
  volume: BuildVolume | null;
  defaultTab: 'fits' | 'all';
  /** "" for all types, else one of the platform's printable types. */
  defaultFileType: string;
  onOpen: (id: number) => void;
  onReconnect: () => void;
  /** Linked to an account: offer My models. */
  linked?: boolean;
  /** Open the plate you're building in the slicer. */
  onOpenProject?: (project: ProjectEntry) => void;
}

/** Sort choices: the platform's own order first, then its sort fields. */
export const SORTS: [string, string][] = [
  ['', 'Best match'],
  ['created_at:desc', 'Newest'],
  ['download_count:desc', 'Most downloaded'],
  ['like_count:desc', 'Most liked'],
  ['print_count:desc', 'Most printed'],
  ['total_size_bytes:asc', 'Smallest first'],
];
const SORT_KEY = 'ccad-browse-sort';

function savedSort(): string {
  try {
    const v = localStorage.getItem(SORT_KEY) ?? '';
    return SORTS.some(([k]) => k === v) ? v : '';
  } catch { return ''; }
}

export function Browse({
  volume, defaultTab, defaultFileType, onOpen, onReconnect, canAllow = false, onAllowed, onSettings, linked = false,
  onOpenProject,
}: Props) {
  // The plate you're building with the + on cards.
  const [plate, setPlate] = useState<PlateState | null>(loadPlate);
  const [plateEntry, setPlateEntry] = useState<ProjectEntry | null>(null);
  const [adding, setAdding] = useState<{ modelId: number; fileId: number | null } | null>(null);
  const [picking, setPicking] = useState<{ modelId: number; title: string; files: ModelFile[]; chosen: number[] } | null>(null);
  // A failure on one card shows on that card; modelId null puts it under the results.
  const [plateNote, setPlateNoteState] = useState<{ modelId: number | null; text: string } | null>(null);
  const setPlateNote = (text: string | null, modelId: number | null = null) =>
    setPlateNoteState(text ? { modelId, text } : null);
  useEffect(() => {
    void plateProject(plate).then((p) => {
      setPlateEntry(p);
      if (plate && !p) { savePlate(null); setPlate(null); }
    }).catch(() => undefined);
  }, []);
  const add = async (modelId: number, fileIds: number[]) => {
    setPicking(null);
    setPlateNote(null);
    setAdding({ modelId, fileId: fileIds[0] ?? null });
    try {
      const r = await addToPlate(modelId, fileIds, plate);
      setPlate(r.plate);
      setPlateEntry(r.project);
    } catch (err) {
      let text = err instanceof Error ? err.message : 'Could not add it to the plate.';
      // A 429 here is usually one file's daily cap on links, not the printer being
      // limited: ask the Pi which, so the card can say so and when it resets.
      if (err instanceof ApiError && err.kind === 'rate_limited' && fileIds[0] != null) {
        const check = await downloadCheck(modelId, fileIds[0]).catch(() => null);
        if (check?.reason === 'issue_cap_reached') text = describeDownloadCost(check) ?? text;
      }
      setPlateNote(text, modelId);
    } finally {
      setAdding(null);
    }
  };
  const onAdd = async (modelId: number) => {
    setPlateNote(null);
    setAdding({ modelId, fileId: null });
    try {
      const { title, files } = await sliceableFiles(modelId);
      if (files.length === 0) {
        setAdding(null);
        setPlateNote(`${title} has no model file to slice.`, modelId);
      } else if (files.length === 1) {
        await add(modelId, [files[0].id]);
      } else {
        setAdding(null);
        setPicking({ modelId, title, files, chosen: files.map((f) => f.id) });
      }
    } catch (err) {
      setAdding(null);
      setPlateNote(err instanceof ApiError ? err.message : 'Could not read that model.', modelId);
    }
  };
  const onPlate = (plateEntry?.sources ?? []).reduce((n, s) => n + s.copies, 0);
  // A printer with no known build volume cannot answer "does it fit", so offering
  // the tab would be a lie. Fall back to All.
  const canFilter = Boolean(volume?.fit_filtering);
  const [tab, setTab] = useState<'fits' | 'all' | 'mine' | 'recent'>(canFilter ? defaultTab : 'all');
  const [why, setWhy] = useState(false);
  const allow = async () => {
    await setPermissions({ printer_settings: true }).catch(() => undefined);
    setWhy(false);
    onAllowed?.();
  };
  const [fileType, setFileType] = useState(defaultFileType);
  const [sort, setSort] = useState(savedSort);
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ModelCard[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  // Ignore a slow response that lost the race to a newer one, so a fast second
  // search is never overwritten by a slow first.
  const requestId = useRef(0);

  useEffect(() => {
    if (canFilter && why) setWhy(false);
  }, [canFilter]);

  const load = useCallback(
    async (offset: number) => {
      if (tab === 'recent') return;
      const id = ++requestId.current;
      setLoading(true);
      if (offset === 0) setError(null);
      try {
        const result = await search({
          q: query,
          fit: tab === 'fits' ? 'only' : 'any',
          mine: tab === 'mine' ? 1 : undefined,
          limit: PAGE,
          offset,
          types: fileType || undefined,
          sort: sort || undefined,
        });
        if (id !== requestId.current) return;
        setItems((prev) => (offset === 0 ? result.items : [...prev, ...result.items]));
        setTotal(result.total);
      } catch (err) {
        if (id !== requestId.current) return;
        // A search outage while the rest of the API is up gets its own wording, so
        // it does not read as "the whole site is down".
        let message = 'Search is temporarily unavailable.';
        if (err instanceof ApiError) {
          setDisconnected(err.kind === 'unlinked');
          message = err.kind === 'server' ? 'Search is temporarily unavailable.' : err.message;
        }
        setError(message);
        if (offset === 0) setItems([]);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [query, tab, fileType, sort],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const chooseType = (next: string) => {
    setFileType(next);
    // Remembered per printer on the Pi, like the default tab. Not worth an error if
    // it doesn't save: the filter still applies now.
    saveSettings({ file_type: next }).catch(() => undefined);
  };

  const submit = (ev: Event) => {
    ev.preventDefault();
    setQuery(term.trim());
    if (tab === 'recent') setTab('all');   // a search is for the catalog, not the history
  };

  return (
    <div class="panel">
      <div class="panel-head">
        <Icon path={ICONS.magnify} />
        <span>Browse</span>
        {volume && (
          <span class="sub head-note">
            {volume.fit_filtering
              ? `${Math.round(volume.x)} × ${Math.round(volume.y)} × ${Math.round(volume.z)} mm`
              : 'Delta printer: showing everything'}
          </span>
        )}
      </div>
      <div class="panel-body">

      <form class="search" onSubmit={submit}>
        <input
          type="search"
          placeholder="Search models"
          value={term}
          onInput={(ev) => setTerm((ev.target as HTMLInputElement).value)}
          aria-label="Search models"
        />
        <button class="btn" type="submit">Search</button>
      </form>

      <div class="tabs" role="tablist">
        <button
          type="button" role="tab"
          aria-selected={tab === 'fits'}
          class={canFilter ? 'tab' : 'tab unavailable'}
          onClick={() => (canFilter ? setTab('fits') : setWhy((w) => !w))}
        >
          Fits your printer
        </button>
        <button
          class="tab" type="button" role="tab"
          aria-selected={tab === 'all'}
          onClick={() => setTab('all')}
        >
          All
        </button>
        {linked && (
          <button
            class="tab" type="button" role="tab"
            aria-selected={tab === 'mine'}
            title="Everything on your account, private models included"
            onClick={() => setTab('mine')}
          >
            My models
          </button>
        )}
        <button
          class="tab" type="button" role="tab"
          aria-selected={tab === 'recent'}
          title="Models you opened, saved or sent to this printer"
          onClick={() => setTab('recent')}
        >
          Recent
        </button>
        {tab !== 'recent' && !loading && !error && <span class="sub">{total} models</span>}
        {tab !== 'recent' && (
          <select class="setting-select sort-select" value={sort} aria-label="Sort"
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setSort(v);
              try { localStorage.setItem(SORT_KEY, v); } catch { /* private mode */ }
            }}>
            {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        )}
      </div>

      {tab !== 'recent' && (
      <div class="chips" role="group" aria-label="File type">
        {FILE_TYPE_CHOICES.map((t) => (
          <button
            key={t || 'all'} class="tab chip" type="button"
            aria-pressed={fileType === t}
            onClick={() => chooseType(t)}
          >
            {t ? typeLabel(t) : 'All types'}
          </button>
        ))}
      </div>
      )}

      {why && !canFilter && (
        <div class="msg" style="text-align:left">
          <p>
            <strong>Fits needs this printer's bed size.</strong>{' '}
            {canAllow
              ? "The plugin hasn't been allowed to read the printer's settings, where the bed size is."
              : 'Klipper isn\'t reporting it right now.'}
          </p>
          <div class="foot">
            {canAllow && (
              <button class="btn sm" type="button" onClick={() => void allow()}>
                Allow reading this printer's settings
              </button>
            )}
            <button class="btn ghost sm" type="button" onClick={() => onSettings?.()}>Type the bed size</button>
          </div>
        </div>
      )}

      {tab === 'recent' ? <Recent onOpen={onOpen} /> : (
      <>
      {error && (
        <div class="msg warn">
          <p>{error}</p>
          {disconnected ? (
            <button class="btn" type="button" onClick={onReconnect}>Reconnect</button>
          ) : (
            <button class="btn" type="button" onClick={() => void load(0)}>Retry</button>
          )}
        </div>
      )}

      {!error && (
        <div class="grid">
          {items.map((model) => (
            <ModelCardView key={model.id} model={model} volume={volume} onOpen={onOpen}
              onAdd={linked ? (id) => void onAdd(id) : undefined}
              added={!!plate?.modelIds.includes(model.id)}
              adding={adding?.modelId === model.id ? adding : null}
              note={plateNote?.modelId === model.id ? plateNote.text : null}
              onDismiss={() => setPlateNote(null)} />
          ))}
          {loading && items.length === 0 &&
            Array.from({ length: 8 }, (_, i) => <div class="skeleton" key={`s${i}`} />)}
        </div>
      )}

      {!error && !loading && items.length === 0 && (
        <div class="msg">
          <p>
            {fileType
              ? `No ${typeLabel(fileType)} models in this search${tab === 'fits' ? ' that fit your printer' : ''}.`
              : tab === 'fits'
                ? 'Nothing in this search fits your printer. Try the All tab.'
                : tab === 'mine'
                  ? (query ? 'None of your models matched.' : "You haven't uploaded any models to CommunityCAD yet.")
                  : 'No models matched.'}
          </p>
        </div>
      )}

      {!error && items.length < total && (
        <div class="more">
          <button
            class="btn ghost" type="button" disabled={loading}
            onClick={() => void load(items.length)}
          >
            {loading ? 'Loading…' : `Show more (${total - items.length} left)`}
          </button>
        </div>
      )}
      </>
      )}
      {plateNote && plateNote.modelId == null && <p class="sub plate-note" role="status">{plateNote.text}</p>}
      {picking && (
        <ConfirmSheet label="Add to your plate" onClose={() => setPicking(null)}>
          <strong class="confirm-title">Add {picking.title} to your plate</strong>
          <p class="sub">It has {picking.files.length} model files. Untick any you don't want.</p>
          {picking.files.map((f) => (
            <label key={f.id} class="sub check plate-pick">
              <input type="checkbox" checked={picking.chosen.includes(f.id)}
                onChange={(e) => setPicking((p) => p && ({ ...p, chosen: (e.target as HTMLInputElement).checked
                  ? [...p.chosen, f.id] : p.chosen.filter((x) => x !== f.id) }))} />
              {f.path.split('/').pop()}
            </label>
          ))}
          <div class="acts">
            <button class="btn" type="button" disabled={picking.chosen.length === 0}
              onClick={() => void add(picking.modelId, picking.chosen)}>
              Add {picking.chosen.length} to the plate
            </button>
          </div>
        </ConfirmSheet>
      )}
      {plate && plateEntry && (
        <div class="plate-bar" role="region" aria-label="Your plate">
          <span><strong>Plate:</strong> {onPlate} {onPlate === 1 ? 'model' : 'models'}</span>
          <button class="btn sm" type="button" onClick={() => onOpenProject?.(plateEntry)}>Open in slicer</button>
          <button class="btn ghost sm" type="button" title="Forget this plate here; the project stays in Projects"
            onClick={() => { savePlate(null); setPlate(null); setPlateEntry(null); }}>Clear</button>
        </div>
      )}
      </div>
    </div>
  );
}
