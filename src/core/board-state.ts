/**
 * A board's own memory of itself, between processes.
 *
 * #184 gave the element store a load half: a registered project's `board` file is read into
 * its store at startup. The save half was left out under that issue's second assumption —
 * "load only, taken literally" — and this is that assumption coming due. Until now the store
 * was memory only, and `docs/element-store.md` said so: a change that nobody remembered to
 * export with `scripts/export-board.mjs` died with the process. A drawing usually survived
 * that, because a drawing is somebody's to redraw. A *draft* did not: the `+` on My Notes
 * makes a block that has no issue, no branch and no project item behind it, and the canvas is
 * the only place it exists (#225).
 *
 * ## Why not the board file
 *
 * Because `docs/whats-next.md` was right about it: a board file is a tracked artifact and a
 * commit like any other, and a process writing to one on a timer would put diff noise into
 * somebody's working tree — on a board that autosaves every second or two, continuously.
 * Every board therefore saves beside the pidfile instead, under the canvas's own state
 * directory, where nothing is committed and no project directory grows a file it did not ask
 * for. `scripts/export-board.mjs` stays the only path into the tracked file.
 *
 * ## What wins at startup
 *
 * The saved state, unless the board file has been written since — which is what a `git pull`,
 * a merge or a fresh export looks like from here. In that case the file is the base and the
 * elements only this process ever had are put back on top of it, so a board that was updated
 * elsewhere arrives updated *and* the drafts nobody else has a copy of are still there. Both
 * branches say in the log which one happened, because a committed board silently overridden
 * by process leftovers is exactly the failure worth being able to read about afterwards.
 *
 * ## What is saved
 *
 * Everything the store holds except what is nobody's to save: the GitHub project mirror is
 * rebuilt from GitHub on every read, and the terminal's block exists for as long as its shell
 * does. Both are already kept out of the autosync and out of the export; this is the third
 * door, and it needs to be, because the store is reachable from the REST API too.
 *
 * Files are not saved. `scripts/export-board.mjs` writes none either, so this is the same
 * limit the tracked boards already have: an image pasted onto a board comes back after a
 * restart as an element whose file the process no longer holds.
 */
import fs from 'fs/promises';
import { renameSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { ServerElement } from '../types.js';
import { canvasStateDir } from './pidfile.js';
import { elementsFor, isWatchedStore, normalizeWorkspaceId } from './element-store.js';
import { BoardScene, parseBoardScene } from './board-seed.js';

/**
 * Kinds this board does not author and therefore does not save.
 *
 * The same two as `scripts/export-board.mjs`, for the same reasons, and stated again here
 * rather than imported because that is a script and this is the server.
 */
const DERIVED_KINDS = new Set(['project-board', 'terminal']);

/**
 * How long after a change the board is written.
 *
 * Long enough that a drag, which lands a sync roughly every second, is one write rather than
 * twenty; short enough that "unexpected occurrence" costs a second of drawing at most.
 */
const SAVE_DEBOUNCE_MS = 1000;

/**
 * And how long a change may be owed while the debounce keeps being pushed back.
 *
 * Editing continuously — typing into a block, dragging one around — arms a sync every second
 * or so, and a debounce with no ceiling would be reset by each one and never fire. The whole
 * point is the crash nobody schedules, so the write happens on this beat whatever else is
 * going on.
 */
const SAVE_MAX_DELAY_MS = 5000;

interface PendingSave {
  timer: NodeJS.Timeout;
  since: number;
}

const persisted = new Set<string>();
const pending = new Map<string, PendingSave>();
/** One write at a time per board, so a slow disk cannot interleave two saves of one file. */
const writing = new Map<string, Promise<void>>();

/** Where saved boards live. An operator who wants them elsewhere says so; nothing else does. */
export function boardStateDir(): string {
  const configured = process.env.EXCALIDRAW_BOARD_STATE?.trim();
  return configured || path.join(canvasStateDir(), 'boards');
}

/** The file one board is saved in. Named as a scene, because that is what it is. */
export function boardStateFile(workspaceId: string): string {
  return path.join(boardStateDir(), `${normalizeWorkspaceId(workspaceId)}.excalidraw`);
}

/**
 * Say that this workspace's board is worth keeping.
 *
 * Registered projects and nothing else. A request naming a workspace nobody registered gets
 * a store — that is `elementsFor` being deliberately forgiving — and a file per typo is not
 * something a forgiving lookup should be able to create.
 */
export function persistBoardFor(workspaceId: string): void {
  const id = normalizeWorkspaceId(workspaceId);
  if (!isWatchedStore(id)) {
    // The default store is the Map `types.ts` exports, shared with the CLI and the MCP
    // tools, and it cannot report its own changes. Said out loud: a project registered
    // under that id would otherwise be the one board that quietly never saved.
    logger.warn(`Board state for "${id}" will not be saved: that id is the shared default store.`);
    return;
  }
  persisted.add(id);
}

/** Elements as they are saved: no tombstones, and nothing derived. */
export function persistableElements(elements: Iterable<ServerElement>): ServerElement[] {
  const all = [...elements];
  const derivedIds = new Set(all
    .filter((element) => DERIVED_KINDS.has(String(element.customData?.kind)))
    .map((element) => element.id));

  // A label bound to a derived shape is derived too, and says nothing about itself:
  // Excalidraw binds text to whatever is selected, and that text carries no `kind`. Saved on
  // its own it would be a string whose container the store has never heard of.
  return all.filter((element) => !element.isDeleted
    && !DERIVED_KINDS.has(String(element.customData?.kind))
    && !(element.containerId && derivedIds.has(element.containerId)));
}

/** What goes in the file: a scene, readable by anything that reads a `.excalidraw`. */
function sceneFor(workspaceId: string): string {
  return `${JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'excalidraw-canvas-board-state',
    savedAt: new Date().toISOString(),
    elements: persistableElements(elementsFor(workspaceId).values()),
    // Empty, as `scripts/export-board.mjs` writes it. See the note at the top of the file.
    appState: {},
    files: {},
  }, null, 0)}\n`;
}

/**
 * Write the board out now.
 *
 * Through a temporary file and a rename, the way the workspace registry is written
 * (`workspaces.ts`): a crash halfway through a plain write would leave the board holding
 * half a file, and half a file is worse than the memory-only store this replaces — it is
 * read at the next startup and refused, which loses the whole board rather than a second of
 * it.
 */
export async function saveBoardState(workspaceId: string): Promise<void> {
  const id = normalizeWorkspaceId(workspaceId);
  if (!persisted.has(id)) return;

  const previous = writing.get(id) ?? Promise.resolve();
  const next = previous.then(async () => {
    const file = boardStateFile(id);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temporary, sceneFor(id), 'utf-8');
      await fs.rename(temporary, file);
    } catch (error) {
      logger.warn(`Could not save the board for "${id}" to ${file}: ${(error as Error).message}`);
    }
  });
  writing.set(id, next);
  await next;
}

/** Everything a shutdown owes, written before the process goes. */
export function flushBoardStateSaves(): void {
  for (const [id, save] of pending) {
    clearTimeout(save.timer);
    pending.delete(id);
    const file = boardStateFile(id);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      // Synchronous, because this runs from `process.on('exit')` as well as from the signal
      // handlers, and nothing asynchronous started there ever finishes.
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temporary, sceneFor(id), 'utf-8');
      renameSync(temporary, file);
    } catch (error) {
      logger.warn(`Could not save the board for "${id}" on the way out: ${(error as Error).message}`);
    }
  }
}

/**
 * Remember that this board changed, and write it shortly.
 *
 * This is what every store write reaches, through `onElementStoreChanged`, so it has to be
 * cheap: a Map lookup and at most one timer per board. The scene is only serialised when the
 * timer fires.
 */
export function scheduleBoardStateSave(workspaceId: string): void {
  const id = normalizeWorkspaceId(workspaceId);
  if (!persisted.has(id)) return;

  const now = Date.now();
  const existing = pending.get(id);
  if (existing && now - existing.since >= SAVE_MAX_DELAY_MS) {
    clearTimeout(existing.timer);
    pending.delete(id);
    void saveBoardState(id);
    return;
  }
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(id);
    void saveBoardState(id);
  }, SAVE_DEBOUNCE_MS);
  // Nothing here is a reason for the process to stay alive.
  timer.unref?.();
  pending.set(id, { timer, since: existing?.since ?? now });
}

export interface SavedBoard {
  scene: BoardScene;
  /** When the file was written, as the filesystem has it. */
  savedAt: number;
  file: string;
}

/**
 * The board as this process last saved it, or nothing.
 *
 * Read through `parseBoardScene`, which is the same door a tracked board comes in by — so a
 * run that was still in flight when the process stopped comes back demoted rather than
 * asserted as running, and a tombstone is dropped. A saved board is exactly as unable to
 * tell a live run from an abandoned one as a committed board is.
 */
export async function readBoardState(workspaceId: string): Promise<SavedBoard | null> {
  const id = normalizeWorkspaceId(workspaceId);
  const file = boardStateFile(id);
  try {
    const [raw, stats] = await Promise.all([fs.readFile(file, 'utf-8'), fs.stat(file)]);
    const scene = parseBoardScene(raw);
    if (!scene.elements.length) return null;
    return { scene, savedAt: stats.mtimeMs, file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn(`Saved board for "${id}" at ${file} was not read: ${(error as Error).message}`);
    return null;
  }
}
