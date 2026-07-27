#!/usr/bin/env node
/**
 * Export a workspace's board to a .excalidraw file, without the diff noise.
 *
 * The store is memory only — nothing loads or saves `board` from board.config.json — so a
 * board that is not exported dies with the process. Exporting straight from the API is not
 * enough on its own: the server stamps every element with `syncedAt`, `source` and friends,
 * which change on every export and turn a no-op into a full-file diff. Strip those, sort by
 * id, and the diff shows only what actually moved.
 *
 * Usage: node scripts/export-board.mjs --workspace board-tool --out docs/board.excalidraw
 */

import { writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const BASE = arg('url', process.env.EXPRESS_SERVER_URL || 'http://127.0.0.1:3737');
const WORKSPACE = arg('workspace', 'board-tool');
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

const response = await fetch(`${BASE}/api/elements?workspace=${encodeURIComponent(WORKSPACE)}`);
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
  // Sort by id, not by paint order: `index` already carries the z-order, and a stable key
  // keeps an unrelated edit from reshuffling the whole file.
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

const scene = {
  type: 'excalidraw',
  version: 2,
  source: 'mcp-excalidraw-server',
  elements: cleaned,
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {},
};

writeFileSync(OUT, `${JSON.stringify(scene, null, 1)}\n`, 'utf8');
console.log(`wrote ${cleaned.length} elements from "${WORKSPACE}" to ${OUT}`);
