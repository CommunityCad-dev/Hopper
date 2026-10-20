import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

/**
 * The confirm before a print starts, over the page rather than somewhere
 * below it: Print plate and quick print's Print save the file, then this opens
 * where the user is looking. The start is still a second, explicit tap inside it.
 * A sheet from the bottom on a phone, a centred dialog on a wider screen.
 */
export function ConfirmSheet({ onClose, children, label = 'Start the print' }: {
  onClose: () => void; children: ComponentChildren; label?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    // The first button (Start print) gets focus, so a keyboard user lands on it.
    panel.current?.querySelector<HTMLButtonElement>('.acts .btn')?.focus();
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <>
      <div class="sheet-backdrop" onClick={onClose} />
      <div ref={panel} class="sheet" role="dialog" aria-modal="true" aria-label={label}>
        <button class="icon-btn sm sheet-close" type="button" aria-label="Close" onClick={onClose}>✕</button>
        {children}
      </div>
    </>
  );
}
