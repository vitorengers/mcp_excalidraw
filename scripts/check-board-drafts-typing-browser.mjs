#!/usr/bin/env node
/**
 * Checks what typing into a notes block does to the block being typed into.
 *
 * `check-board-drafts-browser.mjs` already types into one (its section 3) and asserts the
 * column reflowed around it: the block grew, the block below moved down by the same amount,
 * no project card moved, nothing overlaps. All geometry. The string it types is never read
 * back and the block's own element is never looked at, so a block that reflowed perfectly
 * while flickering — or while losing a word — passed every case (#132).
 *
 * So this asks the other half of the question, and asks it of the element rather than of the
 * layout:
 *
 * 1. **Nothing else on the canvas is rewritten** while the caret is in a block that has
 *    nothing under it. `relayoutForDrafts` runs from Excalidraw's `onChange`, so it runs on
 *    every keystroke, and a block growing changes its own height — which used to be reason
 *    enough to hand the whole scene back to `updateScene`. The block under the caret is the
 *    one the relayout leaves where it is, so that pass wrote nothing that had moved, and the
 *    open label editor is subscribed to exactly those updates: each one restyles the live
 *    textarea and refocuses it. That is the flicker, and it is watched here by holding a
 *    reference to elements typing cannot touch — a mirrored card, the column header, the
 *    title strip — and asking afterwards whether they are still the same objects.
 *
 * 2. **The block under the caret is not rebuilt** when the column really does have to
 *    reflow. With a second block below it the relayout has work to do and must still do it
 *    (#55/#62), but the container being typed into used to travel through
 *    `convertToExcalidrawElements` along with everything else, which deep-clones it and
 *    re-measures its bound label. Excalidraw never replaces a container while its label is
 *    being edited — it mutates it in place — so a container that is a different object after
 *    a keystroke was replaced by us and by nobody else.
 *
 * Both cases also read the text back: `originalText` has to be, character for character,
 * what was typed, sampled between keystrokes rather than only at the end, and the label has
 * to stay inside its container's box, and the editor has to still be open.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes a stub `gh`, starts its own canvas server against a
 * throwaway workspace, and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-board-drafts-typing-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome();

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

if (!existsSync(join(repoRoot, 'dist', 'core', 'project-board-types.js'))) {
  console.error('  FAIL  the compiled server exists — dist/core/project-board-types.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── A project to mirror ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-drafts-typing-'));
const projectDir = join(workDir, 'typing-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

/**
 * Two columns and one card, which is as much board as this needs.
 *
 * The card is here to be watched rather than to be read: it is in a column of the project's
 * own, so no amount of typing in the notes column can move it, and an element that has not
 * moved and has still been replaced was replaced by a redraw. The notes column's id and name
 * come from the compiled module that reserves them, so a check that agreed with the code only
 * by being typed the same way could not pass.
 */
const notesModule = await import(pathToFileURL(
  join(repoRoot, 'dist', 'core', 'project-board-types.js')
).href);
const NOTES = { id: notesModule.NOTES_OPTION_ID, name: notesModule.NOTES_NAME };
const TODO = { id: 'f75ad846', name: 'Todo' };
const DONE = { id: '98236657', name: 'Done' };

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DONE] },
    items: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'PVTI_a',
      type: 'ISSUE',
      fieldValueByName: { optionId: TODO.id, name: TODO.name },
      content: {
        __typename: 'Issue',
        number: 3,
        title: 'Something already on the board',
        url: 'https://github.com/vitorengers/mcp_excalidraw/issues/3',
        createdAt: '2026-07-01T10:00:00Z',
        state: 'OPEN',
        repository: { nameWithOwner: 'vitorengers/mcp_excalidraw' },
      },
    }] },
  } } },
}), 'utf8');

writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'typing-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Typing Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
    // The `+` drops a block *from the library*; with an empty library every click is a
    // silent no-op and the check would fail on its own harness rather than on the feature.
    EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
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

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

async function attach() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  }, 'a Chrome page target');
  socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiting = message.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
}

async function click(x, y, clickCount = 1) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  await sleep(150);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(35);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** The imperative API, through the container's React fibre. See `check-board-drafts-browser.mjs`. */
const GRAB_API = `(() => {
  const host = document.querySelector('.excalidraw-container') || document.querySelector('.excalidraw');
  if (!host) return false;
  const key = Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
  if (!key) return false;
  let node = host[key];
  for (let up = 0; up < 60 && node; up++) {
    let state = node.memoizedState;
    for (let along = 0; along < 40 && state; along++) {
      const value = state.memoizedState;
      if (value && typeof value === 'object'
          && typeof value.getSceneElements === 'function' && typeof value.updateScene === 'function') {
        window.__typingCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The scene, with the label of every draft read back beside the block it is bound to.
 *
 * `originalText` and not `text`: the second is the wrapped copy the renderer draws, with
 * newlines put in at the line breaks, and what was typed is the first.
 */
const PROBE = `(() => {
  const api = window.__typingCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { drafts: [], cards: [], labels: {}, add: null };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height });
    }
    if (custom.kind === 'project-board' && custom.role === 'card') {
      out.cards.push({ id: element.id, x: element.x, y: element.y, h: element.height, col: custom.sectionOptionId });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height };
    }
    if (element.type === 'text' && element.containerId) {
      out.labels[element.containerId] = {
        id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
        originalText: element.originalText,
      };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.editingId = state.editingTextElement ? state.editingTextElement.id : null;
  out.editorOpen = Boolean(document.querySelector('textarea.excalidraw-wysiwyg'));
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

/**
 * Hold on to the element objects behind a set of ids.
 *
 * Object identity is the question. Excalidraw replaces the *text* element on every keystroke
 * — that is how it writes the text — but it leaves everything else in the scene alone, and it
 * grows a container by mutating it in place. So a shape that has a new object behind it after
 * a keystroke was handed back by a whole-scene write, and the only thing making one of those
 * mid-keystroke is this project's own relayout.
 */
const WATCH = (ids) => `(() => {
  const api = window.__typingCheckApi;
  const wanted = new Set(${JSON.stringify(ids)});
  window.__typingWatch = new Map();
  for (const element of api.getSceneElementsIncludingDeleted()) {
    if (wanted.has(element.id)) window.__typingWatch.set(element.id, element);
  }
  return window.__typingWatch.size;
})()`;

/** Which of the watched elements are no longer the objects they were. */
const REPLACED = `(() => {
  const api = window.__typingCheckApi;
  const now = new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
  const out = [];
  for (const [id, element] of window.__typingWatch) {
    if (now.get(id) !== element) out.push(id);
  }
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/**
 * Long enough to wrap several times over and to outgrow the block's template height.
 *
 * A block is 140 tall and 300 wide once the layout has had it, which leaves room for five
 * lines of the default font; this is about nine. The report is of a word going missing out of
 * an observation of roughly this length.
 */
const TYPED = 'The mirror redraws the whole scene while this observation is being typed, '
  + 'and the report says a word can vanish out of the middle of it, so this line is long '
  + 'enough to wrap over several of them. Every character of it has to come back.';

/** Typed in pieces, so the block can be asked what it holds between the keystrokes. */
const CHUNK = 24;

/**
 * Type the string into an open editor, asking the block what it holds after every chunk.
 *
 * Returns one entry per sample: what was typed by then, what the block says it holds, where
 * the label is against its container, whether the editor is still open, and which watched
 * elements had been replaced by that point.
 */
async function typeAndSample(blockId, from) {
  const samples = [];
  for (let at = from; at < TYPED.length; at += CHUNK) {
    const piece = TYPED.slice(at, at + CHUNK);
    await typeText(piece);
    const scene = await evaluate(PROBE);
    const block = scene.drafts.find((draft) => draft.id === blockId) ?? null;
    const label = scene.labels[blockId] ?? null;
    samples.push({
      typed: TYPED.slice(0, at + piece.length),
      block,
      label,
      editorOpen: scene.editorOpen,
      replaced: await evaluate(REPLACED),
    });
  }
  return samples;
}

/** Whether a label's box sits inside its container's, allowing for rounding. */
const inside = (label, block) => Boolean(label && block)
  && label.x >= block.x - 0.5 && label.y >= block.y - 0.5
  && label.x + label.w <= block.x + block.w + 0.5
  && label.y + label.h <= block.y + block.h + 0.5;

const detailOf = (sample) => `typed ${sample.typed.length}: `
  + `text=${JSON.stringify(sample.label?.originalText ?? null)} `
  + `label=${JSON.stringify(sample.label)} block=${JSON.stringify(sample.block)} `
  + `editorOpen=${sample.editorOpen} replaced=${JSON.stringify(sample.replaced)}`;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).cards.length >= 1, 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);
  await shot('01-mirror');

  console.log('1. typing into a block with nothing under it rewrites nothing else on the canvas');

  const plus = toViewport(scene, scene.add.x + scene.add.w / 2, scene.add.y + scene.add.h / 2);
  await click(plus.x, plus.y);
  await sleep(900);
  scene = await evaluate(PROBE);
  check('the + dropped one block, and it is the only one in the column',
        scene.drafts.length === 1, JSON.stringify(scene.drafts));
  const alone = scene.drafts[0];

  // Nothing selected before the double click: a selected block puts Excalidraw's properties
  // island over the left of the canvas, and the first column is under it. The trap
  // `docs/project-board.md` records — the click that never reached the box.
  await evaluate('window.__typingCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
  scene = await evaluate(PROBE);

  // What typing cannot move: a card in a column of the project's own, the notes column's
  // header, and the title strip across the top.
  const card = scene.cards[0];
  const untouchable = [card.id, 'pb-title', `pb-h-${NOTES.id}`];
  check('there is a mirrored card to watch, in a column no block can be in',
        Boolean(card) && card.col === TODO.id, JSON.stringify(scene.cards));

  const centre = toViewport(scene, alone.x + alone.w / 2, alone.y + alone.h / 2);
  await click(centre.x, centre.y, 2);
  await sleep(500);
  check('a double click opens the label editor', (await evaluate(PROBE)).editorOpen);

  // The block ships with a placeholder, and a double click selects it — so the first
  // character replaces it. Asserted rather than assumed: every reading below is of a block
  // that holds what was typed and nothing else.
  await typeText(TYPED[0]);
  await sleep(250);
  let first = await evaluate(PROBE);
  check('the first character replaced the block\'s placeholder rather than joining it',
        first.labels[alone.id]?.originalText === TYPED[0],
        JSON.stringify(first.labels[alone.id]?.originalText));

  // Held by reference only now, with the editor already open and the first character in:
  // opening the editor is itself a reason to lay the column out again, and what is being
  // asked here is what the *keystrokes after that* rewrite.
  check('all three watched elements were found in the scene',
        (await evaluate(WATCH(untouchable))) === untouchable.length, untouchable.join(', '));

  const solo = await typeAndSample(alone.id, 1);
  await shot('02-typed-alone');
  const soloEnd = solo[solo.length - 1];

  check('the block grew, so the relayout really did have a reason to run',
        Boolean(soloEnd.block) && soloEnd.block.h > alone.h, `${alone.h} → ${soloEnd.block?.h}`);
  check('the block holds exactly what was typed, character for character',
        soloEnd.label?.originalText === TYPED,
        `${JSON.stringify(soloEnd.label?.originalText)} vs ${JSON.stringify(TYPED)}`);
  check('and held exactly what had been typed at every sample along the way',
        solo.every((sample) => sample.label?.originalText === sample.typed),
        detailOf(solo.find((sample) => sample.label?.originalText !== sample.typed) ?? soloEnd));
  check('the label never left the box it is bound to',
        solo.every((sample) => inside(sample.label, sample.block)),
        detailOf(solo.find((sample) => !inside(sample.label, sample.block)) ?? soloEnd));
  check('the editor stayed open throughout',
        solo.every((sample) => sample.editorOpen), detailOf(soloEnd));
  // The case itself: nothing in the column moved, so nothing had to be written, and an
  // element that was rewritten anyway was rewritten by a redraw nobody needed.
  check('and nothing that typing cannot move was rewritten while the caret was in the block',
        solo.every((sample) => sample.replaced.length === 0),
        detailOf(solo.find((sample) => sample.replaced.length > 0) ?? soloEnd));

  console.log('\n2. a block with another under it still reflows, and is still not rebuilt');
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(1000);
  await evaluate('window.__typingCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
  scene = await evaluate(PROBE);
  await shot('03-first-written');

  // A second block, which the layout puts on top: drafts stack newest first, so this is the
  // one a reader has just made and is about to write into, with the first one below it.
  const plusAgain = toViewport(scene, scene.add.x + scene.add.w / 2, scene.add.y + scene.add.h / 2);
  await click(plusAgain.x, plusAgain.y);
  await sleep(1000);
  await evaluate('window.__typingCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
  scene = await evaluate(PROBE);
  check('a second block, on top of the one already written',
        scene.drafts.length === 2 && scene.drafts[1].id === alone.id,
        JSON.stringify(scene.drafts));
  const fresh = scene.drafts[0];
  const belowBefore = scene.drafts[1].y;

  const freshCentre = toViewport(scene, fresh.x + fresh.w / 2, fresh.y + fresh.h / 2);
  await click(freshCentre.x, freshCentre.y, 2);
  await sleep(500);
  check('a double click opens the editor on the new block',
        (await evaluate(PROBE)).editingId !== null);

  await typeText(TYPED[0]);
  await sleep(250);
  first = await evaluate(PROBE);
  check('the first character replaced this block\'s placeholder too',
        first.labels[fresh.id]?.originalText === TYPED[0],
        JSON.stringify(first.labels[fresh.id]?.originalText));

  // Watched this time: the container under the caret. Excalidraw grows a container by
  // mutating it in place and never hands back a new one while its label is being edited, so
  // a different object here is one this project's redraw put there.
  check('the block under the caret was found in the scene',
        (await evaluate(WATCH([fresh.id]))) === 1, fresh.id);

  const stacked = await typeAndSample(fresh.id, 1);
  await shot('04-typed-stacked');
  const stackedEnd = stacked[stacked.length - 1];
  const belowAfter = (await evaluate(PROBE)).drafts.find((draft) => draft.id === alone.id)?.y ?? null;

  check('the block below it moved down, so the column did reflow as it always has',
        belowAfter !== null && belowAfter > belowBefore, `${belowBefore} → ${belowAfter}`);
  check('by what the block above it grew by',
        belowAfter !== null && Boolean(stackedEnd.block)
        && Math.abs((belowAfter - belowBefore) - (stackedEnd.block.h - fresh.h)) < 1,
        `grew ${stackedEnd.block && stackedEnd.block.h - fresh.h}, below moved ${belowAfter - belowBefore}`);
  // The case itself: the reflow above is exactly the pass that used to rebuild the block
  // being typed into along with everything else it wrote.
  check('and the block under the caret was never replaced by that reflow',
        stacked.every((sample) => sample.replaced.length === 0),
        detailOf(stacked.find((sample) => sample.replaced.length > 0) ?? stackedEnd));
  check('it holds exactly what was typed, character for character',
        stackedEnd.label?.originalText === TYPED,
        `${JSON.stringify(stackedEnd.label?.originalText)} vs ${JSON.stringify(TYPED)}`);
  check('and held exactly what had been typed at every sample along the way',
        stacked.every((sample) => sample.label?.originalText === sample.typed),
        detailOf(stacked.find((sample) => sample.label?.originalText !== sample.typed) ?? stackedEnd));
  check('the label never left the box it is bound to',
        stacked.every((sample) => inside(sample.label, sample.block)),
        detailOf(stacked.find((sample) => !inside(sample.label, sample.block)) ?? stackedEnd));
  check('and the editor was still open at the end',
        stacked.every((sample) => sample.editorOpen), detailOf(stackedEnd));
} catch (error) {
  failures++;
  console.error(`  FAIL  the run finished — ${error.message}`);
} finally {
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds the profile */ }
}

console.log(failures === 0
  ? '\nAll checks passed.'
  : `\n${failures} check${failures === 1 ? '' : 's'} failed.`);
process.exit(failures === 0 ? 0 : 1);
