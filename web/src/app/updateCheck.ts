/**
 * Tell an open page that the plugin on the printer was updated. Mainsail and
 * Fluidd are single-page apps, so moving around them never loads our script again:
 * a tab left open keeps running the old plugin until it's reloaded.
 *
 * nginx serves inject.js with an ETag (and Last-Modified) that change with every
 * build. The page notes them once, then asks again whenever it comes back into
 * view -- no polling. Never reloads by itself: the user could be mid-task.
 */
import { useEffect, useState } from 'preact/hooks';

const SCRIPT = '/communitycad/inject.js';

async function stamp(): Promise<string | null> {
  try {
    const r = await fetch(SCRIPT, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return null;
    return r.headers.get('etag') ?? r.headers.get('last-modified');
  } catch {
    return null;
  }
}

export function useUpdateAvailable(): boolean {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    let first: string | null = null;
    let live = true;
    void stamp().then((s) => { first = s; });
    const check = () => {
      if (document.visibilityState !== 'visible' || !first) return;
      void stamp().then((now) => { if (live && now && now !== first) setUpdated(true); });
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);
  return updated;
}
