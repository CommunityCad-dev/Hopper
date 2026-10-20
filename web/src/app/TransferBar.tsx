import { useEffect, useState } from 'preact/hooks';

import { getTransfers } from './api';
import { formatBytes } from './format';

/**
 * How far a download from CommunityCAD has got: shown while a file is being
 * saved or sent, read from the Pi twice a second. Nothing until the Pi has started
 * receiving it, and nothing once it's done.
 */
export function TransferBar({ modelId, fileId }: { modelId: number; fileId: number }) {
  const [t, setT] = useState<{ received: number; total: number } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => getTransfers()
      .then((r) => { if (live) setT(r.transfers[`${modelId}:${fileId}`] ?? null); })
      .catch(() => undefined);
    void read();
    const timer = window.setInterval(read, 500);
    return () => { live = false; window.clearInterval(timer); };
  }, [modelId, fileId]);
  if (!t || !t.total) return null;
  const pct = Math.min(100, Math.round((t.received / t.total) * 100));
  return (
    <div class="transfer" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      aria-label="Downloading to the printer">
      <div class="transfer-track"><div class="transfer-fill" style={`width:${pct}%`} /></div>
      <span class="sub">
        {t.received ? `${formatBytes(t.received)} of ${formatBytes(t.total)} · ${pct} %` : 'Starting the download…'}
      </span>
    </div>
  );
}
