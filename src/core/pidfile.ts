import fs from 'fs';
import path from 'path';
// Before the logger, deliberately: importing it applies the configuration layers, and the
// logger reads LOG_LEVEL and LOG_FILE_PATH in its own module body.
import { stateDir, stateDirCandidates } from './settings.js';
import logger from '../utils/logger.js';

// The state directory this file used to choose for itself moved into `core/settings.ts` with
// #304: `config.json` is in the same directory as the pidfile and the restart log, and the
// module that reads the configuration cannot import the logger — so the directory has to be
// chosen upstream of both. Re-exported, because `core/port.ts` and everything else that had
// these from here still does.
export { stateDir, stateDirCandidates };

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
