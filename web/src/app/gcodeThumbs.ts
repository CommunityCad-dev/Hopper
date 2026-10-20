/**
 * Thumbnails for sliced G-code (reviewer, 2026-10-02: "Orca does this by default").
 * Orca's CLI can't render, so the browser draws each plate's models -- no bed, a
 * clear background, framed on the models from Orca's iso angle -- at the sizes the
 * printer's Orca preset asks for (Voron: 48x48 and 300x300). The Pi writes them into
 * the G-code as Orca does, and Mainsail shows them in G-code Files.
 */
import { MESH_FS, MESH_VS, hexColour } from './PlateView';
import { multiply } from './plate3mf';
import type { Project3mf } from './plate3mf';
import { lookAt, perspective, program } from './scene';

export const GCODE_THUMB_SIZES: [number, number][] = [[48, 48], [300, 300]];

export interface GcodeThumb { width: number; height: number; png: string }

/** The plate with Orca's plater id `plateId`, at each size; [] when it can't be drawn. */
export function renderPlateThumbs(project: Project3mf, plateId: number, colour: string,
  sizes: [number, number][] = GCODE_THUMB_SIZES): GcodeThumb[] {
  const plate = project.plates.find((p) => p.id === plateId) ?? project.plates[plateId - 1];
  if (!plate || !plate.models.length) return [];
  const out: GcodeThumb[] = [];
  for (const [w, h] of sizes) {
    const png = renderOne(project, plate.models, colour, w, h);
    if (png) out.push({ width: w, height: h, png });
  }
  return out;
}

function renderOne(project: Project3mf, models: Project3mf['plates'][number]['models'],
  colour: string, w: number, h: number): string | null {
  // Drawn at twice the size and scaled down, for smooth edges at 48 px.
  const scale = w < 128 ? 4 : 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false,
    preserveDrawingBuffer: true });
  if (!gl) return null;
  try {
    // The models' bounds on the plate, to frame them.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of models) {
      const mesh = project.meshes.get(m.mesh);
      if (!mesh) continue;
      for (let i = 0; i < 8; i++) {
        const c = [i & 1 ? mesh.max[0] : mesh.min[0], i & 2 ? mesh.max[1] : mesh.min[1], i & 4 ? mesh.max[2] : mesh.min[2]];
        for (let k = 0; k < 3; k++) {
          const v = m.matrix[k] * c[0] + m.matrix[4 + k] * c[1] + m.matrix[8 + k] * c[2] + m.matrix[12 + k];
          lo[k] = Math.min(lo[k], v);
          hi[k] = Math.max(hi[k], v);
        }
      }
    }
    if (!Number.isFinite(lo[0])) return null;
    const target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const radius = Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    const fov = 0.6, yaw = -Math.PI / 2 - 0.6, pitch = 0.6;
    const dist = (radius * 1.08) / Math.sin(fov / 2);
    const eye = [
      target[0] + dist * Math.cos(pitch) * Math.cos(yaw),
      target[1] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[2] + dist * Math.sin(pitch),
    ];
    const viewProj = multiply(perspective(fov, w / h, dist / 20, dist * 3), lookAt(eye, target));

    const prog = program(gl, MESH_VS, MESH_FS);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u('viewProj'), false, viewProj);
    gl.uniform3fv(u('eye'), eye);
    gl.uniform1f(u('glow'), 0);
    const tint = hexColour(colour);
    const uploaded = new Map<string, { vao: WebGLVertexArrayObject; count: number }>();
    for (const m of models) {
      const mesh = project.meshes.get(m.mesh);
      if (!mesh || !mesh.indices.length) continue;
      let g = uploaded.get(m.mesh);
      if (!g) {
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
        g = { vao, count: mesh.indices.length };
        uploaded.set(m.mesh, g);
      }
      gl.uniformMatrix4fv(u('model'), false, m.matrix);
      gl.uniform3fv(u('color'), mesh.boxed ? [0.55, 0.58, 0.62] : tint);
      gl.bindVertexArray(g.vao);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    }
    gl.finish();
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const g2 = small.getContext('2d');
    if (!g2) return null;
    g2.imageSmoothingQuality = 'high';
    g2.drawImage(canvas, 0, 0, w, h);
    return small.toDataURL('image/png').split(',')[1] ?? null;
  } catch {
    return null;
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
