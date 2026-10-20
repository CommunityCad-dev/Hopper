/**
 * The bed Orca draws for this printer: its 3D model and its texture, read by
 * the component from the Orca installed on the Pi. Loaded once per page; null when
 * the printer isn't recognised, so the 3D views draw a plain plate.
 */
import { useEffect, useState } from 'preact/hooks';

import { getBed } from './api';

export interface BedLook {
  name: string;
  /** Triangles, three vertices (x, y, z) each, in the model's own coordinates:
   * its origin goes to the bed's centre, as in Orca. */
  triangles: Float32Array | null;
  texture: HTMLImageElement | null;
}

let cached: Promise<BedLook | null> | null = null;

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Binary or ASCII STL to a flat triangle list. */
export function parseStl(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length >= 84 ? view.getUint32(80, true) : 0;
  if (bytes.length === 84 + count * 50) {
    const out = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 9; k++) out[i * 9 + k] = view.getFloat32(84 + i * 50 + 12 + k * 4, true);
    }
    return out;
  }
  const text = new TextDecoder().decode(bytes);
  const values: number[] = [];
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) values.push(+m[1], +m[2], +m[3]);
  return new Float32Array(values.length - (values.length % 9)).map((_, i) => values[i]);
}

function loadImage(b64: string, type: string): Promise<HTMLImageElement | null> {
  let src: string;
  if (type === 'image/svg+xml') {
    // Firefox won't draw an SVG with no size of its own onto a canvas: give it one.
    let svg = new TextDecoder().decode(decode(b64));
    if (!/<svg[^>]*\swidth=/.test(svg)) svg = svg.replace(/<svg\b/, '<svg width="1024" height="1024"');
    src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } else {
    src = `data:${type};base64,${b64}`;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function loadBedLook(): Promise<BedLook | null> {
  cached ??= getBed()
    .then(async (r) => {
      if (!r.name || (!r.model && !r.texture)) return null;
      return {
        name: r.name,
        triangles: r.model ? parseStl(decode(r.model)) : null,
        texture: r.texture && r.texture_type ? await loadImage(r.texture, r.texture_type) : null,
      };
    })
    .catch(() => null);
  return cached;
}

/** undefined while loading, then the look or null. */
export function useBedLook(): BedLook | null | undefined {
  const [look, setLook] = useState<BedLook | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadBedLook().then((l) => live && setLook(l));
    return () => { live = false; };
  }, []);
  return look;
}
