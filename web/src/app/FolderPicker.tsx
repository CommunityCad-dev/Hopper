import { useEffect, useState } from 'preact/hooks';

import { currentApiBase } from './api';

/** Folders in the printer's G-code files, as Mainsail lists them: top level and one below. */
async function gcodeFolders(): Promise<string[]> {
  const list = async (path: string): Promise<string[]> => {
    const r = await fetch(`${currentApiBase()}/server/files/directory?path=${encodeURIComponent(path)}&extended=false`,
      { credentials: 'same-origin' });
    if (!r.ok) return [];
    const body = await r.json() as { result?: { dirs?: { dirname: string }[] } };
    return (body.result?.dirs ?? []).map((d) => d.dirname).filter((d) => !d.startsWith('.'));
  };
  const top = await list('gcodes');
  const nested = await Promise.all(top.map(async (d) => (await list(`gcodes/${d}`)).map((s) => `${d}/${s}`)));
  return [...top, ...nested.flat()].sort((a, b) => a.localeCompare(b));
}

const TOP = '';
const NEW = '\u0000new';

/**
 * Where a file goes in G-code files (reviewer, 2026-10-02: "native Klipper, with
 * options"): the top of G-code files, any folder already there, or a new one,
 * shown as a path the way Mainsail's file browser reads. Moonraker makes a new
 * folder on the first file sent to it.
 */
export function FolderPicker({ value, onChange, disabled, label = 'Folder in G-code files' }: {
  value: string; onChange: (folder: string) => void; disabled?: boolean; label?: string;
}) {
  const [folders, setFolders] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    gcodeFolders().then(setFolders).catch(() => setFolders([]));
  }, []);

  const options = value && !folders.includes(value) ? [...folders, value] : folders;
  const finish = () => {
    const clean = draft.trim().replace(/^\/+|\/+$/g, '');
    setTyping(false);
    if (clean) onChange(clean);
  };

  return (
    <span class="folder-picker">
      <span class="folder-root">G-code files /</span>
      {typing ? (
        <>
          <input value={draft} placeholder="new folder" aria-label="New folder name" disabled={disabled}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') setTyping(false); }} />
          <button type="button" class="btn ghost sm" disabled={disabled} onClick={finish}>OK</button>
        </>
      ) : (
        <select value={value} disabled={disabled} aria-label={label}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v === NEW) { setDraft(''); setTyping(true); } else onChange(v);
          }}>
          <option value={TOP}>(top level)</option>
          {options.map((f) => <option key={f} value={f}>{f}</option>)}
          <option value={NEW}>New folder…</option>
        </select>
      )}
    </span>
  );
}
