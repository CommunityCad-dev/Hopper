import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * WebGL contexts are a scarce, per-page resource: Chrome keeps about 16, drops the
 * oldest past that, and after enough losses can turn WebGL off for the page, which
 * is when the plate said "This browser can't show the plate". So each 3D
 * view gives its context back when it closes, and a lost one can be drawn again.
 */

let available = false;

/** Can this browser draw the plate? Asked with a context that is given straight
 * back. Only a yes is remembered: a no can be WebGL switched off for now. */
export function canDraw3d(): boolean {
  if (available) return true;
  if (typeof DecompressionStream === 'undefined') return false;
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return false;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  available = true;
  return true;
}

/**
 * A canvas for a 3D view. `gen` changes when the canvas is replaced after a lost
 * context: put it in the canvas's key and in the drawing effect's dependencies.
 */
export function useGlCanvas() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const made = useRef<WebGL2RenderingContext | null>(null);
  const [gen, setGen] = useState(0);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onLost = (e: Event) => { e.preventDefault(); setLost(true); };
    el.addEventListener('webglcontextlost', onLost);
    return () => {
      el.removeEventListener('webglcontextlost', onLost);
      // Give the context back now rather than whenever the canvas is collected.
      made.current?.getExtension('WEBGL_lose_context')?.loseContext();
      made.current = null;
    };
  }, [gen, lost]);
  /** The canvas's context, made on first use; the same one on later calls. */
  const context = (): WebGL2RenderingContext | null => {
    const el = canvas.current;
    if (!el) return null;
    made.current = el.getContext('webgl2', { antialias: true });
    return made.current;
  };
  return { canvas, context, gen, lost, retry: () => { setLost(false); setGen((g) => g + 1); } };
}
