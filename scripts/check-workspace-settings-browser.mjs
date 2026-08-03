#!/usr/bin/env node
/**
 * Checks what the project settings dialog actually shows, and that a workflow can be typed
 * into it at all.
 *
 * `check-workspace-settings.mjs` proves the route: `PUT /api/workspaces/<id>/config` accepts
 * `agents.<kind>.workflow`, merges it field by field, and refuses what is not a slug. None of
 * that puts a field on screen, and until now none was there — `agentPatch` sent `model`,
 * `effort` and `timeoutSeconds` and nothing else, so the one setting that changes *what a run
 * does* could only be reached by hand-editing JSON. A dialog missing a field compiles
 * perfectly, and so does one that has it and never sends it.
 *
 * The other half is the first screen a new user meets. The dialog opened on eleven free-text
 * rows and two agent fieldsets, immediately after picking a folder, with nothing saying any of
 * it was optional. It now opens on five, each marked optional, with the rest behind `Advanced`
 * — which is a claim about the DOM, so it is asserted against the DOM rather than against a
 * stylesheet: a row hidden with `display: none` is still a row somebody has to scroll past
 * with a screen reader, and `<details>` would have kept every one of them mounted.
 *
 * The case that matters most is the quiet one. The disclosure hides fields; the draft still
 * carries them. If the patch were ever built from what is *rendered* rather than from the
 * draft, saving a collapsed dialog would erase every advanced setting the project had — which
 * is exactly the shape of bug a screenshot cannot see. So section 2 saves without expanding
 * anything and reads the file back.
 *
 * Section 5 is the way back out, added with `DELETE /api/workspaces/:id` (#346). The route is
 * `check-workspace-remove.mjs`'s subject; what belongs here is the half that only exists in a
 * browser — that a reader can find the control at all, that the sentence they are asked to
 * agree to names the folder and says plainly what is *not* deleted, and that the strip, the
 * registry and the project directory all end up where the confirmation said they would. It
 * runs last because it takes away the project every section above it was editing.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: a throwaway registry and project, its own canvas server on a
 * port the kernel handed out, both killed at the end. Nothing here talks to GitHub. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-workspace-settings-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';
import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = argOf('--chrome') ?? findChrome();
if (!chromePath) skipWithoutChrome();

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

// ─── The rows, and which side of the disclosure each is on ────

/** What the dialog opens on. Five, and the first screen of the product. */
const DEFAULT_FIELDS = ['name', 'language', 'docsDir', 'repo', 'githubProject'];

/** What `Advanced` reveals — the expert settings, and both agents in full. */
const ADVANCED_FIELDS = [
  'board', 'library', 'projectField', 'projectCardLimit',
  'projectTodoColumn', 'projectInProgressColumn', 'projectFounderColumn',
  'agents.issue.model', 'agents.issue.effort', 'agents.issue.timeoutSeconds', 'agents.issue.workflow',
  'agents.implement.model', 'agents.implement.effort', 'agents.implement.timeoutSeconds',
  'agents.implement.workflow',
];

// ─── A project with settings a save must not damage ───────────

const workDir = mkdtempSync(join(tmpdir(), 'check-workspace-settings-browser-'));
const projectDir = join(workDir, 'tuned-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const configPath = join(projectDir, 'board.config.json');

/**
 * Hand-written, and every value in it is behind the disclosure except the name.
 *
 * `agents.issue.workflow` is the one the dialog could not reach at all, so it is the one a
 * blank save has to leave alone; `projectTodoColumn` is an ordinary advanced row, and it is
 * here so that "the collapsed rows survive" is a claim about all of them rather than about
 * the interesting one.
 */
writeFileSync(configPath, JSON.stringify({
  name: 'Tuned Project',
  repo: 'vitorengers/vibemaxxing',
  projectTodoColumn: 'Ready',
  agents: {
    issue: { model: 'claude-fable-5', workflow: 'research-first' },
  },
}, null, 2), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'tuned-project', path: slash(projectDir) }],
}, null, 2), 'utf8');

const onDisk = () => JSON.parse(readFileSync(configPath, 'utf8'));

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

const server = startCanvas({
  port: PORT,
  env: { LOG_LEVEL: 'error', EXCALIDRAW_WORKSPACES: registryPath },
});
children.push(server.child);

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${server.read()}`);
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

/** A real click, so nothing passes by calling a handler the user could not reach. */
const click = (selector) => evaluate(`(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) return false;
  target.click();
  return true;
})()`);

/**
 * Type into a controlled input the way React hears it — assigning `.value` alone updates the
 * DOM and tells React nothing, so the component's state stays empty and the save sends it.
 */
const type = (selector, value) => evaluate(`(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

/** Every `data-field` the dialog currently has mounted, in document order. */
const fieldsMounted = () => evaluate(
  `[...document.querySelectorAll('.workspace-config [data-field]')].map((node) => node.getAttribute('data-field'))`);

const valueOf = (field) => evaluate(
  `document.querySelector('.workspace-config [data-field=${JSON.stringify(field)}]')?.value ?? null`);

const present = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);

/** Which of the visible rows say out loud that they may be left blank. */
const rowsMarkedOptional = () => evaluate(`(() => {
  const rows = [...document.querySelectorAll('.workspace-config .workspace-config__row')];
  return rows
    .filter((row) => row.querySelector('.workspace-config__optional'))
    .map((row) => row.querySelector('[data-field]')?.getAttribute('data-field') ?? null);
})()`);

/**
 * Open the settings dialog on the one tab there is, and wait for it to be filled in from disk.
 *
 * The dialog is on screen before its `GET .../config` lands — it renders "Reading
 * board.config.json…" first — so waiting for the shell and reading straight away reads an
 * empty form and calls it a missing field.
 */
async function openSettings() {
  if (!(await click('.workspace-tab--active .workspace-tab__config'))) {
    throw new Error('the settings control is not on the active tab');
  }
  await waitFor(() => present('.workspace-config [data-field="name"]'),
                'the settings form to be filled in from disk');
}

/** Save, and wait for the dialog to go — which is how the board says the write landed. */
async function save() {
  if (!(await click('.workspace-config__save'))) throw new Error('there is no save button');
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!(await present('.workspace-config'))) return;
    const said = await evaluate(`document.querySelector('.workspace-dialog__error')?.textContent ?? null`);
    if (said) throw new Error(`the board refused the save: ${said}`);
    await sleep(250);
  }
  throw new Error('timed out waiting for the settings dialog to close after saving');
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const missing = (mounted, wanted) => wanted.filter((field) => !mounted.includes(field));
const leaked = (mounted, unwanted) => unwanted.filter((field) => mounted.includes(field));

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
    '--window-size=1400,1000',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');

  await waitFor(() => present('.workspace-tab--active'), 'the tab for the registered project');

  console.log('1. the dialog opens on five rows and an Advanced control');
  await openSettings();
  await shot('01-collapsed');
  const collapsed = await fieldsMounted();
  check('the five default rows are there',
        missing(collapsed, DEFAULT_FIELDS).length === 0,
        `missing ${JSON.stringify(missing(collapsed, DEFAULT_FIELDS))} of ${JSON.stringify(collapsed)}`);
  check('and nothing else is — the expert rows are not in the DOM at all',
        leaked(collapsed, ADVANCED_FIELDS).length === 0,
        `still mounted: ${JSON.stringify(leaked(collapsed, ADVANCED_FIELDS))}`);
  check('so the dialog is exactly the five', same(collapsed, DEFAULT_FIELDS), JSON.stringify(collapsed));
  check('neither agent fieldset is mounted', !(await present('.workspace-config__agent')));
  check('there is an Advanced control to reach the rest by',
        await present('.workspace-config__advanced'));
  const optional = await rowsMarkedOptional();
  check('and every row on screen says it may be left blank',
        same(optional, DEFAULT_FIELDS), JSON.stringify(optional));

  console.log('\n2. saving a collapsed dialog changes nothing it is not showing');
  await type('.workspace-config [data-field="name"]', 'Renamed From The Board');
  await save();
  const afterCollapsedSave = onDisk();
  check('the name that was typed is on disk',
        afterCollapsedSave.name === 'Renamed From The Board', JSON.stringify(afterCollapsedSave));
  check('the workflow the dialog never showed is still there',
        afterCollapsedSave.agents?.issue?.workflow === 'research-first',
        JSON.stringify(afterCollapsedSave.agents));
  check('and so is the model beside it',
        afterCollapsedSave.agents?.issue?.model === 'claude-fable-5',
        JSON.stringify(afterCollapsedSave.agents));
  check('and the advanced row that was hidden with them',
        afterCollapsedSave.projectTodoColumn === 'Ready', JSON.stringify(afterCollapsedSave));

  console.log('\n3. Advanced puts the rest of the form in the DOM');
  await openSettings();
  check('the Advanced control is clickable', await click('.workspace-config__advanced'));
  await waitFor(() => present('.workspace-config__agent'), 'the agent fieldsets to be revealed');
  await shot('02-expanded');
  const expanded = await fieldsMounted();
  check('every expert row is now mounted',
        missing(expanded, ADVANCED_FIELDS).length === 0,
        `missing ${JSON.stringify(missing(expanded, ADVANCED_FIELDS))} of ${JSON.stringify(expanded)}`);
  check('the five are still there beside them',
        missing(expanded, DEFAULT_FIELDS).length === 0,
        JSON.stringify(expanded));
  check('and the issue agent\'s workflow is shown as it is written on disk',
        (await valueOf('agents.issue.workflow')) === 'research-first',
        JSON.stringify(await valueOf('agents.issue.workflow')));

  console.log('\n4. a workflow typed here reaches board.config.json');
  check('the implement agent has a workflow field to type into',
        await type('.workspace-config [data-field="agents.implement.workflow"]', 'opus-build'));
  await shot('03-workflow-typed');
  check('the form took it',
        (await valueOf('agents.implement.workflow')) === 'opus-build');
  await save();
  const written = onDisk();
  check('the slug is in the project config',
        written.agents?.implement?.workflow === 'opus-build', JSON.stringify(written.agents));
  check('and the one that was already there survived being saved beside it',
        written.agents?.issue?.workflow === 'research-first', JSON.stringify(written.agents));
  check('as a slug, not a path — the file is what the run will resolve',
        typeof written.agents?.implement?.workflow === 'string'
          && !written.agents.implement.workflow.includes('/'),
        JSON.stringify(written.agents));

  console.log('\n5. and the same dialog is the way back out');
  // Last, because it takes the project this check has been editing off the board. The route
  // itself is `check-workspace-remove.mjs`'s subject; what is asserted here is the half that
  // only exists in a browser — that a reader can reach it, that the sentence they are asked
  // to agree to names the folder and says what is *not* deleted, and that the strip and the
  // registry both come back without it.
  await openSettings();
  check('the removal is at the foot of the settings dialog',
        await present('.workspace-config__danger-open'));
  check('it is behind a press rather than one click from a shipped project',
        !(await present('.workspace-config__danger-go')));
  check('the control opens the confirmation', await click('.workspace-config__danger-open'));
  await waitFor(() => present('.workspace-config__danger-go'), 'the confirmation');
  await shot('04-remove-confirm');

  const asked = await evaluate(
    `document.querySelector('.workspace-config__danger')?.textContent ?? ''`);
  check('the confirmation names the folder on disk, which is what disambiguates two projects',
        asked.includes(slash(projectDir)) || asked.includes(projectDir),
        JSON.stringify(asked));
  check('and says the folder is left as it is',
        /left exactly as they are/i.test(asked), JSON.stringify(asked));
  check('naming board.config.json, the file a reader is most afraid of losing',
        asked.includes('board.config.json'), JSON.stringify(asked));
  check('and saying the drawing is kept too',
        /adding the project back brings it/i.test(asked), JSON.stringify(asked));

  check('the confirmed removal is clickable', await click('.workspace-config__danger-go'));
  await waitFor(async () => !(await present('.workspace-config')), 'the dialog to close');
  await waitFor(async () => !(await present('.workspace-tab')), 'the tab to go');
  await shot('05-removed');
  check('the strip is back to offering the first project',
        await present('.workspace-tabs__add--labelled'));
  check('and the registry no longer lists it',
        JSON.parse(readFileSync(registryPath, 'utf8')).workspaces.length === 0,
        readFileSync(registryPath, 'utf8'));
  check('while the project folder is still there',
        existsSync(projectDir) && existsSync(configPath), projectDir);
  check('with the board.config.json this check last wrote, byte for byte',
        JSON.stringify(onDisk()) === JSON.stringify(written), JSON.stringify(onDisk()));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(300);
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
