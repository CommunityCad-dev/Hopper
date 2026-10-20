/**
 * The 3D view shared by Prepare and Preview: an Orca-style bed,
 * a camera, and touch and mouse gestures, in WebGL2 with no library. What sits on
 * the bed -- models or toolpaths -- is drawn by the caller's `content` function.
 *
 * Drag to turn, pinch or scroll to zoom, two fingers (or right-drag) to move,
 * double-tap to reset.
 */
import type { BedLook } from './bedLook';
import { multiply } from './plate3mf';

export type ViewPreset = 'iso' | 'top' | 'front';

export interface Bed { width: number; depth: number; height: number }

export interface Frame {
  gl: WebGL2RenderingContext;
  viewProj: Float32Array;
  eye: number[];
}

export interface Scene {
  redraw: () => void;
  preset: (p: ViewPreset) => void;
  dispose: () => void;
  /** The world ray under a point on the screen, from the last frame's camera. */
  ray: (clientX: number, clientY: number) => Ray | null;
}

export interface Ray { origin: [number, number, number]; dir: [number, number, number] }

/** What the caller does with taps and drags. dragStart returns true to take a
 * one-finger drag for itself (moving a model) instead of turning the view. */
export interface Hooks {
  tap?: (x: number, y: number) => void;
  hover?: (x: number, y: number) => void;
  dragStart?: (x: number, y: number) => boolean;
  drag?: (x: number, y: number) => void;
  dragEnd?: () => void;
  /** Right after each frame, while the drawing is still readable (a thumbnail). */
  afterDraw?: (canvas: HTMLCanvasElement) => void;
}

/** Inverse of a column-major 4x4 (general, via cofactors). */
export function invert(m: Float32Array): Float32Array | null {
  const a = m;
  const out = new Float32Array(16);
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
  out[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  out[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
  out[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  out[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
  out[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  out[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
  out[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  out[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
  out[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  out[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
  out[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  out[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
  out[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  out[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
  out[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return out;
}

const FLAT_VS = `#version 300 es
in vec3 pos;
uniform mat4 viewProj;
void main(){ gl_Position = viewProj * vec4(pos, 1.0); }`;

const FLAT_FS = `#version 300 es
precision mediump float;
uniform vec4 color;
out vec4 frag;
void main(){ frag = color; }`;

const TEX_VS = `#version 300 es
in vec3 pos;
uniform mat4 viewProj;
uniform vec2 size;
out vec2 uv;
void main(){ uv = pos.xy / size; gl_Position = viewProj * vec4(pos, 1.0); }`;

const TEX_FS = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D sheet;
out vec4 frag;
void main(){ frag = texture(sheet, uv); }`;

// Orca's bed model, lit like its own: flat shading from screen-space derivatives.
const BED_VS = `#version 300 es
in vec3 pos;
uniform mat4 viewProj;
uniform vec3 shift;
out vec3 world;
void main(){ world = pos + shift; gl_Position = viewProj * vec4(world, 1.0); }`;

const BED_FS = `#version 300 es
precision highp float;
in vec3 world;
out vec4 frag;
void main(){
  vec3 n = normalize(cross(dFdx(world), dFdy(world)));
  if (n.z < 0.0) n = -n;
  float light = 0.55 + 0.45 * max(dot(n, normalize(vec3(-0.3, -0.5, 0.8))), 0.0);
  frag = vec4(vec3(0.27, 0.28, 0.31) * light, 1.0);
}`;

const FOV = 0.6;

/** `fit`: the distance follows the canvas shape until the user zooms. */
export interface Camera { yaw: number; pitch: number; dist: number; fit: boolean; target: [number, number, number] }

export function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'pos');
  gl.bindAttribLocation(p, 1, 'role');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'shader');
  return p;
}

export function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function lookAt(eye: number[], target: number[]): Float32Array {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map((x) => x / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target));
  const x = norm(cross([0, 0, 1], z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

/** The textured sheet: speckled like PEI, a 10 mm grid, the plate's number. */
function sheetImage(w: number, d: number, label: string, texture: HTMLImageElement | null,
  overModel: boolean): HTMLCanvasElement {
  const scale = Math.min(4, 2048 / Math.max(w, d));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(d * scale);
  const g = c.getContext('2d')!;
  // Over Orca's bed model the sheet is see-through, so the model's surface shows,
  // as in Orca; on its own it's a textured sheet.
  g.fillStyle = overModel ? 'rgba(69,72,79,0.35)' : '#45484f';
  g.fillRect(0, 0, c.width, c.height);
  if (texture) {
    // Orca stretches the bed texture over the whole printable area.
    try { g.drawImage(texture, 0, 0, c.width, c.height); } catch { /* not drawable: skip it */ }
  }
  // Seeded speckle, so the sheet looks the same every time.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < c.width * c.height / 60; i++) {
    g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
    g.fillRect(rnd() * c.width, rnd() * c.height, 1.5, 1.5);
  }
  g.lineWidth = Math.max(1, scale * 0.25);
  for (let mm = 10; mm < Math.max(w, d); mm += 10) {
    g.strokeStyle = mm % 50 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.16)';
    if (mm < w) { g.beginPath(); g.moveTo(mm * scale, 0); g.lineTo(mm * scale, c.height); g.stroke(); }
    if (mm < d) { g.beginPath(); g.moveTo(0, mm * scale); g.lineTo(c.width, mm * scale); g.stroke(); }
  }
  // The canvas's y runs down and the bed's runs back; the texture is flipped on
  // upload, so the canvas's bottom-left is the bed's front-left, where Orca puts it.
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.font = `600 ${Math.round(Math.min(w, d) * 0.09 * scale)}px Roboto, system-ui, sans-serif`;
  g.textBaseline = 'bottom';
  g.fillText(label, 6 * scale, c.height - 4 * scale);
  return c;
}

/** The build volume's edges, and the X/Y axes at the origin. */
function frameLines(w: number, d: number, h: number) {
  const box = [
    0, 0, 0, w, 0, 0, w, 0, 0, w, d, 0, w, d, 0, 0, d, 0, 0, d, 0, 0, 0, 0,
    0, 0, h, w, 0, h, w, 0, h, w, d, h, w, d, h, 0, d, h, 0, d, h, 0, 0, h,
    0, 0, 0, 0, 0, h, w, 0, 0, w, 0, h, w, d, 0, w, d, h, 0, d, 0, 0, d, h,
  ];
  const a = Math.min(w, d) * 0.12;
  const head = a * 0.18;
  const z = 0.3;
  const xAxis = [0, 0, z, a, 0, z, a, 0, z, a - head, head * 0.6, z, a, 0, z, a - head, -head * 0.6, z];
  const yAxis = [0, 0, z, 0, a, z, 0, a, z, head * 0.6, a - head, z, 0, a, z, -head * 0.6, a - head, z];
  return { box: new Float32Array(box), x: new Float32Array(xAxis), y: new Float32Array(yAxis) };
}

/**
 * Set up the bed, camera and gestures on `el`. `label` is the plate number on the
 * sheet; `top` the height the camera aims a little above. `content` draws what's
 * on the bed, after the bed, with depth testing on.
 */
export function createScene(
  el: HTMLCanvasElement, gl: WebGL2RenderingContext, bed: Bed, label: string, top: number,
  content: (frame: Frame) => void, look: BedLook | null = null, hooks: Hooks = {},
  /** Holds the camera across rebuilds (a placement reloads the project): the view stays put. */
  keep: { current: Camera | null } = { current: null },
): Scene {
  const { width: W, depth: D, height: H } = bed;
  const flatProg = program(gl, FLAT_VS, FLAT_FS);
  const texProg = program(gl, TEX_VS, TEX_FS);
  const bedProg = look?.triangles?.length ? program(gl, BED_VS, BED_FS) : null;
  const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);

  const buffers: WebGLBuffer[] = [];
  const arrays: WebGLVertexArrayObject[] = [];
  const vao = (positions: Float32Array) => {
    const v = gl.createVertexArray()!;
    arrays.push(v);
    gl.bindVertexArray(v);
    const b = gl.createBuffer()!;
    buffers.push(b);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return v;
  };
  const quad = (x0: number, y0: number, x1: number, y1: number, z: number) =>
    vao(new Float32Array([x0, y0, z, x1, y0, z, x0, y1, z, x1, y1, z]));

  const rim = Math.max(W, D) * 0.025;
  const frame = quad(-rim, -rim, W + rim, D + rim, -0.6);
  // With Orca's model the sheet floats just above the model's top, at z = 0.
  const sheet = quad(0, 0, W, D, bedProg ? 0.02 : -0.1);
  const bedModel = bedProg && look?.triangles ? vao(look.triangles) : null;
  const lines = frameLines(W, D, H);
  const box = vao(lines.box);
  const xAxis = vao(lines.x);
  const yAxis = vao(lines.y);
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
      sheetImage(W, D, label, look?.texture ?? null, !!bedProg));
  } catch {
    // A texture the browser won't hand to WebGL: the plate without it.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sheetImage(W, D, label, null, !!bedProg));
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Straight down is avoided by a hair: lookAt needs a horizontal direction for "right".
  const PRESETS: Record<ViewPreset, [number, number]> = {
    iso: [-Math.PI / 2 - 0.6, 0.6], top: [-Math.PI / 2, Math.PI / 2 - 0.001], front: [-Math.PI / 2, 0.1],
  };
  const home = (preset: ViewPreset = 'iso'): Camera => ({
    yaw: PRESETS[preset][0], pitch: PRESETS[preset][1], dist: Math.max(W, D) * 1.75, fit: true,
    target: [W / 2, D / 2, Math.min(top, H) * 0.3],
  });
  let cam = keep.current ?? home();
  keep.current = cam;
  let frameId = 0;
  let lastInverse: Float32Array | null = null;

  const draw = () => {
    frameId = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(el.clientWidth * dpr));
    const ch = Math.max(1, Math.round(el.clientHeight * dpr));
    if (el.width !== cw || el.height !== ch) { el.width = cw; el.height = ch; }
    gl.viewport(0, 0, cw, ch);
    if (cam.fit) {
      // The whole bed in view, whichever way the canvas is narrower.
      const half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * cw / ch));
      cam.dist = (Math.hypot(W, D) / 2 + rim) / Math.sin(half);
    }
    gl.clearColor(0.15, 0.15, 0.17, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const eye = [
      cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw),
      cam.target[1] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw),
      cam.target[2] + cam.dist * Math.sin(cam.pitch),
    ];
    const reach = Math.max(W, D, H) * 4 + cam.dist;
    const viewProj = multiply(perspective(FOV, cw / ch, Math.max(1, cam.dist / 50), reach), lookAt(eye, cam.target));
    lastInverse = invert(viewProj);

    gl.useProgram(flatProg);
    gl.uniformMatrix4fv(u(flatProg, 'viewProj'), false, viewProj);
    const flat = (v: WebGLVertexArrayObject, mode: number, n: number, rgba: number[]) => {
      gl.uniform4fv(u(flatProg, 'color'), rgba);
      gl.bindVertexArray(v);
      gl.drawArrays(mode, 0, n);
    };
    if (bedProg && bedModel && look?.triangles) {
      // Orca puts the model's origin at the bed's centre, a hair below the sheet.
      gl.useProgram(bedProg);
      gl.uniformMatrix4fv(u(bedProg, 'viewProj'), false, viewProj);
      gl.uniform3f(u(bedProg, 'shift'), W / 2, D / 2, -0.03);
      gl.bindVertexArray(bedModel);
      gl.drawArrays(gl.TRIANGLES, 0, look.triangles.length / 3);
      gl.useProgram(flatProg);
    } else {
      flat(frame, gl.TRIANGLE_STRIP, 4, [0.24, 0.25, 0.28, 1]);
    }

    gl.useProgram(texProg);
    gl.uniformMatrix4fv(u(texProg, 'viewProj'), false, viewProj);
    gl.uniform2f(u(texProg, 'size'), W, D);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindVertexArray(sheet);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(flatProg);
    flat(box, gl.LINES, lines.box.length / 3, [0.6, 0.62, 0.68, 0.35]);
    flat(xAxis, gl.LINES, lines.x.length / 3, [0.93, 0.27, 0.27, 1]);
    flat(yAxis, gl.LINES, lines.y.length / 3, [0.3, 0.8, 0.35, 1]);
    gl.bindVertexArray(null);

    content({ gl, viewProj, eye });
    hooks.afterDraw?.(el);
    gl.bindVertexArray(null);
  };
  const redraw = () => { if (!frameId) frameId = requestAnimationFrame(draw); };

  // Gestures: one pointer turns, two pinch and move, double-tap resets.
  const pointers = new Map<number, { x: number; y: number }>();
  let lastTap = 0;
  const pan = (dx: number, dy: number) => {
    const scale = cam.dist / el.clientHeight;
    const sx = -Math.sin(cam.yaw), sy = Math.cos(cam.yaw);
    const fx = -Math.cos(cam.yaw), fy = -Math.sin(cam.yaw);
    cam.target = [
      cam.target[0] - (dx * sx - dy * fx) * scale,
      cam.target[1] - (dx * sy - dy * fy) * scale,
      cam.target[2],
    ];
  };
  const zoomTo = (dist: number) => {
    cam.fit = false;
    cam.dist = Math.min(Math.max(W, D) * 6, Math.max(20, dist));
  };
  // A tap is a press and release that barely moved; it goes to hooks.tap.
  let pressed: { x: number; y: number; t: number; moved: boolean } | null = null;
  let dragging = false;
  const down = (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      pressed = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false };
      dragging = e.button === 0 && !!hooks.dragStart?.(e.clientX, e.clientY);
      const now = e.timeStamp;
      // Double-tap resets the view, except where a tap selects (the view buttons do it there).
      if (!dragging && !hooks.tap && now - lastTap < 300) { cam = home(); keep.current = cam; redraw(); }
      lastTap = now;
    } else {
      pressed = null;
      if (dragging) { dragging = false; hooks.dragEnd?.(); }
    }
  };
  const move = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse') hooks.hover?.(e.clientX, e.clientY);
      return;
    }
    if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 6) pressed.moved = true;
    if (dragging) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      hooks.drag?.(e.clientX, e.clientY);
      return;
    }
    const pts = [...pointers.values()];
    if (pointers.size === 1) {
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      if (e.buttons & 2 || e.shiftKey) pan(dx, dy);
      else {
        cam.yaw -= dx * 0.008;
        cam.pitch = Math.min(Math.PI / 2 - 0.001, Math.max(0.02, cam.pitch + dy * 0.008));
      }
    } else if (pointers.size === 2) {
      const other = pts.find((p) => p !== prev)!;
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (after > 0) zoomTo(cam.dist * before / after);
      pan((e.clientX - prev.x) / 2, (e.clientY - prev.y) / 2);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    redraw();
  };
  const up = (e: PointerEvent) => {
    const wasTap = pointers.size === 1 && pressed && !pressed.moved && e.timeStamp - pressed.t < 500;
    pointers.delete(e.pointerId);
    if (dragging) { dragging = false; hooks.dragEnd?.(); }
    if (wasTap && e.type === 'pointerup') hooks.tap?.(e.clientX, e.clientY);
    pressed = null;
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomTo(cam.dist * Math.exp(e.deltaY * 0.0015));
    redraw();
  };
  const menu = (e: Event) => e.preventDefault();
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('contextmenu', menu);
  const resize = new ResizeObserver(redraw);
  resize.observe(el);
  redraw();

  const ray = (clientX: number, clientY: number): Ray | null => {
    if (!lastInverse) return null;
    const r = el.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = 1 - ((clientY - r.top) / r.height) * 2;
    const at = (z: number) => {
      const m = lastInverse!;
      const x = m[0] * nx + m[4] * ny + m[8] * z + m[12];
      const y = m[1] * nx + m[5] * ny + m[9] * z + m[13];
      const zz = m[2] * nx + m[6] * ny + m[10] * z + m[14];
      const w = m[3] * nx + m[7] * ny + m[11] * z + m[15];
      return [x / w, y / w, zz / w];
    };
    const a = at(-1), b = at(1);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return { origin: [a[0], a[1], a[2]], dir: [d[0] / len, d[1] / len, d[2] / len] };
  };

  return {
    redraw,
    ray,
    preset: (p) => { cam = home(p); keep.current = cam; redraw(); },
    dispose: () => {
      if (frameId) cancelAnimationFrame(frameId);
      resize.disconnect();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', menu);
      for (const v of arrays) gl.deleteVertexArray(v);
      for (const b of buffers) gl.deleteBuffer(b);
      gl.deleteTexture(texture);
      gl.deleteProgram(flatProg);
      gl.deleteProgram(texProg);
      if (bedProg) gl.deleteProgram(bedProg);
    },
  };
}
