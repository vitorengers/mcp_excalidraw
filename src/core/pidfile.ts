import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

/**
 * The directory the platform keeps per-user state in — the *parent*, not the application's own
 * folder inside it.
 *
 * `EXCALIDRAW_STATE_HOME` overrides it, and exists so a check can give a run a throwaway state
 * directory of its own. Without it there is no way to exercise the pidfile and the state file
 * except against the real one, which on this machine holds the board the maintainer is looking
 * at.
 */
function stateHome(): string {
  const override = process.env.EXCALIDRAW_STATE_HOME;
  if (override) return override;
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  }
  return process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
}

/** Read per call rather than captured: a check may be simulating another platform. */
function leaf(name: 'next' | 'legacy'): string {
  if (process.platform === 'win32') {
    return name === 'next' ? 'VibeMaxxing-Canvas' : 'Excalidraw-Canvas';
  }
  return name === 'next' ? 'vibemaxxing-canvas' : 'excalidraw-canvas';
}

/**
 * Where runtime artifacts are written today. Still the legacy directory, deliberately, for the
 * reason `core/identity.ts` gives: a directory rename orphans the pidfile, and `stop` then
 * cannot find the server it started while the port stays held.
 */
export function stateDir(): string {
  return path.join(stateHome(), leaf('legacy'));
}

/**
 * Where a reader looks, new directory first. The rename flips what `stateDir()` returns; this
 * list is what makes that flip survivable, so it ships one release ahead of it.
 */
export function stateDirCandidates(): string[] {
  return [path.join(stateHome(), leaf('next')), stateDir()];
}

export function pidFilePath(port: number): string {
  return path.join(stateDir(), `server-${port}.pid`);
}

/** Every place a pidfile for `port` could be, in the order a reader should try them. */
export function pidFilePaths(port: number): string[] {
  return stateDirCandidates().map(dir => path.join(dir, `server-${port}.pid`));
}

/**
 * Where a restart writes down what happened to it.
 *
 * Beside the pidfile because it is the same kind of thing — runtime state about the server on
 * this port — and in a file rather than in the log because the process that asked for the
 * restart is deliberately dead before the answer exists. Nobody is watching by then, so the
 * account has to survive being written to nobody.
 */
export function restartLogPath(port: number): string {
  return path.join(stateDir(), `restart-${port}.log`);
}

/**
 * Where a server that cannot start writes why.
 *
 * The same argument as the restart log, one door along: the launch path spawns the server
 * detached and with `stdio: 'ignore'` — deliberately, so that no inherited descriptor reaches
 * it (#302) — so everything it said on the way down used to reach nobody, and the caller was
 * left with a health timeout naming neither the port nor the conflict. The server writes here
 * instead, and the launcher clears the file before spawning and reads it if the child dies.
 */
export function startupLogPath(port: number): string {
  return path.join(stateDir(), `startup-${port}.log`);
}

// Written by the canvas server once it is actually listening, so `stop` and
// stale-process checks work for both auto-spawned and manually started servers.
export function writePidFile(port: number, pid: number): void {
  try {
    const file = pidFilePath(port);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(pid), 'utf-8');
  } catch (error) {
    logger.warn('Failed to write canvas pidfile:', (error as Error).message);
  }
}

export function readPidFile(port: number): number | null {
  for (const file of pidFilePaths(port)) {
    try {
      const raw = fs.readFileSync(file, 'utf-8').trim();
      const pid = parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch { /* not in this directory */ }
  }
  return null;
}

export function removePidFile(port: number): void {
  for (const file of pidFilePaths(port)) {
    try {
      fs.unlinkSync(file);
    } catch { /* already gone */ }
  }
}
