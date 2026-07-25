#!/usr/bin/env node
/**
 * Checks for GET /api/docs/:key.
 *
 * The endpoint turns a user-supplied key into a filename, so most of these cases are
 * about refusing to serve anything outside EXCALIDRAW_DOCS_DIR. The server is
 * unauthenticated by design, which makes path traversal here worth pinning down.
 *
 * Usage: node scripts/check-docs-endpoint.mjs [--url http://127.0.0.1:3000]
 * Expects the server to run with EXCALIDRAW_DOCS_DIR pointing at a directory that
 * contains sample-doc.md.
 */

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg !== -1 && process.argv[urlArg + 1])
  || process.env.EXPRESS_SERVER_URL
  || 'http://127.0.0.1:3000';

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

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

main().catch((err) => { console.error(`\nerror: ${err.message}`); process.exit(1); });
