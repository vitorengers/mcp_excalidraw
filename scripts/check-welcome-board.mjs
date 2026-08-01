#!/usr/bin/env node
/**
 * Checks that a project with no board of its own comes up on the welcome board — once.
 *
 * `docs/board.excalidraw` is this repository's own documentation board, and it loads because
 * `board.config.json` names it for this one workspace. Every *other* project got nothing: a
 * config written by the `+` carries a name and possibly a `docsDir` and no `board` at all, so
 * the seed found no file, no saved state and an empty store, and returned. What a reader saw
 * was a blank Excalidraw canvas — nothing explaining the tabs, the blocks or the documentation
 * cards, and `Alt+P` and `Alt+G` doing nothing whatever, because the section keys are declared
 * by board data and there was none.
 *
 * So `docs/welcome.excalidraw` ships with the tool and is seeded for exactly that project. The
 * cases here are the ways that can be wrong:
 *
 *  - **A fresh empty directory comes up holding it.** No config, no documents, nothing.
 *  - **Its documentation cards answer.** Every `docKey` on the board is a key the tool owns
 *    (`TOOL_DOC_KEYS`), so it resolves against the *install* rather than against the project —
 *    which is the only reason a card on somebody else's board can say anything at all. The
 *    second project here carries a `docsDir` of its own with nothing in it, so a 200 is the
 *    tool answering and could not be the project.
 *  - **The keys are bound.** `Alt+P` and `Alt+G` are resolved from the seeded elements through
 *    the same module the frontend uses. The movement they cause is
 *    `scripts/check-board-sections-browser.mjs`; this is the half that says the board declares
 *    anything for it to move to.
 *  - **It happens once.** An edit and a deletion are made, the server is restarted, and the
 *    board comes back as it was left — not as it shipped. This is the case the whole feature
 *    turns on: a seed that ran twice would overwrite somebody's work every start.
 *  - **A project that declares a board it cannot read is left alone.** That is a project with
 *    a board and a problem, and answering it with a welcome board would paper over a broken
 *    path with cards nobody asked for.
 *  - **`default` gets none.** It is not a project somebody registered and has no directory, no
 *    documents and no settings behind it; a welcome board there would be a canvas somebody
 *    opened to draw on, filled with cards about projects they have not added.
 *
 * Section 0 is the artifact rather than the behaviour: the file is tracked (`.gitignore`
 * excludes `*.excalidraw` with one exception, and this needed a second), it is in the tarball
 * (`files` publishes `docs/*.md`, and a board is not a `.md`), and it is a scene that says what
 * the sections below expect to find.
 *
 * Self-contained: throwaway projects in a temp directory, a throwaway registry, its own canvas
 * server on a port the kernel just handed out, started twice and killed. No browser, and
 * nothing here talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-welcome-board.mjs
 *
 * Tier: fast
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WELCOME = 'docs/welcome.excalidraw';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const posix = (value) => value.replace(/\\/g, '/');

// ─── 0. The artifact ──────────────────────────────────────────

console.log('0. the board is a tracked, published file that says what it must');

check(`${WELCOME} is in the repository`, existsSync(join(repoRoot, WELCOME)));

// `git check-ignore` exits 1 when the path is *not* ignored, which is the answer this wants.
const ignored = spawnSync('git', ['check-ignore', WELCOME],
                          { cwd: repoRoot, encoding: 'utf8' });
check('git does not ignore it, despite the *.excalidraw rule', ignored.status !== 0,
      '.gitignore needs an exception of its own for it');

const tracked = spawnSync('git', ['ls-files', '--error-unmatch', WELCOME],
                          { cwd: repoRoot, encoding: 'utf8' });
check('and it is actually tracked', tracked.status === 0, tracked.stderr?.trim());

let packedPaths = [];
try {
  const stdout = execSync('npm pack --dry-run --json --ignore-scripts',
                          { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  packedPaths = (JSON.parse(stdout)[0]?.files ?? []).map((file) => file.path);
} catch (error) {
  check('npm pack --dry-run --json reported a listing', false, error.message);
}
check(`npm pack lists it (${packedPaths.length} entries)`, packedPaths.includes(WELCOME),
      'package.json publishes docs/*.md, and a board file is not one — it needs its own entry');

const shipped = JSON.parse(readFileSync(join(repoRoot, WELCOME), 'utf8'));
const shippedElements = (shipped.elements ?? []).filter((element) => !element.isDeleted);
const customOf = (element) => element?.customData ?? {};

check('it parses as a scene with elements in it', shippedElements.length > 0,
      `${shippedElements.length} element(s)`);

const shippedSections = shippedElements.filter((e) => customOf(e).kind === 'board-section');
check('it declares two sections, claiming KeyP and KeyG',
      shippedSections.length === 2
      && shippedSections.some((e) => customOf(e).hotkeyCode === 'KeyP')
      && shippedSections.some((e) => customOf(e).hotkeyCode === 'KeyG'),
      shippedSections.map((e) => customOf(e).hotkeyCode).join(', '));

check('it carries a block, not only cards',
      shippedElements.some((e) => customOf(e).kind === 'issue'),
      'a board of documentation cards and nothing to press is a diagram of the tool');

const shippedKeys = [...new Set(shippedElements.map((e) => customOf(e).docKey).filter(Boolean))];
check('and at least four documentation cards', shippedKeys.length >= 4, shippedKeys.join(', '));

// The keys have to be the tool's own, or they resolve inside whatever project is on screen —
// where nobody has written any of these documents.
const toolKeysPath = join(repoRoot, 'dist', 'core', 'tool-docs.js');
if (!existsSync(toolKeysPath)) {
  check('dist/core/tool-docs.js is built', false, 'run ./node_modules/.bin/tsc first');
} else {
  const { TOOL_DOC_KEYS } = await import(pathToFileURL(toolKeysPath).href);
  const foreign = shippedKeys.filter((key) => !TOOL_DOC_KEYS.has(key));
  check('every docKey on it is one the tool owns', foreign.length === 0,
        `${foreign.join(', ')} would resolve inside the project on screen`);
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `welcome-board-${process.pid}`);
const registryPath = join(workDir, 'registry.json');
const stateDir = join(workDir, 'registry-state');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** A directory with nothing in it at all: what the `+` is usually pointed at. */
const freshDir = join(workDir, 'fresh');
mkdirSync(freshDir, { recursive: true });

/**
 * A project that keeps documents of its own, and has written none of them.
 *
 * Its `docsDir` is what makes the documentation case mean anything: a key that resolved
 * against the project would 404 here, so a 200 is the tool answering.
 */
const documentedDir = join(workDir, 'documented');
mkdirSync(join(documentedDir, 'docs'), { recursive: true });
writeFileSync(join(documentedDir, 'board.config.json'),
              JSON.stringify({ name: 'Documented', docsDir: 'docs' }, null, 1), 'utf8');

/** A project that declares a board file which is not there. */
const declaredDir = join(workDir, 'declared');
mkdirSync(join(declaredDir, 'docs'), { recursive: true });
writeFileSync(join(declaredDir, 'board.config.json'),
              JSON.stringify({ name: 'Declared', board: 'docs/board.excalidraw' }, null, 1), 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'fresh', path: posix(freshDir) },
    { id: 'documented', path: posix(documentedDir) },
    { id: 'declared', path: posix(declaredDir) },
  ],
}, null, 1), 'utf8');

// ─── The server ───────────────────────────────────────────────

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

let canvas = null;

function startCanvas() {
  canvas = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      // This machine's shell exports it, and a terminal block would add a shape to a board
      // whose element count these cases read.
      EXCALIDRAW_TERMINAL: '',
    },
  });
}

async function stopCanvas() {
  canvas?.stop();
  await sleep(300);
}

async function elementsOf(workspace) {
  const response = await fetch(`${BASE}/api/elements?workspace=${encodeURIComponent(workspace)}`);
  if (!response.ok) throw new Error(`GET /api/elements -> HTTP ${response.status}`);
  const { elements = [] } = await response.json();
  return elements;
}

async function waitForElements(workspace, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (canvas.child.exitCode !== null) {
      throw new Error(`the canvas server exited early:\n${canvas.read()}`);
    }
    try {
      const elements = await elementsOf(workspace);
      if (elements.length) return elements;
    } catch { /* not up yet */
    }
    await sleep(100);
  }
  return [];
}

/** Wait until the board this canvas keeps of a workspace says what the caller is waiting for. */
async function waitForSavedBoard(workspace, holds, attempts = 120) {
  const file = join(stateDir, `${workspace}.excalidraw`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (holds(saved.elements ?? [])) return saved.elements ?? [];
    } catch { /* not written yet, or written half */
    }
    await sleep(100);
  }
  return null;
}

// ─── The cases ────────────────────────────────────────────────

startCanvas();

try {
  console.log('\n1. a project with nothing of its own comes up on the welcome board');

  const fresh = await waitForElements('fresh');
  check('a fresh empty directory has a board with elements on it', fresh.length > 0,
        `got ${fresh.length}:\n${canvas.read()}`);
  check('and it is the welcome board that shipped',
        fresh.length === shippedElements.length,
        `${shippedElements.length} in the file, ${fresh.length} in the store`);

  const ids = new Set(fresh.map((element) => element.id));
  const missing = shippedElements.map((element) => element.id).filter((id) => !ids.has(id));
  check('every element of it arrived', missing.length === 0, missing.slice(0, 5).join(', '));

  const block = fresh.find((element) => customOf(element).kind === 'issue');
  check('the block on it came up as a draft, with something written in it',
        Boolean(block) && block.strokeStyle === 'dashed'
        && fresh.some((element) => element.containerId === block?.id && element.text?.trim()),
        JSON.stringify(block?.customData));

  console.log('\n2. its documentation cards answer, on a project that has none of its own');

  const documented = await waitForElements('documented');
  check('a project with a docsDir of its own is seeded too', documented.length > 0,
        `got ${documented.length}`);

  const keys = [...new Set(documented.map((e) => customOf(e).docKey).filter(Boolean))];
  const unanswered = [];
  for (const key of keys) {
    const response = await fetch(`${BASE}/api/docs/${key}?workspace=documented`);
    if (!response.ok) unanswered.push(`${key} -> HTTP ${response.status}`);
  }
  check(`all ${keys.length} docKeys on the board resolve against the install`,
        keys.length > 0 && unanswered.length === 0, unanswered.join(', '));

  console.log('\n3. the section keys are declared by the board that was seeded');

  const sectionsPath = join(repoRoot, 'dist', 'core', 'board-sections.js');
  if (!existsSync(sectionsPath)) {
    check('dist/core/board-sections.js is built', false, 'run ./node_modules/.bin/tsc first');
  } else {
    const { resolveBoardSectionHotkeys } = await import(pathToFileURL(sectionsPath).href);
    const { bindings, ignored } = resolveBoardSectionHotkeys(fresh);
    const codes = bindings.map((binding) => binding.code);
    check('Alt+P is bound on the seeded board', codes.includes('KeyP'), codes.join(', '));
    check('Alt+G is bound on it too', codes.includes('KeyG'), codes.join(', '));
    check('and no claim on it was refused', ignored.length === 0,
          ignored.map((claim) => `${claim.title}: ${claim.reason}`).join(', '));
  }

  console.log('\n4. a project that declares a board it cannot read is left alone');

  check('a declared board file that is not there leaves that board empty',
        (await elementsOf('declared')).length === 0,
        'the welcome board must not paper over a path that is wrong');
  check('and `default` is not given one either',
        (await elementsOf('default')).length === 0);
  check('the server is still up', canvas.child.exitCode === null);

  console.log('\n5. it is seeded once, and an edit survives the next start');

  const card = fresh.find((element) => customOf(element).docKey);
  const doomed = fresh.find((element) => element.type === 'text' && !element.containerId);

  const edited = await fetch(`${BASE}/api/elements/${card.id}?workspace=fresh`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backgroundColor: '#ffec99' }),
  });
  check('an element on the welcome board can be edited', edited.ok, `HTTP ${edited.status}`);

  const removed = await fetch(`${BASE}/api/elements/${doomed.id}?workspace=fresh`,
                              { method: 'DELETE' });
  check('and one can be deleted', removed.ok, `HTTP ${removed.status}`);

  // The board is written on a one-second debounce, so the restart waits for the file rather
  // than for a duration: killing the child before it lands would test the debounce, not this.
  const saved = await waitForSavedBoard('fresh', (elements) =>
    elements.some((element) => element.id === card.id && element.backgroundColor === '#ffec99')
    && !elements.some((element) => element.id === doomed.id));
  check('the edit reached the board this canvas keeps', saved !== null,
        `nothing matching in ${join(stateDir, 'fresh.excalidraw')}`);

  await stopCanvas();
  startCanvas();

  const again = await waitForElements('fresh');
  const byId = new Map(again.map((element) => [element.id, element]));
  check('the edit is still there after a restart',
        byId.get(card.id)?.backgroundColor === '#ffec99',
        JSON.stringify(byId.get(card.id)?.backgroundColor));
  check('the deleted element did not come back', !byId.has(doomed.id),
        'the welcome board was seeded a second time over what was left');
  check('and nothing else was re-seeded either',
        again.length === shippedElements.length - 1,
        `${shippedElements.length - 1} expected, ${again.length} present`);
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error.message}`);
} finally {
  await stopCanvas();
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
