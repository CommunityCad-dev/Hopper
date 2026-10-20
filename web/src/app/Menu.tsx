import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { ICONS, Icon } from './icons';

interface Props {
  /** Read by screen readers: "More for cad/3DBenchy.stl". */
  label: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ComponentChildren;
  /** What the button shows, when it isn't "⋯" (the nav's "More ▾"). */
  button?: ComponentChildren;
}

/**
 * A "⋯" button and its menu. The menu is fixed to the viewport, so a
 * scrolling list (the model page's files) can't clip it. It opens below the
 * button, or above when there's no room, and as a sheet from the bottom on a
 * phone. A tap outside, Escape, or scrolling the page closes it.
 */
export function Menu({ label, open, onOpen, onClose, children, button: face }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setPos({
      '--menu-right': `${Math.max(8, window.innerWidth - r.right)}px`,
      ...(below > 320 || below > r.top
        ? { '--menu-top': `${r.bottom + 4}px` }
        : { '--menu-bottom': `${window.innerHeight - r.top + 4}px` }),
    });
    const inside = (e: Event) => !!panel.current && e.composedPath().includes(panel.current);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const scroll = (e: Event) => { if (!inside(e)) onClose(); };
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open]);

  return (
    <>
      <button ref={button} class={face ? 'tab' : 'icon-btn sm'} type="button" aria-label={label} title="More"
        aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? onClose() : onOpen())}>
        {face ?? <Icon path={ICONS.dots} size={18} />}
      </button>
      {open && (
        <>
          <div class="menu-backdrop" onClick={onClose} />
          <div ref={panel} class="menu" role="menu" style={pos}>{children}</div>
        </>
      )}
    </>
  );
}
