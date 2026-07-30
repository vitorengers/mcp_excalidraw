#!/usr/bin/env node
/**
 * Checks that `PUT /api/elements/:id` does not come back to the client that sent it.
 *
 * A page that writes one field onto one element already knows what it wrote. Echoing it
 * back tells it nothing — and the echo is not a field, it is the server's *whole* copy of
 * the element, merged over the live one field by field. Through a burst of typing the
 * autosync is a debounce behind, so that copy is the block as it was before it grew, and
 * the echo hands a container its template height back while the label bound to it is twice
 * that. Attaching a screenshot to an issue block is one `PUT`; #190 reports the reader
 * watching their own observation come apart around it.
 *
 * So a socket says who it is when it connects, `?client=<id>`, and a write says who it is
 * in `x-client-id`. Same id, no echo — everyone else still hears it, which is the half that
 * must not be lost: a second browser on the same board has no other way to know.
 *
 * The caller is left able to apply the write itself: the response still carries the updated
 * element, so nothing here asks a client to guess what the server made of its request.
 *
 * Self-contained: it starts its own canvas server on a free port against a throwaway
 * workspace, and kills it. Run `./node_modules/.bin/tsc` first — it runs `dist/server.js`.
 *
 * Usage: node scripts/check-issue-block-typing.mjs
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
  console.error('  FAIL  the compiled server exists — dist/server.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const WORKSPACE = 'echo-check';
const workDir = mkdtempSync(join(tmpdir(), 'check-issue-typing-echo-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
  },
}).child;
children.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

/** One browser on the board, remembering everything it was told. */
async function connect(clientId) {
  const query = `workspace=${WORKSPACE}${clientId ? `&client=${clientId}` : ''}`;
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}?${query}`);
  const seen = [];
  socket.on('message', (raw) => {
    try { seen.push(JSON.parse(raw.toString())); } catch { /* not ours */ }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    seen,
    drain: () => { seen.length = 0; },
    updatesFor: (id) => seen.filter((message) => message.type === 'element_updated'
      && message.element?.id === id),
  };
}

const putElement = (id, body, clientId) => fetch(`${BASE}/api/elements/${id}?workspace=${WORKSPACE}`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    ...(clientId ? { 'x-client-id': clientId } : {}),
  },
  body: JSON.stringify(body),
});

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  const alpha = await connect('alpha');
  const beta = await connect('beta');
  const anonymous = await connect(null);

  // A block to write to. Created over HTTP because what is being checked is the write path,
  // not how it got there.
  const created = await fetch(`${BASE}/api/elements?workspace=${WORKSPACE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 400, height: 140,
      customData: { kind: 'issue', projectBoardDraft: true },
    }),
  });
  const createdBody = await created.json();
  const blockId = createdBody.element?.id;
  check('a block was created to write to', Boolean(blockId), JSON.stringify(createdBody).slice(0, 200));

  await sleep(300);
  alpha.drain(); beta.drain(); anonymous.drain();

  console.log('1. the write does not come back to the client that sent it');

  const echoed = await putElement(blockId, {
    customData: { kind: 'issue', projectBoardDraft: true, issueImages: ['screenshot-1'] },
  }, 'alpha');
  const echoedBody = await echoed.json();
  await sleep(400);

  check('the write succeeded', echoed.ok && echoedBody.success === true,
        JSON.stringify(echoedBody).slice(0, 200));
  check('the sender was not told what it had just written',
        alpha.updatesFor(blockId).length === 0,
        JSON.stringify(alpha.updatesFor(blockId)).slice(0, 300));
  check('the other browser on the board was',
        beta.updatesFor(blockId).length === 1,
        JSON.stringify(beta.updatesFor(blockId)).slice(0, 300));
  check('and so was a client that never named itself',
        anonymous.updatesFor(blockId).length === 1,
        JSON.stringify(anonymous.updatesFor(blockId)).slice(0, 300));
  check('what the others were told is the element as it now stands',
        beta.updatesFor(blockId)[0]?.element?.customData?.issueImages?.[0] === 'screenshot-1',
        JSON.stringify(beta.updatesFor(blockId)[0]?.element?.customData));

  // The sender is not left guessing: the response is the whole updated element, which is
  // what it applies to its own scene in place of the echo it no longer gets.
  check('the sender got the updated element back in the response',
        echoedBody.element?.id === blockId
        && echoedBody.element?.customData?.issueImages?.[0] === 'screenshot-1',
        JSON.stringify(echoedBody.element?.customData));

  console.log('\n2. a write that names nobody still reaches everyone');

  alpha.drain(); beta.drain(); anonymous.drain();
  await putElement(blockId, { height: 220 }, null);
  await sleep(400);

  check('the client that named itself alpha was told', alpha.updatesFor(blockId).length === 1,
        JSON.stringify(alpha.updatesFor(blockId)).slice(0, 200));
  check('so was beta', beta.updatesFor(blockId).length === 1);
  check('so was the client that never named itself', anonymous.updatesFor(blockId).length === 1);

  console.log('\n3. an id no socket answers to excludes nobody');

  alpha.drain(); beta.drain(); anonymous.drain();
  await putElement(blockId, { height: 240 }, 'nobody-here');
  await sleep(400);

  check('every client was told', alpha.updatesFor(blockId).length === 1
        && beta.updatesFor(blockId).length === 1
        && anonymous.updatesFor(blockId).length === 1,
        `alpha ${alpha.updatesFor(blockId).length}, beta ${beta.updatesFor(blockId).length}, `
        + `anonymous ${anonymous.updatesFor(blockId).length}`);

  console.log('\n4. a board of its own is still a board of its own');

  // The exclusion is per socket, not per board: a second board's client shares no id with
  // this one and was never going to be sent this anyway.
  const otherBoard = new WebSocket(`ws://127.0.0.1:${PORT}?workspace=somewhere-else&client=alpha`);
  const otherSeen = [];
  otherBoard.on('message', (raw) => {
    try { otherSeen.push(JSON.parse(raw.toString())); } catch { /* not ours */ }
  });
  await new Promise((resolve, reject) => { otherBoard.once('open', resolve); otherBoard.once('error', reject); });
  await sleep(200);
  otherSeen.length = 0;
  beta.drain();

  await putElement(blockId, { height: 260 }, 'beta');
  await sleep(400);

  check('the board that was written to heard it', anonymous.updatesFor(blockId).length >= 1);
  check('the sender did not', beta.updatesFor(blockId).length === 0,
        JSON.stringify(beta.updatesFor(blockId)).slice(0, 200));
  check('and the other board heard nothing about an element that is not its',
        otherSeen.filter((message) => message.type === 'element_updated').length === 0,
        JSON.stringify(otherSeen.map((message) => message.type)));

  otherBoard.close();
  for (const client of [alpha, beta, anonymous]) client.socket.close();
} catch (error) {
  failures++;
  console.error(`  FAIL  the run finished — ${error.message}`);
} finally {
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(300);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds it */ }
}

console.log(failures === 0
  ? '\nAll checks passed.'
  : `\n${failures} check${failures === 1 ? '' : 's'} failed.`);
process.exit(failures === 0 ? 0 : 1);
