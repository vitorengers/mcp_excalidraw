#!/usr/bin/env node
/**
 * Checks that somebody who has just cloned this repository can get to a board with something
 * on it, by reading only `docs/running.md`.
 *
 * Until #324 they could not. `node dist/server.js` in a fresh clone comes up on the `default`
 * board, which has no project behind it and therefore no `board` file to seed from — a blank
 * Excalidraw canvas, no tabs, no cards, no blocks. The tracked `board.config.json` names
 * `docs/board.excalidraw`, but that field is only ever read for a *registered* workspace, so
 * the one file in the repository that would have filled the canvas was never looked at. And
 * `docs/running.md` said nothing about it: the registry was a row in the variable table, listed
 * as optional like everything else there, with the sole worked example in `docs/workspaces.md`
 * pointing at the maintainer's own directories.
 *
 * So the fix is a procedure written down, and this check is the reader following it. It does
 * not paraphrase the document — it *parses* it:
 *
 *   - the first-run section is found by its heading, and `README.md` has to link that heading;
 *   - the environment variable the section names is read out of the section, and that is the
 *     only `EXCALIDRAW_*` the server is started with;
 *   - the registry the section shows is read out of the section's own JSON block, with the one
 *     `path` in it swapped for this check's throwaway clone.
 *
 * A section rewritten to name a different variable, or to show a different registry shape, is
 * therefore followed rather than failed — and a section that describes a procedure which does
 * not actually produce a board fails, which is the failure mode prose alone cannot have.
 *
 * It asserts the outcome and not the mechanism, deliberately: if the board later grows a
 * zero-config path that registers the working directory by itself, the first-run section
 * becomes shorter and this check still asks the only two questions that matter — is the canvas
 * holding the elements of `docs/board.excalidraw`, and does a documentation card answer 200
 * rather than the `no-docs-dir` 404.
 *
 * The clone is a copy of every tracked file into a throwaway directory, `.git` and all
 * untracked files left behind, which is what a downloaded release is.
 * `check-fresh-clone-config.mjs` is the neighbouring question — what such a copy *points at*
 * once registered; this one asks what it *shows*.
 *
 * Self-contained: throwaway clone, throwaway registry, throwaway state directory, its own
 * canvas server on a port the kernel just handed out, killed at the end. No browser, and
 * nothing here talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-first-run-board.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function stop(reason) {
  console.error(`  FAIL  ${reason}`);
  console.error('\n1 case(s) failed');
  process.exit(1);
}

const slash = (value) => String(value).split('\\').join('/');

/** The anchor GitHub gives a heading, which is what a link from README.md has to spell. */
const anchorOf = (heading) => heading
  .toLowerCase()
  .replace(/[^\w\s-]/g, '')
  .trim()
  .replace(/\s+/g, '-');

// ─── 1. The document states a first-run procedure ─────────────

console.log('1. docs/running.md tells a fresh clone what to do first');

const running = readFileSync(join(repoRoot, 'docs', 'running.md'), 'utf8');

const heading = running.match(/^##[ \t]+(The first run\b.*?)[ \t]*$/m);
if (!heading) {
  stop('docs/running.md has no "## The first run…" section — a fresh clone is still on its own');
}
check('it has a "The first run…" section', true);

const section = running.slice(heading.index + heading[0].length).split(/^##[ \t]+/m)[0];

// Numbered, because it is a procedure: a reader has to be able to tell where they are in it.
const steps = [...section.matchAll(/^\d+\.[ \t]+\S/gm)];
check('the section is numbered steps', steps.length >= 2, `${steps.length} step(s)`);

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const anchor = `docs/running.md#${anchorOf(heading[1])}`;
check('README.md links it', readme.includes(anchor), `no "${anchor}" in README.md`);

// ─── 2. What the section says to do, read out of the section ──

console.log('\n2. and what it says is followed literally, not paraphrased');

const named = [...new Set(
  [...section.matchAll(/`((?:EXCALIDRAW|VIBEMAXXING)_[A-Z0-9_]+)`/g)].map((match) => match[1])
)];
check('it names exactly one setting', named.length === 1, `names ${named.join(', ') || 'none'}`);
if (named.length !== 1) stop('cannot follow a procedure whose environment is ambiguous');
const [settingName] = named;

const block = section.match(/```json\r?\n([\s\S]*?)```/);
if (!block) stop('the section shows no JSON registry for a reader to copy');
check('it shows the registry to write', true);

let registry;
try {
  registry = JSON.parse(block[1]);
} catch (error) {
  stop(`the registry the section shows is not JSON: ${error.message}`);
}
check('the registry has exactly one project in it', Array.isArray(registry?.workspaces) && registry.workspaces.length === 1,
      JSON.stringify(registry?.workspaces ?? null));
if (!Array.isArray(registry?.workspaces) || registry.workspaces.length !== 1) {
  stop('cannot point a one-project example at the clone');
}
check('and that project is named by a path', typeof registry.workspaces[0]?.path === 'string' && registry.workspaces[0].path,
      JSON.stringify(registry.workspaces[0] ?? null));

// ─── 3. The clone ─────────────────────────────────────────────

console.log('\n3. every tracked file copies into a clone of its own');

const workDir = join(tmpdir(), `check-first-run-board-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const cloneDir = join(workDir, 'vibemaxxing');
mkdirSync(cloneDir, { recursive: true });

const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
check('git listed the tracked files', listed.status === 0,
      (listed.stderr || listed.error?.message || '').trim());

for (const path of (listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [])) {
  const from = join(repoRoot, path);
  if (!existsSync(from)) continue;
  const to = join(cloneDir, path);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
check('the clone has a board configuration', existsSync(join(cloneDir, 'board.config.json')));
check('and the board file that configuration names', existsSync(join(cloneDir, 'docs', 'board.excalidraw')));
check('and it is not a git repository', !existsSync(join(cloneDir, '.git')),
      'a downloaded release has no history, and neither does this');

// What the canvas should end up holding: `parseBoardScene` keeps every element with an id
// that is not marked deleted, so that is the set to compare against.
const boardFile = JSON.parse(readFileSync(join(cloneDir, 'docs', 'board.excalidraw'), 'utf8'));
const expected = new Set(
  boardFile.elements
    .filter((element) => element && typeof element.id === 'string' && element.id && !element.isDeleted)
    .map((element) => element.id)
);
check('the clone ships a board with elements on it', expected.size > 0, `${expected.size} element(s)`);

// ─── 4. Following it produces a board ─────────────────────────

console.log('\n4. following it, the canvas comes up holding the board');

const registryPath = join(workDir, 'workspaces.json');
registry.workspaces[0].path = slash(cloneDir);
const workspaceId = (registry.workspaces[0].id ?? 'vibemaxxing').toLowerCase();
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

const canvas = await openCanvas({
  env: {
    // The one thing the section names, and nothing else it does not.
    [settingName]: registryPath,
    // Not part of the procedure: this keeps the check out of the operator's own state
    // directory, where the real board's registry and saved scenes live.
    EXCALIDRAW_STATE_HOME: join(workDir, 'state'),
    LOG_LEVEL: 'error',
  },
});

try {
  check('the canvas took a port the kernel handed out', canvas.port !== 3737, `port ${canvas.port}`);

  const listing = await (await fetch(`${canvas.base}/api/workspaces`)).json().catch(() => ({}));
  const workspace = (listing.workspaces ?? []).find((candidate) => candidate.id === workspaceId);
  check('the clone is the board\'s one project', Boolean(workspace),
        `ids: ${JSON.stringify((listing.workspaces ?? []).map((each) => each.id))}`);
  check('and it loaded without an error', workspace?.error === null ?? false, JSON.stringify(workspace?.error));

  // Seeding is started at `listen` and deliberately not awaited, so the first request can beat
  // the read of a board file off disk. Poll rather than sleep a fixed time.
  let elements = { count: 0, elements: [] };
  for (let attempt = 0; attempt < 100; attempt++) {
    elements = await (await fetch(`${canvas.base}/api/elements?workspace=${workspaceId}`)).json();
    if (elements.count) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  check('the canvas is not empty', elements.count > 0,
        'a fresh clone that followed the document is still looking at a blank canvas');
  const held = new Set((elements.elements ?? []).map((element) => element.id));
  const missing = [...expected].filter((id) => !held.has(id));
  check('it is holding the elements of docs/board.excalidraw', missing.length === 0,
        `${missing.length} of ${expected.size} element(s) missing, e.g. ${missing.slice(0, 3).join(', ')}`);

  console.log('\n5. and its documentation cards answer');

  // A key the tool does not claim for a block it draws, so this resolves through the
  // project's own `docsDir` rather than through the fallback underneath it.
  const response = await fetch(`${canvas.base}/api/docs/running?workspace=${workspaceId}`);
  const doc = await response.json().catch(() => ({}));
  check('GET /api/docs/running answers 200', response.status === 200,
        `${response.status} ${JSON.stringify(doc?.code ?? doc?.error ?? '')}`);
  check('with the clone\'s own copy of the document',
        doc?.markdown === readFileSync(join(cloneDir, 'docs', 'running.md'), 'utf8'),
        'the card is showing something other than the file it names');
} finally {
  canvas.stop();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
