#!/usr/bin/env node
/**
 * Checks that the committed board and its documentation still agree.
 *
 * A shape carries `customData.docKey`; the panel resolves it to `<docsDir>/<key>.md`. When
 * the two drift — a key renamed, a doc deleted, a board exported from a different project —
 * nothing throws. The panel just says the document is missing, on a board nobody opens every
 * day. This turns that into a failing check.
 *
 * Offline: it reads the board file, not a running server.
 *
 * Usage: node scripts/check-board-docs.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('1. the project declares a board and a docs directory');
const config = JSON.parse(readFileSync(join(repoRoot, 'board.config.json'), 'utf8'));
check('board.config.json names a board', Boolean(config.board), 'no "board" field');
check('board.config.json names a docsDir', Boolean(config.docsDir), 'no "docsDir" field');
if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }

const boardPath = resolve(repoRoot, config.board);
const docsDir = resolve(repoRoot, config.docsDir);

console.log('\n2. the board file is there and parses');
check('the board file exists', existsSync(boardPath), boardPath);
if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }

let scene;
try {
  scene = JSON.parse(readFileSync(boardPath, 'utf8'));
} catch (error) {
  console.error(`  FAIL  the board file is valid JSON — ${error.message}`);
  process.exit(1);
}
check('it is an Excalidraw scene', scene.type === 'excalidraw', `type=${scene.type}`);
check('it has elements', Array.isArray(scene.elements) && scene.elements.length > 0);

console.log('\n3. every docKey on the board resolves to a document');
const keys = [...new Set(
  (scene.elements ?? [])
    .map((element) => element?.customData?.docKey)
    .filter((key) => typeof key === 'string' && key.trim())
)].sort();
check('the board attaches at least one document', keys.length > 0);
for (const key of keys) {
  check(`${key}.md exists`, existsSync(join(docsDir, `${key}.md`)), `expected in ${config.docsDir}/`);
}

console.log('\n4. every card has something behind it');
// A card with no docKey opens an empty panel when it is clicked, which reads as the board
// being broken rather than as that card simply having no more to say. A functional block —
// an issue block, a collapsible image — is exempt: its panel has controls, not a document.
const bare = (scene.elements ?? []).filter((element) =>
  element.type === 'rectangle'
  && !element?.customData?.docKey
  && !element?.customData?.kind);
check('no rectangle is left without a docKey', bare.length === 0,
      `${bare.length} card(s) at ${bare.slice(0, 5).map((e) => `(${e.x},${e.y})`).join(' ')}`);

console.log('\n5. no volatile server metadata was committed');
const volatile = ['syncedAt', 'source', 'syncTimestamp', 'createdAt', 'updatedAt'];
const dirty = (scene.elements ?? []).filter((element) =>
  volatile.some((field) => field in element));
check('elements carry no per-export bookkeeping', dirty.length === 0,
      `${dirty.length} element(s) still have ${volatile.join('/')} — re-run scripts/export-board.mjs`);

console.log('\n6. the shipped library can produce a functional block');
// Adding an issue block from inside the canvas is only possible through the library: what
// makes a block functional is customData.kind, and no Excalidraw control sets it. This works
// because restore preserves customData through a library round-trip.
//
// Deliberately not referenced from board.config.json. These blocks belong on every board, so
// EXCALIDRAW_LIBRARY points here — and naming it here as well would serve both sources to this
// board and duplicate every item.
const LIBRARY = 'docs/blocks.excalidrawlib';
const libraryPath = resolve(repoRoot, LIBRARY);
check('the shipped library exists', existsSync(libraryPath), LIBRARY);
check('board.config.json does not also claim it', !config.library,
      'a workspace library plus EXCALIDRAW_LIBRARY duplicates every item');
if (existsSync(libraryPath)) {
  const library = JSON.parse(readFileSync(libraryPath, 'utf8'));
  const items = library.libraryItems ?? [];
  check('it is an Excalidraw library', library.type === 'excalidrawlib', `type=${library.type}`);
  check('every item has elements', items.length > 0 && items.every((item) => item.elements?.length > 0));
  check('an item carries customData.kind = "issue"',
        items.some((item) => item.elements?.some((element) => element?.customData?.kind === 'issue')),
        'dragging in a new issue block would produce an inert shape');
}

const unreferenced = existsSync(docsDir)
  ? readdirSync(docsDir).filter((file) => file.endsWith('.md') && !keys.includes(file.slice(0, -3)))
  : [];
if (unreferenced.length) console.log(`\nnote: ${unreferenced.length} doc(s) no block points at: ${unreferenced.join(', ')}`);

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
