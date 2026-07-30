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
