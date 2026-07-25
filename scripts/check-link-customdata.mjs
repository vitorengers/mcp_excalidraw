#!/usr/bin/env node
/**
 * Regression check for `link` and `customData` on the element API.
 *
 * Both are standard Excalidraw fields and both already survived a frontend sync,
 * which spreads elements unvalidated. The zod schemas, however, omitted them and
 * zod strips unknown keys — so the browser could set them and the API could not.
 * These cases pin the round-trip down.
 *
 * Usage: node scripts/check-link-customdata.mjs [--url http://127.0.0.1:3000]
 */

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg !== -1 && process.argv[urlArg + 1])
  || process.env.EXPRESS_SERVER_URL
  || 'http://127.0.0.1:3000';

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

  console.log('\n1. create aceita e devolve os campos');
  const created = await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 10, y: 10, width: 100, height: 50,
      link: LINK, customData: DOC,
    }),
  });
  const id = created.element.id;
  check('link no create', created.element.link === LINK, `recebeu ${created.element.link}`);
  check('customData no create', created.element.customData?.docKey === 'conectividade');

  console.log('\n2. os campos persistem no store');
  const fetched = (await api(`/api/elements/${id}`)).element;
  check('link persistido', fetched.link === LINK);
  check('customData persistido', fetched.customData?.kind === 'decision');

  console.log('\n3. update altera os campos');
  await api(`/api/elements/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ link: null, customData: { docKey: 'outro', kind: 'note' } }),
  });
  const updated = (await api(`/api/elements/${id}`)).element;
  check('link aceita null', updated.link === null, `recebeu ${updated.link}`);
  check('customData substituido', updated.customData?.docKey === 'outro');

  console.log('\n4. sobrevivem ao sync do frontend');
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
  check('link apos sync', synced.link === LINK);
  check('customData apos sync', synced.customData?.docKey === 'conectividade');

  await api(`/api/elements/${id}`, { method: 'DELETE' });

  if (failures) { console.error(`\n${failures} caso(s) falharam`); process.exit(1); }
  console.log('\ntodos os casos passaram');
}

main().catch((err) => { console.error(`\nerro: ${err.message}`); process.exit(1); });
