/**
 * The forwarding seam: a request naming a peer's board leaves this machine and comes back.
 *
 * Everything this milestone built up to is already written and none of it had a caller.
 * `core/remote-workspace-id.ts` names another machine's project here, `core/peer-registry.ts`
 * says how to reach that machine, `core/peer-request-rewrite.ts` decides what the outgoing
 * request says, `core/peer-client.ts` performs it and maps every failure onto a sentence, and
 * `core/reply-ledger.ts` knows where a reply carrying only a `requestId` belongs. This is the
 * one file that puts them in a row, and it is deliberately the only thing `src/server.ts` learns:
 * an import and one `app.use`, no route, so the route count and the structure map do not move.
 *
 * **The frontend needs no line changed, and that is the result the whole design rests on.**
 * `apiUrlOn` in `frontend/src/App.tsx` is a query-string decorator returning a *relative* path;
 * twenty-six fetch sites go through it and six more in `DocsPanel` hand-spell the same
 * convention, so every board-scoped request already carries the one routing key this needs and is
 * already same-origin. `frontend/src/auth.ts` installs the token header for same-origin targets
 * only and deliberately sends nothing cross-origin — which is precisely why a page fetching a
 * peer directly would silently send no credential, and why the browser has to go on talking only
 * to its own server. A proxy is what lets it.
 *
 * **A middleware rather than a route**, and the order of its questions is the whole of its
 * safety.
 *
 * 1. **Not an API path — the page, the static mounts, `/health`.** Those describe the machine
 *    serving them and they sit outside the token gate for the reasons written at
 *    src/server.ts:542-602. Asked first so that nothing else in this file can run for them.
 * 2. **A path that belongs to this machine.** `POST /api/restart` ends this process and every
 *    agent it hosts whichever board asked; `GET /api/fs/directories` can only read the disk this
 *    process reaches; `GET /api/agent-limits` describes the serving machine; `POST /api/files`
 *    and `GET /api/files/:id` are the process-global content-addressed store. Forwarding one of
 *    those is not a wrong answer, it is an action taken on the wrong machine.
 *    {@link PATHS_THAT_STAY_HERE} names each with its reason and this consults that list rather
 *    than a second copy of it.
 * 3. **A reply half**, which is the one shape that belongs to this machine *conditionally*. The
 *    seven fetch sites in `App.tsx` that answer a message off the socket — five
 *    `POST /api/export/image/result` and two `POST /api/viewport/result` — carry a `requestId`
 *    and **no workspace**, so there is no board to route them on and answering them locally is
 *    wrong whenever the request they answer came down a link. `core/reply-ledger.ts` is the one
 *    thing that knows, and it is consulted here so that the HTTP forwarder and the socket
 *    forwarder read one answer rather than each keeping their own.
 * 4. **Which board.** Read with the compiled `workspaceIdFrom` through
 *    `remoteBoardOf`, so a request naming its board by `x-workspace-id` or by a body field routes
 *    exactly like one naming it by query — the MCP server, the CLI and about twenty checks use
 *    the header form. A local id is not this module's business and falls through untouched.
 * 5. **Which machine, and whether this board still knows it.** A peer that was forgotten is not
 *    forwarded to and not refused either: the id stops being routable and the request goes on to
 *    the local routes, which is what makes *the local store for that id is still empty* a thing
 *    that can be asked of this server at all. It is said out loud once per id, because a tab
 *    reading blank is otherwise a silence.
 *
 * **A peer that is not answering produces an answer.** Never a hang — `core/peer-client.ts` runs
 * a connect budget and a read budget and reports the two separately — and never a 500, which is
 * what an uncaught rejection in a middleware would be. The status is the liveness state's:
 * `unreachable` is a gateway timeout and `refused` is a bad gateway, both carrying the sentence
 * that module wrote for the operator. A page renders it; nobody has to read a stack trace.
 *
 * **Nothing about the credential is decided here.** Which headers cross, that this board's own
 * token crosses in neither spelling, that the peer's secret is written in exactly one place, that
 * `x-client-id` crosses byte-identical so the peer's `broadcast` does not echo a local write back
 * at its author, that a redirect is not followed — all of it lives in `core/peer-client.ts` and
 * `core/peer-request-rewrite.ts`. This file's contribution is to reach them and to add nothing.
 *
 * **What comes back is named too.** The peer's status and its bytes are handed on unread, and of
 * its headers only {@link PEER_RESPONSE_HEADERS_THAT_CROSS} — the two that say what the bytes
 * are. Built by naming, for the reason the outgoing set is: a header the peer starts sending next
 * year stops here until somebody decides otherwise, and a `set-cookie` or an `authorization`
 * echoed into this board's own page is a credential arriving from a machine the reader never
 * authenticated to.
 */

import {
  callPeer,
  type PeerCall,
  type PeerCallResult,
  type PeerCallTarget
} from './peer-client.js';
import {
  PATHS_THAT_STAY_HERE,
  pathStaysHere,
  remoteBoardOf,
  rewriteRequestForPeer,
  type InboundRequest as RewriteInput
} from './peer-request-rewrite.js';
import { getPeer } from './peer-registry.js';
import { createReplyLedger, type ReplyLedger } from './reply-ledger.js';
import logger from '../utils/logger.js';

/**
 * The two paths a reply half arrives on, folded the way the router reads them.
 *
 * Named one at a time rather than matched by a shape, for {@link PATHS_THAT_STAY_HERE}'s own
 * reason: a pattern is a thing a route added next year silently joins. They are also *on* that
 * list, and {@link replyHalfOf} reaches them through it rather than beside it — so a path that
 * stopped being one of this machine's own would stop being recognised here too, loudly, instead
 * of quietly becoming a request routed by a workspace key it does not carry.
 */
export const REPLY_HALF_PATHS: readonly string[] = [
  '/api/export/image/result',
  '/api/viewport/result'
];

/**
 * The response headers that come back to the caller, and the whole list.
 *
 * Two, and both of them describe the bytes rather than the machine: what they are and, for a
 * download, what to call them. Everything else — a `set-cookie` from the peer's own session, an
 * `authorization` challenge, the `date` and `server` of a machine the reader is not looking at —
 * belongs to that board and stops here.
 */
export const PEER_RESPONSE_HEADERS_THAT_CROSS: readonly string[] = [
  'content-type',
  'content-disposition'
];

/**
 * Which HTTP status each way a peer can fail comes back as.
 *
 * Keyed by `core/peer-liveness.ts`'s vocabulary rather than by `core/peer-client.ts`'s ten
 * outcomes, because the caller is a page and the two questions a page can act on are *that
 * machine is not there* and *that machine would not serve this*. Neither is a 500: a 500 says
 * this board broke, and this board did exactly what it was asked.
 */
export const PEER_FAILURE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  unreachable: 504,
  refused: 502,
  checking: 502,
  online: 502
});

/**
 * As much of a request as this module reads.
 *
 * Structural rather than `express.Request`, so that this file goes on being the kind of module
 * every other one in `core/` is: no framework, and drivable from a check in four lines. An
 * Express request satisfies it, which is what lets `src/server.ts` hand the middleware straight
 * to `app.use`.
 */
export interface ProxyRequest {
  method: string;
  /** The path and query as they arrived, which is what the rewrite is a function of. */
  originalUrl?: string;
  url?: string;
  /** In Node's lowercase spelling, which is how they arrive. */
  headers: Record<string, string | string[] | undefined>;
  /** The parsed body, which is what `workspaceIdFrom` reads and what `express.json` leaves. */
  body?: unknown;
}

/** As much of a response as this module writes. An Express response satisfies it. */
export interface ProxyResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  end(chunk?: Buffer): unknown;
}

/** A peer this module is willing to send to: an address to reach and a credential to present. */
export interface ProxyPeer extends PeerCallTarget {
  id: string;
}

export interface PeerProxyDeps {
  /**
   * Where a reply carrying only a `requestId` belongs. Defaulted to {@link peerReplyLedger}, the
   * one every forwarder on this board consults; a check supplies its own so that it can put an
   * entry on it without a socket.
   */
  ledger?: ReplyLedger;
  /** Which machine an id names. Defaulted to the registry, which is read on every call. */
  peerFor?: (peerId: string) => ProxyPeer | null;
  /** How a peer is asked. Defaulted to `core/peer-client.ts`, which owns the credential. */
  call?: (peer: PeerCallTarget, request: PeerCall) => Promise<PeerCallResult>;
}

/**
 * The ledger both forwarders consult.
 *
 * A module-level value rather than an argument, because *one answer* is the whole point of the
 * ledger: an HTTP forwarder and a socket forwarder each holding their own would disagree about
 * where a reply goes, and both disagreements look from outside like a render that never came
 * back. Exported so the socket half can record onto the same one.
 */
export const peerReplyLedger: ReplyLedger = createReplyLedger();

/** Whether a path is one of this server's own routes rather than a file it serves. */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * The path a decision is taken on, which is not the path as it was typed.
 *
 * The same fold `gatePath` in `src/server.ts` and `foldedPath` in
 * `core/peer-request-rewrite.ts` apply, and for the same reason: Express's router is
 * case-insensitive and non-strict about a trailing slash, so `/API/restart/` and `/api/restart`
 * are one route and a decision that only knows one spelling has a second one walking past it.
 */
function foldedPath(path: string): string {
  const cut = path.search(/[?#]/);
  const pathname = (cut === -1 ? path : path.slice(0, cut)).toLowerCase();
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Which reply half a path is, taken through {@link PATHS_THAT_STAY_HERE} rather than beside it.
 *
 * Two agreements have to hold and this is where they are joined: the path is one this machine
 * would otherwise answer for itself, *and* it is one of the two that carry a `requestId` instead
 * of a board. A name that fell off either list stops matching here, which is a reply half that
 * goes back to being answered locally — the behaviour before this file existed — rather than one
 * routed by a key it does not carry.
 */
export function replyHalfOf(path: string): string | null {
  const here = pathStaysHere(path);
  if (!here) return null;
  return REPLY_HALF_PATHS.includes(here.path) ? here.path : null;
}

/** The peer id of a machine, said once, so a forgotten peer is a line rather than a silence. */
const said = new Set<string>();
function sayOnce(message: string): void {
  if (said.has(message)) return;
  said.add(message);
  logger.warn(message);
}

/** The path and query as they arrived. `originalUrl` is what survives a mount; `url` is the fallback. */
function pathOf(request: ProxyRequest): string {
  const given = request?.originalUrl ?? request?.url;
  return typeof given === 'string' ? given : '';
}

/** The parsed body, or nothing. An array is not a thing `workspaceIdFrom` reads a board out of. */
function bodyOf(request: ProxyRequest): Record<string, unknown> | undefined {
  const body = request?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

/** What the peer answered, handed on: its status, its bytes, and the two headers that name them. */
function relay(response: ProxyResponse, answered: Extract<PeerCallResult, { ok: true }>): void {
  for (const name of PEER_RESPONSE_HEADERS_THAT_CROSS) {
    const value = answered.headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === 'string' && single) response.setHeader(name, single);
  }
  response.status(answered.status);
  response.end(answered.body);
}

/** Why there is no answer from the peer, in the sentence that module wrote for the operator. */
function refuseWith(
  response: ProxyResponse,
  status: number,
  error: string,
  extra: Record<string, unknown> = {}
): void {
  response.status(status);
  response.json({ success: false, error, ...extra });
}

/**
 * The middleware, built.
 *
 * `deps` is a defaulted argument nothing in `src/` passes — the convention `createPeerLiveness`,
 * `listPeerWorkspaces` and `listRoots` established, and for the same reason: a board that could
 * be *told* which machine a board is on, or what that machine said, is a board that can be lied
 * to about a peer.
 */
export function createPeerProxy(deps: PeerProxyDeps = {}) {
  const ledger = deps.ledger ?? peerReplyLedger;
  const peerFor = deps.peerFor ?? ((peerId: string) => getPeer(peerId));
  const call = deps.call ?? callPeer;

  /** Ask the peer and write whatever comes back, without ever throwing at the caller. */
  async function forward(
    response: ProxyResponse,
    peer: ProxyPeer,
    request: PeerCall,
    what: string
  ): Promise<void> {
    let answer: PeerCallResult;
    try {
      answer = await call({ baseUrl: peer.baseUrl, secret: peer.secret }, request);
    } catch (error) {
      // Nothing in `core/peer-client.ts` rejects, and this is here because a middleware that
      // does is a 500 with a stack trace in it rather than a sentence — the one failure shape
      // this whole file exists to keep off a reader's screen.
      refuseWith(response, PEER_FAILURE_STATUS.refused!,
        `${what} could not be sent to the board this project lives on: ${(error as Error).message}`,
        { peerId: peer.id, liveness: 'unreachable' });
      return;
    }

    if (!answer.ok) {
      refuseWith(response, PEER_FAILURE_STATUS[answer.liveness] ?? PEER_FAILURE_STATUS.refused!,
        answer.reason, { peerId: peer.id, liveness: answer.liveness });
      return;
    }
    relay(response, answer);
  }

  return function peerProxyMiddleware(
    request: ProxyRequest,
    response: ProxyResponse,
    next: () => void
  ): void {
    const path = pathOf(request);
    const folded = foldedPath(path);

    // The page, the static mounts and `/health`. Asked first, so nothing below can run for them.
    if (!isApiPath(folded)) return next();

    const replyHalf = replyHalfOf(path);
    if (replyHalf) {
      const body = bodyOf(request);
      const route = ledger.resolve(body?.requestId);
      // Nobody here asked for it through a link, so it is this machine's own reply — which is
      // what it has always been and what the local route below answers.
      if (route.kind === 'unknown') return next();
      if (route.kind === 'expired') {
        // The same answer the local route gives an id nothing is waiting on: the poster did
        // nothing wrong and there is nothing for it to do again. The reason is carried so that
        // a reader who goes looking is not left with a silent success.
        response.status(200);
        response.json({ success: true, delivered: false, reason: route.reason });
        return;
      }
      const peer = peerFor(route.peerId);
      if (!peer) {
        refuseWith(response, PEER_FAILURE_STATUS.refused!,
          `The board that asked for ${route.type} ${JSON.stringify(String(body?.requestId))} is `
          + `peer ${JSON.stringify(route.peerId)}, which this board no longer knows, so the `
          + 'answer has nowhere to go. Nothing was sent.', { peerId: route.peerId });
        return;
      }
      // Deliberately not through `rewriteRequestForPeer`: it refuses these paths by name, and it
      // is right to — there is no workspace key on them to translate, and the board they belong
      // to is the ledger's answer rather than anything on the request. What the rewrite would
      // have contributed is the credential discipline, and that lives in `callPeer` itself.
      void forward(response, peer, {
        method: request.method,
        path,
        headers: request.headers,
        ...(body ? { body: Buffer.from(JSON.stringify(body), 'utf8') } : {})
      }, `The answer to ${route.type}`);
      return;
    }

    // Everything else this machine answers for itself: the restart, the picker, the agent
    // limits, the file store, the pairing gesture and the device list.
    if (pathStaysHere(path)) return next();

    const inbound: RewriteInput = {
      method: request.method,
      path,
      headers: request.headers,
      ...(bodyOf(request) ? { body: bodyOf(request) } : {})
    };

    const pair = remoteBoardOf(inbound);
    if (!pair) return next();

    const peer = peerFor(pair.peerId);
    if (!peer) {
      // Not a refusal. An id this board cannot route is an id this board has no peer for, and
      // the local routes answer it exactly as they did before this file existed — which is also
      // what makes *and the local store for that id is still empty* a question this server can
      // be asked. Said once, because a tab drawing blank is otherwise a silence.
      sayOnce(`A request named the project ${JSON.stringify(pair.workspaceId)} on peer `
        + `${JSON.stringify(pair.peerId)}, and this board holds no such peer, so it was answered `
        + 'from this machine. Pair with that board again, or forget the tab.');
      return next();
    }

    const rewritten = rewriteRequestForPeer(inbound, { peerId: peer.id, secret: peer.secret });
    if (!rewritten.ok) {
      // Everything the rewrite refuses for a reason of its own has already been asked above, so
      // what is left here is a path that resolves to another machine or a request its own
      // guarantee could not answer for. Its sentence is written for a person and is handed on.
      refuseWith(response, 400, rewritten.refusal, { peerId: peer.id });
      return;
    }

    logger.info(`Forwarding ${request.method} ${folded} to peer ${peer.id} `
      + `as board ${rewritten.workspaceId}`);
    void forward(response, peer, rewritten.request, `${request.method} ${folded}`);
  };
}

/**
 * The one this board runs.
 *
 * Built here rather than at the `app.use` in `src/server.ts`, so that the whole of what that file
 * learns about federation is a name.
 */
export const peerProxy = createPeerProxy();
