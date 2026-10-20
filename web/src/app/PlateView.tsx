import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { useBedLook } from './bedLook';
import { ICONS, Icon } from './icons';
import {
  centre, centreOnPlate, hit, layOnFace, moveCentreTo, objectTriangles, onBed, restingFaces, turnZ,
} from './placement';
import type { Faces } from './placement';
import { multiply, readProject, toTransform } from './plate3mf';
import type { Mesh, PlacedModel, Project3mf } from './plate3mf';
import { canDraw3d, useGlCanvas } from './gl';
import { createScene, program } from './scene';
import type { Camera, Scene } from './scene';

/** One placement for the Pi to write: a build item's new transform. */
export interface Placement { object: string; instance: number; transform: number[] }

interface Props {
  /** The project file, from Moonraker. */
  url: string;
  /** Changes whenever the project file does, so the plate is read again. */
  version: number;
  /** The filament's colour, "#rrggbb": models are drawn in it, as in Orca. */
  colour: string;
  plate: number;
  onPlate: (index: number, count: number) => void;
  /** Re-arrange the plate (Orca's Update plate). Highlighted when the plate changed. */
  onArrange?: () => void;
  arrangeNeeded?: boolean;
  arranging?: boolean;
  /** The bed as the project describes it, once read: Preview draws the same one. */
  onBed?: (bed: Project3mf['bed']) => void;
  /** Write placements to the project. Absent: models can't be moved here. */
  onPlace?: (changes: Placement[]) => Promise<void>;
  /** Asked for when the project's thumbnail is missing or out of date: a PNG of
   * the first plate from the starting view, base64. */
  onThumbnail?: (png: string) => void;
  /** Why placing is unavailable just now, e.g. copies changed but not arranged yet. */
  placeBlocked?: string | null;
  /** The project as read, for G-code thumbnails at Send time. */
  onProject?: (project: Project3mf) => void;
}

type Mode = 'none' | 'face' | 'move';
const keyOf = (m: { object: string; instance: number }) => `${m.object}/${m.instance}`;
const SNAP = 5;

/**
 * The plate, as Orca laid it out, drawn the way Orca draws its Prepare view
 *, with Orca's basic placement tools: tap a model to select it, then
 * lay it on a face, turn it, or drag it, snapping to a 5 mm grid. Each change is
 * written to the project on the Pi, which sets it down on the bed.
 */
export function PlateView({
  url, version, colour, plate, onPlate, onArrange, arrangeNeeded, arranging, onBed, onPlace, placeBlocked, onThumbnail, onProject,
}: Props) {
  const [project, setProject] = useState<Project3mf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('none');
  const [snap, setSnap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Placement[][]>([]);
  const scene = useRef<Scene | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    if (!canDraw3d()) {
      setError(typeof DecompressionStream === 'undefined'
        ? "This browser can't show the plate. Slicing still works."
        : 'The browser has turned off 3D drawing for this page, so the plate can\'t be shown. '
          + 'Slicing still works. Try again, or reload the page.');
      return;
    }
    fetch(`${url}?v=${version}`, { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.arrayBuffer();
      })
      .then((buf) => readProject(new Uint8Array(buf)))
      .then((p) => {
        if (!live) return;
        setProject(p);
        onBed?.(p.bed);
        onProject?.(p);
        onPlate(Math.min(plate, Math.max(0, p.plates.length - 1)), p.plates.length);
      })
      .catch(() => live && setError("Couldn't read the plate from this project."));
    return () => { live = false; };
  }, [url, version, attempt]);

  const plates = project?.plates ?? [];
  const current = plates[plate];
  const count = new Set((current?.models ?? []).map(keyOf)).size;
  const boxed = current?.models.some((m) => project?.meshes.get(m.mesh)?.boxed) ?? false;
  const canPlace = !!onPlace && !placeBlocked && !busy;

  // The selected item's parts, triangles and resting faces.
  const selection = useMemo(() => {
    if (!project || !current || !selected) return null;
    const parts = current.models.filter((m) => keyOf(m) === selected);
    if (!parts.length) return null;
    const tris = objectTriangles(parts, project.meshes);
    return { parts, tris, centre: centre(tris), faces: null as Faces | null, item: parts[0].item };
  }, [project, current, selected]);
  if (selection && mode === 'face' && !selection.faces) selection.faces = restingFaces(selection.tris);

  useEffect(() => { if (!selection) setMode('none'); }, [selection]);
  useEffect(() => { setSelected(null); }, [plate]);

  const place = async (changes: Placement[], before: Placement[]) => {
    if (!onPlace) return;
    setBusy(true);
    setPlaceError(null);
    try {
      await onPlace(changes);
      setUndo((u) => [...u.slice(-19), before]);
    } catch (err) {
      setPlaceError(err instanceof Error ? err.message : 'Could not place the model.');
    } finally {
      setBusy(false);
    }
  };
  const placeItem = (item: Float32Array) => {
    if (!selection) return;
    const [object, instance] = selected!.split('/');
    void place(
      [{ object, instance: Number(instance), transform: toTransform(item) }],
      [{ object, instance: Number(instance), transform: toTransform(selection.item) }],
    );
  };
  const undoLast = () => {
    const last = undo[undo.length - 1];
    if (!last || !onPlace) return;
    setUndo((u) => u.slice(0, -1));
    setBusy(true);
    onPlace(last).catch((err) => setPlaceError(err instanceof Error ? err.message : 'Could not undo.'))
      .finally(() => setBusy(false));
  };

  const name = selection?.parts[0].name.replace(/\.(stl|obj|3mf|step|stp)(_\d+)?$/i, '$2') ?? '';

  return (
    <div class="plate-view">
      <div class="plate-canvas">
        {project && current ? (
          <Viewport
            project={project} plate={plate} colour={colour} scene={scene}
            selected={selected} mode={mode} selection={selection} snap={snap}
            onSelect={(key) => { setSelected(key); setPlaceError(null); }}
            onLay={(normal) => { if (selection) { placeItem(layOnFace(selection.item, normal, selection.centre)); setMode('none'); } }}
            onMoved={(item) => placeItem(item)}
            canPlace={canPlace} failed={placeError}
            onThumbnail={plate === 0 ? onThumbnail : undefined}
          />
        ) : (
          <div class="plate-note">
            <p>{error ?? 'Reading the plate…'}</p>
            {error && <button class="btn ghost sm" type="button" onClick={() => setAttempt((a) => a + 1)}>Try again</button>}
          </div>
        )}
        {plates.length > 1 && (
          <div class="plate-list" role="tablist" aria-label="Plates">
            {plates.map((p, i) => (
              <button key={p.id} type="button" role="tab" aria-selected={i === plate}
                aria-label={`Plate ${p.id}`} onClick={() => onPlate(i, plates.length)}>
                {String(p.id).padStart(2, '0')}
              </button>
            ))}
          </div>
        )}
        {project && selection && onPlace && (
          <div class="sel-tools" role="toolbar" aria-label={`Place ${name}`}>
            <span class="sel-name">{name}</span>
            <button type="button" class={mode === 'face' ? 'on' : ''} disabled={!canPlace}
              title="Tap a flat face to put it on the bed" onClick={() => setMode(mode === 'face' ? 'none' : 'face')}>
              Lay on face
            </button>
            <button type="button" disabled={!canPlace} aria-label="Turn 90 degrees left"
              onClick={() => placeItem(turnZ(selection.item, 90, selection.centre))}>⟲ 90°</button>
            <button type="button" disabled={!canPlace} aria-label="Turn 90 degrees right"
              onClick={() => placeItem(turnZ(selection.item, -90, selection.centre))}>⟳ 90°</button>
            <TurnBy disabled={!canPlace} onTurn={(deg) => placeItem(turnZ(selection.item, deg, selection.centre))} />
            <button type="button" class={mode === 'move' ? 'on' : ''} disabled={!canPlace}
              title="Drag the model on the plate" onClick={() => setMode(mode === 'move' ? 'none' : 'move')}>
              Move
            </button>
            {mode === 'move' && (
              <label class="snap"><input type="checkbox" checked={snap} onChange={() => setSnap(!snap)} /> Snap {SNAP} mm</label>
            )}
            <button type="button" aria-label="Done" onClick={() => setSelected(null)}>✕</button>
          </div>
        )}
        {project && (
          <div class="plate-tools" role="toolbar" aria-label="View">
            {onArrange && (
              <button type="button" class={arrangeNeeded ? 'on' : ''} disabled={arranging}
                title="Arrange the plate again, as Orca does" onClick={onArrange}>
                <Icon path={ICONS.arrange} size={16} /> {arranging ? 'Arranging…' : 'Arrange'}
              </button>
            )}
            {onPlace && undo.length > 0 && (
              <button type="button" disabled={!canPlace} onClick={undoLast}>Undo</button>
            )}
            <button type="button" title="Isometric view" onClick={() => scene.current?.preset('iso')}>Iso</button>
            <button type="button" title="Top view" onClick={() => scene.current?.preset('top')}>Top</button>
            <button type="button" title="Front view" onClick={() => scene.current?.preset('front')}>Front</button>
          </div>
        )}
        {project && (
          <span class="plate-count">
            {busy ? 'Placing…' : mode === 'face' ? 'Tap a highlighted face to put it on the bed'
              : mode === 'move' ? 'Drag the model' : selection ? '' : onPlace ? 'Tap a model to place it'
                : `${count} ${count === 1 ? 'object' : 'objects'}`}
            {boxed && !selection ? ', large ones as boxes' : ''}
            {project.skipped ? `, ${project.skipped} not shown` : ''}
          </span>
        )}
      </div>
      {(placeError || (selection && placeBlocked)) && (
        <p class="sub plate-warn">{placeError ?? placeBlocked}</p>
      )}
    </div>
  );
}

/** A typed turn, for angles the 90-degree buttons don't cover. */
function TurnBy({ disabled, onTurn }: { disabled: boolean; onTurn: (deg: number) => void }) {
  const [value, setValue] = useState('15');
  return (
    <span class="turn-by">
      <input type="number" inputMode="decimal" value={value} disabled={disabled} aria-label="Turn by degrees"
        onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
      <button type="button" disabled={disabled || !Number(value)} onClick={() => onTurn(Number(value))}>Turn</button>
    </span>
  );
}

// --- the models -------------------------------------------------------------

export const MESH_VS = `#version 300 es
in vec3 pos;
uniform mat4 model, viewProj;
out vec3 world;
void main(){ vec4 w = model * vec4(pos, 1.0); world = w.xyz; gl_Position = viewProj * w; }`;

// Flat shading from screen-space derivatives: no normals to compute or upload.
// Two lights and an ambient term, close to Orca's own object shading.
export const MESH_FS = `#version 300 es
precision highp float;
in vec3 world;
uniform vec3 color, eye;
uniform float glow;
out vec4 frag;
void main(){
  vec3 n = normalize(cross(dFdx(world), dFdy(world)));
  vec3 v = normalize(eye - world);
  if (dot(n, v) < 0.0) n = -n;
  vec3 key = normalize(vec3(-0.46, -0.46, 0.76));
  float top = max(dot(n, key), 0.0);
  float front = max(dot(n, normalize(vec3(0.7, -0.1, 0.7))), 0.0);
  float spec = pow(max(dot(reflect(-key, n), v), 0.0), 24.0);
  vec3 c = color * (0.3 + 0.55 * top + 0.25 * front) + vec3(0.08 * spec);
  frag = vec4(mix(c, vec3(1.0, 0.85, 0.45), glow), 1.0);
}`;

// The resting faces in Lay on face, drawn over the model as Orca highlights them.
const FACE_FS = `#version 300 es
precision mediump float;
uniform vec4 tint;
out vec4 frag;
void main(){ frag = tint; }`;

export function hexColour(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) as [number, number, number] : [0.95, 0.46, 0.31];
}

interface Selection { parts: PlacedModel[]; tris: Float32Array; centre: [number, number, number]; faces: Faces | null; item: Float32Array }

function Viewport({
  project, plate, colour, scene, selected, mode, selection, snap, onSelect, onLay, onMoved, canPlace, failed, onThumbnail,
}: {
  onThumbnail?: (png: string) => void;
  project: Project3mf; plate: number; colour: string;
  /** Set when the Pi refused the last placement: drop the preview of it. */
  failed: string | null;
  scene: { current: Scene | null };
  selected: string | null; mode: Mode; selection: Selection | null; snap: boolean;
  onSelect: (key: string | null) => void;
  onLay: (normal: [number, number, number]) => void;
  onMoved: (item: Float32Array) => void;
  canPlace: boolean;
}) {
  const { canvas, context, gen, lost, retry } = useGlCanvas();
  const look = useBedLook();
  const camera = useRef<Camera | null>(null);
  // Everything the draw loop and the gestures read, kept current without rebuilding GL.
  const ui = useRef({ tint: hexColour(colour), selected, mode, selection, snap, canPlace, onSelect, onLay, onMoved,
    hoverFace: -1, moving: null as Float32Array | null });
  Object.assign(ui.current, { tint: hexColour(colour), selected, mode, selection, snap, canPlace, onSelect, onLay, onMoved });
  if (mode !== 'face') ui.current.hoverFace = -1;

  useEffect(() => { scene.current?.redraw(); }, [colour, selected, mode, selection]);
  useEffect(() => {
    if (failed) { ui.current.moving = null; scene.current?.redraw(); }
  }, [failed]);

  useEffect(() => {
    const el = canvas.current;
    const gl = context();
    if (!el || !gl || look === undefined) return;
    const current = project.plates[plate];
    const models = current?.models ?? [];
    const meshProg = program(gl, MESH_VS, MESH_FS);
    const faceProg = program(gl, MESH_VS, FACE_FS);
    const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);

    // Each mesh goes to the GPU once, however many copies are on the plate.
    const buffers: WebGLBuffer[] = [];
    const gpu = new Map<string, { vao: WebGLVertexArrayObject; count: number; mesh: Mesh }>();
    for (const m of models) {
      const mesh = project.meshes.get(m.mesh);
      if (!mesh || gpu.has(m.mesh) || mesh.indices.length === 0) continue;
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const ib = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      buffers.push(vb, ib);
      gpu.set(m.mesh, { vao, count: mesh.indices.length, mesh });
    }
    // The resting faces of the selected model, uploaded when they change.
    const faceVao = gl.createVertexArray()!;
    const faceBuf = gl.createBuffer()!;
    gl.bindVertexArray(faceVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, faceBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    let uploaded: Faces | null = null;

    // Aim at the tallest model.
    let top = 0;
    for (const m of models) {
      const mesh = project.meshes.get(m.mesh);
      if (!mesh) continue;
      for (let i = 0; i < 8; i++) {
        const c = [i & 1 ? mesh.max[0] : mesh.min[0], i & 2 ? mesh.max[1] : mesh.min[1], i & 4 ? mesh.max[2] : mesh.min[2]];
        top = Math.max(top, m.matrix[2] * c[0] + m.matrix[6] * c[1] + m.matrix[10] * c[2] + m.matrix[14]);
      }
    }

    // Per build item: its triangles in object space, for picking.
    const items = new Map<string, { parts: PlacedModel[]; tris: Float32Array | null }>();
    for (const m of models) {
      const k = keyOf(m);
      const entry = items.get(k) ?? { parts: [], tris: null };
      entry.parts.push(m);
      items.set(k, entry);
    }
    const shift = current?.shift ?? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const itemOf = (k: string, base: Float32Array) => (ui.current.moving && k === ui.current.selected ? ui.current.moving : base);
    const worldOf = (k: string) => multiply(shift, itemOf(k, items.get(k)!.parts[0].item));
    const trisOf = (k: string) => {
      const e = items.get(k)!;
      e.tris ??= objectTriangles(e.parts, project.meshes);
      return e.tris;
    };

    let drag: { start: [number, number]; from: number[]; item: Float32Array; centre: [number, number, number] } | null = null;
    let snapped = !!camera.current;     // only from the starting view, not a turned one
    const s = createScene(el, gl, project.bed, String(current?.id ?? 1).padStart(2, '0'), top, ({ viewProj, eye }) => {
      const st = ui.current;
      gl.useProgram(meshProg);
      gl.uniformMatrix4fv(u(meshProg, 'viewProj'), false, viewProj);
      gl.uniform3fv(u(meshProg, 'eye'), eye);
      for (const m of models) {
        const g = gpu.get(m.mesh);
        if (!g) continue;
        const k = keyOf(m);
        gl.uniformMatrix4fv(u(meshProg, 'model'), false, multiply(shift, multiply(itemOf(k, m.item), m.part)));
        gl.uniform3fv(u(meshProg, 'color'), g.mesh.boxed ? [0.55, 0.58, 0.62] : st.tint);
        gl.uniform1f(u(meshProg, 'glow'), k === st.selected ? 0.28 : 0);
        gl.bindVertexArray(g.vao);
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
      }
      const faces = st.mode === 'face' ? st.selection?.faces : null;
      if (faces && st.selected && faces.triangles.length) {
        if (uploaded !== faces) {
          gl.bindBuffer(gl.ARRAY_BUFFER, faceBuf);
          gl.bufferData(gl.ARRAY_BUFFER, faces.triangles, gl.DYNAMIC_DRAW);
          uploaded = faces;
        }
        gl.useProgram(faceProg);
        gl.uniformMatrix4fv(u(faceProg, 'viewProj'), false, viewProj);
        gl.uniformMatrix4fv(u(faceProg, 'model'), false, worldOf(st.selected));
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-2, -2);
        gl.bindVertexArray(faceVao);
        gl.uniform4f(u(faceProg, 'tint'), 0.25, 0.6, 1.0, 0.45);
        gl.drawArrays(gl.TRIANGLES, 0, faces.triangles.length / 3);
        const h = faces.faces[st.hoverFace];
        if (h) {
          gl.uniform4f(u(faceProg, 'tint'), 0.45, 0.85, 1.0, 0.9);
          gl.drawArrays(gl.TRIANGLES, h.start * 3, h.count * 3);
        }
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
    }, look, {
      tap: (x, y) => {
        const st = ui.current;
        const ray = s.ray(x, y);
        if (!ray) return;
        if (st.mode === 'face' && st.selected && st.selection?.faces) {
          const h = hit(ray, worldOf(st.selected), st.selection.tris);
          const f = h ? st.selection.faces.faceOf[h.tri] : -1;
          if (f >= 0 && st.canPlace) st.onLay(st.selection.faces.faces[f].normal);
          return;
        }
        let best: { k: string; dist: number } | null = null;
        for (const k of items.keys()) {
          const h = hit(ray, worldOf(k), trisOf(k));
          if (h && (!best || h.dist < best.dist)) best = { k, dist: h.dist };
        }
        st.onSelect(best?.k ?? null);
      },
      hover: (x, y) => {
        const st = ui.current;
        if (st.mode !== 'face' || !st.selected || !st.selection?.faces) return;
        const ray = s.ray(x, y);
        const h = ray ? hit(ray, worldOf(st.selected), st.selection.tris) : null;
        const f = h ? st.selection.faces.faceOf[h.tri] : -1;
        if (f !== st.hoverFace) { st.hoverFace = f; s.redraw(); }
      },
      dragStart: (x, y) => {
        const st = ui.current;
        if (st.mode !== 'move' || !st.selected || !st.selection || !st.canPlace) return false;
        const ray = s.ray(x, y);
        if (!ray || !hit(ray, worldOf(st.selected), st.selection.tris)) return false;
        const start = onBed(ray);
        if (!start) return false;
        const from = centreOnPlate(st.selection.item, st.selection.centre);
        drag = { start, from, item: st.selection.item, centre: st.selection.centre };
        return true;
      },
      drag: (x, y) => {
        const st = ui.current;
        const ray = s.ray(x, y);
        const at = ray && drag ? onBed(ray) : null;
        if (!at || !drag) return;
        // In the project's coordinates (plates past the first are offset).
        let cx = drag.from[0] + at[0] - drag.start[0];
        let cy = drag.from[1] + at[1] - drag.start[1];
        if (st.snap) { cx = Math.round(cx / SNAP) * SNAP; cy = Math.round(cy / SNAP) * SNAP; }
        st.moving = moveCentreTo(drag.item, drag.centre, cx, cy);
        s.redraw();
      },
      dragEnd: () => {
        const st = ui.current;
        const moved = st.moving;
        drag = null;
        if (moved) st.onMoved(moved);
        // Keep drawing it where it was dropped until the project comes back.
      },
      afterDraw: (glCanvas) => {
        // The first full frame, from the starting view: the project's picture.
        if (snapped || !onThumbnail || !glCanvas.width) return;
        snapped = true;
        const w = 400, h = 300;
        const shot = document.createElement('canvas');
        shot.width = w;
        shot.height = h;
        const g = shot.getContext('2d');
        if (!g) return;
        const scale = Math.max(w / glCanvas.width, h / glCanvas.height);
        const sw = w / scale, sh = h / scale;
        g.drawImage(glCanvas, (glCanvas.width - sw) / 2, (glCanvas.height - sh) / 2, sw, sh, 0, 0, w, h);
        onThumbnail(shot.toDataURL('image/png').split(',')[1] ?? '');
      },
    }, camera);
    scene.current = s;

    return () => {
      scene.current = null;
      ui.current.moving = null;
      s.dispose();
      for (const g of gpu.values()) gl.deleteVertexArray(g.vao);
      for (const b of buffers) gl.deleteBuffer(b);
      gl.deleteVertexArray(faceVao);
      gl.deleteBuffer(faceBuf);
      gl.deleteProgram(meshProg);
      gl.deleteProgram(faceProg);
    };
  }, [project, plate, look, gen]);

  if (lost) {
    return (
    <div class="gl-lost" role="status">
      <p>The browser reset its 3D drawing, so the plate stopped showing.</p>
      <button class="btn ghost sm" type="button" onClick={retry}>Show it again</button>
    </div>
    );
  }
  return <canvas key={gen} ref={canvas} aria-label="The plate, in 3D" />;
}
