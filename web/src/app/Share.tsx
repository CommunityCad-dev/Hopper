import { useCallback, useEffect, useState } from 'preact/hooks';

import {
  ApiError, cancelAutoShare, currentApiBase, dismissSharePrint, getModel, getStatus, listSharePrints, outboxAction, setPermissions, shareProfile,
  sharePreview, upgradeScopes,
} from './api';
import { SkeletonRows } from './Skeleton';
import { ICONS, Icon } from './icons';
import { PostComposer } from './PostComposer';
import { QrSvg } from './Qr';
import type { SharePayload, SharePrint, SharePrints, Status } from './types';

const RESULT: Record<string, string> = { completed: 'Completed', cancelled: 'Cancelled', error: 'Failed' };

function duration(s?: number | null): string {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/**
 * Share: finished prints of CommunityCAD files, each with one-tap Share
 * profile and, collapsed, exactly what will be sent. Before the first share the
 * printer asks for the sharing permissions on the account.
 */
export function Share({ status, onStatus }: { status: Status; onStatus: () => void }) {
  const [data, setData] = useState<SharePrints | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listSharePrints().then(setData).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read your prints.'));
  }, []);
  useEffect(load, [load]);

  if (!status.linked) {
    return (
      <div class="panel"><div class="panel-head"><Icon path={ICONS.upload} /><span>Share</span></div>
        <div class="panel-empty"><p>Connect this printer to CommunityCAD to share your prints.</p></div></div>
    );
  }

  return (
    <div class="panel">
      <div class="panel-head"><Icon path={ICONS.upload} /><span>Share</span></div>
      <div class="slice-body">
        {data && !data.history_allowed && (
          <div class="msg" style="text-align:left">
            <p>Sharing a print needs to know how it went: allow the plugin to read this printer's print history.</p>
            <button class="btn sm" type="button" onClick={() => void setPermissions({ print_history: true }).then(() => { onStatus(); load(); })}>
              Allow reading print history
            </button>
          </div>
        )}
        {data && !data.can_share && <AddPermissions status={status} onDone={() => { onStatus(); load(); }} />}
        {error && <div class="msg warn"><p>{error}</p></div>}
        {!data && !error && <SkeletonRows />}
        {data?.prints.map((p) => (
          <PrintCard key={p.job_id} print={p} canShare={data.can_share} onChanged={load}
            privateShares={data.visibility === 'private'} privateProfiles={data.private_profiles} />
        ))}
        {data && data.history_allowed && data.prints.length === 0 && (
          <div class="panel-empty">
            <p>No prints to share yet.</p>
            <p class="sub">When a print of a CommunityCAD model finishes, it shows up here, ready to share.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** The sharing permissions, added to this printer's link without re-linking. */
function AddPermissions({ status, onDone }: { status: Status; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = status.link_pending?.upgrade ? status.link_pending : null;

  // Waiting for the approval on communitycad.dev: check every few seconds.
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => {
      void getStatus().then((s) => { if (s.account?.can_share || !s.link_pending) onDone(); });
    }, 3000);
    return () => window.clearInterval(t);
  }, [pending?.user_code]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await upgradeScopes();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not ask for the permissions.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="msg share-perm" style="text-align:left">
      {pending ? (
        <>
          <p>Approve on CommunityCAD: go to{' '}
            <a href={pending.verification_uri_complete} target="_blank" rel="noreferrer">
              {pending.verification_uri.replace(/^https?:\/\//, '')}
            </a> and enter</p>
          <div class="code">{pending.user_code}</div>
          <QrSvg text={pending.verification_uri_complete} size={150} />
          <p class="sub">Waiting for the approval. This printer stays linked as it is.</p>
        </>
      ) : (
        <>
          <p><strong>Sharing needs two more permissions on your account:</strong> post your prints, and share print
            profiles. This printer stays linked; you approve them on CommunityCAD.</p>
          <button class="btn sm" type="button" disabled={busy} onClick={() => void start()}>
            {busy ? 'Asking…' : 'Add sharing permissions'}
          </button>
        </>
      )}
      {error && <p class="sub" style="color:#f6ad55">{error}</p>}
    </div>
  );
}

/** What the Pi is doing with an automatic share, in one line. */
export function autoLine(auto: SharePrint['auto'], now = Date.now() / 1000): string | null {
  if (!auto) return null;
  const left = Math.max(0, Math.round((auto.at ?? 0) - now));
  switch (auto.state) {
    case 'pending': return left > 0 ? `Sharing automatically in ${left} s.` : 'Sharing now…';
    case 'timelapse': return 'The post waits for the timelapse to finish (up to 15 minutes).';
    case 'done': return auto.posted ? 'Shared and posted automatically.' : 'Shared automatically.';
    case 'skipped': return `Not shared automatically: ${auto.error ?? 'sharing isn\'t set up'}`;
    case 'failed': return `The automatic share didn't go through: ${auto.error ?? 'unknown error'}`;
    default: return null;
  }
}

function PrintCard({ print, canShare, onChanged, privateShares, privateProfiles }: {
  print: SharePrint; canShare: boolean; onChanged: () => void; privateShares: boolean; privateProfiles: boolean;
}) {
  const [model, setModel] = useState(print.models[0]?.model_id);
  const [preview, setPreview] = useState<SharePayload | null>(null);
  const [notShared, setNotShared] = useState<string[]>([]);
  const [image, setImage] = useState<string | null>(null);
  // Every model on the plate starts ticked. Until CommunityCAD takes a print of
  // several models, the first ticked one is credited.
  const [ticked, setTicked] = useState<number[]>(print.models.map((m) => m.model_id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  // A private model: its profile isn't shared (it would be public), and a post
  // about it is kept private. The Pi enforces both; this says so before the tap.
  const [privateModel, setPrivateModel] = useState(false);
  useEffect(() => {
    if (model) void getModel(model).then((m) => setPrivateModel(!!m.visibility && m.visibility !== 'public')).catch(() => undefined);
  }, [model]);
  const title = print.models.find((m) => m.model_id === model)?.title ?? print.filename;
  const loadPreview = (id: number | undefined) => sharePreview(print.job_id, id).then((r) => {
    setPreview(r.payload);
    setNotShared(r.not_shared ?? []);
    setImage(r.image ?? null);
  }).catch(() => undefined);
  // Unshared prints show what they'd share straight away: the picture and the summary.
  useEffect(() => { if (!print.shared) void loadPreview(model); }, [print.job_id, model]);
  const tick = (id: number, on: boolean) => {
    const next = on ? [...ticked, id] : ticked.filter((x) => x !== id);
    setTicked(next);
    const first = print.models.find((m) => next.includes(m.model_id))?.model_id;
    if (first !== undefined && first !== model) setModel(first);
  };
  const copies = (m: SharePrint['models'][number]) => (m.files ?? []).reduce((n, f) => n + f.copies, 0) || 1;
  const summary = [
    print.models.map((m) => `${m.title ?? `Model ${m.model_id}`} ×${copies(m)}`).join(' and ')
      + (print.own_parts ? ` and ${print.own_parts} of your own ${print.own_parts === 1 ? 'part' : 'parts'}` : ''),
    preview?.material?.type,
    preview?.settings?.layer_height ? `${preview.settings.layer_height} mm` : null,
    `${(RESULT[print.status ?? ''] ?? print.status ?? '').toLowerCase()}${print.print_duration ? ` in ${duration(print.print_duration)}` : ''}`,
  ].filter(Boolean).join(' · ');

  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      await shareProfile(print.job_id, model);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not share it.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="share-card">
      <div class="share-head">
        <div>
          <strong>{print.models.length > 1 ? print.models.map((m) => m.title ?? `Model ${m.model_id}`).join(' + ') : title}</strong>
          <div class="sub">
            {new Date((print.end_time ?? 0) * 1000).toLocaleString()} · {RESULT[print.status ?? ''] ?? print.status}
            {print.print_duration ? ` · ${duration(print.print_duration)}` : ''}
          </div>
        </div>
        {!print.shared && (
          <button class="icon-btn sm" type="button" title="Remove from this list" aria-label="Remove"
            onClick={() => void dismissSharePrint(print.job_id).then(onChanged)}>✕</button>
        )}
      </div>
      {!print.shared && (
        <div class="share-plate">
          {image && <img class="plate-pic" src={`${currentApiBase()}${image}`} alt="The plate that printed" />}
          <div class="share-what">
            {print.status === 'cancelled' && <p class="share-warn">This print was cancelled. Share it anyway?</p>}
            {print.status === 'error' && <p class="share-warn">This print failed. Share it anyway?</p>}
            <p class="share-summary">Share this print: {summary}</p>
            {print.models.length > 1 && (
              <div class="share-ticks" role="group" aria-label="Models to credit">
                {print.models.map((m) => (
                  <label key={m.model_id} class="sub check">
                    <input type="checkbox" checked={ticked.includes(m.model_id)}
                      disabled={ticked.length === 1 && ticked.includes(m.model_id)}
                      onChange={(e) => tick(m.model_id, (e.target as HTMLInputElement).checked)} />
                    {m.title ?? `Model ${m.model_id}`} ×{copies(m)}
                  </label>
                ))}
                <p class="sub">CommunityCAD credits one model per print for now: <strong>{title}</strong>. Every ticked
                  model will be credited once it can.</p>
              </div>
            )}
          </div>
        </div>
      )}
      {autoLine(print.auto) && print.auto?.state !== 'done' && (
        <div class="outbox-line">
          <p class="sub">{autoLine(print.auto)}</p>
          {(print.auto?.state === 'pending' || print.auto?.state === 'timelapse') && (
            <button class="btn ghost sm" type="button"
              onClick={() => void cancelAutoShare(print.job_id).then(onChanged).catch(onChanged)}>
              Don't share this one
            </button>
          )}
        </div>
      )}
      {print.outbox && !print.shared && (
        <div class="outbox-line">
          <p class="sub">
            {print.outbox.state === 'waiting'
              ? `Waiting to upload: CommunityCAD didn't answer. It tries again${print.outbox.next_at
                ? ` at ${new Date(print.outbox.next_at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.`
              : `Not uploaded: ${print.outbox.error ?? 'CommunityCAD refused it'}.`}
          </p>
          <button class="btn ghost sm" type="button" disabled={busy}
            onClick={() => { setBusy(true); setError(null); void outboxAction(print.outbox!.id, 'retry')
              .then(onChanged).catch((err) => setError(err instanceof ApiError ? err.message : 'Still not through.'))
              .finally(() => setBusy(false)); }}>Try now</button>
          <button class="btn ghost sm" type="button" disabled={busy}
            onClick={() => void outboxAction(print.outbox!.id, 'delete').then(onChanged)}>Delete</button>
        </div>
      )}
      {print.shared ? (
        <p class="sub">
          Profile shared{print.shared.print_count ? `: printed ${print.shared.print_count} times now` : ''}.{' '}
          {print.shared.model_url && <a href={print.shared.model_url} target="_blank" rel="noreferrer">View on CommunityCAD</a>}
        </p>
      ) : (
        <>
          {privateModel && !privateProfiles && (
            <p class="sub">{title} is private on CommunityCAD, so its print profile isn't shared: it would be public.
              You can still post about it privately.</p>
          )}
          <div class="foot" style={print.outbox ? 'display:none' : undefined}>
            <button class="btn sm" type="button" disabled={busy || !canShare || (privateModel && !privateProfiles)}
              onClick={() => void share()}>
              {busy ? 'Sharing…' : privateShares && !privateProfiles ? 'Share profile (public)' : 'Share profile'}
            </button>
          </div>
          <details class="share-details" onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open && !preview) void loadPreview(model);
          }}>
            <summary class="sub">What will be shared</summary>
            {preview ? (
              <ul class="facts">
                <li><span>Model</span><span>{title}</span></li>
                <li><span>Printer</span><span>{[preview.printer_name, preview.printer_kinematics].filter(Boolean).join(', ') || 'not shared'}</span></li>
                <li><span>Slicer</span><span>{[preview.slicer, preview.slicer_version].filter(Boolean).join(' ') || 'unknown'}</span></li>
                <li><span>Material</span><span>{preview.material ? Object.values(preview.material).join(' · ') : 'unknown'}</span></li>
                <li><span>Result</span><span>{RESULT[preview.result]}{preview.print_duration_s ? `, ${duration(preview.print_duration_s)}` : ''}</span></li>
                <li><span>Settings</span><span>{Object.keys(preview.settings).length} from the file</span></li>
                {Object.entries(preview.settings).map(([k, v]) => (
                  <li key={k} class="setting"><span><code>{k}</code></span><span>{v}</span></li>
                ))}
              </ul>
            ) : <p class="sub">Reading the file…</p>}
            {notShared.length > 0 && (
              <p class="sub">Not shared, because CommunityCAD doesn't keep them: {notShared.join(', ')}.</p>
            )}
            <p class="sub">Nothing else: no addresses, keys, file paths or custom G-code.</p>
          </details>
        </>
      )}
      {print.posted ? (
        <p class="sub">
          {print.posted.status === 'draft' ? 'Kept private on CommunityCAD.' : print.posted.status === 'uploading'
            ? 'Post waiting for its timelapse to finish uploading.' : print.posted.status === 'pending_review'
              ? 'Post waiting for a quick review.' : 'Posted.'}{' '}
          {(print.posted.status === 'draft' ? print.posted.edit_url : print.posted.url) && (
            <a href={(print.posted.status === 'draft' ? print.posted.edit_url : print.posted.url)!}
              target="_blank" rel="noreferrer">Open on CommunityCAD</a>
          )}
        </p>
      ) : composing ? (
        <PostComposer print={print} modelId={model} draftFirst={privateShares || privateModel} draftOnly={privateModel}
          onDone={onChanged} onClose={() => setComposing(false)} />
      ) : (
        <div class="foot">
          <button class="btn ghost sm" type="button" disabled={!canShare} onClick={() => setComposing(true)}>
            Create post
          </button>
        </div>
      )}
      {error && <p class="sub" style="color:#f6ad55">{error}</p>}
    </div>
  );
}
