#!/usr/bin/env node
/**
 * Checks that a shape standing for an issue shows the state of the work.
 *
 * Until this existed, a block that had produced an issue looked exactly like a block that
 * had not, a card in one column looked exactly like a card in another, and a card being
 * implemented looked exactly like one nobody had touched. The board is about the state of
 * work and state was the one thing it did not draw.
 *
 * Most of it is offline against `dist/`, because that is the point of keeping the mapping
 * pure: appearance authored in a library file and copied thereafter cannot be checked at
 * all, and appearance decided inside a React component can only be checked by driving a
 * browser. What is left for the server half is the one fact that has to come from GitHub —
 * what closed an issue — because the panel cannot hide **Implement / Fix** for a closed
 * issue that `gh` was never asked about.
 *
 * The column fixture is deliberately named `Icebox` / `Underway` / `Shipped`. A card's
 * colour must come from where a section sits, never from what it is called: a board that
 * renames a column, or adds a fourth, gets no edit in this repository.
 *
 * Self-contained: it writes its own `gh` stub, starts its own canvas server on a free port
 * and kills it. Nothing here talks to GitHub.
 * Run `./node_modules/.bin/tsc` first — the offline half reads the compiled modules.
 *
 * Usage: node scripts/check-block-appearance.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * A compiled module, or null with a failure recorded.
 *
 * Null rather than an exit, so a first run against code that has none of this reports
 * every missing piece at once instead of stopping at the first one.
 */
async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    failures++;
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    return null;
  }
  return import(pathToFileURL(modulePath).href);
}

// ─── 1. A block looks like the stage it is in ─────────────────

console.log('1. an issue block\'s appearance follows its state');

const appearance = await importDist(join('core', 'issue-appearance.js'), 'the issue appearance mapping');

if (appearance?.issueBlockAppearance) {
  const draft = appearance.issueBlockAppearance('draft');
  const created = appearance.issueBlockAppearance('created');

  check('a draft block is dashed', draft?.strokeStyle === 'dashed', draft?.strokeStyle);
  check('a created block is solid', created?.strokeStyle === 'solid', created?.strokeStyle);
  check('so the two differ in style', draft?.strokeStyle !== created?.strokeStyle);
  check('and in stroke colour', draft?.strokeColor !== created?.strokeColor,
        `both ${draft?.strokeColor}`);
  check('and in fill', draft?.backgroundColor !== created?.backgroundColor,
        `both ${draft?.backgroundColor}`);

  // "Slightly darker", not a new scheme: the same hue one step down the palette. A hex is
  // darker when every channel is, which is what one step down an Open Color ramp does.
  const darker = (from, to) => {
    const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const [fr, fg, fb] = channels(from);
    const [tr, tg, tb] = channels(to);
    return tr <= fr && tg <= fg && tb <= fb && (tr < fr || tg < fg || tb < fb);
  };
  check('the created stroke is darker, not merely different',
        darker(draft?.strokeColor ?? '#000000', created?.strokeColor ?? '#ffffff'),
        `${draft?.strokeColor} -> ${created?.strokeColor}`);
  check('and so is the created fill',
        darker(draft?.backgroundColor ?? '#000000', created?.backgroundColor ?? '#ffffff'),
        `${draft?.backgroundColor} -> ${created?.backgroundColor}`);

  // The library ships the first stage, and it is the only definition of it. A mapping that
  // disagreed with the library would repaint every block the moment it was selected.
  const library = JSON.parse(
    await (await import('node:fs/promises')).readFile(join(repoRoot, 'docs', 'blocks.excalidrawlib'), 'utf8')
  );
  const shipped = library.libraryItems
    .flatMap((item) => item.elements ?? [])
    .find((element) => element?.customData?.kind === 'issue');
  check('the draft look is the one the library ships',
        shipped?.strokeColor === draft?.strokeColor
        && shipped?.backgroundColor === draft?.backgroundColor
        && shipped?.strokeStyle === draft?.strokeStyle,
        JSON.stringify({ shipped: shipped?.strokeColor, mapped: draft?.strokeColor }));
} else if (appearance) {
  failures++;
  console.error('  FAIL  issueBlockAppearance is exported');
}

// ─── 2. A card looks like the column it is in ─────────────────

console.log('\n2. a mirrored card is filled from its column, without naming one');

const layout = await importDist(join('core', 'project-board-layout.js'), 'the mirror layout');

/** A board whose sections are named nothing a hardcoded column name could match. */
function board(names, cards) {
  return {
    projectId: 'PVT_check',
    projectTitle: 'Appearance check',
    projectUrl: 'https://github.com/users/vitorengers/projects/5',
    fieldId: 'PVTSSF_check',
    fieldName: 'Stage',
    sections: names.map((name, index) => ({
      optionId: `opt-${index}`,
      name,
      cards: cards[index] ?? [],
      hidden: 0,
    })),
    morePages: false,
  };
}

function card(number, { draggable = true } = {}) {
  return {
    itemId: `PVTI_${number}`,
    contentType: 'Issue',
    number,
    title: `Issue number ${number}`,
    url: `https://github.com/vitorengers/vibemaxxing/issues/${number}`,
    state: 'OPEN',
    createdAt: '2026-07-01T00:00:00Z',
    repository: 'vitorengers/vibemaxxing',
    draggable,
  };
}

const cardsOf = (result) =>
  result.elements.filter((element) => element.customData?.role === 'card');

if (layout?.layoutBoard) {
  const NAMES = ['Icebox', 'Underway', 'Shipped'];
  const drawn = layout.layoutBoard(
    board(NAMES, [[card(1)], [card(2)], [card(3)]]),
    { x: 0, y: 0 }
  );
  const [first, second, third] = cardsOf(drawn);

  check('every column produced a card', Boolean(first && second && third),
        `${cardsOf(drawn).length} cards`);
  check('the first two columns fill their cards differently',
        first?.backgroundColor !== second?.backgroundColor,
        `both ${first?.backgroundColor}`);
  check('and so do the second and the third',
        second?.backgroundColor !== third?.backgroundColor,
        `both ${second?.backgroundColor}`);
  check('so all three differ',
        new Set([first, second, third].map((element) => element?.backgroundColor)).size === 3,
        JSON.stringify([first, second, third].map((element) => element?.backgroundColor)));

  // The fill has to follow the position, not the name. Rename every section and the same
  // cards must come back the same colour, or something is keying on a string.
  const renamed = layout.layoutBoard(
    board(['Someday', 'Cooking', 'Landed'], [[card(1)], [card(2)], [card(3)]]),
    { x: 0, y: 0 }
  );
  const renamedCards = cardsOf(renamed);
  check('renaming the columns changes nothing',
        renamedCards.every((element, index) =>
          element.backgroundColor === cardsOf(drawn)[index]?.backgroundColor),
        JSON.stringify(renamedCards.map((element) => element.backgroundColor)));

  // A fourth option added on GitHub is a fourth section on the next poll. It must get a
  // colour rather than an exception or a repeat of its neighbour.
  const four = layout.layoutBoard(
    board([...NAMES, 'Parked'], [[card(1)], [card(2)], [card(3)], [card(4)]]),
    { x: 0, y: 0 }
  );
  const fourth = cardsOf(four)[3];
  check('a fourth column gets a fill of its own',
        Boolean(fourth) && fourth.backgroundColor !== third?.backgroundColor,
        `${fourth?.backgroundColor} vs ${third?.backgroundColor}`);

  console.log('\n3. a card being implemented is told apart from one that is not');

  const IMPLEMENTED = card(2).url;
  const withRun = layout.layoutBoard(
    board(NAMES, [[], [card(2), card(5)], []]),
    { x: 0, y: 0 },
    { implementing: { [IMPLEMENTED]: 'running' } }
  );
  const [running, idle] = cardsOf(withRun);

  check('both cards are in the same section',
        running?.customData?.sectionOptionId === idle?.customData?.sectionOptionId,
        `${running?.customData?.sectionOptionId} vs ${idle?.customData?.sectionOptionId}`);
  check('and they are still filled the same, because the column is the same',
        running?.backgroundColor === idle?.backgroundColor,
        `${running?.backgroundColor} vs ${idle?.backgroundColor}`);
  check('but the one with a run in flight is drawn differently',
        running?.strokeWidth !== idle?.strokeWidth || running?.strokeStyle !== idle?.strokeStyle,
        JSON.stringify({
          running: { strokeWidth: running?.strokeWidth, strokeStyle: running?.strokeStyle },
          idle: { strokeWidth: idle?.strokeWidth, strokeStyle: idle?.strokeStyle },
        }));

  // Implementing and implemented are different facts, and a card that says only "not idle"
  // would collapse them.
  const withDone = layout.layoutBoard(
    board(NAMES, [[], [card(2), card(5)], []]),
    { x: 0, y: 0 },
    { implementing: { [IMPLEMENTED]: 'done' } }
  );
  const finished = cardsOf(withDone)[0];
  check('a finished implementation differs from one nobody started',
        finished?.strokeWidth !== idle?.strokeWidth || finished?.strokeStyle !== idle?.strokeStyle,
        JSON.stringify({ finished: finished?.strokeWidth, idle: idle?.strokeWidth }));
  check('and from one still running',
        finished?.strokeStyle !== running?.strokeStyle || finished?.strokeWidth !== running?.strokeWidth,
        JSON.stringify({ finished: finished?.strokeStyle, running: running?.strokeStyle }));

  // The column is what fills a card; a run must not repaint it into another column's colour.
  check('a run does not move a card into another column\'s colour',
        running?.backgroundColor === second?.backgroundColor,
        `${running?.backgroundColor} vs ${second?.backgroundColor}`);
}

// ─── 4. A closed issue offers nothing to implement ────────────

console.log('\n4. the panel\'s controls follow the issue, not only the run record');

if (appearance?.offersImplement) {
  check('an open issue nobody started can be implemented',
        appearance.offersImplement({ githubState: 'OPEN', implementState: null }));
  check('an issue with a run in flight cannot be started again',
        !appearance.offersImplement({ githubState: 'OPEN', implementState: 'running' }));
  check('nor can one that already produced a pull request',
        !appearance.offersImplement({ githubState: 'OPEN', implementState: 'done' }));
  check('a run that failed can be tried again',
        appearance.offersImplement({ githubState: 'OPEN', implementState: 'failed' }));
  check('a closed issue offers nothing, whatever the record says',
        !appearance.offersImplement({ githubState: 'CLOSED', implementState: null })
        && !appearance.offersImplement({ githubState: 'CLOSED', implementState: 'failed' }));
  check('the state is matched however GitHub cases it',
        !appearance.offersImplement({ githubState: 'closed', implementState: null }));
  // Before the read lands there is no state, and a button that vanished while the issue
  // loaded would flicker on every selection.
  check('an unread issue keeps the button it had',
        appearance.offersImplement({ githubState: null, implementState: null }));
} else if (appearance) {
  failures++;
  console.error('  FAIL  offersImplement is exported');
}

if (appearance?.closureView) {
  const PR = { number: 77, url: 'https://github.com/vitorengers/vibemaxxing/pull/77' };
  check('an open issue has no closure to show',
        appearance.closureView({ githubState: 'OPEN', stateReason: null, closedBy: [] }) === null);

  const byPr = appearance.closureView({ githubState: 'CLOSED', stateReason: 'COMPLETED', closedBy: [PR] });
  check('a closed issue names the pull request that closed it',
        byPr?.pullRequests?.[0]?.url === PR.url, JSON.stringify(byPr));
  check('and says nothing else, because the link says it', !byPr?.note, byPr?.note);

  const noPr = appearance.closureView({ githubState: 'CLOSED', stateReason: 'COMPLETED', closedBy: [] });
  check('a closed issue with no pull request says so instead',
        Boolean(noPr) && noPr.pullRequests.length === 0 && Boolean(noPr.note), JSON.stringify(noPr));

  const notPlanned = appearance.closureView({ githubState: 'CLOSED', stateReason: 'NOT_PLANNED', closedBy: [] });
  check('and one closed as not planned says that',
        /not planned/i.test(notPlanned?.note ?? ''), notPlanned?.note);
} else if (appearance) {
  failures++;
  console.error('  FAIL  closureView is exported');
}

// ─── 5. What closed it is asked of gh, not inferred ───────────

const workDir = join(tmpdir(), 'block-appearance-check');
rmSync(workDir, { recursive: true, force: true });
const projectDir = join(workDir, 'appearance');
mkdirSync(projectDir, { recursive: true });

const ISSUE_URL = 'https://github.com/vitorengers/vibemaxxing/issues/54';
const PR_URL = 'https://github.com/vitorengers/vibemaxxing/pull/77';

const registryPath = join(workDir, 'workspaces.json');
const strictStub = join(workDir, 'gh-strict.mjs');
const oldStub = join(workDir, 'gh-old.mjs');

// Answers only a query that actually asked what closed the issue. A reader that still sends
// the old field list gets an error, which is the defect this section is here to catch.
writeFileSync(strictStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
const json = args[args.indexOf('--json') + 1] ?? '';
if (!args.includes('issue') || !args.includes('view')) {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
if (!json.includes('closedByPullRequestsReferences') || !json.includes('stateReason')) {
  process.stderr.write('stub gh: the query did not ask what closed the issue: ' + json + '\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  number: 54,
  title: 'An issue block looks the same at every stage',
  body: 'The body, read live.',
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  closedByPullRequestsReferences: [
    { number: 77, url: '${PR_URL}', title: 'Draw the state of the work' },
  ],
}));
`, 'utf8');

// A gh too old to know the field. It must not take issue reading down with it.
writeFileSync(oldStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
const json = args[args.indexOf('--json') + 1] ?? '';
if (json.includes('closedByPullRequestsReferences')) {
  process.stderr.write('Unknown JSON field: "closedByPullRequestsReferences"\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  number: 54,
  title: 'An issue block looks the same at every stage',
  body: 'The body, read live.',
  state: 'OPEN',
}));
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'appearance', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Appearance Check',
  repo: 'vitorengers/vibemaxxing',
}), 'utf8');

const running = [];

function startCanvas(port, ghStub) {
  const child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
    },
  }).child;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, child, read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the canvas server never answered on ${base}:\n${read()}`);
}

const port = await freePort();

try {
  console.log('\n5. what closed the issue comes from gh');

  const canvas = startCanvas(port, strictStub);
  await waitForHealth(`http://127.0.0.1:${port}`, canvas.child, canvas.read);

  const response = await fetch(
    `http://127.0.0.1:${port}/api/issue?workspace=appearance&url=${encodeURIComponent(ISSUE_URL)}`
  );
  const body = await response.json().catch(() => ({}));
  check('the issue was read', response.status === 200,
        `got ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  check('closed, as GitHub says', body?.issue?.state === 'CLOSED', body?.issue?.state);
  check('with the reason it was closed for', body?.issue?.stateReason === 'COMPLETED',
        body?.issue?.stateReason);
  check('and the pull request that closed it',
        body?.issue?.closedBy?.[0]?.url === PR_URL, JSON.stringify(body?.issue?.closedBy));

  console.log('\n6. a gh that does not know the field still reads the issue');

  const oldPort = await freePort();
  const old = startCanvas(oldPort, oldStub);
  await waitForHealth(`http://127.0.0.1:${oldPort}`, old.child, old.read);

  const oldResponse = await fetch(
    `http://127.0.0.1:${oldPort}/api/issue?workspace=appearance&url=${encodeURIComponent(ISSUE_URL)}`
  );
  const oldBody = await oldResponse.json().catch(() => ({}));
  check('reading still works', oldResponse.status === 200,
        `got ${oldResponse.status} ${JSON.stringify(oldBody).slice(0, 300)}`);
  check('the issue came back', oldBody?.issue?.number === 54, JSON.stringify(oldBody?.issue));
  check('with nothing invented about what closed it',
        Array.isArray(oldBody?.issue?.closedBy) && oldBody.issue.closedBy.length === 0,
        JSON.stringify(oldBody?.issue?.closedBy));
} finally {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
