/**
 * The tab strip when two machines answer for it.
 *
 * `core/peer-client.ts` performs one call to one peer and `core/remote-workspace-view.ts` decides
 * which fields of a project may be known here at all. This is what holds the answers between
 * calls: one round per peer, kept, so that `GET /api/workspaces` reads a snapshot instead of
 * waiting on a machine.
 *
 * **The probe is on a timer and never on the request**, and that is the whole shape of this
 * module. A machine that is asleep does not refuse a connection, it hangs — so a strip that asked
 * its peers when the page asked it would take the connect budget of every sleeping machine on the
 * list, every poll, on the one route the page cannot render without. Worse, a page polling the
 * strip would be what woke a peer up. So a caller gets {@link PeerStripDesk.entries}, which is
 * synchronous and answers from the last completed round, and {@link PeerStripDesk.refresh} is
 * what a timer drives. {@link PEER_STRIP_ANSWER_BUDGET_MS} is what the route promises as a
 * result, and it is a budget nothing here can spend.
 *
 * **`checking` is what a peer reads before there is a round, and after one has gone stale.** It
 * is one of `core/peer-liveness.ts`'s four answers rather than the absence of one, because a tab
 * that shows nothing while a probe is out is a tab that looks decided. A round older than
 * `PEER_ANSWER_FRESHNESS_MS` reads `checking` again rather than going on asserting a state
 * nobody has confirmed since — a laptop closes between one round and the next.
 *
 * **A machine that stops answering is not a broken project.** Its projects stop being tabs and
 * what is left is the peer itself, labelled and carrying the reason. Nothing is written into a
 * project's `error`: that field is a configuration failure and it *gates behaviour* — an
 * implement run refuses outright on a project carrying one — so a transient fact about a network
 * wearing the clothes of a permanent fact about a configuration would make runs refuse on
 * projects that have nothing to do with any laptop. The two travel side by side. See
 * `docs/federation.md`.
 *
 * **What crosses is named rather than forwarded.** Every entry below is built field by field out
 * of `projectWorkspaceForPeer`'s three, so a field a `Workspace` grows next year is absent from
 * this strip until somebody decides otherwise, and no absolute path, path inside a distro or
 * distro name can reach it. What replaces the path in a tab's tooltip is
 * `remoteWorkspaceLocation`'s sentence: the project's own name and the name **this** operator
 * calls the machine by.
 *
 * **The caller and the clock are defaulted arguments nothing in `src/` passes** — the convention
 * `createPeerLiveness`, `wslUnsupportedHere` and `listRoots` established, and for the same
 * reason: a board that could be *told* who answered, or what time it is, is a board that can be
 * lied to about a peer. It reads no file and no `process.env`; the peers are handed in.
 */

import { callPeer, type PeerCallResult } from './peer-client.js';
import {
  PEER_ANSWER_FRESHNESS_MS,
  saidBy,
  type PeerLivenessState
} from './peer-liveness.js';
import { normalizeWorkspaceId } from './element-store.js';
import {
  mintRemoteWorkspaceId,
  REMOTE_WORKSPACE_ID_PREFIX
} from './remote-workspace-id.js';
import {
  projectWorkspaceForPeer,
  remoteWorkspaceLocation,
  type RemoteWorkspaceView
} from './remote-workspace-view.js';
import logger from '../utils/logger.js';

/**
 * How often a peer is asked, when there is one.
 *
 * Short enough that a laptop closing is on the strip while the operator still remembers closing
 * it, long enough that a machine on the other end is not being connected to constantly. The
 * round runs whether or not anybody is looking, which is the point: the first answer after a
 * start is honest rather than a guess.
 */
export const PEER_STRIP_REFRESH_MS = 5_000;

/**
 * What the strip route promises, and it is a promise this module makes keepable rather than one
 * it spends.
 *
 * `GET /api/workspaces` reads the last completed round, so the only thing between the request
 * and the answer is the local registry. It is stated as a number because a check can hold a
 * route to a number and cannot hold it to "does not wait".
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

/** What a peer row on the strip is named after when this board holds no name for the machine. */
const UNNAMED_PEER = 'another machine';

/** A board that approved this one. A `PeerRecord` is one; nothing here needs the rest of it. */
export interface StripPeer {
  id: string;
  name: string;
  baseUrl: string;
  /** The credential this board presents there. It is passed on and never read here. */
  secret: string;
}

/** Whether the machine holding a project is answering, and why, in words for the operator. */
export interface PeerLivenessMark {
  state: PeerLivenessState;
  reason: string;
}

/**
 * One row of the strip that belongs to another machine.
 *
 * The fields are `WorkspaceSummary`'s in `frontend/src/components/WorkspaceTabs.tsx`, so a tab
 * draws a peer's project with the code that draws this board's own — and they are written out
 * one at a time rather than spread from anything, which is what keeps a path off the wire by
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

/** What one round asked one peer and what it came back with. */
interface PeerRound {
  at: number;
  status: PeerLivenessMark;
  /** Empty for a peer that did not answer, which is what turns its projects back into one row. */
  projects: RemoteWorkspaceView[];
}

/** As much of `callPeer` as this module uses, so a check can supply one in four lines. */
export type PeerCaller = (
  peer: { baseUrl: string; secret: string },
  call: { path: string }
) => Promise<PeerCallResult>;

export interface PeerStripDeps {
  call?: PeerCaller;
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
  forget(peerId: string): void;
}

/** The path a peer is asked for, which is the read this strip is made of. */
const STRIP_PATH = '/api/workspaces';

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
 * would be a tab that manufactured an empty board on the first press, which is the failure this
 * whole namespace exists to make impossible. `board` rather than two digits, so it can never be
 * read as something `mintRemoteWorkspaceId` produced.
 */
function peerRowId(peerId: string): string | null {
  const id = `${REMOTE_WORKSPACE_ID_PREFIX}board.${peerId}`;
  // A peer id is minted by the machine that approved this one and is hex, so this cannot fail
  // for a record that arrived through pairing. A hand-edited registry can still hold anything,
  // and anything the normaliser dislikes it rewrites to the literal id `default` — which is this
  // board's own shared board. Refused rather than rewritten, for that reason exactly.
  return normalizeWorkspaceId(id) === id ? id : null;
}

export function createPeerStrip(deps: PeerStripDeps = {}): PeerStripDesk {
  const call: PeerCaller = deps.call ?? ((peer, request) => callPeer(peer, request));
  const now = deps.now ?? Date.now;
  const seen = deps.seen;

  const rounds = new Map<string, PeerRound>();
  const inFlight = new Map<string, Promise<void>>();
  const lastSeen = new Map<string, number>();

  /** What a round says now, which is not always what it said when it was taken. */
  function aged(round: PeerRound, peer: StripPeer): PeerLivenessMark {
    if (now() - round.at <= PEER_ANSWER_FRESHNESS_MS) return round.status;
    return {
      state: 'checking',
      reason: `The last answer from ${peer.name || UNNAMED_PEER} is older than `
        + `${Math.round(PEER_ANSWER_FRESHNESS_MS / 1000)} seconds, so it is being asked again.`
    };
  }

  function markFor(peer: StripPeer): PeerLivenessMark {
    const round = rounds.get(peer.id);
    if (!round) {
      return {
        state: 'checking',
        reason: `This board has not asked ${peer.name || UNNAMED_PEER} anything yet.`
      };
    }
    return aged(round, peer);
  }

  /** What the peer's answer to `/api/workspaces` came to, in one round. */
  function readAnswer(peer: StripPeer, result: PeerCallResult): PeerRound {
    const at = now();
    const shown = peer.name || UNNAMED_PEER;
    if (!result.ok) {
      return { at, status: { state: result.liveness, reason: result.reason }, projects: [] };
    }
    if (result.status < 200 || result.status > 299) {
      return {
        at,
        status: {
          state: 'refused',
          reason: `${shown} is running a board and it answered ${result.status} to ${STRIP_PATH}, `
            + `so this board cannot read its projects. It said: ${saidBy(result.body.toString('utf8'))}`
        },
        projects: []
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body.toString('utf8'));
    } catch {
      return {
        at,
        status: {
          state: 'refused',
          reason: `${shown} answered ${STRIP_PATH} with something that is not a list of projects, `
            + 'so nothing was read from it.'
        },
        projects: []
      };
    }

    const listed = (parsed as { workspaces?: unknown } | null)?.workspaces;
    if (!Array.isArray(listed)) {
      return {
        at,
        status: {
          state: 'refused',
          reason: `${shown} answered ${STRIP_PATH} without a list of projects in it, so nothing `
            + 'was read from it.'
        },
        projects: []
      };
    }

    // Built by naming the three fields that cross, one project at a time. Anything that is not a
    // project — a null, a string, an entry with no id — is dropped rather than carried, because
    // the alternative is a tab named `undefined` on somebody's strip.
    const projects: RemoteWorkspaceView[] = [];
    for (const entry of listed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const project = entry as Record<string, unknown>;
      if (typeof project.id !== 'string' || !project.id) continue;
      projects.push(projectWorkspaceForPeer({
        id: project.id,
        name: typeof project.name === 'string' && project.name ? project.name : project.id,
        error: typeof project.error === 'string' ? project.error : null
      }));
    }

    return {
      at,
      status: {
        state: 'online',
        reason: `${shown} is running a board and this board is allowed on it.`
      },
      projects
    };
  }

  async function askOne(peer: StripPeer): Promise<void> {
    const running = inFlight.get(peer.id);
    if (running) return running;
    const attempt = (async () => {
      let round: PeerRound;
      try {
        round = readAnswer(peer, await call(
          { baseUrl: peer.baseUrl, secret: peer.secret },
          { path: STRIP_PATH }
        ));
      } catch (error) {
        // `callPeer` answers with a value rather than throwing, so this is a bug in it or a
        // failure below Node's HTTP client. Reported as a state all the same: a round that threw
        // would otherwise leave the previous answer standing for ever.
        round = {
          at: now(),
          status: {
            state: 'unreachable',
            reason: `${peer.name || UNNAMED_PEER} could not be asked: ${(error as Error).message}.`
          },
          projects: []
        };
      }
      rounds.set(peer.id, round);
      if (round.status.state === 'online' && seen) {
        const last = lastSeen.get(peer.id) ?? 0;
        if (now() - last >= PEER_SEEN_INTERVAL_MS) {
          lastSeen.set(peer.id, now());
          seen(peer.id);
        }
      }
    })().finally(() => { inFlight.delete(peer.id); });
    inFlight.set(peer.id, attempt);
    return attempt;
  }

  return {
    entries(peers: StripPeer[]): PeerStripEntry[] {
      const rows: PeerStripEntry[] = [];
      for (const peer of peers) {
        const status = markFor(peer);
        const round = rounds.get(peer.id);
        const rowId = peerRowId(peer.id);

        if (!round || round.projects.length === 0) {
          // The peer itself, labelled and carrying the reason. This is what is left when a
          // machine sleeps, and it is deliberately not an absence: a strip that simply lost four
          // tabs says nothing about why.
          if (!rowId) {
            complain(`Ignoring the peer board "${peer.id}": its id cannot name a tab on this `
              + 'board. Forget it and pair with that machine again.');
            continue;
          }
          rows.push({
            id: rowId,
            name: peer.name || UNNAMED_PEER,
            path: peer.baseUrl,
            innerPath: '',
            environment: { kind: 'native' },
            docsDir: null,
            repo: null,
            githubProject: null,
            projectField: null,
            projectCardLimit: null,
            error: null,
            status
          });
          continue;
        }

        for (const view of round.projects) {
          const minted = mintRemoteWorkspaceId(peer.id, view.id);
          if (!minted.ok) {
            complain(`A project on the peer board "${peer.name}" is not on this strip: ${minted.refusal}`);
            continue;
          }
          rows.push({
            id: minted.id,
            name: view.name,
            path: remoteWorkspaceLocation(view, peer.name),
            innerPath: '',
            environment: { kind: 'native' },
            docsDir: null,
            repo: null,
            githubProject: null,
            projectField: null,
            projectCardLimit: null,
            error: view.error,
            status
          });
        }
      }
      return rows;
    },

    mark(peer: StripPeer): PeerLivenessMark {
      return markFor(peer);
    },

    async refresh(peers: StripPeer[]): Promise<void> {
      await Promise.all(peers.map(peer => askOne(peer)));
    },

    forget(peerId: string): void {
      rounds.delete(peerId);
      lastSeen.delete(peerId);
    }
  };
}
