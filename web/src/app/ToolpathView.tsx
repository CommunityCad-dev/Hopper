import { useEffect, useRef, useState } from 'preact/hooks';

import { useBedLook } from './bedLook';
import { useGlCanvas } from './gl';
import { createScene, program } from './scene';
import type { Bed, Scene, ViewPreset } from './scene';
import { ROLES, readToolpaths } from './toolpaths';
import type { Toolpaths } from './toolpaths';

interface Props {
  /** Moonraker URLs of the sliced files, one per plate. */
  files: string[];
  bed: Bed;
  plate: number;
  onPlate: (index: number) => void;
  /** Plate numbers as Orca numbered them, for the buttons. */
  plateIds: number[];
  /** Pauses and filament changes on this plate, marked on the slider. */
  marks?: { z: number; kind: 'pause' | 'filament' }[];
  /** The layer shown: its top in mm, for adding a pause there. */
  onLayer?: (z: number | null) => void;
}

/**
 * Orca's Preview, simplified: the sliced toolpaths on the same bed as Prepare,
 * coloured by feature type with Orca's colours, a layer slider down the right side,
 * and a legend that hides and shows feature types. Lines rather than Orca's tubes,
 * so a phone stays smooth.
 */
export function ToolpathView({ files, bed, plate, onPlate, plateIds, marks = [], onLayer }: Props) {
  const [paths, setPaths] = useState<Toolpaths | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [layer, setLayer] = useState(0);
  const [hidden, setHidden] = useState(0);
  const control = useRef<Scene | null>(null);
  const url = files[plate] ?? files[0];

  useEffect(() => {
    let live = true;
    setPaths(null);
    setError(null);
    setProgress(0);
    if (!url) return;
    readToolpaths(url, (f) => live && setProgress(f))
      .then((p) => {
        if (!live) return;
        setPaths(p);
        setLayer(p.layers.length);
      })
      .catch(() => live && setError("Couldn't read the sliced file."));
    return () => { live = false; };
  }, [url]);

  const total = paths?.layers.length ?? 0;
  const shown = Math.max(1, Math.min(layer, total));
  const z = paths?.layers[shown - 1]?.z;
  useEffect(() => { onLayer?.(total > 0 && z != null ? z : null); }, [z, total]);
  // A mark sits at its layer: the nearest layer top to its height.
  const markAt = (mz: number) => {
    const layers = paths?.layers ?? [];
    let best = 0;
    layers.forEach((l, i) => { if (Math.abs(l.z - mz) < Math.abs(layers[best].z - mz)) best = i; });
    return best;
  };

  return (
    <div class="plate-view">
      <div class="plate-canvas">
        {paths && total > 0 ? (
          <Lines paths={paths} bed={bed} label={String(plateIds[plate] ?? plate + 1).padStart(2, '0')}
            layer={shown} hidden={hidden} control={control} />
        ) : (
          <p class="plate-note">
            {error ?? (paths ? 'Nothing is extruded in this file.' : `Reading the toolpaths… ${Math.round(progress * 100)}%`)}
          </p>
        )}
        {files.length > 1 && (
          <div class="plate-list left" role="tablist" aria-label="Plates">
            {files.map((f, i) => (
              <button key={f} type="button" role="tab" aria-selected={i === plate}
                aria-label={`Plate ${plateIds[i] ?? i + 1}`} onClick={() => onPlate(i)}>
                {String(plateIds[i] ?? i + 1).padStart(2, '0')}
              </button>
            ))}
          </div>
        )}
        {total > 0 && (
          <div class="layer-slider">
            <span class="layer-label">{shown}<small>{z != null ? `${z.toFixed(2)}` : ''}</small></span>
            <div class="layer-track">
              <input type="range" min={1} max={total} value={shown} aria-label="Layer"
                onInput={(e) => setLayer(Number((e.target as HTMLInputElement).value))} />
              {marks.map((m) => {
                const i = markAt(m.z);
                return (
                  <button key={`${m.kind}${m.z}`} type="button" class={`layer-mark ${m.kind}`}
                    style={`bottom:${total > 1 ? (i / (total - 1)) * 100 : 0}%`}
                    title={`${m.kind === 'pause' ? 'Pause' : 'Filament change'} before ${m.z.toFixed(2)} mm`}
                    aria-label={`Go to the ${m.kind === 'pause' ? 'pause' : 'filament change'} at ${m.z.toFixed(2)} mm`}
                    onClick={() => setLayer(i + 1)} />
                );
              })}
            </div>
            <span class="layer-label">1</span>
          </div>
        )}
        {total > 0 && (
          <div class="plate-tools" role="toolbar" aria-label="View">
            {(['iso', 'top', 'front'] as ViewPreset[]).map((v) => (
              <button key={v} type="button" onClick={() => control.current?.preset(v)}>
                {v === 'iso' ? 'Iso' : v === 'top' ? 'Top' : 'Front'}
              </button>
            ))}
          </div>
        )}
        {total > 0 && <span class="plate-count">Layer {shown} of {total}{paths?.truncated ? ', top layers not shown' : ''}</span>}
      </div>
      {paths && (
        <div class="legend" aria-label="Feature types">
          {ROLES.map(([name, colour], i) => paths.counts[i] > 0 && (
            <button key={name} type="button" aria-pressed={!(hidden & (1 << i))}
              onClick={() => setHidden((h) => h ^ (1 << i))}>
              <span class="swatch" style={`background:${colour}`} />
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LINE_VS = `#version 300 es
in vec3 pos;
in float role;
uniform mat4 viewProj;
uniform vec3 palette[${ROLES.length}];
uniform int hidden;
uniform int topStart;
out vec3 colour;
void main(){
  int r = int(role + 0.5);
  colour = palette[r] * (gl_VertexID >= topStart ? 1.0 : 0.78);
  gl_Position = ((hidden >> r) & 1) == 1 ? vec4(2.0, 2.0, 2.0, 1.0) : viewProj * vec4(pos, 1.0);
}`;

const LINE_FS = `#version 300 es
precision mediump float;
in vec3 colour;
out vec4 frag;
void main(){ frag = vec4(colour, 1.0); }`;

function Lines({ paths, bed, label, layer, hidden, control }: {
  paths: Toolpaths; bed: Bed; label: string; layer: number; hidden: number;
  control: { current: Scene | null };
}) {
  const { canvas, context, gen, lost, retry } = useGlCanvas();
  const state = useRef({ layer, hidden });
  state.current = { layer, hidden };
  const look = useBedLook();

  useEffect(() => { control.current?.redraw(); }, [layer, hidden]);

  useEffect(() => {
    const el = canvas.current;
    const gl = context();
    if (!el || !gl || look === undefined) return;
    const prog = program(gl, LINE_VS, LINE_FS);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, paths.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const rb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, rb);
    gl.bufferData(gl.ARRAY_BUFFER, paths.roles, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.bindVertexArray(null);
    const palette = new Float32Array(ROLES.flatMap(([, hex]) =>
      [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)));

    const top = paths.layers[paths.layers.length - 1]?.z ?? 0;
    const scene = createScene(el, gl, bed, label, top, ({ viewProj }) => {
      const { layer: shown, hidden: mask } = state.current;
      const end = paths.layers[shown - 1]?.end ?? 0;
      const start = paths.layers[shown - 2]?.end ?? 0;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(u('viewProj'), false, viewProj);
      gl.uniform3fv(u('palette'), palette);
      gl.uniform1i(u('hidden'), mask);
      gl.uniform1i(u('topStart'), start);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.LINES, 0, end);
    }, look);
    control.current = scene;

    return () => {
      control.current = null;
      scene.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(pb);
      gl.deleteBuffer(rb);
      gl.deleteProgram(prog);
    };
  }, [paths, bed.width, bed.depth, bed.height, label, look, gen]);

  if (lost) {
    return (
    <div class="gl-lost" role="status">
      <p>The browser reset its 3D drawing, so the preview stopped showing.</p>
      <button class="btn ghost sm" type="button" onClick={retry}>Show it again</button>
    </div>
    );
  }
  return <canvas key={gen} ref={canvas} aria-label="The toolpaths, in 3D" />;
}
