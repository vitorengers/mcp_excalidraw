import fs from 'fs';
import path from 'path';
// Before the logger, deliberately: importing this applies the configuration layers, and the
// logger reads LOG_LEVEL and LOG_FILE_PATH in its own module body.
import { stateDir } from './settings.js';
import logger from '../utils/logger.js';

// The platform-compatible state directory this file used to choose for itself now lives in
// `core/settings.ts`, because the configuration file sits in the same directory as the pidfile
// and the restart log — one directory, one definition, and one `EXCALIDRAW_STATE_DIR` that
// redirects all three (#304).

export function pidFilePath(port: number): string {
  return path.join(stateDir(), `server-${port}.pid`);
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
  try {
    const raw = fs.readFileSync(pidFilePath(port), 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function removePidFile(port: number): void {
  try {
    fs.unlinkSync(pidFilePath(port));
  } catch { /* already gone */ }
}
