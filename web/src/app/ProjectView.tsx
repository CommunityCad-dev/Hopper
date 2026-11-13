import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

import {
  ApiError, cancelSlice, gcodeFileUrl, getMarkers, getPrinter, getProcess, getSlice, listProfiles, listMaterials, listModels, matchReport,
  moonrakerFileUrl, placeProject, projectFileUrl, saveMarkers, saveProjectThumbnail, sendSlice, startSlice, updateProject,
  uploadModel,
} from './api';
import { formatBytes } from './format';
import { ICONS, Icon } from './icons';
import { FolderPicker } from './FolderPicker';
import { renderPlateThumbs } from './gcodeThumbs';
import { PlateView } from './PlateView';
import type { Project3mf } from './plate3mf';
import { ProcessSettings, effective, processSummary } from './ProcessSettings';
import type { Bed } from './scene';
import { ConfirmSheet } from './ConfirmSheet';
import { SentFile } from './SentFile';
import { ToolpathView } from './ToolpathView';
import type {
  BuildVolume, LayerMarker, LayerMarkers, MatchReport, MaterialSummary, PrinterInfo, ProcessInfo, ProfilesList, ProjectEntry, SliceJob, SliceOptions,
  StoredModel,
} from './types';

interface Props {
  project: ProjectEntry;
  onBack: () => void;
  onChanged: (project: ProjectEntry) => void;
  /** The host's own G-code viewer for a sliced file, where it has one. */
  toolpathsUrl?: (gcode: string) => string | null;
  /** The bed, for the Printer section. */
  bed?: BuildVolume | null;
  /** The printer's default folder in G-code files, from Settings ("" is the top). */
  sendFolder?: string;
  /** Open the Share tab, where this project's prints can be shared. */
  onShare?: () => void;
}

type Source = { model: string; copies: number };
/** Settings that change the room a model needs on the plate. */
const FOOTPRINT = ['brim_type', 'brim_width', 'skirt_loops', 'skirt_distance', 'enable_support', 'support_type'];

/** Same choices: material, preset, and the same changes to it. */
function sameOptions(a: Partial<SliceOptions> | undefined, b: SliceOptions): boolean {
  const norm = (p: Record<string, string> | undefined) =>
    JSON.stringify(Object.entries(p ?? {}).sort(([x], [y]) => x.localeCompare(y)));
  return a?.material === b.material && a?.profile === b.profile && norm(a?.process) === norm(b.process);
}

/**
 * Drawn colour per material type when materials.cfg sets none. PLA keeps
 * Orca's own default filament colour; the rest differ so a glance tells them apart.
 */
const TYPE_COLOURS: Record<string, string> = {
  PLA: '#F2754E', PETG: '#2FA4D8', PET: '#2FA4D8', PCTG: '#2FA4D8', ABS: '#D8D8D8', ASA: '#A9AEB5',
  TPU: '#E8C547', PA: '#C9B98F', PC: '#B7D3E6',
};
export function materialColour(m: MaterialSummary | undefined): string {
  return m?.colour ?? TYPE_COLOURS[m?.type ?? ''] ?? '#F2754E';
}

/**
 * A project in the slicer, laid out like Orca's Prepare screen: the plate
 * in 3D, and beside it (below it on a phone) Printer, Filament, Process and Objects.
 * Plates behave as Orca's do -- what doesn't fit goes on another plate -- and each
 * plate becomes its own G-code file. The convenient slicer: precise placement and
 * every other setting stay in desktop Orca (Download opens this project there).
 */
export function ProjectView({ project, onBack, onChanged, toolpathsUrl, bed, sendFolder = 'communitycad', onShare }: Props) {
  const own = project.origin === 'models';
  const [opts, setOpts] = useState<SliceOptions>({
    material: project.options?.material ?? 'PLA',
    profile: project.options?.profile ?? '0.20mm Standard @Voron',
    process: { ...(project.options?.process ?? {}) },
  });
  const [processInfo, setProcessInfo] = useState<ProcessInfo | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfilesList | null>(null);
  // Profiles and each one's values: read again after Save as profile.
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const loadProfiles = () => {
    listProfiles()
      .then((list) => {
        setProfiles(list);
        // A project whose custom profile was deleted or renamed falls back to the default.
        setOpts((o) => {
          const known = list.defaults.some((d) => d.name === o.profile) || list.custom.some((c) => c.name === o.profile);
          if (known || !list.default_profile) return o;
          setProfileNote(`“${o.profile}” isn't in ${list.path.split('/').pop()} anymore, so this uses “${list.default_profile}”.`);
          return { ...o, profile: list.default_profile };
        });
      })
      .catch(() => undefined);
    getProcess()
      .then(setProcessInfo)
      .catch((err) => setProcessError(err instanceof ApiError ? err.message : "Couldn't read the presets."));
  };
  const [sources, setSources] = useState<Source[]>(project.sources ?? []);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [printer, setPrinter] = useState<PrinterInfo | null>(null);
  const [job, setJob] = useState<SliceJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState(project.name);
  const [tab, setTab] = useState<'prepare' | 'preview'>('prepare');
  const [plate, setPlate] = useState(0);
  const [plateBed, setPlateBed] = useState<Bed | null>(null);
  const [model3mf, setModel3mf] = useState<Project3mf | null>(null);
  /** The plate just sent with Print plate: its card shows the confirm. */
  const [confirmPlate, setConfirmPlate] = useState<number | null>(null);
  const [sending, setSending] = useState<'send' | 'print' | null>(null);
  /** Where Send and Print plate put it: the printer's default until changed here. */
  const [folder, setFolder] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  // Pauses and filament changes: what the project holds, what the last slice
  // had, and the layer the Preview shows.
  const [marks, setMarks] = useState<LayerMarkers | null>(null);
  const [slicedMarks, setSlicedMarks] = useState<string | null>(null);
  const [layerZ, setLayerZ] = useState<number | null>(null);
  const [markNote, setMarkNote] = useState<string | null>(null);
  const marksKey = (list: LayerMarker[]) => JSON.stringify(list.map((m) => [m.plate, m.z, m.kind]));
  useEffect(() => {
    getMarkers(project.filename).then((r) => {
      setMarks(r);
      setSlicedMarks((k) => k ?? marksKey(r.markers));
    }).catch(() => setMarks(null));
  }, [project.filename]);
  const marksChanged = !!marks && slicedMarks !== null && marksKey(marks.markers) !== slicedMarks;

  const original = JSON.stringify(project.sources ?? []);
  const [spacing, setSpacing] = useState(project.spacing != null ? String(project.spacing) : '');
  const spacingValue = spacing.trim() === '' || Number.isNaN(Number(spacing)) ? null
    : Math.min(100, Math.max(0, Number(spacing)));
  const spacingChanged = spacingValue !== (project.spacing ?? null);
  // The plate needs arranging again: different models or copies, or a new spacing.
  const plateChanged = JSON.stringify(sources) !== original || spacingChanged;
  const [last, setLast] = useState<{ filename: string; match: MatchReport }[]>([]);
  // Same plate and same choices as the last slice: print its files again, no slicing.
  const sameAsLast = !plateChanged && !!project.last_slice && !project.last_slice.stale &&
    sameOptions(project.options, opts);

  useEffect(() => {
    const files = project.last_slice?.gcodes ?? [];
    Promise.all(files.map((f) => matchReport(f).catch(() => null)))
      .then((reports) => setLast(reports.filter((r): r is { filename: string; match: MatchReport } => !!r)))
      .catch(() => setLast([]));
  }, [project.filename, project.last_slice?.at]);

  useEffect(() => {
    listMaterials().then((r) => setMaterials(r.materials)).catch(() => undefined);
    getPrinter().then((r) => setPrinter(r.printer)).catch(() => undefined);
    loadProfiles();
    getSlice()
      .then((current) => {
        if (current.model === project.filename && current.state !== 'idle') {
          setJob(current);
          if (current.state === 'slicing') poll();
        }
      })
      .catch(() => undefined);
    return stopPolling;
  }, [project.filename]);

  function stopPolling() {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  }

  function poll() {
    stopPolling();
    timer.current = window.setInterval(() => {
      getSlice()
        .then((next) => {
          setJob(next);
          if (next.state !== 'slicing') {
            stopPolling();
            // Orca moves to Preview when a slice finishes.
            if (next.state === 'done') setTab('preview');
          }
        })
        .catch(() => undefined);
    }, 1000);
  }

  const set = <K extends keyof SliceOptions>(key: K, value: SliceOptions[K]) =>
    setOpts((o) => ({ ...o, [key]: value }));

  // Re-arrange the plate and show it, without slicing.
  const arrange = async () => {
    setError(null);
    setBusy('Arranging the plate…');
    try {
      const { project: next } = await updateProject(project.filename, { models: sources, spacing: spacingValue, ...opts });
      onChanged(next);
      if (job?.state === 'done') setJob(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not arrange the plate.');
    } finally {
      setBusy(null);
    }
  };

  const toolpaths = (gcode: string) => {
    const href = toolpathsUrl?.(gcode);
    return href ? <a class="sub" href={href}>Open in Mainsail's G-code viewer</a> : null;
  };

  const slice = async () => {
    setError(null);
    // Pauses count as sliced once the new slice has started, never before: until
    // then the old slice's Send and Print must stay hidden.
    const markersNow = marks ? marksKey(marks.markers) : null;
    try {
      // Brim, skirt and supports change how much room each model needs. Without
      // moving models by hand, the plate is arranged again for them, or Orca refuses
      // a skirt that runs off the bed.
      const rearrange = plateChanged || (own && FOOTPRINT.some((k) =>
        effective(processInfo, project.options?.profile ?? opts.profile, project.options?.process ?? {}, k) !==
        effective(processInfo, opts.profile, opts.process, k)));
      if (rearrange || title.trim() !== project.name) {
        setBusy('Arranging the plate…');
        const { project: next } = await updateProject(project.filename, {
          ...(rearrange ? { models: sources, spacing: spacingValue } : {}),
          ...(title.trim() !== project.name ? { rename: title.trim() } : {}),
          ...opts,
        });
        onChanged(next);
        setBusy(null);
        setJob(await startSlice({ project: next.filename }, opts));
      } else {
        setJob(await startSlice({ project: project.filename }, opts));
      }
      if (markersNow !== null) setSlicedMarks(markersNow);
      poll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not slice.');
    } finally {
      setBusy(null);
    }
  };

  const slicing = job?.state === 'slicing';
  // A slice is shown only while it still matches the plate and the choices, as in
  // Orca: change either and Preview waits for the next slice.
  const jobCurrent = job?.state === 'done' && !plateChanged && sameOptions(job.options, opts);
  const plates = jobCurrent ? (job?.plates ?? []) : [];
  const sliced = plates.length > 0 || (job?.state !== 'done' && sameAsLast && last.length > 0);
  useEffect(() => {
    if (tab === 'preview' && !sliced) setTab('prepare');
  });
  const material = materials.find((m) => m.name === opts.material);
  // Preview: one sliced file per plate, in plate order.
  const sortedPlates = [...plates].sort((a, b) => a.plate - b.plate);
  // A plate waiting to be sent is read from where it waits; a sent one from G-code files.
  const previewUrls = sortedPlates.length
    ? sortedPlates.map((p) => (p.gcode ? gcodeFileUrl(p.gcode) : moonrakerFileUrl(p.staged ?? '')))
    : last.map((f) => gcodeFileUrl(f.filename));
  const previewIds = sortedPlates.length ? sortedPlates.map((p) => p.plate) : previewUrls.map((_, i) => i + 1);
  const previewIndex = Math.min(plate, Math.max(0, previewUrls.length - 1));
  const current = sortedPlates[previewIndex];

  // Orca's Send and Print plate: the plate goes to the G-code files, with its
  // thumbnails; Print plate then asks to start it, as one-tap Print does.
  const send = async (andPrint: boolean) => {
    if (!current || !job) return;
    setError(null);
    setSending(andPrint ? 'print' : 'send');
    try {
      const thumbs = model3mf ? renderPlateThumbs(model3mf, current.plate, materialColour(material)) : [];
      const r = await sendSlice(current.plate, thumbs, folder ?? undefined);
      setJob((j) => (j ? {
        ...j, printer_state: r.printer_state ?? j.printer_state,
        plates: (j.plates ?? []).map((p) => (p.plate === r.plate.plate ? r.plate : p)),
      } : j));
      setConfirmPlate(andPrint ? r.plate.plate : null);
      setTab('preview');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send it to the printer.');
    } finally {
      setSending(null);
    }
  };
  const plateLabel = sortedPlates.length > 1 && current ? ` plate ${String(current.plate).padStart(2, '0')}` : '';
  const previewBed: Bed = plateBed ?? { width: bed?.x ?? 350, depth: bed?.y ?? 350, height: bed?.z ?? 250 };

  const sliceButton = slicing ? (
    <>
      <button class="btn" type="button" disabled>Slicing… {Math.round(job?.elapsed_s ?? 0)} s</button>
      <button class="btn ghost" type="button" onClick={() => void cancelSlice().then(setJob)}>Cancel</button>
    </>
  ) : current && !marksChanged ? (
    // Sliced and still current: Orca's choice between sending and printing.
    <>
      <button class="btn ghost" type="button" disabled={!!busy || !!sending} onClick={() => void slice()}
        title="Slice again">{busy ?? 'Slice'}</button>
      <button class="btn ghost" type="button" disabled={!!sending || !!current.gcode}
        title="Put it in the printer's G-code files without starting it" onClick={() => void send(false)}>
        {sending === 'send' ? 'Sending…' : current.gcode ? 'Sent' : `Send${plateLabel}`}
      </button>
      <button class="btn" type="button" disabled={!!sending}
        title="Send it, then confirm to start" onClick={() => void send(true)}>
        {sending === 'print' ? 'Sending…' : `Print${plateLabel || ' plate'}`}
      </button>
    </>
  ) : (
    <button class="btn" type="button" disabled={!!busy} onClick={() => void slice()}>
      {busy ?? (current && marksChanged ? 'Slice again' : 'Slice plate')}
    </button>
  );

  return (
    <div class="slicer">
      <div class="slicer-head">
        <button class="icon-btn sm" type="button" aria-label="Back to projects" onClick={onBack}>←</button>
        <input class="title-input" value={title} aria-label="Project name"
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        <div class="seg" role="tablist" aria-label="Slicer">
          <button type="button" role="tab" aria-selected={tab === 'prepare'} onClick={() => setTab('prepare')}>
            Prepare
          </button>
          <button type="button" role="tab" aria-selected={tab === 'preview'} disabled={!sliced}
            title={sliced ? undefined : 'Slice first'} onClick={() => setTab('preview')}>
            Preview
          </button>
        </div>
        <a class="icon-btn sm" href={projectFileUrl(project.filename)} download={project.filename}
          title="Download, to open in OrcaSlicer" aria-label="Download this project">
          <Icon path={ICONS.download} size={18} />
        </a>
        <div class="slicer-go">{sliceButton}</div>
      </div>

      <div class="slicer-body">
        <div class="slicer-stage">
          {/* Kept mounted while Preview shows, so going back doesn't read the project again. */}
          <div style={tab === 'prepare' ? undefined : 'display:none'}>
            <PlateView
              url={projectFileUrl(project.filename)} version={project.updated}
              colour={materialColour(material)}
              plate={plate} onPlate={(i) => setPlate(i)} onBed={setPlateBed} onProject={setModel3mf}
              onArrange={own ? () => void arrange() : undefined}
              arrangeNeeded={plateChanged} arranging={busy === 'Arranging the plate…'}
              onPlace={async (changes) => {
                try {
                  const { project: next } = await placeProject(project.filename, changes);
                  onChanged(next);
                  if (job?.state === 'done') setJob(null);
                } catch (err) {
                  throw new Error(err instanceof ApiError ? err.message : 'Could not place the model.');
                }
              }}
              onThumbnail={!project.thumbnail || project.thumbnail.stale
                ? (png) => void saveProjectThumbnail(project.filename, png).catch(() => undefined)
                : undefined}
              placeBlocked={slicing ? 'Slicing: placing waits until it is done.'
                : plateChanged ? 'The models on the plate changed: Arrange first, then place them.' : null}
            />
          </div>
          {tab === 'preview' && previewUrls.length > 0 && (
            <ToolpathView files={previewUrls} bed={previewBed}
              plate={previewIndex} onPlate={setPlate} plateIds={previewIds} onLayer={setLayerZ}
              marks={(marks?.markers ?? []).filter((m) => m.plate === (previewIds[previewIndex] ?? 1))} />
          )}
          {tab === 'preview' && previewUrls.length > 0 && marks && (
            <LayerMarkersBar marks={marks} plate={previewIds[previewIndex] ?? 1} z={layerZ} changed={marksChanged}
              note={markNote}
              onChange={async (next) => {
                setMarkNote(null);
                try {
                  setMarks(await saveMarkers(project.filename, next));
                } catch (err) {
                  setMarkNote(err instanceof ApiError ? err.message : 'Could not save that.');
                }
              }} />
          )}
          {error && <div class="msg warn"><p>{error}</p></div>}
          {job?.state === 'failed' && <div class="msg warn"><p>{job.error}</p></div>}
          {job?.state === 'cancelled' && <p class="sub">Cancelled. Nothing was saved.</p>}
          {tab === 'preview' && (
            <div class="preview-summary">
              {plates.length > 0 ? (
                <>
                  {job?.printer && <p class="sub">Sliced for {job.printer} in {job.seconds} s.</p>}
                  {sortedPlates.some((p) => !p.gcode) && (
                    <div class="send-to">
                      <span class="sub">Send to</span>
                      <FolderPicker value={folder ?? sendFolder} disabled={!!sending}
                        label="Where Send and Print plate put it" onChange={setFolder} />
                    </div>
                  )}
                  {(job?.assumed ?? []).map((a) => <p key={a} class="sub">Assumed {a}.</p>)}
                  {job?.capped && <p class="sub">{job.capped}.</p>}
                  {sortedPlates.map((p) => (
                    <div key={p.plate} class={`plate-result${p.plate === current?.plate ? ' current' : ''}`}>
                      <ul class="facts">
                        {plates.length > 1 && <li><span>Plate</span><span>{String(p.plate).padStart(2, '0')}</span></li>}
                        <li><span>Print time</span><span>{p.summary?.print_time ?? 'unknown'}</span></li>
                        <li><span>Filament</span><span>{p.summary?.filament_g ? `${p.summary.filament_g} g` : 'unknown'}</span></li>
                        <li><span>Layers</span><span>{p.summary?.layers ?? 'unknown'}</span></li>
                      </ul>
                      {p.gcode && p.match ? (
                        <>
                          <SentFile key={p.gcode} filename={p.gcode} match={p.match} printerState={job?.printer_state} />
                          {toolpaths(p.gcode)}
                        </>
                      ) : (
                        <p class="sub">Not on the printer yet: <strong>Send</strong> puts it in G-code files,{' '}
                          <strong>Print</strong> sends it and asks to start.</p>
                      )}
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <p class="sub">Sliced {new Date((project.last_slice?.at ?? 0) * 1000).toLocaleString()}, with these settings.</p>
                  {last.map((f) => (
                    <div key={f.filename} class="plate-result">
                      <SentFile filename={f.filename} match={f.match} />
                      {toolpaths(f.filename)}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <div class="slicer-side">
          <Section title="Printer">
            <div class="side-row">
              <span class="name">{printer?.identity.name ?? 'This printer'}</span>
              <span class="sub">
                {printer?.nozzle_diameter ? `${printer.nozzle_diameter} mm nozzle` : ''}
                {bed ? `${printer?.nozzle_diameter ? ' · ' : ''}${bed.x} × ${bed.y} × ${bed.z}` : ''}
              </span>
            </div>
            {!printer && <p class="sub">Read from printer.cfg once you allow it in Settings.</p>}
          </Section>

          <Section title="Filament">
            <label class="filament">
              <span class="swatch" style={`background:${materialColour(material)}`} />
              <select value={opts.material} disabled={slicing || !!busy} aria-label="Filament"
                onChange={(e) => set('material', (e.target as HTMLSelectElement).value)}>
                {materials.length === 0 && <option value={opts.material}>{opts.material}</option>}
                {materials.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            </label>
            <p class="sub">From materials.cfg. Edit them in Settings → Materials.</p>
          </Section>

          {own ? (
            <Section title="Process" note={processSummary(processInfo, opts.profile, opts.process)}>
              <ProcessSettings
                info={processInfo} error={processError}
                profile={opts.profile} profiles={profiles} process={opts.process} disabled={slicing || !!busy}
                onProfile={(name) => set('profile', name)} onProcess={(p) => set('process', p)}
                onProfilesChanged={loadProfiles}
              />
              {profileNote && <p class="sub" style="color:#f6ad55">{profileNote}</p>}
            </Section>
          ) : (
            <Section title="Process">
              <p class="sub">
                {project.origin === 'catalog' ? 'From the catalog' : 'Uploaded'}: this project keeps its own
                settings, plates and layout, sliced for this printer. Only the filament applies.
              </p>
            </Section>
          )}

          {own && (
            <Section title="Objects" note={`${sources.reduce((n, s) => n + s.copies, 0)} on the plate`}>
              {sources.map((src, i) => (
                <div key={src.model} class="plate-row">
                  <Icon path={ICONS.cube} size={16} />
                  <span class="name">{src.model}</span>
                  <span class="stepper">
                    <button class="icon-btn sm" type="button" aria-label="One fewer" disabled={slicing}
                      onClick={() => setSources((list) => (src.copies > 1
                        ? list.map((s, j) => (j === i ? { ...s, copies: s.copies - 1 } : s))
                        : list.length > 1 ? list.filter((_, j) => j !== i) : list))}>−</button>
                    <span>{src.copies}×</span>
                    <button class="icon-btn sm" type="button" aria-label="One more" disabled={slicing || src.copies >= 50}
                      onClick={() => setSources((list) => list.map((s, j) => (j === i ? { ...s, copies: s.copies + 1 } : s)))}>+</button>
                  </span>
                </div>
              ))}
              <button class="btn ghost sm" type="button" disabled={slicing} onClick={() => setPicking(true)}>
                Add models
              </button>
              <label class="spacing-row">
                <span>Arrange spacing</span>
                <span class="num">
                  <input type="number" inputMode="decimal" min={0} max={100} step={1} placeholder="Orca"
                    value={spacing} disabled={slicing || !!busy} aria-label="Arrange spacing in mm"
                    onInput={(e) => setSpacing((e.target as HTMLInputElement).value)}
                    onChange={(e) => {
                      const raw = (e.target as HTMLInputElement).value.trim();
                      const n = Number(raw);
                      setSpacing(raw === '' || Number.isNaN(n) ? '' : String(Math.min(100, Math.max(0, n))));
                    }} />
                  <span class="unit">mm</span>
                </span>
              </label>
              <p class="sub">Gap between models when the plate is arranged. Empty: Orca's own.</p>
              {plateChanged && <p class="sub">Tap Arrange on the plate to see the new layout. Slicing also does this.</p>}
              {picking && (
                <ModelPicker
                  exclude={sources.map((s) => s.model)}
                  onPick={(names) => {
                    setSources((list) => [...list, ...names.map((model) => ({ model, copies: 1 }))]);
                    setPicking(false);
                  }}
                  onClose={() => setPicking(false)}
                />
              )}
            </Section>
          )}

          {(project.prints ?? []).length > 0 && (
            <Section title="Prints">
              <ul class="facts">
                {[...(project.prints ?? [])].reverse().slice(0, 5).map((pr) => (
                  <li key={`${pr.gcode}${pr.at}`}>
                    <span>{new Date(pr.at * 1000).toLocaleDateString()}</span>
                    <span>{pr.status}{pr.duration ? `, ${Math.round(pr.duration / 60)} min` : ''}</span>
                  </li>
                ))}
              </ul>
              {onShare && (
                <button class="btn ghost sm" type="button" onClick={onShare}>
                  Share a print: profile or post
                </button>
              )}
            </Section>
          )}
          <p class="sub">Printer, bed and limits come from this printer. For anything more, download the project and open it in OrcaSlicer.</p>
        </div>
      </div>

      <div class="slicer-bar">{sliceButton}</div>
      {(() => {
        // Print plate: the confirm opens over the slicer, where the user is looking.
        const p = sortedPlates.find((x) => x.plate === confirmPlate && x.gcode && x.match);
        return p ? (
          <ConfirmSheet onClose={() => setConfirmPlate(null)}>
            <SentFile key={`confirm-${p.gcode}`} filename={p.gcode!} match={p.match!} printerState={job?.printer_state}
              confirm onDecline={() => setConfirmPlate(null)} onDone={() => setConfirmPlate(null)} title={title}
              materials={materials.map((m) => m.name)}
              onChangeMaterial={(m) => { setConfirmPlate(null); set('material', m); }} />
          </ConfirmSheet>
        ) : null;
      })()}
    </div>
  );
}

/** One sidebar section, folding like Orca's simple mode. */
function Section({ title, note, children }: { title: string; note?: string; children: ComponentChildren }) {
  return (
    <details class="sec" open>
      <summary>
        <span>{title}</span>
        {note && <span class="sub">{note}</span>}
      </summary>
      <div class="sec-body">{children}</div>
    </details>
  );
}

/** Pick models from Models on this printer, or upload new ones on the spot. */
function ModelPicker({ exclude, onPick, onClose }: {
  exclude: string[]; onPick: (names: string[]) => void; onClose: () => void;
}) {
  const [models, setModels] = useState<StoredModel[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = () => listModels().then((r) => setModels(r.models.filter((m) => m.usable))).catch(() => undefined);
  useEffect(() => void load(), []);

  const upload = async (ev: Event) => {
    const el = ev.target as HTMLInputElement;
    const files = [...(el.files ?? [])];
    el.value = '';
    try {
      for (const f of files) {
        setUploading(f.name);
        await uploadModel(f, () => undefined);
        setChosen((c) => new Set([...c, f.name]));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The upload did not finish.');
    } finally {
      setUploading(null);
      void load();
    }
  };

  const offered = models.filter((m) => !exclude.includes(m.filename));
  return (
    <div class="picker">
      <div class="picker-head">
        <strong>Add models</strong>
        <button class="btn ghost sm" type="button" disabled={!!uploading} onClick={() => input.current?.click()}>
          {uploading ? `Uploading ${uploading}…` : 'Upload from device'}
        </button>
        <input ref={input} type="file" accept=".stl,.obj,.3mf,.step,.stp" multiple hidden onChange={upload} />
      </div>
      {error && <p class="sub" style="color:#f6ad55">{error}</p>}
      {offered.length === 0 && <p class="sub">No other models on this printer. Upload one, or save one from Browse.</p>}
      {offered.map((m) => (
        <label key={m.filename} class="picker-row">
          <input type="checkbox" checked={chosen.has(m.filename)}
            onChange={() => setChosen((c) => {
              const next = new Set(c);
              if (next.has(m.filename)) next.delete(m.filename);
              else next.add(m.filename);
              return next;
            })} />
          <span class="name">{m.filename}</span>
          <span class="sub">{formatBytes(m.bytes)}</span>
        </label>
      ))}
      <div class="foot">
        <button class="btn sm" type="button" disabled={chosen.size === 0} onClick={() => onPick([...chosen])}>
          Add {chosen.size || ''}
        </button>
        <button class="btn ghost sm" type="button" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Pause here / Change filament here, as on Orca's layer slider: at the layer
 * the Preview shows, before it prints. Kept in the project's 3MF, so desktop Orca
 * shows them too; the printer runs its own PAUSE, or M600 for a filament change
 * where printer.cfg has one.
 */
function LayerMarkersBar({ marks, plate, z, changed, note, onChange }: {
  marks: LayerMarkers; plate: number; z: number | null; changed: boolean; note: string | null;
  onChange: (next: LayerMarker[]) => void;
}) {
  const here = marks.markers.filter((m) => m.plate === plate);
  const at = z == null ? undefined : here.find((m) => Math.abs(m.z - z) < 0.001);
  const add = (kind: LayerMarker['kind']) => z != null && onChange([
    ...marks.markers.filter((m) => !(m.plate === plate && Math.abs(m.z - z) < 0.001)), { plate, z, kind }]);
  const remove = (m: LayerMarker) => onChange(marks.markers.filter((x) => x !== m));
  const { macros } = marks;
  return (
    <div class="markers">
      {!macros.known ? (
        <p class="sub">To pause or change filament at a layer, allow reading this printer's settings in Settings,
          so the plugin can check printer.cfg has a PAUSE macro.</p>
      ) : !macros.pause && !macros.filament ? (
        <p class="sub">printer.cfg has no PAUSE or M600 macro, so the printer can't stop at a layer.
          Mainsail's mainsail.cfg adds PAUSE.</p>
      ) : z != null && (
        <div class="marker-bar">
          <span class="sub">Before {z.toFixed(2)} mm:</span>
          {at ? (
            <button class="btn ghost sm" type="button" onClick={() => remove(at)}>
              Remove {at.kind === 'pause' ? 'pause' : 'filament change'}
            </button>
          ) : (
            <>
              {macros.pause && (
                <button class="btn ghost sm" type="button" onClick={() => add('pause')}>Pause here</button>
              )}
              <button class="btn ghost sm" type="button" onClick={() => add('filament')}
                title={`Runs ${macros.filament} before this layer`}>Change filament here</button>
            </>
          )}
        </div>
      )}
      {here.length > 0 && (
        <ul class="marker-list">
          {here.map((m) => (
            <li key={`${m.kind}${m.z}`}>
              <span class={`dot ${m.kind}`} />
              <span>{m.kind === 'pause' ? 'Pause' : 'Filament change'} before {m.z.toFixed(2)} mm
                <span class="sub"> ({m.gcode ?? (m.kind === 'pause' ? 'PAUSE' : macros.filament)})</span></span>
              <button class="icon-btn sm" type="button" aria-label="Remove" onClick={() => remove(m)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {changed && <p class="sub" style="color:#f6ad55">Slice again to include these before sending.</p>}
      {note && <p class="sub" style="color:#f6ad55">{note}</p>}
    </div>
  );
}
