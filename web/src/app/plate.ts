import { ApiError, createProject, getModel, listProjects, saveModel, updateProject } from './api';
import type { ModelFile, ProjectEntry } from './types';

/**
 * The plate you're building from Browse: a real project on the printer, made
 * by the first + on a card and added to by the next ones. Which project, and which
 * CommunityCAD models are on it, is remembered in this browser only.
 */
const KEY = 'ccad-plate';

export interface PlateState { filename: string; modelIds: number[] }

export function loadPlate(): PlateState | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PlateState | null;
    return v && typeof v.filename === 'string' && Array.isArray(v.modelIds) ? v : null;
  } catch { return null; }
}

export function savePlate(p: PlateState | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p)); else localStorage.removeItem(KEY);
  } catch { /* private mode: the plate lasts for this page only */ }
}

/** The project behind the remembered plate, or null if it was deleted or renamed. */
export async function plateProject(p: PlateState | null): Promise<ProjectEntry | null> {
  if (!p) return null;
  const list = await listProjects();
  return list.projects.find((x) => x.filename === p.filename) ?? null;
}

const SLICEABLE = /\.(stl|obj|3mf|step|stp)$/i;
const SENDABLE = /\.(gcode|gco|g|gcode\.3mf)$/i;

/** A model's files that can go on a plate: printable model files, not G-code. */
export async function sliceableFiles(modelId: number): Promise<{ title: string; files: ModelFile[] }> {
  const m = await getModel(modelId);
  return { title: m.title, files: (m.files ?? []).filter((f) => f.printable && SLICEABLE.test(f.path) && !SENDABLE.test(f.path)) };
}

/**
 * Save the chosen files to the printer and put them on the plate: a new project the
 * first time, the same one after. Returns the project and the plate state.
 */
export async function addToPlate(modelId: number, fileIds: number[], current: PlateState | null):
  Promise<{ project: ProjectEntry; plate: PlateState; skipped: string[] }> {
  const names: string[] = [];
  const skipped: string[] = [];
  for (const fileId of fileIds) {
    const saved = await saveModel(modelId, fileId);
    if (saved.model) names.push(saved.model.filename);
    else if (saved.project) skipped.push(saved.project.name);   // a 3MF project of its own
  }
  if (names.length === 0) throw new Error(skipped.length
    ? `${skipped[0]} is a project of its own. Open it from Projects.` : 'Nothing was saved.');
  const existing = await plateProject(current);
  const added = names.map((model) => ({ model, copies: 1 }));
  let project: ProjectEntry;
  try {
    ({ project } = existing
      ? await updateProject(existing.filename, { models: [...(existing.sources ?? []), ...added] })
      : await createProject(added));
  } catch (err) {
    // Saved, but the plate can't be made during a print: say the save worked, and
    // that + again is instant afterwards.
    if (err instanceof ApiError && err.status === 409 && /printing/i.test(err.message)) {
      throw new Error(`Saved to the printer. It goes on the plate after the print: press + again then.`);
    }
    throw err;
  }
  const plate = {
    filename: project.filename,
    modelIds: [...new Set([...(existing ? current?.modelIds ?? [] : []), modelId])],
  };
  savePlate(plate);
  return { project, plate, skipped };
}
