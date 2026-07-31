#!/usr/bin/env node
/**
 * Checks that a mirror card offers its issue URL once, through `customData`.
 *
 * A card used to carry the same URL twice: `customData.issueUrl`, which is what the board
 * reads to open the issue panel, and `element.link`, which nothing in `src/` or
 * `frontend/` reads at all. The second copy was not inert — `element.link` is what
 * Excalidraw's own hyperlink UI keys off, so every selected card grew a popup drawn
 * *above* its own box, covering the cards stacked over it in the column, plus a link
 * badge in its corner. Two copies of a URL, one covered card.
 *
 * So the cases here are: no card carries a link, every card still carries its URL in
 * `customData`, and the title strip — whose link is the only route from the board to the
 * GitHub project, and which is full width so its popup lands over the mirror rather than
 * over a card — keeps hers.
 *
 * Offline: it imports the compiled layout module and lays a board out. No server, no
 * browser, no GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-mirror-card-link.mjs
 *
 * Tier: fast
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

const modulePath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the project board layout is built — dist/core/project-board-layout.js not found');
  console.error('        (run ./node_modules/.bin/tsc)');
  process.exit(1);
}
const { layoutBoard } = await import(pathToFileURL(modulePath).href);

const REPO = 'https://github.com/vitorengers/vibemaxxing';

function card(itemId, number, title, { draggable = true, contentType = 'Issue' } = {}) {
  return {
    itemId,
    contentType,
    number,
    title,
    url: `${REPO}/issues/${number}`,
    state: 'OPEN',
    createdAt: '2026-07-01T00:00:00Z',
    repository: 'vitorengers/vibemaxxing',
    draggable,
  };
}

// Two cards stacked in one column is the shape the defect showed up in: the popup over the
// lower one covers the upper one.
const board = {
  projectId: 'PVT_stub',
  projectTitle: 'mcp_excalidraw',
  projectUrl: 'https://github.com/users/vitorengers/projects/5',
  fieldId: 'PVTSSF_status',
  fieldName: 'Status',
  morePages: false,
  sections: [
    {
      optionId: 'f75ad846',
      name: 'Todo',
      hidden: 0,
      cards: [card('PVTI_a', 118, 'Upper card'), card('PVTI_b', 115, 'Lower card')],
    },
    {
      optionId: '47fc9ee4',
      name: 'In Progress',
      hidden: 0,
      cards: [card('PVTI_c', 116, 'A pull request rides along', { draggable: false, contentType: 'PullRequest' })],
    },
  ],
};

const laid = layoutBoard(board, { x: 0, y: 0 });
const cards = laid.elements.filter((element) => element.customData?.role === 'card');

console.log('1. a card offers its issue URL through customData, and only there');
check('the fixture laid out some cards', cards.length === 3, `got ${cards.length}`);
check('no card carries element.link',
      cards.every((element) => !element.link),
      cards.filter((element) => element.link).map((element) => `${element.id} -> ${element.link}`).join(', '));
check('every card still carries customData.issueUrl',
      cards.every((element) => typeof element.customData?.issueUrl === 'string'
        && element.customData.issueUrl.startsWith(REPO)),
      cards.map((element) => String(element.customData?.issueUrl)).join(', '));
check('and it is the card\'s own issue',
      cards.find((element) => element.customData?.itemId === 'PVTI_b')?.customData?.issueUrl
        === `${REPO}/issues/115`);
check('the locked pull request card is link-free too — locking is not what suppresses the popup',
      cards.find((element) => element.customData?.itemId === 'PVTI_c')?.link == null);

console.log('\n2. a card label carries no link either — the popup keys off any linked element');
const cardIds = new Set(cards.map((element) => element.id));
const labels = laid.elements.filter((element) => cardIds.has(element.containerId));
check('every card has its label', labels.length === cards.length, `got ${labels.length}`);
check('no card label carries element.link', labels.every((element) => !element.link));

console.log('\n3. the title strip keeps its link — the only route from the board to the project');
const title = laid.elements.find((element) => element.customData?.role === 'title');
check('the strip is there', Boolean(title));
check('and it still links to the project', title?.link === board.projectUrl, String(title?.link));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
