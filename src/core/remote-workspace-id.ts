/**
 * A peer's project, named on this board, in a spelling the peer's own normaliser hands back.
 *
 * `normalizeWorkspaceId` in `core/element-store.ts` **does not reject**. Anything failing the
 * class it applies is rewritten to the literal id `default`, and the WebSocket upgrade path
 * applies it to the `?workspace=` off the query with no registry lookup at all. So a namespacing
 * scheme spelled `pc:board-tool` or `pc/board-tool` does not error: it silently lands that socket
 * on this machine's shared `default` board and starts streaming it. Nothing logs. The page just
 * shows the wrong scene, and the operator has no thread to pull. That is the failure this module
 * exists to make impossible, and it is decided by a regular expression rather than by anything a
 * reviewer would look at — which is why the guarantee below is asserted against that expression
 * rather than argued about.
 *
 * **Both directions, and the second is the one the wire needs.** Minting answers *what do I call
 * that machine's project here*; splitting answers *given a local id, what spelling does the
 * peer's own normaliser expect on the upstream URL*. Getting the inverse wrong is how a forwarded
 * request reaches the right machine and the wrong board — the same silent failure one hop later.
 *
 * **Only `.`, `-` and `_` are available**, because they are the only non-alphanumeric characters
 * the class admits, and the whole result has to stay inside {@link WORKSPACE_ID_BUDGET}
 * characters including the first-character constraint. An id that cannot be namespaced inside
 * that budget is **refused with a sentence naming it** — never truncated, because a truncated id
 * is a valid id for a different board, and never collapsed, because the collapse is the defect.
 *
 * **Why a separator alone cannot do it.** `<peer>.<workspace>` looks like the answer and is not
 * invertible: an id may contain every one of the three separators, in runs, and may end in one,
 * so `a.b` holding `c` and `a` holding `b.c` would be the same string and one of those two boards
 * would be unreachable. There is no character left to escape with either. So the length of the
 * peer's id is written into the id, in a fixed two digits, and the split is a slice rather than a
 * search. It costs nine characters of the budget and it is exact.
 *
 * **This module creates nothing and stores nothing.** It reads no file, opens no socket and reads
 * no `process.env`, and it touches none of the per-id maps: the store for an unknown id is
 * created empty on first use by design, and eleven sibling maps behave the same way, so a stray
 * read here would not fail — it would manufacture a plausible-looking blank local board for a
 * project another machine owns. It is a pure function of its two arguments and back again.
 */

import { normalizeWorkspaceId } from './element-store.js';

/**
 * The longest a workspace id may be: what `normalizeWorkspaceId` accepts, one first character
 * plus sixty-three more. Stated here as the budget every refusal below names, and asserted
 * against the real normaliser rather than restated as a pattern.
 */
export const WORKSPACE_ID_BUDGET = 64;

/**
 * The namespace a peer's project lives in locally, and it is reserved.
 *
 * A local project whose own id begins this way and continues with the rest of the shape would be
 * read as a peer's, and there is no character in the class that could have prevented it. Exported
 * so a caller that registers local projects can refuse the namespace outright rather than
 * discover the clash from a tab pointing at nothing.
 */
export const REMOTE_WORKSPACE_ID_PREFIX = 'peer.';

/** The one separator this shape uses. `-` and `_` stay available to the ids themselves. */
const SEPARATOR = '.';

/**
 * How many digits carry the peer id's length. Two is always enough and never one too few: the
 * peer id is itself an id, so it is at most {@link WORKSPACE_ID_BUDGET} characters, and it has to
 * be at least one.
 */
const PEER_LENGTH_DIGITS = 2;

/** Exactly the digits, and no leniency about how many: a second spelling is a second board. */
const LENGTH_FIELD = /^[0-9]{2}$/;

/** A peer's project: which machine, and what that machine calls it. */
export interface RemoteWorkspacePair {
  /** This board's id for the peer, as its peer registry holds it. */
  peerId: string;
  /** The peer's own spelling — what goes on the upstream URL, and nothing derived from it. */
  workspaceId: string;
}

/**
 * A local id, or a sentence saying why there is none.
 *
 * A union rather than a throw, and rather than a fallback, because the whole subject of this
 * module is that a caller must not be able to carry on with something plausible instead. There
 * is nothing to reach for on the refusing branch.
 */
export type RemoteWorkspaceIdMint =
  | { ok: true; id: string }
  | { ok: false; refusal: string };

/** Whether the other board's own normaliser hands this back unchanged. The only test applied. */
function accepted(value: unknown): value is string {
  return typeof value === 'string' && normalizeWorkspaceId(value) === value;
}

/** What the peer would make of a spelling it will not accept, quoted in the refusal. */
function rewrittenTo(value: unknown): string {
  return normalizeWorkspaceId(typeof value === 'string' ? value : null);
}

function refuseSpelling(role: string, value: unknown): { ok: false; refusal: string } {
  return {
    ok: false,
    refusal: `${JSON.stringify(String(value))} cannot be the ${role} half of a local id: a `
      + 'workspace id is what the owning board\'s own normaliser hands back unchanged, and that '
      + `one it rewrites to ${JSON.stringify(rewrittenTo(value))}. It is refused here rather `
      + 'than namespaced, because an id that collapses reaches a board nobody named.',
  };
}

/**
 * What this board calls `workspaceId` on `peerId`.
 *
 * The result is guaranteed to survive `normalizeWorkspaceId` unchanged, and that guarantee is
 * checked below rather than argued from the shape — the argument is the thing that would rot.
 */
export function mintRemoteWorkspaceId(peerId: string, workspaceId: string): RemoteWorkspaceIdMint {
  if (!accepted(peerId)) return refuseSpelling('peer', peerId);
  if (!accepted(workspaceId)) return refuseSpelling('project', workspaceId);

  const length = String(peerId.length).padStart(PEER_LENGTH_DIGITS, '0');
  const id = `${REMOTE_WORKSPACE_ID_PREFIX}${length}${SEPARATOR}${peerId}${SEPARATOR}${workspaceId}`;

  if (id.length > WORKSPACE_ID_BUDGET) {
    return {
      ok: false,
      refusal: `${JSON.stringify(workspaceId)} on peer ${JSON.stringify(peerId)} cannot be `
        + `namespaced inside ${WORKSPACE_ID_BUDGET} characters: naming both would take `
        + `${id.length}, and a workspace id may be at most ${WORKSPACE_ID_BUDGET}. Nothing is `
        + 'truncated to fit, because a truncated id is a valid id for a different board. Shorten '
        + 'the project name on the machine that owns it, or this board\'s id for that machine.',
    };
  }

  // The guarantee, taken from the normaliser itself. It cannot fail for a pair that got this
  // far, and it is here so that the reason it cannot is a fact about the code rather than a
  // paragraph: whatever that expression becomes, this function answers for the composition.
  if (normalizeWorkspaceId(id) !== id) {
    return {
      ok: false,
      refusal: `${JSON.stringify(id)} is not a spelling a board would keep — it reads as `
        + `${JSON.stringify(normalizeWorkspaceId(id))}. Nothing was minted.`,
    };
  }

  return { ok: true, id };
}

/**
 * Which machine a local id belongs to, and what that machine calls the project.
 *
 * `null` for anything this module did not mint — a local project, a near miss, a second spelling
 * of a shape it does mint. That last one is why the answer is checked by minting it again: one
 * pair has exactly one local id, so a spelling this function could not have produced is not a
 * board with an unusual name, it is a board that does not exist.
 */
export function splitRemoteWorkspaceId(id: string): RemoteWorkspacePair | null {
  if (typeof id !== 'string' || !id.startsWith(REMOTE_WORKSPACE_ID_PREFIX)) return null;

  let at = REMOTE_WORKSPACE_ID_PREFIX.length;
  const length = id.slice(at, at + PEER_LENGTH_DIGITS);
  if (!LENGTH_FIELD.test(length)) return null;
  at += PEER_LENGTH_DIGITS;

  if (id[at] !== SEPARATOR) return null;
  at += SEPARATOR.length;

  const peerId = id.slice(at, at + Number(length));
  at += Number(length);
  if (id[at] !== SEPARATOR) return null;

  const pair: RemoteWorkspacePair = { peerId, workspaceId: id.slice(at + SEPARATOR.length) };
  const again = mintRemoteWorkspaceId(pair.peerId, pair.workspaceId);
  return again.ok && again.id === id ? pair : null;
}

/** Whether a local id names a peer's project rather than one of this machine's own. */
export function isRemoteWorkspaceId(id: string): boolean {
  return splitRemoteWorkspaceId(id) !== null;
}
