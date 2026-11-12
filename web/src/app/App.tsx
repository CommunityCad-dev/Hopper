import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { ApiError, createProject, getStatus } from './api';
import { About, REPO } from './About';
import { Browse } from './Browse';
import { Connect } from './Connect';
import { REFRESH_EVENT, notifyRefresh } from './DashboardPanel';
import { ModelDetailView } from './ModelDetail';
import { Menu } from './Menu';
import { Models } from './Models';
import { Projects } from './Projects';
import { ProjectView } from './ProjectView';
import { Notice } from './Notice';
import { PermissionsAsk } from './Permissions';
import { Settings } from './Settings';
import { Share } from './Share';
import { ShareBanner } from './ShareBanner';
import { hostAccent } from './theme';
import { useUpdateAvailable } from './updateCheck';
import type { ProjectEntry, Status } from './types';

export { APP_CSS } from './styles';

export interface AppProps {
  version: string;
  hostName: string;
}

type View =
  | { name: 'browse' }
  | { name: 'model'; id: number }
  | { name: 'models' }
  | { name: 'projects' }
  | { name: 'share' }
  | { name: 'project'; project: ProjectEntry }
  | { name: 'settings' }
  | { name: 'about' }
  | { name: 'connect' };

/**
 * The browser remembers which account it last linked, purely so the Connect screen
 * on a second printer can say "Signed in on another printer as …" instead of
 * starting cold. Per-browser convenience only — never credentials, which live on
 * the Pi at 0600 and never reach here.
 */
const LAST_ACCOUNT_KEY = 'ccad:lastAccount';

function rememberAccount(username: string | null | undefined): void {
  try {
    if (username) localStorage.setItem(LAST_ACCOUNT_KEY, username);
  } catch {
    /* private mode, or storage blocked */
  }
}

/** Mainsail opens a G-code file in its viewer from the URL; Fluidd has no such route. */
function toolpathsFor(hostName: string) {
  return hostName === 'mainsail'
    ? (gcode: string) => `/viewer?filename=${encodeURIComponent(`gcodes/${gcode}`)}`
    : undefined;
}

/** The tabs, in order. The third field: behind More on a phone. */
const TABS = [
  ['browse', 'Browse', false],
  ['models', 'Models', false],
  ['projects', 'Projects', false],
  ['share', 'Share', false],
  ['settings', 'Settings', true],
  ['about', 'About', true],
] as const;

export function App({ version, hostName }: AppProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: 'browse' });
  const [moreOpen, setMoreOpen] = useState(false);
  const browseScroll = useRef(0);
  const updated = useUpdateAvailable();

  const refresh = useCallback(() => {
    getStatus()
      .then((next) => {
        setStatus(next);
        setError(null);
        if (next.linked) rememberAccount(next.account?.username);
      })
      .catch((err) => {
        // The Pi's own component is unreachable. Say so plainly and let them retry;
        // the printer itself is unaffected either way.
        // A 404 here is specific and worth naming: the plugin is installed on the
        // machine serving this page, but not on the printer currently selected.
        setError(
          err instanceof ApiError && err.status === 404
            ? 'NOT_INSTALLED'
            : "Can't reach CommunityCAD. Your printer works as normal.",
        );
      });
  }, []);

  useEffect(() => {
    refresh();
    // The dashboard panel can link or unlink this printer too. Reload when it says
    // something changed, so the two trees never disagree about the account.
    const onExternalChange = () => refresh();
    window.addEventListener(REFRESH_EVENT, onExternalChange);
    // Coming back to the page (another tab, the phone's app switcher): check again,
    // so changes made elsewhere -- like answers reset on the Pi -- show up.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(REFRESH_EVENT, onExternalChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Dark palette to match both hosts, with the host's own accent so the plugin reads
  // as part of the interface rather than bolted on.
  const vars = [
    `--ccad-accent:${hostAccent()}`,
    '--ccad-fg:#e2e8f0',
    '--ccad-line:rgba(127,127,127,.32)',
    '--ccad-card:rgba(127,127,127,.07)',
    '--ccad-input:rgba(127,127,127,.12)',
  ].join(';');

  if (error === 'NOT_INSTALLED') {
    return (
      <div class="wrap" style={vars}>
        <div class="msg warn">
          <p>Hopper isn't installed on this printer.</p>
          <p class="sub">
            Each printer needs its own install. On that printer's host, run:
          </p>
          <pre class="cmd">{`bash <(curl -fsSL ${REPO}/releases/latest/download/install.sh)`}</pre>
          <button class="btn" type="button" onClick={refresh}>Retry</button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="wrap" style={vars}>
        <div class="msg warn">
          <p>{error}</p>
          <button class="btn" type="button" onClick={refresh}>Retry</button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div class="wrap" style={vars}>
        <div class="grid">
          {Array.from({ length: 8 }, (_, i) => <div class="skeleton" key={i} />)}
        </div>
      </div>
    );
  }

  const volume = status.build_volume;

  // First open: nothing is read from the printer until both are answered,
  // so this comes before everything else.
  const perms = status.permissions;
  if (perms && (perms.printer_settings === null || perms.print_history === null)) {
    return (
      <div class="wrap" style={vars}>
        <PermissionsAsk current={perms} onDone={refresh} />
      </div>
    );
  }

  // Then the notice, once per printer and per notice version.
  if (status.notice && !status.notice.accepted) {
    return (
      <div class="wrap" style={vars}>
        <Notice version={status.notice.version} onDone={refresh} />
      </div>
    );
  }

  const selectedTab = view.name === 'model' ? 'browse' : view.name === 'project' ? 'projects' : view.name;
  const moreTab = TABS.find(([name, , more]) => more && name === selectedTab)?.[0];

  return (
    <div class="wrap" style={vars}>
      {updated && (
        <div class="msg update-ready" role="status">
          <p>The plugin on this printer was updated. Reload to use the new version.</p>
          <button class="btn sm" type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      {status.linked && view.name !== 'share' && (
        <ShareBanner canShare={!!status.account?.can_share} onOpen={() => setView({ name: 'share' })} />
      )}
      {status.update_required && (
        // Say it plainly and point at the host's own update manager,
        // which is where a Klipper user already updates everything else. Reading
        // still works; actions the API has dropped fail with their own message.
        <div class="msg warn" style="margin-bottom:14px;text-align:left">
          <p>
            <strong>Update available.</strong> CommunityCAD now needs Hopper{' '}
            {status.min_plugin_version} or newer; this printer has{' '}
            {status.component_version}. Update through Mainsail or Fluidd.
          </p>
        </div>
      )}
      {view.name !== 'connect' && (
        <nav class="topnav" aria-label="Hopper">
          {TABS.map(([name, label, more]) => (
            <button
              key={name} class={`tab${more ? ' tab-more-item' : ''}`} type="button"
              aria-selected={selectedTab === name}
              onClick={() => setView({ name } as View)}
            >
              {label}
            </button>
          ))}
          {/* Phones: the last tabs move behind More, as in Bambu Handy. */}
          <span class={`tab-more${moreTab ? ' active' : ''}`}>
            <Menu label="More tabs" open={moreOpen} onOpen={() => setMoreOpen(true)} onClose={() => setMoreOpen(false)}
              button={<>More ▾</>}>
              {TABS.filter(([, , more]) => more).map(([name, label]) => (
                <button key={name} class="menu-item" role="menuitem" type="button"
                  aria-current={selectedTab === name ? 'page' : undefined}
                  onClick={() => { setMoreOpen(false); setView({ name } as View); }}>
                  {label}
                </button>
              ))}
            </Menu>
          </span>
        </nav>
      )}

      {view.name === 'about' && <About status={status} version={version} hostName={hostName} />}
      {view.name === 'share' && <Share status={status} onStatus={refresh} />}

      {view.name === 'models' && (
        <Models
          onBrowse={() => setView({ name: 'browse' })}
          onSlice={async (names) => {
            // Slice always starts a new project; several selected models share one.
            const { project } = await createProject(names.map((model) => ({ model, copies: 1 })));
            setView({ name: 'project', project });
          }}
        />
      )}

      {view.name === 'projects' && (
        <Projects
          onOpen={(project) => setView({ name: 'project', project })}
          onModels={() => setView({ name: 'models' })}
        />
      )}

      {view.name === 'project' && (
        <ProjectView
          project={view.project}
          onBack={() => setView({ name: 'projects' })}
          onChanged={(project) => setView({ name: 'project', project })}
          toolpathsUrl={toolpathsFor(hostName)}
          bed={status.build_volume}
          sendFolder={status.send_folder ?? 'communitycad'}
          onShare={status.linked ? () => setView({ name: 'share' }) : undefined}
        />
      )}

      {(view.name === 'browse' || view.name === 'model') && (
        // Kept mounted while a model is open: Back returns to the same search,
        // results and scroll position instead of a fresh, empty Browse.
        <div hidden={view.name === 'model'}>
          <Browse
            volume={volume}
            defaultTab={status.default_tab}
            defaultFileType={status.file_type ?? ''}
            canAllow={status.permissions?.printer_settings !== true}
            onAllowed={refresh}
            onSettings={() => setView({ name: 'settings' })}
            linked={status.linked}
            onOpenProject={(project) => setView({ name: 'project', project })}
            onOpen={(id) => {
              browseScroll.current = window.scrollY;
              setView({ name: 'model', id });
              window.scrollTo(0, 0);
            }}
            onReconnect={() => {
              refresh();
              setView({ name: 'connect' });
            }}
          />
          <div class="more">
            {!status.linked && (
              <button class="btn" type="button" onClick={() => setView({ name: 'connect' })}>
                Connect your account
              </button>
            )}
          </div>
        </div>
      )}

      {view.name === 'model' && (
        <ModelDetailView
          id={view.id}
          volume={volume}
          linked={status.linked}
          onBack={() => {
            setView({ name: 'browse' });
            // After Browse is shown again, back to where the user was in it.
            requestAnimationFrame(() => window.scrollTo(0, browseScroll.current));
          }}
          onConnect={() => setView({ name: 'connect' })}
          onModels={() => setView({ name: 'models' })}
          onOpenProject={(project) => setView({ name: 'project', project })}
        />
      )}

      {view.name === 'connect' && (
        <Connect
          status={status}
          onLinked={() => {
            refresh();
            notifyRefresh();
          }}
          onBack={() => setView({ name: 'browse' })}
        />
      )}

      {view.name === 'settings' && (
        <>
          <Settings
            status={status}
            onSaved={() => {
              refresh();
              notifyRefresh();
            }}
            onConnect={() => setView({ name: 'connect' })}
          />
        </>
      )}

      <div class="sub" style="margin-top:20px;text-align:center">
        inject {version}
      </div>
    </div>
  );
}
