/**
 * A saved board read back into the shape the store holds.
 *
 * `boardFile` was resolved from `board.config.json` and published by `GET /api/workspaces`,
 * and that is where it stopped: nothing ever read it, so every registered board came up
 * empty and the way back was an ad-hoc import of whatever revision somebody happened to
 * open (#184, and the mojibake behind #151 is what one of those cost).
 *
 * Kept out of `server.ts` because the decision below is the whole of the risk, and a
 * decision made inside a boot sequence can only be checked by booting.
 *
 * ## What a seed may assert
 *
 * Seeded elements *are* the store, and for the ten fields in `SERVER_AUTHORED_CUSTOM_DATA`
 * the store outranks the browser — that is #118 working as designed. So a scene carrying a
 * run that was in flight when the last process stopped would come back asserted as true,
 * for an agent that died with that process, and no browser could correct it.
 *
 * The rule is therefore: a seed may assert what is finished and may not assert what is
 * running. An issue that exists still says so (`issueUrl`, `issueTitle` — a block that
 * produced #94 should still say so), and so does an implementation that ended in a pull
 * request. A run still in flight is demoted, exactly as `DELETE /api/issue-block/:id`
 * demotes a stuck one, because both are answering the same question: nothing here can tell
 * a live run from an abandoned one, and after a restart there are no live ones.
 */
import { ServerElement, ExcalidrawFile } from '../types.js';
import { issueBlockAppearance } from './issue-appearance.js';

/** What `recordImplement` writes onto every element carrying the issue. */
const IMPLEMENT_FIELDS = [
  'implementState',
  'implementUrl',
  'implementError',
  'implementStartedAt',
  'implementEndedAt',
] as const;

/**
 * Implementation states that describe work that is over.
 *
 * `running` is the obvious one to drop. `interrupted` goes with it because it is *derived*
 * rather than recorded: `recoverInterruptedRuns` reads it back out of git at startup, git
 * being the only participant that was still there, so a seeded copy would either be
 * restated a moment later or be a claim that there is a checkout to resume when there is
 * not.
 *
 * `blocked` is settled and seedable for the same reason `failed` is: the run is over, and what
 * it left is a pull request somebody has to look at — which is precisely the thing a seeded
 * board should still be saying.
 */
const SETTLED_IMPLEMENT_STATES = new Set(['done', 'failed', 'blocked']);

export interface BoardScene {
  elements: ServerElement[];
  files: Record<string, ExcalidrawFile>;
}

/**
 * One element as it may be seeded: verbatim, minus any claim that something is running,
 * and — for a block — drawn in the palette this code has rather than the one it was
 * exported in.
 *
 * Returns the element untouched when it claims nothing, which is every shape on a board
 * that has never had an issue block on it.
 */
export function seedableElement(element: ServerElement): ServerElement {
  const custom = element.customData;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return element;

  let next = custom as Record<string, unknown>;
  let appearance: Partial<ServerElement> = {};

  if (next.issueState === 'running') {
    // The instants go with the state they describe. A seeded block whose run was dropped
    // would otherwise carry the moment that run started, and a clock is only ever read
    // against a `running` block — so keeping them is keeping a claim nothing can settle.
    const { issueState, issueError, issueStartedAt, issueEndedAt, ...rest } = next;
    // A block that already produced an issue is `created`, whatever the stuck state said —
    // dropping the state outright would send it back to offering a run the POST route then
    // refuses. The look goes back with the state, or a created block would keep wearing the
    // dashed outline that means *no issue behind this yet*.
    const resetTo = rest.issueUrl ? 'created' : 'draft';
    appearance = issueBlockAppearance(resetTo);
    next = rest.issueUrl ? { ...rest, issueState: 'created' } : rest;
  }

  if ('implementState' in next && !SETTLED_IMPLEMENT_STATES.has(String(next.implementState))) {
    const withoutRun = { ...next };
    for (const field of IMPLEMENT_FIELDS) delete withoutRun[field];
    next = withoutRun;
  }

  // A block's look is the server's, drawn from its state (`docs/issue-block.md`), and a
  // saved board is the one place a look can arrive from outside this process. So the block
  // is repainted from the mapping as it is read: a board exported before the palette moved
  // would otherwise come back in the old hue and stay there, nothing else on the way in
  // ever writing a block's colours again. Only a block — repainting anything else on a
  // saved scene would be the seed redecorating somebody's drawing.
  if (next.kind === 'issue') {
    appearance = issueBlockAppearance(next.issueState as string | undefined);
  }

  const asFields = element as unknown as Record<string, unknown>;
  const repainted = Object.entries(appearance).some(([field, value]) => asFields[field] !== value);
  if (next === custom && !repainted) return element;
  return { ...element, ...appearance, customData: next };
}

/**
 * The files a scene carries, as the process-wide store holds them.
 *
 * This is the door the saved board comes back in by, since #343: `board-state.ts` writes the
 * files its elements point at, and without this the seed would put image elements back as
 * broken references. `scripts/export-board.mjs` still writes an empty `files` object, so a
 * *tracked* board carries none — which is why this is lenient about the object being absent
 * rather than treating it as a malformed scene.
 */
function readFiles(raw: unknown): Record<string, ExcalidrawFile> {
  const files: Record<string, ExcalidrawFile> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return files;

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const file = value as Partial<ExcalidrawFile>;
    if (typeof file.dataURL !== 'string' || !file.dataURL) continue;
    files[id] = {
      id: typeof file.id === 'string' && file.id ? file.id : id,
      dataURL: file.dataURL,
      mimeType: typeof file.mimeType === 'string' && file.mimeType ? file.mimeType : 'image/png',
      created: typeof file.created === 'number' ? file.created : Date.now(),
    };
  }
  return files;
}

/**
 * A `.excalidraw` file as elements to seed, or a throw saying what is wrong with it.
 *
 * Lenient about one element and strict about the file. A shape the parser cannot make sense
 * of is skipped, the way `loadWorkspace` drops a field of the wrong type rather than losing
 * the whole project; a file that is not a scene at all is refused, because seeding half of
 * something nobody meant as a board is worse than coming up empty and saying so.
 *
 * A tombstone is dropped rather than stored. `isDeleted` travels through a live sync so a
 * client can be told about a removal it has not seen; a board being read from cold has
 * nobody to tell, and a stored tombstone would only be an element every count includes and
 * nothing draws.
 */
export function parseBoardScene(raw: string): BoardScene {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the file is not a JSON object');
  }

  const scene = parsed as { elements?: unknown; files?: unknown };
  if (!Array.isArray(scene.elements)) {
    throw new Error('the file has no "elements" array, so it is not a scene');
  }

  const elements: ServerElement[] = [];
  for (const candidate of scene.elements) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const element = candidate as ServerElement;
    if (typeof element.id !== 'string' || !element.id) continue;
    if ((element as { isDeleted?: unknown }).isDeleted) continue;
    elements.push(seedableElement(element));
  }

  return { elements, files: readFiles(scene.files) };
}
