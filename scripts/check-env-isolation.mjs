#!/usr/bin/env node
/**
 * Checks that a check's canvas server gets the environment the check gave it, and not the one
 * the machine happens to be holding.
 *
 * `src/server.ts` and `src/core/config.ts` both call `dotenv.config()` with no argument, so the
 * server reads `<cwd>/.env` — and a hundred of the `scripts/check-*.mjs` spawn it with
 * `cwd: repoRoot`, where this machine keeps an untracked `.env` with eleven `EXCALIDRAW_*`
 * values in it. dotenv never overwrites a variable that is already set, which sounds harmless
 * and is exactly backwards: the only variables it can restore are the ones a check deliberately
 * removed.
 *
 * `check-workspace-settings.mjs` builds its "nothing granted" server by deleting
 * `EXCALIDRAW_IMPLEMENT_AGENT` and then POSTs `/api/implement` expecting a 404. On a machine
 * with an `.env`, dotenv handed that server the operator's real
 * `claude.exe -p --dangerously-skip-permissions` back, so running the check started a coding
 * agent against a fabricated issue URL. `check-health-identity.mjs` strips every `EXCALIDRAW_*`
 * from the child environment for the same reason and was defeated the same way.
 *
 * The fixture below is the defect in miniature: a `.env` in the server's working directory
 * naming a registry that does not exist and agents that are not there. Case 1 proves the fixture
 * is real by letting dotenv read it. Cases 2 onward are the fix — `EXCALIDRAW_NO_DOTENV=1`,
 * which `scripts/lib/spawn-canvas.mjs` sets for every check.
 *
 * Self-contained: it writes a throwaway working directory, starts its own canvas servers on
 * ports the kernel allocated and kills them. Nothing here talks to the board, to GitHub or to
 * the network, and no agent is ever spawned — the `.env` names `node --version`.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-env-isolation.mjs
 *
 * Tier: fast
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workDir = join(tmpdir(), `env-isolation-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// The stand-in for the operator's untracked `.env`. Every value here is a lie the server would
// otherwise believe: a registry path that does not exist, and two "agents" that are `node
// --version` so that a run which wrongly starts one still cannot do anything.
const bogusRegistry = join(workDir, 'nowhere', 'workspaces.json').replace(/\\/g, '/');
const dotenvFile = join(workDir, '.env');
writeFileSync(dotenvFile, [
  `EXCALIDRAW_WORKSPACES=${bogusRegistry}`,
  'EXCALIDRAW_ISSUE_AGENT=node --version',
  'EXCALIDRAW_IMPLEMENT_AGENT=node --version',
  'EXCALIDRAW_TERMINAL=1',
  '',
].join('\n'), 'utf8');

// A second file, somewhere else, for the `EXCALIDRAW_ENV_FILE` case.
const elsewhereFile = join(workDir, 'elsewhere.env');
writeFileSync(elsewhereFile, 'EXCALIDRAW_ISSUE_AGENT=node --version\n', 'utf8');

const started = [];

async function healthOf(port, child, read, attempts = 120) {
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

/** The one server in this file that is allowed to read the `.env`. */
async function startWithDotenv(extraEnv = {}) {
  const port = await freePort();
  const canvas = startCanvas({
    port, cwd: workDir, allowDotenv: true, env: { LOG_LEVEL: 'error', ...extraEnv },
  });
  started.push(canvas.child);
  return { port, health: await healthOf(port, canvas.child, canvas.read) };
}

async function startThroughHelper(extraEnv = {}, cwd = workDir) {
  const port = await freePort();
  const canvas = startCanvas({ port, cwd, env: { LOG_LEVEL: 'error', ...extraEnv } });
  started.push(canvas.child);
  return { port, health: await healthOf(port, canvas.child, canvas.read) };
}

try {
  // ─── The fixture is real ──────────────────────────────────────
  //
  // Without this the rest of the file could pass because the `.env` was never readable, which
  // is the way a check quietly stops checking anything.

  console.log('\nA server that is allowed to read the .env');

  const withDotenv = await startWithDotenv();
  check('the .env in the working directory reaches the server',
    withDotenv.health.workspaces === 'configured',
    `/health said workspaces: ${JSON.stringify(withDotenv.health.workspaces)}`);
  check('and its agents are configured from the file too',
    withDotenv.health.agents?.issue?.configured === true
    && withDotenv.health.agents?.implement?.configured === true,
    JSON.stringify(withDotenv.health.agents));

  // ─── EXCALIDRAW_ENV_FILE moves the file ──────────────────────

  console.log('\nEXCALIDRAW_ENV_FILE names the file instead');

  const elsewhere = await startWithDotenv({ EXCALIDRAW_ENV_FILE: elsewhereFile });
  check('the named file is read', elsewhere.health.agents?.issue?.configured === true,
    JSON.stringify(elsewhere.health.agents));
  check('and the .env beside the working directory is not',
    elsewhere.health.workspaces === 'none'
    && elsewhere.health.agents?.implement?.configured === false,
    `/health said ${JSON.stringify({ workspaces: elsewhere.health.workspaces, agents: elsewhere.health.agents })}`);

  // ─── The fix ─────────────────────────────────────────────────

  console.log('\nA server started the way every check starts one');

  const isolated = await startThroughHelper();
  check('/health reports workspaces: none with an .env sitting next to it',
    isolated.health.workspaces === 'none',
    `/health said workspaces: ${JSON.stringify(isolated.health.workspaces)} — the .env was read`);
  check('neither agent is configured',
    isolated.health.agents?.issue?.configured === false
    && isolated.health.agents?.implement?.configured === false,
    JSON.stringify(isolated.health.agents));
  check('and the terminal the .env asked for is off',
    isolated.health.terminal === false,
    `/health said terminal: ${JSON.stringify(isolated.health.terminal)}`);

  // ─── What the check does grant still arrives ─────────────────
  //
  // Isolation that also blocks the check's own values would be useless. The point is that the
  // check decides, not that nothing gets through.

  console.log('\nThe values the check itself sets');

  const granted = await startThroughHelper({ EXCALIDRAW_ISSUE_AGENT: 'node --version' });
  check('an agent the check granted is configured',
    granted.health.agents?.issue?.configured === true, JSON.stringify(granted.health.agents));
  check('and one it did not grant is still off, .env or no .env',
    granted.health.agents?.implement?.configured === false, JSON.stringify(granted.health.agents));

  // ─── The parent process cannot decide either ─────────────────

  console.log('\nAn EXCALIDRAW_* held by the process running the check');

  process.env.EXCALIDRAW_WORKSPACES = bogusRegistry;
  process.env.EXCALIDRAW_IMPLEMENT_AGENT = 'node --version';
  process.env.EXCALIDRAW_TERMINAL = '1';
  const inherited = await startThroughHelper({}, workDir);
  check('is stripped before the child is spawned',
    inherited.health.workspaces === 'none'
    && inherited.health.agents?.implement?.configured === false
    && inherited.health.terminal === false,
    JSON.stringify({
      workspaces: inherited.health.workspaces,
      agents: inherited.health.agents,
      terminal: inherited.health.terminal,
    }));

  // ─── And PORT in the shell cannot retarget the board ─────────

  console.log('\nPORT in the environment running the check');

  process.env.PORT = '3737';
  const ownPort = await freePort();
  const own = startCanvas({ port: ownPort, cwd: workDir, env: { LOG_LEVEL: 'error' } });
  started.push(own.child);
  const ownHealth = await healthOf(ownPort, own.child, own.read);
  check('does not decide the port the check\'s own server binds',
    ownHealth.pid === own.child.pid,
    `the server answering on ${ownPort} was pid ${ownHealth.pid}, the child is ${own.child.pid}`);
} finally {
  for (const child of started) child.kill();
  await sleep(300);
  rmSync(workDir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
