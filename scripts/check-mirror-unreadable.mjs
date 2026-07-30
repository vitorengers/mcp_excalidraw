#!/usr/bin/env node
/**
 * Checks the strip a mirror draws when its project could not be read.
 *
 * #254: a read that fails draws nothing and says nothing, and on a board where nothing has
 * ever been drawn that is indistinguishable from a board with no `githubProject` at all —
 * #252 lost a mirror to a restart that way and the only trace was a line in the server's log
 * file. The server was never the quiet part: `GET /api/project-board` answers 502 with `gh`'s
 * own message in it. The canvas threw it away.
 *
 * What is arithmetic about the answer is here; what is wiring is in
 * `check-mirror-unreadable-browser.mjs`, which drives a real Chrome across a `gh` that fails,
 * then works, then fails again. The split is `project-board-layout.ts`'s own, and the reason
 * that module exists.
 *
 * The two rules the mirror is built on are the two this has to keep, and both are asked here:
 * every shape it draws is marked derived, which is what keeps it out of the autosync and out
 * of the export; and the strip has to hold its own text, which `board-card-text-must-be-
 * measured` is the standing lesson about — an estimate that wraps late puts the sentence
 * outside the box, and the box is the whole message.
 *
 * Offline and self-contained; it reads the compiled module, so run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-mirror-unreadable.mjs
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const layoutPath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
if (!existsSync(layoutPath)) {
  console.error(`  FAIL  the compiled module exists — ${layoutPath} not found`);
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

const layout = await import(pathToFileURL(layoutPath).href);
const {
  layoutUnreadable,
  UNREADABLE_WIDTH,
  boardWidth,
  layoutBoard,
  MIRROR_KIND,
  MIRROR_DOC_KEY,
} = layout;

if (typeof layoutUnreadable !== 'function') {
  console.error('  FAIL  the mirror can draw a strip for a read that failed');
  console.error('        — project-board-layout.js exports no layoutUnreadable, so a cold');
  console.error('          board still shows nothing at all when gh cannot be reached (#254)');
  process.exit(1);
}

/** The message #252 actually got, and the one this whole issue is named after. */
const GH_MISSING = 'bash: line 1: C:\\Program Files\\GitHub CLI\\gh.exe: command not found';

const ORIGIN = { x: -1440, y: -200 };

const parts = layoutUnreadable(GH_MISSING, ORIGIN);
const strip = parts.find((element) => element.type === 'rectangle');
const words = parts.find((element) => element.type === 'text');

console.log('1. it draws a strip, and the strip says what went wrong');

check('a rectangle and the text bound to it, and nothing else',
      parts.length === 2 && Boolean(strip) && Boolean(words),
      parts.map((element) => element.type).join(', '));
check('the label is bound to the strip rather than merely laid on top of it',
      words?.containerId === strip?.id
      && strip?.boundElements?.[0]?.id === words?.id,
      JSON.stringify({ containerId: words?.containerId, bound: strip?.boundElements }));
check('it carries gh\'s own sentence, not "the read failed"',
      typeof words?.text === 'string' && words.text.replace(/\n/g, ' ').includes(GH_MISSING),
      JSON.stringify(words?.text));
check('and says what it is about, so the sentence is not on its own',
      typeof words?.text === 'string' && /project board/i.test(words.text),
      JSON.stringify(words?.text));
check('it is red, the way the strip a truncated mirror draws is',
      strip?.strokeColor === '#e03131' && words?.strokeColor === '#c92a2a',
      `${strip?.strokeColor} / ${words?.strokeColor}`);

console.log('\n2. it is derived, so it can never reach the store or the export');

check('every shape is marked with the mirror\'s own kind',
      parts.every((element) => element.customData?.kind === MIRROR_KIND),
      JSON.stringify(parts.map((element) => element.customData?.kind)));
check('the strip is locked, so it cannot be dragged out of the region',
      strip?.locked === true && words?.locked === true);
check('it has no link: there is no project behind it to open',
      strip?.link === null || strip?.link === undefined, String(strip?.link));
check('selecting it opens the document that explains the region',
      strip?.customData?.docKey === MIRROR_DOC_KEY, String(strip?.customData?.docKey));
check('and it is told apart from the strip of a board that was read',
      strip?.customData?.unreadable === true, JSON.stringify(strip?.customData));

console.log('\n3. it stands where the region stands, and holds its own text');

check('it starts at the origin it was handed',
      strip?.x === ORIGIN.x && strip?.y === ORIGIN.y, JSON.stringify({ x: strip?.x, y: strip?.y }));
check('it is a whole number of the mirror\'s own columns wide',
      strip?.width === UNREADABLE_WIDTH
      && [1, 2, 3, 4, 5].some((columns) => boardWidth(columns) === UNREADABLE_WIDTH),
      `${strip?.width} vs ${UNREADABLE_WIDTH}`);
check('wide enough that gh\'s sentence is not squeezed onto four lines',
      UNREADABLE_WIDTH >= boardWidth(3), String(UNREADABLE_WIDTH));

const inside = (text, box) => text.x >= box.x - 0.5
  && text.x + text.width <= box.x + box.width + 0.5
  && text.y >= box.y - 0.5
  && text.y + text.height <= box.y + box.height + 0.5;

check('the text sits inside the strip', inside(words, strip),
      JSON.stringify({ text: [words?.x, words?.y, words?.width, words?.height],
                       strip: [strip?.x, strip?.y, strip?.width, strip?.height] }));

console.log('\n4. whatever the reason turns out to be, the strip holds it');

const cases = [
  ['a one-word failure', 'HTTP 502'],
  ['the loopback refusal',
   'The project board only reads while the server is bound to loopback.'],
  ['an expired login',
   'gh: To get started with GitHub CLI, please run: gh auth login. '
   + 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API '
   + 'authentication token.'],
  ['a token without the project scope',
   'your token has not been granted the required scopes to execute this query. '
   + 'The \'id\' field requires one of the following scopes: [\'read:project\'], but your '
   + 'token has only been granted the: [\'gist\', \'read:org\', \'repo\'] scopes.'],
  ['a reason the width of a stack trace', 'x'.repeat(4000)],
];

for (const [name, reason] of cases) {
  const drawn = layoutUnreadable(reason, ORIGIN);
  const box = drawn.find((element) => element.type === 'rectangle');
  const label = drawn.find((element) => element.type === 'text');
  check(`${name}: the strip grows to hold it and the text stays inside`,
        inside(label, box) && box.height >= 48,
        JSON.stringify({ height: box?.height, lines: label?.text?.split('\n').length }));
  check(`${name}: the strip keeps the region's width`, box.width === UNREADABLE_WIDTH,
        String(box?.width));
}

const nothing = layoutUnreadable('   ', ORIGIN);
const nothingSaid = nothing.find((element) => element.type === 'text');
check('a failure that gave no reason still says the read failed',
      typeof nothingSaid?.text === 'string' && nothingSaid.text.trim().length > 20,
      JSON.stringify(nothingSaid?.text));

console.log('\n5. it does not collide with the mirror it stands in for');

const board = {
  projectTitle: 'mcp_excalidraw',
  projectUrl: 'https://github.com/users/vitorengers/projects/5',
  fieldName: 'Status',
  sections: [
    { optionId: 'a', name: 'Todo', cards: [], hidden: 0 },
    { optionId: 'b', name: 'In Progress', cards: [], hidden: 0 },
  ],
  morePages: false,
};
const drawnBoard = layoutBoard(board, ORIGIN);
const ids = new Set(drawnBoard.elements.map((element) => element.id));
check('the strip\'s ids are the mirror\'s nowhere else',
      parts.every((element) => !ids.has(element.id)),
      parts.map((element) => element.id).join(', '));

console.log(
  failures === 0
    ? '\nAll good — a mirror whose read fails says so, on its own strip.'
    : `\n${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
