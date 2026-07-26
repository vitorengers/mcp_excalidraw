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

const cleaned = elements
  .filter((element) => !element.isDeleted)
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
