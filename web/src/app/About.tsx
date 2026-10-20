import { useState } from 'preact/hooks';

import { ICONS, Icon } from './icons';
import type { Status } from './types';

/** Where the plugin lives. One place, so the move to the CommunityCAD org is a one-line change. */
/** The public repo: docs, releases and the issue tracker. The one place it's named in the UI. */
export const REPO = 'https://github.com/CommunityCad-dev/communitycad-klipper';

/**
 * Where the plugin is. Written by hand at each release, not fetched: the About
 * tab must work with no internet, and a status read from a server could be
 * changed without the plugin changing.
 */
const STATUS = {
  stage: 'Alpha',
  note: 'Being tested on its author\'s printer before a closed beta.',
  workingOn: [
    'Polishing what exists, so it looks and feels like OrcaSlicer and Bambu Handy',
    'Sharing prints to CommunityCAD, tested end to end',
    'Sending to the printer from the CommunityCAD website',
  ],
};

export type FeedbackKind = 'bug' | 'feature' | 'enhancement' | 'general';

export const KINDS: { kind: FeedbackKind; label: string; hint: string }[] = [
  { kind: 'bug', label: 'Bug', hint: 'Something doesn\'t work as it should.' },
  { kind: 'feature', label: 'Feature request', hint: 'Something the plugin doesn\'t do yet.' },
  { kind: 'enhancement', label: 'Enhancement', hint: 'Something that could work better.' },
  { kind: 'general', label: 'General', hint: 'Anything else.' },
];

/**
 * The new-issue page for one kind of feedback, with the form filled in.
 * Only what the user typed, plus versions: no addresses, tokens, file names or
 * printer settings. GitHub fills an issue form's fields from query parameters
 * named after the field ids in .github/ISSUE_TEMPLATE.
 */
export function feedbackUrl(kind: FeedbackKind, title: string, text: string, versions: string | null): string {
  const params = new URLSearchParams({ template: `${kind}.yml` });
  if (title.trim()) params.set('title', title.trim().slice(0, 120));
  if (text.trim()) params.set('what', text.trim().slice(0, 4000));
  if (versions) params.set('versions', versions);
  return `${REPO}/issues/new?${params.toString()}`;
}

/** Versions worth knowing for a bug, and nothing that identifies the printer or its owner. */
export function versionsText(status: Status, version: string, hostName: string): string {
  return [
    `Plugin: ${status.component_version}`,
    `Interface script: ${version}`,
    `Host: ${hostName === 'mainsail' ? 'Mainsail' : hostName === 'fluidd' ? 'Fluidd' : 'unknown'}`,
    `Screen: ${window.innerWidth < 600 ? 'phone' : window.innerWidth < 1000 ? 'tablet' : 'desktop'}`,
  ].join('\n');
}

/**
 * About: what the plugin is for, where it stands, where the docs are, and
 * feedback that becomes a GitHub issue.
 */
export function About({ status, version, hostName }: { status: Status; version: string; hostName: string }) {
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [withVersions, setWithVersions] = useState(true);
  const versions = versionsText(status, version, hostName);

  return (
    <div class="about-grid">
      <section class="panel settings-card" aria-label="About">
        <div class="panel-head"><Icon path={ICONS.cube} /><span>CommunityCAD for Klipper</span></div>
        <div class="settings-body about">
          <p>
            Find a model on CommunityCAD, slice it on your printer, print it, and share how it went. All from
            Mainsail or Fluidd, from your phone, with your own printer's settings.
          </p>
          <p class="sub">
            Open source and free. Mainsail and Fluidd aren't changed, and the CommunityCAD sign-in stays on the
            printer, never in the browser.
          </p>
          <div class="field">
            <label>Status</label>
            <div><span class="badge stage">{STATUS.stage}</span> <span class="sub">{STATUS.note}</span></div>
            <ul class="about-list">
              {STATUS.workingOn.map((w) => <li key={w}>{w}</li>)}
            </ul>
            <div class="sub">Plugin {status.component_version}. Updates through Mainsail or Fluidd.</div>
          </div>
          <div class="field">
            <label>Docs</label>
            <div class="about-links">
              <a href={`${REPO}#readme`} target="_blank" rel="noreferrer">Plugin guide on GitHub</a>
              <a href="https://communitycad.dev/docs" target="_blank" rel="noreferrer">CommunityCAD docs</a>
              <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">Known issues</a>
            </div>
          </div>
          <a class="ccad-banner" href="https://communitycad.dev" target="_blank" rel="noreferrer">
            <span class="ccad-banner-icon"><Icon path={ICONS.cube} size={28} /></span>
            <span>
              <strong>CommunityCAD</strong>
              <span class="sub">Models with their CAD source, print profiles from people who printed them, and
                your own uploads.</span>
            </span>
            <span class="ccad-banner-go" aria-hidden="true">›</span>
          </a>
        </div>
      </section>

      <section class="panel settings-card" aria-label="Feedback">
        <div class="panel-head"><span>Feedback</span></div>
        <form class="settings-body feedback" onSubmit={(e) => {
          e.preventDefault();
          const w = window.open(feedbackUrl(kind, title, text, withVersions ? versions : null), '_blank');
          if (w) w.opener = null;
        }}>
          <div class="chips" role="radiogroup" aria-label="Kind of feedback">
            {KINDS.map((k) => (
              <button key={k.kind} type="button" class="tab chip" role="radio" aria-checked={kind === k.kind}
                aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)}>{k.label}</button>
            ))}
          </div>
          <div class="sub">{KINDS.find((k) => k.kind === kind)!.hint}</div>
          <input type="text" placeholder="A short title" aria-label="Title" maxLength={120} value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          <textarea rows={5} placeholder={kind === 'bug' ? 'What you did, what you expected, and what happened.'
            : 'Tell us about it.'} aria-label="Your feedback" maxLength={4000} value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <label class="sub check">
            <input type="checkbox" checked={withVersions}
              onChange={(e) => setWithVersions((e.target as HTMLInputElement).checked)} />
            Include versions
          </label>
          {withVersions && <pre class="versions">{versions}</pre>}
          <div class="foot">
            <button class="btn" type="submit" disabled={!text.trim()}>Continue on GitHub</button>
          </div>
          <p class="sub">
            Opens a new issue on GitHub with this filled in, for you to check and send. It needs a GitHub
            account. Nothing is sent from the printer.
          </p>
        </form>
      </section>
    </div>
  );
}
