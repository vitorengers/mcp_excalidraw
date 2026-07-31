#!/usr/bin/env node
/**
 * Checks that this tool's configuration can be spelled with either prefix, and that the twenty-odd
 * variables it actually reads are the twenty-odd its documentation describes.
 *
 * `EXCALIDRAW_*` is the whole of the user's configuration and the product is now called
 * VibeMaxxing, so the prefix has to move. It cannot move in one commit: an operator whose
 * `config.json`, `.env` or shell profile names the old spelling would come up with no registry,
 * no terminal and no agents, on a board that answers `status: healthy`. So both prefixes are
 * read, `VIBEMAXXING_` first, and the old one says so once in the log file.
 *
 * Two hazards a find-and-replace misses, and both are cases here:
 *
 *   - `scripts/lib/spawn-canvas.mjs` deletes every inherited `EXCALIDRAW_*` before it starts a
 *     check's server, specifically so that the operator's machine cannot decide the result. A
 *     loop that strips one prefix strips nothing under the other, and the live board's
 *     configuration leaks back into ~130 checks (section 4).
 *   - the documentation states a count, and a count is a claim a machine can check. It said
 *     fifteen against an actual twenty-five (section 5).
 *
 * Self-contained: it writes its own registries under the system temp directory, starts its own
 * canvas servers on ports the kernel just handed out with a state home and a log file of their
 * own, and kills them. Nothing here talks to the board, to GitHub or to the network, and no
 * agent is ever spawned — the "agent" is `node --version`.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-env-prefix-compat.mjs
 *
 * Tier: fast
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const settingsModule = join(repoRoot, 'dist', 'core', 'settings.js');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** English for a count, so that a document asserting one can be compared against the code. */
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four',
  'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty',
];

// ─── The fixtures ────────────────────────────────────────────────

const workDir = join(tmpdir(), `check-env-prefix-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const make = (...parts) => {
  const dir = join(workDir, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function writeRegistry(id) {
  const project = make(`project-${id}`);
  writeFileSync(join(project, 'board.config.json'), JSON.stringify({ name: id }), 'utf8');
  const file = join(workDir, `registry-${id}.json`);
  writeFileSync(file, JSON.stringify({ workspaces: [{ id, path: project }] }), 'utf8');
  return file.replace(/\\/g, '/');
}

const sharedRegistry = writeRegistry('shared');
const newerRegistry = writeRegistry('newer');
const stateHome = make('state');

const started = [];
let logSeq = 0;

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
 * A canvas with exactly the variables a case names, and a log file of its own.
 *
 * The log file, because the deprecation notice goes there rather than to the console: the
 * console transport is warn and above, and a board whose whole configuration is legacy-spelled
 * would otherwise print a paragraph of stderr on every start.
 */
async function board(env) {
  const port = await freePort();
  const logFile = join(workDir, `server-${logSeq++}.log`);
  const canvas = startCanvas({
    port,
    env: { LOG_LEVEL: 'info', LOG_FILE_PATH: logFile, EXCALIDRAW_STATE_HOME: stateHome, ...env },
  });
  started.push(canvas);
  const health = await healthAt(port, canvas.child, canvas.read);
  return { port, health, logFile, read: canvas.read };
}

/**
 * What `/health` says this instance *is*, reduced to what a spelling can change.
 *
 * The agents are read down to `configured` rather than compared whole: since #404 each role
 * carries a live preflight — `resolved: "probing"` until the probe lands — and two servers
 * started a second apart would differ there for a reason that has nothing to do with prefixes.
 */
const identityOf = (health) => JSON.stringify({
  workspaces: health.workspaces,
  terminal: health.terminal,
  agents: {
    issue: health.agents?.issue?.configured ?? null,
    implement: health.agents?.implement?.configured ?? null,
  },
});

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

const readLog = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

try {
  if (!existsSync(settingsModule)) {
    console.error('  FAIL  dist/core/settings.js not found — run ./node_modules/.bin/tsc first');
    process.exit(1);
  }

  // ─── 1. only the legacy names ──────────────────────────────────

  console.log('\n1. a board configured with only the legacy EXCALIDRAW_* names');

  const legacy = await board({
    EXCALIDRAW_WORKSPACES: sharedRegistry,
    EXCALIDRAW_TERMINAL: '1',
    EXCALIDRAW_ISSUE_AGENT: 'node --version',
  });
  check('/health reports a registry', legacy.health.workspaces === 'configured',
        JSON.stringify(legacy.health.workspaces));
  check('and a terminal', legacy.health.terminal === true, JSON.stringify(legacy.health.terminal));
  check('and the issue agent it was given',
        legacy.health.agents?.issue?.configured === true, JSON.stringify(legacy.health.agents));

  // ─── 2. only the new names ─────────────────────────────────────

  console.log('\n2. the same board, spelled with the new prefix');

  const next = await board({
    VIBEMAXXING_WORKSPACES: sharedRegistry,
    VIBEMAXXING_TERMINAL: '1',
    VIBEMAXXING_ISSUE_AGENT: 'node --version',
  });
  check('it reports the same identity, field for field',
        identityOf(next.health) === identityOf(legacy.health),
        `new: ${identityOf(next.health)} — legacy: ${identityOf(legacy.health)}`);
  check('and lists the same project',
        await projectAt(next.port) === await projectAt(legacy.port),
        `${await projectAt(next.port)} vs ${await projectAt(legacy.port)}`);

  // ─── 3. both, and what the deprecation costs ───────────────────

  console.log('\n3. both spellings set');

  const both = await board({
    EXCALIDRAW_WORKSPACES: sharedRegistry,
    VIBEMAXXING_WORKSPACES: newerRegistry,
  });
  check('the new prefix wins', await projectAt(both.port) === 'newer',
        `the board listed ${JSON.stringify(await projectAt(both.port))}`);

  const legacyLog = readLog(legacy.logFile);
  const notices = legacyLog.split(/\r?\n/)
    .filter((line) => line.includes('EXCALIDRAW_WORKSPACES') && /deprecat/i.test(line));
  check('a legacy-spelled board says so in its log file', notices.length > 0,
        `nothing in ${legacy.logFile} mentioned it:\n${legacyLog}`);
  check('exactly once, though the variable is read from a dozen places',
        notices.length === 1, `${notices.length} lines:\n${notices.join('\n')}`);
  check('and it names the replacement',
        notices.some((line) => line.includes('VIBEMAXXING_WORKSPACES')), notices.join('\n'));

  // Only about the three this case set. The harness itself hands every server a legacy-spelled
  // `EXCALIDRAW_NO_DOTENV` and `EXCALIDRAW_STATE_HOME`, and those are correctly deprecated —
  // asserting on the whole file would be asserting that the notice does not work.
  const nextLog = readLog(next.logFile);
  const wrongly = nextLog.split(/\r?\n/)
    .filter((line) => /deprecat/i.test(line))
    .filter((line) => /EXCALIDRAW_(WORKSPACES|TERMINAL|ISSUE_AGENT)\b/.test(line));
  check('a board spelled the new way is told nothing about the names it used',
        wrongly.length === 0, wrongly.join('\n'));

  // ─── 4. the checks' own environment strips both prefixes ───────
  //
  // The one that a find-and-replace loses. `canvasEnvironment` exists so that the operator's
  // machine cannot decide a check's result; under a second prefix a loop that strips only the
  // first strips nothing.

  console.log('\n4. an inherited VIBEMAXXING_* is stripped before a check\'s server starts');

  process.env.VIBEMAXXING_TERMINAL = '1';
  process.env.VIBEMAXXING_WORKSPACES = newerRegistry;

  const stripped = canvasEnvironment({});
  check('canvasEnvironment drops it from the environment it builds',
        !Object.keys(stripped).some((key) => key.startsWith('VIBEMAXXING_')),
        `it kept ${JSON.stringify(Object.keys(stripped).filter((key) => key.startsWith('VIBEMAXXING_')))}`);

  const inherited = await board({});
  check('so a server started through the helper gets neither',
        inherited.health.terminal === false && inherited.health.workspaces === 'none',
        JSON.stringify({
          terminal: inherited.health.terminal,
          workspaces: inherited.health.workspaces,
        }));
  delete process.env.VIBEMAXXING_TERMINAL;
  delete process.env.VIBEMAXXING_WORKSPACES;

  // ─── 5. the documentation and the accessor agree ───────────────

  console.log('\n5. the documentation describes the variables the accessor knows about');

  const probe = join(workDir, 'probe.mjs');
  writeFileSync(probe, [
    `import { SETTINGS } from ${JSON.stringify(pathToFileURL(settingsModule).href)};`,
    'process.stdout.write(JSON.stringify(SETTINGS.map((setting) => setting.name)));',
    '',
  ].join('\n'), 'utf8');

  const names = await new Promise((resolve) => {
    execFile(process.execPath, [probe], { env: { ...process.env } }, (error, stdout, stderr) => {
      if (error) resolve({ error: `${error.message}\n${stderr}` });
      else {
        try { resolve({ names: JSON.parse(stdout) }); } catch { resolve({ error: `not JSON: ${stdout}` }); }
      }
    });
  });

  check('SETTINGS is exported and is a list of names', Array.isArray(names.names),
        names.error ?? JSON.stringify(names));

  if (Array.isArray(names.names)) {
    const running = readFileSync(join(repoRoot, 'docs', 'running.md'), 'utf8');
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

    const documented = [...running.matchAll(/^\|\s*`EXCALIDRAW_([A-Z_]+)`/gm)].map((match) => match[1]);
    const missing = names.names.filter((name) => !documented.includes(name));
    const extra = documented.filter((name) => !names.names.includes(name));
    check('every variable the accessor reads has a row in running.md',
          missing.length === 0, missing.join(', '));
    check('and running.md documents nothing the accessor does not read',
          extra.length === 0, extra.join(', '));

    const total = names.names.length;
    const windowsOnly = names.names.filter((name) => name.endsWith('_WSL')).length;
    const crossPlatform = total - windowsOnly;
    check(`running.md counts the ${NUMBER_WORDS[crossPlatform]} cross-platform ones`,
          running.includes(`The ${NUMBER_WORDS[crossPlatform]} below`),
          `running.md does not say "The ${NUMBER_WORDS[crossPlatform]} below"`);
    check(`and the README counts all ${NUMBER_WORDS[total]}`,
          readme.includes(`all ${NUMBER_WORDS[total]} \`EXCALIDRAW_*\` variables`),
          `the README does not say "all ${NUMBER_WORDS[total]} \`EXCALIDRAW_*\` variables"`);
  }
} finally {
  for (const canvas of started) canvas.stop();
  await sleep(300);
  rmSync(workDir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
