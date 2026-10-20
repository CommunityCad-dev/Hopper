#!/usr/bin/env node
// Bundle budget gate: the injected bundle must stay
// under 200 KB gzipped, because it loads on every page view of the host interface,
// often over a Pi's wifi. Exits non-zero when over, so `npm run build` fails.
//
// Override for a one-off check: BUNDLE_BUDGET_BYTES=123456 npm run build
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(repoRoot, 'web', 'dist', 'inject.js');
const budget = Number(process.env.BUNDLE_BUDGET_BYTES ?? 200 * 1024);

let raw;
try {
  raw = readFileSync(bundle);
} catch {
  console.error(`bundle check: ${bundle} not found — did vite build run?`);
  process.exit(1);
}

const gzipped = gzipSync(raw, { level: 9 }).length;
const pct = ((gzipped / budget) * 100).toFixed(1);
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

console.log(
  `bundle check: ${kib(statSync(bundle).size)} raw, ${kib(gzipped)} gzipped ` +
    `(${pct}% of ${kib(budget)} budget)`,
);

if (gzipped > budget) {
  console.error(`bundle check: FAIL — ${kib(gzipped - budget)} over budget`);
  process.exit(1);
}
