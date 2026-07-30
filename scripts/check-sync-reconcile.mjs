#!/usr/bin/env node
/**
 * Regression check for POST /api/elements/sync.
 *
 * The endpoint used to clear the whole store and rewrite it from the payload, so an
 * element the browser had never seen — one created through the API seconds earlier —
 * vanished on the next autosync. These cases pin the reconciling behaviour down.
 *
 * Self-contained: with no arguments it starts its own canvas on a free port and kills it,
 * which is also how the empty board these cases need is guaranteed to be empty. Run
 * `./node_modules/.bin/tsc` first. `--url` points the same cases at a board you are already
 * looking at — it must be an empty one, and the count below still refuses to go on if it is
 * not, because case 1 asserts what survived.
 *
 * Usage: node scripts/check-sync-reconcile.mjs [--url http://127.0.0.1:3737]
 *
 * Tier: fast
 */

import { openCanvas, urlOverride } from './lib/spawn-canvas.mjs';

const canvas = await openCanvas({ url: urlOverride(), env: { LOG_LEVEL: 'error' } });
const BASE = canvas.base;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const sync = (elements) =>
  api('/api/elements/sync', {
    method: 'POST',
    body: JSON.stringify({ elements, timestamp: new Date().toISOString() }),
  });

const listIds = async () => new Set((await api('/api/elements')).elements.map((e) => e.id));

function shape(overrides = {}) {
  return {
    type: 'rectangle', x: 0, y: 0, width: 10, height: 10,
    version: 1, versionNonce: 1000, isDeleted: false,
    ...overrides,
  };
}

async function main() {
  console.log(`canvas: ${BASE}`);
  const before = (await api('/api/elements')).elements;
  if (before.length) {
    console.error(`Canvas has ${before.length} element(s). Run against an empty canvas.`);
    canvas.stop();
    process.exit(2);
  }

  // 1. The original bug: an API-created element must outlive a sync that omits it.
  console.log('\n1. an API-created element survives a sync that never mentions it');
  const created = await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify(shape({ x: 500, y: 500 })),
  });
  const apiId = created.element.id;
  await sync([shape({ id: 'browser-1' })]);
  let ids = await listIds();
  check('the API element was kept', ids.has(apiId), `${apiId} vanished`);
  check('the browser element was applied', ids.has('browser-1'));

  // 2. Deletion still works — but only when stated, never inferred from absence.
  console.log('\n2. an explicit deletion removes; an absence does not');
  await sync([shape({ id: 'browser-1', version: 2, isDeleted: true })]);
  ids = await listIds();
  check('the tombstone removed the element', !ids.has('browser-1'));
  check('the element missing from the payload survived', ids.has(apiId));

  // 3. Concurrency: the newest version wins, not the last request to arrive.
  console.log('\n3. a concurrent edit keeps the newest version');
  await sync([shape({ id: 'race', version: 5, x: 999 })]);
  await sync([shape({ id: 'race', version: 3, x: 111 })]);   // arrives later, but is older
  const race = (await api('/api/elements')).elements.find((e) => e.id === 'race');
  check('version 5 beat the version 3 that arrived after it', race?.x === 999, `x=${race?.x}`);

  // 4. version must survive: it is what makes the next reconciliation possible.
  console.log('\n4. version is not overwritten with 1');
  check('version was kept', race?.version === 5, `version=${race?.version}`);

  console.log('\ncleaning up...');
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

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
