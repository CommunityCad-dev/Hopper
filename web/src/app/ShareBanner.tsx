import { useEffect, useState } from 'preact/hooks';

import { ApiError, cancelAutoShare, listSharePrints, shareProfile } from './api';
import { autoLine } from './Share';
import type { SharePrint, SharePrints } from './types';

const DAY = 24 * 3600;
const KEY = 'ccad-share-not-now';

function notNow(): string[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { return []; }
}

/**
 * After a print of a CommunityCAD model, one line:
 * - Ask me: one tap to share its profile, for a day, or Not now.
 * - Share automatically: the countdown to the Pi's share, with Don't share this
 *   one, then what was shared.
 * - Don't share: nothing.
 */
export function ShareBanner({ canShare, onOpen }: { canShare: boolean; onOpen: () => void }) {
  const [data, setData] = useState<SharePrints | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [hidden, setHidden] = useState<string[]>(notNow());
  const [, tick] = useState(0);

  const check = () => listSharePrints().then(setData).catch(() => setData(null));
  useEffect(() => {
    void check();
    const onVisible = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const now = Date.now() / 1000;
  const recent = (p: SharePrint) => now - (p.end_time ?? 0) < DAY && !hidden.includes(p.job_id);
  const counting = data?.prints.find((p) => (p.auto?.state === 'pending' || p.auto?.state === 'timelapse') && recent(p));
  const autoDone = data?.prints.find((p) => p.auto?.state === 'done' && now - (p.end_time ?? 0) < 3600 && recent(p));
  const asking = data?.mode === 'ask' ? data.prints.find((p) => !p.shared && !p.auto && recent(p)) : undefined;
  const print = counting ?? autoDone ?? asking;

  // While the Pi counts down, tick every second, and look again once it's due.
  useEffect(() => {
    if (!counting) return;
    const t = window.setInterval(() => {
      tick((n) => n + 1);
      if ((counting.auto?.at ?? 0) <= Date.now() / 1000) void check();
    }, counting.auto?.state === 'pending' ? 1000 : 15000);
    return () => window.clearInterval(t);
  }, [counting?.job_id, counting?.auto?.state]);

  if (!print) return null;
  const title = print.models[0]?.title ?? print.filename;
  const hide = () => {
    const next = [...hidden, print.job_id].slice(-50);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
    setHidden(next);
  };

  if (print === counting || print === autoDone) {
    const link = print.posted?.url ?? print.shared?.model_url;
    return (
      <div class="msg share-banner" role="status">
        <p>Your print of <strong>{title}</strong> finished. {autoLine(print.auto)}</p>
        {print === counting ? (
          <button class="btn ghost sm" type="button"
            onClick={() => void cancelAutoShare(print.job_id).then(check).catch(check)}>
            Don't share this one
          </button>
        ) : (
          <>
            {link && <a class="btn ghost sm" href={link} target="_blank" rel="noreferrer">View on CommunityCAD</a>}
            <button class="btn ghost sm" type="button" onClick={hide}>OK</button>
          </>
        )}
        <button class="btn ghost sm" type="button" onClick={onOpen}>Details</button>
      </div>
    );
  }

  const share = async () => {
    if (!canShare) { onOpen(); return; }
    setState('busy');
    try {
      const r = await shareProfile(print.job_id);
      setState('done');
      setNote(r.queued ? null : r.shared?.model_url ?? null);
      if (r.queued) setQueued(true);
    } catch (err) {
      setState('idle');
      setNote(err instanceof ApiError ? err.message : 'Could not share it.');
    }
  };

  return (
    <div class="msg share-banner" role="status">
      {state === 'done' ? (
        <p>{queued ? "Saved on the printer. It uploads when CommunityCAD answers." : 'Shared. '}
          {!queued && note && <a href={note} target="_blank" rel="noreferrer">View on CommunityCAD</a>}</p>
      ) : (
        <>
          <p>Your print of <strong>{title}</strong> finished. Share your print profile
            {data?.visibility === 'private' && !data.private_profiles ? ' publicly' : ''}?</p>
          <button class="btn sm" type="button" disabled={state === 'busy'} onClick={() => void share()}>
            {state === 'busy' ? 'Sharing…' : 'Share'}
          </button>
          <button class="btn ghost sm" type="button" onClick={onOpen}>Details</button>
          <button class="btn ghost sm" type="button" onClick={hide}>Not now</button>
          {note && <p class="sub" style="flex-basis:100%;color:#f6ad55">{note}</p>}
        </>
      )}
    </div>
  );
}
