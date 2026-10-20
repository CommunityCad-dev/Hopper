import { useRef, useState } from 'preact/hooks';

import { ApiError, exportOrcaPresets, importOrcaPresets } from './api';
import type { OrcaImportItem } from './types';

const ACCEPT = '.json,.zip,.orca_printer,.orca_filament';

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Your own OrcaSlicer presets, in and out. Import takes what desktop Orca's
 * Export Preset Bundle (or a single preset .json) makes: process presets become
 * print profiles, filament presets materials. A preview shows exactly what will be
 * written, and nothing is until Import is pressed. Export gives a .zip that Orca's
 * File > Import > Import Configs reads.
 */
export function OrcaPresets({ onImported }: { onImported?: () => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [items, setItems] = useState<OrcaImportItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const pick = async (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    setNote(null);
    setBusy(true);
    try {
      const data = await base64(f);
      const r = await importOrcaPresets(f.name, data, false);
      setFile({ name: f.name, data });
      setItems(r.items);
    } catch (err) {
      setItems(null);
      setNote(err instanceof ApiError ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await importOrcaPresets(file.name, file.data, true);
      const n = r.items.filter((i) => i.action !== 'skip').length;
      setNote(`Imported ${n} ${n === 1 ? 'preset' : 'presets'}.`);
      setItems(null);
      setFile(null);
      onImported?.();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not import.');
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    setNote(null);
    try {
      const r = await exportOrcaPresets();
      const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes]));
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setNote('In OrcaSlicer: File → Import → Import Configs, and pick this file.');
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not export.');
    }
  };

  const writes = items?.filter((i) => i.action !== 'skip') ?? [];
  return (
    <div class="orca-presets">
      <div class="foot">
        <button class="btn ghost" type="button" disabled={busy} onClick={() => picker.current?.click()}>
          {busy && !items ? 'Reading…' : 'Import from OrcaSlicer…'}
        </button>
        <button class="btn ghost" type="button" disabled={busy} onClick={() => void exportAll()}>Export to OrcaSlicer</button>
        <input ref={picker} type="file" accept={ACCEPT} hidden onChange={pick} />
      </div>
      {items && (
        <div class="import-preview">
          <strong>{file?.name}</strong>
          <ul>
            {items.map((i) => (
              <li key={`${i.kind}${i.name}`} class={i.action === 'skip' ? 'skip' : ''}>
                <span class={`tag ${i.kind}`}>{i.kind === 'profile' ? 'Profile' : i.kind === 'material' ? 'Material' : 'Printer'}</span>
                <span class="name">{i.name}</span>
                <span class="sub">
                  {i.action === 'skip' ? `skipped: ${i.note}`
                    : `${i.action === 'replace' ? 'replaces yours' : 'new'} · ${i.settings} settings`
                      + (i.inherits ? ` · from ${i.inherits}` : '')}
                  {i.note && i.action !== 'skip' ? ` · ${i.note}` : ''}
                  {(i.dropped ?? []).length > 0 ? ` · not imported: ${i.dropped!.join(', ')} (runs programs)` : ''}
                  {(i.skipped ?? []).length > 0 ? ` · ${i.skipped!.length} unknown to this Orca version, skipped` : ''}
                </span>
              </li>
            ))}
          </ul>
          <div class="foot">
            <button class="btn" type="button" disabled={busy || writes.length === 0} onClick={() => void apply()}>
              {busy ? 'Importing…' : `Import ${writes.length}`}
            </button>
            <button class="btn ghost" type="button" disabled={busy} onClick={() => { setItems(null); setFile(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div class="sub">
        {note ?? 'Profiles go to print_profiles.cfg, filaments to materials.cfg. Printer presets are skipped: the printer comes from printer.cfg.'}
      </div>
    </div>
  );
}
