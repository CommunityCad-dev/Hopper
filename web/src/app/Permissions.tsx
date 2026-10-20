import { useState } from 'preact/hooks';

import { ApiError, setPermissions } from './api';
import type { Permissions as Answers } from './types';

type Key = keyof Answers;

const ASKS: { key: Key; title: string; body: string; without: string }[] = [
  {
    key: 'printer_settings',
    title: "Read this printer's settings",
    body:
      "Bed size, nozzle, speed limits and your start macro, from printer.cfg. Used to show " +
      'which models fit, to check a file before printing, and to slice for this printer.',
    without: 'Without it, type the bed size in Settings. Fits and slicing use only that.',
  },
  {
    key: 'print_history',
    title: "Read this printer's print history",
    body:
      'Which jobs finished and with what filament. Used to show how your prints of a model ' +
      'went, and to offer sharing after a print.',
    without: "Without it, those don't appear. Everything else works.",
  },
];

/**
 * Ask before reading. Two separate choices, neither picked in advance. Either
 * answer is a real answer: nothing nags afterwards. Both stay on this printer;
 * they can be changed in Settings. Enforced on the Pi, not here.
 */
export function PermissionsAsk({ current, onDone, inSettings = false }: {
  current: Answers;
  onDone: () => void;
  inSettings?: boolean;
}) {
  const [answers, setAnswers] = useState<Partial<Record<Key, boolean>>>(
    inSettings ? { printer_settings: current.printer_settings ?? undefined,
                   print_history: current.print_history ?? undefined } : {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = ASKS.every((a) => typeof answers[a.key] === 'boolean');

  const save = async (next = answers) => {
    setBusy(true);
    setError(null);
    try {
      await setPermissions(next);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Your printer works as normal.');
    } finally {
      setBusy(false);
    }
  };

  const pick = (key: Key, value: boolean) => {
    const next = { ...answers, [key]: value };
    setAnswers(next);
    if (inSettings) void save({ [key]: value });
  };

  return (
    <div class={inSettings ? '' : 'panel ask'}>
      {!inSettings && (
        <div class="panel-head"><span>Before you start</span></div>
      )}
      <div class={inSettings ? '' : 'slice-body'}>
        {!inSettings && (
          <p>
            The plugin works better with two things only this printer has. Each stays on the
            printer and is never sent to CommunityCAD. Choose for each; you can change them in
            Settings.
          </p>
        )}
        {ASKS.map((a) => (
          <div key={a.key} class="ask-card">
            <strong>{a.title}</strong>
            <p class="sub">{a.body}</p>
            {inSettings ? (
              // In Settings the choice is already made: a switch shows it.
              <label class="perm-switch">
                <input type="checkbox" class="switch" checked={answers[a.key] === true} disabled={busy}
                  aria-label={a.title} onChange={(e) => pick(a.key, (e.target as HTMLInputElement).checked)} />
                {answers[a.key] === true ? 'Allowed' : 'Not allowed'}
              </label>
            ) : (
              <div class="chips">
                <button class="tab chip" type="button" aria-pressed={answers[a.key] === true}
                  disabled={busy} onClick={() => pick(a.key, true)}>Allow</button>
                <button class="tab chip" type="button" aria-pressed={answers[a.key] === false}
                  disabled={busy} onClick={() => pick(a.key, false)}>Not now</button>
              </div>
            )}
            {answers[a.key] === false && <p class="sub">{a.without}</p>}
          </div>
        ))}
        {error && <div class="msg warn"><p>{error}</p></div>}
        {!inSettings && (
          <div class="foot">
            <button class="btn" type="button" disabled={!complete || busy} onClick={() => void save()}>
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
