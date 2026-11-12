import { useCallback, useEffect, useState } from 'preact/hooks';

import { getStatus } from './api';
import { QrSvg } from './Qr';
import { formatCountdown, useLinkFlow } from './useLinkFlow';
import type { Status } from './types';

/**
 * The CommunityCAD panel on the host's dashboard.
 *
 * It exists so a user never has to go looking for the pairing code: the printer has
 * no keyboard, and the code should be where they are already looking.
 *
 * Deliberately small. It shows state and starts a link; browsing, settings and model
 * detail all live in the full view, reached from the button here.
 */

interface Props {
  status: Status;
  onRefresh: () => void;
  onOpenBrowser: () => void;
}

export function DashboardPanel({ status, onRefresh, onOpenBrowser }: Props) {
  const { pending, starting, error, remaining, start, cancel } = useLinkFlow(status, onRefresh);
  const volume = status.build_volume;

  return (
    <div class="panelwrap">
      <div class="panelhead">
        <span class="panelname">Hopper</span>
        {status.linked && status.account?.username && (
          <span class="sub">{status.account.username}</span>
        )}
      </div>

      {error && <p class="warn">{error}</p>}

      {/* Waiting on approval: the code is the whole point of the panel. */}
      {pending && (
        <div class="pairing">
          <div class="code">{pending.user_code}</div>
          <p class="sub">
            Go to{' '}
            <a href={pending.verification_uri} target="_blank" rel="noreferrer">
              {pending.verification_uri.replace(/^https?:\/\//, '')}
            </a>{' '}
            and enter this code, or scan it.
          </p>
          <QrSvg text={pending.verification_uri_complete} size={150} />
          {remaining != null && (
            <p class="sub">
              {remaining > 0
                ? `Expires in ${formatCountdown(remaining)}`
                : 'This code has expired.'}
            </p>
          )}
          <div class="acts">
            <button class="btn ghost" type="button" onClick={() => void cancel()}>Cancel</button>
            {remaining === 0 && (
              <button class="btn" type="button" onClick={() => void start()}>Get a new code</button>
            )}
          </div>
        </div>
      )}

      {!pending && !status.linked && (
        <>
          <p>
            Connect this printer to browse and send CommunityCAD models. Approve a
            short code on your phone — nothing to type here.
          </p>
          <div class="acts">
            <button class="btn" type="button" disabled={starting} onClick={() => void start()}>
              {starting ? 'Starting…' : 'Connect'}
            </button>
            <button class="btn ghost" type="button" onClick={onOpenBrowser}>Browse models</button>
          </div>
        </>
      )}

      {!pending && status.linked && (
        <>
          <dl class="facts2">
            <dt>Printer</dt>
            <dd>{status.printer_name}</dd>
            <dt>Build volume</dt>
            <dd>
              {volume
                ? `${Math.round(volume.x)} × ${Math.round(volume.y)} × ${Math.round(volume.z)} mm`
                : 'not detected'}
            </dd>
          </dl>
          <div class="acts">
            <button class="btn" type="button" onClick={onOpenBrowser}>Browse models</button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Fetches its own status and keeps it fresh.
 *
 * The panel and the main view are separate Preact trees in separate shadow roots,
 * and they are never visible at the same time -- opening our view hides the host's
 * page, panel included. They stay in step through one `ccad:refresh` window event:
 * whichever tree changes something (linking, unlinking) fires it, and both reload.
 * That is cheaper than a shared store for two consumers that never race.
 *
 * Renders nothing at all until status arrives, and nothing if it cannot be reached:
 * an empty space on the dashboard is better than a broken panel.
 */
export function PanelRoot({ onOpenBrowser }: { onOpenBrowser: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(() => {
    getStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    const onExternalChange = () => refresh();
    window.addEventListener(REFRESH_EVENT, onExternalChange);
    return () => window.removeEventListener(REFRESH_EVENT, onExternalChange);
  }, [refresh]);

  if (!status) return null;

  return (
    <DashboardPanel
      status={status}
      onRefresh={() => {
        refresh();
        notifyRefresh();
      }}
      onOpenBrowser={onOpenBrowser}
    />
  );
}

/** Both trees listen for this; either fires it after changing something. */
export const REFRESH_EVENT = 'ccad:refresh';

export function notifyRefresh(): void {
  try {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
  } catch {
    /* CustomEvent is universally available; guard anyway, this must never throw */
  }
}

/** Styles for the panel's shadow root. The host's panel chrome is outside it. */
export const PANEL_CSS = `
:host{display:block;color:inherit}
*,*::before,*::after{box-sizing:border-box}
.panelwrap{padding:14px 16px 16px;font:14px/1.5 Roboto,system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--ccad-fg)}
.panelhead{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}
.panelname{font-size:15px;font-weight:600}
.sub{font-size:12px;opacity:.65}
p{margin:0 0 12px}
a{color:var(--ccad-accent)}
.warn{color:#f6ad55}
.acts{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;cursor:pointer}
.btn{background:var(--ccad-accent);color:#fff;border:0;border-radius:6px;padding:8px 14px;font-weight:500}
.btn.ghost{background:transparent;border:1px solid var(--ccad-line);color:inherit}
.btn:disabled{opacity:.5;cursor:default}
.pairing{text-align:center}
.code{font:700 30px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;margin-bottom:10px}
.qr{width:150px;height:auto;border-radius:6px;padding:6px;background:#fff;margin:4px 0 8px}
.pairing .acts{justify-content:center}
.facts2{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0 0 14px;font-size:13px}
.facts2 dt{opacity:.6}
.facts2 dd{margin:0}
`;
