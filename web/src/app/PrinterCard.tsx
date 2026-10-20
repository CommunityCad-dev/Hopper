import { useEffect, useState } from 'preact/hooks';

import { getPrinter } from './api';
import type { PrinterInfo } from './types';

/**
 * What the slicer knows about this printer, and where each fact came from: its
 * own printer.cfg. Shown so nothing about slicing is a mystery.
 */
export function PrinterCard() {
  const [state, setState] = useState<{ allowed: boolean; printer: PrinterInfo | null } | null>(null);
  useEffect(() => {
    getPrinter().then(setState).catch(() => setState(null));
  }, []);
  if (!state) return null;
  if (!state.allowed) {
    return <p class="sub">Allow reading this printer's settings (above) and the slicer uses its own limits and start macro.</p>;
  }
  const p = state.printer;
  if (!p) return <p class="sub">Klipper isn't ready, so the printer's settings can't be read right now.</p>;
  const rows: [string, string][] = [
    ['Limits', `${p.max_velocity ?? '?'} mm/s, ${p.max_accel ?? '?'} mm/s²`],
    ['Nozzle', p.nozzle_diameter ? `${p.nozzle_diameter} mm` : 'unknown'],
    ['Heaters', `${p.hotend_max_temp ?? '?'} °C hotend, ${p.bed_max_temp ?? '?'} °C bed`],
    ['Retraction', p.firmware_retraction ? 'firmware ([firmware_retraction])' : 'by the slicer'],
    ['Start', p.start_macro
      ? `${p.start_macro} ${Object.values(p.params).map((v) => `${v}=`).join(' ')}` +
        (p.heats_bed && p.heats_nozzle ? ' (it heats; the slicer only calls it)' : ' (the slicer heats first)')
      : "no start macro found: Orca's default"],
    ['End', p.end_macro ?? "Orca's default"],
    ['Enclosed', p.enclosed ? 'yes (chamber sensor)' : 'no'],
  ];
  return (
    <div class="printer-card">
      <strong>{p.identity.name ?? `Klipper printer (${p.kinematics})`}</strong>
      {p.identity.evidence.length > 0 && (
        <ul class="evidence">{p.identity.evidence.map((e) => <li key={e} class="sub">{e}</li>)}</ul>
      )}
      <ul class="facts">
        {rows.map(([k, v]) => <li key={k}><span>{k}</span><span>{v}</span></li>)}
      </ul>
      <p class="sub">All read from printer.cfg. Change them there and restart Klipper.</p>
      <Facts p={p} />
    </div>
  );
}

/**
 * Facts printer.cfg can't say on its own, added by the owner as macro variables
 *. The plugin shows the lines; it never writes printer.cfg.
 */
function Facts({ p }: { p: PrinterInfo }) {
  const [copied, setCopied] = useState(false);
  const f = p.facts;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(f.add_lines ?? '');
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div class="facts-box">
      <strong>Facts you add</strong>
      <ul class="facts">
        <li><span>Bed surface</span><span>{p.bed_surface.replace(/_/g, ' ')}{p.bed_surface_assumed ? ' (assumed)' : ''}</span></li>
        <li><span>Hotend</span><span>{String(f.facts.hotend ?? 'not set')}</span></li>
        <li><span>Part cooling</span><span>{String(f.facts.part_cooling ?? 'not set')}</span></li>
      </ul>
      {f.problems.map((x) => <p key={x} class="sub" style="color:#f6ad55">{x}</p>)}
      {f.add_lines && (
        <>
          <p class="sub">
            {f.macro_present
              ? <>Add these lines to <code>[gcode_macro _COMMUNITYCAD]</code> in printer.cfg:</>
              : <>Add this to printer.cfg (Mainsail → Machine), save, and restart Klipper:</>}
          </p>
          <pre class="snippet">{f.add_lines}</pre>
          <p class="sub">
            Keep the quotes around text: Klipper won't start with a value it can't read.
          </p>
          <button class="btn ghost sm" type="button" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </>
      )}
    </div>
  );
}
