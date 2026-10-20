import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { ApiError, getStatus, linkCancel, linkStart } from './api';
import type { Status } from './types';

const POLL_MS = 2500;

/**
 * The device-code flow, shared by the Connect screen and the dashboard panel.
 *
 * It lives in one place on purpose: two copies of a polling state machine drift,
 * and this one decides when a printer is linked.
 *
 * The browser polls *the component*, not CommunityCAD. The Pi is already doing the
 * real RFC 8628 polling, so watching the Pi keeps one poller per printer however
 * many tabs or panels are open.
 */
export function useLinkFlow(status: Status, onLinked: () => void) {
  const pending = status.link_pending;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(status.link_error);
  const [remaining, setRemaining] = useState<number | null>(null);
  const alreadyLinked = useRef(false);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getStatus();
        if (next.linked && !alreadyLinked.current) {
          alreadyLinked.current = true;
          window.clearInterval(timer);
          onLinked();
        } else if (next.link_error) {
          setError(next.link_error);
          window.clearInterval(timer);
        }
      } catch {
        /* transient; the next tick tries again */
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, onLinked]);

  // Countdown, so an expired code reads as expired rather than as mysteriously
  // not working.
  useEffect(() => {
    if (!pending) {
      setRemaining(null);
      return;
    }
    const tick = () =>
      setRemaining(Math.max(0, Math.round(pending.expires_at - Date.now() / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      await linkStart(status.printer_name);
      onLinked(); // refresh status; the pending code renders on the next pass
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start sign-in.');
    } finally {
      setStarting(false);
    }
  }, [status.printer_name, onLinked]);

  const cancel = useCallback(async () => {
    try {
      await linkCancel();
    } catch {
      /* best effort; the code expires on its own anyway */
    }
    onLinked();
  }, [onLinked]);

  return { pending, starting, error, remaining, start, cancel };
}

/** "9:52" for a countdown, or null when there is nothing to count. */
export function formatCountdown(remaining: number | null): string | null {
  if (remaining == null) return null;
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
}
