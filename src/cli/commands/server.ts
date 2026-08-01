import { parseArgs } from '../args.js';
import { printJson, note } from '../util.js';
import {
  ensureCanvasRunning, stopCanvas, canvasPort, isCanvasHealth, foreignServiceError,
  describeSkew, versionSkew
} from '../../core/spawn.js';
import { getHealth, getSyncStatus } from '../../core/canvas-client.js';
import { EXPRESS_SERVER_URL } from '../../core/config.js';
import { readPidFile } from '../../core/pidfile.js';
import { ensureSettingsFile } from '../../core/settings.js';
import { openBrowser } from '../../core/open-browser.js';
import { BIN_NAME, packageVersion, productName } from '../../core/version.js';
import { logFilePath } from '../../utils/logger.js';

/**
 * What the command with no arguments does: bring the board up, open it, say where it is.
 *
 * This is the whole of the first-run path, and it is separate from `start` on purpose. `start` is
 * the machine-readable one — an agent or a script reads its JSON, and a second `start` against a
 * live board correctly answers `spawned: false`. Neither of those is what somebody who has just
 * installed this needs to see, and `spawned: false` is actively wrong as a first impression: the
 * board is there, and what should happen is that it comes to the front.
 *
 * So both outcomes of `ensureCanvasRunning` end the same way here — the browser is pointed at the
 * board, and one line names it. The open is in this command rather than inside
 * `ensureCanvasRunning` because every canvas-driving command goes through that function to
 * auto-start; a browser window arriving on `vibemaxxing describe` would be a surprise, and
 * suppressing it again per-caller would be the same decision made in more places.
 */
export async function launch(argv: string[]): Promise<void> {
  parseArgs(argv, {});

  const settings = ensureSettingsFile(canvasPort());
  if (settings.created) {
    note(`Wrote ${settings.file} — configuration lives here, see config.example.json`);
  }

  // Typing the command is user intent, exactly as `start` is, so the auto-start opt-outs do not
  // apply: somebody who asked for the board is asking for the board.
  const result = await ensureCanvasRunning({ force: true });
  openBrowser(result.url);

  // Exactly one line, and it is the only thing on stdout. Everything `ensureCanvasRunning` has to
  // say about spawning, and the note above, are diagnostics and went to stderr.
  process.stdout.write(`${productName()} ${packageVersion()} — ${result.url}\n`);
}

/**
 * The MCP stdio server, by name.
 *
 * It is what a bare invocation used to mean, and it is still what a bare invocation means under
 * any name that is not one of this package's own. Naming it makes it reachable from the new
 * command too, so an MCP client configuration can be written without depending on which of the
 * three shapes an installer left `argv[1]` in.
 *
 * The import is deliberately inside the handler: `index.js` evaluates the whole MCP module graph,
 * and no other command should pay for it.
 */
export async function mcp(argv: string[]): Promise<void> {
  parseArgs(argv, {});
  const { runServer } = await import('../../index.js');
  await runServer();
}

export async function start(argv: string[]): Promise<void> {
  parseArgs(argv, {});

  // First launch leaves a configuration file behind, holding the port it resolved and nothing
  // else (#304). Not because the port needs writing down — it is already the default — but
  // because a file that exists is a file somebody can open and add a registry to. The
  // alternative was a documented convention about a gitignored `.env` in a directory a
  // double-clicked launcher cannot predict, which is the defect this replaces.
  //
  // Before `ensureCanvasRunning`, because the port is already decided by here: `core/port.ts`
  // resolved it at the entry point, and `canvasPort()` is reading that answer rather than
  // asking a new one.
  const settings = ensureSettingsFile(canvasPort());
  if (settings.created) {
    note(`Wrote ${settings.file} — configuration lives here, see config.example.json`);
  }

  // Explicit start is user intent — it overrides the auto-start opt-outs
  const result = await ensureCanvasRunning({ force: true });
  if (!result.spawned) {
    note(`Canvas server already running at ${result.url}`);
  }
  printJson({
    running: true,
    url: result.url,
    spawned: result.spawned,
    pid: readPidFile(canvasPort()) ?? undefined
  });
}

export async function stop(argv: string[]): Promise<void> {
  parseArgs(argv, {});
  const result = await stopCanvas();
  printJson(result);
}

/**
 * Replace the running canvas with one from *this* install, on the port it already holds.
 *
 * Stop-and-start rather than `POST /api/restart`, and the difference is the whole point of the
 * command. That route hands the restart to a supervisor which starts `dist/server.js` resolved
 * relative to the *dying process's own module URL* — the old install — so it is exactly the wrong
 * tool for the case this exists for, which is a canvas left behind by the previous release. Here
 * the replacement comes from the build that is running this command.
 *
 * What that costs is the half the route gets for free: the supervisor carries the old server's
 * environment, and `ensureCanvasRunning` can only carry this process's. So a board whose
 * registry, terminal and agents came from exported variables rather than from `config.json`
 * comes back as whatever *this* shell holds. `config.json` in the state directory is the layer
 * that survives either way, which is one of the reasons it exists (see `core/settings.ts`).
 *
 * The board is asked what it is doing before it is stopped. Stopping the server stops every
 * coding agent it is hosting, and a command that ends somebody's implementation run without
 * saying so is not a restart, it is a loss. `--force` is how you say you meant it.
 */
export async function restart(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv, { force: { takesValue: false } });

  // Read before anything is signalled, and tolerated when it fails: a canvas that is not
  // answering is one this command brings up rather than one it refuses over.
  let before;
  try {
    before = await getHealth();
  } catch {
    before = null;
  }

  const inFlight = typeof before?.implementing === 'number' ? before.implementing : 0;
  if (inFlight > 0 && !flags.force) {
    const error = new Error(
      `The canvas server at ${EXPRESS_SERVER_URL} is implementing ${inFlight} `
      + `${inFlight === 1 ? 'issue' : 'issues'} right now, and stopping it would end `
      + `${inFlight === 1 ? 'that run' : 'those runs'} where they stand. `
      + 'Wait for them, or pass --force to restart anyway.'
    );
    (error as any).code = 'IMPLEMENT_IN_FLIGHT';
    throw error;
  }

  const stopped = await stopCanvas();
  note(stopped.message);

  // `force` here is `ensureCanvasRunning`'s own meaning — an explicit start overrides the
  // auto-start opt-outs — and not this command's `--force`, which is about the runs above.
  // Somebody who typed `restart` asked for a board either way.
  const started = await ensureCanvasRunning({ force: true });

  // The pid the *replacement* reports about itself. The pidfile is written by the new server and
  // is the same answer a moment later, but /health is the one that cannot be stale.
  let after;
  try {
    after = await getHealth();
  } catch {
    after = null;
  }

  printJson({
    running: true,
    url: started.url,
    stopped: stopped.pid,
    pid: after?.pid ?? readPidFile(canvasPort()) ?? undefined,
    version: after?.version,
    previousVersion: before?.version ?? null
  });
}

/**
 * What every branch of `status` says, however the board answered.
 *
 * The log path is here rather than in the healthy branch alone because the moment somebody is
 * asked for a log is the moment the board is *not* answering: a `running: false` that names no
 * file leaves the reader with a console capped at warn and a log under `%LOCALAPPDATA%` that
 * nothing has ever mentioned. It is this process's resolved path, which is the one the board it
 * spawns resolves too — the same code, the same environment.
 */
function whereTheLogIs(): { logFile: string } {
  return { logFile: logFilePath };
}

export async function status(argv: string[]): Promise<void> {
  parseArgs(argv, {});

  let health;
  try {
    health = await getHealth();
  } catch {
    printJson({ running: false, url: EXPRESS_SERVER_URL, ...whereTheLogIs() });
    const error = new Error(`Canvas server is not running at ${EXPRESS_SERVER_URL}`);
    (error as any).code = 'CANVAS_UNREACHABLE';
    (error as any).quiet = true; // JSON above already tells the story
    throw error;
  }

  if (!isCanvasHealth(health)) {
    printJson({
      running: false,
      url: EXPRESS_SERVER_URL,
      conflict: 'another service (or a pre-1.1 canvas build) is answering at this URL',
      ...whereTheLogIs()
    });
    const error = foreignServiceError();
    (error as any).quiet = true;
    throw error;
  }

  let sync: Record<string, unknown> = {};
  try {
    sync = await getSyncStatus();
  } catch { /* health is enough */ }

  // The one command that reports a version mismatch instead of refusing over it. Everything else
  // that drives the canvas is stopped by `ensureCanvasRunning` before it can act on the old
  // build; this is the command somebody runs *to find out*, and refusing to answer it would
  // withhold the very fact they came for.
  const skew = versionSkew(health);

  printJson({
    running: true,
    url: EXPRESS_SERVER_URL,
    // Prefer the pid the server reports about itself; the pidfile can be stale
    pid: health.pid ?? readPidFile(canvasPort()) ?? undefined,
    version: skew.running,
    installedVersion: skew.installed,
    versionMismatch: skew.mismatch,
    elements: health.elements_count,
    browserClients: health.websocket_clients,
    implementing: health.implementing,
    ...whereTheLogIs(),
    ...sync
  });

  if (skew.mismatch) {
    note(`${describeSkew(skew)} It is serving that build's code and frontend — the browser `
      + `shows nothing about this. Replace it with \`${BIN_NAME} restart\`.`);
  }
}
