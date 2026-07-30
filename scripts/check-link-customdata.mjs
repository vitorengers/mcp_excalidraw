#!/usr/bin/env node
/**
 * Regression check for `link` and `customData` on the element API.
 *
 * Both are standard Excalidraw fields and both already survived a frontend sync,
 * which spreads elements unvalidated. The zod schemas, however, omitted them and
 * zod strips unknown keys — so the browser could set them and the API could not.
 * These cases pin the round-trip down.
 *
 * Self-contained: with no arguments it starts its own canvas on a free port and kills it.
 * Run `./node_modules/.bin/tsc` first. `--url` points the same cases at a board you are
 * already looking at, which is a debugging move rather than the way this is run.
 *
 * Usage: node scripts/check-link-customdata.mjs [--url http://127.0.0.1:3737]
 *
 * Tier: fast
 */

import { openCanvas, urlOverride } from './lib/spawn-canvas.mjs';

const canvas = await openCanvas({ url: urlOverride(), env: { LOG_LEVEL: 'error' } });
const BASE = canvas.base;

const LINK = 'https://github.com/vitorengers/FicaAI/blob/main/docs/decisoes/conectividade.md';
const DOC = { docKey: 'conectividade', kind: 'decision' };

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
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

async function main() {
  console.log(`canvas: ${BASE}`);

  console.log('\n1. create accepts both fields and gives them back');
  const created = await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 10, y: 10, width: 100, height: 50,
      link: LINK, customData: DOC,
    }),
  });
  const id = created.element.id;
  check('link on create', created.element.link === LINK, `got ${created.element.link}`);
  check('customData on create', created.element.customData?.docKey === 'conectividade');

  console.log('\n2. the fields survive in the store');
  const fetched = (await api(`/api/elements/${id}`)).element;
  check('link persisted', fetched.link === LINK);
  check('customData persisted', fetched.customData?.kind === 'decision');

  console.log('\n3. update changes them');
  await api(`/api/elements/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ link: null, customData: { docKey: 'outro', kind: 'note' } }),
  });
  const updated = (await api(`/api/elements/${id}`)).element;
  check('link accepts null', updated.link === null, `got ${updated.link}`);
  check('customData replaced', updated.customData?.docKey === 'outro');

  console.log('\n4. and both survive a frontend sync');
  await api('/api/elements/sync', {
    method: 'POST',
    body: JSON.stringify({
      elements: [{
        id, type: 'rectangle', x: 10, y: 10, width: 100, height: 50,
        version: 99, versionNonce: 1, isDeleted: false,
        link: LINK, customData: DOC,
      }],
      timestamp: new Date().toISOString(),
    }),
  });
  const synced = (await api(`/api/elements/${id}`)).element;
  check('link after the sync', synced.link === LINK);
  check('customData after the sync', synced.customData?.docKey === 'conectividade');

  await api(`/api/elements/${id}`, { method: 'DELETE' });
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
