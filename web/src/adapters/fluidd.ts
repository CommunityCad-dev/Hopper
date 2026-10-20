import type { HostAdapter } from './types';

/**
 * Fluidd adapter.
 *
 * Fluidd is Vue 2 + Vuetify 2 like Mainsail, so the nav technique carries over
 * almost unchanged. Two things differ and are the reason this is not simply the
 * Mainsail adapter with another name:
 *
 *  - Fluidd has no `#page-container`. Its page content is the `.container` inside
 *    `.v-main__wrap`, which is also what distinguishes it from Mainsail.
 *  - Its cards are not `.panel`, so the dashboard-panel hooks are deliberately not
 *    implemented here. They are optional, so Fluidd simply gets no panel rather
 *    than a broken one.
 */

const SELECTORS = {
  app: '#app',
  // Fluidd puts its entries in `.nav-items` inside the drawer -- not a `.v-list`,
  // and the drawer renders as <aside> rather than <nav>. Both differ from Mainsail,
  // and both cost a debugging round to find, so the fallbacks stay.
  navList: [
    '.v-navigation-drawer .nav-items',
    '.v-navigation-drawer .v-list',
    'nav .v-list',
  ],
  // Not `a.v-list-item[href]` as in Mainsail: Fluidd's entries are router links and
  // do not all carry an href.
  navLink: 'a.v-list-item',
  navTitle: '.v-list-item__title',
  navIconPath: 'svg path',
  mainWrap: '.v-main__wrap',
  // Fluidd's routed content. Mainsail's equivalent is #page-container.
  pageContainer: '.v-main__wrap > .container',
  mobileDrawerOpen: 'nav.v-navigation-drawer--is-mobile.v-navigation-drawer--open',
  drawerToggle: 'header button.v-app-bar__nav-icon',
} as const;

/** mdi-cube-outline, same mark as the Mainsail entry. */
const ICON_PATH =
  'M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22' +
  'C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5' +
  'C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18' +
  'L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L6.04,7.5L12,10.85L17.96,7.5L12,4.15' +
  'M5,15.91L11,19.29V12.58L5,9.21V15.91M19,15.91V9.21L13,12.58V19.29L19,15.91Z';

const NAV_ITEM_ID = 'ccad-nav-item';

/** A nav entry we can clone: it has both a label and an icon to reuse. */
function isUsableTemplate(el: Element): boolean {
  return Boolean(
    el.id !== NAV_ITEM_ID &&
      el.querySelector(SELECTORS.navTitle) &&
      el.querySelector(SELECTORS.navIconPath),
  );
}

/**
 * The nav list that actually holds page links.
 *
 * Fluidd renders several `nav` elements, and the first one in the document is empty
 * -- taking `document.querySelector('nav')` finds a drawer with no items in it. So
 * scan every candidate list and pick the first that contains something we could
 * clone, rather than trusting document order.
 */
function findUsableNavList(): Element | null {
  for (const selector of SELECTORS.navList) {
    for (const list of Array.from(document.querySelectorAll(selector))) {
      if (Array.from(list.querySelectorAll(SELECTORS.navLink)).some(isUsableTemplate)) {
        return list;
      }
    }
  }
  // Last resort: whatever element actually holds the entries. This survives a
  // container being renamed, which the selectors above would not.
  const items = Array.from(
    document.querySelectorAll(`.v-navigation-drawer ${SELECTORS.navLink}`),
  ).filter(isUsableTemplate);
  const last = items[items.length - 1];
  return last?.parentElement ?? null;
}

export const fluiddAdapter: HostAdapter = {
  name: 'fluidd',

  pageContainerSelector: SELECTORS.pageContainer,

  detect() {
    // Both interfaces mount on #app and both are Vuetify 2, so neither alone is
    // enough. Fluidd is the one with a routed .container and no #page-container;
    // the Mainsail adapter is tried first and claims the other case.
    return Boolean(
      document.querySelector(SELECTORS.app) &&
        document.querySelector(SELECTORS.pageContainer) &&
        !document.querySelector('#page-container'),
    );
  },

  findMountPoint() {
    return document.querySelector(SELECTORS.mainWrap) ?? document.querySelector('main');
  },

  findNavList() {
    return findUsableNavList();
  },

  createNavItem(navList, onActivate) {
    // Clone a real page link rather than the first one: the list can start with a
    // logo or a printer-name row carrying neither a title nor an icon.
    const candidates = Array.from(navList.querySelectorAll(SELECTORS.navLink))
      .filter(isUsableTemplate);
    const template = candidates[candidates.length - 1];
    if (!template) return null;

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
    link.classList.remove('v-list-item--active');

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
  },

  hostCss(activeClass) {
    // Mute Fluidd's own highlight for the route still underneath our view.
    return (
      `html.${activeClass} nav a.v-list-item--active:not(.ccad-link)::before` +
      `{opacity:0!important}`
    );
  },

  afterActivate() {
    // Same reasoning as Mainsail: Fluidd closes its mobile drawer on route change,
    // and we do not change the route. Only an exact selector matching exactly one
    // element -- never a control picked by position.
    if (!document.querySelector(SELECTORS.mobileDrawerOpen)) return;
    const buttons = document.querySelectorAll<HTMLElement>(SELECTORS.drawerToggle);
    if (buttons.length === 1) buttons[0].click();
  },

  isHostNavigation(target) {
    const anchor = target.closest('nav a');
    return Boolean(anchor && !anchor.closest(`#${NAV_ITEM_ID}`));
  },

  moonrakerBaseUrl() {
    // Fluidd keeps the selected printer's HTTP base in its Vuex store as
    // `config.apiUrl`, already whole (its own file URLs are `${apiUrl}/server/...`),
    // where Mainsail's has to be assembled from socket parts. Host internals, so it
    // is wrapped and falls back to null -- same origin, the right answer for a
    // single-printer install and for any Fluidd we cannot read.
    try {
      const app = document.querySelector(SELECTORS.app) as (HTMLElement & { __vue__?: any }) | null;
      const apiUrl = app?.__vue__?.$store?.state?.config?.apiUrl;
      if (typeof apiUrl !== 'string' || !apiUrl) return null;

      const url = new URL(apiUrl, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      const base = url.origin + url.pathname.replace(/\/+$/, '');

      // Same origin anyway: keep relative URLs, as on Mainsail.
      return base === location.origin ? null : base;
    } catch {
      return null;
    }
  },

  // No dashboard panel: Fluidd's cards are not `.panel`, and guessing at its
  // dashboard grid would risk the page we promise never to break. The hooks are
  // optional, so leaving them out simply means no panel on Fluidd.
};
