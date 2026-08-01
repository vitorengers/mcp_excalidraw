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
 * Every board therefore saves beside the registry that lists it instead, in a directory named
 * after that file, where nothing is committed and no project directory grows a file it did not
 * ask for. `scripts/export-board.mjs` stays the only path into the tracked file.
 *
 * Beside the *registry*, rather than in the canvas's own state directory next to the pidfile,
 * for one reason that is not tidiness: a workspace id is unique within a registry and nowhere
 * else. Every self-contained check in `scripts/` starts a server against a throwaway registry
 * of its own, and one shared directory would let a check called `board-tool` write over the
 * saved drafts of the real `board-tool` — silently, on somebody's machine, which is the exact
 * failure this file exists to prevent. Following the registry makes each of them isolated
 * without a single check having to know this feature exists.
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
 * Files are saved too, since #343, and that is the one thing here with a ceiling on it. A
 * dataURL is base64 and a board of screenshots can outgrow any figure, while this file is
 * rewritten on a one-second debounce — so a board's images are written up to
 * `BOARD_IMAGE_BUDGET_BYTES` and the rest are named in a warning rather than silently
 * halved. Without them the save was a scene that referred to pictures nobody could produce:
 * every reload of every board, not the restart-only limit this comment used to claim.
 *
 * ## What is kept when a board is emptied
 *
 * The same scene, written once, beside the saved board and named after it — because a clear is
 * the one write that is not a change to a board but the end of one, and since #225 it reaches
 * the file (#345). It carries the images too, on the same budget: they are exactly what a
 * clear would otherwise take with no way back.
 */
import fs from 'fs/promises';
import { renameSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { ExcalidrawFile, ServerElement, files } from '../types.js';
import { elementsFor, normalizeWorkspaceId } from './element-store.js';
import { BOARD_IMAGE_BUDGET_BYTES, megabytes, referencedFileIds, withinBudget } from './board-files.js';
import { BoardScene, parseBoardScene } from './board-seed.js';
import { registryPath } from './workspaces.js';
import { env } from './settings.js';

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

/**
 * Where saved boards live.
 *
 * Derived from the registry — `board-workspaces.json` keeps its boards in
 * `board-workspaces-state/` beside it — unless an operator names a directory outright. It
 * follows `registryPath()` rather than the variable behind it, so a board that resolved the
 * default registry saves beside *that*, in the per-user state directory. Reading the variable
 * here instead would give the two halves different answers to one question, and the half that
 * lost would be the one that keeps a draft: a project registered through the `+` on a
 * first-run board would have had nowhere to save, which is the case this whole path exists for.
 *
 * Still nullable, and null is still reachable: `boardStateFile` is the only caller and a
 * registry path is only ever empty if somebody set the variable to whitespace.
 */
export function boardStateDir(): string | null {
  const configured = env('BOARD_STATE')?.trim();
  if (configured) return configured;

  const registry = registryPath().trim();
  if (!registry) return null;
  const directory = path.dirname(registry);
  const named = path.basename(registry, path.extname(registry));
  return path.join(directory, `${named}-state`);
}

/** The file one board is saved in, or nothing. Named as a scene, because that is what it is. */
export function boardStateFile(workspaceId: string): string | null {
  const directory = boardStateDir();
  if (!directory) return null;
  return path.join(directory, `${normalizeWorkspaceId(workspaceId)}.excalidraw`);
}

/**
 * Say that this workspace's board is worth keeping.
 *
 * Registered projects, and `default` — which is nobody's project and is exactly why it is
 * here: it is the board a user who has registered nothing draws on, and it was the one board
 * that could never be saved (#314). Everything else is still left out. A request naming a
 * workspace nobody registered gets a store — that is `elementsFor` being deliberately
 * forgiving — and a file per typo is not something a forgiving lookup should be able to
 * create. A typo costs at worst an element in `default.excalidraw`, because that is where
 * `normalizeWorkspaceId` sends anything malformed.
 */
export function persistBoardFor(workspaceId: string): void {
  const id = normalizeWorkspaceId(workspaceId);
  if (!boardStateDir()) return;
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

/**
 * Which boards have already been told they are over the image budget.
 *
 * The save runs every second or two for as long as somebody is drawing, and a warning printed
 * on every one of them is a log nobody can read. Cleared when the board comes back under, so
 * the next time it happens is said again.
 */
const overBudget = new Set<string>();

/**
 * The files a board's saved scene carries: the ones its own saved elements point at, up to
 * the budget.
 *
 * Walked from the *persistable* elements rather than the whole store, so the scene never
 * carries bytes for a shape it did not save — a terminal block's image, if one ever existed,
 * would otherwise be written into a file whose elements have no mention of it.
 */
function filesFor(workspaceId: string, elements: ServerElement[]): Record<string, ExcalidrawFile> {
  const { kept, dropped, bytes } = withinBudget(
    referencedFileIds(elements),
    (id) => files.get(id),
    BOARD_IMAGE_BUDGET_BYTES
  );

  if (dropped.length && !overBudget.has(workspaceId)) {
    overBudget.add(workspaceId);
    logger.warn(
      `"${workspaceId}" is carrying more images than a saved board holds: `
      + `${megabytes(bytes)} of ${megabytes(BOARD_IMAGE_BUDGET_BYTES)} written, `
      + `${dropped.length} image(s) left out. They stay on the canvas and will not survive a restart.`
    );
  }
  if (!dropped.length) overBudget.delete(workspaceId);

  const scoped: Record<string, ExcalidrawFile> = {};
  for (const file of kept) scoped[file.id] = file as ExcalidrawFile;
  return scoped;
}

/**
 * What goes in a file: a scene, readable by anything that reads a `.excalidraw`.
 *
 * The elements are passed in rather than read here, because the two callers do not agree on
 * what they are: the save writes the board as it stands, and the copy taken before a clear
 * writes the same board one moment before it stops standing. The files follow whichever set
 * of elements it is handed, so a copy carries the pictures its own shapes point at — the
 * board's images are exactly what a clear would otherwise take with no way back.
 */
function sceneOf(workspaceId: string, elements: ServerElement[], source: string): string {
  return `${JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source,
    savedAt: new Date().toISOString(),
    elements,
    appState: {},
    files: filesFor(workspaceId, elements),
  }, null, 0)}\n`;
}

/** The board as it is now, for the file it is saved in. */
function sceneFor(workspaceId: string): string {
  return sceneOf(workspaceId, persistableElements(elementsFor(workspaceId).values()),
                 'excalidraw-canvas-board-state');
}

/**
 * Where a board goes before something empties it.
 *
 * Beside its saved state and named after it, so a reader who knows where the board lives
 * knows where its copies are without being told a second directory. `.cleared-<when>` rather
 * than a single `.backup`, because the interesting clear is rarely the last one: an agent
 * that clears and restores badly does it repeatedly, and one file would be overwritten by the
 * clear that came after the one worth reading.
 *
 * The stamp has its colons and dot beaten out of it — an ISO timestamp is not a filename on
 * Windows — and it stays sortable either way, which is what makes "the newest one" a `sort()`.
 *
 * It does *not* collide with what `readBoardState` reads: that opens `<id>.excalidraw` by
 * name, so a copy sitting beside it is never mistaken for the board itself.
 */
export function boardBackupFile(workspaceId: string, at: Date): string | null {
  const directory = boardStateDir();
  if (!directory) return null;
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return path.join(directory, `${normalizeWorkspaceId(workspaceId)}.cleared-${stamp}.excalidraw`);
}

/**
 * Keep what is about to be destroyed, and say where it was put.
 *
 * `DELETE /api/elements/clear` is the one write on this server that is not a change to a
 * board but the end of one, and since #225 it reaches the file: the store empties, the save
 * listener fires, and a second later the board's saved `.excalidraw` holds an empty element
 * list. Nothing in the product could get that back — snapshots were in memory and died with
 * the process — so the copy is taken here, in the route, rather than in the one caller that
 * happens to have a person in front of it (#345).
 *
 * Not gated on `persistBoardFor`. That gate exists so a request naming a workspace nobody
 * registered cannot create a file per typo, and it cannot here either: a store nobody has
 * written to has no elements, and a board with no elements is not copied. What the gate would
 * cost instead is the case this is for — an unregistered board holding somebody's only copy
 * of something, emptied by a tool call.
 *
 * Written through a temporary file and a rename for the same reason the board is: a copy that
 * is half a file is not a copy, and this one exists precisely for the moment somebody needs it.
 */
export async function backupBoardBefore(workspaceId: string): Promise<string | null> {
  const id = normalizeWorkspaceId(workspaceId);
  const elements = persistableElements(elementsFor(id).values());
  if (!elements.length) return null;

  const file = boardBackupFile(id, new Date());
  if (!file) return null;

  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, sceneOf(id, elements, 'excalidraw-canvas-board-cleared'), 'utf-8');
    await fs.rename(temporary, file);
    return file;
  } catch (error) {
    logger.warn(`Could not copy the board for "${id}" to ${file} before clearing it: ${(error as Error).message}`);
    return null;
  }
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

  const file = boardStateFile(id);
  if (!file) return;

  const previous = writing.get(id) ?? Promise.resolve();
  const next = previous.then(async () => {
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
    if (!file) continue;
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
/**
 * Whether this canvas has ever written a state file for the board, whatever is in it.
 *
 * A separate question from `readBoardState`, and the difference is the whole point: that one
 * answers nothing for a board somebody emptied, because a scene with no elements is not a
 * scene to come back as. This one answers "somebody has been here", which is what a *first*
 * run has to ask before it puts a welcome board on a canvas. Without it, clearing the welcome
 * board would bring it back on the next start — a deliberate emptying read as a fresh project.
 */
export async function boardStateExists(workspaceId: string): Promise<boolean> {
  const file = boardStateFile(normalizeWorkspaceId(workspaceId));
  if (!file) return false;
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readBoardState(workspaceId: string): Promise<SavedBoard | null> {
  const id = normalizeWorkspaceId(workspaceId);
  const file = boardStateFile(id);
  if (!file) return null;
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
