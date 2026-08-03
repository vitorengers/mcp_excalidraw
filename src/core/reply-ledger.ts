/**
 * Which machine a reply belongs to, when the reply says only which request it answers.
 *
 * Seven fetch sites in `frontend/src/App.tsx` are the **answer half** of a message that arrived
 * over the socket — five `POST /api/export/image/result` and two `POST /api/viewport/result` — and
 * every one of them carries a `requestId` and **no workspace**. On one machine that has always
 * been fine: the server that asked is the server that is answered, and `pendingExports` /
 * `pendingViewports` in `src/server.ts` are keyed by exactly that id.
 *
 * Once a socket is forwarded it stops being fine. The request came down a link from a peer, the
 * reply lands on the *local* server, and the local server holds no pending record for that id. A
 * forwarder routing on `?workspace=` has nothing to route it on either, because the parameter is
 * not there — the board that asked lives on the other machine. A render or a camera move driven
 * against a remote board then hangs until its own timeout, thirty seconds for an export and ten
 * for a viewport, and nothing anywhere reports why.
 *
 * **A ledger, and nothing else.** It is deliberately separate from every transport, so that the
 * HTTP forwarder and the socket forwarder consult one answer rather than each keeping their own
 * and disagreeing about where a reply goes. It opens no socket, reads no file and reads no
 * `process.env`; the clock is a defaulted argument nothing in `src/` passes, the convention
 * `wslUnsupportedHere` and `listRoots` set — a ledger that can be told what time it is can be told
 * that an entry which expired is still live, and the whole point of the expiry is that nobody gets
 * to say that.
 *
 * **Keyed by the request id, because that is the only thing the reply carries.** Anything else is
 * a key two in-flight requests can share: a table keyed by the peer link loses the first of two
 * boards rendering on one machine, and one keyed by the workspace loses the first of two requests
 * for one board. Both failures look the same from outside — one reply delivered twice and the
 * other never — and both are invisible to anything that exercises a single board.
 *
 * **Resolving consumes.** A reply is answered once. A second post carrying the same id is a
 * duplicate or a replay, and either way it is not something to route again.
 *
 * **An entry expires no later than the request it describes**, on that request's own budget and
 * not on one budget for all three. Later is a ledger that grows without bound on a peer that goes
 * away mid-render; sooner turns a slow answer into a wrong one. So the numbers are the requester's
 * own — {@link REPLY_BUDGET_MS} — and `scripts/check-reply-ledger.mjs` reads them out of
 * `src/server.ts` rather than keeping a second copy that would go on passing after they moved.
 *
 * **Expired and unknown are different answers**, because they are different things for a caller to
 * report: one is a peer that answered too late, which names a machine and a budget, and the other
 * is a reply nobody here asked for, which names nothing and is either this board's own or a frame
 * that should not have arrived.
 */

/**
 * The three message types that may create an entry, and there is no fourth.
 *
 * Each is a request this board dispatches down a socket and then waits for an answer to. An
 * open-ended ledger keyed by whatever id happens to be in a frame is a memory leak with a routing
 * table attached, so a type that is not one of these is refused rather than recorded.
 *
 * `mermaid_convert` carries no `requestId` today — `POST /api/elements/from-mermaid` broadcasts
 * and answers its caller immediately — so nothing creates an entry for one yet. It is named here
 * because it is the third message the transport sends *asking for something back*, and the day it
 * grows an id is the day it needs a way home; a type admitted by this list is a decision, and the
 * list is short enough to be read.
 */
export type ForwardedRequestType = 'export_image_request' | 'set_viewport' | 'mermaid_convert';

/**
 * How long an entry may live, per request type: **the requester's own timeout, and not a number
 * invented here**.
 *
 * `export_image_request` is the 30 s `src/server.ts` rejects an export after, and `set_viewport`
 * the 10 s it rejects a viewport change after. `mermaid_convert` has no such budget because
 * nothing waits on it, and it takes the **shorter** of the two rather than the longer: a request
 * with no requester cannot be answered late-but-usefully, so there is nothing to buy by keeping
 * its entry the longest of the three.
 */
export const REPLY_BUDGET_MS: Readonly<Record<ForwardedRequestType, number>> = Object.freeze({
  export_image_request: 30_000,
  set_viewport: 10_000,
  mermaid_convert: 10_000
});

/** The same three names as a list, so a caller can say what it admits without restating them. */
export const FORWARDED_REQUEST_TYPES: readonly ForwardedRequestType[] =
  Object.freeze(Object.keys(REPLY_BUDGET_MS) as ForwardedRequestType[]);

/** A request this board dispatched on behalf of a peer, on its way across an inbound link. */
export interface InboundRequest {
  /** The id the reply will carry, and the only thing it will carry. */
  requestId: string;
  /** The peer it came from, as this board's peer registry names it. */
  peerId: string;
  type: ForwardedRequestType;
}

/**
 * What actually arrives: a frame off a socket, in which none of the three is known to be anything.
 *
 * An {@link InboundRequest} satisfies it, so a caller that has already checked its frame loses
 * nothing; a caller that has not cannot skip the check by declaring a type.
 */
export type InboundRequestFrame = { [K in keyof InboundRequest]?: unknown };

/**
 * Whether the entry was created, and if not, why in a sentence.
 *
 * A union rather than a throw: this is called from inside a frame handler, and a forwarder that
 * has to wrap every dispatch in a `try` to stay alive is a forwarder that will one day catch the
 * wrong thing. There is nothing to reach for on the refusing branch.
 */
export type ReplyRecording =
  | { ok: true; expiresAt: number }
  | { ok: false; refusal: string };

/**
 * Where a reply goes, or why it goes nowhere.
 *
 * `unknown` and `expired` are separate answers on purpose. A caller reports them differently and
 * repairs them differently: an expired entry names a peer that stopped waiting, and an unknown id
 * names nothing at all — it is this machine's own reply, or a frame that should not have arrived.
 */
export type ReplyRoute =
  | { kind: 'peer'; peerId: string; type: ForwardedRequestType; recordedAt: number; expiresAt: number }
  | { kind: 'expired'; peerId: string; type: ForwardedRequestType; expiredAt: number; reason: string }
  | { kind: 'unknown'; reason: string };

export interface ReplyLedgerDeps {
  /** Defaulted, and nothing in `src/` passes it. See the note at the top of this file. */
  now?: () => number;
}

interface Entry {
  peerId: string;
  type: ForwardedRequestType;
  recordedAt: number;
  expiresAt: number;
}

/**
 * The one answer both forwarders consult.
 *
 * It holds entries and nothing else: no timer, no socket, and no opinion about how a caller
 * dispatches or how it replies.
 */
export interface ReplyLedger {
  /** Remember which peer `requestId` came from. Refused for anything that is not one of the three. */
  record(request: InboundRequestFrame | null | undefined): ReplyRecording;
  /** Where the reply carrying `requestId` goes — and having asked, that id is spent. */
  resolve(requestId: unknown): ReplyRoute;
  /**
   * How many requests are still live, expired ones already dropped.
   *
   * The observable that says this ledger is bounded, and what a caller logs when it wants to know
   * how much is in flight.
   */
  size(): number;
}

function refuse(refusal: string): { ok: false; refusal: string } {
  return { ok: false, refusal };
}

function isForwardedType(type: unknown): type is ForwardedRequestType {
  return typeof type === 'string'
    && (FORWARDED_REQUEST_TYPES as readonly string[]).includes(type);
}

export function createReplyLedger(deps: ReplyLedgerDeps = {}): ReplyLedger {
  const now = deps.now ?? Date.now;

  /** Keyed by the request id, which is the only thing the reply will carry. */
  const entries = new Map<string, Entry>();

  /**
   * Drop everything past its budget.
   *
   * Called before every read and every write rather than on a timer, so that a ledger nobody is
   * calling holds no timer either — and so that the bound holds on a peer that disappears
   * mid-render, where the entries that have to go are exactly the ones nothing will ever ask
   * about again.
   */
  function sweep(at: number): void {
    for (const [requestId, entry] of entries) {
      if (at >= entry.expiresAt) entries.delete(requestId);
    }
  }

  return {
    record(request): ReplyRecording {
      const at = now();
      sweep(at);

      if (!request || typeof request !== 'object') {
        return refuse('A request to remember is an object carrying a request id, the peer it came '
          + `from and its type; this one is ${JSON.stringify(request ?? null)}.`);
      }
      const { requestId, peerId, type } = request;
      if (typeof requestId !== 'string' || requestId === '') {
        return refuse(`${JSON.stringify(requestId ?? null)} is not a request id. A request with no `
          + 'id has no reply to route: nothing would ever match it, and the entry would sit here '
          + 'until its budget ran out.');
      }
      if (typeof peerId !== 'string' || peerId === '') {
        return refuse(`Request ${JSON.stringify(requestId)} names no peer `
          + `(${JSON.stringify(peerId ?? null)}), so there is no machine to send its reply home `
          + 'to. A request that did not cross a link is answered by the board that holds it.');
      }
      if (!isForwardedType(type)) {
        return refuse(`${JSON.stringify(type ?? null)} is not a request this board waits for an `
          + `answer to. Only ${FORWARDED_REQUEST_TYPES.join(', ')} create an entry: a ledger `
          + 'keyed by whatever id happens to be in a frame is a memory leak with a routing table '
          + 'attached.');
      }

      const held = entries.get(requestId);
      if (held) {
        return refuse(`Request id ${JSON.stringify(requestId)} is already on this ledger, against `
          + `peer ${JSON.stringify(held.peerId)}. It is not re-pointed at `
          + `${JSON.stringify(peerId)}: a live id belongs to the request that is waiting on it, `
          + 'and re-pointing one sends that answer to a machine that never asked.');
      }

      const expiresAt = at + REPLY_BUDGET_MS[type];
      entries.set(requestId, { peerId, type, recordedAt: at, expiresAt });
      return { ok: true, expiresAt };
    },

    resolve(requestId): ReplyRoute {
      const at = now();

      if (typeof requestId !== 'string' || requestId === '') {
        return {
          kind: 'unknown',
          reason: `A reply carrying ${JSON.stringify(requestId ?? null)} names no request, so `
            + 'there is nothing to look up.'
        };
      }

      const entry = entries.get(requestId);
      if (!entry) {
        sweep(at);
        return {
          kind: 'unknown',
          reason: `No peer asked for ${JSON.stringify(requestId)} through this board. It is a `
            + 'reply to a request of this machine\'s own, a duplicate of one already answered, or '
            + 'a frame that should not have arrived.'
        };
      }

      // Resolving consumes it either way: an entry that has been reported as expired has been
      // reported, and a second post carrying the same id is a duplicate rather than a second
      // chance to route it.
      entries.delete(requestId);
      sweep(at);

      if (at >= entry.expiresAt) {
        return {
          kind: 'expired',
          peerId: entry.peerId,
          type: entry.type,
          expiredAt: entry.expiresAt,
          reason: `Peer ${JSON.stringify(entry.peerId)} sent ${entry.type} `
            + `${JSON.stringify(requestId)}, and the answer arrived `
            + `${at - entry.expiresAt} ms after that request's own `
            + `${REPLY_BUDGET_MS[entry.type]} ms budget ran out. Nothing on that machine is `
            + 'waiting for it any more.'
        };
      }

      return {
        kind: 'peer',
        peerId: entry.peerId,
        type: entry.type,
        recordedAt: entry.recordedAt,
        expiresAt: entry.expiresAt
      };
    },

    size(): number {
      sweep(now());
      return entries.size;
    }
  };
}
