/**
 * Which pictures cross: the files a remote board's scene refers to.
 *
 * Files are the one thing in this server deliberately **not** keyed by workspace. The store is
 * process-global and content-addressed, and scoping happens by reference at serve time and at
 * save time through the same walk — `filesForWorkspace` in `src/server.ts` and `filesFor` in
 * `core/board-state.ts` both compute the referenced set from the elements rather than reading a
 * per-board bucket, because there is no per-board bucket.
 *
 * That design is right and it has a consequence federation cannot avoid: **there is nothing to
 * hand over.** A board that forwards a remote scene without its files draws references to
 * pictures the local process has never held, and the set that has to cross can only be computed
 * from the elements. This module computes it, once, with `referencedFileIds` rather than a second
 * implementation of it: two walks that disagree about which files a scene refers to is a bug that
 * presents as missing images on one machine only, which is the hardest kind to be shown.
 *
 * It is a pure module with no caller yet. It is groundwork: the HTTP forwarder needs it the
 * moment a remote board's scene contains an image, and the socket forwarder — which is not in
 * this plan — needs it more. Filing the decision here rather than inside one of those keeps it in
 * one place instead of two.
 *
 * **Fetched through the peer, and not looked for here first.** Every picture the walk names is
 * asked of the machine that owns the board, one at a time, by id. A content-addressed store makes
 * a local hit look correct — the id matches, the bytes decode, the canvas draws something — and a
 * local hit for a peer's id means either that two different images shared an id or that this
 * board has quietly been handed something. Neither is a thing to paper over by drawing whichever
 * picture was to hand.
 *
 * **And by id rather than by asking for that board's listing**, which is the same decision seen
 * from the other end. `GET /api/files` on the peer is scoped by reference *today*; before #343 it
 * answered with every dataURL the process held, for every board. A forwarder that trusted a
 * peer's listing would therefore be correct against one build of this server and would hand a
 * board another board's pictures against another, with nothing on either machine saying so. The
 * ids come from the walk here, so the version at the far end cannot change which pictures cross.
 *
 * **Nothing is kept.** A peer's bytes are not written into a store keyed by workspace, because
 * that would be inventing the per-board bucket the design deliberately does not have, on the
 * machine that owns none of it. There is no cache here at all: two reads of a board that is being
 * drawn on are two different scenes, and a picture served from something kept a minute ago is a
 * picture that has already been wrong once.
 *
 * **A failure is a value**, exactly as `core/peer-client.ts` hands it over, and it travels
 * unchanged: the caller is a route handler that has to tell a browser something honest, and *the
 * machine is asleep* is a different sentence from *the credential was refused*. Nothing here
 * throws at its caller and nothing here logs.
 *
 * **The transport is a defaulted argument** and nothing in `src/` passes it — the convention
 * `callPeer`, `createPeerLiveness` and `listRoots` established, and for the same reason: a board
 * that can be *told* who answered is a board that can be lied to about a peer. This module reads
 * no `process.env`, opens no socket of its own and reads no file.
 *
 * What is deliberately not here: a byte budget. `BOARD_IMAGE_BUDGET_BYTES` bounds what a *saved
 * scene* may carry, because that write happens on a one-second debounce for as long as somebody
 * is drawing. A forwarded read is not a save, and a second ceiling invented here would drop
 * pictures a caller never agreed to lose.
 */

import { referencedFileIds, type BoardFile, type FileBearingElement } from './board-files.js';
import { normalizeWorkspaceId } from './element-store.js';
import {
  callPeer,
  PEER_CALL_LIVENESS,
  type PeerCall,
  type PeerCallKind,
  type PeerCallResult,
  type PeerCallTarget,
  type PeerFailure
} from './peer-client.js';
import type { PeerLivenessState } from './peer-liveness.js';
import { isRemoteWorkspaceId, splitRemoteWorkspaceId } from './remote-workspace-id.js';

/**
 * Every way this can come out, and it is `core/peer-client.ts`'s list with one addition.
 *
 * `unreadable` is a peer that answered and whose answer was not the thing that was asked for — a
 * proxy's sign-in page, a route that has moved, a picture arriving under an id nobody asked
 * about. It is not one of the client's outcomes because that module deliberately has no opinion
 * about the bytes it carries, and having one is this module's whole job.
 */
export type PeerFilesKind = PeerCallKind | 'unreadable';

/**
 * Which of the four answers each outcome is.
 *
 * The client's table, extended by one rather than restated: a second copy of the vocabulary is a
 * copy that drifts. `unreadable` is **online**, and that is a decision rather than an oversight —
 * the machine replied, so reporting it as unreachable would send its operator to look at a
 * network that is working.
 */
export const PEER_FILES_LIVENESS: Record<PeerFilesKind, PeerLivenessState> = {
  ...PEER_CALL_LIVENESS,
  unreadable: 'online'
};

/** The board whose pictures are wanted, and the scene if the caller already has it. */
export interface PeerScene {
  /**
   * The board's id **as the owning machine spells it** — what `splitRemoteWorkspaceId` hands
   * back, never this board's own name for it. The two are told apart below rather than trusted.
   */
  workspaceId: string;
  /**
   * The scene, where the caller is already holding one. A forwarder that has just read a board
   * passes what it read: asking for it a second time would walk a scene that is not the one it
   * is about to hand on, and a board being drawn on changes between the two reads.
   */
  elements?: Iterable<FileBearingElement>;
}

/** How a request reaches the peer. Defaulted, and nothing in `src/` passes it. */
export interface PeerFilesDeps {
  call?: (peer: PeerCallTarget, call: PeerCall) => Promise<PeerCallResult>;
}

/** The pictures a remote board's scene refers to, and the bytes that machine holds for them. */
export interface PeerFiles {
  ok: true;
  /** Every id the scene names, in scene order, deduplicated: the walk's own answer. */
  ids: string[];
  /** The bytes, as the owning machine wrote them. Never from anything on this machine. */
  files: BoardFile[];
  /**
   * Ids the owning machine no longer holds.
   *
   * A real answer about a picture rather than a failure of the link, and never a reason to look
   * here instead: a shape pointing at a file its own machine has dropped is a hole on that
   * machine too, and drawing something else in it would hide that from both operators.
   */
  missing: string[];
}

/** Why there are none, in one sentence a surface can show verbatim. */
export interface PeerFilesRefusal {
  ok: false;
  kind: PeerFilesKind;
  liveness: PeerLivenessState;
  reason: string;
  status?: number;
}

export type PeerFilesResult = PeerFiles | PeerFilesRefusal;

/**
 * The three frames a forwarded link carries about pictures and shapes, and what each one means
 * when it arrives from another machine.
 *
 * They are named here so that the HTTP forwarder and the socket forwarder implement **one**
 * decision rather than each taking their own. Since #526 every one of them names the board it
 * happened on, so an image pasted on one machine reaches sockets declaring that machine's board
 * and no other — which is what makes a forwarded frame routable at all, and what the decisions
 * below rest on.
 */
export const PEER_FILE_EVENTS: readonly string[] = ['files_added', 'file_deleted', 'elements_synced'];

/** What a forwarder does with one of them. */
export interface ForwardedFileEvent {
  /** Whether the frame carries file bytes, rather than only naming them. */
  carriesBytes: boolean;
  /** Whether the referenced set has to be walked again once this has been applied. */
  rewalks: boolean;
  /**
   * What becomes of the board on the frame. One value, because there is one right answer: the
   * owning machine's spelling means nothing to a socket here, and a frame relabelled to this
   * board's name for that project reaches the tab that is watching it. A frame that cannot be
   * relabelled — no board on it, or a board this link does not carry — is **dropped**, never
   * broadcast without one: `broadcast` with no workspace reaches every client, so fanning it
   * wider is how one project's image lands in every project open in the browser.
   */
  board: 'relabel-to-local';
  /**
   * Whether anything is written into a store on this machine. Always false, and this is where
   * that is stated per frame rather than left to each forwarder to decide again.
   */
  storesLocally: false;
  /** The decision, for a reader. */
  says: string;
}

export const FORWARDED_FILE_EVENTS: Record<string, ForwardedFileEvent> = {
  files_added: {
    carriesBytes: true,
    rewalks: false,
    board: 'relabel-to-local',
    storesLocally: false,
    says: 'The bytes are handed to the tab watching that board, relabelled to this board\'s name '
      + 'for the project, and written into no store here. The browser holds them for as long as '
      + 'the scene is on screen, which is exactly as long as they are wanted: a picture kept here '
      + 'would be a per-board bucket on the machine that owns none of the board.'
  },
  file_deleted: {
    carriesBytes: false,
    rewalks: false,
    board: 'relabel-to-local',
    storesLocally: false,
    says: 'An id in the owning machine\'s store has gone. Nothing on this machine is deleted for '
      + 'it — the store here is content-addressed and process-global, so the same id may be a '
      + 'picture on one of this operator\'s own boards, and honouring a peer\'s deletion would '
      + 'take it. What it changes is a picture on that board, which is that board\'s to lose.'
  },
  elements_synced: {
    carriesBytes: false,
    rewalks: true,
    board: 'relabel-to-local',
    storesLocally: false,
    says: 'The scene changed, so the referenced set is stale and is walked again from the new '
      + 'elements. Nothing is evicted, because nothing was kept: a picture the new scene no '
      + 'longer names simply stops being asked for.'
  }
};

/** The board's own route, as the owning machine spells its query. */
const scenePath = (workspaceId: string): string =>
  `/api/elements?workspace=${encodeURIComponent(workspaceId)}`;

/**
 * One picture, by id.
 *
 * The board is named on it even though that route reads the process-global store: the id came
 * from *that* board's walk, and a request that says which board it is about is one an operator
 * reading the other machine's log can follow.
 */
const picturePath = (workspaceId: string, id: string): string =>
  `/api/files/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspaceId)}`;

const refused = (kind: PeerFilesKind, reason: string, status?: number): PeerFilesRefusal =>
  ({ ok: false, kind, liveness: PEER_FILES_LIVENESS[kind], reason, ...(status === undefined ? {} : { status }) });

/**
 * Whether that id names a board on the machine being asked, or a sentence saying why it does not.
 *
 * Both refusals are the same failure, and it is a silent one. `normalizeWorkspaceId` **does not
 * reject**: a spelling outside the class it applies is rewritten to the literal id `default`, so
 * a request carrying one reaches the right machine and its shared `default` board, is answered
 * with whatever is on it, and logs nothing anywhere. This board's own name for a peer's project
 * is the same trap wearing a valid spelling — `peer.NN.<peer>.<board>` survives the normaliser
 * intact and names a board that machine has never heard of, so the answer is an empty scene and
 * a page with no pictures on it and no thread to pull.
 */
function notABoardOn(workspaceId: unknown): PeerFilesRefusal | null {
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return refused('unaddressable',
      `${JSON.stringify(String(workspaceId))} is not a board on that machine, so nothing was `
      + 'sent. What goes upstream is the id the owning board knows the project by.');
  }
  const pair = splitRemoteWorkspaceId(workspaceId);
  if (isRemoteWorkspaceId(workspaceId) && pair) {
    return refused('unaddressable',
      `${JSON.stringify(workspaceId)} is this board's own name for a project on another machine, `
      + 'and that machine has never heard of it. It would be accepted there as a board of that '
      + `name and answered with an empty scene. Send ${JSON.stringify(pair.workspaceId)}, which `
      + 'is what that machine calls the project.');
  }
  if (normalizeWorkspaceId(workspaceId) !== workspaceId) {
    return refused('unaddressable',
      `${JSON.stringify(workspaceId)} is not a spelling the owning board keeps — it rewrites it `
      + `to ${JSON.stringify(normalizeWorkspaceId(workspaceId))}, which is that machine's shared `
      + 'board rather than the project. Nothing was sent, because a request that lands there is '
      + 'answered with somebody else\'s scene and logged as nothing at all.');
  }
  return null;
}

/** What the peer wrote, as JSON, or null for anything that is not. */
function jsonBody(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Enough of a file to be one: an id that is the one asked for, and bytes behind it. */
function fileFrom(value: unknown, id: string): BoardFile | null {
  const file = value as Partial<BoardFile> | null | undefined;
  if (!file || typeof file !== 'object') return null;
  if (file.id !== id) return null;
  if (typeof file.dataURL !== 'string' || !file.dataURL) return null;
  return file as BoardFile;
}

/**
 * The pictures a peer's board refers to, fetched from the machine that owns it.
 *
 * The scene is read first unless the caller passed one, walked here, and every id it names is
 * asked of that machine by id. A call that fails part of the way through is handed back as the
 * failure it was rather than as a short set: a caller told *here are the pictures* would draw a
 * board with holes in it and no reason to show anybody.
 */
export async function fetchPeerFiles(
  peer: PeerCallTarget,
  scene: PeerScene,
  deps: PeerFilesDeps = {}
): Promise<PeerFilesResult> {
  const call = deps.call ?? callPeer;
  const workspaceId = scene?.workspaceId as string;

  const wrongBoard = notABoardOn(workspaceId);
  if (wrongBoard) return wrongBoard;

  let elements = scene?.elements;
  if (!elements) {
    const answer = await call(peer, { path: scenePath(workspaceId) });
    if (!answer.ok) return answer as PeerFailure;
    const body = answer.status === 200 ? jsonBody(answer.body) : null;
    const served = body?.elements;
    if (!Array.isArray(served)) {
      return refused('unreadable',
        `${JSON.stringify(workspaceId)} was asked for and what came back was not a scene `
        + `(${answer.status}). The machine answered, so it is there and this is what it said `
        + 'rather than whether it is awake.', answer.status);
    }
    elements = served as FileBearingElement[];
  }

  // The one walk. Everything below is about the ids this produced, and nothing adds to them.
  const ids = referencedFileIds(elements);
  const carried: BoardFile[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const answer = await call(peer, { path: picturePath(workspaceId, id) });
    if (!answer.ok) return answer as PeerFailure;
    if (answer.status === 404) { missing.push(id); continue; }
    const file = fileFrom(jsonBody(answer.body)?.file, id);
    if (!file) {
      return refused('unreadable',
        `The picture ${JSON.stringify(id)} on ${JSON.stringify(workspaceId)} came back as `
        + `something that is not that picture (${answer.status}). A file arriving under an id `
        + 'nobody asked about is not drawn, because the id is the only thing here that says '
        + 'which shape it belongs to.', answer.status);
    }
    carried.push(file);
  }

  return { ok: true, ids, files: carried, missing };
}

/**
 * Every file id a scene refers to, in the order its elements name them.
 *
 * `referencedFileIds` itself, under the name this subject calls it: the ids an image element
 * carries and the ids a block has attached, with tombstones passing over. It is re-exported as a
 * function rather than aliased so that the one walk has one name on this side of the wire, and
 * so a caller reaching for *which pictures cross* is never tempted to write a second one.
 */
export function fileIdsThatCross(elements: Iterable<FileBearingElement>): string[] {
  return referencedFileIds(elements);
}
