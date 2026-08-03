/**
 * One peer's projects, as tabs on this board's strip — and what is left when that machine sleeps.
 *
 * It asks a peer for its projects, names each one locally through `core/remote-workspace-id.ts`,
 * reduces each record to what may cross through `core/remote-workspace-view.ts`, and attaches one
 * of `core/peer-liveness.ts`'s four states. Everything interesting about it is a decision about
 * where a fact is allowed to land.
 *
 * **A machine that is asleep is not a broken project, and that is one field name.** A peer that
 * does not answer contributes **zero projects and one liveness state**, and specifically *not* a
 * `Workspace.error`. `error` is what `core/workspaces.ts` sets when a project's *configuration*
 * cannot be resolved: it draws the `!` glyph and the `--broken` underline on a tab, and it gates
 * real behaviour — an implement run refuses outright on a project carrying one, and the
 * implementation queue treats that board as unusable. Writing *the laptop is asleep* there would
 * dress a transient fact about a network in the clothes of a permanent fact about a
 * configuration, and the day the host's own projects and a peer's share a code path it would be
 * this board's *own* runs that started refusing. So there is no field on {@link PeerWorkspaces}
 * for a liveness fact to be written into by accident: the state travels beside the projection,
 * the projection's `error` is the owner's own and nothing else, and
 * `scripts/check-peer-workspaces.mjs` asserts that every `error` anywhere in an unreachable
 * peer's answer is null. See `docs/federation.md`.
 *
 * **It touches no per-id store, and that is not an accident of the code as written.**
 * `elementsFor` yields an empty store for an unknown id *by design* — it is documented as
 * deliberately forgiving — and eleven sibling maps are created on first use the same way. So a
 * stray local read here would not fail; it would manufacture a plausible blank board for a
 * project another machine owns, and the operator would be looking at an empty canvas that reads
 * as their laptop's. Nothing below reads or writes an element store, a board-state file, a
 * terminal session or an implement record, the check holds the import list to that, and it then
 * asks the *local* server for the elements of every namespaced id to prove it from outside.
 *
 * **A peer's project is never written into the local workspace registry.** It is discovered from
 * the peer on every read and marked on the wire by the shape of its id. That is why there is no
 * third `WorkspaceEnvironment` kind and no fourth registry field: with no local entry, no local
 * resolver, spawner, `gh` call or worktree can ever be handed one, and the `environment.kind`
 * reads that fall through to the native branch are never reached with something they do not
 * understand. The refusal lives at the route rather than in ten switch statements.
 *
 * **The peer's own spelling is retained beside the local one.** {@link PeerWorkspaceTab.remoteId}
 * is what the owning board calls the project, kept rather than re-derived at the point of use:
 * the forwarder and the socket both have to send that spelling back, and two places deriving it
 * separately is how the two drift.
 *
 * **Pure, with the transport a defaulted argument.** Nothing in `src/` passes it — the convention
 * `core/peer-liveness.ts` states for its connector, its fetch and its clock, and for the same
 * reason: a board that can be *told* what another machine said is a board that can be lied to
 * about a peer. It reads no file and no `process.env`, and the budget below is a constant here
 * rather than a setting, because a setting drags in the generated tables in `docs/running.md`,
 * the generator that writes them, and two rules that red any prose stating a count of the
 * variable set. The default is `core/peer-client.ts`'s `callPeer`, which is where the header
 * discipline lives — this board's own token crosses in neither spelling, the device credential
 * replaces it in exactly one place, and a redirect is not followed — so none of that is decided
 * again here.
 */

import {
  PEER_CALL_BUDGET_MS,
  PEER_CALL_CONNECT_BUDGET_MS,
  callPeer
} from './peer-client.js';
import {
  PEER_CONNECT_BUDGET_MS,
  PEER_REQUEST_BUDGET_MS,
  createPeerLiveness,
  type PeerLiveness,
  type PeerLivenessDesk,
  type PeerLivenessState,
  type PeerTarget
} from './peer-liveness.js';
import { mintRemoteWorkspaceId } from './remote-workspace-id.js';
import {
  projectWorkspaceForPeer,
  remoteWorkspaceLocation,
  type RemoteWorkspaceView
} from './remote-workspace-view.js';

/**
 * As much of a peer as this module reads.
 *
 * Structural rather than imported: a `PeerRecord` from `core/peer-registry.ts` satisfies it, and
 * a caller holding one hands it straight in. `secret` is optional because a check — and a board
 * that has not been paired yet — has none, and a missing credential is a refusal from the peer
 * rather than a reason not to ask.
 */
export interface PeerBoard {
  /** This board's id for the peer. Half of every local id minted below. */
  id: string;
  /** What this operator calls that machine. Theirs, and what a tooltip names it by. */
  name: string;
  /** Where that board answers: scheme, host and port, and nothing after them. */
  baseUrl: string;
  /** The credential this board holds on that peer, when it holds one. */
  secret?: string;
}

/** One of a peer's projects, named here, drawn here, and owned there. */
export interface PeerWorkspaceTab {
  /**
   * What this board calls it — `core/remote-workspace-id.ts`'s minting, which is guaranteed to
   * survive the normaliser that decides which board a socket lands on.
   */
  id: string;
  /** Which machine owns it: this board's id for that peer. */
  peerId: string;
  /** The peer's own spelling, retained rather than re-derived. What goes back on the wire. */
  remoteId: string;
  /** What a person reads on the tab. */
  name: string;
  /**
   * The project's configuration could not be resolved **on the machine that owns it**.
   *
   * Never *the peer is asleep*, never *the credential was refused*, never *nothing answered*.
   * Those are {@link PeerWorkspaces.liveness}, and the distinction is the whole module.
   */
  error: string | null;
  /** What replaces the path in the tab's tooltip: the project's name and the machine's. */
  location: string;
  /** How the machine that owns this project is answering, right now. */
  liveness: PeerLiveness;
}

/**
 * One peer, and the tabs it contributes.
 *
 * There is deliberately no `error` on this interface. The only thing that could be written into
 * one is a fact about the machine, and a fact about the machine is {@link liveness}.
 */
export interface PeerWorkspaces {
  peerId: string;
  peerName: string;
  baseUrl: string;
  /** One state for the peer, and the same object on each of its tabs. */
  liveness: PeerLiveness;
  /** Empty whenever the peer did not answer with a list of projects. */
  workspaces: PeerWorkspaceTab[];
  /**
   * Projects the peer named that could not be named here, each with the sentence saying why.
   *
   * A project whose id cannot be namespaced inside the length a workspace id has is refused by
   * `mintRemoteWorkspaceId` rather than truncated, because a truncated id is a valid id for a
   * different board. The sentence is kept so a surface can say which project went missing and
   * what to shorten, instead of a tab quietly not being there.
   */
  refusals: string[];
}

/** What a peer was asked for, and what it came back with. */
export type PeerWorkspacesReply =
  | { ok: true; workspaces: unknown }
  | {
      ok: false;
      /**
       * Which of the four answers this failure is, in `core/peer-liveness.ts`'s vocabulary.
       *
       * A transport reports the state rather than a boolean because *it answered and would not
       * have this board* and *nothing usable answered* are two different repairs, and
       * `core/peer-client.ts` has already made that classification — including which of the two
       * 403s a 403 is. Anything but `refused` is read as `unreachable`: a failure is never
       * `online`, and `checking` is a thing a desk says rather than a thing a call comes back as.
       */
      liveness: PeerLivenessState;
      reason: string;
    };

/** How a peer is asked. Defaulted, and nothing in `src/` passes it — see the banner. */
export type PeerWorkspacesTransport = (target: PeerTarget) => Promise<PeerWorkspacesReply>;

export interface PeerWorkspacesDeps {
  /**
   * The desk that answers *is that machine there*. Defaulted to a fresh one, so a call with no
   * dependencies works; a caller polling several peers holds one of its own, because the desk is
   * where an answer's freshness and the one-probe-per-peer rule live.
   */
  liveness?: PeerLivenessDesk;
  transport?: PeerWorkspacesTransport;
  now?: () => number;
}

/**
 * The longest a peer may hold this answer.
 *
 * Composed from the budgets it is made of rather than picked, so that it cannot drift from what
 * the two steps actually spend: `createPeerLiveness` allows one connect and two requests deciding
 * whether a board is there and whether this one is allowed on it, and `callPeer` allows one
 * connect and one read for the list itself. A machine that is asleep does not refuse a
 * connection, it hangs — so without a ceiling here a tab strip would wait on a laptop in a bag.
 *
 * It is enforced rather than argued: past this point the answer is a liveness state and zero
 * projects. The number is the worst case of a peer that keeps accepting and keeps not answering,
 * not what an unreachable one costs — that one is refused or times out at the *connect* budget,
 * because the project list is never asked for at all until liveness says `online`.
 */
export const PEER_WORKSPACES_BUDGET_MS = PEER_CONNECT_BUDGET_MS + 2 * PEER_REQUEST_BUDGET_MS
  + PEER_CALL_CONNECT_BUDGET_MS + PEER_CALL_BUDGET_MS;

/**
 * The read a peer is asked for.
 *
 * The same path `core/peer-liveness.ts` uses as its credentialed probe, and for the same reason:
 * a peer that will not serve its projects is not a peer whose projects can be tabs, whatever
 * `/health` says.
 */
const PEER_WORKSPACES_PATH = '/api/workspaces';

/** How much of the peer's own sentence a tooltip is given. Enough to act on, short of a page. */
const QUOTE_BUDGET = 300;

/** The peer's own words, trimmed to what a tooltip can hold and never invented. */
function said(body: string): string {
  let text = body.trim();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) text = parsed.error.trim();
  } catch { /* not JSON; whatever it sent is still what it said */ }
  if (!text) return 'nothing at all';
  return text.length > QUOTE_BUDGET ? `${text.slice(0, QUOTE_BUDGET)}…` : text;
}

/**
 * The default transport: `core/peer-client.ts`, asked for the one path.
 *
 * Everything about *how* a board is called belongs to that module and is deliberately not decided
 * again here — which headers cross, that this board's own token crosses in neither spelling, that
 * a redirect is not followed, and which of the two 403s a 403 is. What is left for this function
 * is the one thing that is about *workspaces*: a 2xx whose body is a list of projects is the only
 * answer that is one, and every other status the peer's own routes produced is a peer that
 * answered and did not serve this. That reads as `refused` rather than as a machine that is
 * asleep, because something on the other end plainly is not.
 */
async function askThePeer(target: PeerTarget): Promise<PeerWorkspacesReply> {
  const result = await callPeer(
    { baseUrl: target.url, secret: target.token ?? '' },
    { path: PEER_WORKSPACES_PATH, headers: { accept: 'application/json' } }
  );
  if (!result.ok) return { ok: false, liveness: result.liveness, reason: result.reason };

  const body = result.body.toString('utf8');
  if (result.status < 200 || result.status > 299) {
    return {
      ok: false,
      liveness: 'refused',
      reason: `${target.url}${PEER_WORKSPACES_PATH} answered ${result.status}, so this board `
        + `cannot read that machine's projects. It said: ${said(body)}`
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      liveness: 'refused',
      reason: `${target.url}${PEER_WORKSPACES_PATH} answered ${result.status} and what came back `
        + 'was not JSON, so it is not a project list this board can draw.'
    };
  }
  return { ok: true, workspaces: (parsed as { workspaces?: unknown } | null)?.workspaces };
}

/**
 * One record off the wire, reduced to the three fields that may cross.
 *
 * Read defensively and then handed through `projectWorkspaceForPeer`, rather than trusted because
 * the machine at the other end is supposed to have projected it already. The projection is what
 * guarantees a fourth field cannot reach a tab, and the guarantee is worth having on the reading
 * end too: this board does not get to assume the peer is running the same version of itself.
 *
 * A record with no id is not a project — there would be nothing to address it by — and it is
 * dropped rather than defaulted into one. A blank `error` reads as none: an owner sending `""`
 * means the same thing as an owner sending nothing, and only one of the two should draw a warning.
 */
function readRecord(value: unknown): RemoteWorkspaceView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) return null;
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
  const error = typeof entry.error === 'string' && entry.error.trim() ? entry.error.trim() : null;
  return projectWorkspaceForPeer({ id, name, error });
}

/**
 * A peer that contributed nothing, and the one state saying why.
 *
 * This is the shape the whole issue is about: zero projects, one liveness state, and no field
 * anywhere for the reason to be written as an `error`.
 */
function nothingFrom(peer: PeerBoard, liveness: PeerLiveness): PeerWorkspaces {
  return {
    peerId: peer.id,
    peerName: peer.name,
    baseUrl: peer.baseUrl,
    liveness,
    workspaces: [],
    refusals: []
  };
}

/**
 * The answer, or the budget's answer, whichever comes first.
 *
 * The timer is *not* unref'd: an unref'd deadline in an otherwise idle process is a deadline that
 * never fires, which is exactly the case a check drives. It is cleared as soon as the race
 * settles, so it holds nothing open either way.
 */
function withBudget(
  work: () => Promise<PeerWorkspaces>,
  late: () => PeerWorkspaces
): Promise<PeerWorkspaces> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overdue = new Promise<PeerWorkspaces>(resolve => {
    timer = setTimeout(() => resolve(late()), PEER_WORKSPACES_BUDGET_MS);
  });
  return Promise.race([work(), overdue]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * What one peer contributes to this board's tab strip.
 *
 * Asked in two steps on purpose. The liveness probe answers *is that machine there, and is this
 * board allowed on it* — and it is what decides that the credential goes to no port until that
 * port has said it is a board of ours. Only then is the project list asked for. A peer that is
 * not `online` is never fetched from at all, which is also why an unreachable one answers inside
 * the connect budget rather than inside a request timeout.
 */
export function listPeerWorkspaces(
  peer: PeerBoard,
  deps: PeerWorkspacesDeps = {}
): Promise<PeerWorkspaces> {
  const now = deps.now ?? Date.now;
  const liveness = deps.liveness ?? createPeerLiveness();
  const transport = deps.transport ?? askThePeer;
  const target: PeerTarget = {
    url: peer.baseUrl,
    ...(peer.secret ? { token: peer.secret } : {})
  };
  const answer = (state: PeerLivenessState, reason: string): PeerLiveness =>
    ({ state, reason, at: now() });

  return withBudget(async () => {
    const state = await liveness.check(target);
    if (state.state !== 'online') return nothingFrom(peer, state);

    const reply = await transport(target);
    if (!reply.ok) {
      // It was there a moment ago and the list did not arrive. Still a fact about the machine,
      // so it lands on the state — one of the four, and never on a project. Clamped rather than
      // trusted: a failure is not `online`, and `checking` is what a desk says about a probe that
      // is still out rather than something a finished call can come back as.
      return nothingFrom(peer,
        answer(reply.liveness === 'refused' ? 'refused' : 'unreachable', reply.reason));
    }
    if (!Array.isArray(reply.workspaces)) {
      return nothingFrom(peer, answer('unreachable',
        `${peer.baseUrl} answered and what came back was not a list of projects, so this board `
        + 'has nothing to draw for that machine.'));
    }

    const workspaces: PeerWorkspaceTab[] = [];
    const refusals: string[] = [];
    for (const record of reply.workspaces) {
      const view = readRecord(record);
      if (!view) {
        refusals.push(`${peer.name} sent a record with no id, which is not a project this board `
          + 'can address. It is dropped rather than given one.');
        continue;
      }
      const minted = mintRemoteWorkspaceId(peer.id, view.id);
      if (!minted.ok) {
        refusals.push(minted.refusal);
        continue;
      }
      workspaces.push({
        id: minted.id,
        peerId: peer.id,
        remoteId: view.id,
        name: view.name,
        error: view.error,
        location: remoteWorkspaceLocation(view, peer.name),
        liveness: state
      });
    }

    return {
      peerId: peer.id,
      peerName: peer.name,
      baseUrl: peer.baseUrl,
      liveness: state,
      workspaces,
      refusals
    };
  }, () => nothingFrom(peer, answer('unreachable',
    `${peer.baseUrl} did not answer within ${PEER_WORKSPACES_BUDGET_MS} ms, so this board stopped `
    + 'waiting for it. A machine that is asleep does not refuse a connection, it hangs.')));
}
