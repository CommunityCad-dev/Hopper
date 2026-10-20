import type { BoundingBox, BuildVolume } from './types';

/**
 * Does the model fit the printer?
 *
 * An XY swap is allowed (turning a part 90° on the bed is free),
 * a Z rotation is not (laying it down changes supports and strength, which is the
 * user's call, not ours). Unknown size is `null`, never a guess in either direction.
 */
export function fits(bbox: BoundingBox, volume: BuildVolume | null): boolean | null {
  if (!volume || !volume.fit_filtering) return null;
  const { x, y, z } = bbox;
  if (x == null || y == null || z == null) return null;
  if (z > volume.z) return false;
  return (x <= volume.x && y <= volume.y) || (x <= volume.y && y <= volume.x);
}

/** "180 × 120 × 65 mm", or "≈" when the file never declared its units. */
export function formatSize(bbox: BoundingBox): string | null {
  const { x, y, z } = bbox;
  if (x == null || y == null || z == null) return null;
  const round = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  const prefix = bbox.source === 'assumed_mm' ? '≈ ' : '';
  return `${prefix}${round(x)} × ${round(y)} × ${round(z)} mm`;
}

export function formatBytes(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/**
 * What sending will cost, in one plain line.
 *
 * Downloads are metered, so the user should know before they tap, not after.
 */
export function describeDownloadCost(check: import('./types').DownloadCheck | null): string | null {
  if (!check || !check.linked) return null;
  if (check.allowed === false) {
    const when = check.reset_at ? new Date(check.reset_at) : null;
    const ok = when && !Number.isNaN(when.getTime());
    if (check.reason === 'issue_cap_reached') {
      // A cap on links for one file, not the account's downloads: other files still work.
      const at = ok ? when!.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'tomorrow';
      // Short enough to fit over a phone card's picture, with the time early.
      return `This file's links are used up until ${ok ? at : 'tomorrow'}. Other models still work.`;
    }
    const at = ok ? when!.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'tomorrow';
    return `Daily download limit reached. It resets at ${at}.`;
  }
  if (check.reason === 'own_model') return 'Free: your own model.';
  if (check.would_count === false) return 'Free — already sent to this printer today.';
  const left = check.daily_remaining;
  if (typeof left === 'number') {
    return `Uses 1 of your ${left} remaining download${left === 1 ? '' : 's'} today.`;
  }
  return 'Uses one download.';
}

/** How a printable type reads on a card or a filter chip. */
export function typeLabel(type: string): string {
  return type === 'gcode' ? 'G-code' : type.toUpperCase();
}

/** The file-type filter's choices, in the order they're offered. "" is all types. */
export const FILE_TYPE_CHOICES = ['', 'gcode', '3mf', 'stl', 'obj'] as const;
