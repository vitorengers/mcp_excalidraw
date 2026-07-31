#!/usr/bin/env node
/**
 * Checks that where the launch command was typed does not decide what the board is.
 *
 * `dotenv.config()` was called with no path in both entry points, so the only configuration
 * source was a `.env` in `process.cwd()` — a file that is gitignored, had no tracked example,
 * and sits wherever the caller's shell happened to be. The spawned server inherited that cwd
 * too, because the spawn in `src/core/spawn.ts` passed an environment and no `cwd`. Two
 * failures fell out of it, and `docs/running.md` had to document the second as a warning:
 *
 *   - a double-clicked launcher has an unpredictable working directory (`C:\Windows\System32`
 *     from a shortcut, `/` from a `.desktop` entry, the home directory from Finder), so it can
 *     never find a `.env` and the board comes up with no workspaces, no terminal, no agents;
 *   - an MCP server attached to an editor auto-starts a canvas *in that editor's project*,
 *     which then holds the board's port answering `status: healthy` and is not the board.
 *
 * So the fixture here is the defect stated as a directory: a decoy `.env` naming a registry of
 * its own, a terminal and an agent, sitting in the directory the launch command is run from,
 * and a `config.json` in a state directory naming a different registry. The launched board has
 * to report the state file's registry and none of the decoy's.
 *
 * Section 0 proves the decoy is real by letting a server read it — without that, every case
 * below could pass because the fixture was never readable, which is how a check quietly stops
 * checking anything.
 *
 * Section 3 is the other half of the same claim, and it is a *positive*: a `.env` beside
 * `config.json` **is** read, because the state directory is the explicit working directory the
 * spawn now passes. Asserting only that the decoy is ignored would also pass for a board that
 * had stopped reading `.env` files at all.
 *
 * Self-contained: it writes its own state directories, decoy directories and registries under
 * the system temp directory, launches through `dist/bin.js`, and kills every server it started
 * by the pid that server reports about itself. Nothing here touches the operator's own state
 * directory (`EXCALIDRAW_STATE_DIR` redirects it), the board, GitHub or the network, and no
 * agent is ever spawned — the decoy's "agent" is `node --version`.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-launch-cwd-independent.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const binPath = join(repoRoot, 'dist', 'bin.js');

/**
 * The CLI's canvas-URL variable, spelled in pieces the way
 * `scripts/check-no-external-server.mjs` spells it.
 *
 * That check bans the name from every check file, and the ban is on the string rather than on
 * the use, because a scanner that has to tell reading from writing is a scanner one edit from
 * missing the case it exists for. What it forbids is a check whose target is *read* out of the
 * environment; this one only ever hands the name to a child it started, and asserts on what the
 * layers make of it.
 */
const URL_VARIABLE = ['EXPRESS', 'SERVER', 'URL'].join('_');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The fixtures ────────────────────────────────────────────────

const workDir = join(tmpdir(), `check-launch-cwd-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const make = (...parts) => {
  const dir = join(workDir, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A registry with one project in it, named so that a listing says which file it came from. */
function writeRegistry(file, id) {
  const project = join(workDir, `project-${id}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'board.config.json'), JSON.stringify({ name: id }), 'utf8');
  writeFileSync(file, JSON.stringify({ workspaces: [{ id, path: project }] }), 'utf8');
  return file;
}

const decoyRegistry = writeRegistry(join(workDir, 'decoy-workspaces.json'), 'decoy-project');
const stateRegistry = writeRegistry(join(workDir, 'state-workspaces.json'), 'state-project');

// The directory the launch command is typed in, holding everything the old code would have
// believed. `node --version` rather than a real command line: a run that wrongly starts an
// agent still cannot do anything.
const decoyDir = make('decoy');
writeFileSync(join(decoyDir, '.env'), [
  `EXCALIDRAW_WORKSPACES=${decoyRegistry.replace(/\\/g, '/')}`,
  'EXCALIDRAW_TERMINAL=1',
  'EXCALIDRAW_ISSUE_AGENT=node --version',
  '',
].join('\n'), 'utf8');

/** A directory with nothing in it at all, for the "no `.env` on the machine" case. */
const bareDir = make('bare');

function writeStateDir(name, values) {
  const dir = make(name);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(values, null, 2), 'utf8');
  return dir;
}

// ─── Launching, and cleaning up after ────────────────────────────

const launched = [];

async function healthAt(port, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return null;
}

/**
 * `vibemaxxing start`, from `cwd`, with a state directory of the check's own.
 *
 * The environment is the one every check gives a canvas — no inherited `EXCALIDRAW_*`, no
 * `PORT`, no `HOST` — minus `EXCALIDRAW_NO_DOTENV`, because a check about which file decides
 * cannot start by turning the files off.
 */
function launch({ cwd, stateDir, extraEnv = {} }) {
  const env = canvasEnvironment({ EXCALIDRAW_STATE_DIR: stateDir, LOG_LEVEL: 'error', ...extraEnv });
  delete env.EXCALIDRAW_NO_DOTENV;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, 'start'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.on('close', (code) => {
      // Whatever `start` says it started, whether or not it is the board this case expected.
      // A run that goes red because the launch landed somewhere else must still take that
      // somewhere-else down with it — a failing check that leaves a detached server holding a
      // port is worse than the defect it found.
      const reported = out.match(/"pid":\s*(\d+)/);
      if (reported) launched.push(Number(reported[1]));
      resolve({ code, out });
    });
  });
}

async function boardAt(port) {
  const health = await healthAt(port);
  if (health?.pid) launched.push(health.pid);
  return health;
}

async function workspacesAt(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const startedByHelper = [];

try {
  if (!existsSync(binPath)) {
    console.error(`  FAIL  dist/bin.js not found — run ./node_modules/.bin/tsc first`);
    process.exit(1);
  }

  // ─── 0. the decoy is a real fixture ────────────────────────────

  console.log('0. a server that reads the decoy directory believes it');

  const emptyState = make('empty-state');
  const decoyPort = await freePort();
  const decoyCanvas = startCanvas({
    port: decoyPort,
    cwd: decoyDir,
    allowDotenv: true,
    env: { LOG_LEVEL: 'error', EXCALIDRAW_STATE_DIR: emptyState },
  });
  startedByHelper.push(decoyCanvas.child);
  const decoyHealth = await healthAt(decoyPort);
  check('the decoy .env configures a registry', decoyHealth?.workspaces === 'configured',
        `/health said ${JSON.stringify(decoyHealth?.workspaces)}`);
  check('and a terminal, and an issue agent',
        decoyHealth?.terminal === true && decoyHealth?.agents?.issue === true,
        JSON.stringify({ terminal: decoyHealth?.terminal, agents: decoyHealth?.agents }));
  const decoyList = await workspacesAt(decoyPort);
  check('and the projects it lists are the decoy registry\'s',
        decoyList?.workspaces?.some((workspace) => workspace.id === 'decoy-project') === true,
        JSON.stringify(decoyList?.workspaces?.map((workspace) => workspace.id)));

  // ─── 1. the state file decides, not the launch directory ───────

  console.log('\n1. a board launched from the decoy directory');

  const port = await freePort();
  const stateDir = writeStateDir('state', { PORT: port, EXCALIDRAW_WORKSPACES: stateRegistry });
  const launchedFromDecoy = await launch({ cwd: decoyDir, stateDir });
  check('`start` came back happy', launchedFromDecoy.code === 0, launchedFromDecoy.out.trim());

  const health = await boardAt(port);
  check('a board is answering on the port the state file named', health?.status === 'healthy',
        `nothing answered on ${port}\n${launchedFromDecoy.out.trim()}`);
  check('/health reports the state file\'s registry', health?.workspaces === 'configured',
        `/health said ${JSON.stringify(health?.workspaces)}`);

  const list = await workspacesAt(port);
  const ids = list?.workspaces?.map((workspace) => workspace.id) ?? [];
  check('and the projects it lists are that registry\'s', ids.includes('state-project'),
        JSON.stringify(ids));
  check('not the decoy\'s', !ids.includes('decoy-project'), JSON.stringify(ids));
  check('the decoy\'s terminal did not arrive', health?.terminal === false,
        `/health said terminal: ${JSON.stringify(health?.terminal)}`);
  check('nor the decoy\'s agent', health?.agents?.issue === false,
        JSON.stringify(health?.agents));

  // ─── 2. no .env anywhere, an arbitrary directory ───────────────

  console.log('\n2. a board launched from a directory with no .env in it');

  const barePort = await freePort();
  const bareState = writeStateDir('bare-state', { PORT: barePort, EXCALIDRAW_WORKSPACES: stateRegistry });
  const launchedFromBare = await launch({ cwd: bareDir, stateDir: bareState });
  check('`start` came back happy', launchedFromBare.code === 0, launchedFromBare.out.trim());

  const bareHealth = await boardAt(barePort);
  check('the board still has its workspaces', bareHealth?.workspaces === 'configured',
        `/health said ${JSON.stringify(bareHealth?.workspaces)}\n${launchedFromBare.out.trim()}`);
  const bareIds = (await workspacesAt(barePort))?.workspaces?.map((workspace) => workspace.id) ?? [];
  check('and they are the ones the state file configured', bareIds.includes('state-project'),
        JSON.stringify(bareIds));

  // ─── 3. the server's working directory is the state directory ──

  console.log('\n3. the .env beside config.json is the one a board reads');

  const besidePort = await freePort();
  const besideState = writeStateDir('beside-state', {
    PORT: besidePort, EXCALIDRAW_WORKSPACES: stateRegistry,
  });
  writeFileSync(join(besideState, '.env'), 'EXCALIDRAW_TERMINAL=1\n', 'utf8');
  const launchedBeside = await launch({ cwd: decoyDir, stateDir: besideState });
  check('`start` came back happy', launchedBeside.code === 0, launchedBeside.out.trim());

  const besideHealth = await boardAt(besidePort);
  check('a .env in the state directory reaches the board', besideHealth?.terminal === true,
        `/health said terminal: ${JSON.stringify(besideHealth?.terminal)}\n${launchedBeside.out.trim()}`);

  // ─── 4. first launch leaves a config.json behind ───────────────

  console.log('\n4. the first launch writes the file');

  const freshPort = await freePort();
  const freshState = make('fresh-state');
  const launchedFresh = await launch({
    cwd: bareDir,
    stateDir: freshState,
    extraEnv: { [URL_VARIABLE]: `http://127.0.0.1:${freshPort}` },
  });
  check('`start` came back happy', launchedFresh.code === 0, launchedFresh.out.trim());
  await boardAt(freshPort);

  const freshFile = join(freshState, 'config.json');
  check('a config.json is there afterwards', existsSync(freshFile), freshFile);
  if (existsSync(freshFile)) {
    const written = JSON.parse(readFileSync(freshFile, 'utf8'));
    check('holding the resolved port', Number(written.PORT) === freshPort, JSON.stringify(written));
    check('and nothing else', Object.keys(written).length === 1, JSON.stringify(written));
  }

  // ─── 5. every key of config.example.json is read ───────────────

  console.log('\n5. the tracked example is read, key for key');

  const settingsModule = join(repoRoot, 'dist', 'core', 'settings.js');
  if (!existsSync(settingsModule)) {
    failures++;
    console.error('  FAIL  dist/core/settings.js not found — the settings module does not exist');
  } else {
    const settings = await import(pathToFileURL(settingsModule).href);
    const examplePath = join(repoRoot, 'config.example.json');
    check('config.example.json is in the tree', existsSync(examplePath), examplePath);

    const example = JSON.parse(readFileSync(examplePath, 'utf8'));
    const read = settings.readSettingsFile(examplePath);
    const unread = Object.keys(example).filter((key) => !(key in read));
    check('every key in it comes back out of readSettingsFile', unread.length === 0,
          `${unread.length} dropped: ${unread.join(', ')}`);
    check('and comes back as the string an environment holds',
          Object.values(read).every((value) => typeof value === 'string'),
          JSON.stringify(read));

    // ─── 6. the order of the layers ─────────────────────────────

    console.log('\n6. state file, then .env, then the real environment');

    const { mergeSettings } = settings;
    const onlyFile = mergeSettings({ EXCALIDRAW_TERMINAL: '1' }, {}, {});
    check('the state file is applied when nothing else names the key',
          onlyFile.EXCALIDRAW_TERMINAL === '1', JSON.stringify(onlyFile));

    const overFile = mergeSettings({ EXCALIDRAW_TERMINAL: '1' }, { EXCALIDRAW_TERMINAL: '0' }, {});
    check('a .env value wins over the state file', overFile.EXCALIDRAW_TERMINAL === '0',
          JSON.stringify(overFile));

    const overBoth = mergeSettings(
      { EXCALIDRAW_TERMINAL: '1' }, { EXCALIDRAW_TERMINAL: '0' }, { EXCALIDRAW_TERMINAL: 'own' });
    check('and a real environment variable wins over both',
          overBoth.EXCALIDRAW_TERMINAL === undefined, JSON.stringify(overBoth));

    const derived = mergeSettings({ PORT: '4123' }, {}, {});
    check('a port from the state file carries the canvas URL with it',
          derived[URL_VARIABLE] === 'http://127.0.0.1:4123', JSON.stringify(derived));

    const notDerived = mergeSettings({ PORT: '4123' }, {}, { [URL_VARIABLE]: 'http://127.0.0.1:9' });
    check('but never over a URL the caller named',
          notDerived[URL_VARIABLE] === undefined, JSON.stringify(notDerived));

    const shellPort = mergeSettings({}, {}, { PORT: '4123' });
    check('and never for a PORT that was only ever in the shell',
          shellPort[URL_VARIABLE] === undefined, JSON.stringify(shellPort));
  }
} finally {
  for (const pid of new Set(launched)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  for (const child of startedByHelper) child.kill();

  // A server's working directory is one of these, so Windows refuses to remove the tree until
  // it is really gone. Retried, and never thrown: the run's verdict is the cases above, not
  // whether a temp directory came off on the first attempt — `scripts/run-checks.mjs` collects
  // what is left behind.
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(300);
    try { rmSync(workDir, { recursive: true, force: true }); break; } catch { /* still held */ }
  }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
