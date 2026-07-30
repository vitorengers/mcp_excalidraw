#!/usr/bin/env node
/**
 * Checks that a board can find its documents, and says so when it cannot.
 *
 * Documentation reaches a board in one way: a shape carries `customData.docKey` and
 * `GET /api/docs/:key?workspace=…` serves `<docsDir>/<key>.md`. `docsDir` comes from the
 * project's own `board.config.json`, and a project added through the `+` was given a config
 * containing nothing but `{ name }` — so every document on that board answered 404, and the
 * panel, which threw the body away, reported it as a missing document rather than as a
 * board with no docs directory at all. A project one setting away from working looked like
 * a project whose documents did not exist.
 *
 * So the cases here are about the two answers being different things:
 *
 *   - a project registered with a `docs/` folder gets `docsDir` written for it, from disk,
 *     and its documents resolve straight away;
 *   - a project with no such folder still gets `{ name }` — nothing is invented — and its
 *     404 carries a code a caller can branch on, distinct from the code a missing file gets;
 *   - a project already in the registry is never rewritten: the seeding happens when the
 *     config is created and at no other time, so a config deliberately left without
 *     `docsDir` keeps its mtime;
 *   - a doc key that belongs to the tool rather than to the project — the mirror's
 *     `project-board` — resolves to the document shipped with the tool, on a project that
 *     has never heard of it.
 *
 * Self-contained: it builds throwaway project directories and a registry, starts its own
 * canvas server on a free port and kills it. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-docs-directory.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `docs-directory-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/**
 * A project directory.
 *
 * `docs` decides whether it has a `docs/` folder with a document in it; `config` is written
 * verbatim when given, standing for a project that arrived with one of its own.
 */
function makeProject(name, { docs = null, config = null } = {}) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  if (docs) {
    mkdirSync(join(dir, docs), { recursive: true });
    writeFileSync(join(dir, docs, 'sample-doc.md'), `# ${name} sample\n\nRead from ${docs}.\n`, 'utf8');
  }
  if (config) {
    writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config, null, 2), 'utf8');
  }
  return dir;
}

/** Added through the `+`, and it has documents where a project usually keeps them. */
const withDocsDir = makeProject('with-docs', { docs: 'docs' });
/** Added through the `+`, and it has none. Nothing may be invented for it. */
const withoutDocsDir = makeProject('without-docs');
/** Already registered, config written by hand, deliberately without `docsDir`. */
const alreadyRegistered = makeProject('already-registered', {
  docs: 'docs',
  config: { name: 'Already registered', repo: 'someone/else' },
});

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'registered', path: slash(alreadyRegistered) }],
}, null, 2), 'utf8');

const configOf = (dir) => JSON.parse(readFileSync(join(dir, 'board.config.json'), 'utf8'));

const serverPath = join(repoRoot, 'dist', 'server.js');
const running = [];

function startCanvas(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      // Deliberately unset: the fallback would hide the very defect under test, because a
      // board with no docsDir of its own would quietly serve somebody else's documents.
      EXCALIDRAW_DOCS_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

async function waitForHealth(child, read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${read()}`);
}

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const add = (path) => call('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: slash(path) }) });
const doc = (key, workspace) =>
  call(`/api/docs/${encodeURIComponent(key)}?workspace=${encodeURIComponent(workspace)}`);

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(port);
  await waitForHealth(server.child, server.read);

  console.log('1. a project added with the + that keeps documents gets docsDir written for it');
  const created = await add(withDocsDir);
  check('the project is accepted', created.status === 201,
        `got ${created.status} ${JSON.stringify(created.body)}`);
  const seeded = configOf(withDocsDir);
  check('its config carries docsDir', typeof seeded.docsDir === 'string' && seeded.docsDir.length > 0,
        JSON.stringify(seeded));
  check('and it names the folder that is actually there', seeded.docsDir === 'docs',
        JSON.stringify(seeded));
  check('the name is still written too', seeded.name === 'with-docs', JSON.stringify(seeded));

  const withDocsId = created.body?.workspace?.id;
  check('the new project has an id to ask with', Boolean(withDocsId), JSON.stringify(created.body));

  console.log('\n2. and its documents resolve straight away, with no settings dialog in between');
  const served = await doc('sample-doc', withDocsId ?? '');
  check('200', served.status === 200, `got ${served.status} ${JSON.stringify(served.body)}`);
  check('it is the project\'s own document',
        typeof served.body?.markdown === 'string' && served.body.markdown.includes('with-docs sample'),
        JSON.stringify(served.body?.markdown ?? '').slice(0, 120));

  console.log('\n3. a project with no docs folder has nothing invented for it');
  const bare = await add(withoutDocsDir);
  check('the project is accepted', bare.status === 201,
        `got ${bare.status} ${JSON.stringify(bare.body)}`);
  const bareConfig = configOf(withoutDocsDir);
  check('no docsDir was guessed', bareConfig.docsDir === undefined, JSON.stringify(bareConfig));
  check('but it is still named, so the tab is not born broken', bareConfig.name === 'without-docs',
        JSON.stringify(bareConfig));

  console.log('\n4. the two 404s are different answers, and a caller can tell them apart');
  const bareId = bare.body?.workspace?.id;
  const noDirectory = await doc('sample-doc', bareId ?? '');
  const noFile = await doc('nothing-with-this-name', withDocsId ?? '');
  check('a board with no docs directory answers 404', noDirectory.status === 404,
        `got ${noDirectory.status}`);
  check('a missing file answers 404 too', noFile.status === 404, `got ${noFile.status}`);
  check('the no-directory answer carries a code', typeof noDirectory.body?.code === 'string',
        JSON.stringify(noDirectory.body));
  check('the missing-file answer carries one as well', typeof noFile.body?.code === 'string',
        JSON.stringify(noFile.body));
  check('and the two codes are not the same', noDirectory.body?.code !== noFile.body?.code,
        `both said ${JSON.stringify(noDirectory.body?.code)}`);
  check('the no-directory answer names the setting that fixes it',
        /docsDir/.test(noDirectory.body?.error ?? ''), JSON.stringify(noDirectory.body));
  check('neither leaks content', noDirectory.body?.markdown === undefined && noFile.body?.markdown === undefined);

  console.log('\n5. a project already in the registry is left exactly as it was');
  const before = statSync(join(alreadyRegistered, 'board.config.json')).mtimeMs;
  await call('/api/workspaces');
  await doc('sample-doc', 'registered');
  const again = await add(alreadyRegistered);
  check('registering it a second time is refused', again.status === 409,
        `got ${again.status} ${JSON.stringify(again.body)}`);
  const kept = configOf(alreadyRegistered);
  check('its config still has no docsDir — the seeding is a creation, not a repair',
        kept.docsDir === undefined, JSON.stringify(kept));
  check('and it kept the keys it arrived with', kept.repo === 'someone/else', JSON.stringify(kept));
  check('the file was not written at all',
        statSync(join(alreadyRegistered, 'board.config.json')).mtimeMs === before,
        'the mtime moved');

  console.log('\n6. a block belonging to the tool shows the tool\'s documentation, on any project');
  const mirror = await doc('project-board', withDocsId ?? '');
  check('200 on a project that has never heard of it', mirror.status === 200,
        `got ${mirror.status} ${JSON.stringify(mirror.body)}`);
  check('and it is the mirror\'s own document',
        typeof mirror.body?.markdown === 'string' && /project board mirror/i.test(mirror.body.markdown),
        JSON.stringify(mirror.body?.markdown ?? '').slice(0, 120));
  const mirrorOnBare = await doc('project-board', bareId ?? '');
  check('even on a project with no docs directory of its own', mirrorOnBare.status === 200,
        `got ${mirrorOnBare.status} ${JSON.stringify(mirrorOnBare.body)}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  stopAll();
  await sleep(300);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
