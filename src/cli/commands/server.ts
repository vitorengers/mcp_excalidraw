import { parseArgs } from '../args.js';
import { printJson, note } from '../util.js';
import { ensureCanvasRunning, stopCanvas, canvasPort, isCanvasHealth, foreignServiceError } from '../../core/spawn.js';
import { getHealth, getSyncStatus } from '../../core/canvas-client.js';
import { EXPRESS_SERVER_URL } from '../../core/config.js';
import { readPidFile } from '../../core/pidfile.js';
import { ensureSettingsFile } from '../../core/settings.js';

export async function start(argv: string[]): Promise<void> {
  parseArgs(argv, {});

  // First launch leaves a configuration file behind, holding the port it resolved and nothing
  // else (#304). Not because the port needs writing down — it is already the default — but
  // because a file that exists is a file somebody can open and add a registry to. The
  // alternative was a documented convention about a gitignored `.env` in a directory a
  // double-clicked launcher cannot predict, which is the defect this replaces.
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
