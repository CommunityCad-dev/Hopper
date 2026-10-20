import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { SkeletonRows } from './Skeleton';
import { ApiError, currentApiBase, deleteProject, listProjects, projectFileUrl, uploadProject } from './api';
import { formatBytes } from './format';
import { ICONS, Icon } from './icons';
import type { ProjectEntry, ProjectsList } from './types';

interface Props {
  onOpen: (project: ProjectEntry) => void;
  onModels: () => void;
}

const ORIGIN: Record<ProjectEntry['origin'], string> = {
  models: 'Made here', catalog: 'From the catalog', upload: 'Uploaded',
};

/** "Today 10:31", "Yesterday", or a date, as Orca's recent list reads. */
function when(seconds: number): string {
  const d = new Date(seconds * 1000);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return d.toLocaleDateString();
}

/**
 * Projects, laid out like OrcaSlicer's home page: New project and Open
 * project, then the projects as cards with a picture of their first plate, newest
 * first. The picture is drawn the first time a project is opened, since Orca's CLI
 * can't render one.
 */
export function Projects({ onOpen, onModels }: Props) {
  const [data, setData] = useState<ProjectsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError(null);
    listProjects()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read the projects.'));
  }, []);
  useEffect(load, [load]);

  const upload = async (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    try {
      for (const f of files) {
        setUploading(f.name);
        await uploadProject(f, () => undefined);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The upload did not finish.');
    } finally {
      setUploading(null);
      load();
    }
  };

  const remove = async (name: string) => {
    try {
      await deleteProject(name);
      setConfirming(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that project.');
    }
  };

  const needle = query.trim().toLowerCase();
  const projects = [...(data?.projects ?? [])]
    .filter((p) => !needle || p.name.toLowerCase().includes(needle))
    .sort((a, b) => b.updated - a.updated);
  const models = (p: ProjectEntry) => (p.sources ? p.sources.reduce((n, s) => n + s.copies, 0) : null);

  return (
    <div class="panel projects-home">
      <div class="panel-head"><Icon path={ICONS.cube} /><span>Projects</span></div>
      <div class="home-actions">
        <button type="button" class="home-action" onClick={onModels}>
          <span class="home-icon">+</span>
          <span><strong>New project</strong><span class="sub">Pick models in Models, then Slice</span></span>
        </button>
        <button type="button" class="home-action" disabled={!!uploading} onClick={() => picker.current?.click()}>
          <span class="home-icon"><Icon path={ICONS.upload} size={20} /></span>
          <span><strong>{uploading ? `Opening ${uploading}…` : 'Open project'}</strong>
            <span class="sub">An OrcaSlicer .3mf from this device</span></span>
        </button>
        <input ref={picker} type="file" accept=".3mf" multiple hidden onChange={upload} />
      </div>

      <div class="home-head">
        <h3>Recent projects</h3>
        {(data?.projects.length ?? 0) > 4 && (
          <label class="panel-search home-search">
            <input type="search" placeholder="Search" value={query} aria-label="Search projects"
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
            <Icon path={ICONS.magnify} />
          </label>
        )}
        <button class="icon-btn" type="button" title="Refresh" aria-label="Refresh" onClick={load}>
          <Icon path={ICONS.refresh} />
        </button>
      </div>
      {error && <div class="msg warn" style="margin:8px 16px"><p>{error}</p></div>}
      {!data && !error && <SkeletonRows />}

      <div class="project-grid">
        {projects.map((p) => (
          <div key={p.id} class="project-card">
            <button type="button" class="project-open" aria-label={`Open ${p.name}`} onClick={() => onOpen(p)}>
              <span class="project-thumb">
                {p.thumbnail ? (
                  <img src={`${currentApiBase()}${p.thumbnail.url}`} alt="" decoding="async" />
                ) : (
                  <Icon path={ICONS.cube} size={44} />
                )}
              </span>
              <span class="project-name">{p.name}</span>
              <span class="sub">{when(p.updated)}</span>
              <span class="sub project-meta">
                {[ORIGIN[p.origin], models(p) != null ? `${models(p)} ${models(p) === 1 ? 'model' : 'models'}` : '',
                  p.options?.material ?? '', formatBytes(p.bytes)].filter(Boolean).join(' · ')}
              </span>
            </button>
            <div class="project-actions">
              {confirming === p.id ? (
                <>
                  <button class="btn sm" type="button" onClick={() => void remove(p.filename)}>Delete</button>
                  <button class="btn ghost sm" type="button" onClick={() => setConfirming(null)}>Keep</button>
                </>
              ) : (
                <>
                  <a class="icon-btn sm" href={projectFileUrl(p.filename)} download={p.filename}
                    title="Download, to open in OrcaSlicer" aria-label={`Download ${p.name}`}>
                    <Icon path={ICONS.download} size={18} />
                  </a>
                  <button class="icon-btn sm" type="button" title="Delete" aria-label={`Delete ${p.name}`}
                    onClick={() => setConfirming(p.id)}>
                    <Icon path={ICONS.delete} size={18} />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {data && projects.length === 0 && (
        <div class="panel-empty">
          {data.projects.length === 0 ? (
            <>
              <p>No projects yet.</p>
              <p class="sub">Slice a model in Models and it becomes a project here. Or open one from OrcaSlicer.</p>
            </>
          ) : (
            <p>Nothing matches "{query}".</p>
          )}
        </div>
      )}
    </div>
  );
}
