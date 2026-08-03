/**
 * What one board's request says by the time it is the peer's.
 *
 * `core/peer-client.ts` performs the call; this decides what the call *says*, and it is a pure
 * function from a request that arrived here to the request that leaves. There is no `fetch` in
 * it, nothing here opens a socket, reads a file or reads `process.env`, and that is what makes
 * every decision below assertable at the fast tier and disjoint from anything in `src/server.ts`.
 * The seam that will call it is `core/peer-proxy.ts`; until that lands nothing imports this file.
 *
 * Four things have to be right, and each of them breaks a board **quietly** rather than loudly.
 *
 * **The workspace key is translated.** The local namespaced id `core/remote-workspace-id.ts`
 * minted goes out as the peer's own spelling. The peer runs `normalizeWorkspaceId` on whatever
 * arrives and it does not reject — it rewrites anything it dislikes to the literal id `default`
 * — so a wrong spelling here does not error. It lands the request on the peer's shared `default`
 * board and answers from it, and nothing logs.
 *
 * **It is read from all three places the server reads it.** `workspaceIdFrom` takes
 * `query.workspace`, then a body field, then the `x-workspace-id` header, and falls back to
 * `default` when none matches. The MCP server, the CLI and about twenty check scripts use the
 * header form. So the reader is **imported and called** rather than re-implemented, and the
 * outbound request is fed back through that same reader before it is handed out: what this
 * function claims about where a request is addressed is a fact taken from the code that will
 * read it, not an argument about the code that wrote it.
 *
 * **The board is named in exactly one place on the way out**, for the same reason the credential
 * is. All three spellings are taken off the request and the peer's own id is written into the
 * query — the spelling every page on that machine already uses, and the first one its reader
 * consults, so nothing left over anywhere could outrank it. It is also what makes the guarantee
 * above worth having: one request expressed three ways produces one outbound request, byte for
 * byte, rather than three that happen to agree about the board and differ everywhere else.
 *
 * **The credential is replaced, not appended.** This board's token comes out of both the
 * spellings `offeredToken` in `src/server.ts` reads — {@link TOKEN_HEADER} and the
 * {@link TOKEN_QUERY} parameter — and the peer's device credential goes in, once. A request
 * carrying two is a request the peer gets to choose between, and which one it chose would be
 * `offeredToken`'s ordering rather than anybody's decision.
 *
 * **`x-client-id` crosses verbatim.** `broadcast`'s third argument excludes the socket whose id
 * matches, so a client id substituted on the way through gets the reader its own writes echoed
 * back a debounce later — with the server's whole copy of an element rather than the field that
 * was written, which is the defect #190 was filed for.
 *
 * **The headers are built by naming what crosses**, and the list is `core/peer-client.ts`'s
 * {@link PEER_HEADERS_THAT_CROSS} rather than a second copy of it: a second list is the one that
 * stops being updated, and the client is the module that owns what may reach a peer.
 * {@link HOP_BY_HOP_HEADERS} is written out here all the same — not as what the outgoing set is
 * built from, but as the record of the other half of the same decision, so that a reader can see
 * the names rather than take it on trust that none of them is on the list that crosses. That
 * import is the one thing in this file that is not free-standing; it costs a module that opens
 * sockets being *loaded*, and it buys one list instead of two.
 *
 * **A request that belongs to this machine is refused here rather than rewritten.** A rewriter
 * that will rewrite anything handed to it is one bug away from forwarding `POST /api/restart`,
 * which ends this process and every agent it hosts whichever board asked. {@link
 * PATHS_THAT_STAY_HERE} names each of them with the reason beside it, and the refusal quotes
 * that reason, because *this one is not yours to forward* is a different repair from *that board
 * is not on this machine*.
 */

import { TOKEN_HEADER, TOKEN_QUERY } from './board-token.js';
import { workspaceIdFrom, WORKSPACE_QUERY_KEYS } from './element-store.js';
import { PEER_HEADERS_THAT_CROSS, type PeerCall } from './peer-client.js';
import { splitRemoteWorkspaceId, type RemoteWorkspacePair } from './remote-workspace-id.js';

/**
 * The headers that describe *this hop* rather than the message, and so cannot be forwarded.
 *
 * The eight RFC 7230 names, and `proxy-connection`, which is not in any standard and is on the
 * wire anyway. Written out here rather than assumed from memory, and it is the record of a
 * decision rather than the thing the outgoing set is built from: that set names what crosses
 * (`PEER_HEADERS_THAT_CROSS`), so a header nobody has thought of yet is absent by construction
 * and these are absent because none of them is on that list. Both halves are worth having — the
 * naming is what makes the rule hold next year, and this list is what a reader can check today.
 */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection'
];

/** One path this machine answers for itself, and why no other machine could answer it. */
export interface LocalPath {
  /** Folded the way the router reads it: lowercase, and without a trailing slash. */
  path: string;
  /** Whether everything below it belongs to this machine too. */
  children: boolean;
  /** Why it cannot be answered by another machine. Quoted verbatim in the refusal. */
  why: string;
}

/**
 * Every request shape that belongs to the machine it was asked of, and the reason for each.
 *
 * Refusing is the whole point: forwarding any of these is not a wrong answer, it is an action
 * taken on the wrong machine. They are named one at a time rather than matched by a pattern,
 * because a pattern is a thing a route added next year silently joins.
 */
export const PATHS_THAT_STAY_HERE: readonly LocalPath[] = [
  {
    path: '/health',
    children: false,
    why: 'it describes the machine serving it — its pid, its build and its port'
  },
  {
    path: '/api/restart',
    children: false,
    why: 'it ends this process and every agent it hosts, whichever board asked for it'
  },
  {
    path: '/api/fs/directories',
    children: false,
    why: 'it can only ever read the disk this process reaches, and a picker on another '
      + 'machine choosing a directory on this one names nothing that exists'
  },
  {
    path: '/api/agent-limits',
    children: false,
    why: 'it describes what the agent on the serving machine has spent and may still spend'
  },
  {
    path: '/api/files',
    children: true,
    why: 'the content-addressed store is this process\'s own and is shared by every board on '
      + 'it, so which pictures cross a link is a decision of its own rather than a forward'
  },
  {
    path: '/api/export/image/result',
    children: false,
    why: 'it is the reply half of a request, carrying a requestId and no board at all, so '
      + 'there is no workspace key to route it on and answering it here would be wrong'
  },
  {
    path: '/api/viewport/result',
    children: false,
    why: 'it is the reply half of a request, carrying a requestId and no board at all, so '
      + 'there is no workspace key to route it on and answering it here would be wrong'
  },
  {
    path: '/api/pair',
    children: true,
    why: 'pairing is how the operator of this machine approves another one, and an approval '
      + 'forwarded somewhere else is an approval nobody at this keyboard gave'
  },
  {
    path: '/api/devices',
    children: true,
    why: 'the device list is what this machine approved and holds the credentials it minted'
  }
];

/**
 * A request as this board received it, in the shape its own reader sees.
 *
 * `body` is the **parsed** body, because that is what `workspaceIdFrom` reads and what
 * `express.json` leaves behind — this server parses nothing else, so a body that reached a route
 * at all is an object. What goes on the wire is re-encoded from it, which is also what lets the
 * board name be taken out of it.
 */
export interface InboundRequest {
  /** Defaults to a read. */
  method?: string;
  /** Path and query as they arrived: `/api/elements?workspace=peer.03.mac.field-notes`. */
  path: string;
  /** In Node's lowercase spelling, which is how they arrive. */
  headers?: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
}

/**
 * The request to make instead, which is a {@link PeerCall} and is meant to be handed to
 * `callPeer` unaltered. Narrower than what that interface admits, because everything optional
 * about it has been decided by the time it is here.
 */
export interface OutboundPeerRequest extends PeerCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}

/**
 * The peer this call is aimed at. A `PeerRecord` is one; nothing here needs the rest of it, and
 * taking it structurally is what lets this module stay clear of the registry.
 */
export interface PeerRequestTarget {
  /** This board's id for that machine, as `core/peer-registry.ts` holds it. */
  peerId: string;
  /** The credential this board presents there. It is written onto the request and nowhere else. */
  secret: string;
}

/**
 * An outbound request, or a sentence saying why there is none.
 *
 * A union rather than a throw and rather than a fallback, for `core/remote-workspace-id.ts`'s
 * reason: on the refusing branch there is deliberately nothing plausible to carry on with.
 */
export type PeerRequestRewrite =
  | { ok: true; peerId: string; workspaceId: string; request: OutboundPeerRequest }
  | { ok: false; refusal: string };

/**
 * The body field `workspaceIdFrom` reads, spelled here because `element-store.ts` exports the
 * query names and deliberately not this one. The guarantee at the end of the rewrite is what
 * keeps the two honest: whatever this takes out, the real reader is asked what is left.
 */
const BODY_WORKSPACE_KEY = 'workspace';

/** The header spelling. Same file, same reason, same guarantee. */
const WORKSPACE_HEADER = 'x-workspace-id';

/** The one query spelling this board writes. The rest of the list is read, never written. */
const OUTBOUND_WORKSPACE_KEY: string = WORKSPACE_QUERY_KEYS[0]!;

/** What this function encodes, so it is what it says it wrote rather than what it was told. */
const ENCODED_CONTENT_TYPE = 'application/json';

/**
 * The path a decision is taken on, which is not the path as it was typed.
 *
 * The same fold `gatePath` in `src/server.ts` applies and for the same reason: Express's router
 * is case-insensitive and non-strict about a trailing slash, so `/API/restart/` and
 * `/api/restart` are one route, and a list that only knows one of the spellings is a list with a
 * second spelling that walks past it — #513, one layer along.
 */
function foldedPath(path: string): string {
  const cut = path.search(/[?#]/);
  const pathname = (cut === -1 ? path : path.slice(0, cut)).toLowerCase();
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Which entry of {@link PATHS_THAT_STAY_HERE} a path is, or `null`.
 *
 * A child is matched on the separator rather than on the prefix, so `/api/filestore` is not
 * something below `/api/files`.
 */
export function pathStaysHere(path: string): LocalPath | null {
  const folded = foldedPath(typeof path === 'string' ? path : '');
  for (const entry of PATHS_THAT_STAY_HERE) {
    if (folded === entry.path) return entry;
    if (entry.children && folded.startsWith(`${entry.path}/`)) return entry;
  }
  return null;
}

/** How Express hands a query string to `workspaceIdFrom`: one value, or an array of them. */
function queryRecordOf(params: URLSearchParams): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    record[key] = all.length === 1 ? all[0] : all;
  }
  return record;
}

/** The query string of a path, and the pathname in front of it. */
function partsOf(path: string): { pathname: string; params: URLSearchParams } {
  const cut = path.indexOf('?');
  return {
    pathname: cut === -1 ? path : path.slice(0, cut),
    params: new URLSearchParams(cut === -1 ? '' : path.slice(cut + 1))
  };
}

/**
 * Which peer's project a request names, or `null` for one of this machine's own.
 *
 * Read with the compiled `workspaceIdFrom`, so a request naming its board by `x-workspace-id` or
 * by a body field answers exactly like one naming it by query. Exported because the caller has
 * to know which peer it is talking to before it can hand this module that peer's credential.
 */
export function remoteBoardOf(inbound: InboundRequest): RemoteWorkspacePair | null {
  const { params } = partsOf(typeof inbound?.path === 'string' ? inbound.path : '');
  return splitRemoteWorkspaceId(workspaceIdFrom({
    query: queryRecordOf(params),
    headers: inbound?.headers as Record<string, unknown> | undefined,
    body: inbound?.body
  }));
}

/** The body with the board name taken out of it, or the body itself if it holds no name. */
function withoutBoardName(body: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== BODY_WORKSPACE_KEY) stripped[key] = value;
  }
  return stripped;
}

const refuse = (refusal: string): PeerRequestRewrite => ({ ok: false, refusal });

/**
 * What to ask the peer instead, or why nothing is being asked.
 *
 * The order of the refusals is the order of the questions: whether this is a request at all,
 * then whether it is one the serving machine answers for itself, then which board it is about
 * and whether that board is on the machine this call was aimed at. A request that survives all
 * four is rewritten, and the rewrite is checked against the peer's own reader before it is
 * returned.
 */
export function rewriteRequestForPeer(
  inbound: InboundRequest,
  peer: PeerRequestTarget
): PeerRequestRewrite {
  const path = typeof inbound?.path === 'string' ? inbound.path : '';
  // `//host/x` and `/\host/x` are ordinary-looking strings that resolve to a different
  // authority, which is how a credential reaches a machine nobody approved. `pathOn` in
  // `core/peer-client.ts` has the last word by comparing resolved origins; this refuses the two
  // spellings outright, because a rewrite that got as far as being built would have had the
  // peer's secret written onto it.
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    return refuse(`${JSON.stringify(path)} is not a path on a peer board, so nothing was `
      + 'rewritten. A request whose path resolves to some other machine is one this board would '
      + 'present a credential to without anybody having approved it.');
  }

  const here = pathStaysHere(path);
  if (here) {
    return refuse(`${foldedPath(path)} is answered by the machine it was asked of: ${here.why}. `
      + 'It is refused here rather than rewritten, because forwarding it would not be a wrong '
      + 'answer — it would be an action taken on the wrong machine.');
  }

  const pair = remoteBoardOf(inbound);
  if (!pair) {
    return refuse(`${foldedPath(path)} names one of this board's own projects rather than a `
      + 'peer\'s, so there is nothing to rewrite. A local id is not something to send anywhere.');
  }
  if (pair.peerId !== peer.peerId) {
    return refuse(`that board is on ${JSON.stringify(pair.peerId)} and this call was aimed at `
      + `${JSON.stringify(peer.peerId)}. It is refused rather than sent, because the credential `
      + 'on the request would be one machine\'s secret offered to another.');
  }

  const { pathname, params } = partsOf(path);
  // Both spellings this board's token can arrive in come off here; the header spelling is not on
  // the list that crosses, and this is the query one.
  params.delete(TOKEN_QUERY);
  // Every spelling of the board name comes off, and one goes back on at the end, so that a
  // request named three ways is one request by the time it leaves. Appended rather than left in
  // place for the same reason: a query whose parameters are in the order they arrived in is
  // three different strings for one request.
  for (const key of WORKSPACE_QUERY_KEYS) params.delete(key);
  params.append(OUTBOUND_WORKSPACE_KEY, pair.workspaceId);

  const stripped = inbound.body && typeof inbound.body === 'object' && !Array.isArray(inbound.body)
    ? withoutBoardName(inbound.body)
    : inbound.body;
  // An empty object is what `express.json` leaves on every request that had no body at all, so
  // treating it as one would put two bytes on the wire behind every read.
  const body = stripped && Object.keys(stripped).length > 0 ? stripped : undefined;

  const headers: Record<string, string> = {};
  for (const name of PEER_HEADERS_THAT_CROSS) {
    const value = inbound.headers?.[name];
    // An array is a header sent twice; the first is what every route here reads, and joining
    // them would invent a value neither half sent.
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === 'string' && single) headers[name] = single;
  }
  // Not on the list that crosses, so it is already absent — deleted by name all the same,
  // because *the board is named in exactly one place* is something this function does rather
  // than something it inherits from another module's list.
  delete headers[WORKSPACE_HEADER];
  // The content type describes the bytes this function wrote, not the ones it was handed, and a
  // request with no body has nothing for it to describe.
  if (body) headers['content-type'] = ENCODED_CONTENT_TYPE;
  else delete headers['content-type'];
  // Last and unconditional, so there is exactly one credential on the wire whatever the incoming
  // request carried: the list above admits neither spelling of this board's own token.
  headers[TOKEN_HEADER] = peer.secret;

  const request: OutboundPeerRequest = {
    method: (inbound.method ?? 'GET').toUpperCase(),
    path: `${pathname}?${params.toString()}`,
    headers,
    ...(body ? { body: Buffer.from(JSON.stringify(body), 'utf8') } : {})
  };

  // The guarantee, taken from the reader the peer really runs rather than argued from the three
  // deletions above. It cannot fail for a request that got this far, and it is here so that the
  // reason it cannot is a fact about the code: whatever `workspaceIdFrom` becomes, and whatever
  // fourth spelling it grows, this function answers for where the request it built is addressed.
  const addressed = workspaceIdFrom({
    query: queryRecordOf(new URLSearchParams(params)),
    headers,
    body
  });
  if (addressed !== pair.workspaceId) {
    return refuse(`the rewritten request reads as board ${JSON.stringify(addressed)} to the `
      + `peer's own reader rather than ${JSON.stringify(pair.workspaceId)}. Nothing was sent: a `
      + 'request addressed to a board nobody named is answered rather than refused, which is the '
      + 'failure this module exists to make impossible.');
  }

  return { ok: true, peerId: pair.peerId, workspaceId: pair.workspaceId, request };
}
