/**
 * CommunityCAD injector.
 *
 * Loaded by a plain <script defer> tag that nginx's sub_filter adds to the host
 * interface's index.html. The host's own files are never modified.
 *
 * The one rule this file exists to enforce: **it must never break the host.** Every
 * entry point is wrapped in `guard`, nothing here patches the host's JavaScript, and
 * all of our UI lives inside a Shadow DOM. If a selector stops matching we degrade to
 * a floating button, and if that fails too we do nothing at all.
 */
import { render } from 'preact';

import { App, APP_CSS } from './app/App';
import { currentApiBase, setApiBaseResolver } from './app/api';
import { PANEL_CSS, PanelRoot, notifyRefresh } from './app/DashboardPanel';
import { fluiddAdapter } from './adapters/fluidd';
import { mainsailAdapter } from './adapters/mainsail';
import type { HostAdapter } from './adapters/types';

const VERSION = '0.1.0-dev';

const ACTIVE_CLASS = 'ccad-active';
const HOST_ID = 'ccad-root';
const STYLE_ID = 'ccad-global-style';
const FALLBACK_ID = 'ccad-fallback-button';
const PANEL_ID = 'ccad-panel';

/** How long to wait for the host's sidebar before showing the floating fallback. */
const GIVE_UP_MS = 20_000;

const ADAPTERS: readonly HostAdapter[] = [mainsailAdapter, fluiddAdapter];

interface State {
  active: boolean;
  /** URL our view was opened at; any change means the host navigated away. */
  activeHref: string | null;
  observer: MutationObserver | null;
  startedAt: number;
}

const state: State = { active: false, activeHref: null, observer: null, startedAt: Date.now() };

function log(...args: unknown[]): void {
  try {
    console.debug('[communitycad]', ...args);
  } catch {
    /* a host that has replaced console is not our problem to solve */
  }
}

/** Wrap a function so a throw is logged and swallowed, never propagated to the host. */
function guard<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => {
    try {
      return fn(...args);
    } catch (err) {
      log('suppressed error', err);
      return undefined;
    }
  };
}

function navItem(): Element | null {
  return document.getElementById('ccad-nav-item');
}

/**
 * Global CSS, kept to the minimum that has to live outside the Shadow DOM: showing
 * and hiding our host element, hiding the host's page while our view is up, plus
 * whatever the adapter needs. Everything is keyed on ACTIVE_CLASS, so removing that
 * one class restores the host completely.
 */
function ensureGlobalStyle(adapter: HostAdapter): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    `#${HOST_ID}{display:none}` +
    `html.${ACTIVE_CLASS} #${HOST_ID}{display:block}` +
    `html.${ACTIVE_CLASS} ${adapter.pageContainerSelector}{display:none!important}` +
    adapter.hostCss(ACTIVE_CLASS);
  document.head.appendChild(style);
}

function buildHost(adapter: HostAdapter): Element {
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = APP_CSS;
  shadow.appendChild(style);

  const mount = document.createElement('div');
  shadow.appendChild(mount);
  render(<App version={VERSION} hostName={adapter.name} />, mount);

  return host;
}

/**
 * Put our panel on the host's dashboard, or take it away again.
 *
 * Called on every coalesced tick, so it has to be cheap and idempotent. The host
 * owns that page and re-renders it freely; when it drops our node we put it back on
 * the next tick, exactly as the nav entry works.
 *
 * Every failure here is silent by construction: if the host has no dashboard hooks,
 * or its markup no longer matches, `findDashboardSlot` returns null and no panel
 * appears. The host's own dashboard is never moved, restyled or reordered.
 */
function syncDashboardPanel(adapter: HostAdapter): void {
  const existing = document.getElementById(PANEL_ID);
  const slot = adapter.findDashboardSlot?.() ?? null;

  if (!slot) {
    existing?.remove(); // wrong route, or the dashboard is gone
    return;
  }
  // Still mounted in the right place: nothing to do. Re-rendering every tick would
  // throw away the panel's own state, including a pairing code mid-flow.
  if (existing && existing.parentElement === slot) return;
  existing?.remove();

  const shell = adapter.createPanelShell?.();
  if (!shell) return;
  shell.id = PANEL_ID;

  const shadow = shell.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);
  const mount = document.createElement('div');
  shadow.appendChild(mount);
  render(<PanelRoot onOpenBrowser={() => activate(adapter)} />, mount);

  // First in the column: a pairing code the user has to act on should not be below
  // the fold. We insert and never reorder what the host already put there.
  slot.insertBefore(shell, slot.firstChild);
}

function activate(adapter: HostAdapter): void {
  ensureMounted(adapter);
  state.active = true;
  state.activeHref = location.href;
  document.documentElement.classList.add(ACTIVE_CLASS);
  const item = navItem();
  if (item) adapter.setNavActive(item, true);
  adapter.afterActivate?.();
  // The panel may have linked the printer since this view last loaded.
  notifyRefresh();
}

function deactivate(adapter: HostAdapter): void {
  if (!state.active) return;
  state.active = false;
  state.activeHref = null;
  document.documentElement.classList.remove(ACTIVE_CLASS);
  const item = navItem();
  if (item) adapter.setNavActive(item, false);
}

/**
 * Mount our view and nav entry, or re-mount whichever the host's framework removed
 * in a re-render. Idempotent, and called on every coalesced mutation.
 */
function ensureMounted(adapter: HostAdapter): boolean {
  const mountPoint = adapter.findMountPoint();
  if (!mountPoint) return false;

  ensureGlobalStyle(adapter);

  if (!document.getElementById(HOST_ID)) {
    mountPoint.appendChild(buildHost(adapter));
  }

  const navList = adapter.findNavList();
  if (navList && !navItem()) {
    const item = adapter.createNavItem(navList, () => activate(adapter));
    if (item) {
      navList.appendChild(item);
      if (state.active) adapter.setNavActive(item, true);
    }
  }

  // The nav entry is a foreign node in a framework-managed list. If it's there, drop
  // the fallback; if the sidebar never appears, show the fallback instead.
  syncDashboardPanel(adapter);

  const fallback = document.getElementById(FALLBACK_ID);
  if (navItem()) {
    fallback?.remove();
  } else if (!fallback && Date.now() - state.startedAt > GIVE_UP_MS) {
    mountFallbackButton(adapter);
  }

  return true;
}

/** Last resort: the host's sidebar can no longer be found (a major UI rewrite). */
function mountFallbackButton(adapter: HostAdapter): void {
  const host = document.createElement('div');
  host.id = FALLBACK_ID;
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>button{font:600 13px system-ui,sans-serif;padding:8px 14px;border-radius:18px;' +
    'border:0;background:#2b6cb0;color:#fff;cursor:pointer}</style><button>Hopper</button>';
  shadow.querySelector('button')?.addEventListener(
    'click',
    guard(() => (state.active ? deactivate(adapter) : activate(adapter))),
  );
  document.body.appendChild(host);
  log('sidebar not found, using fallback button');
}

/**
 * How long to keep looking for a host we recognise before giving up entirely.
 *
 * Detection cannot be a one-shot check at DOMContentLoaded: the host is an SPA, so
 * at the moment this script runs the page is a bare `#app` and nothing else. The
 * markers that tell Mainsail from Fluidd apart only exist once Vue has rendered,
 * a second or two later. Checking once and giving up would miss them.
 */
const DETECT_TIMEOUT_MS = 30_000;

let adapter: HostAdapter | null = null;
let stopped = false;
/** Last seen component base, so a printer switch can be noticed. */
let lastApiBase = '';
let pollTimer: number | undefined;

/**
 * How often to re-check which printer the host is talking to.
 *
 * Switching printers changes no DOM we observe -- and while our view is open the
 * host's page is hidden and quiet, so mutation-driven checks can miss it entirely.
 * A light poll is the only reliable signal short of subscribing to the host's store,
 * which is deeper into its internals than we want to reach.
 */
const PRINTER_POLL_MS = 2000;

declare global {
  interface Window {
    __communitycad?: {
      version: string;
      host: string;
      activate: () => void;
      deactivate: () => void;
    };
  }
}

function onDocumentClick(ev: MouseEvent): void {
  if (!adapter || !state.active) return;
  const target = ev.target;
  if (target instanceof Element && adapter.isHostNavigation(target)) deactivate(adapter);
}

function teardown(): void {
  if (stopped) return;
  stopped = true;
  state.observer?.disconnect();
  state.observer = null;
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
  document.removeEventListener('click', onDocumentClick, true);
}

/**
 * Optional deep link: `/?communitycad` opens our view on load.
 *
 * A query parameter rather than a path, because the host owns the path and any
 * route we invented would 404 through its router. The host ignores unknown query
 * parameters, so this is inert to it. We do not rewrite the URL when our view is
 * opened normally: the URL staying put is exactly how we detect the host
 * navigating away.
 */
function wantsDeepLink(): boolean {
  try {
    return new URLSearchParams(location.search).has('communitycad');
  } catch {
    return false;
  }
}

/** Bind to the host, once. */
function bind(found: HostAdapter): void {
  adapter = found;
  // Follow the printer the user is looking at, not the machine serving the page.
  setApiBaseResolver(() => found.moonrakerBaseUrl?.() ?? '');
  lastApiBase = currentApiBase();
  // Restart the fallback-button clock from detection, not from script load, so a
  // host that renders slowly doesn't eat the budget before we have even looked.
  state.startedAt = Date.now();
  window.__communitycad = {
    version: VERSION,
    host: found.name,
    activate: guard(() => activate(found)) as () => void,
    deactivate: guard(() => deactivate(found)) as () => void,
  };
  log('host detected:', found.name, VERSION);
  ensureMounted(found);
  if (wantsDeepLink()) activate(found);
}

const tick = guard((): void => {
  if (stopped) return;

  if (!adapter) {
    const found = ADAPTERS.find((candidate) => candidate.detect());
    if (found) {
      bind(found);
      return;
    }
    // Not a host we recognise yet. Could be a page that has not rendered, or a
    // page that never will be one — a proxied webcam stream, say. Stop looking
    // eventually so we are not observing someone else's DOM forever.
    if (Date.now() - state.startedAt > DETECT_TIMEOUT_MS) {
      teardown();
      log('no supported host found, stopping');
    }
    return;
  }

  // Any host navigation — router link, programmatic push, back/forward — changes
  // the URL. Ours doesn't, so a change means we are no longer the current view.
  if (state.active && location.href !== state.activeHref) deactivate(adapter);

  // The host can switch to a different printer without changing the URL. When it
  // does, everything on screen belongs to the old one — account, build volume, which
  // models fit — so reload rather than leave stale data showing.
  const base = currentApiBase();
  if (base !== lastApiBase) {
    lastApiBase = base;
    log('printer changed, reloading for', base || 'this host');
    notifyRefresh();
  }

  ensureMounted(adapter);
});

// The host mutates the DOM constantly (temperatures, console output), so coalesce
// to at most one check per frame.
let scheduled = false;
const scheduleCheck = guard((): void => {
  if (scheduled || stopped) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    tick();
  });
});

const start = guard((): void => {
  tick(); // fast path: the host may already have rendered

  state.observer = new MutationObserver(scheduleCheck);
  state.observer.observe(document.body, { childList: true, subtree: true });
  pollTimer = window.setInterval(scheduleCheck, PRINTER_POLL_MS);
  document.addEventListener('click', onDocumentClick, true);
  window.addEventListener('popstate', tick);

  // Make sure the fallback and detection-timeout checks run even on a page that
  // never mutates again.
  setTimeout(scheduleCheck, GIVE_UP_MS + 500);
  setTimeout(scheduleCheck, DETECT_TIMEOUT_MS + 500);
});

guard(() => {
  if (window.__communitycad) return; // already injected (double sub_filter, or a reload)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
