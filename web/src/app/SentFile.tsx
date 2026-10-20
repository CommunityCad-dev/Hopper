import { useState } from 'preact/hooks';

import { ApiError, startPrint } from './api';
import type { MatchReport } from './types';

/**
 * What happens after a file reaches the printer.
 *
 * Pre-sliced G-code only works on the printer it was sliced for, and a mismatched
 * file can drive the toolhead into the bed or melt the wrong filament. So a file with
 * warnings does not get a plain Start button: the warnings are shown and starting
 * takes a second, deliberate action. Nothing here ever starts a print on its own.
 */
export function SentFile({
  filename, match, printerState, confirm = false, onDecline, fromCatalog = false, materials, onChangeMaterial,
}: {
  filename: string;
  /** A file made by someone else on CommunityCAD, not sliced here: say so where it's started. */
  fromCatalog?: boolean;
  match: MatchReport;
  /** Klipper's print state when the file was saved: busy means Start queues. */
  printerState?: string | null;
  /** One-tap Print: shown as the confirm, right after saving. */
  confirm?: boolean;
  onDecline?: () => void;
  /** Your material profiles: picking another one is offered when it isn't what's loaded. */
  materials?: string[];
  /** Slice again with another material; the caller closes this and slices. */
  onChangeMaterial?: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  const queues = printerState === 'printing' || printerState === 'paused';
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  // Every start asks for the material to be confirmed as loaded. A file for
  // several filaments is a multi-material setup's to track, so it isn't asked.
  const sliced = match.materials ?? [];
  const multi = sliced.length > 1;
  const [loaded, setLoaded] = useState(multi);

  const warnings = match.checks.filter((c) => c.status === 'warn');
  const unknowns = match.checks.filter((c) => c.status === 'unknown');

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await startPrint(filename);
      setOutcome(result.queued ? 'Added to the print queue.' : 'Printing.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the print.');
    } finally {
      setBusy(false);
    }
  };

  if (declined) {
    return (
      <div class="sent">
        <div class="sub">Saved as <strong>{filename}</strong>, not started. It's in G-code files when you want it.</div>
      </div>
    );
  }

  return (
    <div class={confirm ? 'sent confirm' : 'sent'}>
      {confirm && <strong class="confirm-title">{queues ? 'Ready to queue' : 'Ready to print'}</strong>}
      <div class="sub">Saved as <strong>{filename}</strong></div>

      {warnings.length > 0 && (
        <div class="warnbox">
          <strong>This file was sliced for a different printer.</strong>
          <ul>
            {warnings.map((w) => <li key={w.check}>{w.detail}</li>)}
          </ul>
          <p class="sub">
            Printing it could damage your printer. It is saved either way — slice it
            for this printer instead, unless you are sure.
          </p>
        </div>
      )}

      {warnings.length === 0 && !match.confident && (
        <div class="sub">
          Could not check this file against your printer
          {unknowns.length > 0 && `: ${unknowns[0].detail.toLowerCase()}`}
        </div>
      )}

      {warnings.length === 0 && match.confident && (
        <div class="sub">Checked against your printer, no problems found.</div>
      )}

      {fromCatalog && !outcome && (
        <div class="sub">Made by another CommunityCAD user. CommunityCAD hasn't checked it, so watch the first layer.</div>
      )}

      {!outcome && multi && (
        <div class="sub">Sliced for {sliced.join(', ')}. Your multi-material setup keeps track of them.</div>
      )}
      {!outcome && !multi && (
        <div class="material-check">
          <label class="check">
            <input type="checkbox" checked={loaded} onChange={(e) => setLoaded((e.target as HTMLInputElement).checked)} />
            {sliced.length ? <span><strong>{sliced[0]}</strong> is loaded in the printer</span>
              : <span>The material this file was sliced for is loaded</span>}
          </label>
          {onChangeMaterial && materials && materials.length > 1 && (
            <label class="sub material-other">Something else loaded?
              <select class="setting-select" value="" onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v) onChangeMaterial(v);
              }}>
                <option value="">Slice for another material…</option>
                {materials.filter((m) => m !== sliced[0]).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {outcome && <div class="sub" style="color:#48bb78">{outcome}</div>}
      {error && <div class="sub" style="color:#f6ad55">{error}</div>}

      {!outcome && (
        <div class="acts">
          {warnings.length > 0 && !override ? (
            <button class="btn ghost" type="button" onClick={() => setOverride(true)}>
              Start anyway…
            </button>
          ) : (
            <button class="btn" type="button" disabled={busy || !loaded}
              title={loaded ? undefined : 'Tick that the material is loaded first'} onClick={() => void start()}>
              {busy ? 'Starting…'
                : queues ? (warnings.length > 0 ? 'Yes, add it to the queue' : 'Add to queue')
                  : warnings.length > 0 ? 'Yes, start this print' : 'Start print'}
            </button>
          )}
          {confirm && (
            <button class="btn ghost" type="button" disabled={busy}
              onClick={() => { setDeclined(true); onDecline?.(); }}>
              Don't print
            </button>
          )}
        </div>
      )}
    </div>
  );
}
