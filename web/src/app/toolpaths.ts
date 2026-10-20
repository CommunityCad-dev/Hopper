/**
 * Reads a sliced G-code file into toolpaths for Preview: every extruding move
 * as a line segment, tagged with Orca's feature type, grouped by layer. Streamed and
 * parsed a chunk at a time, yielding between chunks so a phone stays responsive;
 * travel moves are not kept.
 */

/** Orca's feature names (`;TYPE:`) and its own preview colours (GCodeViewer.cpp). */
export const ROLES: readonly [string, string][] = [
  ['Other', '#E6B3B3'],
  ['Inner wall', '#FFE64D'],
  ['Outer wall', '#FF7D38'],
  ['Overhang wall', '#1F1FFF'],
  ['Sparse infill', '#B03029'],
  ['Internal solid infill', '#9654CC'],
  ['Top surface', '#F04040'],
  ['Bottom surface', '#665CC7'],
  ['Ironing', '#FF8C69'],
  ['Bridge', '#4D66A1'],
  ['Internal Bridge', '#4D80BA'],
  ['Gap infill', '#FFFFFF'],
  ['Skirt', '#00876E'],
  ['Brim', '#003B6E'],
  ['Support', '#00FF00'],
  ['Support interface', '#008000'],
  ['Support transition', '#004000'],
  ['Prime tower', '#B3E3AB'],
  ['Custom', '#5ED194'],
];
const ROLE_INDEX = new Map(ROLES.map(([name], i) => [name.toLowerCase(), i]));

export interface Toolpaths {
  /** Two vertices (x, y, z) per segment. */
  positions: Float32Array;
  /** The feature type of each vertex, an index into ROLES. */
  roles: Uint8Array;
  /** Per layer: its height, and the vertex count up to and including it. */
  layers: { z: number; end: number }[];
  /** Segments per feature type. */
  counts: number[];
  /** Stopped at MAX_SEGMENTS: the top layers are missing. */
  truncated: boolean;
}

/** About 80 MB of vertex data: past this a phone runs out of memory. */
const MAX_SEGMENTS = 3_000_000;

class Growing {
  pos = new Float32Array(1 << 18);
  role = new Uint8Array(1 << 17);
  n = 0;

  push(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number) {
    if ((this.n + 2) * 3 > this.pos.length) {
      const pos = new Float32Array(this.pos.length * 2);
      pos.set(this.pos);
      this.pos = pos;
      const role = new Uint8Array(this.role.length * 2);
      role.set(this.role);
      this.role = role;
    }
    const p = this.n * 3;
    this.pos[p] = x0; this.pos[p + 1] = y0; this.pos[p + 2] = z0;
    this.pos[p + 3] = x1; this.pos[p + 4] = y1; this.pos[p + 5] = z1;
    this.role[this.n] = r;
    this.role[this.n + 1] = r;
    this.n += 2;
  }
}

/** Parses G-code text a line at a time; feed() it chunks, then finish(). */
export class ToolpathParser {
  private out = new Growing();
  private layers: { z: number; end: number }[] = [];
  private counts = ROLES.map(() => 0);
  private rest = '';
  private x = 0;
  private y = 0;
  private z = 0;
  private e = 0;
  private relE = false;
  private relXYZ = false;
  private role = 0;
  private layerZ = 0;
  private layerStart = 0;
  truncated = false;

  feed(text: string): void {
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop() ?? '';
    for (const line of lines) {
      if (this.truncated) return;
      this.line(line);
    }
  }

  finish(): Toolpaths {
    if (this.rest) this.line(this.rest);
    this.closeLayer();
    return {
      positions: this.out.pos.subarray(0, this.out.n * 3),
      roles: this.out.role.subarray(0, this.out.n),
      layers: this.layers,
      counts: this.counts,
      truncated: this.truncated,
    };
  }

  private closeLayer() {
    if (this.out.n > this.layerStart) {
      this.layers.push({ z: this.layerZ || this.z, end: this.out.n });
      this.layerStart = this.out.n;
    }
  }

  private line(raw: string) {
    const c = raw.charCodeAt(0);
    if (c === 59 /* ; */) {
      if (raw.startsWith(';TYPE:')) this.role = ROLE_INDEX.get(raw.slice(6).trim().toLowerCase()) ?? 0;
      else if (raw.startsWith(';LAYER_CHANGE')) this.closeLayer();
      else if (raw.startsWith(';Z:')) this.layerZ = parseFloat(raw.slice(3)) || this.layerZ;
      return;
    }
    if (c !== 71 /* G */ && c !== 77 /* M */) return;
    const semi = raw.indexOf(';');
    const words = (semi >= 0 ? raw.slice(0, semi) : raw).trim().split(/\s+/);
    const cmd = words[0];
    if (cmd === 'M83') { this.relE = true; return; }
    if (cmd === 'M82') { this.relE = false; return; }
    if (cmd === 'G91') { this.relXYZ = true; this.relE = true; return; }
    if (cmd === 'G90') { this.relXYZ = false; return; }
    if (cmd === 'G92') {
      for (const w of words.slice(1)) {
        const v = parseFloat(w.slice(1));
        if (w[0] === 'E') this.e = v; else if (w[0] === 'X') this.x = v;
        else if (w[0] === 'Y') this.y = v; else if (w[0] === 'Z') this.z = v;
      }
      return;
    }
    const arc = cmd === 'G2' || cmd === 'G3';
    if (cmd !== 'G1' && cmd !== 'G0' && !arc) return;
    let x = this.x, y = this.y, z = this.z, de = 0, i = 0, j = 0;
    for (let k = 1; k < words.length; k++) {
      const w = words[k];
      const v = parseFloat(w.slice(1));
      if (Number.isNaN(v)) continue;
      switch (w[0]) {
        case 'X': x = this.relXYZ ? this.x + v : v; break;
        case 'Y': y = this.relXYZ ? this.y + v : v; break;
        case 'Z': z = this.relXYZ ? this.z + v : v; break;
        case 'E': de = this.relE ? v : v - this.e; this.e = this.relE ? this.e + v : v; break;
        case 'I': i = v; break;
        case 'J': j = v; break;
      }
    }
    const moved = x !== this.x || y !== this.y;
    if (de > 0 && moved) {
      if (arc) this.arc(x, y, z, i, j, cmd === 'G2');
      else this.segment(this.x, this.y, this.z, x, y, z);
    }
    this.x = x; this.y = y; this.z = z;
  }

  private segment(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    if (this.out.n / 2 >= MAX_SEGMENTS) { this.truncated = true; return; }
    this.out.push(x0, y0, z0, x1, y1, z1, this.role);
    this.counts[this.role]++;
  }

  /** An arc as short straight segments, about 1 mm or 10 degrees each. */
  private arc(x: number, y: number, z: number, i: number, j: number, clockwise: boolean) {
    const cx = this.x + i, cy = this.y + j;
    const r = Math.hypot(i, j);
    const a0 = Math.atan2(this.y - cy, this.x - cx);
    let a1 = Math.atan2(y - cy, x - cx);
    if (clockwise && a1 >= a0) a1 -= 2 * Math.PI;
    if (!clockwise && a1 <= a0) a1 += 2 * Math.PI;
    const steps = Math.max(1, Math.min(72, Math.ceil(Math.max(Math.abs(a1 - a0) * r, Math.abs(a1 - a0) / 0.17))));
    let px = this.x, py = this.y, pz = this.z;
    for (let s = 1; s <= steps; s++) {
      const a = a0 + (a1 - a0) * (s / steps);
      const nx = s === steps ? x : cx + r * Math.cos(a);
      const ny = s === steps ? y : cy + r * Math.sin(a);
      const nz = this.z + (z - this.z) * (s / steps);
      this.segment(px, py, pz, nx, ny, nz);
      px = nx; py = ny; pz = nz;
    }
  }
}

/** Fetch and parse, reporting the fraction read so far. */
export async function readToolpaths(url: string, onProgress: (fraction: number) => void): Promise<Toolpaths> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok || !res.body) throw new Error(String(res.status));
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new ToolpathParser();
  let read = 0;
  let sinceYield = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
    sinceYield += value.length;
    parser.feed(decoder.decode(value, { stream: true }));
    if (parser.truncated) { void reader.cancel(); break; }
    if (sinceYield > 1 << 20) {
      sinceYield = 0;
      if (total) onProgress(read / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  parser.feed(decoder.decode());
  return parser.finish();
}
