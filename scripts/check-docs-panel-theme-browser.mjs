#!/usr/bin/env node
/**
 * Checks that the anchored documentation card is readable in both themes, in a browser.
 *
 * The card is styled with Excalidraw's theme variables — `--island-bg-color`,
 * `--text-primary-color`, the `--color-gray-*` ramp — but it is deliberately a *sibling*
 * of `<Excalidraw>` rather than a child of it, so that it never becomes a scene element
 * and never reaches a PNG export. Excalidraw scopes those variables to its own root
 * element, so outside that subtree they are simply undefined, and every declaration in
 * `DocsPanel.css` falls through to its hard-coded fallback or, where there is none, to
 * whatever the page happens to inherit. In dark mode that pairs the inherited near-white
 * body colour with a white card: text at roughly 1.16:1 against its own background.
 *
 * Only a browser can answer this. `getComputedStyle` on the live card is the whole point:
 * the variables resolve at computed-value time, which no build step and no type check
 * ever runs. So this reads the card's *rendered* colours in dark and in light, and asks
 * whether what a reader ends up looking at has any contrast in it.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway workspace with one
 * documented block, starts its own canvas server on a free port and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the
 * built frontend.
 *
 * Usage: node scripts/check-docs-panel-theme-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

/** Chrome, wherever this machine keeps it. Edge speaks the same protocol. */
function findChrome() {
  const named = argOf('--chrome');
  if (named) return existsSync(named) ? named : null;
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('SKIPPED — no Chrome or Edge found, so the browser half was not run.');
  console.log('        Pass --chrome <path> or set CHROME_PATH to run it.');
  process.exit(0);
}

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

// ─── Colour arithmetic ────────────────────────────────────────
//
// WCAG 2.1, relative luminance and contrast ratio. Small enough to keep here, and the
// alternative is a dependency for twelve lines.

/** `rgb(35, 35, 41)` or `rgba(0, 0, 0, 0)` as the browser writes it, into channels. */
function parseColor(value) {
  const numbers = String(value).match(/[\d.]+/g);
  if (!numbers || numbers.length < 3) return null;
  const [r, g, b] = numbers.slice(0, 3).map(Number);
  const alpha = numbers.length > 3 ? Number(numbers[3]) : 1;
  return { r, g, b, alpha };
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

const hex = (colour) => colour
  ? `#${[colour.r, colour.g, colour.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  : 'none';

/** A background that is `rgba(0, 0, 0, 0)` is not a background: the card's shows through. */
const opaque = (colour) => Boolean(colour) && colour.alpha > 0.99;

// ─── A project with one documented block ──────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-docs-theme-'));
const projectDir = join(workDir, 'themed-project');
const docsDir = join(projectDir, 'docs');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, docsDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'themed-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Themed Project',
  repo: 'vitorengers/mcp_excalidraw',
  docsDir: 'docs',
}), 'utf8');

// Every construct the card colours separately, so one selection exercises the whole
// stylesheet: body text, inline code, a code block, a quote, a table.
const DOC_KEY = 'theme-sample';
writeFileSync(join(docsDir, `${DOC_KEY}.md`), [
  '# Theme sample',
  '',
  'Ordinary body text, which is what the reader is here for, plus `inline code`.',
  '',
  '```',
  'a fenced block',
  '```',
  '',
  '> A quotation, set apart from the text around it.',
  '',
  '| Column | Column |',
  '| --- | --- |',
  '| cell | cell |',
  '',
].join('\n'), 'utf8');

const PORT = 36100 + (process.pid % 300);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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

const api = (path, options = {}) => fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`, {
  headers: { 'Content-Type': 'application/json' },
  ...options,
});

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

/** The imperative API, through the container's React fibre. See check-board-sections-browser. */
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
        window.__docsThemeApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const CARD_ID = `(() => {
  const api = window.__docsThemeApi;
  if (!api) return null;
  const found = api.getSceneElements().find((element) => (element.customData || {}).docKey === '${DOC_KEY}');
  return found ? found.id : null;
})()`;

/**
 * What a reader is actually looking at, straight out of the rendered card.
 *
 * Nothing here is read from a stylesheet: every value is what the cascade settled on,
 * variables resolved, in the theme the board is in at this instant.
 */
const PAINT = `(() => {
  const card = document.querySelector('.docs-card');
  if (!card) return { error: 'no card' };
  const body = card.querySelector('.element-docs');
  const code = card.querySelector('.element-docs__body code');
  const pre = card.querySelector('.element-docs__body pre');
  const quote = card.querySelector('.element-docs__body blockquote');
  const cell = card.querySelector('.element-docs__body td');
  if (!body || !code || !pre || !quote || !cell) return { error: 'the document has not rendered yet' };
  const tab = document.querySelector('.workspace-tab--active');
  const label = tab && tab.querySelector('.workspace-tab__select');
  const style = (node) => getComputedStyle(node);
  const cardStyle = style(card);
  return {
    theme: (document.querySelector('.app') || {}).dataset ? document.querySelector('.app').dataset.theme : null,
    // Is the variable in scope here at all? Undefined resolves to the empty string.
    islandToken: cardStyle.getPropertyValue('--island-bg-color').trim(),
    textToken: cardStyle.getPropertyValue('--text-primary-color').trim(),
    grayToken: cardStyle.getPropertyValue('--color-gray-10').trim(),
    cardBackground: cardStyle.backgroundColor,
    cardBorder: cardStyle.borderTopColor,
    bodyColor: style(body).color,
    codeBackground: style(code).backgroundColor,
    preBackground: style(pre).backgroundColor,
    quoteColor: style(quote).color,
    cellBorder: style(cell).borderTopColor,
    // The tab strip shares the card's dependency on these variables, and shares its
    // failure mode: a half-declared set gives the selected tab a light background and a
    // near-white label. It is not the reported defect, but it is one variable away from it.
    tabBackground: tab ? style(tab).backgroundColor : null,
    tabColor: label ? style(label).color : null,
  };
})()`;

/**
 * The project settings dialog, which is the third overlay outside the canvas.
 *
 * It is opened and closed from here rather than by a click because the point is its
 * colours, not its trigger — and its save button is the one control in the app painted
 * *on* the primary fill rather than in it, so it is the one that a themed foreground and
 * an unthemed background would meet on.
 */
const DIALOG = `(() => {
  const gear = document.querySelector('.workspace-tab--active .workspace-tab__config');
  if (!gear) return { error: 'no settings button' };
  gear.click();
  return true;
})()`;

const DIALOG_PAINT = `(() => {
  const dialog = document.querySelector('.workspace-config');
  const save = dialog && dialog.querySelector('.workspace-config__save');
  const field = dialog && dialog.querySelector('.workspace-config__field');
  if (!dialog || !save || !field) return { error: 'the settings dialog has not opened yet' };
  const style = (node) => getComputedStyle(node);
  // A control with a transparent background is read against whatever is behind it, so
  // that is what the contrast has to be measured against — the dialog's own fill, here.
  const behind = (node) => {
    for (let at = node; at; at = at.parentElement) {
      const colour = style(at).backgroundColor;
      const alpha = (String(colour).match(/[\\d.]+/g) || [])[3];
      if (alpha === undefined || Number(alpha) > 0.99) return colour;
    }
    return style(document.body).backgroundColor;
  };
  return {
    dialogBackground: behind(dialog),
    dialogColor: style(dialog).color,
    fieldBackground: behind(field),
    fieldColor: style(field).color,
    saveBackground: behind(save),
    saveColor: style(save).color,
  };
})()`;

/** Put the board in one theme with the documented block selected, and let it settle. */
const showIn = (theme, id) => `(() => {
  const api = window.__docsThemeApi;
  api.updateScene({ appState: { theme: '${theme}', selectedElementIds: { '${id}': true } } });
  return true;
})()`;

const ISLAND = { dark: '#232329', light: '#ffffff' };

/**
 * What each theme's card has to look like.
 *
 * 4.5:1 is WCAG AA for body text, and the body of the card is body text. A quotation is
 * held to 3:1, AA's threshold for large text, because it is set apart rather than read
 * straight through. Borders only have to be *there*: 1.4:1, because Excalidraw's own
 * `--color-gray-30` on its own white island is 1.45:1, and the point of copying the
 * palette is to look like the canvas rather than to out-argue it.
 */
function assertReadable(theme, paint) {
  const cardBackground = parseColor(paint.cardBackground);
  const bodyColor = parseColor(paint.bodyColor);

  check(`${theme}: the Excalidraw theme variables are in scope on the card`,
        paint.islandToken !== '' && paint.textToken !== '' && paint.grayToken !== '',
        `--island-bg-color=${JSON.stringify(paint.islandToken)} `
        + `--text-primary-color=${JSON.stringify(paint.textToken)} `
        + `--color-gray-10=${JSON.stringify(paint.grayToken)}`);

  check(`${theme}: the card is painted the theme's island colour`,
        opaque(cardBackground) && hex(cardBackground) === ISLAND[theme],
        `${paint.cardBackground} (wanted ${ISLAND[theme]})`);

  const bodyContrast = cardBackground && bodyColor ? contrast(bodyColor, cardBackground) : 0;
  check(`${theme}: the body text has at least 4.5:1 against the card it sits on`,
        bodyContrast >= 4.5,
        `${hex(bodyColor)} on ${hex(cardBackground)} is ${bodyContrast.toFixed(2)}:1`);

  for (const [what, value] of [['inline code', paint.codeBackground], ['a code block', paint.preBackground]]) {
    const background = parseColor(value);
    const ratio = background && bodyColor ? contrast(bodyColor, background) : 0;
    check(`${theme}: text on ${what} has at least 4.5:1`,
          opaque(background) && ratio >= 4.5,
          `${hex(bodyColor)} on ${value} is ${ratio.toFixed(2)}:1`);
  }

  const quoteColor = parseColor(paint.quoteColor);
  const quoteContrast = cardBackground && quoteColor ? contrast(quoteColor, cardBackground) : 0;
  check(`${theme}: a quotation has at least 3:1`, quoteContrast >= 3,
        `${hex(quoteColor)} on ${hex(cardBackground)} is ${quoteContrast.toFixed(2)}:1`);

  for (const [what, value] of [['the card', paint.cardBorder], ['a table cell', paint.cellBorder]]) {
    const border = parseColor(value);
    const ratio = cardBackground && border ? contrast(border, cardBackground) : 0;
    check(`${theme}: the border of ${what} can be seen against it`,
          opaque(border) && ratio >= 1.4,
          `${value} on ${hex(cardBackground)} is ${ratio.toFixed(2)}:1`);
  }

  const tabBackground = parseColor(paint.tabBackground);
  const tabColor = parseColor(paint.tabColor);
  const tabContrast = tabBackground && tabColor ? contrast(tabColor, tabBackground) : 0;
  check(`${theme}: the selected project tab's label reads against the tab`,
        opaque(tabBackground) && tabContrast >= 4.5,
        `${hex(tabColor)} on ${paint.tabBackground} is ${tabContrast.toFixed(2)}:1`);
}

function assertDialogReadable(theme, paint) {
  for (const [what, foreground, background] of [
    ['the settings dialog reads', paint.dialogColor, paint.dialogBackground],
    ['what is typed into one of its fields reads', paint.fieldColor, paint.fieldBackground],
    ['its save button reads', paint.saveColor, paint.saveBackground],
  ]) {
    const text = parseColor(foreground);
    const fill = parseColor(background);
    const ratio = text && fill ? contrast(text, fill) : 0;
    check(`${theme}: ${what}`, opaque(fill) && ratio >= 4.5,
          `${hex(text)} on ${background} is ${ratio.toFixed(2)}:1`);
  }
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 120, y: 120, width: 300, height: 160,
      backgroundColor: '#e7f5ff', text: 'documented', customData: { docKey: DOC_KEY },
    }),
  });

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  const cardId = await waitFor(() => evaluate(CARD_ID), 'the documented block to reach the canvas');

  // Dark first: it is the reported defect, and a run that dies early should die on it.
  let step = 0;
  for (const theme of ['dark', 'light']) {
    console.log(`\n${++step}. ${theme} mode`);
    await evaluate(showIn(theme, cardId));
    const paint = await waitFor(async () => {
      const seen = await evaluate(PAINT);
      return seen && !seen.error && seen.theme === theme ? seen : null;
    }, `the card to render in ${theme} mode`);
    await shot(`0${step}-${theme}`);
    assertReadable(theme, paint);

    await evaluate(DIALOG);
    const dialogPaint = await waitFor(async () => {
      const seen = await evaluate(DIALOG_PAINT);
      return seen && !seen.error ? seen : null;
    }, `the settings dialog to open in ${theme} mode`);
    await shot(`0${step}-${theme}-dialog`);
    assertDialogReadable(theme, dialogPaint);
    await evaluate(`(() => {
      const cancel = document.querySelector('.workspace-config__cancel');
      if (cancel) cancel.click();
      return true;
    })()`);
    await sleep(300);

    // Deselect, so the next theme opens the card again rather than keeping a stale one.
    await evaluate('window.__docsThemeApi.updateScene({ appState: { selectedElementIds: {} } })');
    await sleep(400);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(600);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  } else {
    console.log(`\nscreenshots in ${shotDir}`);
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
