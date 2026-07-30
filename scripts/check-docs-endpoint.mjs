#!/usr/bin/env node
/**
 * Checks for GET /api/docs/:key.
 *
 * The endpoint turns a user-supplied key into a filename, so most of these cases are
 * about refusing to serve anything outside EXCALIDRAW_DOCS_DIR. The server is
 * unauthenticated by design, which makes path traversal here worth pinning down.
 *
 * Self-contained: it writes a throwaway docs directory holding the one document case 1 reads
 * back, starts its own canvas on it and kills it. That directory is the fixture — the cases
 * about escaping it only mean anything against a directory whose contents are known, and the
 * repository's own `docs/` is not that. Run `./node_modules/.bin/tsc` first.
 *
 * `--url` points the same cases at a board you are already looking at, and there the fixture
 * is yours to arrange: that server has to have been started with EXCALIDRAW_DOCS_DIR pointing
 * at a directory containing sample-doc.md.
 *
 * Usage: node scripts/check-docs-endpoint.mjs [--url http://127.0.0.1:3737]
 *
 * Tier: fast
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCanvas, urlOverride } from './lib/spawn-canvas.mjs';

const url = urlOverride();
const workDir = join(tmpdir(), `docs-endpoint-check-${process.pid}`);
// Two levels down, so that `../../package` — the key case 3 asks for — lands on a file that
// genuinely exists. A traversal case pointed at nothing passes whether or not the guard
// works, which is the way a security check quietly stops checking anything.
const docsDir = join(workDir, 'nested', 'docs');

if (!url) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, 'sample-doc.md'), '# Sample\n\nA document to read back.\n', 'utf8');
  writeFileSync(join(workDir, 'package.md'), '# Not this one\n', 'utf8');
}

const canvas = await openCanvas({
  url,
  env: { LOG_LEVEL: 'error', EXCALIDRAW_DOCS_DIR: docsDir },
});
const BASE = canvas.base;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function get(key) {
  // Deliberately unencoded: encoding here would test fetch, not the server.
  const res = await fetch(`${BASE}/api/docs/${key}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log(`canvas: ${BASE}`);

  console.log('\n1. serves an existing doc');
  const ok = await get('sample-doc');
  check('200', ok.status === 200, `got ${ok.status}`);
  check('returns markdown', typeof ok.body.markdown === 'string' && ok.body.markdown.includes('Sample'));
  check('echoes the key', ok.body.key === 'sample-doc');

  console.log('\n2. missing doc is a clean 404, not a crash');
  const missing = await get('does-not-exist');
  check('404', missing.status === 404, `got ${missing.status}`);
  check('no markdown leaked', missing.body.markdown === undefined);

  console.log('\n3. rejects keys that try to escape the docs directory');
  for (const key of ['..%2F..%2Fpackage', '..', 'sub%2Fnested', 'a%00b']) {
    const res = await get(key);
    check(`rejected ${key}`, res.status === 400 || res.status === 404, `got ${res.status}`);
    check(`no content for ${key}`, res.body.markdown === undefined);
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  failures++;
} finally {
  canvas.stop();
  if (!url) rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
