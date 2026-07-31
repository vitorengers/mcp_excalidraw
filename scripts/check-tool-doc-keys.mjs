#!/usr/bin/env node
/**
 * Checks that every doc key naming a block this server draws resolves against the tool's own
 * `docs/`, whichever board is asking.
 *
 * `TOOL_DOC_KEYS` held exactly one key — `project-board`, the mirror's — and every other key
 * fell through to the project's own `docsDir`. But the tool publishes its documentation in the
 * npm package and draws the same blocks on every board, so a terminal block on a user's project
 * pointed at a `terminal.md` that project has no reason to own, and the card answered 404. The
 * mechanism was already there and was applied to one block out of seven.
 *
 * The set is deliberately an explicit list rather than "anything in the tool's `docs/`": falling
 * through to the tool for any unmatched key would let a project's own `index` or `configuration`
 * key resolve to this repository's, which is the silent wrong answer rather than a 404.
 *
 * Five cases:
 *
 * 1. **The set names the blocks.** The seven documents that describe blocks this server draws
 *    are in it. Asserted by name, because the point of the change is which keys are in the list.
 * 2. **Every key in it ships.** A hand-maintained list is a list somebody extends; a key with no
 *    `docs/<key>.md` behind it turns a card that used to 404 for one reason into one that 404s
 *    for another.
 * 3. **Every key in it resolves from a board that is not this repository**, with the tool's own
 *    bytes — read off disk here and compared, so "some markdown came back" cannot pass for it.
 * 4. **A key the project owns still resolves against the project.** The widening must not have
 *    turned the route into "serve the tool's docs".
 * 5. **The collision rule, enforced.** Where a project holds a file of the same name as a tool
 *    key, the tool's wins — a tool block's documentation is a property of the tool, and a mirror
 *    drawn onto a project that happens to keep its own `project-board.md` must not read that
 *    one. `docs/docs-block.md` states this; here it is checked.
 *
 * `EXCALIDRAW_DOCS_DIR` is set **empty** rather than left unset on purpose: unset now means the
 * tool's own `docs/`, and the fallback would answer every case here whether or not `TOOL_DOC_KEYS`
 * contains anything at all. Empty is how a board says it wants no fallback, which leaves the
 * key set as the only thing that could serve these.
 *
 * Self-contained and offline: its own registry, its own throwaway project, its own canvas on a
 * port the kernel just handed out. No browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-tool-doc-keys.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOOL_DOC_KEYS } from '../dist/core/tool-docs.js';
import { openCanvas, repoRoot } from './lib/spawn-canvas.mjs';

/**
 * The blocks this server draws, and the document behind each.
 *
 * Named here rather than read from the set under test, because the set *is* what changed: a
 * check that took its expectation from the implementation would pass on a set of one.
 */
const BLOCK_DOC_KEYS = [
  'project-board',   // the mirror
  'issue-block',     // the observation block and its agent
  'terminal',        // the terminal block
  'docs-block',      // the card this whole route draws
  'board-sections',  // the section marks and their keys
  'shared-library',  // where the blocks above come from
  'workspaces',      // the project tabs the blocks are drawn on
];

/** A key the project owns and the tool does not. */
const PROJECT_KEY = 'project-note';
/** A key both hold, so the precedence is asked rather than assumed. */
const COLLIDING_KEY = 'terminal';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const slash = (path) => path.replace(/\\/g, '/');
const toolDoc = (key) => join(repoRoot, 'docs', `${key}.md`);

if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
  console.error('dist/server.js is missing — build first: ./node_modules/.bin/tsc');
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'check-tool-doc-keys-'));
const project = join(workDir, 'somebody-elses-project');
const projectDocs = join(project, 'docs');
mkdirSync(projectDocs, { recursive: true });
writeFileSync(join(projectDocs, `${PROJECT_KEY}.md`), '# The project\'s own note\n', 'utf8');
writeFileSync(join(projectDocs, `${COLLIDING_KEY}.md`), '# The project\'s own terminal note\n', 'utf8');

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({ workspaces: [] }, null, 2), 'utf8');

const canvas = await openCanvas({
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_BOARD_STATE: join(workDir, 'state'),
    EXCALIDRAW_STATE_HOME: join(workDir, 'state-home'),
    // Empty rather than unset: unset is the tool's own docs since #313, and the fallback would
    // answer every case below whatever TOOL_DOC_KEYS contained.
    EXCALIDRAW_DOCS_DIR: '',
  },
});

async function call(path, options = {}) {
  const response = await fetch(`${canvas.base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const doc = (key, workspace) =>
  call(`/api/docs/${key}?workspace=${encodeURIComponent(workspace)}`);

try {
  console.log(`canvas: ${canvas.base}`);

  console.log('\n0. a throwaway project, registered the way the + registers one');
  const created = await call('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ path: slash(project) }),
  });
  check('the project is accepted', created.status === 201,
        `got ${created.status} ${JSON.stringify(created.body)}`);
  const board = created.body?.workspace?.id;
  check('it has an id to ask with', Boolean(board), JSON.stringify(created.body));
  const config = existsSync(join(project, 'board.config.json'))
    ? JSON.parse(readFileSync(join(project, 'board.config.json'), 'utf8'))
    : {};
  check('and a docsDir of its own, detected at registration', config.docsDir === 'docs',
        JSON.stringify(config));
  if (!board) throw new Error('without a registered board there is nothing to ask from');

  console.log('\n1. the set names every block this server draws');
  for (const key of BLOCK_DOC_KEYS) {
    check(`TOOL_DOC_KEYS holds "${key}"`, TOOL_DOC_KEYS.has(key),
          'a block whose card reads as undocumented on every board but this repository');
  }

  console.log('\n2. every key in the set is a document this build ships');
  for (const key of TOOL_DOC_KEYS) {
    check(`docs/${key}.md exists`, existsSync(toolDoc(key)),
          'a key in the list with no file behind it 404s wherever it is asked');
  }

  console.log("\n3. and each resolves against the tool's docs from somebody else's board");
  for (const key of TOOL_DOC_KEYS) {
    const served = await doc(key, board);
    check(`${key} answers 200`, served.status === 200,
          `got ${served.status} ${served.body?.code ?? ''} ${served.body?.error ?? ''}`.trim());
    const shipped = existsSync(toolDoc(key)) ? readFileSync(toolDoc(key), 'utf8') : null;
    check(`${key} is the tool's own text`,
          shipped !== null && served.body?.markdown === shipped,
          'the bytes differ from docs/' + key + '.md');
  }

  console.log('\n4. a key the project owns still comes from the project');
  const own = await doc(PROJECT_KEY, board);
  check(`${PROJECT_KEY} answers 200`, own.status === 200,
        `got ${own.status} ${JSON.stringify(own.body)}`);
  check('and it is the project\'s own text',
        /project's own note/i.test(own.body?.markdown ?? ''),
        JSON.stringify(own.body?.markdown ?? '').slice(0, 160));

  console.log('\n5. where both hold the same name, the tool\'s wins');
  const collided = await doc(COLLIDING_KEY, board);
  check(`${COLLIDING_KEY} answers 200`, collided.status === 200,
        `got ${collided.status} ${JSON.stringify(collided.body)}`);
  check('and it is the tool\'s document, not the project\'s copy',
        collided.body?.markdown === readFileSync(toolDoc(COLLIDING_KEY), 'utf8'),
        JSON.stringify(collided.body?.markdown ?? '').slice(0, 160));

  console.log('\n6. the guards the wider set now sits behind still hold');
  for (const key of ['..', '..%2F..%2Fpackage', 'sub%2Fnested', 'a%00b']) {
    const rejected = await doc(key, board);
    check(`rejected ${key}`, rejected.status === 400 || rejected.status === 404,
          `got ${rejected.status}`);
    check(`no content for ${key}`, rejected.body?.markdown === undefined);
  }
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  failures++;
} finally {
  canvas.stop();
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
