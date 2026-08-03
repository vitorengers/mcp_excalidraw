/**
 * What another board is doing, in the four answers an operator can act on.
 *
 * The transport half of this was already right and is not the interesting half.
 * `core/restart-supervisor.ts` probes with a raw socket and a 250 ms budget, and that number is
 * there for exactly the case this milestone is about: **a sleeping machine does not refuse a
 * connection, it hangs**. What it has nowhere to put is the difference between the answers,
 * because connect-or-not is one bit and the states are four:
 *
 * - `checking` — this board has not been told yet, or what it was told has expired. It is a
 *   state rather than the absence of one, because a tab that shows nothing while a probe is out
 *   is a tab that looks broken.
 * - `online` — a board of ours is there **and this board is allowed on it**.
 * - `unreachable` — nothing answered. Asleep, off the network, or nothing on that port.
 * - `refused` — it answered, and it did not serve this board. The two ways that happens are not
 *   the same repair, and telling them apart is the whole reason this is a module.
 *
 * **The trap the transport cannot see.** `/health` is outside the token gate deliberately — it
 * is how `core/port.ts`, `core/spawn.ts` and the restart supervisor find out whether anything of
 * ours holds a port, and it is answered before the token file exists. But the **origin gate**
 * (`core/origin-gate.ts`) is the first middleware on the server and runs on every path, and it
 * pins `Host` to the authorities that board answers for. A probe from another machine names the
 * peer's LAN or tailnet name, which is not in that set, and meets a **403 that has nothing
 * whatever to do with credentials**. A probe that only knows connect from timeout calls that
 * board `online`; one that reads any 403 as a credential refusal sends the operator off to
 * re-pair a device that is fine while the actual repair is one entry in an allowed-hosts list on
 * the other machine. So the reasons below are two, and the peer's own sentence is carried
 * through verbatim: it names the setting, on the machine where it has to be set.
 *
 * **Two probes rather than one.** `/health` answers before any credential exists, so it
 * separates *a board of ours is up* from *this board is allowed on it* for free, and no second
 * endpoint had to be invented. It also decides when the credential may be sent at all: a name
 * that pointed at a board last week can point somewhere else today, so nothing is handed a
 * secret until it has identified itself as one of ours.
 *
 * **Pure.** The connector, the fetch and the clock are defaulted arguments **nothing in `src/`
 * passes** — the convention `wslUnsupportedHere` and `listRoots` established, and for the same
 * reason: one machine has to be able to assert what another would be told, and a board that
 * could be *told* who answered or what time it is is a board that can be lied to about a peer.
 * It reads no file and no `process.env`; both budgets are constants here rather than settings,
 * because a setting drags in the generated tables in `docs/running.md`, the generator that
 * writes them, and two rules that red any prose stating a count of the variable set. Neither
 * number is worth that.
 */

import net from 'net';

import { TOKEN_HEADER } from './board-token.js';
import { isAcceptedCanvasService } from './identity.js';

/** The four answers, and there is no fifth. `checking` is one of them on purpose. */
export type PeerLivenessState = 'checking' | 'online' | 'unreachable' | 'refused';

export interface PeerLiveness {
  state: PeerLivenessState;
  /** One sentence, phrased for the operator, that a tooltip can show verbatim. */
  reason: string;
  /** The clock reading this answer was taken at, so a caller can age it on the same clock. */
  at: number;
}

export interface PeerTarget {
  /** How this board names the peer: `http://mac.tailnet.ts.net:3737`, without a trailing slash. */
  url: string;
  /** The credential this board holds on that peer, when it has been paired with one. */
  token?: string;
}

/**
 * What opening a socket came to.
 *
 * `refused` and `timeout` are both `unreachable` and they are not the same sentence: a machine
 * that refuses is awake and has nothing on that port, and one that hangs is the case the budget
 * exists for. `error` is everything the resolver and the stack can say instead — a name that
 * goes nowhere, a network with no route — and it carries the message rather than swallowing it.
 */
export type ConnectOutcome =
  | { kind: 'open' }
  | { kind: 'refused' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

export type Connector =
  (target: { host: string; port: number; timeoutMs: number }) => Promise<ConnectOutcome>;

/**
 * As much of `fetch` as this module uses, so that a check can supply one in four lines.
 *
 * The global `fetch` satisfies it; the type is narrow so that nothing here can quietly start
 * depending on the rest of the Response surface.
 */
export type FetchLike = (url: string, init?: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<{ status: number; text: () => Promise<string> }>;

export interface PeerLivenessDeps {
  connect?: Connector;
  fetch?: FetchLike;
  now?: () => number;
}

/**
 * How long a connection may take to open. The same 250 ms `core/restart-supervisor.ts` uses,
 * and for the same reason: a machine that is asleep does not refuse, it hangs, so the budget is
 * what turns a hang into an answer.
 */
export const PEER_CONNECT_BUDGET_MS = 250;

/**
 * How long the two requests may take once the socket is open. Longer than the connect budget on
 * purpose: a board that has just woken has a scene to read back, and a probe that gave up in a
 * quarter of a second would call a machine that is answering slowly a machine that is asleep.
 */
export const PEER_REQUEST_BUDGET_MS = 2_000;

/**
 * How long an answer is worth showing. Past this a peer reads `checking` again rather than going
 * on asserting a state nobody has confirmed since — a laptop closes between one poll and the
 * next, and the wrong half of that is a tab that says `online` about a machine in a bag.
 */
export const PEER_ANSWER_FRESHNESS_MS = 15_000;

/** Open, and answered before the token file exists. It is the only thing asked without one. */
const HEALTH_PATH = '/health';

/**
 * The credentialed probe: the smallest read behind the token gate that a peer is asked for.
 *
 * Its *status* is what this module reads and not its body, so what matters is that it is gated
 * the way the rest of `/api` is. `/api/workspaces` is also the read this milestone is heading
 * for, which makes it the honest thing to ask: a peer that will not serve its projects is not a
 * peer whose projects can appear on a tab strip, whatever `/health` says.
 */
const CREDENTIAL_PATH = '/api/workspaces';

/**
 * How the origin gate's refusal is recognised, and why by its sentence.
 *
 * There is nothing on the wire that distinguishes it: it is a 403 with a JSON body, exactly like
 * a caller guard's or a device credential's. What it does carry is `core/origin-gate.ts`'s own
 * prose, which names the authority set, the rebinding it defends against and the setting to add
 * a name to. Matching on that is a coupling, and it is a coupling a check holds: the real half
 * of `scripts/check-liveness-states.mjs` stands up a board and is refused by it for real, so a
 * rewording on that side turns this red rather than turning a peer silently `online`.
 */
const ORIGIN_GATE_MARKERS = [
  'this board answers for',
  'dns rebinding',
  'allowed_hosts',
  'own page may drive it',
  'page this board served may ask'
];

/** How much of the peer's own sentence a tooltip is given. Enough to act on, short of a page. */
const QUOTE_BUDGET = 300;

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
      error.code === 'ECONNREFUSED'
        ? { kind: 'refused' }
        : { kind: 'error', message: error.message }
    ));
  });
}

interface Authority {
  /** What a socket connects to — no brackets, because `net` does not want them on an IPv6 host. */
  host: string;
  port: number;
  /** What a person reads, and what every reason below names the peer by. */
  shown: string;
}

function authorityOf(url: string): Authority | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port, shown: parsed.host };
  } catch {
    return null;
  }
}

/**
 * The peer's own words, trimmed to what a tooltip can hold and never invented.
 *
 * Exported for `core/peer-client.ts`, which reads a refusal off a real call rather than off a
 * probe and has the same sentence to quote — and, more to the point, has to reach
 * {@link refusedTheName} with the same string this passes it.
 */
export function saidBy(body: string): string {
  let said = body.trim();
  try {
    const parsed = JSON.parse(said) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) said = parsed.error.trim();
  } catch { /* not JSON; whatever it sent is still what it said */ }
  if (!said) return 'nothing at all';
  return said.length > QUOTE_BUDGET ? `${said.slice(0, QUOTE_BUDGET)}…` : said;
}

/**
 * Whether a refusal is about the name this board was reached by rather than about what it
 * carries — the one classification in this milestone worth keeping to a single owner.
 *
 * Exported rather than copied into `core/peer-client.ts`: {@link ORIGIN_GATE_MARKERS} is a
 * coupling to another module's prose, and a second list of those markers is the one that stops
 * being updated. A probe and a real call are two callers of one rule, and the check that holds
 * the rule honest — a board standing up and refusing for real — then holds it for both.
 */
export function refusedTheName(said: string): boolean {
  const lowered = said.toLowerCase();
  return ORIGIN_GATE_MARKERS.some(marker => lowered.includes(marker));
}

/** Whether a `/health` body is one of ours rather than whatever else holds that port. */
function isOurBoard(body: string): boolean {
  try {
    return isAcceptedCanvasService((JSON.parse(body) as { service?: unknown }).service);
  } catch {
    return false;
  }
}

type Answered = { ok: true; status: number; body: string };
type Silent = { ok: false; timedOut: boolean; message: string };

/**
 * A board this one is watching, and what it will say about each peer right now.
 *
 * The desk holds the last answer per URL and nothing else: no timer, no polling and no opinion
 * about how often a caller should ask. `state` is what a render reads — synchronous, always one
 * of the four — and `check` is what a poll drives.
 */
export interface PeerLivenessDesk {
  /** What to show for `url` without waiting: `checking` until there is a fresh answer. */
  state(url: string): PeerLiveness;
  /** Probe `target` and remember the answer. Two calls for one peer share one probe. */
  check(target: PeerTarget): Promise<PeerLiveness>;
  /** Forget a peer — one that has been unpaired, or removed from the strip. */
  forget(url: string): void;
}

export function createPeerLiveness(deps: PeerLivenessDeps = {}): PeerLivenessDesk {
  const connect = deps.connect ?? connectWithSocket;
  const request: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;

  const answers = new Map<string, PeerLiveness>();
  const inFlight = new Map<string, Promise<PeerLiveness>>();

  const answer = (state: PeerLivenessState, reason: string): PeerLiveness =>
    ({ state, reason, at: now() });

  async function ask(url: string, token?: string): Promise<Answered | Silent> {
    try {
      const response = await request(url, {
        headers: token ? { [TOKEN_HEADER]: token } : {},
        signal: AbortSignal.timeout(PEER_REQUEST_BUDGET_MS)
      });
      return { ok: true, status: response.status, body: await response.text() };
    } catch (error) {
      const failure = error as Error;
      return {
        ok: false,
        timedOut: failure.name === 'TimeoutError' || failure.name === 'AbortError',
        message: failure.message
      };
    }
  }

  /**
   * A refusal, told apart by what the other board said rather than by its status.
   *
   * The two reasons are two repairs. One is a name to add on the *peer*; the other is a
   * credential to mint or re-pair from here. Reporting either as the other is worse than
   * reporting neither, which is why they are separate sentences and not one with a status in it.
   */
  function refusal(shown: string, status: number, body: string): PeerLiveness {
    const said = saidBy(body);
    if (refusedTheName(said)) {
      return answer('refused',
        `${shown} is running a board, and it refused the name this board reached it by rather `
        + `than anything this board carries. It said: ${said}`);
    }
    return answer('refused',
      `${shown} is running a board, and it refused this board's credential (${status}). `
      + `It said: ${said}`);
  }

  async function probe(target: PeerTarget): Promise<PeerLiveness> {
    const authority = authorityOf(target.url);
    if (!authority) {
      return answer('unreachable',
        `${target.url} is not an address this board can open a connection to.`);
    }
    const { shown } = authority;

    const outcome = await connect({
      host: authority.host, port: authority.port, timeoutMs: PEER_CONNECT_BUDGET_MS
    });
    if (outcome.kind === 'refused') {
      return answer('unreachable',
        `Nothing is listening on ${shown}. The machine is awake enough to refuse the connection, `
        + 'so it is the board that is not there rather than the machine.');
    }
    if (outcome.kind === 'timeout') {
      return answer('unreachable',
        `${shown} did not answer a connection within ${PEER_CONNECT_BUDGET_MS} ms. A machine that `
        + 'is asleep or off the network does not refuse a connection, it hangs.');
    }
    if (outcome.kind === 'error') {
      return answer('unreachable', `${shown} could not be reached: ${outcome.message}.`);
    }

    // First probe: is a board of ours up at all. No credential — see the note on `HEALTH_PATH`.
    const health = await ask(`${target.url}${HEALTH_PATH}`);
    if (!health.ok) {
      return answer('unreachable', health.timedOut
        ? `${shown} accepted a connection and then did not answer ${HEALTH_PATH} within `
          + `${PEER_REQUEST_BUDGET_MS} ms.`
        : `${shown} accepted a connection and then could not be asked: ${health.message}.`);
    }
    if (health.status === 401 || health.status === 403) {
      // The origin gate runs in front of `/health` too, so this is where the name refusal
      // usually lands — before anything has been said about a credential at all.
      return refusal(shown, health.status, health.body);
    }
    if (health.status < 200 || health.status > 299) {
      return answer('unreachable',
        `${shown} answered ${health.status} to ${HEALTH_PATH}, so this board cannot tell that a `
        + `board of ours is there. It said: ${saidBy(health.body)}`);
    }
    if (!isOurBoard(health.body)) {
      return answer('unreachable',
        `Something answers on ${shown} and it is not a board of ours, so nothing here has been `
        + 'sent to it.');
    }

    // Second probe, and only now: a board of ours has identified itself, so the credential may
    // go to it. Everything from here is about whether this board is allowed, never about whether
    // the machine is up — that question has been answered.
    const allowed = await ask(`${target.url}${CREDENTIAL_PATH}`, target.token);
    if (!allowed.ok) {
      return answer('unreachable', allowed.timedOut
        ? `${shown} is running a board and then did not answer ${CREDENTIAL_PATH} within `
          + `${PEER_REQUEST_BUDGET_MS} ms.`
        : `${shown} is running a board and then could not be asked: ${allowed.message}.`);
    }
    if (allowed.status >= 200 && allowed.status <= 299) {
      return answer('online', `${shown} is running a board and this board is allowed on it.`);
    }
    if (allowed.status === 401 || allowed.status === 403) return refusal(shown, allowed.status, allowed.body);
    return answer('refused',
      `${shown} is running a board, and it answered ${allowed.status} to ${CREDENTIAL_PATH}, so `
      + `this board cannot read it. It said: ${saidBy(allowed.body)}`);
  }

  return {
    state(url: string): PeerLiveness {
      const known = answers.get(url);
      if (inFlight.has(url)) {
        return answer('checking', known
          ? `Asking ${url} again.`
          : `Asking ${url} whether it is there.`);
      }
      if (!known) return answer('checking', `This board has not asked ${url} anything yet.`);
      if (now() - known.at > PEER_ANSWER_FRESHNESS_MS) {
        return answer('checking',
          `The last answer from ${url} is older than ${Math.round(PEER_ANSWER_FRESHNESS_MS / 1000)} `
          + 'seconds, so it is being asked again.');
      }
      return known;
    },

    check(target: PeerTarget): Promise<PeerLiveness> {
      // One probe per peer at a time. Two tabs rendering the same peer must not open two sockets
      // to it, and the second caller wants the first one's answer rather than one of its own.
      const running = inFlight.get(target.url);
      if (running) return running;
      const attempt = probe(target).then(result => {
        answers.set(target.url, result);
        inFlight.delete(target.url);
        return result;
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
