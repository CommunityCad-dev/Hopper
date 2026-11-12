import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LOGO_DARK, LOGO_LIGHT, LOGO_VIEWBOX } from './logoArt';

/** True when a CSS colour is light, i.e. it's text on a dark theme. */
function isLight(colour: string): boolean {
  const m = colour.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return true;
  const [r, g, b] = m.slice(0, 3).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

/**
 * The full Hopper logo. Picks the light or dark version from the text colour the
 * host theme gives us, so it reads on Mainsail's and Fluidd's dark and light themes.
 * Dark is the default: it's what both hosts ship with.
 */
export function Logo({ height = 44 }: { height?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [dark, setDark] = useState(true);
  useLayoutEffect(() => {
    try {
      if (ref.current) setDark(isLight(getComputedStyle(ref.current).color));
    } catch {
      /* keep the default */
    }
  }, []);
  return (
    <svg
      ref={ref}
      class="logo"
      viewBox={LOGO_VIEWBOX}
      height={height}
      role="img"
      aria-label="Hopper"
      dangerouslySetInnerHTML={{ __html: dark ? LOGO_DARK : LOGO_LIGHT }}
    />
  );
}
