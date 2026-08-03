/**
 * The asking half of the pairing gesture: this board, asking another one to let it in.
 *
 * `core/pairing.ts` is the other end — a device asks, the operator approves, and the secret is
 * handed over on one poll. That module is the machine being *reached*. This one is the machine
 * doing the reaching, and it is the half that was cut from #504 at position 2: the end that asks
 * is a **process** rather than a page, so its progress has to be reported to the operator through
 * this board's own page, same-origin, and the peer's credential never enters a browser.
 *
 * **It answers twice, and that is what makes it three routes rather than one.** The first answer
 * is the **code**, which is the whole of what the operator has to do: read it off this screen and
 * approve the request showing the same one on the other machine. The second answer is the peer
 * itself, and it exists only once the other end approved. A route that blocked until an operator
 * walked to another keyboard would be a request held open for minutes; a route that answered with
 * a peer straight away would be one that never asked anybody.
 *
 * **Unreachable is a state and not a rejection.** A machine that is asleep does not refuse a
 * connection, it hangs, and the operator registering a peer at half past eleven at night is
 * describing a machine rather than making a claim about whether it is awake. So an attempt that
 * cannot reach the other end is *recorded* with `unreachable` and a reason, and the poll keeps
 * asking until it is answered, until {@link PEER_ASK_EXPIRY_MS}, or until the operator cancels
 * it. What **is** a rejection is an address that is not an address: that is a typo, and a typo
 * recorded as a state is a row the operator has to work out how to get rid of.
 *
 * **Nothing here mints and nothing here writes.** The credential is minted by the machine being
 * reached (`core/device-registry.ts`, over there), and the record on this end is
 * `core/peer-registry.ts`'s to write. The writer is passed in rather than imported, for the
 * reason `createPairingDesk` gives about its own minter: a check has to be able to drive the
 * arithmetic below without a real registry file being written on the machine running it.
 *
 * **Nothing here logs a secret and no reason carries one.** A reason is rendered into a dialog
 * and pasted into an issue by somebody asking for help, which is the one place a plaintext
 * credential would escape the file whose permissions are its whole defence.
 */

import { randomUUID } from 'crypto';

import { saidBy } from './peer-liveness.js';
import { callPeer, type PeerCall, type PeerCallResult } from './peer-client.js';
import type { NewPeer, PeerAddResult } from './peer-registry.js';

/** How often an attempt in flight asks the other machine what became of it. */
export const PEER_ASK_POLL_MS = 1_000;

/**
 * How long an attempt goes on trying before it is given up on.
 *
 * The machine being reached expires a request of its own inside three minutes, so this only ever
 * bites the retry loop in front of one — a peer at an address nothing answers on. Generous, and
 * bounded all the same: a board quietly opening a connection to a dead address for the rest of
 * its life is not something an operator asked for by typing a URL once.
 */
export const PEER_ASK_EXPIRY_MS = 10 * 60 * 1000;

/**
 * How many attempts may be in flight at once.
 *
 * Small, for `PAIRING_MAX_PENDING`'s reason one machine along: this is a list a person reads
 * while comparing codes on two screens, and a list of eight is already longer than the gesture
 * was ever meant to be.
 */
export const PEER_ASK_MAX_PENDING = 8;

/** The two routes the other machine answers before this one holds any credential. */
const REQUEST_PATH = '/api/pair/request';
const STATUS_PATH = '/api/pair/status';

/**
 * Where an attempt has got to, in words a surface can render.
 *
 * `asking` and `waiting` are the two halves of the gesture — before the code exists and after it
 * does. `unreachable` and `refused` are `core/peer-liveness.ts`'s own words on purpose: the same
 * two things that can be wrong with a peer that is registered are what can be wrong with one that
 * is being registered, and a second vocabulary for them is a second thing to learn.
 */
export type PeerAskState = 'asking' | 'waiting' | 'unreachable' | 'refused' | 'paired';

/** One attempt, and the whole of what a surface is told about it. Never carries a secret. */
export interface PeerAsk {
  /** This board's own id for the attempt — what `DELETE /api/peers/:id` cancels it by. */
  id: string;
  /** What this operator will call that machine once it is a peer. */
  name: string;
  baseUrl: string;
  /** The code to compare on the other machine's screen. Null until that machine has answered. */
  code: string | null;
  state: PeerAskState;
  /** One sentence, phrased for the operator, that a dialog can show verbatim. */
  reason: string;
  startedAt: number;
}

/** Why nothing was started. A status and a sentence, because a route has to answer with both. */
export interface PeerAskRefused {
  ok: false;
  status: number;
  error: string;
}

export interface PeerAskStarted {
  ok: true;
  ask: PeerAsk;
}

export type PeerAskResult = PeerAskStarted | PeerAskRefused;

/** As much of `callPeer` as this module uses, so a check can supply one in four lines. */
export type PeerCaller = (
  peer: { baseUrl: string; secret: string },
  call: PeerCall
) => Promise<PeerCallResult>;

export interface PeerAskDeps {
  /** `addPeer` from `core/peer-registry.ts`, and in a check something that writes nowhere. */
  record: (peer: NewPeer) => PeerAddResult;
  /** Where this board already holds a credential, so one machine is not registered twice. */
  known: () => { baseUrl: string }[];
  call?: PeerCaller;
  now?: () => number;
}

export interface PeerAskDesk {
  /** Start the gesture, and come back with the code or with a reason there is none. */
  ask(input: { name: string; baseUrl: string; as: string }): Promise<PeerAskResult>;
  /** Every attempt in flight, oldest first. */
  pending(): PeerAsk[];
  /** Give up on one. False when there is no such attempt, which is not an error. */
  cancel(id: string): boolean;
  /** One round over every attempt. What a timer drives. */
  poll(): Promise<void>;
}

/**
 * The address a peer answers on, reduced to the three things that are an address, or null.
 *
 * The same rules `core/peer-registry.ts` applies to what it stores, asked here so that a typo is
 * refused while the operator is still looking at the dialog they typed it into rather than
 * becoming a row that never works. The parse is the WHATWG one, so it agrees with what `fetch`
 * would make of the same string — which is what closes `http://good.example\@evil.example/`,
 * where a backslash reads as a separator and the authority is not the one the text names.
 */
function readBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const given = value.trim();
  if (!given) return null;
  let parsed: URL;
  try {
    parsed = new URL(given);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.port === '0') return null;
  return parsed.origin;
}

/** As much of `GET /api/pair/status`'s answer as this end reads, taken as it arrives. */
interface PairingStatusSaid {
  state?: unknown;
  credential?: unknown;
  deviceId?: unknown;
}

interface Attempt {
  ask: PeerAsk;
  /** The other machine's own id for the request, once it has answered with one. */
  requestId: string | null;
  /**
   * What this board proposes to be called on the *other* operator's screen.
   *
   * The two names in this gesture are different things and conflating them is how the other
   * operator ends up approving a request labelled with their own machine's nickname:
   * {@link PeerAsk.name} is what **this** operator calls that machine, and this is what **that**
   * operator will see asking. It is kept on the attempt because a retry has to propose the same
   * one, and it is not on `PeerAsk` because no surface here has anything to do with it.
   */
  as: string;
}

const shownOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

export function createPeerAskDesk(deps: PeerAskDeps): PeerAskDesk {
  const call: PeerCaller = deps.call ?? ((peer, request) => callPeer(peer, request));
  const now = deps.now ?? Date.now;

  const attempts = new Map<string, Attempt>();

  /**
   * Ask the other machine to put a row on its operator's screen.
   *
   * The credential is empty because there is not one yet, and this is the only call this board
   * ever makes to a peer without one: `POST /api/pair/request` is outside that board's token gate
   * for exactly this reason, since requiring a credential to ask for one would be a circle.
   */
  async function sendRequest(entry: Attempt): Promise<void> {
    const result = await call({ baseUrl: entry.ask.baseUrl, secret: '' }, {
      method: 'POST',
      path: REQUEST_PATH,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ name: entry.as }), 'utf8')
    });

    if (!result.ok) {
      entry.ask.state = result.liveness === 'refused' ? 'refused' : 'unreachable';
      entry.ask.reason = result.reason;
      return;
    }

    const said = saidBy(result.body.toString('utf8'));
    if (result.status < 200 || result.status > 299) {
      entry.ask.state = 'refused';
      entry.ask.reason = `${shownOf(entry.ask.baseUrl)} is running a board and it would not take a `
        + `pairing request (${result.status}). It said: ${said}`;
      return;
    }

    let answered: { requestId?: unknown; code?: unknown } | null = null;
    try {
      answered = JSON.parse(result.body.toString('utf8')) as { requestId?: unknown; code?: unknown };
    } catch { /* not JSON, which the branch below reports */ }
    if (typeof answered?.requestId !== 'string' || typeof answered?.code !== 'string') {
      entry.ask.state = 'refused';
      entry.ask.reason = `${shownOf(entry.ask.baseUrl)} answered ${REQUEST_PATH} without a request `
        + `identifier and a code, so there is nothing to compare on its screen. It said: ${said}`;
      return;
    }

    entry.requestId = answered.requestId;
    entry.ask.code = answered.code;
    entry.ask.state = 'waiting';
    entry.ask.reason = `Compare ${answered.code} on ${shownOf(entry.ask.baseUrl)} and approve the request `
      + 'showing the same code there. Nothing is held here until that machine has approved it.';
  }

  /** Ask what became of a request, and write the peer down on the one poll that answers. */
  async function pollStatus(entry: Attempt): Promise<void> {
    const result = await call({ baseUrl: entry.ask.baseUrl, secret: '' }, {
      path: `${STATUS_PATH}?requestId=${encodeURIComponent(entry.requestId ?? '')}`
    });

    if (!result.ok) {
      // The request id is kept: a machine that went quiet mid-gesture is one the operator may
      // still be walking towards, and asking again is cheaper than a second row on their screen.
      entry.ask.state = result.liveness === 'refused' ? 'refused' : 'unreachable';
      entry.ask.reason = result.reason;
      return;
    }

    let status: PairingStatusSaid | null = null;
    try {
      status = JSON.parse(result.body.toString('utf8')) as PairingStatusSaid;
    } catch { /* reported below */ }

    if (status?.state === 'pending') {
      entry.ask.state = 'waiting';
      return;
    }

    if (status?.state === 'approved'
        && typeof status.credential === 'string'
        && typeof status.deviceId === 'string') {
      const written = deps.record({
        id: status.deviceId,
        name: entry.ask.name,
        baseUrl: entry.ask.baseUrl,
        secret: status.credential
      });
      if (!written.ok) {
        entry.requestId = null;
        entry.ask.state = 'refused';
        entry.ask.reason = written.error;
        return;
      }
      entry.requestId = null;
      entry.ask.state = 'paired';
      entry.ask.reason = `${shownOf(entry.ask.baseUrl)} approved this board.`;
      return;
    }

    entry.requestId = null;
    entry.ask.state = 'refused';
    entry.ask.reason = status?.state === 'refused'
      ? `The operator at ${shownOf(entry.ask.baseUrl)} refused this board. Nothing is held here.`
      : `The request this board made to ${shownOf(entry.ask.baseUrl)} is no longer waiting there. It may `
        + 'have expired, or it may have been answered on that machine already. Ask again.';
  }

  return {
    async ask({ name, baseUrl, as }): Promise<PeerAskResult> {
      const wanted = typeof name === 'string' ? name.trim() : '';
      if (!wanted) {
        return {
          ok: false,
          status: 400,
          error: 'A peer board needs a name — what you call that machine, so that a tab from it '
            + 'is recognisable beside your own. Nothing was asked of it.'
        };
      }

      const address = readBaseUrl(baseUrl);
      if (!address) {
        const given = typeof baseUrl === 'string' ? baseUrl.trim() : '';
        return {
          ok: false,
          status: 400,
          error: `"${given}" is not an address a board answers on. It has to be an http or https `
            + 'URL naming a host and, where it is not the default, a port — and nothing after '
            + 'them: a path, a query, a fragment or credentials in the address would each change '
            + 'where this board\'s requests to that machine end up. Nothing was asked of it.'
        };
      }

      if (deps.known().some(peer => peer.baseUrl === address)) {
        return {
          ok: false,
          status: 409,
          error: `This board already holds a credential for the board at ${address}. Forget that `
            + 'peer first if you mean to pair with it again. Nothing was asked of it.'
        };
      }
      for (const entry of attempts.values()) {
        if (entry.ask.baseUrl === address && entry.ask.state !== 'refused') {
          return {
            ok: false,
            status: 409,
            error: `This board is already asking ${address} to pair. Cancel that attempt first, `
              + 'or approve it on that machine. Nothing was asked of it.'
          };
        }
      }
      if (attempts.size >= PEER_ASK_MAX_PENDING) {
        return {
          ok: false,
          status: 429,
          error: 'This board is already asking as many machines as it will ask at once. Finish '
            + 'or cancel one of them first.'
        };
      }

      const entry: Attempt = {
        ask: {
          id: randomUUID(),
          name: wanted.slice(0, 80),
          baseUrl: address,
          code: null,
          state: 'asking',
          reason: `Asking ${shownOf(address)} to pair.`,
          startedAt: now()
        },
        requestId: null,
        as: (typeof as === 'string' && as.trim() ? as.trim() : 'a board on another machine').slice(0, 80)
      };
      attempts.set(entry.ask.id, entry);
      await sendRequest(entry);
      return { ok: true, ask: { ...entry.ask } };
    },

    pending(): PeerAsk[] {
      return [...attempts.values()]
        .map(entry => ({ ...entry.ask }))
        .sort((left, right) => left.startedAt - right.startedAt);
    },

    cancel(id: string): boolean {
      return attempts.delete(typeof id === 'string' ? id.trim() : '');
    },

    async poll(): Promise<void> {
      const live = [...attempts.values()];
      await Promise.all(live.map(async entry => {
        // A paired attempt has become a peer and belongs on that list rather than this one.
        if (entry.ask.state === 'paired') {
          attempts.delete(entry.ask.id);
          return;
        }
        if (entry.ask.state === 'refused') return;
        if (now() - entry.ask.startedAt > PEER_ASK_EXPIRY_MS) {
          entry.requestId = null;
          entry.ask.state = 'refused';
          entry.ask.reason = `Nothing was heard from ${shownOf(entry.ask.baseUrl)} in `
            + `${Math.round(PEER_ASK_EXPIRY_MS / 60000)} minutes, so this board stopped asking. `
            + 'Ask again when that machine is awake.';
          return;
        }
        if (entry.requestId) await pollStatus(entry);
        else await sendRequest(entry);
      }));
    }
  };
}
