/**
 * DRAFT — what a peer board is doing, told from one bit.
 *
 * This is the shape without the distinction: a connection either opens or it does not, and an
 * answer is either 2xx or it is not. Kept for exactly as long as it takes
 * `scripts/check-liveness-states.mjs` to say what it costs.
 */

import net from 'net';

import { isAcceptedCanvasService } from './identity.js';
import { TOKEN_HEADER } from './board-token.js';

export type PeerLivenessState = 'checking' | 'online' | 'unreachable' | 'refused';

export interface PeerLiveness {
  state: PeerLivenessState;
  reason: string;
  at: number;
}

export interface PeerTarget {
  url: string;
  token?: string;
}

export type ConnectOutcome =
  | { kind: 'open' }
  | { kind: 'refused' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

export type Connector =
  (target: { host: string; port: number; timeoutMs: number }) => Promise<ConnectOutcome>;

export type FetchLike = (url: string, init?: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<{ status: number; text: () => Promise<string> }>;

export interface PeerLivenessDeps {
  connect?: Connector;
  fetch?: FetchLike;
  now?: () => number;
}

export const PEER_CONNECT_BUDGET_MS = 250;
export const PEER_REQUEST_BUDGET_MS = 2_000;
export const PEER_ANSWER_FRESHNESS_MS = 15_000;

const HEALTH_PATH = '/health';
const CREDENTIAL_PATH = '/api/workspaces';

function connectWithSocket(
  { host, port, timeoutMs }: { host: string; port: number; timeoutMs: number }
): Promise<ConnectOutcome> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = (outcome: ConnectOutcome): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ kind: 'open' }));
    socket.once('timeout', () => finish({ kind: 'timeout' }));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(
      error.code === 'ECONNREFUSED' ? { kind: 'refused' } : { kind: 'error', message: error.message }
    ));
  });
}

interface Authority { host: string; port: number; origin: string }

function authorityOf(url: string): Authority | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    return {
      host: parsed.hostname.replace(/^\[|\]$/g, ''),
      port,
      origin: `${parsed.host}`
    };
  } catch {
    return null;
  }
}

export interface PeerLivenessDesk {
  state(url: string): PeerLiveness;
  check(target: PeerTarget): Promise<PeerLiveness>;
  forget(url: string): void;
}

export function createPeerLiveness(deps: PeerLivenessDeps = {}): PeerLivenessDesk {
  const connect = deps.connect ?? connectWithSocket;
  const request = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;

  const answers = new Map<string, PeerLiveness>();
  const inFlight = new Map<string, Promise<PeerLiveness>>();

  const checking = (reason: string): PeerLiveness => ({ state: 'checking', reason, at: now() });

  async function probe(target: PeerTarget): Promise<PeerLiveness> {
    const authority = authorityOf(target.url);
    if (!authority) {
      return { state: 'unreachable', reason: `${target.url} is not an address.`, at: now() };
    }

    const outcome = await connect({
      host: authority.host, port: authority.port, timeoutMs: PEER_CONNECT_BUDGET_MS
    });
    if (outcome.kind !== 'open') {
      const reason = outcome.kind === 'refused'
        ? `Nothing is listening on ${authority.origin}: the connection was refused.`
        : outcome.kind === 'timeout'
          ? `${authority.origin} did not answer a connection within ${PEER_CONNECT_BUDGET_MS} ms.`
          : `${authority.origin} could not be reached: ${outcome.message}.`;
      return { state: 'unreachable', reason, at: now() };
    }

    const health = await ask(`${target.url}${HEALTH_PATH}`);
    if (!health.ok) return { state: 'unreachable', reason: health.reason, at: now() };
    if (health.status < 200 || health.status > 299) {
      return {
        state: 'unreachable',
        reason: `${authority.origin} answered ${health.status}. ${health.body}`,
        at: now()
      };
    }
    if (!looksLikeOurBoard(health.body)) {
      return {
        state: 'unreachable',
        reason: `Something answers on ${authority.origin}, and it is not a board of ours.`,
        at: now()
      };
    }

    const credential = await ask(`${target.url}${CREDENTIAL_PATH}`, target.token);
    if (!credential.ok) return { state: 'unreachable', reason: credential.reason, at: now() };
    if (credential.status < 200 || credential.status > 299) {
      return {
        state: 'unreachable',
        reason: `${authority.origin} answered ${credential.status}. ${credential.body}`,
        at: now()
      };
    }
    return { state: 'online', reason: `${authority.origin} answered.`, at: now() };
  }

  async function ask(url: string, token?: string): Promise<
    { ok: true; status: number; body: string } | { ok: false; reason: string }
  > {
    try {
      const response = await request(url, {
        headers: token ? { [TOKEN_HEADER]: token } : {},
        signal: AbortSignal.timeout(PEER_REQUEST_BUDGET_MS)
      });
      return { ok: true, status: response.status, body: await response.text() };
    } catch (error) {
      const failure = error as Error;
      const timedOut = failure.name === 'TimeoutError' || failure.name === 'AbortError';
      return {
        ok: false,
        reason: timedOut
          ? `${url} did not answer within ${PEER_REQUEST_BUDGET_MS} ms.`
          : `${url} could not be asked: ${failure.message}.`
      };
    }
  }

  return {
    state(url: string): PeerLiveness {
      const answer = answers.get(url);
      if (!answer) return checking(`This board has not asked ${url} anything yet.`);
      if (now() - answer.at > PEER_ANSWER_FRESHNESS_MS) {
        return checking(`The last answer from ${url} has expired.`);
      }
      return answer;
    },
    check(target: PeerTarget): Promise<PeerLiveness> {
      const running = inFlight.get(target.url);
      if (running) return running;
      const attempt = probe(target).then(answer => {
        answers.set(target.url, answer);
        inFlight.delete(target.url);
        return answer;
      }, error => {
        inFlight.delete(target.url);
        throw error;
      });
      inFlight.set(target.url, attempt);
      return attempt;
    },
    forget(url: string): void {
      answers.delete(url);
      inFlight.delete(url);
    }
  };
}

function looksLikeOurBoard(body: string): boolean {
  try {
    return isAcceptedCanvasService((JSON.parse(body) as { service?: unknown }).service);
  } catch {
    return false;
  }
}
