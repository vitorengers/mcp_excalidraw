import winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import { homedir, tmpdir } from 'os';

/**
 * Choose a platform-compatible default log path. MCP servers are launched in
 * the caller's working directory, so a relative path would scatter log files
 * across unrelated project and cloud-synced folders.
 *
 * LOG_FILE_PATH can still override this default.
 *
 * This one carries the new name already, ahead of the identity marker and the state directory
 * beside it, and deliberately: nothing reads the log path back. A marker is matched on the wire
 * and a state directory is where `stop` looks for a pidfile, so both have to accept their old
 * values for a release before they change (see core/identity.ts). A log file only has to be
 * somewhere, and the worst a rename costs is that yesterday's log is in the other folder.
 */
function defaultLogPath(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Logs', 'vibemaxxing-mcp.log');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    return path.join(base, 'VibeMaxxing-MCP', 'vibemaxxing.log');
  }
  // Linux and other POSIX platforms: follow the XDG state convention.
  const xdgState = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(xdgState, 'vibemaxxing-mcp', 'vibemaxxing.log');
}

const LOG_FILE_PATH = process.env.LOG_FILE_PATH || defaultLogPath();

function ensureWritableLogFile(filePath: string): string {
  const logDir = path.dirname(filePath);
  fs.mkdirSync(logDir, { recursive: true });
  fs.accessSync(logDir, fs.constants.W_OK);
  return filePath;
}

function resolveLogFilePath(): string {
  try {
    return ensureWritableLogFile(LOG_FILE_PATH);
  } catch (error) {
    if (process.env.LOG_FILE_PATH) {
      throw error;
    }
  }

  return ensureWritableLogFile(path.join(tmpdir(), 'vibemaxxing-mcp.log'));
}

const RESOLVED_LOG_FILE_PATH = resolveLogFilePath();

/**
 * Where this process's log is actually being written.
 *
 * Exported because until #348 nothing said: the console transport is warn-and-above, so every
 * `logger.info` goes to a file under `%LOCALAPPDATA%` or `~/Library/Logs` — deliberately outside
 * the caller's project, and therefore somewhere nobody asked for a log would think to look. The
 * *resolved* path rather than the setting, so that the fallback to the temporary directory is
 * visible too: an unset and unwritable default lands there, and a command echoing the variable
 * back would name a file that was never opened. `excalidraw-canvas status` prints this.
 */
export const logFilePath: string = RESOLVED_LOG_FILE_PATH;

/**
 * The bound on the log file, and why there is one at all.
 *
 * The File transport was created with a filename and a level and nothing else, so nothing ever
 * truncated it: on the maintainer's machine it reached 70 MB across five days of ordinary use,
 * roughly 14 MB a day, in a directory no user opens. `maxsize` and `maxFiles` cap the whole
 * history at `LOG_MAX_SIZE * LOG_MAX_FILES`, and `tailable` keeps the newest lines in the file
 * `logFilePath` names — without it the path a reader is handed holds the *oldest* content on
 * disk, and the recent history they were asked for is in a numbered sibling.
 *
 * Five megabytes because a log is read to answer "what did this board do just now", and because
 * an installation that has run the unbounded build already has a file this replaces — the
 * rotation walks that one out of the window rather than leaving it there for ever.
 *
 * Not settings: they carry no prefix and cannot, because this module is read before the
 * configuration layers are applied (`core/settings.ts` explains the ordering), and a ceiling that
 * an operator can raise to infinity is not a ceiling. `LOG_LEVEL` is the dial that matters.
 */
const LOG_MAX_SIZE = 1024 * 1024;
const LOG_MAX_FILES = 5;

/** Only warn and error reach stderr, whatever `LOG_LEVEL` says. */
const CONSOLE_LEVEL = 'warn';

/** What is written to the file. `LOG_LEVEL` is about this transport and only ever was. */
const FILE_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * The most verbose of the levels given, by winston's own numbering.
 *
 * The logger's level gates *before* any transport's, so a logger at `info` and a File transport
 * at `debug` is a file that never sees a debug line — which is what this was, and why moving the
 * per-sync lines down to `debug` needed this as well as the move. The logger has to sit at
 * whichever of its transports asks for the most, and each transport then takes its own share.
 */
function mostVerbose(levels: readonly string[]): string {
  const ranked = winston.config.npm.levels as Record<string, number | undefined>;
  return levels.reduce((deepest, level) =>
    (ranked[level] ?? -1) > (ranked[deepest] ?? -1) ? level : deepest);
}

const logger: winston.Logger = winston.createLogger({
  level: mostVerbose([CONSOLE_LEVEL, FILE_LEVEL]),

  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.uncolorize(),
    winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
    winston.format.printf(info => {
      const extra = info.metadata && Object.keys(info.metadata).length
        ? ` ${JSON.stringify(info.metadata)}`
        : '';
      return `${info.timestamp} [${info.level}] ${info.message}${extra}`
    })
  ),

  transports: [
    new winston.transports.Console({
      level: CONSOLE_LEVEL,          // only warn+error to stderr
      stderrLevels: ['warn','error']
    }),

    new winston.transports.File({
      filename: RESOLVED_LOG_FILE_PATH,
      level: FILE_LEVEL,
      maxsize: LOG_MAX_SIZE,
      maxFiles: LOG_MAX_FILES,
      // The newest lines stay in `filename`; the history is `…1.log`, `…2.log` and so on.
      tailable: true
    })
  ]
});

export default logger;
