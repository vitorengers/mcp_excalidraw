#!/usr/bin/env node
/**
 * Checks the order the four configuration layers resolve in, and that a `<cwd>/.env` says so
 * once when it is read.
 *
 * #304 gave this tool a `config.json` in a per-OS state directory so that the launch directory
 * stops deciding what the board is. What it did not do is write the order down anywhere a
 * machine can read it: `mergeSettings` folded the two file layers under the environment, and
 * every caller then read `process.env.EXCALIDRAW_*` for itself. An order that only exists as
 * the shape of one function is an order the next read site can quietly get wrong, and the
 * failure mode is a board that answers `status: healthy` with somebody else's registry.
 *
 * So the order is stated here as four cases, lowest layer first:
 *
 *   1. `<state-dir>/config.json`
 *   2. `<cwd>/.env`
 *   3. the real environment
 *   4. an explicit override — what a command-line flag supplies
 *
 * Each case adds one layer on top of the one below it and asserts the board changed its mind.
 * `/api/workspaces` is what it is read off, not `/health`: `/health` only says `configured` or
 * `none`, and every layer here is configured — a check that could not tell *which* registry
 * won would pass for all four orders.
 *
 * Layers 1 to 3 are asserted against real servers, deliberately. The risk this whole change
 * carries is a setting that resolves to the wrong layer at runtime while compiling perfectly,
 * so a check that imported the resolver and asserted its return value would be asserting the
 * half that cannot fail. Layer 4 has no command-line surface today — nothing maps a flag to an
 * `EXCALIDRAW_*` setting, `--url` overrides the canvas URL, which this module does not own —
 * so it is asserted through `resolveSetting` in a child process instead, and says so.
 *
 * Sections 5 and 6 are the deprecation notice: a `.env` that is read produces exactly one
 * warning line naming the file, and a board that read no `.env` produces none. Exactly one
 * matters — `EXCALIDRAW_WORKSPACES` alone is read from a dozen places, and a notice per read
 * is a notice nobody finishes.
 *
 * Self-contained: it writes its own state homes, launch directories and registries under the
 * system temp directory, starts its own canvas servers on ports the kernel just handed out,
 * and kills them. `EXCALIDRAW_STATE_HOME` keeps it out of the operator's own state directory,
 * nothing here talks to the board, to GitHub or to the network, and no agent is ever spawned.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-settings-precedence.mjs
 *
 * Tier: fast
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const settingsModule = join(repoRoot, 'dist', 'core', 'settings.js');

/**
 * The application's own folder inside the state home, spelled as `core/settings.ts` spells it.
 *
 * `EXCALIDRAW_STATE_HOME` redirects the *parent*, so a check that plants a `config.json` has to
 * know the leaf. Read from `process.platform` for the same reason the module does.
 */
const STATE_LEAF = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The fixtures ────────────────────────────────────────────────

const workDir = join(tmpdir(), `check-settings-precedence-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const make = (...parts) => {
  const dir = join(workDir, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A registry with one project in it, named so that a listing says which layer it came from. */
function writeRegistry(id) {
  const project = make(`project-${id}`);
  writeFileSync(join(project, 'board.config.json'), JSON.stringify({ name: id }), 'utf8');
  const file = join(workDir, `registry-${id}.json`);
  writeFileSync(file, JSON.stringify({ workspaces: [{ id, path: project }] }), 'utf8');
  return file.replace(/\\/g, '/');
}

const fromFile = writeRegistry('from-config-json');
const fromEnvFile = writeRegistry('from-dotenv');
const fromEnvironment = writeRegistry('from-environment');

/** A state home with a `config.json` in the directory the tool looks in. */
function stateHomeWith(name, values) {
  const home = make(name);
  const dir = make(name, STATE_LEAF);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(values, null, 2), 'utf8');
  return home;
}

/** A launch directory, with a `.env` in it or without one. */
function launchDirWith(name, lines) {
  const dir = make(name);
  if (lines) writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`, 'utf8');
  return dir;
}

const stateWithRegistry = stateHomeWith('state-with-registry', {
  EXCALIDRAW_WORKSPACES: fromFile,
});
const stateEmpty = make('state-empty');

const bareDir = launchDirWith('bare', null);
const dotenvDir = launchDirWith('with-dotenv', [`EXCALIDRAW_WORKSPACES=${fromEnvFile}`]);

const started = [];

async function healthAt(port, child, read, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server on ${port} never came up:\n${read()}`);
}

/**
 * A canvas with the file layers **on**, from a working directory the case chooses.
 *
 * `allowDotenv` because a check about which file decides cannot start by turning the files off,
 * and `EXCALIDRAW_STATE_HOME` because the alternative is reading the operator's own.
 */
async function board({ cwd, stateHome, env = {} }) {
  const port = await freePort();
  const canvas = startCanvas({
    port,
    cwd,
    allowDotenv: true,
    env: { LOG_LEVEL: 'warn', EXCALIDRAW_STATE_HOME: stateHome, ...env },
  });
  started.push(canvas);
  const health = await healthAt(port, canvas.child, canvas.read);
  return { port, health, read: canvas.read };
}

/** Which registry won, by the id of the one project in it. */
async function projectAt(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
    if (!response.ok) return null;
    const body = await response.json();
    return (body?.workspaces ?? []).map((workspace) => workspace.id).join(',');
  } catch {
    return null;
  }
}

/** How many lines of a server's output name `file`. */
const linesNaming = (output, file) =>
  output.split(/\r?\n/).filter((line) => line.includes(file)).length;

try {
  if (!existsSync(settingsModule)) {
    console.error('  FAIL  dist/core/settings.js not found — run ./node_modules/.bin/tsc first');
    process.exit(1);
  }

  // ─── 1. the settings file, from a directory with no .env ───────
  //
  // The fixture proof as well as the first layer: if `config.json` were not readable at all,
  // every case below would pass for the wrong reason.

  console.log('\n1. <state-dir>/config.json, from a working directory holding no .env');

  const one = await board({ cwd: bareDir, stateHome: stateWithRegistry });
  check('/health reports a registry', one.health.workspaces === 'configured',
        `/health said workspaces: ${JSON.stringify(one.health.workspaces)}`);
  check('and it is the one config.json named',
        await projectAt(one.port) === 'from-config-json',
        `the board listed ${JSON.stringify(await projectAt(one.port))}`);

  // ─── 2. a <cwd>/.env beats the settings file ───────────────────

  console.log('\n2. a <cwd>/.env beats it');

  const two = await board({ cwd: dotenvDir, stateHome: stateWithRegistry });
  check('the .env in the working directory wins',
        await projectAt(two.port) === 'from-dotenv',
        `the board listed ${JSON.stringify(await projectAt(two.port))}`);

  // ─── 3. the environment beats both files ───────────────────────
  //
  // Not a style choice: it is what keeps the ~130 checks in scripts/ working, every one of
  // which configures a throwaway server by setting EXCALIDRAW_* in the spawn environment.

  console.log('\n3. the real environment beats both files');

  const three = await board({
    cwd: dotenvDir,
    stateHome: stateWithRegistry,
    env: { EXCALIDRAW_WORKSPACES: fromEnvironment },
  });
  check('what the process was started with wins',
        await projectAt(three.port) === 'from-environment',
        `the board listed ${JSON.stringify(await projectAt(three.port))}`);

  // ─── 4. an explicit override beats the environment ─────────────
  //
  // Through `resolveSetting` rather than a server, because no flag maps to a setting yet. The
  // three cases above are the ones a server can be wrong about; this one is the order itself.

  console.log('\n4. an explicit override — the layer a command-line flag supplies');

  const probe = join(workDir, 'probe.mjs');
  writeFileSync(probe, [
    `import { resolveSetting } from ${JSON.stringify(pathToFileURL(settingsModule).href)};`,
    'const layers = {',
    '  file: { EXCALIDRAW_WORKSPACES: "file" },',
    '  envFile: { EXCALIDRAW_WORKSPACES: "envFile" },',
    '  environment: { EXCALIDRAW_WORKSPACES: "environment" },',
    '  flag: { EXCALIDRAW_WORKSPACES: "flag" },',
    '};',
    'const drop = (...names) => {',
    '  const kept = { ...layers };',
    '  for (const name of names) delete kept[name];',
    '  return resolveSetting("WORKSPACES", kept);',
    '};',
    'process.stdout.write(JSON.stringify({',
    '  all: drop(),',
    '  noFlag: drop("flag"),',
    '  filesOnly: drop("flag", "environment"),',
    '  fileOnly: drop("flag", "environment", "envFile"),',
    '  none: drop("flag", "environment", "envFile", "file"),',
    '}));',
    '',
  ].join('\n'), 'utf8');

  const resolved = await new Promise((resolve) => {
    execFile(process.execPath, [probe], { env: { ...process.env } }, (error, stdout, stderr) => {
      if (error) resolve({ error: `${error.message}\n${stderr}` });
      else {
        try { resolve(JSON.parse(stdout)); } catch { resolve({ error: `not JSON: ${stdout}` }); }
      }
    });
  });

  check('the resolver is exported and runs', !resolved.error, resolved.error ?? '');
  check('a flag beats all three', resolved.all === 'flag', JSON.stringify(resolved.all));
  check('with no flag the environment wins', resolved.noFlag === 'environment', JSON.stringify(resolved.noFlag));
  check('with neither, the .env wins', resolved.filesOnly === 'envFile', JSON.stringify(resolved.filesOnly));
  check('with only the settings file, it wins', resolved.fileOnly === 'file', JSON.stringify(resolved.fileOnly));
  check('and an unset setting is undefined, not empty', resolved.none === undefined, JSON.stringify(resolved.none));

  // ─── 5. a .env that is read says so, once ──────────────────────

  console.log('\n5. a <cwd>/.env that is loaded warns, naming the file');

  const dotenvFile = join(dotenvDir, '.env');
  const naming = linesNaming(two.read(), dotenvFile);
  check('the server warned about the file it loaded', naming > 0,
        `nothing in the server output named ${dotenvFile}:\n${two.read()}`);
  check('exactly once, however many settings were read of it', naming === 1,
        `${naming} lines named it:\n${two.read()}`);

  // ─── 6. and a board that read none says nothing ────────────────

  console.log('\n6. a board with no .env in reach says nothing about one');

  const six = await board({ cwd: bareDir, stateHome: stateEmpty });
  check('it came up', six.health.status === 'healthy', JSON.stringify(six.health.status));
  check('and warned about no .env at all',
        !/\.env/i.test(six.read()), `the server said:\n${six.read()}`);
} finally {
  for (const canvas of started) canvas.stop();
  await sleep(300);
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
