#!/usr/bin/env node
/**
 * Regression check for POST /api/elements/sync.
 *
 * The endpoint used to clear the whole store and rewrite it from the payload, so an
 * element the browser had never seen — one created through the API seconds earlier —
 * vanished on the next autosync. These cases pin the reconciling behaviour down.
 *
 * Usage: node scripts/check-sync-reconcile.mjs [--url http://127.0.0.1:3000]
 * Requires a running canvas server. Exits non-zero on the first failed case.
 */

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg !== -1 && process.argv[urlArg + 1])
  || process.env.EXPRESS_SERVER_URL
  || 'http://127.0.0.1:3000';

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
    process.exit(2);
  }

  // 1. The original bug: an API-created element must outlive a sync that omits it.
  console.log('\n1. elemento criado pela API sobrevive a um sync que nao o menciona');
  const created = await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify(shape({ x: 500, y: 500 })),
  });
  const apiId = created.element.id;
  await sync([shape({ id: 'browser-1' })]);
  let ids = await listIds();
  check('elemento da API preservado', ids.has(apiId), `${apiId} sumiu`);
  check('elemento do browser aplicado', ids.has('browser-1'));

  // 2. Deletion still works — but only when stated, never inferred from absence.
  console.log('\n2. delecao explicita remove; ausencia nao remove');
  await sync([shape({ id: 'browser-1', version: 2, isDeleted: true })]);
  ids = await listIds();
  check('tombstone removeu o elemento', !ids.has('browser-1'));
  check('elemento ausente do payload sobreviveu', ids.has(apiId));

  // 3. Concurrency: the newest version wins, not the last request to arrive.
  console.log('\n3. edicao concorrente mantem a versao mais nova');
  await sync([shape({ id: 'race', version: 5, x: 999 })]);
  await sync([shape({ id: 'race', version: 3, x: 111 })]);   // chega depois, mas e antiga
  const race = (await api('/api/elements')).elements.find((e) => e.id === 'race');
  check('versao 5 prevaleceu sobre a 3 que chegou depois', race?.x === 999, `x=${race?.x}`);

  // 4. version must survive: it is what makes the next reconciliation possible.
  console.log('\n4. version nao e sobrescrito para 1');
  check('version preservado', race?.version === 5, `version=${race?.version}`);

  console.log('\nlimpando...');
  await api('/api/elements/clear', { method: 'DELETE' });

  if (failures) {
    console.error(`\n${failures} caso(s) falharam`);
    process.exit(1);
  }
  console.log('\ntodos os casos passaram');
}

main().catch((err) => {
  console.error(`\nerro: ${err.message}`);
  process.exit(1);
});
