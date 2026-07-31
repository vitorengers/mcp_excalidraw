import fs from 'fs';
import net from 'net';
import path from 'path';
import { isAcceptedCanvasService } from './identity.js';
import { stateDir, stateDirCandidates } from './pidfile.js';

/**
 * Where the canvas listens when nobody said.
 *
 * Not 3000. That number is the default of Next.js, Create React App, Rails and most tutorial
 * servers, so the one machine most likely to be running something else on it is a developer's —
 * and on the machine this fork is developed on it can never work at all, because a Windows
 * portproxy rule maps it to itself (`docs/trap-port-3000.md`). The board has run on 3737 out of
 * a gitignored `.env` for months; this makes that the shipped answer instead of one operator's
 * habit.
 */
export const DEFAULT_CANVAS_PORT = 3737;

/** How far up from the preferred port the scan will walk before giving up. */
export const PORT_SCAN_LIMIT = 64;

const HOST_FALLBACK = '127.0.0.1';

/** `0.0.0.0` and `::` are bind addresses, not places to send a request. */
function addressable(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === 'localhost' || host === '') return HOST_FALLBACK;
  return host.replace(/^\[|\]$/g, '');
}

export function canvasUrlFor(port: number, host: string = HOST_FALLBACK): string {
  const target = addressable(host);
  return `http://${target.includes(':') ? `[${target}]` : target}:${port}`;
}

/**
 * The port the caller pinned, or null.
 *
 * A pinned port is a hard override that never scans: a script that starts the board on the port
 * its other half will talk to, a published container, a firewall rule — each needs the answer to
 * be the number it gave, and a helpful move to the next free port would be a board none of them
 * can find.
 */
export function explicitPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.PORT;
  if (!raw) return null;
  const port = parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Where a scan starts. `EXCALIDRAW_CANVAS_PORT` is a *preference* rather than a pin — it says
 * which port to try first and leaves the search free to walk past it.
 */
export function preferredPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXCALIDRAW_CANVAS_PORT;
  if (raw) {
    const port = parseInt(raw, 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return DEFAULT_CANVAS_PORT;
}

/**
 * Whether this process could bind `port` on `host` right now.
 *
 * The probe is unref'd and closed on both paths. A server object left behind by a failed
 * `listen` keeps the event loop alive, and this runs on the way in to every CLI invocation:
 * one leaked handle and the command does its work and then never exits.
 */
export function isPortFree(port: number, host: string = HOST_FALLBACK): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => { probe.close(); resolve(false); });
    probe.listen(port, addressable(host), () => probe.close(() => resolve(true)));
  });
}

/**
 * The first free port at or above `from`.
 *
 * There is a race between this answer and the caller's own bind, and it cannot be closed from
 * here — only narrowed. A caller that loses it sees `EADDRINUSE` from the server it started,
 * which is a failure with a name on it rather than a silent collision.
 */
export async function findFreePort(from: number, host: string = HOST_FALLBACK): Promise<number> {
  for (let port = from; port < from + PORT_SCAN_LIMIT && port < 65536; port++) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(
    `No free port between ${from} and ${from + PORT_SCAN_LIMIT - 1}. `
    + 'Set PORT to one that is free.'
  );
}

/**
 * What is on `port`, in words a person can act on, or null when nothing is.
 *
 * This is the sentence the old failure was missing. "did not become healthy within 8000ms"
 * named neither the port nor the thing holding it, and the one place that did say — the
 * platform log file — is a file no first-time user knows exists.
 */
export async function whatIsOn(port: number, host: string = HOST_FALLBACK): Promise<string | null> {
  if (await isPortFree(port, host)) return null;
  try {
    const response = await fetch(`${canvasUrlFor(port, host)}/health`, { signal: AbortSignal.timeout(700) });
    const body = await response.json().catch(() => null) as { service?: string } | null;
    if (typeof body?.service === 'string') return `a service identifying as "${body.service}"`;
    return `an HTTP service answering ${response.status} on /health`;
  } catch {
    return 'a listener that does not answer /health';
  }
}

async function isOurCanvasAt(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const body = await response.json() as { service?: string };
    return isAcceptedCanvasService(body?.service);
  } catch {
    return false;
  }
}

/** What a running board wrote down about itself. */
export interface CanvasState {
  port: number;
  pid: number;
  url: string;
}

/**
 * One file rather than one per port: what a later command needs to know is where *the* board
 * is, and it has no port to look one up by — that is the whole question it is asking.
 */
const CANVAS_STATE_FILE = 'canvas.json';

/** Beside the pidfile, because it is the same kind of thing: runtime state about this board. */
export function canvasStatePath(): string {
  return path.join(stateDir(), CANVAS_STATE_FILE);
}

export function canvasStatePaths(): string[] {
  return stateDirCandidates().map(dir => path.join(dir, CANVAS_STATE_FILE));
}

export function writeCanvasState(state: CanvasState): void {
  try {
    const file = canvasStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* the board still works; only discovery is poorer */ }
}

export function readCanvasState(): CanvasState | null {
  for (const file of canvasStatePaths()) {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as CanvasState;
      if (Number.isInteger(state?.port) && Number.isInteger(state?.pid) && typeof state?.url === 'string') {
        return state;
      }
    } catch { /* not in this directory, or not readable */ }
  }
  return null;
}

/** Only the board that wrote it may clear it, so a second board's file survives the first's exit. */
export function removeCanvasState(port: number): void {
  for (const file of canvasStatePaths()) {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as CanvasState;
      if (state?.port === port) fs.unlinkSync(file);
    } catch { /* already gone, or somebody else's */ }
  }
}

/**
 * The canvas URL to use when the environment has not already decided one, or null when it has.
 *
 * Called from the CLI/MCP entry point before any module captures `EXPRESS_SERVER_URL`, which is
 * what makes a scanned port usable at all: everything downstream reads one fixed URL, so the
 * one place a scan can happen is in front of all of it. The order is the decision this issue
 * left open —
 *
 *   1. an explicit `EXPRESS_SERVER_URL` wins outright. MCP client configs and Docker images
 *      hardcode it, and a resolution that overrode it would move a board out from under them;
 *   2. an explicit `PORT` is the same kind of promise, one field smaller;
 *   3. the state file a running board wrote — **probed, never trusted**. A stale file naming a
 *      port some other program now holds would otherwise send every command at a stranger;
 *   4. otherwise the preferred port, and if something else is on it, the next free one above.
 */
export async function resolveCanvasUrl(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.EXPRESS_SERVER_URL) return null;

  const pinned = explicitPort(env);
  if (pinned !== null) return canvasUrlFor(pinned, env.HOST || HOST_FALLBACK);

  const state = readCanvasState();
  if (state && await isOurCanvasAt(state.url)) return state.url;

  const preferred = preferredPort(env);
  const host = env.HOST || HOST_FALLBACK;
  if (await isPortFree(preferred, host)) return canvasUrlFor(preferred, host);
  // Occupied — but a board of ours already there is the thing we were looking for.
  if (await isOurCanvasAt(canvasUrlFor(preferred, host))) return canvasUrlFor(preferred, host);

  return canvasUrlFor(await findFreePort(preferred + 1, host), host);
}
