/**
 * Placement on the plate: picking a model or a face, finding the flat faces a
 * model can rest on, and the turns that lay it on one. Pure math, column-major
 * matrices. The Pi drops every placement onto the bed, so nothing here sets height.
 */
import type { Mesh, PlacedModel } from './plate3mf';
import { multiply } from './plate3mf';
import type { Ray } from './scene';
import { invert } from './scene';

type V3 = [number, number, number];

/** One build item's triangles in its object's own space: every part, transformed. */
export function objectTriangles(parts: PlacedModel[], meshes: Map<string, Mesh>): Float32Array {
  let total = 0;
  for (const p of parts) total += meshes.get(p.mesh)?.indices.length ?? 0;
  const out = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    const mesh = meshes.get(p.mesh);
    if (!mesh) continue;
    const m = p.part;
    for (const i of mesh.indices) {
      const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
      out[o++] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[o++] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[o++] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
  }
  return out;
}

export function centre(tris: Float32Array): V3 {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (tris[i + k] < lo[k]) lo[k] = tris[i + k];
      if (tris[i + k] > hi[k]) hi[k] = tris[i + k];
    }
  }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

export interface Face {
  /** Outward normal, object space. */
  normal: V3;
  area: number;
  /** Its triangles in Faces.triangles: [start, count) in triangles. */
  start: number;
  count: number;
}

export interface Faces {
  faces: Face[];
  /** Every candidate face's triangles, grouped face by face (object space). */
  triangles: Float32Array;
  /** For each of the object's triangles, the face it belongs to, or -1. */
  faceOf: Int32Array;
}

/**
 * The flat faces a model can rest on, as Orca's Lay on face offers them: triangles
 * grouped by plane, big enough to matter, and with the whole model on one side of
 * the plane -- a face of the convex hull. Coplanar feet count as one face.
 */
export function restingFaces(tris: Float32Array, limit = 40): Faces {
  const n = tris.length / 9;
  const groups = new Map<string, { normal: V3; d: number; area: number; tris: number[] }>();
  const keyOf = new Array<string | null>(n).fill(null);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const ux = tris[o + 3] - ax, uy = tris[o + 4] - ay, uz = tris[o + 5] - az;
    const vx = tris[o + 6] - ax, vy = tris[o + 7] - ay, vz = tris[o + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    nx /= len; ny /= len; nz /= len;
    const d = nx * ax + ny * ay + nz * az;
    // Normals within about a third of a degree, planes within 0.2 mm, count as one.
    const key = `${Math.round(nx * 200)},${Math.round(ny * 200)},${Math.round(nz * 200)},${Math.round(d * 5)}`;
    keyOf[t] = key;
    const g = groups.get(key);
    if (g) { g.area += len / 2; g.tris.push(t); } else groups.set(key, { normal: [nx, ny, nz], d, area: len / 2, tris: [t] });
  }
  const ranked = [...groups.entries()].filter(([, g]) => g.area >= 4).sort((a, b) => b[1].area - a[1].area);
  const faces: Face[] = [];
  const chosen = new Map<string, number>();
  const parts: number[] = [];
  for (const [key, g] of ranked.slice(0, 80)) {
    if (faces.length >= limit) break;
    // Every point on or behind the plane: the model can rest on it.
    let ok = true;
    for (let i = 0; i < tris.length && ok; i += 3) {
      if (g.normal[0] * tris[i] + g.normal[1] * tris[i + 1] + g.normal[2] * tris[i + 2] > g.d + 0.05) ok = false;
    }
    if (!ok) continue;
    chosen.set(key, faces.length);
    faces.push({ normal: g.normal, area: g.area, start: parts.length / 9, count: g.tris.length });
    for (const t of g.tris) for (let k = 0; k < 9; k++) parts.push(tris[t * 9 + k]);
  }
  const faceOf = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const k = keyOf[t];
    if (k != null && chosen.has(k)) faceOf[t] = chosen.get(k)!;
  }
  return { faces, triangles: new Float32Array(parts), faceOf };
}

/** Where a world ray first hits an object's triangles: triangle index and distance. */
export function hit(ray: Ray, world: Float32Array, tris: Float32Array): { tri: number; dist: number } | null {
  const inv = invert(world);
  if (!inv) return null;
  const o = ray.origin, d = ray.dir;
  const ox = inv[0] * o[0] + inv[4] * o[1] + inv[8] * o[2] + inv[12];
  const oy = inv[1] * o[0] + inv[5] * o[1] + inv[9] * o[2] + inv[13];
  const oz = inv[2] * o[0] + inv[6] * o[1] + inv[10] * o[2] + inv[14];
  const dx = inv[0] * d[0] + inv[4] * d[1] + inv[8] * d[2];
  const dy = inv[1] * d[0] + inv[5] * d[1] + inv[9] * d[2];
  const dz = inv[2] * d[0] + inv[6] * d[1] + inv[10] * d[2];
  let best: { tri: number; dist: number } | null = null;
  for (let t = 0, i = 0; i < tris.length; t++, i += 9) {
    // Moller-Trumbore.
    const e1x = tris[i + 3] - tris[i], e1y = tris[i + 4] - tris[i + 1], e1z = tris[i + 5] - tris[i + 2];
    const e2x = tris[i + 6] - tris[i], e2y = tris[i + 7] - tris[i + 1], e2z = tris[i + 8] - tris[i + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv_ = 1 / det;
    const tx = ox - tris[i], ty = oy - tris[i + 1], tz = oz - tris[i + 2];
    const u = (tx * px + ty * py + tz * pz) * inv_;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv_;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv_;
    if (dist > 0 && (!best || dist < best.dist)) best = { tri: t, dist };
  }
  return best;
}

/** Where a world ray meets the bed (z = 0). */
export function onBed(ray: Ray): [number, number] | null {
  if (Math.abs(ray.dir[2]) < 1e-9) return null;
  const t = -ray.origin[2] / ray.dir[2];
  return t > 0 ? [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t] : null;
}

/** Rotation (column-major 4x4) turning unit vector a onto unit vector b. */
function rotationBetween(a: V3, b: V3): Float32Array {
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (c > 1 - 1e-9) return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let ax: V3;
  let angle: number;
  if (c < -1 + 1e-9) {
    // Opposite: half a turn about any axis at right angles to a.
    ax = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]];
    angle = Math.PI;
  } else {
    ax = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    angle = Math.acos(Math.max(-1, Math.min(1, c)));
  }
  const l = Math.hypot(ax[0], ax[1], ax[2]);
  const [x, y, z] = [ax[0] / l, ax[1] / l, ax[2] / l];
  const s = Math.sin(angle), k = 1 - Math.cos(angle), co = Math.cos(angle);
  return new Float32Array([
    co + x * x * k, y * x * k + z * s, z * x * k - y * s, 0,
    x * y * k - z * s, co + y * y * k, z * y * k + x * s, 0,
    x * z * k + y * s, y * z * k - x * s, co + z * z * k, 0,
    0, 0, 0, 1,
  ]);
}

function turnAbout(item: Float32Array, turn: Float32Array, centreObj: V3): Float32Array {
  // Turn about the model's own centre, so it stays where it was on the plate.
  const before = apply(item, centreObj);
  const turned = multiply(turn, linearOnly(item));
  const after = apply(turned, centreObj);
  turned[12] = before[0] - after[0];
  turned[13] = before[1] - after[1];
  turned[14] = item[14];
  return turned;
}

function linearOnly(m: Float32Array): Float32Array {
  const out = new Float32Array(m);
  out[12] = 0; out[13] = 0; out[14] = 0;
  return out;
}

function apply(m: Float32Array, p: V3): V3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** The item turned so the face with this (object-space) normal faces the bed. */
export function layOnFace(item: Float32Array, normal: V3, centreObj: V3): Float32Array {
  const w = [
    item[0] * normal[0] + item[4] * normal[1] + item[8] * normal[2],
    item[1] * normal[0] + item[5] * normal[1] + item[9] * normal[2],
    item[2] * normal[0] + item[6] * normal[1] + item[10] * normal[2],
  ];
  const l = Math.hypot(w[0], w[1], w[2]) || 1;
  return turnAbout(item, rotationBetween([w[0] / l, w[1] / l, w[2] / l], [0, 0, -1]), centreObj);
}

/** The item turned about the vertical axis through its centre. */
export function turnZ(item: Float32Array, degrees: number, centreObj: V3): Float32Array {
  const a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return turnAbout(item, new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), centreObj);
}

/** The item moved so its centre is at (x, y) on the plate's own coordinates. */
export function moveCentreTo(item: Float32Array, centreObj: V3, x: number, y: number): Float32Array {
  const now = apply(item, centreObj);
  const out = new Float32Array(item);
  out[12] += x - now[0];
  out[13] += y - now[1];
  return out;
}

export function centreOnPlate(item: Float32Array, centreObj: V3): V3 {
  return apply(item, centreObj);
}
