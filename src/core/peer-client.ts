/**
 * One board's HTTP call to another, and what each way it fails means.
 *
 * `core/peer-liveness.ts` asks a peer whether it is there; this performs a real call to one. It
 * takes a peer descriptor and a request, sends it, and maps every way it can fail onto one of
 * that module's four answers rather than onto a stack trace. It has no route and no caller yet:
 * the seam that will reach it is `core/peer-proxy.ts`, and until that lands nothing in `src/`
 * imports this file.
 *
 * **A failure is a value.** Nothing here throws at its caller. The caller is a route handler that
 * has to answer a browser something honest, and *the peer did not answer in time* is a different
 * sentence for the operator than *the peer refused your credential* — a rejected promise carrying
 * an `Error` would flatten the two into a 500 with a message nobody wrote for a person.
 *
 * **The header discipline is the whole of the security of this module**, and it is three rules.
 *
 * 1. **This board's token crosses in neither spelling.** `TOKEN_HEADER` and the `TOKEN_QUERY`
 *    parameter are the two doors `offeredToken` in `src/server.ts` reads, and the secret behind
 *    them is *this* server's, minted for callers on this machine. The peer's is a different one
 *    entirely, and forwarding this one is handing one board's credential to another — to a
 *    machine that, by the time it is a peer, is exactly the sort of thing that would accept it.
 * 2. **The device credential replaces it, in exactly one place.** A request carrying two would
 *    leave the peer to pick, and which one it picked would be `offeredToken`'s ordering rather
 *    than anybody's decision.
 * 3. **`x-client-id` crosses verbatim.** `broadcast`'s third argument excludes the socket whose
 *    id matches, so a client id substituted on the way through gets the reader its own writes
 *    echoed back a debounce later — with the server's whole copy of an element rather than the
 *    field that was written, which is the defect #190 was filed for.
 *
 * The first two are consequences of the third thing this does rather than rules applied on top of
 * it: the outgoing header set is built by **naming what crosses** ({@link PEER_HEADERS_THAT_CROSS})
 * rather than by removing what must not, so a header this board starts sending next year stays on
 * this machine until somebody decides otherwise. Removal is what a reader checks, and naming is
 * what makes the check hold for the headers nobody has written yet.
 *
 * **Two budgets, and neither is a setting.** A machine that is asleep does not refuse a
 * connection, it hangs — which is why `core/restart-supervisor.ts` and `core/peer-liveness.ts`
 * both open a socket under a 250 ms budget, and why {@link PEER_CALL_CONNECT_BUDGET_MS} is the
 * same number. But a real request is not a connect probe: a peer that has to read a scene back,
 * or encode an image, is answering slowly rather than sleeping, and one budget covering both
 * phases would report the two as the same thing. So the read runs under
 * {@link PEER_CALL_BUDGET_MS}, stated separately, and the two failures are two sentences. Both
 * are constants here rather than configuration variables, for the reason the liveness module
 * gives about its own: a setting drags in the generated tables in `docs/running.md`, the
 * generator that writes them, and two rules that red any prose stating a count of that set, and
 * neither number is worth that.
 *
 * **The peer is a plain argument.** This module does not import `core/peer-registry.ts` — a
 * `PeerRecord` satisfies {@link PeerCallTarget} structurally and either module could have landed
 * first. It is also what lets the check drive this with no file on disk.
 *
 * **A redirect is not followed.** A peer answering 3xx is not the board this device paired with,
 * whatever it says about where to go instead, and following it would carry the credential to a
 * machine nobody approved. It is reported as its own outcome, with the status in the sentence.
 *
 * **Nothing here logs.** The only interesting value this module holds is a peer's secret, and a
 * log line is the one place it would escape the file whose permissions are its whole defence. It
 * is in no returned reason either: a reason is rendered into a tooltip and pasted into an issue
 * by somebody asking for help.
 */

import http from 'http';
import https from 'https';

import { TOKEN_HEADER, TOKEN_QUERY } from './board-token.js';
import { refusedTheName, saidBy, type PeerLivenessState } from './peer-liveness.js';

/**
 * How long a connection to a peer may take to open. The same 250 ms
 * `core/restart-supervisor.ts` and `core/peer-liveness.ts` use, and for the same reason: a
 * machine that is asleep does not refuse a connection, it hangs, so the budget is what turns a
 * hang into an answer.
 */
export const PEER_CALL_CONNECT_BUDGET_MS = 250;

/**
 * How long the peer has to answer once the socket is open, and it is a different question.
 *
 * Longer than the connect budget by a factor nobody should have to think about, because the two
 * phases fail for different reasons: nothing has to happen on the other machine for a connection
 * to be accepted, and a great deal does before an answer exists — a scene read back, an image
 * encoded, an agent's transcript assembled. A read that gave up in a quarter of a second would
 * call a board that is working a board that is asleep, which is exactly the confusion the two
 * budgets exist to prevent.
 */
export const PEER_CALL_BUDGET_MS = 10_000;

/**
 * The headers that cross to a peer, and the whole list.
 *
 * `x-client-id` is the one that matters and the reason this is a list rather than a filter: it
 * has to arrive **byte-identical**, because the peer's `broadcast` excludes the socket whose id
 * matches and a substituted id gets the reader its own writes back. The other two are what a
 * request means: what it is sending, and what it will accept back. Everything else — this
 * board's token in either spelling, a cookie its page holds, the `Host` it was reached under —
 * belongs to this machine and stops here.
 *
 * Exported so the seam that eventually calls this can see the list rather than guess at it.
 * Adding a name is a decision made in this file.
 */
export const PEER_HEADERS_THAT_CROSS: readonly string[] = ['accept', 'content-type', 'x-client-id'];

/** A board that approved this one. A `PeerRecord` is one; nothing here needs the rest of it. */
export interface PeerCallTarget {
  /** Where that board answers: scheme, host and port, and nothing after them. */
  baseUrl: string;
  /** The credential this board presents there. Never logged, never returned, never a reason. */
  secret: string;
}

/** What to ask the peer for. `headers` is the local request's, in Node's lowercase spelling. */
export interface PeerCall {
  /** Defaults to a read. */
  method?: string;
  /** The path and query, as the peer's own routes spell them: `/api/workspaces?board=x`. */
  path: string;
  headers?: Record<string, string | string[] | undefined>;
  /** The body as bytes, already encoded. Absent for a request that has none. */
  body?: Buffer;
}

/**
 * Every way this call can come out, and each of them maps to exactly one liveness state.
 *
 * `answered` is any status the peer's own routes produced — a 404 from a board that served this
 * one is an answer, and re-labelling it a failure here would lose the peer's own reply. The
 * three refusals are the statuses that are about *this board* rather than about the request, and
 * they are three rather than one because they are three different repairs.
 */
export type PeerCallKind =
  | 'answered'
  | 'unaddressable'
  | 'connect-refused'
  | 'connect-timeout'
  | 'read-timeout'
  | 'transport'
  | 'unauthorized'
  | 'refused-name'
  | 'refused-credential'
  | 'redirected';

/**
 * Which of `core/peer-liveness.ts`'s four answers each outcome is, in one table.
 *
 * The table is here and the states are imported, so that this module has an opinion about its
 * own outcomes and none about what the four answers are. A second copy of the vocabulary is a
 * copy that drifts, and the classification that decides which *refusal* a 403 is — the origin
 * gate's own prose — is imported for the same reason rather than restated.
 */
export const PEER_CALL_LIVENESS: Record<PeerCallKind, PeerLivenessState> = {
  answered: 'online',
  unaddressable: 'unreachable',
  'connect-refused': 'unreachable',
  'connect-timeout': 'unreachable',
  'read-timeout': 'unreachable',
  transport: 'unreachable',
  unauthorized: 'refused',
  'refused-name': 'refused',
  'refused-credential': 'refused',
  redirected: 'refused'
};

/** What the peer answered, handed on without being read or re-encoded. */
export interface PeerAnswer {
  ok: true;
  kind: 'answered';
  liveness: 'online';
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** The bytes the peer wrote. A `Buffer`, so an image survives the hop. */
  body: Buffer;
}

/** Why the call did not produce one, in a sentence phrased for the operator. */
export interface PeerFailure {
  ok: false;
  kind: Exclude<PeerCallKind, 'answered'>;
  liveness: PeerLivenessState;
  /** One sentence a surface can show verbatim. Never carries either machine's secret. */
  reason: string;
  /** What the peer answered, where it answered at all. */
  status?: number;
}

export type PeerCallResult = PeerAnswer | PeerFailure;

/**
 * As much of an HTTP client as this module uses, so that a check can supply one in four lines.
 *
 * It is the seam for the one outcome no machine can be made to produce on demand: a connect
 * timeout needs a peer that is asleep or a firewall that drops rather than refuses. Everything
 * else is reachable with a real listener, and the check uses one.
 */
export type PeerTransport = (request: SentRequest) => Promise<TransportOutcome>;

export interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  connectBudgetMs: number;
  requestBudgetMs: number;
}

/**
 * What the socket came to, before anything has been made of the status.
 *
 * `connect-timeout` and `read-timeout` are separate at this level because they are separate
 * *phases*, and a transport that reported one timeout would make the distinction unrecoverable
 * above it — a board that accepted and then went quiet would be indistinguishable from a board
 * that never accepted at all.
 */
export type TransportOutcome =
  | {
      kind: 'answered';
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
    }
  | { kind: 'refused' }
  | { kind: 'connect-timeout' }
  | { kind: 'read-timeout' }
  | { kind: 'error'; message: string };

export interface PeerClientDeps {
  transport?: PeerTransport;
}

/**
 * The peer's address, reduced to the three things that are an address, or null.
 *
 * The same shape `core/peer-registry.ts` stores and for the same reason — anything after the
 * port changes where a concatenated request goes — restated here rather than imported, because
 * this module takes its peer as a plain argument and a caller that built one by hand gets the
 * same treatment as one that read it off the registry.
 */
function originOf(baseUrl: string): { origin: string; host: string; shown: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  if (parsed.search || parsed.hash) return null;
  return { origin: parsed.origin, host: parsed.host, shown: parsed.host };
}

/**
 * The path this board will ask for, with the query spelling of the local token taken out of it.
 *
 * Null for anything that is not a path on that peer. `//elsewhere.example/x` is the shape this
 * exists for: it is a perfectly ordinary-looking string that `new URL` resolves to a **different
 * authority**, so a path taken off an incoming request could send this board's peer credential to
 * a machine nobody approved — the same failure a followed redirect would be, one layer earlier.
 * The resolved origin is compared against the peer's rather than trusted to the leading
 * characters, so any other spelling that moves the authority is refused with it.
 */
function pathOn(origin: string, path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  let resolved: URL;
  try {
    resolved = new URL(path, origin);
  } catch {
    return null;
  }
  if (resolved.origin !== origin) return null;
  resolved.searchParams.delete(TOKEN_QUERY);
  return `${resolved.pathname}${resolved.search}`;
}

/**
 * The headers to send, built by naming them.
 *
 * The credential is written last and unconditionally, so there is exactly one on the wire
 * whatever the incoming request carried: the list above does not admit either spelling of a
 * token, and this is the one place a credential is put on a request to a peer.
 */
function headersFor(call: PeerCall, secret: string): Record<string, string> {
  const outgoing: Record<string, string> = {};
  const given = call.headers ?? {};
  for (const name of PEER_HEADERS_THAT_CROSS) {
    const value = given[name];
    // An array is a header sent twice; the first is what every route here reads, and joining
    // them would invent a value neither half sent.
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === 'string' && single) outgoing[name] = single;
  }
  outgoing[TOKEN_HEADER] = secret;
  return outgoing;
}

/**
 * A request over a socket of its own, with the two phases timed separately.
 *
 * `agent: false` rather than the global agent, and it is load-bearing rather than tidy: since
 * Node 19 the global agent keeps connections alive, and a reused socket is already open — so the
 * connect budget would apply to a phase that had already happened on some earlier request, and
 * the first thing this module claims to be able to tell apart would depend on what it had done a
 * minute ago.
 *
 * The connect timer is cleared by the socket's own `connect` event, which is the only thing that
 * knows the difference; for `https:` the TLS handshake falls under the read budget, which is the
 * right side of the line — a handshake is the peer doing work, not a machine failing to answer.
 */
function sendOverHttp(request: SentRequest): Promise<TransportOutcome> {
  return new Promise(resolve => {
    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      resolve({ kind: 'error', message: 'the address could not be opened' });
      return;
    }

    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let readTimer: NodeJS.Timeout | null = null;

    const outgoing = client.request(target, {
      method: request.method,
      headers: request.headers,
      agent: false
    });

    const finish = (outcome: TransportOutcome): void => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (readTimer) clearTimeout(readTimer);
      outgoing.destroy();
      resolve(outcome);
    };

    connectTimer = setTimeout(() => finish({ kind: 'connect-timeout' }), request.connectBudgetMs);

    const opened = (): void => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
      readTimer = setTimeout(() => finish({ kind: 'read-timeout' }), request.requestBudgetMs);
    };
    outgoing.once('socket', socket => {
      if (socket.connecting) socket.once('connect', opened);
      else opened();
    });

    outgoing.once('response', response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => finish({
        kind: 'answered',
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.once('error', (error: Error) => finish({ kind: 'error', message: error.message }));
    });

    outgoing.once('error', (error: NodeJS.ErrnoException) => finish(
      error.code === 'ECONNREFUSED'
        ? { kind: 'refused' }
        : { kind: 'error', message: error.message }
    ));

    if (request.body && request.body.length) outgoing.write(request.body);
    outgoing.end();
  });
}

const failed = (kind: Exclude<PeerCallKind, 'answered'>, reason: string, status?: number): PeerFailure =>
  ({ ok: false, kind, liveness: PEER_CALL_LIVENESS[kind], reason, ...(status === undefined ? {} : { status }) });

/**
 * A refusal, told apart by what the other board said rather than by its status.
 *
 * The two reasons are two repairs, and the third — a 401 — is a third. One is a name to add on
 * the *peer*, one is a credential to pair again from here, and one is a board that has never
 * heard of this credential at all. Reporting any of them as another is worse than reporting
 * none, which is why they are separate sentences rather than one with a status in it. Which of
 * the two 403s this is comes from `core/peer-liveness.ts`, because the markers it matches on are
 * the origin gate's own prose and a second copy of that list is a list that drifts.
 */
function refusal(shown: string, status: number, body: Buffer): PeerFailure {
  const said = saidBy(body.toString('utf8'));
  if (refusedTheName(said)) {
    return failed('refused-name',
      `${shown} is running a board, and it refused the name this board reached it by rather than `
      + 'anything this board carries. That is a list on that machine rather than a pairing here. '
      + `It said: ${said}`, status);
  }
  if (status === 401) {
    return failed('unauthorized',
      `${shown} is running a board, and it does not know the credential this board presented `
      + '(401). A peer credential is minted by the machine being reached, so this one is paired '
      + `again there rather than repaired here. It said: ${said}`, status);
  }
  return failed('refused-credential',
    `${shown} is running a board and it knows this board, and it would not serve this request to `
    + `the credential this board holds (${status}). It said: ${said}`, status);
}

/**
 * Ask a peer board for something, and come back with an answer or with a reason.
 *
 * `deps` is a defaulted argument nothing in `src/` passes — the convention `createPeerLiveness`,
 * `wslUnsupportedHere` and `listRoots` established, and for the same reason: a board that could
 * be *told* who answered is a board that can be lied to about a peer.
 */
export async function callPeer(
  peer: PeerCallTarget,
  call: PeerCall,
  deps: PeerClientDeps = {}
): Promise<PeerCallResult> {
  const send = deps.transport ?? sendOverHttp;

  const address = originOf(peer?.baseUrl ?? '');
  if (!address) {
    return failed('unaddressable',
      `"${peer?.baseUrl ?? ''}" is not an address a board answers on, so nothing was sent. It has `
      + 'to be an http or https URL naming a host and, where it is not the default, a port — and '
      + 'nothing after them.');
  }

  const path = pathOn(address.origin, call?.path ?? '');
  if (path === null) {
    return failed('unaddressable',
      `"${call?.path ?? ''}" is not a path on ${address.shown}, so nothing was sent. A request `
      + 'that resolves to another machine is one this board would present its credential to '
      + 'without anybody having approved it.');
  }

  const method = (call.method ?? 'GET').toUpperCase();
  const outcome = await send({
    url: `${address.origin}${path}`,
    method,
    headers: headersFor(call, peer.secret),
    ...(call.body ? { body: call.body } : {}),
    connectBudgetMs: PEER_CALL_CONNECT_BUDGET_MS,
    requestBudgetMs: PEER_CALL_BUDGET_MS
  });

  if (outcome.kind === 'refused') {
    return failed('connect-refused',
      `Nothing is listening on ${address.shown}. The machine is awake enough to refuse the `
      + 'connection, so it is the board that is not there rather than the machine.');
  }
  if (outcome.kind === 'connect-timeout') {
    return failed('connect-timeout',
      `${address.shown} did not answer a connection within ${PEER_CALL_CONNECT_BUDGET_MS} ms. A `
      + 'machine that is asleep or off the network does not refuse a connection, it hangs.');
  }
  if (outcome.kind === 'read-timeout') {
    return failed('read-timeout',
      `${address.shown} accepted a connection and then did not answer ${method} ${path} within `
      + `${PEER_CALL_BUDGET_MS} ms. It is a board that is there and is not answering, which is `
      + 'not the same as a machine that is asleep.');
  }
  if (outcome.kind === 'error') {
    return failed('transport', `${address.shown} could not be reached: ${outcome.message}.`);
  }

  if (outcome.status >= 300 && outcome.status <= 399) {
    const location = outcome.headers.location;
    const named = typeof location === 'string' && location ? location : 'nowhere in particular';
    return failed('redirected',
      `${address.shown} answered ${outcome.status} and pointed at ${named}, which was not `
      + 'followed. A board this one paired with answers for itself, and following a redirect '
      + 'would carry this board\'s credential to a machine nobody approved.', outcome.status);
  }

  if (outcome.status === 401 || outcome.status === 403) {
    return refusal(address.shown, outcome.status, outcome.body);
  }

  return {
    ok: true,
    kind: 'answered',
    liveness: 'online',
    status: outcome.status,
    headers: outcome.headers,
    body: outcome.body
  };
}
