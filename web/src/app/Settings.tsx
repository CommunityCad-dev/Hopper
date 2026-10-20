import { useEffect, useState } from 'preact/hooks';

import { ApiError, listWebcams, rename, saveSettings, unlink } from './api';
import { FolderPicker } from './FolderPicker';
import { Materials } from './Materials';
import { OrcaPresets } from './OrcaPresets';
import { Profiles } from './Profiles';
import { PermissionsAsk } from './Permissions';
import { PrinterCard } from './PrinterCard';
import type { BuildVolume, Status } from './types';

interface Props {
  status: Status;
  onSaved: () => void;
  onConnect: () => void;
}

export function Settings({ status, onSaved, onConnect }: Props) {
  const [name, setName] = useState(status.printer_name);
  const [busy, setBusy] = useState(false);
  const [accountNote, setAccountNote] = useState<string | null>(null);
  const [tab, setTab] = useState<'fits' | 'all'>(status.default_tab);
  const [folder, setFolder] = useState(status.send_folder ?? 'communitycad');
  const [folderNote, setFolderNote] = useState<string | null>(null);
  // Profiles and Materials are panels here. An open editor gets the whole page;
  // the panels stay mounted so it keeps what's typed. `presets` reloads both after an
  // OrcaSlicer import.
  const [focus, setFocus] = useState<'profiles' | 'materials' | null>(null);
  const [presets, setPresets] = useState(0);
  const editing = (which: 'profiles' | 'materials') => (open: boolean) => {
    setFocus(open ? which : null);
    if (!open) {
      window.setTimeout(() => {
        const host = document.getElementById('ccad-root')?.shadowRoot;
        host?.getElementById(`ccad-${which}`)?.scrollIntoView({ block: 'start' });
      }, 50);
    } else {
      window.scrollTo({ top: 0 });
    }
  };
  const [webcams, setWebcams] = useState<string[]>([]);
  const [useWebcam, setUseWebcam] = useState(!!status.post_webcam);
  const [shareMode, setShareMode] = useState(status.share_after_print ?? (status.share_prompt === false ? 'off' : 'ask'));
  const [visibility, setVisibility] = useState(status.share_visibility ?? 'public');
  useEffect(() => { listWebcams().then((r) => setWebcams(r.webcams.map((w) => w.name))).catch(() => undefined); }, []);

  const saveFolder = async () => {
    setBusy(true);
    setFolderNote(null);
    try {
      const saved = await saveSettings({ send_folder: folder });
      const now = String((saved as { send_folder?: string }).send_folder ?? folder);
      setFolder(now);
      setFolderNote(now ? `Saved. Files go to G-code files / ${now}.` : 'Saved. Files go to the top of G-code files.');
      onSaved();
    } catch (err) {
      setFolderNote(err instanceof ApiError ? err.message : 'Could not save. Your printer works as normal.');
    } finally {
      setBusy(false);
    }
  };

  const saveTab = async (next: 'fits' | 'all') => {
    setTab(next);
    setBusy(true);
    try {
      await saveSettings({ default_tab: next });
      onSaved();
    } catch {
      setNote('Could not save. Your printer works as normal.');
    } finally {
      setBusy(false);
    }
  };
  const detected = status.build_volume;
  const [x, setX] = useState(detected ? String(Math.round(detected.x)) : '');
  const [y, setY] = useState(detected ? String(Math.round(detected.y)) : '');
  const [z, setZ] = useState(detected ? String(Math.round(detected.z)) : '');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const doRename = async () => {
    setBusy(true);
    setAccountNote(null);
    try {
      await rename(name.trim());
      setAccountNote('Renamed.');
      onSaved();
    } catch {
      setAccountNote('Could not rename. Your printer works as normal.');
    } finally {
      setBusy(false);
    }
  };

  const doUnlink = async () => {
    setBusy(true);
    setAccountNote(null);
    try {
      await unlink();
      // The browser remembers the account only to offer a friendlier Connect
      // screen on another printer; forget it when this one is unlinked.
      try {
        localStorage.removeItem('ccad:lastAccount');
      } catch {
        /* private mode, or storage blocked */
      }
      onSaved();
    } catch {
      setAccountNote('Could not unlink. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = async (volume: Partial<BuildVolume> | null) => {
    setSaving(true);
    setNote(null);
    try {
      await saveSettings({ build_volume: volume });
      setNote('Saved.');
      onSaved();
    } catch {
      setNote('Could not save. Your printer works as normal.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>

      <div class={`settings-grid${focus ? ' focus' : ''}`}>
        <section class="panel settings-card" aria-label="Account">
          <div class="panel-head">Account</div>
          <div class="settings-body">
            <div class="field">
              {status.linked ? (
                <>
                  <div class="sub">Linked as {status.account?.username ?? 'unknown'}</div>
                  <div class="foot">
                    <button class="btn ghost" type="button" disabled={busy}
                      onClick={() => void doUnlink()}>Unlink this printer</button>
                  </div>
                  <a class="sub" href="https://communitycad.dev/settings" target="_blank" rel="noreferrer">
                    Manage account on CommunityCAD
                  </a>
                </>
              ) : (
                <>
                  <div class="sub">Not linked. Browsing works without an account.</div>
                  <div class="foot">
                    <button class="btn" type="button" onClick={onConnect}>Connect</button>
                  </div>
                </>
              )}
            </div>
            <div class="field">
              <label>Printer name{status.linked ? ' (shown on CommunityCAD)' : ''}</label>
              <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
              {status.linked ? (
                <div class="foot">
                  <button class="btn ghost" type="button"
                    disabled={busy || !name.trim() || name === status.printer_name}
                    onClick={() => void doRename()}>Rename</button>
                </div>
              ) : (
                <div class="sub">Set once this printer is linked.</div>
              )}
            </div>

            {accountNote && <div class="sub">{accountNote}</div>}
          </div>
        </section>
        <section class="panel settings-card" aria-label="This printer">
          <div class="panel-head">This printer</div>
          <div class="settings-body">
            <div class="field">
              <label>
                Build volume in mm
                {detected?.source === 'detected' && ' (detected from Klipper)'}
                {detected?.source === 'override' && ' (your override)'}
                {!detected && ' — not detected, so fit filtering is off'}
              </label>
              <div class="row3">
                <input type="number" inputMode="numeric" value={x} aria-label="X"
                  onInput={(e) => setX((e.target as HTMLInputElement).value)} />
                <input type="number" inputMode="numeric" value={y} aria-label="Y"
                  onInput={(e) => setY((e.target as HTMLInputElement).value)} />
                <input type="number" inputMode="numeric" value={z} aria-label="Z"
                  onInput={(e) => setZ((e.target as HTMLInputElement).value)} />
              </div>
              <div class="sub">
                Klipper's axis limits can include overtravel, so the detected figure is
                sometimes larger than the usable bed.
              </div>
            </div>

            <div class="foot">
              <button class="btn" type="button" disabled={saving}
                onClick={() => void save({ x: Number(x), y: Number(y), z: Number(z) })}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button class="btn ghost" type="button" disabled={saving}
                onClick={() => void save(null)}>
                Reset to detected
              </button>
            </div>

            {note && <div class="sub">{note}</div>}
            {status.permissions && (
              <div class="field">
                <label>What the plugin may read on this printer</label>
                <PermissionsAsk current={status.permissions} onDone={onSaved} inSettings />
              </div>
            )}
            <div class="field">
              <label>This printer, for slicing</label>
              <PrinterCard />
            </div>
          </div>
        </section>
        <section class="panel settings-card" aria-label="Browsing and sending">
          <div class="panel-head">Browsing and sending</div>
          <div class="settings-body">
            <div class="field">
              <label>Default browse tab</label>
              <div class="tabs">
                <button class="tab" type="button" disabled={busy}
                  aria-selected={tab === 'fits'}
                  onClick={() => void saveTab('fits')}>Fits your printer</button>
                <button class="tab" type="button" disabled={busy}
                  aria-selected={tab === 'all'}
                  onClick={() => void saveTab('all')}>All</button>
              </div>
            </div>
            <div class="field">
              <label>Send files to</label>
              <FolderPicker value={folder} disabled={busy} label="Where files go in G-code files"
                onChange={(f) => setFolder(f)} />
              <div class="foot">
                <button class="btn ghost" type="button"
                  disabled={busy || folder === (status.send_folder ?? 'communitycad')}
                  onClick={() => void saveFolder()}>Save</button>
              </div>
              <div class="sub">{folderNote ?? 'Where Send, Print and Save to printer put files. You can change it for each send too.'}</div>
            </div>
          </div>
        </section>
        <section class="panel settings-card" aria-label="OrcaSlicer presets">
          <div class="panel-head">OrcaSlicer presets</div>
          <div class="settings-body">
            <OrcaPresets onImported={() => setPresets((n) => n + 1)} />
          </div>
        </section>
        <div class={`settings-slot${focus === 'profiles' ? ' focused' : ''}`}>
          <Profiles key={`p${presets}`} onEditing={editing('profiles')} />
        </div>
        <div class={`settings-slot${focus === 'materials' ? ' focused' : ''}`}>
          <Materials key={`m${presets}`} onEditing={editing('materials')} />
        </div>
        <section class="panel settings-card" aria-label="Sharing">
          <div class="panel-head">Sharing</div>
          <div class="settings-body">
            <div class="field">
              <label class="sub setting-line">After a print of a CommunityCAD model finishes
                <select class="setting-select" value={shareMode}
                  onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value as 'ask' | 'auto' | 'off';
                    setShareMode(v);
                    void saveSettings({ share_after_print: v });
                  }}>
                  <option value="ask">Ask me</option>
                  <option value="auto">Share automatically</option>
                  <option value="off">Don't share</option>
                </select>
              </label>
              {shareMode === 'auto' && (
                <div class="sub setting-note">
                  A minute after a print completes, the printer shares its print profile
                  {useWebcam || status.post_timelapse ? ', and posts the webcam photo or timelapse' : ''}. Until then, the
                  banner has <em>Don't share this one</em>. Cancelled and failed prints are never shared on their own.
                </div>
              )}
              <label class="sub setting-line">Who can see what you share
                <select class="setting-select" value={visibility}
                  onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value as 'public' | 'private';
                    setVisibility(v);
                    void saveSettings({ share_visibility: v });
                  }}>
                  <option value="public">Everyone</option>
                  <option value="private">Only me, until I publish it</option>
                </select>
              </label>
              {visibility === 'private' && (
                <div class="sub setting-note">
                  Posts are kept private on CommunityCAD: only you see them until you publish them there. Print profiles
                  can't be private on CommunityCAD yet, so they aren't shared automatically; sharing one by hand
                  makes it public.
                </div>
              )}
              <label class="sub" style="display:flex;gap:8px;align-items:center">
                <input type="checkbox" defaultChecked={status.post_attach_profile !== false}
                  onChange={(e) => void saveSettings({ post_attach_profile: (e.target as HTMLInputElement).checked })} />
                Attach the print profile to posts
              </label>
              <label class="sub" style="display:flex;gap:8px;align-items:center">
                <input type="checkbox" defaultChecked={!!status.post_timelapse}
                  onChange={(e) => void saveSettings({ post_timelapse: (e.target as HTMLInputElement).checked })} />
                Offer timelapse in posts (needs moonraker-timelapse; nothing is read while this is off)
              </label>
              <label class="sub" style="display:flex;gap:8px;align-items:center">
                <input type="checkbox" checked={useWebcam}
                  onChange={(e) => {
                    const on = (e.target as HTMLInputElement).checked;
                    setUseWebcam(on);
                    void saveSettings({ post_webcam: on });
                  }} />
                Use webcam for post photos (the webcam is never read while this is off)
              </label>
              {useWebcam && webcams.length > 1 && (
                <label class="sub">Webcam:{' '}
                  <select class="setting-select" defaultValue={status.post_webcam_name ?? webcams[0]}
                    onChange={(e) => void saveSettings({ post_webcam_name: (e.target as HTMLSelectElement).value })}>
                    {webcams.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
