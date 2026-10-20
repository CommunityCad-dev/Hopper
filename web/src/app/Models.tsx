import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { SkeletonRows } from './Skeleton';
import { ApiError, deleteModel, listModels, modelFileUrl, uploadModel } from './api';
import { formatBytes } from './format';
import { ICONS, Icon } from './icons';
import type { ModelsList } from './types';

interface Props {
  /** Starts a new project with these models and opens it. */
  onSlice?: (names: string[]) => Promise<void>;
  onBrowse: () => void;
}

const MODEL_TYPES = '.stl,.obj,.3mf,.step,.stp';

/**
 * Models on the printer: printer_data/models, a Moonraker file root. Files
 * saved from the catalog or uploaded from this device, kept for slicing. It's the
 * owner's data: upload and download go through Moonraker's own file API.
 *
 * Laid out like Mainsail's G-Code Files on purpose -- header bar, tools, an info line,
 * a table with checkboxes and an action bar for what's selected.
 */
export function Models({ onSlice, onBrowse }: Props) {
  const [data, setData] = useState<ModelsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null);
  const [starting, setStarting] = useState(false);

  const slice = async (names: string[]) => {
    if (!onSlice) return;
    setStarting(true);
    setError(null);
    try {
      await onSlice(names);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a project.');
    } finally {
      setStarting(false);
    }
  };
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError(null);
    listModels()
      .then((next) => {
        setData(next);
        setSelected((sel) => new Set([...sel].filter((n) => next.models.some((m) => m.id === n))));
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not read the models on this printer.'),
      );
  }, []);

  useEffect(load, [load]);

  const upload = async (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length || !data) return;
    const total = files.reduce((n, f) => n + f.size, 0);
    if (data.used_bytes + total > data.cap_bytes) {
      setError(`That's more than the space left in Models (${formatBytes(data.cap_bytes - data.used_bytes)}).`);
      return;
    }
    setError(null);
    try {
      for (const file of files) {
        setUploading({ name: file.name, fraction: 0 });
        await uploadModel(file, (fraction) => setUploading({ name: file.name, fraction }));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The upload did not finish.');
    } finally {
      setUploading(null);
      load();
    }
  };

  const download = (names: string[]) => {
    // Same origin as the page, so the download attribute is honoured and the
    // browser saves the file instead of opening it.
    for (const name of names) {
      const a = document.createElement('a');
      a.href = modelFileUrl(name);
      a.download = name;
      a.rel = 'noopener';
      a.click();
    }
  };

  const removeSelected = async () => {
    setBusy(true);
    try {
      for (const name of selected) await deleteModel(name);
      setSelected(new Set());
      setConfirming(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete.');
    } finally {
      setBusy(false);
      load();
    }
  };

  const needle = query.trim().toLowerCase();
  const rows = (data?.models ?? []).filter(
    (m) => !needle || `${m.filename} ${m.title ?? ''}`.toLowerCase().includes(needle),
  );
  const allSelected = rows.length > 0 && rows.every((m) => selected.has(m.id));
  const toggle = (name: string) =>
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div class="panel">
      <div class="panel-head">
        <Icon path={ICONS.cube} />
        <span>Models on this printer</span>
      </div>

      <div class="panel-tools">
        <label class="panel-search">
          <input
            type="search" placeholder="Search" value={query} aria-label="Search models on this printer"
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <Icon path={ICONS.magnify} />
        </label>
        <button class="icon-btn upload" type="button" title="Upload from this device"
          aria-label="Upload from this device" disabled={!!uploading} onClick={() => picker.current?.click()}>
          <Icon path={ICONS.upload} />
        </button>
        <input ref={picker} type="file" accept={MODEL_TYPES} multiple hidden onChange={upload} />
        <button class="icon-btn" type="button" title="Refresh" aria-label="Refresh" onClick={load}>
          <Icon path={ICONS.refresh} />
        </button>
      </div>

      <div class="panel-info">
        <span><strong>Kept for slicing.</strong> Not in G-code files until sliced.</span>
        {data && (
          <span>
            <strong>Space used:</strong> {formatBytes(data.used_bytes) ?? '0 B'} of{' '}
            {formatBytes(data.cap_bytes)}
          </span>
        )}
      </div>

      {uploading && (
        <div class="upload-bar" role="status">
          <span>Uploading {uploading.name}… {Math.round(uploading.fraction * 100)}%</span>
          <div class="upload-track"><div style={`width:${Math.round(uploading.fraction * 100)}%`} /></div>
        </div>
      )}

      {selected.size > 0 && (
        <div class="action-bar" role="toolbar" aria-label="Selected models">
          <span>{selected.size} selected</span>
          {confirming ? (
            <>
              <button class="btn sm" type="button" disabled={busy} onClick={() => void removeSelected()}>
                {busy ? 'Deleting…' : `Delete ${selected.size}`}
              </button>
              <button class="btn ghost sm" type="button" onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : (
            <>
              <button class="btn sm" type="button" disabled={starting || !onSlice}
                onClick={() => void slice([...selected].filter((n) => data?.models.find((m) => m.id === n)?.usable))}>
                {starting ? 'Arranging…' : selected.size > 1 ? `Slice ${selected.size} together` : 'Slice'}
              </button>
              <button class="btn ghost sm" type="button" onClick={() => download([...selected])}>Download</button>
              <button class="btn ghost sm" type="button" onClick={() => setConfirming(true)}>Delete</button>
            </>
          )}
        </div>
      )}

      {error && <div class="msg warn" style="margin:0 16px 16px"><p>{error}</p></div>}
      {!data && !error && <SkeletonRows />}

      <div class="table-scroll">
        <table class="files-table">
          <thead>
            <tr>
              <th class="check-col">
                <input type="checkbox" aria-label="Select all" checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((m) => m.id)))} />
              </th>
              <th class="thumb-col" />
              <th>Name</th>
              <th class="wide-only">File size</th>
              <th class="wide-only">Saved</th>
              <th class="wide-only">From</th>
              <th class="actions-col" />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} class={selected.has(m.id) ? 'selected' : ''}>
                <td class="check-col">
                  <input type="checkbox" aria-label={`Select ${m.filename}`}
                    checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                </td>
                <td class="thumb-col">
                  {m.thumbnail_url ? (
                    <img src={m.thumbnail_url} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <Icon path={ICONS.cube} />
                  )}
                </td>
                <td class="name">{m.filename}<div class="sub narrow-only">{formatBytes(m.bytes)}</div></td>
                <td class="nowrap wide-only">{formatBytes(m.bytes)}</td>
                <td class="nowrap wide-only">{new Date(m.saved_at * 1000).toLocaleString()}</td>
                <td class="from wide-only">{m.uploaded ? 'your device' : m.title ?? ''}</td>
                <td class="actions-col nowrap">
                  {m.usable ? (
                    <button
                      class="btn sm" type="button" disabled={!onSlice || starting}
                      title="Start a new project with this model"
                      onClick={() => void slice([m.id])}
                    >
                      Slice
                    </button>
                  ) : (
                    <span class="sub">not a model</span>
                  )}{' '}
                  <a class="icon-btn sm" href={modelFileUrl(m.filename)} download={m.filename}
                    title="Download to this device" aria-label={`Download ${m.filename}`}>
                    <Icon path={ICONS.download} size={18} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && rows.length === 0 && (
        <div class="panel-empty">
          {data.models.length === 0 ? (
            <>
              <p>No models on this printer yet.</p>
              <p class="sub">
                On a model's page, <strong>Save to printer</strong> on an STL, OBJ or 3MF puts it here. Or
                upload one from this device.
              </p>
              <button class="btn ghost" type="button" onClick={onBrowse}>Browse models</button>{' '}
              <button class="btn ghost" type="button" onClick={() => picker.current?.click()}>Upload</button>
            </>
          ) : (
            <p>Nothing matches "{query}".</p>
          )}
        </div>
      )}
    </div>
  );
}
