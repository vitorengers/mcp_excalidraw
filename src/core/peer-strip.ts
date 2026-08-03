/**
 * The tab strip when two machines answer for it.
 *
 * `core/peer-workspaces.ts` answers *what does one peer contribute right now*, and everything
 * interesting about that question — which fields cross, what a machine that sleeps contributes,
 * and the budget the whole answer is held to — is decided there and deliberately not again here.
 * This is the thing that holds those answers **between calls**, so that `GET /api/workspaces`
 * reads a snapshot instead of waiting on a machine, and turns them into rows a tab strip draws.
 *
 * **The probe is on a timer and never on the request**, and that is the whole shape of this
 * module. A machine that is asleep does not refuse a connection, it hangs — so a strip that asked
 * its peers when the page asked it would spend every sleeping machine's budget on the one route
 * the page cannot render without, every poll. Worse, a page polling the strip would be what woke
 * a peer up. So a caller gets {@link PeerStripDesk.entries}, which is synchronous and answers
 * from the last completed round, and {@link PeerStripDesk.refresh} is what a timer drives.
 * {@link PEER_STRIP_ANSWER_BUDGET_MS} is what the route can promise as a result, and it is a
 * budget nothing here can spend.
 *
 * **`checking` is what a peer reads before there is a round, and after one has gone stale.** It
 * is one of `core/peer-liveness.ts`'s four answers rather than the absence of one, because a tab
 * that shows nothing while a probe is out is a tab that looks decided. A round older than
 * `PEER_ANSWER_FRESHNESS_MS` reads `checking` again rather than going on asserting a state nobody
 * has confirmed since — a laptop closes between one round and the next.
 *
 * **A machine that stops answering is not a broken project.** Its projects stop being tabs and
 * what is left is the peer itself, labelled and carrying the reason. Nothing is written into a
 * project's `error`: `core/peer-workspaces.ts` has no field for such a fact to land in and this
 * module adds none, because that field is a configuration failure and it *gates behaviour* — an
 * implement run refuses outright on a project carrying one. See `docs/federation.md`.
 *
 * **One liveness desk for the whole strip.** The desk is where an answer's freshness and the
 * one-probe-per-peer rule live, so a board watching four peers holds one rather than making a
 * fresh one per peer per round and losing both properties.
 *
 * **The clock and the lister are defaulted arguments nothing in `src/` passes** — the convention
 * `createPeerLiveness`, `wslUnsupportedHere` and `listRoots` established, and for the same
 * reason: a board that could be *told* who answered, or what time it is, is a board that can be
 * lied to about a peer. It reads no file and no `process.env`; the peers are handed in.
 */

import { normalizeWorkspaceId } from './element-store.js';
import { createPeerLiveness, PEER_ANSWER_FRESHNESS_MS } from './peer-liveness.js';
import {
  listPeerWorkspaces,
  type PeerBoard,
  type PeerWorkspaces,
  type PeerWorkspacesDeps
} from './peer-workspaces.js';
import { REMOTE_WORKSPACE_ID_PREFIX } from './remote-workspace-id.js';
import logger from '../utils/logger.js';

/**
 * How often a peer is asked, when there is one.
 *
 * Short enough that a laptop closing is on the strip while the operator still remembers closing
 * it, long enough that the machine on the other end is not being connected to constantly. The
 * round runs whether or not anybody is looking, which is the point: the first answer after a
 * start is honest rather than a guess. A round that is still out is not started again, so a peer
 * whose answer takes longer than this simply skips ticks.
 */
export const PEER_STRIP_REFRESH_MS = 5_000;

/**
 * What the strip route promises, and it is a promise this module makes keepable rather than one
 * it spends.
 *
 * `GET /api/workspaces` reads the last completed round, so the only thing between the request and
 * the answer is the local registry. It is stated as a number because a check can hold a route to
 * a number and cannot hold it to "does not wait".
 */
export const PEER_STRIP_ANSWER_BUDGET_MS = 1_000;

/**
 * How often a peer that is answering is written down as seen.
 *
 * `lastSeenAt` separates "added and never reached" from "last reached in March", which is the
 * question somebody is asking when they look at a peer that is quiet. Rate-limited because the
 * registry is rewritten whole on every update and the round runs every few seconds — the same
 * reason `noteDeviceSeen` limits its own side of the pair.
 */
export const PEER_SEEN_INTERVAL_MS = 5 * 60_000;

/** What a peer row is named when this board holds no name for the machine. */
const UNNAMED_PEER = 'another machine';

/** A board that approved this one. A `PeerRecord` is one; nothing here needs the rest of it. */
export interface StripPeer extends PeerBoard {
  /** The credential this board presents there. It is passed on and never read here. */
  secret: string;
}

/** Whether the machine holding a project is answering, and why, in words for the operator. */
export interface PeerLivenessMark {
  state: PeerWorkspaces['liveness']['state'];
  reason: string;
}

/**
 * One row of the strip that belongs to another machine.
 *
 * The fields are `WorkspaceSummary`'s in `frontend/src/components/WorkspaceTabs.tsx`, so a tab
 * draws a peer's project with the code that draws this board's own — and they are written out one
 * at a time rather than spread from anything, which is what keeps a path off a tab by
 * construction rather than by remembering to delete one.
 */
export interface PeerStripEntry {
  /** What this board calls the project: `core/remote-workspace-id.ts`'s minted id. */
  id: string;
  name: string;
  /** What goes where the path went. Never a path on anybody's disk. */
  path: string;
  /** Empty, always: a path inside a distro is the other half of what does not cross. */
  innerPath: string;
  /** Native, always: `kind` alone answers nothing here, and the distro name is the owner's. */
  environment: { kind: 'native' };
  docsDir: null;
  repo: null;
  githubProject: null;
  projectField: null;
  projectCardLimit: null;
  /** The owner's own `error` — a configuration failure, and never a fact about a network. */
  error: string | null;
  /** The second field, beside `error` and never inside it. */
  status: PeerLivenessMark;
}

export interface PeerStripDeps {
  /** How a peer is asked. Defaulted to `core/peer-workspaces.ts`'s own answer. */
  list?: (peer: StripPeer, given: PeerWorkspacesDeps) => Promise<PeerWorkspaces>;
  now?: () => number;
  /** Told when a peer answered, at most once per {@link PEER_SEEN_INTERVAL_MS}. */
  seen?: (peerId: string) => void;
}

export interface PeerStripDesk {
  /** What to draw right now, without waiting for anything. One of the four states per row. */
  entries(peers: StripPeer[]): PeerStripEntry[];
  /** What a peer's own row says right now — for the route that lists the peers themselves. */
  mark(peer: StripPeer): PeerLivenessMark;
  /** One round over every peer, concurrently. What a timer drives. */
  refresh(peers: StripPeer[]): Promise<void>;
  /** Forget a peer that has been forgotten, so nothing is remembered about a dead link. */
  forget(peer: StripPeer): void;
}

/** Said once per distinct complaint: a round runs every few seconds. */
const complained = new Set<string>();
function complain(message: string): void {
  if (complained.has(message)) return;
  complained.add(message);
  logger.warn(message);
}

/**
 * The id a peer's own row wears when it has no projects to show.
 *
 * Inside {@link REMOTE_WORKSPACE_ID_PREFIX}, which `core/remote-workspace-id.ts` reserves, so the
 * one funnel that refuses a peer-owned id refuses this one too — a row whose id looked local
 * would be a tab that manufactured an empty board on the first press, which is the failure that
 * namespace exists to make impossible. `board` rather than two digits, so it can never be read as
 * something `mintRemoteWorkspaceId` produced.
 */
function peerRowId(peerId: string): string | null {
  const id = `${REMOTE_WORKSPACE_ID_PREFIX}board.${peerId}`;
  // A peer id is minted by the machine that approved this one and is hex, so this cannot fail for
  // a record that arrived through pairing. A hand-edited registry can still hold anything, and
  // anything the normaliser dislikes it rewrites to the literal id `default` — which is this
  // board's own shared board. Refused rather than rewritten, for that reason exactly.
  return normalizeWorkspaceId(id) === id ? id : null;
}

export function createPeerStrip(deps: PeerStripDeps = {}): PeerStripDesk {
  const list = deps.list ?? ((peer, given) => listPeerWorkspaces(peer, given));
  const now = deps.now ?? Date.now;
  const seen = deps.seen;

  // One desk for the whole strip rather than one per peer per round: it is where the freshness of
  // an answer and the one-probe-per-peer rule live, and both are properties of a thing that lasts.
  const liveness = createPeerLiveness();

  const rounds = new Map<string, PeerWorkspaces>();
  const inFlight = new Map<string, Promise<void>>();
  const lastSeen = new Map<string, number>();

  /** What a round says now, which is not always what it said when it was taken. */
  function markOf(peer: StripPeer): PeerLivenessMark {
    const round = rounds.get(peer.id);
    if (!round) {
      return {
        state: 'checking',
        reason: `This board has not asked ${peer.name || UNNAMED_PEER} anything yet.`
      };
    }
    if (now() - round.liveness.at > PEER_ANSWER_FRESHNESS_MS) {
      return {
        state: 'checking',
        reason: `The last answer from ${peer.name || UNNAMED_PEER} is older than `
          + `${Math.round(PEER_ANSWER_FRESHNESS_MS / 1000)} seconds, so it is being asked again.`
      };
    }
    return { state: round.liveness.state, reason: round.liveness.reason };
  }

  /** Everything a row carries that is the same whichever kind of row it is. */
  function row(fields: {
    id: string;
    name: string;
    path: string;
    error: string | null;
    status: PeerLivenessMark;
  }): PeerStripEntry {
    return {
      id: fields.id,
      name: fields.name,
      path: fields.path,
      innerPath: '',
      environment: { kind: 'native' },
      docsDir: null,
      repo: null,
      githubProject: null,
      projectField: null,
      projectCardLimit: null,
      error: fields.error,
      status: fields.status
    };
  }

  function askOne(peer: StripPeer): Promise<void> {
    const running = inFlight.get(peer.id);
    if (running) return running;
    const attempt = list(peer, { liveness, now })
      .then((answer) => {
        rounds.set(peer.id, answer);
        for (const refusal of answer.refusals) {
          complain(`A project on the peer board "${peer.name}" is not on this strip: ${refusal}`);
        }
        if (answer.liveness.state === 'online' && seen) {
          const last = lastSeen.get(peer.id) ?? 0;
          if (now() - last >= PEER_SEEN_INTERVAL_MS) {
            lastSeen.set(peer.id, now());
            seen(peer.id);
          }
        }
      }, (error: Error) => {
        // `listPeerWorkspaces` answers with a value rather than throwing, so this is a bug in it
        // or a failure below Node's HTTP client. Recorded as a state all the same: a round that
        // threw would otherwise leave the previous answer standing for ever.
        rounds.set(peer.id, {
          peerId: peer.id,
          peerName: peer.name,
          baseUrl: peer.baseUrl,
          liveness: {
            state: 'unreachable',
            reason: `${peer.name || UNNAMED_PEER} could not be asked: ${error.message}.`,
            at: now()
          },
          workspaces: [],
          refusals: []
        });
      })
      .finally(() => { inFlight.delete(peer.id); });
    inFlight.set(peer.id, attempt);
    return attempt;
  }

  return {
    entries(peers: StripPeer[]): PeerStripEntry[] {
      const rows: PeerStripEntry[] = [];
      for (const peer of peers) {
        const status = markOf(peer);
        const round = rounds.get(peer.id);

        if (!round || round.workspaces.length === 0) {
          // The peer itself, labelled and carrying the reason. This is what is left when a
          // machine sleeps, and it is deliberately not an absence: a strip that simply lost four
          // tabs says nothing about why.
          const rowId = peerRowId(peer.id);
          if (!rowId) {
            complain(`Ignoring the peer board "${peer.id}": its id cannot name a tab on this `
              + 'board. Forget it and pair with that machine again.');
            continue;
          }
          rows.push(row({
            id: rowId,
            name: peer.name || UNNAMED_PEER,
            path: peer.baseUrl,
            error: null,
            status
          }));
          continue;
        }

        for (const tab of round.workspaces) {
          rows.push(row({
            id: tab.id,
            name: tab.name,
            path: tab.location,
            error: tab.error,
            status
          }));
        }
      }
      return rows;
    },

    mark(peer: StripPeer): PeerLivenessMark {
      return markOf(peer);
    },

    async refresh(peers: StripPeer[]): Promise<void> {
      await Promise.all(peers.map((peer) => askOne(peer)));
    },

    forget(peer: StripPeer): void {
      rounds.delete(peer.id);
      lastSeen.delete(peer.id);
      // The liveness desk is keyed by the address rather than by the peer, because that is what
      // it was asked about — a second peer at the same address is the same machine to it.
      liveness.forget(peer.baseUrl);
    }
  };
}
