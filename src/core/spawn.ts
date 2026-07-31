import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { EXPRESS_SERVER_URL, ENABLE_CANVAS_SYNC, EXCALIDRAW_NO_AUTOSTART } from './config.js';
import { getHealth, CANVAS_SERVICE_NAME, foreignServiceError, markCanvasIdentityVerified } from './canvas-client.js';
import { isAcceptedCanvasService } from './identity.js';
import { DEFAULT_CANVAS_PORT, removeCanvasState, whatIsOn } from './port.js';

export { foreignServiceError };
import { readPidFile, removePidFile, spawnLogPath } from './pidfile.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

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
    `Start it with \`mcp-excalidraw-server start\` or \`node dist/server.js\`.`
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
function spawnLogTail(file: string, limit = 900): string {
  try {
    const text = fs.readFileSync(file, 'utf-8').trim();
    return text.length > limit ? `...${text.slice(-limit)}` : text;
  } catch {
    return '';
  }
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
    markCanvasIdentityVerified();
    return { url: EXPRESS_SERVER_URL, spawned: false };
  }

  if (!options.force) {
    if (EXCALIDRAW_NO_AUTOSTART) {
      throw unreachableError('auto-start disabled by EXCALIDRAW_NO_AUTOSTART=1');
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

  // Its stderr, in a file the parent can read back. `stdio: 'ignore'` was why a startup failure
  // reached nobody: the server does say what went wrong, and it said it into the void.
  const logFile = spawnLogPath(port);
  let logFd: number | null = null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    logFd = fs.openSync(logFile, 'w');
  } catch { /* the spawn is worth more than its log */ }

  // dist/core/spawn.js -> dist/server.js; spawn args must be path strings
  const serverJs = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [serverJs], {
    detached: true,
    stdio: ['ignore', 'ignore', logFd ?? 'ignore'],
    env: { ...process.env, PORT: String(port), HOST: bindHost }
  });
  child.unref();
  // Ours is closed once the child holds its own; leaving it open would keep this process alive.
  if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* already closed */ } }

  let exitCode: number | null = null;
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
      process.stderr.write(
        `Canvas server running at ${EXPRESS_SERVER_URL} — open it in a browser for screenshots and mermaid conversion.\n`
        + (bare ? 'This one has no workspace registry and no terminal: a scratch canvas, not a configured board.\n' : '')
      );
      return { url: EXPRESS_SERVER_URL, spawned: true };
    }
    // It died rather than came up. Relayed with what it said, and now — waiting out the
    // remaining seven seconds to then report a timeout is describing the wrong event.
    if (exitCode !== null) {
      const said = spawnLogTail(logFile);
      throw unreachableError(
        `the canvas server started on port ${port} exited with code ${exitCode} before answering /health`
        + (said ? `. It said:\n${said}` : `. Its output is in ${logFile}`)
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const stillThere = await whatIsOn(port, bindHost);
  const said = spawnLogTail(logFile);
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
      return { stopped: false, pid: filePid, message: `Canvas server is not running; stale pidfile removed (pid ${filePid}).` };
    }
    removeCanvasState(port);
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
      return { stopped: true, pid, message: `Canvas server (pid ${pid}) stopped.` };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  throw new Error(`Canvas server (pid ${pid}) did not stop within 5s.`);
}
