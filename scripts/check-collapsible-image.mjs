#!/usr/bin/env node
/**
 * Checks that a collapsed image survives the round trips that matter.
 *
 * Collapsing rewrites width and height, so the full size has to be stashed before
 * shrinking — otherwise expanding could only guess and the image would come back the
 * wrong shape. These cases pin that down, plus survival through sync and export,
 * since collapse state living only in the browser would be lost on any reload.
 *
 * Self-contained: with no arguments it starts its own canvas on a free port and kills it, so
 * the workspace it writes into is empty because nothing else has ever touched it. Run
 * `./node_modules/.bin/tsc` first. `--url` points the same cases at a board you are already
 * looking at, which is a debugging move rather than the way this is run.
 *
 * Usage: node scripts/check-collapsible-image.mjs [--url http://127.0.0.1:3737]
 *
 * Tier: fast
 */

import { openCanvas, urlOverride } from './lib/spawn-canvas.mjs';

const canvas = await openCanvas({ url: urlOverride(), env: { LOG_LEVEL: 'error' } });
const BASE = canvas.base;

/** Its own board, so a run against a live server cannot draw on the one being looked at. */
const WS = 'collapse-test';
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${glue}workspace=${WS}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  console.log(`canvas: ${BASE}`);

  console.log('\n1. an image collapses and keeps its full size on record');
  const created = await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'image', x: 0, y: 0, width: 400, height: 300, fileId: 'f1' }),
  });
  const id = created.element.id;

  await api(`/api/elements/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      width: 64, height: 48,
      customData: { collapsed: true, fullSize: { width: 400, height: 300 } },
    }),
  });
  let element = (await api(`/api/elements/${id}`)).element;
  check('collapsed height applied', element.height === 48, `height=${element.height}`);
  check('collapsed flag stored', element.customData?.collapsed === true);
  check('full size remembered', element.customData?.fullSize?.width === 400);

  console.log('\n2. collapse state survives a frontend sync');
  await api('/api/elements/sync', {
    method: 'POST',
    body: JSON.stringify({
      elements: [{ ...element, version: (element.version ?? 1) + 5 }],
      timestamp: new Date().toISOString(),
    }),
  });
  element = (await api(`/api/elements/${id}`)).element;
  check('still collapsed after sync', element.customData?.collapsed === true);
  check('full size still there', element.customData?.fullSize?.height === 300);

  console.log('\n3. expanding restores the original size exactly');
  const full = element.customData.fullSize;
  await api(`/api/elements/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      width: full.width, height: full.height,
      customData: { ...element.customData, collapsed: false },
    }),
  });
  element = (await api(`/api/elements/${id}`)).element;
  check('width restored', element.width === 400, `width=${element.width}`);
  check('height restored', element.height === 300, `height=${element.height}`);
  check('no longer collapsed', element.customData?.collapsed === false);

  await api('/api/elements/clear', { method: 'DELETE' });
}

try {
  await main();
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  failures++;
} finally {
  canvas.stop();
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
