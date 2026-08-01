#!/usr/bin/env node
/**
 * Export a workspace's board to a .excalidraw file, without the diff noise.
 *
 * The store is memory only, and this is the whole of the write half: a board is read back from
 * `board` at startup (#184) and never written there, so a change that is not exported here dies
 * with the process. Exporting straight from the API is not
 * enough on its own: the server stamps every element with `syncedAt`, `source` and friends,
 * which change on every export and turn a no-op into a full-file diff. Strip those, sort by
 * id, and the diff shows only what actually moved.
 *
 * `--url` and `--workspace` are required, and deliberately have no defaults. They used to
 * name the operator's live board — the port it runs on, and the workspace this repository's
 * own board lives in — which meant the one script that writes a tracked file would, run with
 * no arguments in any checkout at all, fetch whatever answered on that port and write it over
 * `docs/board.excalidraw`. There is nothing in that request that says which board came back,
 * so an absent flag was one step from committing somebody else's. `--out` keeps its default:
 * getting the destination wrong is visible in `git status`, and getting the source wrong is
 * not.
 *
 * Usage: node scripts/export-board.mjs --url http://127.0.0.1:<port> --workspace board-tool \
 *                                      --out docs/board.excalidraw
 *
 * The port is whichever one the board was started on — `docs/running.md` has the invocation
 * for this repository's own board.
 */

import { writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const USAGE = 'usage: node scripts/export-board.mjs --url <server> --workspace <id> [--out <file>]';

function required(name, description) {
  const value = arg(name, null);
  if (value) return value;
  console.error(`Missing --${name}: ${description}.`);
  console.error(USAGE);
  process.exit(2);
}

const BASE = required('url', 'the server to read the board from, port and all');
const WORKSPACE = required('workspace', 'the workspace whose board is being exported');
const OUT = arg('out', 'docs/board.excalidraw');

/** Server bookkeeping. None of it is Excalidraw's, and all of it churns. */
const VOLATILE = ['syncedAt', 'source', 'syncTimestamp', 'createdAt', 'updatedAt'];

/**
 * The shapes that are not this board's to save.
 *
 * The GitHub project mirror is rebuilt from GitHub on every read, so a copy in the board
 * file would be a snapshot of somebody's Todo column from whenever the export happened to
 * run — stale on arrival, and churning the diff every time anyone moved a card. The
 * terminal is the same argument with a shorter life: the block exists for as long as a
 * shell does, and a saved one would be a dead frame around a session that ended.
 *
 * The browser already keeps both out of the autosync; this is the second door, because the
 * store is shared and only one of the two needs to be missed.
 */
const DERIVED_KINDS = new Set(['project-board', 'terminal']);

// A server that is not there is an ordinary thing to get wrong — the board has to be running
// and it has to be the one meant — so it is reported rather than thrown. An unhandled
// rejection here reads as a defect in the script and buries the one line that matters.
/**
 * This board's token, from the build, or nothing at all.
 *
 * Wanted because this is the only reader of a *live, configured* board in `scripts/` — everything
 * else here starts a server of its own with the token off — and since #350 a configured board
 * refuses a request that does not carry one.
 *
 * Imported here rather than at the top, and forgiven when it fails, for one reason:
 * `check-shallow-clone.mjs` runs this script inside a clone that has no `node_modules`, to prove
 * the two flags are required. `core/auth-token.js` reaches the settings layers and through them
 * `dotenv`, so a top-level import would turn that check's subject — a missing flag, reported —
 * into a module-resolution stack trace. A clone with no build has no board to export either.
 */
async function boardToken(base) {
  try {
    const { authHeaders } = await import('../dist/core/auth-token.js');
    return authHeaders(base);
  } catch {
    return {};
  }
}

const url = `${BASE}/api/elements?workspace=${encodeURIComponent(WORKSPACE)}`;
let response;
try {
  response = await fetch(url, { headers: await boardToken(BASE) });
} catch (error) {
  console.error(`GET ${url} failed: ${error?.message ?? error}`);
  console.error('Is the board running, and is --url the port it was started on?');
  process.exit(1);
}
if (!response.ok) {
  console.error(`GET /api/elements -> HTTP ${response.status}`);
  process.exit(1);
}

const { elements = [] } = await response.json();
if (!elements.length) {
  console.error(`Workspace "${WORKSPACE}" has no elements. Refusing to write an empty board.`);
  process.exit(1);
}

// A label bound to a derived shape is derived too, and says nothing about itself: Excalidraw
// binds text to whatever is selected, and that text carries no `customData.kind`. Saved on
// its own it is a string whose container is not in the file.
const derivedIds = new Set(elements
  .filter((element) => DERIVED_KINDS.has(element?.customData?.kind))
  .map((element) => element.id));

const cleaned = elements
  .filter((element) => !element.isDeleted)
  .filter((element) => !DERIVED_KINDS.has(element?.customData?.kind))
  .filter((element) => !(element.containerId && derivedIds.has(element.containerId)))
  .map((element) => {
    const copy = { ...element };
    for (const field of VOLATILE) delete copy[field];
    return copy;
  })
  // Sort by paint order, id breaking the tie.
  //
  // This used to sort by id alone, on the reasoning that `index` already carries the z-order
  // and a stable key keeps an unrelated edit from reshuffling the whole file. The first half
  // of that is wrong, and the board paid for it: Excalidraw treats fractional indices as
  // valid only while they *increase along the array*, so an array in id order reads as
  // broken, gets its indices regenerated from the array order, and paints in that order.
  // Twenty pieces of text ended up underneath the opaque cards they label — five cards that
  // drew as empty boxes, in the file the whole time and unreadable on the canvas.
  //
  // The diff stays quiet anyway: `index` only changes when something is actually restacked,
  // and `id` still decides between elements that share one.
  //
  // Compared as plain strings rather than with `localeCompare`, because that is exactly how
  // Excalidraw compares them: a locale-aware collation puts `aa` and `aA` in the other order
  // and would reintroduce the same inversion under a different name.
  .sort((a, b) => (String(a.index) < String(b.index) ? -1
                 : String(a.index) > String(b.index) ? 1
                 : String(a.id).localeCompare(String(b.id))));

const scene = {
  type: 'excalidraw',
  version: 2,
  // The package that produced this scene. Kept in step with `package.json` by hand: a
  // re-export that reverted it would undo the rename in the one file nobody re-reads.
  source: '@vitorengers/vibemaxxing',
  elements: cleaned,
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {},
};

writeFileSync(OUT, `${JSON.stringify(scene, null, 1)}\n`, 'utf8');
console.log(`wrote ${cleaned.length} elements from "${WORKSPACE}" to ${OUT}`);
