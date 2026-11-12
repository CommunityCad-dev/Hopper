import { useState } from 'preact/hooks';

import { ApiError, acceptNotice } from './api';

/**
 * The first-use notice, once per printer, before anything reaches or starts
 * on it. Accepting is stored on the Pi, and the Pi refuses sends and prints until
 * then, so skipping this screen gains nothing. Asked again when the notice changes.
 * Draft wording: for the reviewer's and the lawyer's review.
 */
export function Notice({ version, onDone }: { version: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await acceptNotice(version);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="panel notice">
      <div class="panel-head"><span>Before you use Hopper on this printer</span></div>
      <div class="slice-body">
        <p><strong>This plugin comes with no warranty. Use it at your own risk.</strong></p>
        <ul>
          <li>Models and G-code on CommunityCAD are made by other people. CommunityCAD doesn't check them for
            safety, and a file made for another printer can damage yours.</li>
          <li>The checks the plugin shows, like printer match and fit, are aids, not guarantees.</li>
          <li>You are responsible for your printer. Watch every print, especially the first layer.</li>
          <li>The plugin never flashes firmware, never edits printer.cfg, and sends no commands to your printer
            other than starting or queueing a file you chose.</li>
        </ul>
        <p class="sub">
          Using CommunityCAD also means agreeing to its{' '}
          <a href="https://communitycad.dev/terms" target="_blank" rel="noopener">Terms</a>.
        </p>
        {error && <div class="msg warn"><p>{error}</p></div>}
        <div class="foot">
          <button class="btn" type="button" disabled={busy} onClick={() => void accept()}>
            {busy ? 'Saving…' : 'I understand and accept'}
          </button>
        </div>
      </div>
    </div>
  );
}
