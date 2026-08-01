import { spawn } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import {
  EXPRESS_SERVER_URL, ENABLE_CANVAS_SYNC, EXCALIDRAW_NO_AUTOSTART, EXCALIDRAW_ALLOW_VERSION_SKEW
} from './config.js';
import { BIN_NAME, packageVersion } from './version.js';
import { getHealth, CANVAS_SERVICE_NAME, foreignServiceError, markCanvasIdentityVerified } from './canvas-client.js';
import { isAcceptedCanvasService } from './identity.js';
import { DEFAULT_CANVAS_PORT, removeCanvasState, whatIsOn } from './port.js';

export { foreignServiceError };
import { readPidFile, removePidFile, startupLogPath } from './pidfile.js';
import { boardUrlWithToken, removeAuthToken } from './auth-token.js';
import { ensureStateDir, realEnvironment, settingName } from './settings.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** How long a spawned server's death is allowed to be somebody else winning the race. */
const CONCURRENT_START_GRACE_MS = 2000;

export function canvasPort(): number {
  try {
    const url = new URL(EXPRESS_SERVER_URL);
    return parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
  } catch {
    return DEFAULT_CANVAS_PORT;
  }
}

function canvasHostname(): string {
  try {
    return new URL(EXPRESS_SERVER_URL).hostname;
  } catch {
    return '127.0.0.1';
  }
}

// The HOST the spawned server must bind so that health probes against
// EXPRESS_SERVER_URL actually reach it (e.g. [::1] URLs need an IPv6 bind).
function spawnBindHost(): string {
  const hostname = canvasHostname();
  if (hostname === 'localhost') return '127.0.0.1';
  return hostname.replace(/^\[|\]$/g, '');
}

function isLoopbackUrl(): boolean {
  return LOOPBACK_HOSTS.has(canvasHostname());
}

function unreachableError(reason: string): Error {
  const error = new Error(
    `Canvas server is not reachable at ${EXPRESS_SERVER_URL} (${reason}). ` +
    `Start it with \`${BIN_NAME} start\` or \`node dist/server.js\`.`
  );
  (error as any).code = 'CANVAS_UNREACHABLE';
  return error;
}

async function healthOrNull(timeoutMs = 500) {
  try {
    return await getHealth(timeoutMs);
  } catch {
    return null;
  }
}

// True only for a /health payload from OUR canvas server. Anything else
// answering the port is a foreign service.
//
// "Ours" is a list rather than one string: the marker is renamed in a later
// release than the one that starts accepting the new value, so that a canvas
// already running from the old build is still ours. See core/identity.ts.
export function isCanvasHealth(health: { service?: string } | null): boolean {
  return health !== null && isAcceptedCanvasService(health.service);
}

/**
 * The port is taken by something that is not us, and no scan is going to help — either the
 * caller pinned it or the resolution already walked past everything free. Naming the port and
 * what answers on it is the whole of the improvement: the old path spawned a server that could
 * not bind, threw its complaint into a log file, and told the caller only that eight seconds
 * had gone by.
 */
function portConflictError(port: number, occupant: string): Error {
  const error = new Error(
    `Canvas server cannot start on port ${port}: ${occupant} is already listening there. `
    + `Stop it, or set PORT to a free port — with PORT unset the launch path picks one itself.`
  );
  (error as any).code = 'CANVAS_UNREACHABLE';
  return error;
}

/** The last of what the spawned server said before it gave up, or '' if it said nothing. */
function startupLogTail(file: string, limit = 900): string {
  try {
    const text = fs.readFileSync(file, 'utf-8').trim();
    return text.length > limit ? `...${text.slice(-limit)}` : text;
  } catch {
    return '';
  }
}

export interface VersionSkew {
  /** What the running canvas says it was built from, or null when it cannot say at all. */
  running: string | null;
  /** What this process was built from. */
  installed: string;
  /** Whether the two are different — a canvas that names no version counts as different. */
  mismatch: boolean;
}

/**
 * Which build is answering, against which build is asking.
 *
 * A responder with no `version` at all is a **mismatch**, not an unknown. The field has been in
 * `/health` since #347, so a canvas that omits it is by construction from a build older than any
 * that could be reading this — which is precisely the case the comparison exists for, and the
 * one that would otherwise pass unnoticed for exactly as long as it mattered most.
 */
export function versionSkew(health: { version?: string } | null): VersionSkew {
  const installed = packageVersion();
  const running = typeof health?.version === 'string' ? health.version : null;
  return { running, installed, mismatch: running !== installed };
}

/** How a canvas of another build is named — the same sentence wherever it is said. */
export function describeSkew(skew: VersionSkew): string {
  return skew.running === null
    ? `The canvas server at ${EXPRESS_SERVER_URL} does not report a version, so it is from a `
      + `build older than this one (${skew.installed}).`
    : `The canvas server at ${EXPRESS_SERVER_URL} is version ${skew.running}; this one is `
      + `${skew.installed}.`;
}

/**
 * The refusal, and the reason it is a refusal rather than an automatic restart.
 *
 * Replacing the server would discard whatever the running board holds — the scene as the browser
 * has it, every terminal session, every coding agent mid-run — so it is the operator's decision
 * and not this function's. What is not acceptable is the third option the old code took: going
 * ahead against the old build, which is `docs/trap-stale-server.md` and is silent by definition.
 */
export function versionSkewError(skew: VersionSkew): Error {
  const error = new Error(
    // Neutral about which way the two run, because both happen: the ordinary case is a server
    // left behind by the previous release, and the other is a working copy older than what is
    // installed globally. Neither is the software the caller thinks it is driving.
    `${describeSkew(skew)} It is serving that build's code and frontend, so this command would `
    + `act on software that is not the one you installed. Replace it with `
    + `\`${BIN_NAME} restart\`, or set ${settingName('ALLOW_VERSION_SKEW')}=1 to use it as it is.`
  );
  // The same code an unreachable canvas gets, and for the same reason a caller cares about: from
  // this build's point of view there is no canvas here it can safely drive. A code of its own
  // would be a fifth number in an exit-code table documented in four places, bought for a
  // distinction no caller acts on differently.
  (error as any).code = 'CANVAS_UNREACHABLE';
  return error;
}

export interface EnsureResult {
  url: string;
  spawned: boolean;
}

/**
 * Make sure OUR canvas server is answering at EXPRESS_SERVER_URL,
 * auto-spawning a detached one on a loopback URL when needed. A healthy
 * responder without the service identity marker is a foreign service —
 * proceeding against it would only produce confusing downstream errors.
 *
 * `force: true` (the explicit `start` command) overrides the auto-start
 * opt-outs — an explicit start is user intent, not auto-start.
 *
 * A concurrent-spawn race is safe: the canvas server's loopback guard makes
 * the losing process exit, and every caller here only proceeds once /health
 * answers.
 */
export async function ensureCanvasRunning(options: { timeoutMs?: number; force?: boolean } = {}): Promise<EnsureResult> {
  const timeoutMs = options.timeoutMs ?? 8000;

  const existing = await healthOrNull();
  if (existing) {
    if (!isCanvasHealth(existing)) {
      throw foreignServiceError();
    }
    // Ours, and answering — but "ours" was never the same question as "this build". Attaching
    // here is what makes a stale server invisible: every request succeeds, against the code of
    // whatever release last held the port.
    const skew = versionSkew(existing);
    if (skew.mismatch && !EXCALIDRAW_ALLOW_VERSION_SKEW) {
      throw versionSkewError(skew);
    }
    markCanvasIdentityVerified();
    return { url: EXPRESS_SERVER_URL, spawned: false };
  }

  if (!options.force) {
    if (EXCALIDRAW_NO_AUTOSTART) {
      throw unreachableError(`auto-start disabled by ${settingName('NO_AUTOSTART')}=1`);
    }
    if (!ENABLE_CANVAS_SYNC) {
      throw unreachableError('auto-start disabled because ENABLE_CANVAS_SYNC=false');
    }
  }

  if (!isLoopbackUrl()) {
    throw unreachableError('refusing to auto-start a non-loopback canvas URL');
  }

  const port = canvasPort();
  const bindHost = spawnBindHost();

  // Asked before spawning, not after failing to. Nothing answered /health above, so anything
  // holding the port is either not HTTP or not a canvas — and a server we spawn onto it will
  // exit on EADDRINUSE eight seconds before the caller hears about it.
  const occupant = await whatIsOn(port, bindHost);
  if (occupant) {
    throw portConflictError(port, occupant);
  }

  // Cleared before the spawn rather than read blind after it: the server writes its own fatal
  // startup errors here (see startServer in server.ts), and a message left by an earlier
  // attempt on the same port would be relayed as this one's.
  const startupLog = startupLogPath(port);
  try { fs.rmSync(startupLog, { force: true }); } catch { /* nothing to clear */ }

  // dist/core/spawn.js -> dist/server.js; spawn args must be path strings
  const serverJs = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [serverJs], {
    detached: true,
    // `stdio: 'ignore'` stays, and the startup error still gets back here — through the file
    // above rather than through a pipe. Two reasons it is not a pipe: a detached child whose
    // parent has exited would be writing into a closed one, and #302 kept this spawn free of
    // inherited descriptors on purpose, because libuv skips `CREATE_NO_WINDOW` when a stdio
    // entry is one. The file is the same shape as the restart log next to it, and for the same
    // reason: by the time there is something to say, nobody is listening.
    stdio: 'ignore',
    // What every other spawn in this tree sets, and this one did not — including the other
    // detached one, the PTY reaper in terminal-session.ts. `detached` and `stdio: 'ignore'`
    // stay: the server has to outlive the CLI, and its output already goes to the log file
    // (utils/logger.ts) rather than to a console anybody could read.
    windowsHide: true,
    // The working directory the board gets, rather than the one the caller happened to be in
    // (#304). This spawn passed no `cwd` at all, so an MCP server attached to an editor
    // auto-started a canvas in *that editor's project* — which is where the warning in
    // `docs/running.md` comes from: the port is then held by something answering
    // `status: healthy` with no workspaces, no terminal and no agents. The state directory is
    // where `config.json` is, so it is also the directory whose `.env` the board reads: a
    // fixed pair, wherever the command was typed.
    cwd: ensureStateDir(),
    // The environment this process was *started* with, not the one it read its own files into.
    // The child does its own layering, from the directory above; passing `process.env` would
    // hand it the launch directory's `.env` as though it had been exported. `PORT` and `HOST`
    // are the exception on purpose — the caller has already resolved where this board goes
    // (`core/port.ts`), and the child must not resolve it a second time and differently.
    env: { ...realEnvironment(), PORT: String(port), HOST: bindHost }
  });
  child.unref();

  let exitCode: number | null = null;
  let diedAt: number | null = null;
  child.once('exit', code => { exitCode = code ?? 0; });
  logger.info(`Auto-starting canvas server (pid ${child.pid}) at ${EXPRESS_SERVER_URL}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await healthOrNull(400);
    if (isCanvasHealth(health)) {
      markCanvasIdentityVerified();
      // Name it when it is a scratch canvas. That is the ordinary case for a CLI command and
      // not a fault, but this same path once replaced somebody's configured board after a
      // terminal killed it, and the only thing that said so was a field nobody had reason to
      // read. A line here costs nothing and is read by whoever is confused later.
      const bare = (health as { workspaces?: string } | null)?.workspaces === 'none';
      // The address a person can actually use. Since #350 the board refuses an `/api` request
      // with no token, so the bare URL opened by hand is a page that loads and then does nothing
      // — this carries the token the server has just written, exactly as the launcher does, and
      // the page takes it back out of the address bar once it has read it. A board with no token
      // gets its URL back unchanged. On stderr, where this whole paragraph already was: it is
      // for a person, and `start`'s stdout stays the JSON a script parses.
      process.stderr.write(
        `Canvas server running at ${boardUrlWithToken(EXPRESS_SERVER_URL)} — open it in a browser for screenshots and mermaid conversion.\n`
        + (bare ? 'This one has no workspace registry and no terminal: a scratch canvas, not a configured board.\n' : '')
      );
      return { url: EXPRESS_SERVER_URL, spawned: true };
    }
    // It died rather than came up. Relayed with what it said, and now — waiting out the
    // remaining seven seconds to then report a timeout is describing the wrong event.
    //
    // But not instantly, because of the one case where our own child dying is not the answer:
    // two callers auto-starting at once. The loser exits on the loopback guard or EADDRINUSE
    // and the winner is a moment from healthy, and this path has always been allowed to end in
    // success for that reason. So the death opens a short window rather than closing the door,
    // and the loop above is still the one that decides.
    if (exitCode !== null) {
      if (diedAt === null) diedAt = Date.now();
      if (Date.now() - diedAt >= CONCURRENT_START_GRACE_MS) {
        const said = startupLogTail(startupLog);
        throw unreachableError(
          `the canvas server started on port ${port} exited with code ${exitCode} before answering /health`
          + (said ? `. It said:\n${said}` : `. It wrote nothing to ${startupLog}; the rest is in the platform log file`)
        );
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const stillThere = await whatIsOn(port, bindHost);
  const said = startupLogTail(startupLog);
  throw unreachableError(
    `the server auto-started on port ${port} did not answer /health within ${timeoutMs}ms `
    + `(${stillThere ?? 'and nothing is listening on that port now'})`
    + (said ? `. It said:\n${said}` : '')
  );
}

export interface StopResult {
  stopped: boolean;
  pid?: number;
  message: string;
}

/**
 * Stop the canvas server. Identity-safe: we only ever signal the pid that a
 * live /health responder reports about ITSELF, and only when it identifies
 * as this canvas service. A stale pidfile is cleaned up, never killed —
 * recycled pids and unrelated apps squatting on the port are safe.
 */
export async function stopCanvas(): Promise<StopResult> {
  const port = canvasPort();
  const filePid = readPidFile(port);
  const health = await healthOrNull(2000);

  if (!health) {
    if (filePid !== null) {
      removePidFile(port);
      removeCanvasState(port);
      // And the token beside them. A process killed outright never runs its own cleanup, and a
      // token left behind is a secret on disk for a server that no longer exists.
      removeAuthToken(port);
      return { stopped: false, pid: filePid, message: `Canvas server is not running; stale pidfile removed (pid ${filePid}).` };
    }
    removeCanvasState(port);
    removeAuthToken(port);
    return { stopped: false, message: 'Canvas server is not running.' };
  }

  // Require the identity marker AND a sane positive pid: pid 0 / negative
  // values would make process.kill signal our own process group.
  const pid = isCanvasHealth(health) && Number.isSafeInteger(health.pid) && (health.pid as number) > 0
    ? health.pid as number
    : null;
  if (pid === null) {
    throw foreignServiceError();
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    throw new Error(`Failed to signal canvas server (pid ${pid}): ${(error as Error).message}`);
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await healthOrNull(300))) {
      removePidFile(port);
      removeCanvasState(port);
      removeAuthToken(port);
      return { stopped: true, pid, message: `Canvas server (pid ${pid}) stopped.` };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  throw new Error(`Canvas server (pid ${pid}) did not stop within 5s.`);
}
