import { parseArgs } from '../args.js';
import { printJson, note } from '../util.js';
import { ensureCanvasRunning, stopCanvas, canvasPort, isCanvasHealth, foreignServiceError } from '../../core/spawn.js';
import { getHealth, getSyncStatus } from '../../core/canvas-client.js';
import { EXPRESS_SERVER_URL } from '../../core/config.js';
import { readPidFile } from '../../core/pidfile.js';
import { ensureSettingsFile } from '../../core/settings.js';
import { openBrowser } from '../../core/open-browser.js';
import { packageVersion, productName } from '../../core/version.js';

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

export async function status(argv: string[]): Promise<void> {
  parseArgs(argv, {});

  let health;
  try {
    health = await getHealth();
  } catch {
    printJson({ running: false, url: EXPRESS_SERVER_URL });
    const error = new Error(`Canvas server is not running at ${EXPRESS_SERVER_URL}`);
    (error as any).code = 'CANVAS_UNREACHABLE';
    (error as any).quiet = true; // JSON above already tells the story
    throw error;
  }

  if (!isCanvasHealth(health)) {
    printJson({
      running: false,
      url: EXPRESS_SERVER_URL,
      conflict: 'another service (or a pre-1.1 canvas build) is answering at this URL'
    });
    const error = foreignServiceError();
    (error as any).quiet = true;
    throw error;
  }

  let sync: Record<string, unknown> = {};
  try {
    sync = await getSyncStatus();
  } catch { /* health is enough */ }

  printJson({
    running: true,
    url: EXPRESS_SERVER_URL,
    // Prefer the pid the server reports about itself; the pidfile can be stale
    pid: health.pid ?? readPidFile(canvasPort()) ?? undefined,
    elements: health.elements_count,
    browserClients: health.websocket_clients,
    ...sync
  });
}
