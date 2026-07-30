/**
 * Start a canvas server for a check, with an environment the check decides and the machine does
 * not.
 *
 * Two things used to leak in, and both of them decided answers the check thought it was
 * asserting:
 *
 * 1. `{ ...process.env }` carried the operator's own `EXCALIDRAW_*` into the child, so a browser
 *    check inherited `EXCALIDRAW_TERMINAL=1` and got a terminal overlay it never asked for.
 * 2. Worse, the server calls `dotenv.config()` on startup, and the checks spawn it with
 *    `cwd: repoRoot`, where an untracked `.env` sits. dotenv does not overwrite a variable that
 *    is already set, so the only variables it could restore were exactly the ones a check had
 *    deliberately deleted. `check-workspace-settings.mjs` builds a server with no implement agent
 *    to prove `/api/implement` answers 404; on a machine with an `.env` it got the operator's
 *    real `claude.exe -p --dangerously-skip-permissions` back and started a coding agent against
 *    a fabricated issue.
 *
 * So: every inherited `EXCALIDRAW_*` is deleted before the check's own values are applied, and
 * `EXCALIDRAW_NO_DOTENV=1` tells the server not to read the file at all. `PORT` and `HOST` go the
 * same way — `PORT=3737` is in this machine's session environment, and a check that inherited it
 * would health-check the operator's live board instead of its own server.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort } from './free-port.mjs';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const serverPath = join(repoRoot, 'dist', 'server.js');

/**
 * The environment a canvas server should be started with: this process's, with everything the
 * machine could smuggle in removed, and `overrides` applied on top. Exported for the checks that
 * build their environment in one place and start several servers from it.
 *
 * A key whose value is `undefined` in `overrides` is left unset rather than becoming the string
 * `"undefined"`, so `{ EXCALIDRAW_TERMINAL_PTY: undefined }` reads as "this one is off".
 */
export function canvasEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('EXCALIDRAW_')) delete env[key];
  }
  delete env.PORT;
  delete env.HOST;
  env.EXCALIDRAW_NO_DOTENV = '1';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/**
 * Start `dist/server.js` and return the child together with a reader for everything it has
 * written so far. The streams are drained here, so a check that never reads cannot deadlock the
 * child on a full pipe, and a check that wants the log on failure has it without wiring up its
 * own listeners.
 *
 * `port` may be given directly or as `PORT` inside `env`; the two are the same thing and
 * whichever is present wins, `port` first. `HOST` defaults to loopback, which is what every
 * check wants and what the board itself is bound to.
 */
export function startCanvas({ port, env = {}, cwd = repoRoot, script = serverPath, allowDotenv = false } = {}) {
  const resolvedPort = port ?? env.PORT;
  if (resolvedPort === undefined) {
    throw new Error('startCanvas: no port — pass { port } or set PORT in { env }');
  }
  const childEnv = canvasEnvironment({ HOST: '127.0.0.1', ...env, PORT: String(resolvedPort) });
  // One caller, on purpose: `check-env-isolation.mjs` has to watch a server read the `.env`
  // before it can claim the other servers are not reading it. A fixture nobody proved is real
  // is how a check quietly stops checking anything.
  if (allowDotenv) delete childEnv.EXCALIDRAW_NO_DOTENV;
  const child = spawn(process.execPath, [script], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  return {
    child,
    port: Number(resolvedPort),
    base: `http://127.0.0.1:${resolvedPort}`,
    read: () => log,
    stop: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The canvas a check names on its command line, or null for the one it will start itself.
 *
 * There used to be a third answer. Eight checks read `--url`, then `EXPRESS_SERVER_URL`, then
 * fell back to `http://127.0.0.1:3000` — a port `docs/trap-port-3000.md` says can never work
 * on the machine they were written on, and one nothing in the repository ever started. So the
 * common case, `node scripts/check-<name>.mjs` with no arguments, could only ever fail at
 * connect, and the convention that made it work — a second server on 3838, started by hand
 * with the right stubs — lived in prose and in one operator's habits.
 *
 * What is left is one explicit answer and one implicit one: a maintainer who says `--url` is
 * pointing a check at a board they are looking at, which is a real debugging move; everybody
 * else gets a server the check starts, on a port the kernel just handed out, and kills. The
 * environment gets no vote at all — `EXPRESS_SERVER_URL` is gone from the checks for the
 * reason `canvasEnvironment` deletes `PORT`: a check whose target is decided by a variable
 * somebody exported months ago is a check that asserts an unknown server.
 */
export function urlOverride(argv = process.argv) {
  const at = argv.indexOf('--url');
  if (at === -1) return null;
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--url needs the address of a running canvas, e.g. --url http://127.0.0.1:3737');
  }
  return value.replace(/\/+$/, '');
}

/**
 * A canvas to run cases against: the one `--url` named, or one started here and answering.
 *
 * `stop()` and `read()` are there either way, so a check's `finally` does not have to know
 * which of the two it got. For a server somebody else started they do nothing — killing a
 * board the maintainer is looking at would be a surprising thing for a check to do.
 */
export async function openCanvas({ url = null, env = {}, cwd = repoRoot } = {}) {
  if (url) return { base: url.replace(/\/+$/, ''), external: true, read: () => '', stop: () => {} };

  const server = startCanvas({ port: await freePort(), env, cwd });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the canvas server exited early:\n${server.read()}`);
    }
    try {
      if ((await fetch(`${server.base}/health`)).ok) return { ...server, external: false };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  server.stop();
  throw new Error(`the canvas server never answered on ${server.base}:\n${server.read()}`);
}
