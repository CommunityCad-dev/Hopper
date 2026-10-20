import { useEffect, useRef, useState } from 'preact/hooks';

import {
  ApiError, createProject, currentApiBase, downloadCheck, downloadUrl, getModel, listProjects, saveModel, sendToPrinter,
  updateProject,
} from './api';
import { ConfirmSheet } from './ConfirmSheet';
import { QuickPrint } from './QuickPrint';
import { TransferBar } from './TransferBar';
import { rememberViewed } from './Recent';
import { renderMarkdown } from './markdown';
import { SentFile } from './SentFile';
import {
  mdiCheck, mdiContentSaveOutline, mdiFolderPlusOutline, mdiLayersTripleOutline, mdiOpenInNew, mdiPrinter3dNozzleOutline,
  mdiTrayArrowDown,
} from '@mdi/js';
import { ICONS, Icon } from './icons';
import { describeDownloadCost, fits, formatBytes, formatSize } from './format';
import type {
  BuildVolume, DownloadCheck, MatchReport, ModelDetail as Detail, ModelFile, ProjectEntry,
} from './types';

/** iPhone and iPad, including iPadOS reporting itself as a Mac. */
const IOS =
  /iP(hone|od|ad)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Download through a hidden frame. The bucket sends no Content-Disposition, so a
 * type the browser can't show (STL, 3MF, G-code) downloads, and one it can show
 * loads invisibly instead of navigating the page away from Mainsail.
 */
function startDownload(url: string, host: HTMLElement | null) {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.src = url;
  (host ?? document.body).appendChild(frame);
  window.setTimeout(() => frame.remove(), 60_000);
}

/** Model files the printer can keep for slicing; the rest of "printable"
 * (Prusa's binary .bgcode) can only be downloaded. */
const SLICEABLE = /\.(stl|obj|3mf|step|stp)$/i;
const BGCODE = /\.bgcode$/i;

/** What can go to the printer: G-code, or a sliced 3MF whose plates the Pi extracts.
 * Anything else is a model, not a print job. */
const SENDABLE = /\.(gcode|gco|g|gcode\.3mf)$/i;

interface Props {
  id: number;
  volume: BuildVolume | null;
  linked: boolean;
  onBack: () => void;
  onConnect: () => void;
  /** Opens Models on the printer, where saved model files wait for slicing. */
  onModels: () => void;
  /** Opens a project in the slicer. */
  onOpenProject: (project: ProjectEntry) => void;
}

export function ModelDetailView({ id, volume, linked, onBack, onConnect, onModels, onOpenProject }: Props) {
  const [model, setModel] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [sent, setSent] = useState<Record<number, { filename: string; match: MatchReport }[]>>({});
  // One-tap Print: which file's save should come up as the confirm.
  const [printing, setPrinting] = useState<number | null>(null);
  const [printerState, setPrinterState] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);
  // Links the browser refused to open in a new tab (pop-up blocking); shown inline.
  const [links, setLinks] = useState<Record<number, string>>({});
  const [started, setStarted] = useState<number | null>(null);
  const [kept, setKept] = useState<Record<number, true>>({});
  const [opening, setOpening] = useState<number | null>(null);
  // Quick print: which file's panel is open.
  const [quick, setQuick] = useState<number | null>(null);
  // Hidden frames that carry downloads live here, inside our own view.
  const frames = useRef<HTMLDivElement>(null);
  const [cost, setCost] = useState<DownloadCheck | null>(null);

  // Ask what sending would cost as soon as the page opens, so the answer is on the
  // button before anyone taps it rather than after.
  useEffect(() => {
    if (!linked) {
      setCost(null);
      return;
    }
    let cancelled = false;
    downloadCheck(id)
      .then((c) => !cancelled && setCost(c))
      .catch(() => !cancelled && setCost(null));
    return () => {
      cancelled = true;
    };
  }, [id, linked]);

  const send = async (fileId: number, thenPrint = false) => {
    // Sending needs an account, so route an unlinked printer to Connect and
    // let them come back rather than failing at the API.
    if (!linked) {
      onConnect();
      return;
    }
    setSending(fileId);
    setSendError(null);
    try {
      const result = await sendToPrinter(id, fileId);
      const files = result.files?.length
        ? result.files
        : [{ filename: result.filename, match: result.match }];
      setSent((prev) => ({ ...prev, [fileId]: files }));
      setPrinterState(result.printer_state ?? null);
      setPrinting(thenPrint ? fileId : null);
      // The allowance has moved; show what the next send would cost.
      downloadCheck(id).then(setCost).catch(() => undefined);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not send that file.');
    } finally {
      setSending(null);
    }
  };

  // A model file goes to Models on the printer: the printer can't run it
  // until it's sliced, so it never goes into the G-code files.
  const keep = async (fileId: number) => {
    if (!linked) {
      onConnect();
      return;
    }
    setSending(fileId);
    setSendError(null);
    try {
      await saveModel(id, fileId);
      setKept((prev) => ({ ...prev, [fileId]: true }));
      downloadCheck(id).then(setCost).catch(() => undefined);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not save that file to the printer.');
    } finally {
      setSending(null);
    }
  };

  // "Open in slicer" and "Add to project": save the file to Models, then
  // put it in a new or an existing project and open it. One step instead of two.
  // The rest of a file's actions sit behind its "⋯" menu.
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [menuView, setMenuView] = useState<'main' | 'projects'>('main');
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const openMenu = (fileId: number) => {
    setMenuFor(fileId);
    setMenuView('main');
    setQuery('');
  };
  const closeMenu = () => setMenuFor(null);
  const showProjects = () => {
    if (!linked) {
      closeMenu();
      onConnect();
      return;
    }
    setMenuView('projects');
    setProjects(null);
    listProjects()
      .then((r) => setProjects(r.projects.filter((p) => p.origin === 'models').sort((a, b) => b.updated - a.updated)))
      .catch(() => setProjects([]));
  };
  const addToProject = async (fileId: number, target: ProjectEntry | null) => {
    if (!linked) {
      onConnect();
      return;
    }
    closeMenu();
    setOpening(fileId);
    setSending(fileId);
    setSendError(null);
    try {
      const saved = await saveModel(id, fileId);
      if (saved.project) {
        // It was a project itself (a 3MF with its own settings): open that.
        onOpenProject(saved.project);
        return;
      }
      const model = saved.model!.filename;
      const result = target
        ? await updateProject(target.filename, {
          models: [...(target.sources ?? []), { model, copies: 1 }],
        })
        : await createProject([{ model, copies: 1 }]);
      onOpenProject(result.project);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not add it to a project.');
    } finally {
      setSending(null);
      setOpening(null);
    }
  };

  const download = async (fileId: number) => {
    if (!linked) {
      onConnect();
      return;
    }
    // iOS Safari won't download from a hidden frame, so there the tab opens now,
    // inside the tap (a window opened after a network wait is blocked) and is
    // pointed at the link once the Pi has it. Everywhere else a hidden frame
    // downloads without leaving a blank tab behind.
    const tab = IOS ? window.open('', '_blank') : null;
    if (tab) tab.opener = null;
    setDownloading(fileId);
    setSendError(null);
    try {
      const link = await downloadUrl(id, fileId);
      if (!IOS) {
        startDownload(link.url, frames.current);
        setStarted(fileId);
        window.setTimeout(() => setStarted((f) => (f === fileId ? null : f)), 4000);
      } else if (tab && !tab.closed) {
        tab.location.href = link.url;
      } else {
        setLinks((prev) => ({ ...prev, [fileId]: link.url }));
      }
      downloadCheck(id).then(setCost).catch(() => undefined);
    } catch (err) {
      tab?.close();
      setSendError(err instanceof ApiError ? err.message : 'Could not download that file.');
    } finally {
      setDownloading(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setModel(null);
    setError(null);
    getModel(id)
      .then((result) => {
        if (cancelled) return;
        setModel(result);
        rememberViewed(result);
      })
      .catch((err) =>
        !cancelled &&
        setError(err instanceof ApiError ? err.message : 'Could not load this model.'),
      );
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <>
        <div class="head">
          <button class="btn ghost" type="button" onClick={onBack}>← Back</button>
        </div>
        <div class="msg warn"><p>{error}</p></div>
      </>
    );
  }

  if (!model) {
    return (
      <>
        <div class="head">
          <button class="btn ghost" type="button" onClick={onBack}>← Back</button>
        </div>
        <div class="skeleton" style="aspect-ratio:16/9" />
      </>
    );
  }

  const size = formatSize(model.bbox);
  const fitsPrinter = fits(model.bbox, volume);
  // Printable files first: they are what someone browsing from a printer wants.
  // Printable files first, G-code first among them: on a phone, the files someone
  // came for must not sit below a licence, a readme and a dozen photos. The field
  // is `printable`; an earlier `is_printable` never existed, so this sort did nothing.
  const rank = (f: ModelFile) =>
    SENDABLE.test(f.path) ? 0 : f.printable ? 1 : 2;
  const files = [...(model.files ?? [])].sort((a, b) => rank(a) - rank(b));

  return (
    <>
      <div class="head">
        <button class="btn ghost" type="button" onClick={onBack}>← Back</button>
      </div>

      <div class="detail">
        <div>
          <Gallery images={galleryOf(model)} />
        </div>

        <div>
          <h3>{model.title}</h3>
          <div class="meta sub">
            {model.creator.display_name || model.creator.username}
            {model.original_author && <> · originally by {model.original_author}</>}
            {model.source_url && /^https?:\/\//.test(model.source_url) && (
              <> · <a href={model.source_url} target="_blank" rel="noreferrer noopener">Source</a></>
            )}
          </div>
          {model.description && <p class="model-desc">{model.description}</p>}
          {(model.tags?.length ?? 0) > 0 && (
            <div class="tag-row">{model.tags!.slice(0, 12).map((t) => <span key={t} class="tag-chip">{t}</span>)}</div>
          )}

          <div class="foot" style="margin-top:10px">
            {fitsPrinter === true && <span class="badge fit">Fits your printer</span>}
            {fitsPrinter === false && <span class="badge nofit">Too big for your printer</span>}
            {!model.has_printable && <span class="badge cad">CAD only</span>}
          </div>

          <ul class="facts">
            <li><span>Size</span><span>{size ?? 'unknown'}</span></li>
            <li><span>Licence</span><span>{model.license_name ?? 'not stated'}</span></li>
            <li>
              <span>Printable</span>
              <span>
                {model.has_printable
                  ? model.printable_types.join(', ').toUpperCase()
                  : 'no printable file — CAD source only'}
              </span>
            </li>
            <li><span>Downloads</span><span>{model.download_count}</span></li>
            {model.print_count > 0 && (
              <li><span>Printed</span><span>{model.print_count} times</span></li>
            )}
            <li><span>Total size</span><span>{formatBytes(model.total_size_bytes) ?? 'unknown'}</span></li>
          </ul>

          {files.length > 0 && (
            <>
              <div class="sub" style="margin-top:14px">Files ({files.length})</div>
              {sendError && <p class="sub" style="color:#f6ad55">{sendError}</p>}
              {describeDownloadCost(cost) && (
                <p class="sub">
                  {describeDownloadCost(cost)}
                  {cost?.allowed === false && (
                    <>
                      {' '}
                      <a href="https://communitycad.dev/subscribe" target="_blank" rel="noreferrer">
                        See plans
                      </a>
                    </>
                  )}
                </p>
              )}
              <ul class={quick !== null ? 'files grown' : 'files'}>
                {files.map((file) => {
                  const sendable = SENDABLE.test(file.path);
                  const sliceable = file.printable && SLICEABLE.test(file.path) && !sendable;
                  const downloadable = file.printable || sendable;
                  const busy = sending !== null || cost?.allowed === false;
                  const needle = query.trim().toLowerCase();
                  const shown = (projects ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle));
                  return (
                    <li key={file.id} class="file-row">
                      <div class="file-head">
                        <span class="path" title={file.path}>{file.path}</span>
                        <span class="sz">{formatBytes(file.size_bytes)}</span>
                      </div>
                      {/* Every action as a button, nothing behind a menu. */}
                      <div class="file-actions">
                        {sendable && (sent[file.id] ? (
                          <span class="sz" style="color:#48bb78">
                            {sent[file.id].length > 1 ? `Saved ${sent[file.id].length} plates` : 'In G-code files'}
                          </span>
                        ) : (
                          <>
                            <Act primary icon={mdiPrinter3dNozzleOutline} disabled={busy}
                              label={sending === file.id && printing === null ? 'Saving…' : 'Print'}
                              tip={describeDownloadCost(cost) ?? 'Save it to the printer, then confirm to start'}
                              onClick={() => void send(file.id, true)} />
                            <Act icon={mdiContentSaveOutline} disabled={busy} label="Save to printer" short="Save"
                              tip={describeDownloadCost(cost) ?? 'Into the printer\'s G-code files'}
                              onClick={() => void send(file.id)} />
                          </>
                        ))}
                        {sliceable && (
                          <>
                            <Act primary icon={mdiPrinter3dNozzleOutline} disabled={busy || quick !== null} label="Print"
                              tip={describeDownloadCost(cost) ?? 'Slice it with your last material and default profile, then choose Print or Send'}
                              onClick={() => (linked ? setQuick(file.id) : onConnect())} />
                            <Act icon={mdiLayersTripleOutline} disabled={busy}
                              label={opening === file.id ? 'Opening…' : 'Open in slicer'} short={opening === file.id ? 'Opening…' : 'Slicer'}
                              tip={describeDownloadCost(cost) ?? 'A new project with this model, in the slicer'}
                              onClick={() => void addToProject(file.id, null)} />
                            <Act icon={mdiFolderPlusOutline} disabled={busy} label="Add to project" short="Project"
                              tip="Add it to a project you already have"
                              onClick={() => { openMenu(file.id); showProjects(); }} />
                            {kept[file.id] ? (
                              <Act icon={mdiCheck} label="In Models ›" short="In Models" tip="Open Models on the printer" onClick={onModels} />
                            ) : (
                              <Act icon={mdiContentSaveOutline} disabled={busy}
                                label={sending === file.id && quick === null && opening === null ? 'Saving…' : 'Save to printer'}
                                short={sending === file.id && quick === null && opening === null ? 'Saving…' : 'Save'}
                                tip={describeDownloadCost(cost) ?? 'Into Models on the printer, for slicing later'}
                                onClick={() => void keep(file.id)} />
                            )}
                          </>
                        )}
                        {downloadable && (links[file.id] ? (
                          <a class="btn ghost sm act" href={links[file.id]} target="_blank" rel="noreferrer"
                            title="Open download" aria-label="Open download">
                            <Icon path={mdiOpenInNew} size={18} />
                            <span class="act-label">Open download</span><span class="act-short" aria-hidden="true">Open</span>
                          </a>
                        ) : (
                          <Act icon={mdiTrayArrowDown} disabled={downloading !== null || cost?.allowed === false}
                            label={downloading === file.id ? 'Getting link…' : started === file.id ? 'Download started' : 'Download'}
                            short={downloading === file.id ? '…' : started === file.id ? 'Started' : 'Download'}
                            tip={'To this device. ' + (describeDownloadCost(cost) ?? '')}
                            onClick={() => void download(file.id)} />
                        ))}
                      </div>
                      {menuFor === file.id && menuView === 'projects' && (
                        <ConfirmSheet label="Add to project" onClose={closeMenu}>
                          <strong class="confirm-title">Add to project</strong>
                          {(projects?.length ?? 0) > 3 && (
                            <input class="menu-search" type="search" placeholder="Search projects" value={query}
                              aria-label="Search projects"
                              onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
                          )}
                          {projects === null && <p class="sub">Reading projects…</p>}
                          {(needle ? shown.slice(0, 8) : shown.slice(0, 5)).map((p) => (
                            <button key={p.id} class="menu-item menu-project" type="button"
                              disabled={sending !== null} onClick={() => void addToProject(file.id, p)}>
                              <span class="menu-thumb">
                                {p.thumbnail
                                  ? <img src={`${currentApiBase()}${p.thumbnail.url}`} alt="" decoding="async" />
                                  : <Icon path={ICONS.cube} size={20} />}
                              </span>
                              <span class="menu-name">{p.name}</span>
                            </button>
                          ))}
                          {projects !== null && needle && shown.length === 0 && <p class="sub">No project matches.</p>}
                          {projects !== null && !needle && projects.length > 5 && (
                            <p class="sub">{projects.length - 5} more: search to find them.</p>
                          )}
                          <button class="menu-item menu-new" type="button" disabled={sending !== null}
                            onClick={() => void addToProject(file.id, null)}>
                            + New project
                          </button>
                        </ConfirmSheet>
                      )}
                      {(sending === file.id || opening === file.id) && (
                        // How far the file has got on its way to the printer.
                        <div style="flex-basis:100%"><TransferBar modelId={id} fileId={file.id} /></div>
                      )}
                      {quick === file.id && (
                        <div style="flex-basis:100%">
                          <QuickPrint modelId={id} fileId={file.id} onOpenProject={onOpenProject}
                            onClose={() => { setQuick(null); downloadCheck(id).then(setCost).catch(() => undefined); }} />
                        </div>
                      )}
                      {BGCODE.test(file.path) && (
                        <span class="sub" style="flex-basis:100%">
                          Prusa binary G-code: Klipper can't print it. Download it, or use this model's other files.
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {Object.entries(sent).flatMap(([fileId, saved]) =>
                saved.map((info) => (
                  <SentFile key={`${fileId}:${info.filename}`} filename={info.filename} match={info.match} fromCatalog
                    printerState={printerState} confirm={printing === Number(fileId)}
                    onDecline={() => setPrinting(null)} />
                )),
              )}

              {!files.some((f) => SENDABLE.test(f.path)) && (
                <p class="sub">
                  No G-code here. <strong>Open in slicer</strong> makes a project with a model file, ready to
                  slice. Saved model files wait in{' '}
                  <button class="link-btn" type="button" onClick={onModels}>Models on the printer</button>.
                </p>
              )}
            </>
          )}


        </div>
      </div>
      {model.readme_markdown && <Readme text={model.readme_markdown} pageUrl={`https://communitycad.dev/models/${model.slug}-${model.id}`} />}
      <div ref={frames} hidden />
    </>
  );
}

/** Every picture of a model, the cover first and none twice. */
function galleryOf(model: Detail): { url: string; caption: string | null }[] {
  const out: { url: string; caption: string | null }[] = [];
  if (model.thumbnail_url) out.push({ url: model.thumbnail_url, caption: null });
  for (const img of model.images ?? []) {
    if (img.url && /^https:\/\//.test(img.url) && !out.some((o) => o.url === img.url)) out.push(img);
  }
  return out;
}

/**
 * One file action: icon and label on a wide screen; on a phone, the icon
 * with a short caption under it, so all five fit on one row. The tooltip names it
 * and says what it costs, where there's a pointer to hover with.
 */
function Act({ icon, label, short, tip, primary = false, disabled = false, onClick }: {
  icon: string; label: string; short?: string; tip?: string; primary?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button class={`btn sm act${primary ? '' : ' ghost'}`} type="button" disabled={disabled}
      aria-label={label} title={tip ? `${label}. ${tip}` : label} onClick={onClick}>
      <Icon path={icon} size={18} />
      <span class="act-label">{label}</span>
      <span class="act-short" aria-hidden="true">{short ?? label}</span>
    </button>
  );
}

/** The model's pictures, side by side, swiped like Bambu Handy's. */
function Gallery({ images }: { images: { url: string; caption: string | null }[] }) {
  const [index, setIndex] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  if (images.length === 0) return <div class="thumb ph hero">no preview</div>;
  const go = (i: number) => {
    const el = strip.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };
  // ‹ › wrap around, so the last picture's › goes back to the first.
  const step = (d: number) => go((index + d + images.length) % images.length);
  const many = images.length > 1;
  return (
    <div class="gallery">
      <div class="gallery-frame">
      <div ref={strip} class="gallery-strip" tabIndex={many ? 0 : undefined} aria-label="Pictures of the model"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
          if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        }} onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
      }}>
        {images.map((img, i) => (
          <figure key={img.url} class="gallery-item">
            <img class="hero" src={img.url} alt={img.caption ?? `Picture ${i + 1}`} decoding="async" />
            {img.caption && <figcaption class="sub">{img.caption}</figcaption>}
          </figure>
        ))}
      </div>
      {many && (
        <>
          <button type="button" class="gallery-arrow prev" aria-label="Previous picture" onClick={() => step(-1)}>‹</button>
          <button type="button" class="gallery-arrow next" aria-label="Next picture" onClick={() => step(1)}>›</button>
          <span class="gallery-count" aria-hidden="true">{index + 1} / {images.length}</span>
        </>
      )}
      </div>
      {many && (
        <div class="gallery-dots" role="tablist" aria-label="Pictures">
          {images.map((img, i) => (
            <button key={img.url} type="button" role="tab" aria-selected={i === index}
              aria-label={`Picture ${i + 1} of ${images.length}`} onClick={() => go(i)} />
          ))}
        </div>
      )}
    </div>
  );
}

const README_SHOWN = 1500;      // characters before Read more
const README_MAX = 60_000;      // past this, the full text is on CommunityCAD

/** The README, short until asked for more. */
function Readme({ text, pageUrl }: { text: string; pageUrl: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > README_SHOWN;
  const cut = open ? text.slice(0, README_MAX) : text.slice(0, README_SHOWN).replace(/\n[^\n]*$/, '');
  return (
    <section class="readme" aria-label="About this model">
      <h3>About this model</h3>
      <div class={`md${!open && long ? ' faded' : ''}`}>{renderMarkdown(cut)}</div>
      {long && !open && <button class="btn ghost sm" type="button" onClick={() => setOpen(true)}>Read more</button>}
      {open && text.length > README_MAX && (
        <p class="sub">The rest is on <a href={pageUrl} target="_blank" rel="noreferrer noopener">CommunityCAD</a>.</p>
      )}
    </section>
  );
}
