import { useEffect, useRef, useState } from 'preact/hooks';

import { ApiError, createPost, currentApiBase, postOptions, webcamSnapshot } from './api';
import type { PostOptions, SharePrint } from './types';

const MAX_PHOTOS = 4;
const MAX_CAPTION = 500;
const MAX_SIDE = 2560;

interface Photo { data: string; type: string; url: string; source: 'device' | 'webcam' }

/** A phone photo, shrunk to at most 2560 px and re-encoded as JPEG: a few hundred
 * KB instead of many MB through the Pi, and inside the platform's 5 MB limit. */
async function shrink(file: File): Promise<Photo> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL('image/jpeg', 0.88);
  return { data: url.split(',')[1] ?? '', type: 'jpg', url, source: 'device' };
}

/**
 * A post about a finished print. A photo from the phone is the default; a
 * webcam snapshot and the timelapse are offered only when turned on in Settings,
 * and the snapshot is shown before it's used. Publish, or keep it private (only you see it until you publish it on CommunityCAD).
 */
export function PostComposer({ print, modelId, draftFirst = false, draftOnly = false, onDone, onClose }: {
  print: SharePrint; modelId?: number; onDone: () => void; onClose: () => void;
  /** "Only me, until I publish it": Keep private is the main button. */
  draftFirst?: boolean;
  /** The model is private: Keep private only, no Publish. */
  draftOnly?: boolean;
}) {
  const [options, setOptions] = useState<PostOptions | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [caption, setCaption] = useState('');
  const [timelapse, setTimelapse] = useState(false);
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string | null; text: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    postOptions(print.job_id)
      .then((o) => { setOptions(o); setAttach(!!o.profile_id && o.attach_profile); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read this print.'));
  }, [print.job_id]);

  const addFiles = async (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    const files = [...(input.files ?? [])].slice(0, MAX_PHOTOS - photos.length);
    input.value = '';
    setBusy('Preparing photos…');
    try {
      const shrunk = await Promise.all(files.map(shrink));
      setPhotos((p) => [...p, ...shrunk].slice(0, MAX_PHOTOS));
    } catch {
      setError("One of those photos couldn't be read.");
    } finally {
      setBusy(null);
    }
  };

  const snapshot = async () => {
    setBusy('Taking a snapshot…');
    setError(null);
    try {
      const s = await webcamSnapshot();
      const mime = s.type === 'jpg' ? 'jpeg' : s.type;
      setPhotos((p) => [...p, { data: s.data, type: s.type, url: `data:image/${mime};base64,${s.data}`, source: 'webcam' as const }]
        .slice(0, MAX_PHOTOS));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The webcam didn't answer.");
    } finally {
      setBusy(null);
    }
  };

  const send = async (publish: boolean) => {
    setBusy(publish ? 'Publishing…' : 'Saving privately…');
    setError(null);
    try {
      const r = await createPost({
        job_id: print.job_id, model_id: modelId, caption: caption.trim(), publish,
        images: photos.map((p) => ({ data: p.data })), timelapse, attach_profile: attach,
      });
      if (r.queued) {
        setResult({ url: null, text: "Saved on the printer. It posts when CommunityCAD answers." });
      } else {
        const lines = [publish ? 'Posted.' : 'Kept private: only you can see it until you publish it on CommunityCAD.'];
        if (r.message) lines.push(r.message);
        if (r.video_uploading) lines.push('The timelapse is uploading from the printer; the post finishes when it\'s in.');
        setResult({ url: (publish ? r.post?.url : r.post?.edit_url) ?? null, text: lines.join(' ') });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not post it.');
    } finally {
      setBusy(null);
    }
  };

  if (result) {
    return (
      <div class="composer">
        <p>{result.text}</p>
        <div class="foot">
          {result.url && <a class="btn sm" href={result.url} target="_blank" rel="noreferrer">Open the post</a>}
          <button class="btn ghost sm" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  const tl = options?.timelapse;
  const ready = photos.length > 0 || (timelapse && tl && !tl.too_big);
  return (
    <div class="composer">
      <div class="photo-row">
        {photos.map((p, i) => (
          <div key={p.url.slice(-24) + i} class="photo">
            <img src={p.url} alt={p.source === 'webcam' ? 'Webcam snapshot' : 'Your photo'} />
            <button type="button" class="icon-btn sm" aria-label="Remove photo"
              onClick={() => setPhotos((list) => list.filter((_, j) => j !== i))}>✕</button>
            {p.source === 'webcam' && <span class="tag">Webcam</span>}
          </div>
        ))}
        {photos.length < MAX_PHOTOS && (
          <button type="button" class="photo add" onClick={() => picker.current?.click()} disabled={!!busy}>
            + Photo
          </button>
        )}
        <input ref={picker} type="file" accept="image/*" multiple hidden onChange={addFiles} />
      </div>
      {options?.webcam && photos.length < MAX_PHOTOS && (
        <button class="btn ghost sm" type="button" disabled={!!busy} onClick={() => void snapshot()}>
          Add a webcam snapshot
        </button>
      )}
      {tl && (
        <label class="sub check">
          <input type="checkbox" checked={timelapse} disabled={tl.too_big}
            onChange={(e) => setTimelapse((e.target as HTMLInputElement).checked)} />
          Include the timelapse ({(tl.size_bytes / 1048576).toFixed(1)} MB{tl.too_big ? ', over the 50 MB a post takes' : ''})
        </label>
      )}
      {tl && timelapse && (
        <video class="tl-preview" src={`${currentApiBase()}${tl.url}`} controls muted playsInline preload="metadata" />
      )}
      <textarea rows={3} maxLength={MAX_CAPTION} placeholder="Say something about this print (optional)"
        value={caption} onInput={(e) => setCaption((e.target as HTMLTextAreaElement).value)} />
      <div class="sub" style="text-align:right">{caption.length}/{MAX_CAPTION}</div>
      {options?.profile_id ? (
        <label class="sub check">
          <input type="checkbox" checked={attach} onChange={(e) => setAttach((e.target as HTMLInputElement).checked)} />
          Attach the print profile you shared
        </label>
      ) : (
        <p class="sub">Share the profile first to attach it to the post.</p>
      )}
      {draftOnly && <p class="sub">The model is private, so this post is kept private too. Publish it on CommunityCAD once the model is public.</p>}
      {error && <p class="sub" style="color:#f6ad55">{error}</p>}
      <div class="foot">
        {(draftOnly ? [false] : [!draftFirst, draftFirst]).map((publish, i) => (
          <button key={String(publish)} class={i === 0 ? 'btn sm' : 'btn ghost sm'} type="button"
            disabled={!!busy || !ready} onClick={() => void send(publish)}>
            {publish
              ? (busy === 'Publishing…' ? busy : 'Publish')
              : (busy === 'Saving privately…' ? busy : 'Keep private')}
          </button>
        ))}
        <button class="btn ghost sm" type="button" disabled={!!busy} onClick={onClose}>Cancel</button>
        {busy && busy !== 'Publishing…' && busy !== 'Saving privately…' && <span class="sub">{busy}</span>}
      </div>
    </div>
  );
}
