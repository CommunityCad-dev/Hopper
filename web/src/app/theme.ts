/**
 * Read the host interface's accent colour so the plugin looks like part of it.
 *
 * Vuetify 2 does not expose its theme as CSS variables in Mainsail's build, so the
 * reliable way is to ask the browser: create a throwaway element carrying Vuetify's
 * own `primary--text` class, read the colour it computes, and remove it. Cheap, runs
 * once, and degrades to our own default if the class means nothing on this host.
 */
const FALLBACK = '#2b6cb0';

export function hostAccent(): string {
  try {
    // The probe must live INSIDE the Vuetify app root: Vuetify 2 scopes its theme
    // classes under `.v-application`, so a span on document.body matches nothing and
    // silently yields the fallback.
    const root = document.querySelector('.v-application') || document.getElementById('app');
    if (!root) return FALLBACK;
    const probe = document.createElement('span');
    probe.className = 'primary--text';
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
    root.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    // An unstyled element computes to the inherited colour, usually near-black or
    // near-white. Either means the class did nothing, so prefer our own.
    if (!colour || /^rgba?\(\s*0,\s*0,\s*0/.test(colour) || colour === 'rgb(255, 255, 255)') {
      return FALLBACK;
    }
    return colour;
  } catch {
    return FALLBACK;
  }
}
