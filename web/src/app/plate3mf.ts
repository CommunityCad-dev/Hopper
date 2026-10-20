/**
 * Reads an OrcaSlicer project (.3mf) for the plate viewer: the bed, the plates,
 * and every model where Orca placed it. No library -- the zip is read by hand and
 * inflated with the browser's own DecompressionStream; the XML is scanned with
 * regular expressions, which is much faster than a DOM for meshes of many MB.
 *
 * Geometry is the 3MF core spec plus Orca's two additions: meshes split into
 * 3D/Objects/*.model (the production extension's p:path), and plates listed in
 * Metadata/model_settings.config. Plates past the first sit on Orca's grid, 1.2 bed
 * widths apart, so each plate's models are moved back onto one bed here.
 */

export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
  /** Too big to draw on a phone: drawn as its bounding box instead. */
  boxed: boolean;
}

export interface PlacedModel {
  name: string;
  mesh: string;
  /** Column-major 4x4: mesh coordinates to this plate's bed coordinates. */
  matrix: Float32Array;
  /** Which build item this part belongs to: the object's id and its copy number
   * among that object's items. A placement changes the item, not the part. */
  object: string;
  instance: number;
  /** The item's own transform, in the project's coordinates (column-major). */
  item: Float32Array;
  /** The part within its object: mesh coordinates to object coordinates. */
  part: Float32Array;
}

export interface Plate {
  id: number;
  models: PlacedModel[];
  /** Project coordinates to this plate's bed: plates past the first sit on Orca's grid. */
  shift: Float32Array;
}

export interface Project3mf {
  bed: { width: number; depth: number; height: number };
  plates: Plate[];
  meshes: Map<string, Mesh>;
  /** Models that couldn't be read at all (missing or far too large). */
  skipped: number;
}

/** Past this much mesh XML in total, further meshes are drawn as boxes. */
const FULL_MESH_BUDGET = 40 << 20;
/** Past this, a single mesh isn't read at all: even a box needs every vertex scanned. */
const MAX_MESH_FILE = 160 << 20;
/** Orca's LOGICAL_PART_PLATE_GAP: plates are laid out 1 + 1/5 bed sizes apart. */
const PLATE_STRIDE = 1.2;

// --- zip ----------------------------------------------------------------------

interface ZipEntry {
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

class Zip {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip');
    let count = v.getUint16(eocd + 10, true);
    let dir = v.getUint32(eocd + 16, true);
    // Zip64: the real count and offset are in the zip64 end record.
    const loc = eocd - 20;
    if ((dir === 0xffffffff || count === 0xffff) && loc >= 0 && v.getUint32(loc, true) === 0x07064b50) {
      const rec = Number(v.getBigUint64(loc + 8, true));
      count = Number(v.getBigUint64(rec + 32, true));
      dir = Number(v.getBigUint64(rec + 48, true));
    }
    const text = new TextDecoder();
    let p = dir;
    for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      const entry: ZipEntry = {
        method: v.getUint16(p + 10, true),
        compressed: v.getUint32(p + 20, true),
        size: v.getUint32(p + 24, true),
        offset: v.getUint32(p + 42, true),
      };
      const name = text.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      // Zip64 extra field: the 64-bit values, in order, for each field that overflowed.
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = v.getUint16(e, true);
        const len = v.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (entry.size === 0xffffffff) { entry.size = Number(v.getBigUint64(q, true)); q += 8; }
          if (entry.compressed === 0xffffffff) { entry.compressed = Number(v.getBigUint64(q, true)); q += 8; }
          if (entry.offset === 0xffffffff) entry.offset = Number(v.getBigUint64(q, true));
        }
        e += 4 + len;
      }
      this.entries.set(name.replace(/^\//, ''), entry);
      p = end + commentLen;
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  size(name: string): number {
    return this.entries.get(name)?.size ?? 0;
  }

  async text(name: string): Promise<string | null> {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const v = this.view;
    const at = entry.offset;
    const data = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
    const raw = this.bytes.subarray(data, data + entry.compressed);
    if (entry.method === 0) return new TextDecoder().decode(raw);
    if (entry.method !== 8) throw new Error('unsupported compression');
    const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }
}

// --- matrices -----------------------------------------------------------------

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A column-major 4x4 as the 3MF's 12 numbers (row vectors), the inverse of transform(). */
export function toTransform(m: Float32Array): number[] {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]];
}

/** A 3MF transform ("m00 m01 m02 m10 ... m32", row vectors) as a column-major 4x4. */
function transform(attr: string | undefined): Float32Array {
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const n = (attr ?? '').trim().split(/\s+/).map(Number);
  if (n.length === 12 && n.every(Number.isFinite)) {
    m.set(n.slice(0, 3), 0);
    m.set(n.slice(3, 6), 4);
    m.set(n.slice(6, 9), 8);
    m.set(n.slice(9, 12), 12);
  }
  return m;
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

// --- XML scanning -------------------------------------------------------------

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

interface ObjectDef {
  /** Byte range of its <mesh> in the file's text, when it has one. */
  mesh?: [number, number];
  components: { path: string; id: string; matrix: Float32Array }[];
}

/** Every <object> in a model file: its mesh's location, or its components. */
function scanObjects(xml: string, path: string): Map<string, ObjectDef> {
  const out = new Map<string, ObjectDef>();
  const open = /<object\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const id = attrs(m[0]).id;
    const close = xml.indexOf('</object>', open.lastIndex);
    const end = close < 0 ? xml.length : close;
    const def: ObjectDef = { components: [] };
    const meshAt = xml.indexOf('<mesh', open.lastIndex);
    if (meshAt >= 0 && meshAt < end) def.mesh = [meshAt, end];
    for (const c of xml.slice(open.lastIndex, def.mesh ? meshAt : end).matchAll(/<component\b[^>]*>/g)) {
      const a = attrs(c[0]);
      def.components.push({
        path: (a['p:path'] ?? path).replace(/^\//, ''),
        id: a.objectid,
        matrix: transform(a.transform),
      });
    }
    if (id) out.set(id, def);
    open.lastIndex = end;
  }
  return out;
}

const VERTEX = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
const TRIANGLE = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g;

/** The mesh in xml[from, to): vertices and triangles, or only the bounds when boxed. */
function readMesh(xml: string, from: number, to: number, boxed: boolean): Mesh {
  const text = xml.slice(from, to);
  const verts: number[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, z: number) => {
    if (!boxed) verts.push(x, y, z);
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  };
  VERTEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = VERTEX.exec(text))) { found = true; add(+m[1], +m[2], +m[3]); }
  if (!found) {
    // Attributes in another order: the slow, general way.
    for (const v of text.matchAll(/<vertex\b[^>]*>/g)) {
      const a = attrs(v[0]);
      add(+a.x, +a.y, +a.z);
    }
  }
  if (!Number.isFinite(min[0])) {
    return { positions: new Float32Array(), indices: new Uint32Array(), min: [0, 0, 0], max: [0, 0, 0], boxed: true };
  }
  if (boxed) return { ...box(min, max), min, max, boxed: true };
  const tris: number[] = [];
  TRIANGLE.lastIndex = 0;
  found = false;
  while ((m = TRIANGLE.exec(text))) { found = true; tris.push(+m[1], +m[2], +m[3]); }
  if (!found) {
    for (const t of text.matchAll(/<triangle\b[^>]*>/g)) {
      const a = attrs(t[0]);
      tris.push(+a.v1, +a.v2, +a.v3);
    }
  }
  return { positions: new Float32Array(verts), indices: new Uint32Array(tris), min, max, boxed: false };
}

function box(min: number[], max: number[]): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? max[0] : min[0];
    positions[i * 3 + 1] = i & 2 ? max[1] : min[1];
    positions[i * 3 + 2] = i & 4 ? max[2] : min[2];
  }
  const indices = new Uint32Array([
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4,
    2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
  ]);
  return { positions, indices };
}

// --- the project --------------------------------------------------------------

function bedFrom(settings: string | null): { x: number; y: number; width: number; depth: number; height: number } {
  let area: string[] = ['0x0', '350x0', '350x350', '0x350'];
  let height = 250;
  try {
    const json = JSON.parse(settings ?? '{}') as { printable_area?: string[]; printable_height?: string | number };
    if (Array.isArray(json.printable_area) && json.printable_area.length >= 3) area = json.printable_area;
    if (Number(json.printable_height) > 0) height = Number(json.printable_height);
  } catch {
    // Not Orca's settings: a default bed, and the models are still shown.
  }
  const pts = area.map((p) => p.split('x').map(Number));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, depth: Math.max(...ys) - y, height };
}

/** Orca's plate list: object id and instance number, per plate. */
function platesFrom(config: string | null): { id: number; instances: [string, number][] }[] {
  const out: { id: number; instances: [string, number][] }[] = [];
  for (const block of (config ?? '').matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const meta = (key: string, text: string) =>
      new RegExp(`key="${key}"\\s+value="([^"]*)"`).exec(text)?.[1];
    const id = Number(meta('plater_id', block[1]) ?? out.length + 1);
    const instances: [string, number][] = [];
    for (const inst of block[1].matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)) {
      const obj = meta('object_id', inst[1]);
      if (obj) instances.push([obj, Number(meta('instance_id', inst[1]) ?? 0)]);
    }
    out.push({ id, instances });
  }
  return out;
}

/** Orca's PartPlateList::compute_colum_count. */
function plateColumns(count: number): number {
  const v = Math.sqrt(count);
  const r = Math.round(v);
  return v > r ? r + 1 : r;
}

export async function readProject(bytes: Uint8Array): Promise<Project3mf> {
  const zip = new Zip(bytes);
  const root = zip.names().find((n) => /^3D\/3dmodel\.model$/i.test(n)) ?? '3D/3dmodel.model';
  const rootXml = await zip.text(root);
  if (rootXml == null) throw new Error('no 3D model in this file');
  const bed = bedFrom(await zip.text('Metadata/project_settings.config'));

  const files = new Map<string, Promise<{ xml: string | null; objects: Map<string, ObjectDef> }>>();
  const file = (path: string) => {
    let f = files.get(path);
    if (!f) {
      f = (path === root ? Promise.resolve(rootXml) : zip.size(path) > MAX_MESH_FILE ? Promise.resolve(null) : zip.text(path))
        .then((xml) => ({ xml, objects: xml ? scanObjects(xml, path) : new Map<string, ObjectDef>() }));
      files.set(path, f);
    }
    return f;
  };

  const meshes = new Map<string, Mesh>();
  let budget = FULL_MESH_BUDGET;
  let skipped = 0;
  const mesh = async (path: string, id: string): Promise<boolean> => {
    const key = `${path}#${id}`;
    if (meshes.has(key)) return true;
    const { xml, objects } = await file(path);
    const range = objects.get(id)?.mesh;
    if (!xml || !range) return false;
    const len = range[1] - range[0];
    meshes.set(key, readMesh(xml, range[0], range[1], len > budget));
    budget -= len;
    return true;
  };

  // Every mesh under an object, with the transform down to it.
  const flatten = async (path: string, id: string, matrix: Float32Array, depth = 0):
    Promise<{ mesh: string; matrix: Float32Array }[]> => {
    const def = (await file(path)).objects.get(id);
    if (!def || depth > 8) return [];
    const parts: { mesh: string; matrix: Float32Array }[] = [];
    if (def.mesh && (await mesh(path, id))) parts.push({ mesh: `${path}#${id}`, matrix });
    for (const c of def.components) {
      parts.push(...(await flatten(c.path, c.id, multiply(matrix, c.matrix), depth + 1)));
    }
    return parts;
  };

  // Build items, grouped by object: instance N of an object is its Nth item.
  const names = new Map<string, string>();
  for (const o of rootXml.matchAll(/<object\b[^>]*>/g)) {
    const a = attrs(o[0]);
    if (a.id && a.name) names.set(a.id, a.name);
  }
  const settings = await zip.text('Metadata/model_settings.config');
  for (const o of (settings ?? '').matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"/g)) {
    names.set(o[1], o[2]);
  }
  const items = new Map<string, Float32Array[]>();
  const order: [string, number][] = [];
  const build = rootXml.slice(rootXml.indexOf('<build'));
  for (const it of build.matchAll(/<item\b[^>]*>/g)) {
    const a = attrs(it[0]);
    if (!a.objectid || a.printable === '0') continue;
    const list = items.get(a.objectid) ?? [];
    order.push([a.objectid, list.length]);
    list.push(transform(a.transform));
    items.set(a.objectid, list);
  }

  let layout = platesFrom(settings).filter((p) => p.instances.length > 0);
  if (layout.length === 0) layout = [{ id: 1, instances: order }];
  const cols = plateColumns(platesFrom(settings).length || 1);

  const plates: Plate[] = [];
  for (const [index, p] of layout.entries()) {
    const slot = p.id - 1 >= 0 ? p.id - 1 : index;
    // Back onto one bed whose front-left corner is 0,0.
    const ox = bed.x + (slot % cols) * bed.width * PLATE_STRIDE;
    const oy = bed.y - Math.floor(slot / cols) * bed.depth * PLATE_STRIDE;
    const shift = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -ox, -oy, 0, 1]);
    const models: PlacedModel[] = [];
    for (const [obj, inst] of p.instances) {
      const placed = items.get(obj)?.[inst];
      if (!placed) continue;
      const parts = await flatten(root, obj, IDENTITY);
      if (parts.length === 0) skipped++;
      for (const part of parts) {
        models.push({
          name: names.get(obj) ?? `Object ${obj}`, mesh: part.mesh,
          matrix: multiply(shift, multiply(placed, part.matrix)),
          object: obj, instance: inst, item: placed, part: part.matrix,
        });
      }
    }
    plates.push({ id: p.id, models, shift });
  }
  return { bed: { width: bed.width, depth: bed.depth, height: bed.height }, plates, meshes, skipped };
}
