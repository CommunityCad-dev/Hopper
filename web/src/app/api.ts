/**
 * Client for the Moonraker component.
 *
 * Same-origin only: the host interface's nginx already proxies `/server/` to
 * Moonraker, so the browser never talks to CommunityCAD directly and never holds
 * the token.
 */
import type {
  DownloadLink, MaterialDetail, MaterialsList, ModelDetail, ModelsList, Permissions, PrinterInfo,
  ProjectEntry, ProjectsList, SearchResult,
  OrcaImportItem, PostOptions, ProcessInfo, ProfileDetail, ProfilesList, SharePayload, SharePrint, SharePrints, SlicedPlate, SliceJob, SliceOptions, Status, StoredModel, LayerMarker, LayerMarkers,
} from './types';

const PATH = '/server/communitycad';

/**
 * Where the component lives.
 *
 * Empty string means "same origin", which is the ordinary case. In a host driving
 * several printers from one page, the injector supplies a resolver that returns the
 * selected printer's Moonraker, so our calls follow the printer the user is looking
 * at rather than whichever machine happens to serve the page.
 */
let resolveBase: () => string = () => '';

export function setApiBaseResolver(fn: () => string): void {
  resolveBase = fn;
}

/** The base currently in use, for detecting that the host switched printers. */
export function currentApiBase(): string {
  try {
    return resolveBase();
  } catch {
    return '';
  }
}

/**
 * A failure already phrased for the user.
 *
 * The phrasing lives here rather than in each screen so that one situation always
 * reads the same way wherever it surfaces, and so the wording is changed in one
 * place. `kind` is what screens branch on; `message` is what they show.
 */
export type FailureKind = 'unreachable' | 'unlinked' | 'rate_limited' | 'server' | 'other';

export class ApiError extends Error {
  readonly status: number;
  readonly kind: FailureKind;
  readonly retryable: boolean;

  constructor(message: string, status: number, kind: FailureKind) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.retryable = kind === 'unreachable' || kind === 'server' || kind === 'rate_limited';
  }
}

const UNREACHABLE = "Can't reach CommunityCAD. Your printer works as normal.";
const DISCONNECTED = 'This printer was disconnected from your account.';

function classify(status: number, message: string): ApiError {
  // A 401 means the token was revoked on the site; the component has already
  // dropped it locally, so the honest thing is to say so and offer Reconnect.
  if (status === 401) return new ApiError(DISCONNECTED, status, 'unlinked');
  if (status === 429) {
    return new ApiError(message || 'CommunityCAD is busy. Try again shortly.', status, 'rate_limited');
  }
  if (status === 0) return new ApiError(UNREACHABLE, status, 'unreachable');
  if (status >= 500 || status === 503) {
    return new ApiError(message || UNREACHABLE, status, 'server');
  }
  return new ApiError(message || UNREACHABLE, status, 'other');
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(currentApiBase() + PATH + path, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // The Pi itself is unreachable — the browser lost the printer, not the site.
    throw new ApiError(UNREACHABLE, 0, 'unreachable');
  }

  let payload: any = null;
  try {
    payload = await resp.json();
  } catch {
    /* an error response without a body is still an error */
  }

  if (!resp.ok) {
    // Moonraker wraps failures as {error: {code, message}}.
    const message: string = payload?.error?.message || payload?.message || '';
    throw classify(resp.status, message);
  }

  // Moonraker wraps success as {result: ...}.
  return (payload?.result ?? payload) as T;
}

export function getStatus(): Promise<Status> {
  return call<Status>('/status');
}

export interface SearchQuery {
  q?: string;
  fit?: 'only' | 'any';
  limit?: number;
  offset?: number;
  printable_only?: boolean;
  sort?: string;
  /** Comma-separated printable types; the Pi filters until the API can. */
  types?: string;
  /** 1: the account's own models, private ones included. */
  mine?: number;
}

export function search(query: SearchQuery): Promise<SearchResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return call<SearchResult>('/search' + (qs ? `?${qs}` : ''));
}

export function getModel(id: number): Promise<ModelDetail> {
  return call<ModelDetail>(`/model?id=${encodeURIComponent(String(id))}`);
}

export interface LinkStart {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export function linkStart(deviceName?: string): Promise<LinkStart> {
  return call<LinkStart>('/link/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceName ? { device_name: deviceName } : {}),
  });
}

export function linkCancel(): Promise<unknown> {
  return call('/link/cancel', { method: 'POST' });
}

export function unlink(): Promise<unknown> {
  return call('/unlink', { method: 'POST' });
}

export function rename(name: string): Promise<{ printer_name: string }> {
  return call('/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export interface SavedFile {
  filename: string;
  bytes: number;
  /** Plate number when the file came out of a sliced 3MF. */
  plate: number | null;
  match: import('./types').MatchReport;
}

export interface SendResult {
  filename: string;
  bytes: number;
  print_started: boolean;
  match: import('./types').MatchReport;
  /** Every file the send produced: one, or one per plate of a sliced 3MF. */
  files?: SavedFile[];
  printer_state?: string | null;
}

export interface PrintResult {
  queued: boolean;
  started: boolean;
  printer_state: string;
}

/**
 * Start a print. `confirm` is always true here because the only caller is a button
 * the user pressed — the component refuses without it, by design.
 */
export function startPrint(filename: string): Promise<PrintResult> {
  return call<PrintResult>('/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, confirm: true }),
  });
}

export function sendToPrinter(modelId: number, fileId: number): Promise<SendResult> {
  return call<SendResult>('/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId, file_id: fileId }),
  });
}

/** A short-lived link to one catalog file, for "Download to this device". The Pi
 * asks CommunityCAD with its own token and passes back only the presigned URL. */
export function downloadUrl(modelId: number, fileId: number): Promise<DownloadLink> {
  return call<DownloadLink>('/download-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId, file_id: fileId }),
  });
}

/** Put a model file (STL, OBJ, unsliced 3MF, STEP) on the printer, for slicing. */
export function saveModel(
  modelId: number,
  fileId: number,
): Promise<{ model?: StoredModel; project?: ProjectEntry; already?: boolean } & Omit<ModelsList, 'models'>> {
  return call('/save-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId, file_id: fileId }),
  });
}

/** Where Moonraker serves a file in printer_data/models, for download. */
export function modelFileUrl(name: string): string {
  return `${currentApiBase()}/server/files/models/${encodeURIComponent(name)}`;
}

/**
 * Upload a file from this device into printer_data/models, through Moonraker's own
 * file API (the path G-code uploads take). XMLHttpRequest rather than fetch, for
 * upload progress.
 */
export function uploadModel(file: File, onProgress: (fraction: number) => void): Promise<void> {
  return uploadTo('models', file, onProgress);
}

export function uploadProject(file: File, onProgress: (fraction: number) => void): Promise<void> {
  return uploadTo('projects', file, onProgress);
}

function uploadTo(root: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('root', root);
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${currentApiBase()}/server/files/upload`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status}).`;
      try {
        message = JSON.parse(xhr.responseText).error?.message ?? message;
      } catch {
        /* not JSON */
      }
      reject(classify(xhr.status, message));
    };
    xhr.onerror = () => reject(new ApiError("Couldn't reach the printer to upload.", 0, 'unreachable'));
    xhr.send(form);
  });
}

/** What the Pi sent or saved, by G-code file name. */
export interface LibraryEntry { model_id?: number; title?: string | null; sent_at?: number }

export function getLibrary(): Promise<{ files: Record<string, LibraryEntry> }> {
  return call('/library');
}

/** Downloads from CommunityCAD running now, keyed "modelId:fileId". */
export function getTransfers(): Promise<{ transfers: Record<string, { name: string; received: number; total: number }> }> {
  return call('/transfers');
}

export function listModels(): Promise<ModelsList> {
  return call<ModelsList>('/models');
}

export function deleteModel(id: string): Promise<unknown> {
  return call('/models/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

export function startSlice(target: { id?: string; project?: string }, options: SliceOptions): Promise<SliceJob> {
  return call<SliceJob>('/slice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...target, ...options }),
  });
}

export function listProjects(): Promise<ProjectsList> {
  return call<ProjectsList>('/projects');
}

type Sources = { model: string; copies: number }[];

export function createProject(models: Sources, options?: Partial<SliceOptions>): Promise<{ project: ProjectEntry }> {
  return call('/projects/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models, ...(options ?? {}) }),
  });
}

export function updateProject(project: string, change: {
  models?: Sources; rename?: string; spacing?: number | null;
} & Partial<SliceOptions>): Promise<{ project: ProjectEntry }> {
  return call('/projects/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, ...change }),
  });
}

/** Turn, lay on a face or move models on the plate; the Pi sets each on the bed. */
export function placeProject(project: string, changes: { object: string; instance: number; transform: number[] }[]):
  Promise<{ project: ProjectEntry }> {
  return call('/projects/place', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, changes }),
  });
}

/** A picture of the project's first plate, kept on the Pi. */
export function saveProjectThumbnail(project: string, png: string): Promise<{ project: ProjectEntry }> {
  return call('/projects/thumbnail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, png }),
  });
}

export function deleteProject(project: string): Promise<unknown> {
  return call('/projects/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  });
}

export function matchReport(filename: string): Promise<{
  filename: string; match: import('./types').MatchReport; printer_state?: string | null;
}> {
  return call(`/match?filename=${encodeURIComponent(filename)}`);
}

/** A file in the G-code files, by its path there ("communitycad/x.gcode"). */
export function gcodeFileUrl(path: string): string {
  return `${currentApiBase()}/server/files/gcodes/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** A project's pauses and filament changes. */
export function getMarkers(project: string): Promise<LayerMarkers> {
  return call<LayerMarkers>(`/projects/markers?project=${encodeURIComponent(project)}`);
}

export function saveMarkers(project: string, markers: LayerMarker[]): Promise<LayerMarkers> {
  return call<LayerMarkers>('/projects/markers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, markers }),
  });
}

export function projectFileUrl(name: string): string {
  return `${currentApiBase()}/server/files/projects/${encodeURIComponent(name)}`;
}

/** Send a sliced plate to the G-code files, with G-code thumbnails. Never starts a print. */
export function sendSlice(plate: number, thumbnails: { width: number; height: number; png: string }[],
  folder?: string): Promise<{ plate: SlicedPlate; printer_state?: string | null }> {
  return call('/slice/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plate, thumbnails, ...(folder !== undefined ? { folder } : {}) }),
  });
}

/** Any file Moonraker serves, by its root-relative path ("projects/.sliced/x.gcode"). */
export function moonrakerFileUrl(path: string): string {
  return `${currentApiBase()}/server/files/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function getSlice(): Promise<SliceJob> {
  return call<SliceJob>('/slice');
}

export function cancelSlice(): Promise<SliceJob> {
  return call<SliceJob>('/slice/cancel', { method: 'POST' });
}

export function setPermissions(answers: Partial<Record<keyof Permissions, boolean>>): Promise<Permissions> {
  return call<Permissions>('/permissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(answers),
  });
}

export function getPrinter(): Promise<{ allowed: boolean; printer: PrinterInfo | null }> {
  return call('/printer');
}

export function getBed(): Promise<{
  name: string | null; model: string | null; texture: string | null; texture_type: string | null;
}> {
  return call('/bed');
}

export function acceptNotice(version: string): Promise<{ accepted: boolean }> {
  return call('/notice', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
  });
}

export function upgradeScopes(): Promise<{ status: string }> {
  return call('/scopes/upgrade', { method: 'POST' });
}

export function listSharePrints(): Promise<SharePrints> {
  return call<SharePrints>('/share/prints');
}

/** Don't share this one: stops an automatic share that hasn't gone yet. */
export function cancelAutoShare(jobId: string): Promise<{ cancelled: string }> {
  return call('/share/auto-cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId }),
  });
}

/** Exactly what a share sends, after CommunityCAD's allowlist; what it won't keep; the plate's picture. */
export function sharePreview(jobId: string, modelId?: number):
  Promise<{ payload: SharePayload; not_shared?: string[]; image?: string | null }> {
  return call(`/share/preview?job_id=${encodeURIComponent(jobId)}${modelId ? `&model_id=${modelId}` : ''}`);
}

export function postOptions(jobId: string): Promise<PostOptions> {
  return call<PostOptions>(`/posts/options?job_id=${encodeURIComponent(jobId)}`);
}

export function webcamSnapshot(): Promise<{ type: string; data: string }> {
  return call('/webcam/snapshot');
}

export function listWebcams(): Promise<{ webcams: { name: string }[] }> {
  return call('/webcams');
}

export function createPost(body: {
  job_id: string; model_id?: number; caption: string; publish: boolean;
  images: { data: string }[]; timelapse: boolean; attach_profile: boolean;
}): Promise<{ post?: { id: number; url: string; edit_url: string; status: string }; message?: string | null;
  video_uploading?: boolean; queued?: boolean }> {
  return call('/posts/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

export function outboxAction(id: string, action: 'retry' | 'delete'): Promise<unknown> {
  return call('/outbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }),
  });
}

export function shareProfile(jobId: string, modelId?: number):
  Promise<{ shared?: SharePrint['shared']; queued?: boolean; message?: string }> {
  return call('/share/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, ...(modelId ? { model_id: modelId } : {}) }),
  });
}

export function dismissSharePrint(jobId: string): Promise<unknown> {
  return call('/share/dismiss', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: jobId }),
  });
}

export function listProfiles(): Promise<ProfilesList> {
  return call<ProfilesList>('/profiles');
}

export function saveProfile(body: {
  name: string; inherits: string; values: Record<string, string>; old_name?: string; create?: boolean;
}): Promise<{ saved: string }> {
  return call('/profiles/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

export function profileDetail(name: string): Promise<ProfileDetail> {
  return call<ProfileDetail>(`/profiles/detail?name=${encodeURIComponent(name)}`);
}

export function deleteProfile(name: string): Promise<unknown> {
  return call('/profiles/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
}

/** Remove one of Orca's default profiles from the lists, or bring it back. */
export function hideProfile(name: string, hidden: boolean):
  Promise<{ hidden: string[]; default_profile: string | null; moved_to: string | null }> {
  return call('/profiles/hide', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, hidden }),
  });
}

export function importOrcaPresets(filename: string, data: string, apply: boolean):
  Promise<{ items: OrcaImportItem[]; applied: boolean }> {
  return call('/orca/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, data, apply }),
  });
}

export function exportOrcaPresets(kind = 'all', name = ''): Promise<{ filename: string; data: string }> {
  return call(`/orca/export?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
}

export function getProcess(): Promise<ProcessInfo> {
  return call<ProcessInfo>('/process');
}

export function listMaterials(): Promise<MaterialsList> {
  return call<MaterialsList>('/materials');
}

export function materialDetail(name: string): Promise<MaterialDetail> {
  return call<MaterialDetail>(`/materials/detail?name=${encodeURIComponent(name)}`);
}

export function materialPresets(): Promise<{ presets: string[] }> {
  return call('/materials/presets');
}

const postJson = <T,>(path: string, body: unknown): Promise<T> =>
  call<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export function saveMaterial(body: {
  name: string; inherits: string; values: Record<string, string>; old_name?: string; create?: boolean;
}): Promise<{ saved: string }> {
  return postJson('/materials/save', body);
}

export function deleteMaterial(name: string): Promise<unknown> {
  return postJson('/materials/delete', { name });
}

export function importMaterial(preset: string): Promise<{
  saved: string; inherits: string; settings: number; skipped: string[];
}> {
  return postJson('/materials/import', { preset });
}

export function downloadCheck(
  modelId: number,
  fileId?: number,
): Promise<import('./types').DownloadCheck> {
  const q = fileId ? `&file_id=${fileId}` : '';
  return call(`/download-check?model_id=${modelId}${q}`);
}

export function getSettings(): Promise<Record<string, unknown>> {
  return call('/settings');
}

export function saveSettings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return call('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
