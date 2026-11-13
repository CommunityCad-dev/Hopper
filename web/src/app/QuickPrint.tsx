import { useEffect, useRef, useState } from 'preact/hooks';

import {
  ApiError, createProject, getSlice, listMaterials, listProfiles, projectFileUrl, saveModel, sendSlice, startSlice,
} from './api';
import { renderPlateThumbs } from './gcodeThumbs';
import { readProject } from './plate3mf';
import { materialColour } from './ProjectView';
import { ConfirmSheet } from './ConfirmSheet';
import { SentFile } from './SentFile';
import { TransferBar } from './TransferBar';
import type { MaterialSummary, ProfilesList, ProjectEntry, SlicedPlate, SliceJob } from './types';

/** A slice that ended without G-code: its own message is the one to show. */
class SliceFailed extends Error {}

type Step = 'saving' | 'arranging' | 'slicing' | 'ready' | 'sending' | 'sent' | 'failed';

const STEP_TEXT: Partial<Record<Step, string>> = {
  saving: 'Saving it to the printer…', arranging: 'Placing it on the bed…', slicing: 'Slicing',
  sending: 'Sending it to the printer…',
};

/**
 * Quick print from a model page, the few taps Bambu Handy takes: the model
 * is saved, placed and sliced on the Pi with the last material used and the
 * default print profile, then the user chooses Print or Send once. Print still
 * goes through the usual confirm, so nothing starts on its own. Anything
 * this can't do (several plates, a change of placement) opens the project in the
 * slicer, where it already is.
 */
export function QuickPrint({ modelId, fileId, onOpenProject, onClose }: {
  modelId: number; fileId: number; onOpenProject: (p: ProjectEntry) => void; onClose: () => void;
}) {
  const [step, setStep] = useState<Step>('saving');
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectEntry | null>(null);
  const [job, setJob] = useState<SliceJob | null>(null);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [profiles, setProfiles] = useState<ProfilesList | null>(null);
  const [material, setMaterial] = useState('');
  const [profile, setProfile] = useState('');
  const [sent, setSent] = useState<{ plate: SlicedPlate; printerState?: string | null; print: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const fail = (err: unknown, fallback: string) => {
    if (!alive.current) return;
    setError(err instanceof ApiError || err instanceof SliceFailed ? err.message : fallback);
    setStep('failed');
  };

  const slice = async (target: ProjectEntry, mat: string, prof: string) => {
    setStep('slicing');
    setError(null);
    let current = await startSlice({ project: target.filename }, { material: mat, profile: prof, process: target.options?.process ?? {} });
    while (alive.current && current.state === 'slicing') {
      setJob(current);
      await new Promise((r) => window.setTimeout(r, 1500));
      current = await getSlice();
    }
    if (!alive.current) return;
    setJob(current);
    if (current.state !== 'done') throw new SliceFailed(current.error ?? 'The slice didn\'t finish.');
    setStep('ready');
  };

  useEffect(() => {
    void (async () => {
      try {
        const saved = await saveModel(modelId, fileId);
        if (!alive.current) return;
        setStep('arranging');
        const target = saved.project ?? (await createProject([{ model: saved.model!.filename, copies: 1 }])).project;
        if (!alive.current) return;
        setProject(target);
        const mat = target.options?.material ?? 'PLA';
        const prof = target.options?.profile ?? '';
        setMaterial(mat);
        setProfile(prof);
        listMaterials().then((r) => alive.current && setMaterials(r.materials)).catch(() => undefined);
        listProfiles().then((r) => alive.current && setProfiles(r)).catch(() => undefined);
        await slice(target, mat, prof);
      } catch (err) {
        fail(err, 'Could not get it ready to print.');
      }
    })();
  }, [modelId, fileId]);

  const reslice = (mat: string, prof: string) => {
    if (!project) return;
    setMaterial(mat);
    setProfile(prof);
    setSent(null);
    void slice(project, mat, prof).catch((err) => fail(err, 'Could not slice it.'));
  };

  const send = async (print: boolean) => {
    const plate = job?.plates?.[0];
    if (!project || !plate) return;
    setStep('sending');
    try {
      let thumbs: { width: number; height: number; png: string }[] = [];
      try {
        const bytes = new Uint8Array(await (await fetch(projectFileUrl(project.filename))).arrayBuffer());
        thumbs = renderPlateThumbs(await readProject(bytes), plate.plate,
          materialColour(materials.find((m) => m.name === material)));
      } catch { /* a file without thumbnails still prints */ }
      const r = await sendSlice(plate.plate, thumbs);
      if (!alive.current) return;
      setSent({ plate: r.plate, printerState: r.printer_state, print });
      setStep('sent');
    } catch (err) {
      fail(err, 'Could not send it to the printer.');
    }
  };

  const plates = job?.plates ?? [];
  const summary = plates[0]?.summary ?? job?.summary;
  const busy = step === 'saving' || step === 'arranging' || step === 'slicing' || step === 'sending';

  return (
    <div class="quick" role="region" aria-label="Quick print">
      <div class="quick-head">
        <strong>Quick print</strong>
        <button class="icon-btn sm" type="button" aria-label="Close quick print" onClick={onClose}>✕</button>
      </div>
      {busy && (
        <div class="sub quick-step" aria-live="polite">
          {STEP_TEXT[step]}{step === 'slicing' ? `… ${Math.round(job?.elapsed_s ?? 0)} s` : ''}
          {step === 'saving' && <TransferBar modelId={modelId} fileId={fileId} />}
        </div>
      )}
      {step === 'failed' && <p class="sub" style="color:#f6ad55">{error}</p>}

      {(step === 'ready' || step === 'slicing' || step === 'sending') && project && (
        <div class="quick-choices">
          <label class="sub">Material
            <select class="setting-select" value={material} disabled={busy}
              onChange={(e) => reslice((e.target as HTMLSelectElement).value, profile)}>
              {(materials.length ? materials.map((m) => m.name) : [material]).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label class="sub">Profile
            <select class="setting-select" value={profile} disabled={busy}
              onChange={(e) => reslice(material, (e.target as HTMLSelectElement).value)}>
              {[...(profiles?.custom.map((c) => c.name) ?? []), ...(profiles?.defaults.map((d) => d.name) ?? [profile])]
                .map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      )}

      {step === 'ready' && plates.length > 1 && (
        <p class="sub">It needs {plates.length} plates. Open it in the slicer to print them one at a time.</p>
      )}
      {step === 'ready' && plates.length === 1 && summary && (
        <p class="quick-summary">
          {[summary.print_time, summary.filament_g ? `${summary.filament_g} g` : '', material].filter(Boolean).join(' · ')}
        </p>
      )}
      {job?.capped && step === 'ready' && <p class="sub">{job.capped}</p>}

      {step === 'ready' && (
        <div class="foot">
          {plates.length === 1 && (
            <>
              <button class="btn sm" type="button" onClick={() => void send(true)}>Print</button>
              <button class="btn ghost sm" type="button" title="Put it in the G-code files without starting it"
                onClick={() => void send(false)}>Send</button>
            </>
          )}
          <button class="btn ghost sm" type="button" onClick={() => project && onOpenProject(project)}>Open in slicer</button>
        </div>
      )}
      {step === 'failed' && project && (
        <div class="foot">
          <button class="btn ghost sm" type="button" onClick={() => onOpenProject(project)}>Open in slicer</button>
        </div>
      )}

      {step === 'sent' && sent?.plate.gcode && sent.plate.match && (sent.print ? (
        // Print: the confirm opens over the page, not below the panel.
        <ConfirmSheet onClose={onClose}>
          <SentFile filename={sent.plate.gcode} match={sent.plate.match} printerState={sent.printerState}
            confirm onDecline={onClose} onDone={onClose} materials={materials.map((m) => m.name)}
            onChangeMaterial={(m) => reslice(m, profile)} />
        </ConfirmSheet>
      ) : (
        <SentFile filename={sent.plate.gcode} match={sent.plate.match} printerState={sent.printerState} />
      ))}
    </div>
  );
}
