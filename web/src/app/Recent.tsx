import { useEffect, useState } from 'preact/hooks';

import { getLibrary, listModels } from './api';
import { ICONS, Icon } from './icons';

const KEY = 'ccad-recent';
const KEPT = 30;

interface Viewed { id: number; title: string; thumb: string | null; at: number }

function viewed(): Viewed[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Viewed[];
    return Array.isArray(list) ? list.filter((v) => typeof v.id === 'number') : [];
  } catch { return []; }
}

/** A model page was opened: kept in this browser only, newest first. */
export function rememberViewed(model: { id: number; title: string; thumbnail_url: string | null }) {
  try {
    const next = [{ id: model.id, title: model.title, thumb: model.thumbnail_url, at: Date.now() / 1000 },
      ...viewed().filter((v) => v.id !== model.id)].slice(0, KEPT);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* private mode: nothing to remember */ }
}

interface Row { id: number; title: string; thumb: string | null; at: number; what: 'Viewed' | 'Sent to the printer' | 'Saved to the printer' }

function ago(seconds: number): string {
  const s = Date.now() / 1000 - seconds;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * Recent: models opened in this browser, and models saved or sent to this
 * printer (from the Pi, so those show on every device), newest first.
 */
export function Recent({ onOpen }: { onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cleared, setCleared] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const byId = new Map<number, Row>();
      const add = (r: Row) => {
        const had = byId.get(r.id);
        if (!had || r.at > had.at) byId.set(r.id, { ...r, thumb: r.thumb ?? had?.thumb ?? null });
        else if (!had.thumb && r.thumb) had.thumb = r.thumb;
      };
      viewed().forEach((v) => add({ ...v, what: 'Viewed' }));
      const [library, models] = await Promise.all([getLibrary().catch(() => null), listModels().catch(() => null)]);
      for (const f of Object.values(library?.files ?? {})) {
        if (f.model_id && f.sent_at) add({ id: f.model_id, title: f.title ?? 'Model', thumb: null, at: f.sent_at, what: 'Sent to the printer' });
      }
      for (const m of models?.models ?? []) {
        if (m.model_id) add({ id: m.model_id, title: m.title ?? m.filename, thumb: m.thumbnail_url ?? null, at: m.saved_at, what: 'Saved to the printer' });
      }
      if (live) setRows([...byId.values()].sort((a, b) => b.at - a.at));
    })();
    return () => { live = false; };
  }, [cleared]);

  if (!rows) return <p class="sub">Reading…</p>;
  if (rows.length === 0) {
    return (
      <div class="panel-empty">
        <p>Nothing here yet.</p>
        <p class="sub">Models you open, and models you save or send to the printer, show up here.</p>
      </div>
    );
  }
  return (
    <div class="recent">
      <ul class="recent-list">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" class="recent-row" onClick={() => onOpen(r.id)}>
              <span class="recent-thumb">
                {r.thumb ? <img src={r.thumb} alt="" decoding="async" /> : <Icon path={ICONS.cube} size={22} />}
              </span>
              <span class="recent-text">
                <span class="recent-title">{r.title}</span>
                <span class="sub">{r.what} {ago(r.at)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {viewed().length > 0 && (
        <button class="btn ghost sm" type="button" onClick={() => {
          try { localStorage.removeItem(KEY); } catch { /* nothing kept */ }
          setCleared((n) => n + 1);
        }}>Clear viewed</button>
      )}
    </div>
  );
}
