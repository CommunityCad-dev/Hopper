import type { HostAdapter } from './types';

/**
 * Mainsail adapter.
 *
 * Stability: `#app`, `main#content` and `#page-container`
 * are explicit ids in Mainsail's App.vue and have held since v2.0.0. The sidebar hook
 * depends on Vuetify 2 class names and would break on a Vuetify 3 migration — which is
 * why createNavItem returns null rather than throwing, letting the injector fall back
 * to a floating button.
 */

const SELECTORS = {
  app: '#app',
  navList: ['nav.v-navigation-drawer .v-list', 'nav .v-list'],
  navLink: 'a.v-list-item[href]',
  navTitle: '.v-list-item__title',
  navIconPath: 'svg path',
  main: ['main#content', 'main.v-main', 'main'],
  mainWrap: '.v-main__wrap',
  pageContainer: '#page-container',
  mobileDrawerOpen: 'nav.v-navigation-drawer--is-mobile.v-navigation-drawer--open',
  drawerToggle: 'header button.v-app-bar__nav-icon',
  // Dashboard grid. Mainsail lays the dashboard out as #page-container > div >
  // .row > .col-*, with each panel a .v-card.panel inside a column. There are no
  // ids to anchor to, and the only other attributes are data-v-* Vue scoped-style
  // hashes, which change on every Mainsail build.
  dashboardRow: '#page-container .row',
} as const;

/** Mainsail's dashboard is its index route. */
const DASHBOARD_PATH = '/';

/**
 * Classes that make a plain div look like one of Mainsail's own panels.
 *
 * Verified by measurement rather than assumption: a div carrying these computes
 * identically to a real panel — same rgb(30,30,30) background, same 4px radius,
 * same box-shadow. Mainsail's `.panel` styling is global, not Vue-scoped, so we can
 * construct a panel instead of cloning one. That avoids the template-hunting the
 * nav entry needs, and there is nothing to strip.
 */
const PANEL_CLASSES = 'v-card v-sheet theme--dark panel mb-3 mb-md-6';

/** mdi-cube-outline */
const ICON_PATH =
  'M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22' +
  'C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5' +
  'C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18' +
  'L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L6.04,7.5L12,10.85L17.96,7.5L12,4.15' +
  'M5,15.91L11,19.29V12.58L5,9.21V15.91M19,15.91V9.21L13,12.58V19.29L19,15.91Z';

const NAV_ITEM_ID = 'ccad-nav-item';

function firstMatch(selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

export const mainsailAdapter: HostAdapter = {
  name: 'mainsail',

  pageContainerSelector: SELECTORS.pageContainer,

  detect() {
    // #app alone isn't enough: Fluidd mounts on #app too. The Vuetify navigation
    // drawer plus Mainsail's own #page-container is the distinguishing pair.
    return Boolean(
      document.querySelector(SELECTORS.app) && document.querySelector(SELECTORS.pageContainer),
    );
  },

  findMountPoint() {
    const main = firstMatch(SELECTORS.main);
    if (!main) return null;
    return main.querySelector(SELECTORS.mainWrap) ?? main;
  },

  findNavList() {
    return firstMatch(SELECTORS.navList);
  },

  createNavItem(navList, onActivate) {
    // Clone a real page link, not merely the first one: on mobile the list starts
    // with a logo / printer-name row that has neither a title nor an icon.
    const candidates = Array.from(navList.querySelectorAll(SELECTORS.navLink)).filter(
      (a) =>
        a.id !== NAV_ITEM_ID &&
        a.querySelector(SELECTORS.navTitle) &&
        a.querySelector(SELECTORS.navIconPath),
    );
    const template = candidates[candidates.length - 1];
    if (!template) return null;

    // Clone the host's own markup so Vuetify's scoped styles apply. cloneNode does
    // not copy Vue's listeners, so the clone is inert until we wire it up.
    const wrapper = template.parentElement !== navList ? template.parentElement : template;
    if (!wrapper) return null;
    const item = wrapper.cloneNode(true) as Element;
    item.id = NAV_ITEM_ID;

    const link = (item.matches(SELECTORS.navLink) ? item : item.querySelector(SELECTORS.navLink)) as
      | HTMLAnchorElement
      | null;
    if (!link) return null;

    link.classList.add('ccad-link');
    link.setAttribute('href', '#communitycad');
    link.removeAttribute('aria-current');
    link.removeAttribute('router');
    link.classList.remove('v-list-item--active', 'active-nav-item');

    const title = link.querySelector(SELECTORS.navTitle);
    if (title) title.textContent = ' CommunityCAD ';

    const paths = link.querySelectorAll(SELECTORS.navIconPath);
    if (paths.length) {
      paths[0].setAttribute('d', ICON_PATH);
      for (let i = 1; i < paths.length; i++) paths[i].remove();
    }

    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onActivate();
    });

    return item;
  },

  setNavActive(item, on) {
    const link = item.querySelector('a') ?? item;
    link.classList.toggle('v-list-item--active', on);
    link.classList.toggle('active-nav-item', on);
  },

  hostCss(activeClass) {
    // Mainsail keeps its own item highlighted for the route still under our view,
    // so mute it. Cosmetic only — a miss here never breaks anything.
    return (
      `html.${activeClass} nav a.v-list-item--active:not(.ccad-link)::before` +
      `{opacity:0!important}` +
      `html.${activeClass} nav a.active-nav-item:not(.ccad-link)` +
      `{border-right-color:transparent!important;border-right-width:0!important}`
    );
  },

  afterActivate() {
    // Mainsail closes its mobile drawer on route change; we don't change the route.
    // Vuetify 2 ignores synthetic clicks on the overlay scrim (it checks isTrusted),
    // so use the app bar's menu button instead.
    //
    // Exactly this selector, and only when exactly one element matches: EMERGENCY STOP
    // lives in the same header, and must never be clicked by position.
    if (!document.querySelector(SELECTORS.mobileDrawerOpen)) return;
    const buttons = document.querySelectorAll<HTMLElement>(SELECTORS.drawerToggle);
    if (buttons.length === 1) buttons[0].click();
  },

  findDashboardSlot() {
    // Only on the dashboard. Everywhere else the answer is null, and the injector
    // removes the panel.
    if (location.pathname !== DASHBOARD_PATH) return null;
    const row = document.querySelector(SELECTORS.dashboardRow);
    if (!row) return null;
    // First column in DOM order. Mainsail's dashboard layout is user-configurable,
    // so we insert into it and never reorder what is already there.
    const column = Array.from(row.children).find((child) =>
      /(^|\s)col(-|\s|$)/.test(child.className),
    );
    return column ?? null;
  },

  createPanelShell() {
    const shell = document.createElement('div');
    shell.className = PANEL_CLASSES;
    return shell;
  },

  moonrakerBaseUrl() {
    // Mainsail keeps the live connection in its Vuex store, which is reachable
    // through the Vue instance on its mount point. That is host internals, so it is
    // wrapped and falls back to null -- meaning same origin, the right answer for a
    // single-printer install and for any Mainsail we cannot read.
    try {
      const app = document.getElementById('app') as (HTMLElement & { __vue__?: any }) | null;
      const socket = app?.__vue__?.$store?.state?.socket;
      if (!socket?.hostname) return null;

      const secure = location.protocol === 'https:';
      const scheme = socket.protocol === 'wss' || secure ? 'https' : 'http';
      const port = Number(socket.port) || 0;
      const path = typeof socket.path === 'string' ? socket.path.replace(/\/+$/, '') : '';
      const host = port ? `${socket.hostname}:${port}` : String(socket.hostname);
      const base = `${scheme}://${host}${path}`;

      // Same origin anyway: return null so we keep using relative URLs, which avoids
      // a needless cross-origin request in the common case.
      return base === location.origin ? null : base;
    } catch {
      return null;
    }
  },

  isHostNavigation(target) {
    const anchor = target.closest('nav a');
    // Mainsail's own item for the route already showing doesn't change the URL, so
    // the URL watcher won't catch it. Treat the click itself as navigation.
    return Boolean(anchor && !anchor.closest(`#${NAV_ITEM_ID}`));
  },
};
