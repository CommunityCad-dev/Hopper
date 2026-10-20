/**
 * What the injector needs from a host interface (Mainsail, Fluidd).
 *
 * Every DOM assumption about a host lives in its adapter, never in the injector.
 * Any method may return null when a selector stops matching: the injector degrades
 * (to a floating button, or to doing nothing) and never throws into the host page.
 */
export interface HostAdapter {
  /** Short name, used in log lines. */
  readonly name: string;

  /** Is this page that interface? Cheap, read-only DOM check. */
  detect(): boolean;

  /** Element our view is appended to. */
  findMountPoint(): Element | null;

  /** The nav list our entry is appended to. */
  findNavList(): Element | null;

  /**
   * Build a nav entry that matches the host's own markup, wired to `onActivate`.
   * Returning null means "no usable template found" — the caller falls back.
   */
  createNavItem(navList: Element, onActivate: () => void): Element | null;

  /** Mark our nav entry active, or not. */
  setNavActive(item: Element, on: boolean): void;

  /** The host's page content, hidden while our view is shown. */
  readonly pageContainerSelector: string;

  /**
   * Host-specific global CSS, scoped under `html.<activeClass>`. Used to mute the
   * host's own active-nav highlight while our view owns the screen.
   */
  hostCss(activeClass: string): string;

  /** Ran after our view is shown. Closing a mobile drawer, for example. */
  afterActivate?(): void;

  /** True when a click on this element is the host navigating away from our view. */
  isHostNavigation(target: Element): boolean;

  // --- Dashboard panel (optional) ------------------------------------------
  //
  // A host that has a dashboard can let us add a panel to it. Both hooks are
  // optional: a host that has not implemented them simply gets no panel, and
  // every other part of the plugin is unaffected.

  /**
   * The element our panel should be placed in, or null.
   *
   * Returns null whenever the panel does not belong on screen — the user is on
   * another route, or the dashboard's own markup no longer matches. Null is the
   * normal answer most of the time, not a failure.
   */
  findDashboardSlot?(): Element | null;

  /**
   * An empty container styled as one of the host's own panels, for our content
   * to render into. Null if the host cannot provide one.
   */
  createPanelShell?(): HTMLElement | null;

  /**
   * Base URL of the Moonraker the host is currently talking to, or null for
   * "same origin as this page".
   *
   * Hosts can drive several printers from one page. The page is served by one of
   * them (or by neither), so calling our component at the page's own origin would
   * reach the wrong printer, or none. Null is the right answer for the ordinary
   * single-printer install and whenever the host cannot be read.
   */
  moonrakerBaseUrl?(): string | null;
}
