// First, before every other module body in this file's graph: importing it folds
// `<state-dir>/config.json` and `<cwd>/.env` into `process.env`, and half the modules below
// read a variable while they are being evaluated. See `core/settings.ts`.
import './core/env.js';
import { env, settingName } from './core/settings.js';
import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer } from 'ws';
import { createServer, IncomingHttpHeaders } from 'http';
import net from 'net';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import logger from './utils/logger.js';
import {
  files,
  snapshotsFor,
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  ExcalidrawFile,
  WebSocketMessage,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
  SyncStatusMessage,
  InitialElementsMessage,
  Snapshot,
  normalizeFontFamily
} from './types.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { isMainModule } from './core/entry.js';
import { packageVersion, productName } from './core/version.js';
import { writePidFile, removePidFile, restartLogPath, startupLogPath } from './core/pidfile.js';
import {
  canvasUrlFor, explicitPort, preferredPort, removeCanvasState, writeCanvasState
} from './core/port.js';
import { spawnRestartSupervisor, type CanvasIdentity } from './core/restart-supervisor.js';
import {
  addWorkspace,
  hasWorkspaceRegistry,
  loadWorkspaces,
  registryPath,
  removeWorkspace,
  reorderWorkspaces,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  AgentBackends,
  DEFAULT_AGENT_BACKENDS,
  Workspace
} from './core/workspaces.js';
import { BoardScene, parseBoardScene } from './core/board-seed.js';
import { listDirectories } from './core/directory-browse.js';
import {
  AgentCommands, AgentHost, AgentRun, agentCommandFor, agentCommandsOf, agentGrantFor,
  agentGrantsFromEnv, runIssueAgent, runReviseAgent
} from './core/issue-agent.js';
import {
  DEFAULT_AGENT_BACKEND, type AgentAdapter, type AgentCommandSpec
} from './core/agent-adapter.js';
import { limitsReaders } from './core/agents/index.js';
import {
  KNOWN_BACKEND_NAMES, enabledAgentBackends, parseAgentBackends, type AgentGrants
} from './core/agent-backend.js';
import {
  AgentEnvironmentHealth, AgentRoleCommands, AgentsHealth, agentRoles, initialAgents,
  preflightAgents, preflightLines
} from './core/agent-preflight.js';
import { AgentUsage } from './core/agent-usage.js';
import { AgentLimitsReading, STALE_AFTER_SECONDS } from './core/agent-limits.js';
import { issueImageIds, materializeIssueImages, MaterializedImages, NO_IMAGES } from './core/issue-images.js';
import { referencedFileIds } from './core/board-files.js';
import {
  readProjectBoard,
  moveCard,
  moveIssueToColumn,
  findColumn,
  founderColumn,
  inProgressColumn,
  todoColumn,
  DEFAULT_FOUNDER_COLUMN,
  DEFAULT_TODO_COLUMN,
  NoProjectConfigured,
  ProjectUrlUnparseable,
  NotOnThisBoard
} from './core/project-board.js';
import type { FounderCard } from './core/project-board-types.js';
import { openFounderActions } from './core/founder-store.js';
import {
  GithubHealth, GithubStatus, githubHealth, githubPreflightLine, initialGithub, readGithubStatus
} from './core/github-status.js';
import {
  FounderBlocker,
  blockerForAgentPreflight,
  blockerForGhFailure,
  blockerForGithubStatus,
  blockerForPushAccess,
  founderActionFor
} from './core/founder-blockers.js';
import {
  FounderActionRecord,
  founderActionKey,
  openFounderActions,
  readFounderAction,
  recordFounderAction,
  resolveFounderAction
} from './core/founder-store.js';
import { FounderSnapshot, verifyAgainst } from './core/founder-verify.js';
import { publishFounderAction as publishFounderActionTo } from './core/founder-publish.js';
import { setTerminalGhReporter } from './core/gh.js';
import {
  lastQueuePass,
  QueuePass,
  QueuePassReason,
  dependenciesOf,
  queueEnabled,
  queuedWorkspaces,
  reasonAnnounces,
  recordQueuePass,
  setQueueEnabled,
  startableCards
} from './core/implement-queue.js';
import { TOOL_DOC_KEYS } from './core/tool-docs.js';
import { commentOnIssue, fetchIssue, isIssueUrl } from './core/github-issue.js';
import { GITHUB_HOST, issueUrlRefusal } from './core/github-host.js';
import { PushAccess, pushRefusal, readPushAccess } from './core/github-push.js';
import type { IssueDetail } from './core/github-issue.js';
import { fetchPullLanding } from './core/github-pull.js';
import { Landing, landingFor } from './core/implement-landing.js';
import { IssueMemo, memoWindow } from './core/issue-memo.js';
import {
  PtyModule,
  TERMINAL_SESSION_LIMIT,
  TerminalSession,
  TerminalSessionOptions,
  loadPty,
  shellCommandFrom
} from './core/terminal-session.js';
import { issueBlockAppearance } from './core/issue-appearance.js';
import { preserveServerAuthored } from './core/element-authorship.js';
import { UnfinishedRun, runImplementAgent } from './core/implement-agent.js';
import {
  ImplementRecord,
  ImplementUsage,
  clearImplement,
  isImplementing,
  listImplement,
  readImplement,
  runningImplementCount,
  runningImplements,
  writeImplement
} from './core/implement-state.js';
import {
  HeldWorktree,
  ImplementWorktree,
  ensureWorktree,
  originRemote,
  releaseWorktree,
  worktreesHoldingWork
} from './core/implement-worktree.js';
import { describeInterrupted, interruptedRuns } from './core/implement-recovery.js';
import {
  ReclaimedRun,
  forgetSighting,
  goneProcessReclaim,
  landedReclaim,
  reclaimDetail
} from './core/implement-reclaim.js';
import { layoutLabel, DEFAULT_BOUND_TEXT_FONT_SIZE } from './core/text-layout.js';
import {
  elementsFor,
  workspaceIdFrom,
  normalizeWorkspaceId,
  activeWorkspaceIds,
  onElementStoreChanged,
  DEFAULT_WORKSPACE_ID,
  WORKSPACE_QUERY_KEYS
} from './core/element-store.js';
import { allowedAuthorities, verifyOrigin, verifySameAuthority } from './core/origin-gate.js';
import { callerIsLocal } from './core/caller-gate.js';
import { hostname as osHostname } from 'os';

import { createPairingDesk, isLoopbackCaller } from './core/pairing.js';
import { addDevice, deviceRegistryPath } from './core/device-registry.js';
import { peerProxy } from './core/peer-proxy.js';
import {
  addPeer,
  forgetPeer,
  listPeers,
  peerRegistryPath,
  touchPeer,
  type PeerRecord
} from './core/peer-registry.js';
import { createPeerAskDesk, PEER_ASK_POLL_MS } from './core/peer-pairing-ask.js';
import {
  createPeerStrip,
  PEER_STRIP_REFRESH_MS,
  type PeerStripEntry,
  type StripPeer
} from './core/peer-strip.js';
import {
  isRemoteWorkspaceId,
  REMOTE_WORKSPACE_ID_PREFIX,
  splitRemoteWorkspaceId
} from './core/remote-workspace-id.js';
import {
  authRequired,
  consumeTokenHandover,
  newToken,
  removeAuthToken,
  removeTokenHandover,
  sameToken,
  tokenFilePath,
  writeAuthToken,
  writeTokenHandover,
  TOKEN_HEADER,
  TOKEN_QUERY
} from './core/auth-token.js';
import {
  deviceRegistryRevision,
  listDevices,
  renameDevice,
  revokeDevice,
  touchDevice,
  verifyDevice,
  type DeviceRecord
} from './core/device-registry.js';
import {
  backupBoardBefore,
  boardStateExists,
  boardStateFile,
  dropBoardState,
  flushBoardStateSaves,
  persistBoardFor,
  readBoardState,
  scheduleBoardStateSave,
  SavedBoard
} from './core/board-state.js';

// Every write to every store reaches the save half through here, rather than each of the
// dozen writers remembering to. Nothing is written until a board has been registered as worth
// saving, which only `seedBoards` does, so importing this module still saves nothing.
onElementStoreChanged(scheduleBoardStateSave);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The build this process is, for `/health` to name — read once rather than per request.
 *
 * The frontend polls that route, and this is a property of the running process that cannot
 * change under it: a canvas serving a different build is a different process, which is the whole
 * of what the field is for.
 */
const PACKAGE_VERSION = packageVersion();

const app = express();

/**
 * The router matches a path the way the gates read it, rather than more loosely.
 *
 * Both of these are off by Express's defaults, and both defaults are what made `/API/elements`
 * reach a handler the token gate had already waved through as "not an API request". `gatePath`
 * is the fix and this is the second half of it: with the router this strict there is no second
 * spelling of a route for a gate to disagree with in the first place. Kept as belt *and*
 * braces deliberately — a route added later, or a gate that grows a new literal comparison,
 * must not be able to re-open #513 on its own.
 *
 * Nothing in this product ever asked for `/API/…` or `/api/elements/`: the frontend builds its
 * paths in `apiUrl`, the CLI and the MCP server build theirs in `core/canvas-client.ts`, and
 * every check spells them the way this file declares them.
 */
app.set('case sensitive routing', true);
app.set('strict routing', true);

const server = createServer(app);

/**
 * The authorities this board answers for, built once the port is known and rebuilt when the set
 * of approved devices changes.
 *
 * Read through a function rather than captured, because `HOST` and `PORT` are resolved at the
 * bottom of this file and both gates below run long after that.
 *
 * **The memo used to be for the whole of it, and that made approval and reachability two
 * different lifetimes.** The set was built from `HOST`, `PORT` and `ALLOWED_HOSTS` on the first
 * request and never again, so a device approved a minute later reached this board under a name
 * the memo had been built without — refused at the first middleware, holding a perfect
 * credential, until somebody restarted the server. Each `DeviceRecord` carries the authority it
 * was approved *for*, which is the name the operator read off the pairing card before they
 * approved it, so those names join the set here.
 *
 * Still memoised, because this runs on every request the board serves, static files included,
 * and a registry read per request would put an open and a parse in front of every font the page
 * loads. `deviceRegistryRevision` is a `stat` and a comparison, which is what makes that safe:
 * an approval or a revocation — in this process or in another one — changes it, and the set is
 * rebuilt on the next request rather than at the next restart.
 */
let authorities: Set<string> | null = null;
let authoritiesFrom: string | null = null;

/** Every approved device's own authority, or none when the registry cannot be read. */
function approvedAuthorities(): string[] {
  try {
    return listDevices().map(device => device.host).filter(Boolean);
  } catch (error) {
    // Refusing to answer at all because a file is unreadable would take the board down over a
    // list of devices; `core/device-registry.ts` makes the same call for the same reason.
    logger.warn(`The device registry could not be read: ${(error as Error).message}`);
    return [];
  }
}

function boardAuthorities(): Set<string> {
  let revision: string;
  try {
    revision = deviceRegistryRevision();
  } catch {
    revision = 'unreadable';
  }
  if (!authorities || revision !== authoritiesFrom) {
    authorities = allowedAuthorities(HOST, PORT, env('ALLOWED_HOSTS'), approvedAuthorities());
    authoritiesFrom = revision;
  }
  return authorities;
}

/**
 * Whether this board is behind a secret at all, and what that secret is.
 *
 * Two names rather than one so that the gate below can **fail closed**: the token cannot be
 * chosen up here, because it is per start and per port and `PORT` is resolved at the bottom of
 * this file, so `startServer` sets it. Anything that reached a route before then — nothing does,
 * but the shape of the code should not be what says so — is refused rather than let through.
 *
 * The gate this feeds is authentication and not authorization: one secret, and holding it is the
 * whole of being allowed. What it defends against is another *account* and a sandboxed process,
 * because the file's permissions are the operating system's own boundary. It defends against
 * nothing already running as the operator, and `docs/SECURITY.md` says so in those words.
 */
const AUTH_REQUIRED = authRequired();
let AUTH_TOKEN: string | null = null;

/**
 * Whether this exit is a replacement rather than a stop.
 *
 * `POST /api/restart` hands the board to a supervisor that brings it back on the same port while
 * the reader's tab watches. The exit handlers clear the state files, and clearing the token there
 * would leave that tab holding a secret nothing accepts — a board that reports itself back and
 * then answers 401 to everything. So a restart writes a handover instead; see `core/auth-token.ts`.
 */
let handingOver = false;

/**
 * The token a caller offered, in the two spellings there are.
 *
 * A header for a program, because it stays out of logs and out of an address bar. A query
 * parameter because a browser's `WebSocket` constructor takes a URL and nothing else, so the
 * upgrade has no other door — and once it is accepted there it may as well be accepted on an
 * ordinary request, so that `curl` and a check script have one spelling that works everywhere.
 */
function offeredToken(headers: IncomingHttpHeaders, url: string | undefined): string | null {
  const header = headers[TOKEN_HEADER];
  if (typeof header === 'string' && header.trim()) return header.trim();
  try {
    // A base, because a request URL is a path and `new URL` needs an origin to parse one. Which
    // origin is irrelevant: nothing but the query is read out of it.
    const query = new URL(url ?? '/', 'http://board.invalid').searchParams.get(TOKEN_QUERY);
    if (query && query.trim()) return query.trim();
  } catch { /* not a URL we can read a query out of */ }
  return null;
}

/**
 * Which paired device offered this credential, if any.
 *
 * Wrapped rather than called directly because it reads a file on every request that missed the
 * board token, and a registry that cannot be read is not a reason to stop answering: the caller
 * is refused, which is what would have happened anyway, and the operator gets a line saying the
 * file is the reason rather than a stack trace on a request they made.
 */
function deviceFor(offered: string | null): DeviceRecord | null {
  try {
    return verifyDevice(offered);
  } catch (error) {
    logger.warn(`The device registry could not be read: ${(error as Error).message}`);
    return null;
  }
}

/**
 * A device as the management surface may see it: everything but the hash.
 *
 * The stored digest has no use in a browser and a page that carried every device's verifier
 * would put the whole registry through the network to draw a list. Written here rather than in
 * `core/device-registry.ts` because it is a fact about *this surface*, not about the registry.
 */
function deviceView(device: DeviceRecord): Omit<DeviceRecord, 'secretHash'> {
  const { secretHash: _secretHash, ...rest } = device;
  return rest;
}

/**
 * When each device was last written down as seen, so that is not done on every request.
 *
 * `touchDevice` deliberately leaves the rate to its caller — it reads and rewrites the whole
 * registry, with a `chmod`, and a poll every four seconds from every open panel would make that
 * the busiest write on the board. `lastSeenAt` is read by a person deciding whether a laptop is
 * still in use, and "within the last minute" is as fine as that question ever gets.
 *
 * In memory rather than on disk: a restart that forgets this costs one extra write per device.
 */
const deviceSeenAt = new Map<string, number>();
const DEVICE_TOUCH_INTERVAL_MS = 60_000;

function noteDeviceSeen(device: DeviceRecord): void {
  const now = Date.now();
  const written = deviceSeenAt.get(device.id);
  if (written !== undefined && now - written < DEVICE_TOUCH_INTERVAL_MS) return;
  deviceSeenAt.set(device.id, now);
  try {
    touchDevice(device.id);
  } catch (error) {
    logger.warn(`Could not record when ${device.name} was last seen: ${(error as Error).message}`);
  }
}

// The socket is the same hole as the routes by a door CORS does not cover at all: it declared
// no `verifyClient`, so a page at any origin got `initial_elements` and every live shell's
// scrollback on connect. Both gates have to exist; either one alone leaves the board readable.
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin, req }, done) => {
    // Resolved once, before either question below, because both of them turn on it: which device
    // is calling decides whether a caller that is not on this machine may be here at all, and
    // then whether what it carries is a credential this board accepts. Read again in
    // `connection` below rather than stashed on `req`, so that the record of who holds a socket
    // does not depend on two callbacks being handed the same object.
    const holder = AUTH_REQUIRED ? deviceFor(offeredToken(req.headers, req.url)) : null;

    // Who is calling, first, because the origin gate cannot see this caller at all. It asks a
    // browser question, and a program connecting from the network supplies whatever `Host` it
    // likes and is waved through — so an unguarded socket hands the whole board and every live
    // shell's scrollback to anyone who reaches the port, which is the same read the routes below
    // refuse (#366). Guarding the reads and not this one would have made them decorative.
    //
    // It asked about the *bind* until #501, and had to move with `offLoopback` rather than be
    // left behind an HTTP-only guard: this is where `initial_elements` and the scrollback go.
    //
    // An approved device is the one caller off this machine that may be here, and it has to be
    // able to be: the scene arrives over this socket and nowhere else, so a device refused here
    // is a device with a board that never draws. This is the same widening `offLoopback` takes,
    // in the place where refusing late is refusing after the whole board has been sent.
    if (!callerIsLocal(req) && !holder) {
      logger.warn('Refused a WebSocket upgrade: the board is served over the socket to a caller '
                  + 'on this machine or on a device this board has approved, and this one came '
                  + `from ${req.socket?.remoteAddress} with neither.`);
      done(false, 403, 'Forbidden');
      return;
    }
    const verdict = verifyOrigin({ origin, host: req.headers.host }, boardAuthorities(), PORT);
    if (!verdict.ok) {
      logger.warn(`Refused a WebSocket upgrade: ${verdict.reason}`);
      done(false, 403, 'Forbidden');
      return;
    }
    // The upgrade streams the scene and every live shell's scrollback the moment it opens, so it
    // is one of the two things the token has to cover — the other being everything under `/api`.
    // Refused here rather than after `connection`, because a socket that opens and is then closed
    // has already been handed `initial_elements`.
    if (AUTH_REQUIRED) {
      const offered = offeredToken(req.headers, req.url);
      // A paired device's secret opens the socket as the board token does, and the socket is
      // where revocation has to reach: an upgrade that has already been accepted keeps streaming
      // the scene and every live shell's scrollback whatever the registry says afterwards.
      if (!sameToken(offered, AUTH_TOKEN) && !holder) {
        logger.warn('Refused a WebSocket upgrade: it carried no valid board token.');
        done(false, 401, 'Unauthorized');
        return;
      }
    }
    done(true);
  }
});

/**
 * The two routes a device that has never been here may reach.
 *
 * They are the bootstrap of the pairing gesture (#503) and they are open for the same reason
 * `GET /` is: a page cannot present a credential before it has one, and asking for one is what
 * these are. Both gates below make an exception for exactly these two paths and for nothing
 * else — the pending list and the approval are the operator's, and they are behind the token
 * and behind loopback like every other route that acts on this machine.
 */
const PAIRING_OPEN_PATHS = new Set(['/api/pair/request', '/api/pair/status']);

/**
 * The path a gate decides on, which is not the path as it was typed.
 *
 * Every literal path comparison in this file goes through here, and the reason is that the
 * gates and the router used to disagree about what a path is. Express's router is
 * case-insensitive by default and nothing here set it otherwise, so `/API/elements` failed the
 * token gate's `startsWith('/api/')`, took the `next()` meant for a request that is not an API
 * request at all, and then matched `app.get('/api/elements')` perfectly. Measured
 * unauthenticated against a running board: `/api/elements` 401, `/API/elements` 200 with the
 * whole board, `/Api/elements` 200, `/api/../API/elements` 200.
 *
 * That was a session-lifetime bypass of the one control that stands between this server and
 * another process on the same machine — the threat `core/auth-token.ts` names, and one that is
 * on loopback, so every loopback guard passes for it. Since #510 it was more than that:
 * `POST /API/pair/approve` reached its handler, and a local process could approve its own
 * pairing request and keep a **persisted** device secret it never had to read a file for.
 *
 * A trailing slash is folded too, because `strict routing` is off by the same default and
 * `/api/elements/` reaches the same handler. Percent-encoding is deliberately *not* decoded:
 * `req.path` is the raw pathname and the router matches on the raw pathname, so the two already
 * agree there — `/%41PI/elements` matches nothing and 404s, and decoding here would invent a
 * disagreement rather than close one.
 */
function gatePath(req: Request): string {
  const lowered = req.path.toLowerCase();
  return lowered.length > 1 && lowered.endsWith('/') ? lowered.slice(0, -1) : lowered;
}

const isPairingBootstrap = (req: Request): boolean => PAIRING_OPEN_PATHS.has(gatePath(req));

/** Whether a path is one of this server's own routes rather than a file it serves. */
const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

/**
 * The page itself, which an unapproved device has to be able to load (#504).
 *
 * Until now the `Host` pin applied to `GET /` and to the bundle as well, so a device reaching
 * this board under a name it does not answer for — which is what a second machine is, and what
 * `POST /api/pair/request` exists to let it be — got a 403 with the origin gate's sentence in it
 * instead of a screen. A device cannot read a code off a page it is refused, so the gesture #503
 * describes had no way to start on the machine it is for.
 *
 * What this widens is exactly the software and nothing about the board. The page carries no
 * credential — the token comes out of the address bar on the machine that launched it, and a
 * device's own credential is minted by an approval — and every route that *acts* is still pinned,
 * so a page served to a rebound authority can do no more from there than the two open pairing
 * routes already allow it. `/health` stays pinned: it names a pid and a build, which is a thing
 * to answer this machine's own tools with rather than anybody who resolves a name here.
 *
 * `GET` and `HEAD` only, because a file is read and not written, and a `POST` to a path this
 * server does not route is a request that should meet the pin on its way to a 404.
 *
 * `gatePath` rather than `req.path`, like every other literal comparison in this file and for
 * the reason #513 gives: a rule that widened `/HEALTH` while pinning `/health` would be exactly
 * the disagreement between a gate and a router that this one was written to end.
 */
const isPageLoad = (req: Request): boolean => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = gatePath(req);
  if (path === '/health') return false;
  return !isApiPath(path);
};

// Middleware
//
// This replaces `app.use(cors())`, whose defaults were `origin: '*'`. Note it refuses rather
// than merely withholding CORS headers: a cross-origin `fetch` with `mode: 'no-cors'` still
// runs on this side, and for `POST /api/terminal` the damage is starting the shell, not
// reading the answer. See src/core/origin-gate.ts.
app.use((req: Request, res: Response, next: NextFunction) => {
  const verdict = (isPairingBootstrap(req) || isPageLoad(req))
    // Not the pin, because a device that has not been approved yet reaches this board under a
    // name it does not answer for — that is what pairing is. `verifySameAuthority` keeps the
    // half that still applies: a cross-origin page may not ask. See src/core/origin-gate.ts.
    ? verifySameAuthority({ origin: req.headers.origin, host: req.headers.host }, PORT)
    : verifyOrigin(
      { origin: req.headers.origin, host: req.headers.host },
      boardAuthorities(),
      PORT
    );
  if (!verdict.ok) {
    logger.warn(`Refused ${req.method} ${req.path}: ${verdict.reason}`);
    res.status(403).json({ success: false, error: verdict.reason });
    return;
  }
  next();
});

/**
 * The token gate, and what it deliberately leaves open.
 *
 * `GET /` and the static mounts below stay open, because the page has to be able to bootstrap:
 * it is the page that reads the token out of the address bar, and it cannot do that before it
 * has loaded. What they serve is this build's own frontend and Excalidraw's fonts — a bundle
 * anybody could fetch from npm — so what an unauthenticated caller gets from them is the
 * software, not the board. `/health` stays open for the same shape of reason and a second one:
 * it is how `core/port.ts`, `core/spawn.ts` and the restart supervisor find out whether anything
 * of ours is on a port at all, and it is answered before the token file exists.
 *
 * Everything under `/api` requires the token, with the two exceptions `PAIRING_OPEN_PATHS`
 * names. That is the whole of the reachable surface — the scene, the files, the terminal, the
 * agents, the registry and the directory picker — and until #350 every one of them was open to
 * any process on the machine that could open a socket.
 *
 * The two exceptions are the same kind of exception as `GET /`: asking to pair (#503) is how a
 * device that holds no credential gets one, so requiring a credential to ask would be a circle.
 * What they can do is bounded in `core/pairing.ts` and what they can read is nothing — a
 * `requestId` the caller was just handed, and whether the operator has looked at it yet.
 *
 * In front of `express.json`, so an unauthenticated caller cannot make this process parse ten
 * megabytes of body before being turned away.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!AUTH_REQUIRED) return next();
  // `gatePath`, never `req.path`: the two spellings of this comparison are what let `/API/…`
  // past this gate and into a handler (#513). See the note on that function.
  if (!isApiPath(gatePath(req))) return next();
  if (isPairingBootstrap(req)) return next();
  const offered = offeredToken(req.headers, req.url);
  if (sameToken(offered, AUTH_TOKEN)) return next();

  // The third answer, and the one the pairing in #503 exists to produce: a device approved on
  // this board holds a credential of its own (`core/device-registry.ts`), so that the operator
  // has something to revoke short of a restart. Verified after the board token and never
  // instead of it — the operator on loopback is the host, and the host is not on the list.
  //
  // `res.locals.device` is what the routes below read to tell the two apart. Absent means the
  // host, which is also what a board with the opt-out gives every caller: no authentication at
  // all is no way to be less than the operator.
  const device = deviceFor(offered);
  if (device) {
    res.locals.device = device;
    // On the request rather than on a timer: "last seen" is what tells a laptop in use from one
    // nobody has opened in months, and a request arriving is the only moment this server can
    // observe. Rate-limited in `noteDeviceSeen`, which is where the registry says it belongs.
    noteDeviceSeen(device);
    return next();
  }

  // The path, never the token: a refusal that echoed what it was offered would put a near-miss
  // in the log file, and the log file is not where a secret goes.
  logger.warn(`Refused ${req.method} ${req.path}: it carried no valid board token.`);
  res.status(401).json({
    success: false,
    error: 'This board requires its token. The launcher puts it in the URL it opens; a program '
      + `reads it from ${tokenFilePath(PORT)} and sends it as the ${TOKEN_HEADER} header or as `
      + `?${TOKEN_QUERY}=. See docs/SECURITY.md.`
  });
});

app.use(express.json({ limit: '10mb' }));

/**
 * The forwarding seam, first: a request naming a peer's board leaves this machine here.
 *
 * `core/peer-proxy.ts` (#565) reads the board off the request, finds the machine that owns it and
 * sends the request there. It is deliberately above the refusal below rather than beside it: a
 * board this one still holds a credential for is **answered by its owner**, and the refusal is
 * for what that seam does not route.
 */
app.use(peerProxy);

/**
 * And a board nobody can be asked about is refused, rather than answered out of a store made up
 * on the spot.
 *
 * The forwarder above deliberately lets an id it cannot route **fall through** — a peer that has
 * been forgotten, the row a peer with no projects wears on the strip, a near miss inside the
 * namespace. Falling through used to mean being answered locally, and that is the one failure in
 * this milestone that is **silent**: `elementsFor` yields an empty store for an id nothing
 * registered — deliberately, and eleven sibling maps behave the same way — so the operator would
 * see a blank canvas for a project that is alive somewhere, and one pointer press arming the
 * autosync would write that blank scene into a local store and into a local `.excalidraw`.
 * Nothing would log and there would be no thread to pull.
 *
 * So it refuses with a **stated status and a sentence**: 421, the status for a request that
 * reached a server which cannot produce the answer, and prose a page can render verbatim. A
 * forwarded request never gets here; what does is exactly the set for which there is nobody to
 * ask, and the two branches below are the two ways that happens.
 *
 * **The whole reserved namespace, not only the ids that parse.** `REMOTE_WORKSPACE_ID_PREFIX` is
 * reserved by `core/remote-workspace-id.ts`, and a near miss inside it would otherwise read as a
 * local project and manufacture exactly the store this exists to prevent.
 *
 * In front of every route rather than inside them, because "every board-scoped route" is some
 * thirty of them and a rule applied thirty times is a rule with a twenty-ninth site. After
 * `express.json`, because `workspaceIdFrom` reads a body field as well as a query parameter and a
 * header, and behind the token gate, because a caller holding nothing is told that first.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!isApiPath(gatePath(req))) return next();
  const named = workspaceIdFrom(req);
  if (!named.startsWith(REMOTE_WORKSPACE_ID_PREFIX)) return next();

  const pair = splitRemoteWorkspaceId(named);

  logger.warn(`Refused ${req.method} ${req.path}: it names the board "${named}", which is not `
    + 'one of this board\'s own and is not on a machine this board can ask.');
  res.status(421).json({
    success: false,
    error: pair
      ? `"${named}" is a project on a machine this board holds no credential for, so there is `
        + 'nothing to ask and nothing here to answer with. An empty board answered in its place '
        + 'would look exactly like a project with nothing on it. Pair with that machine again, or '
        + 'take the tab off the strip.'
      : `"${named}" is inside the "${REMOTE_WORKSPACE_ID_PREFIX}" namespace, which names another `
        + 'machine rather than a board this one keeps. Nothing was read and nothing was written.'
  });
});

// Serve static files from the build directory
const staticDir = path.join(__dirname, '../dist');
app.use(express.static(staticDir));
// Also serve frontend assets
app.use(express.static(path.join(__dirname, '../dist/frontend')));
/**
 * Where the Excalidraw package unpacked to, asked of the module resolver rather than guessed.
 *
 * The guess was `path.join(__dirname, '../node_modules/@excalidraw/excalidraw')`. In a source
 * checkout `__dirname` is `<repo>/dist` and that is exactly right; in an npm-installed copy it
 * points inside the package's own — empty — `node_modules`, while npm has hoisted the dependency
 * to the consumer root, so the mount was over a directory that was not there. pnpm's symlinked
 * store puts it somewhere else again. The resolver knows all three.
 *
 * Not `resolve('@excalidraw/excalidraw/package.json')`, which is the obvious spelling and throws:
 * the package's `exports` map defines `./*` as types only, so no subpath but `.` and
 * `./index.css` is reachable at all. The entry point is resolved instead and the package root
 * found by walking up from it to the `package.json` that names the package, rather than by
 * counting directories off the entry — `main` is `./dist/prod/index.js` today and where it
 * points is the package's business, not ours.
 */
function excalidrawPackageRoot(): string | null {
  let directory: string;
  try {
    directory = path.dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw'));
  } catch {
    return null;
  }
  for (let up = 0; up < 8; up++) {
    const manifest = path.join(directory, 'package.json');
    try {
      if (existsSync(manifest)
          && JSON.parse(readFileSync(manifest, 'utf-8'))?.name === '@excalidraw/excalidraw') {
        return directory;
      }
    } catch { /* not the manifest we are after */ }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

// Serve Excalidraw fonts so the font subsetting worker can fetch them for export, and so the
// canvas draws its own faces instead of fetching them from esm.sh — see the comment on
// `window.EXCALIDRAW_ASSET_PATH` in `frontend/index.html`.
const excalidrawRoot = excalidrawPackageRoot();
const excalidrawFonts = excalidrawRoot
  ? path.join(excalidrawRoot, 'dist', 'prod', 'fonts')
  : null;
if (excalidrawFonts && existsSync(excalidrawFonts)) {
  app.use('/assets/fonts', express.static(excalidrawFonts));
} else {
  // Said once, at warn, and the server comes up regardless: every face names the CDN as its
  // second source, so this degrades the board to what it did before the mount existed rather
  // than breaking it. Mounting the missing directory anyway would have answered 404 in silence
  // — and the two ways to get here are told apart, because "the dependency is not installed"
  // and "this build of it has no fonts" are answered by different things.
  logger.warn(
    excalidrawRoot
      ? `${excalidrawRoot} ships no dist/prod/fonts, so /assets/fonts is not mounted — `
        + 'the canvas will fetch its fonts from esm.sh instead.'
      : '@excalidraw/excalidraw could not be resolved, so /assets/fonts is not mounted — '
        + 'the canvas will fetch its fonts from esm.sh instead.'
  );
}

/**
 * Whether `incoming` should win over `current` when both describe the same element.
 *
 * Mirrors how Excalidraw reconciles collaborative scenes: `version` counts edits and
 * decides; `versionNonce` only breaks ties, where it is arbitrary but identical on
 * every peer, so all of them converge on the same winner instead of flip-flopping.
 */
function isNewerVersion(incoming: any, current: any): boolean {
  const incomingVersion = typeof incoming?.version === 'number' ? incoming.version : 0;
  const currentVersion = typeof current?.version === 'number' ? current.version : 0;

  if (incomingVersion !== currentVersion) return incomingVersion > currentVersion;

  const incomingNonce = typeof incoming?.versionNonce === 'number' ? incoming.versionNonce : 0;
  const currentNonce = typeof current?.versionNonce === 'number' ? current.versionNonce : 0;

  // Lower nonce wins, matching Excalidraw, so the choice is stable across peers.
  return incomingNonce < currentNonce;
}

// WebSocket connections
const clients = new Set<WebSocket>();

/** Elements held across every workspace — for counters that describe the process. */
function totalElementCount(): number {
  return activeWorkspaceIds().reduce((total, id) => total + elementsFor(id).size, 0);
}

/** Which board each socket is watching, so events do not cross boards. */
const socketWorkspaces = new WeakMap<WebSocket, string>();

/**
 * Whether a socket's board is the one its reader is actually looking at.
 *
 * Since #173 a browser keeps the socket of a board it has switched away from, so that the
 * board stays up to date and coming back is a redraw rather than a reconnect. Such a socket
 * still *receives* — that is the whole point of it — but it has no scene on screen, so it
 * cannot render an export or answer a request to move a camera. Without this distinction
 * `clientsWatching` would say a board has a browser on it and both of those routes would
 * wait out their timeout instead of being refused at once.
 *
 * True by default: a socket that never says otherwise is a browser on the board it named,
 * which is every socket before this existed and every socket from any other client.
 */
const socketWatching = new WeakMap<WebSocket, boolean>();

/**
 * What a socket calls itself, when it calls itself anything.
 *
 * A page's socket and a page's HTTP writes are two connections, and nothing tied them
 * together — so a write over HTTP came back to its own author over the socket, carrying the
 * server's whole copy of the element rather than the field that was written. Through a burst
 * of typing the autosync is a debounce behind, so that copy is the block as it was before it
 * grew: the echo hands a container its template height back while the label bound to it is
 * twice that (#190). The socket names itself on connect, `?client=<id>`, and a write names
 * the same id in `x-client-id`; that is the whole of the pairing.
 */
const socketClients = new WeakMap<WebSocket, string>();

/**
 * Which paired device holds a socket, for the sockets a paired device holds.
 *
 * A `Map` rather than a `WeakMap` like the three above, because this one has to be *walked*:
 * revoking a device means finding its open sockets and closing them, and a weak map answers
 * questions about a key somebody already has. Deleted on close beside the others, so it holds
 * exactly the live ones.
 *
 * Why it exists at all: revocation that only refuses the next HTTP request leaves the scene and
 * every live shell's scrollback flowing over an upgrade that was accepted before the device was
 * removed. The socket is the half a person cannot see, and it is the half that is still sending.
 */
const socketDevices = new Map<WebSocket, string>();

/** Who a request says it is, for the one purpose of not answering it back to itself. */
function clientIdFrom(req: Request): string | undefined {
  const named = req.headers['x-client-id'];
  const id = Array.isArray(named) ? named[0] : named;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

/**
 * Broadcast to the clients watching one workspace.
 *
 * Omitting `workspaceId` reaches every client — right for server-wide notices, wrong
 * for element events, which would make one board redraw with another board's shapes.
 *
 * **Which calls legitimately omit it, enumerated here so the next reader does not have to
 * re-derive the distinction from the call sites.** Today the answer is none: there is no
 * server-wide notice on this socket, and every element and file event below names its board.
 * `elements_synced`, `files_added` and `file_deleted` did not until #526 — `files_added`
 * carries dataURLs and the client applies them unconditionally, so an image pasted on one
 * project was pushed into every other project open in the same browser. A frame carrying no
 * board is also a frame nothing can route: the day a socket crosses a network, a forwarder
 * holding one has to choose between dropping it and fanning it wider than it goes here, and
 * neither of those is a behaviour anybody decided.
 *
 * One call still omits it and it is **not** one of the legitimate kind: `mermaid_convert`,
 * which asks whichever board is in front to draw a diagram. Scoping it would change what
 * `create_from_mermaid` does when the named board is not the one on screen — from drawing on
 * the wrong board to drawing nowhere — and that is a decision about a tool's contract rather
 * than about who is told, so #526 deliberately left it where it was.
 *
 * `initial_elements` on connect does not come through here at all: it is sent to the one
 * socket that just declared its board, which is the same scoping arrived at from the other end.
 *
 * `exceptClientId` leaves out the sockets of the client that asked for this, and nobody
 * else. An id no socket answers to excludes nobody, which is what makes it safe to send
 * from anything: a client that never names itself is told everything, as every client was
 * before this existed.
 */
function broadcast(message: WebSocketMessage, workspaceId?: string, exceptClientId?: string): void {
  const data = JSON.stringify(
    workspaceId ? { ...message, workspace: workspaceId } : message
  );
  clients.forEach(client => {
    try {
      if (client.readyState !== WebSocket.OPEN) return;
      if (workspaceId && socketWorkspaces.get(client) !== workspaceId) return;
      if (exceptClientId && socketClients.get(client) === exceptClientId) return;
      client.send(data);
    } catch (err) {
      logger.warn('Failed to send to client, removing');
      clients.delete(client);
    }
  });
}

/**
 * How many browsers are on one board.
 *
 * Two routes ask the browser to do something rather than telling it something — move its
 * camera, render its scene — and both used to ask *everyone*, then check that somebody
 * anywhere was connected. On a single-board setup those are the same question. With a tab
 * strip they are not: a request naming one project scrolled every project open in every
 * window, and an export of one board had every other board answer with its own scene
 * (#156). Both now ask one board, so both have to know whether that board has a browser
 * on it — `clients.size` would say yes on the strength of a tab watching something else.
 */
function clientsWatching(workspaceId: string): number {
  let watching = 0;
  clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (socketWorkspaces.get(client) !== workspaceId) return;
    // A socket kept open for a board its reader has switched away from is listening, not
    // watching. It has no scene on screen to render or to scroll.
    if (socketWatching.get(client) === false) return;
    watching += 1;
  });
  return watching;
}

function normalizeLineBreakMarkup(text: string): string {
  return text
    .replace(/<\s*b\s*r\s*\/?\s*>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

// WebSocket connection handling
wss.on('connection', (ws: WebSocket, request) => {
  // A socket belongs to one board for its lifetime: the client reconnects when it
  // switches tabs, which is simpler than multiplexing workspaces over one socket.
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  const workspaceId = normalizeWorkspaceId(requestUrl.searchParams.get('workspace'));
  socketWorkspaces.set(ws, workspaceId);
  // Optional, and unnamed is the state every socket was in before #190: a client that does
  // not say who it is is simply told everything.
  const clientId = requestUrl.searchParams.get('client')?.trim();
  if (clientId) socketClients.set(ws, clientId);
  // Asked again rather than carried over from `verifyClient`: the upgrade only had to decide
  // whether to accept, and what is wanted here is a name to close this socket by later. A
  // socket the board token opened is the operator's own page and is not on the list.
  const holder = AUTH_REQUIRED ? deviceFor(offeredToken(request.headers, request.url)) : null;
  if (holder) socketDevices.set(ws, holder.id);
  // A socket is watching until its own client says it is in the background: a browser opens
  // one for the board it is about to show.
  socketWatching.set(ws, true);
  clients.add(ws);
  logger.info(`New WebSocket connection established (workspace: ${workspaceId})`);

  // Send current elements to new client, with the files this board's own elements point
  // at — every board's files went out here, on every connect, which is the same megabytes
  // as the unscoped `GET /api/files` and paid for by every reader of every board.
  const filesObj = filesForWorkspace(workspaceId);
  const initialMessage: InitialElementsMessage & { files?: Record<string, ExcalidrawFile> } = {
    type: 'initial_elements',
    elements: Array.from(elementsFor(workspaceId).values()),
    ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
  };
  ws.send(JSON.stringify(initialMessage));

  // Send sync status to new client
  const syncMessage: SyncStatusMessage = {
    type: 'sync_status',
    elementCount: elementsFor(workspaceId).size,
    timestamp: new Date().toISOString()
  };
  ws.send(JSON.stringify(syncMessage));

  // A terminal session outlives the socket watching it — a reload, a tab switched away and
  // back, a second window — so every live transcript is replayed here rather than being lost
  // with whichever socket happened to receive it.
  //
  // The whole set, and sent even when it is empty, because this is what a viewer reconciles
  // its tabs against: a session that ended while the tab was disconnected has to be *absent*
  // from a list rather than merely unmentioned, or the block would keep a tab for a shell
  // that has gone. Gated on the feature being on rather than on there being a session, for
  // the reason the old code gated on the session: a board that never turned this on is told
  // nothing at all about it.
  if (TERMINAL_SETTING) {
    ws.send(JSON.stringify({
      type: 'terminal_sessions',
      workspace: workspaceId,
      sessions: Array.from(terminalSessionsFor(workspaceId).values()).map(terminalReplay)
    }));
  }

  // A browser cannot send a protocol ping, so the liveness check clients use is an
  // application message and answering it is the whole contract. Without an answer a
  // half-open socket reads OPEN until TCP gives up, which is minutes of a canvas that
  // looks connected and receives nothing.
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      // The other thing a client says: whether this board is the one on its screen. It stays
      // subscribed either way — see `socketWatching`.
      if (message?.type === 'watching') socketWatching.set(ws, message.active !== false);
    } catch {
      // Clients talk to this server over HTTP; anything else arriving here is not ours.
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    socketWorkspaces.delete(ws);
    socketWatching.delete(ws);
    socketClients.delete(ws);
    socketDevices.delete(ws);
    logger.info('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    clients.delete(ws);
    socketWorkspaces.delete(ws);
    socketWatching.delete(ws);
    socketClients.delete(ws);
    socketDevices.delete(ws);
  });
});

// Schema validation
const CreateElementSchema = z.object({
  id: z.string().optional(), // Allow passing ID for MCP sync
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  // Arrow-specific properties
  points: z.any().optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
  // Standard Excalidraw integration fields. Both already survive a frontend sync,
  // which spreads the element unvalidated — accepting them here removes an
  // asymmetry where the browser could set them but the API could not.
  link: z.string().nullable().optional(),
  customData: z.record(z.unknown()).optional(),
  // A shape's label is a text element bound to it through containerId; without this
  // the binding is stripped and the label becomes a free-floating text.
  containerId: z.string().nullable().optional(),
});

const UpdateElementSchema = z.object({
  id: z.string(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  points: z.array(z.union([
    z.tuple([z.number(), z.number()]),
    z.object({ x: z.number(), y: z.number() })
  ])).optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
  link: z.string().nullable().optional(),
  customData: z.record(z.unknown()).optional(),
  // A shape's label is a text element bound to it through containerId; without this
  // the binding is stripped and the label becomes a free-floating text.
  containerId: z.string().nullable().optional(),
});

// ─── The loopback guard ───────────────────────────────────────
//
// Every route below that answers with something this machine owns asks this first. What it asks
// lives in `core/caller-gate.ts`; the whole of the funnel is here, so the ~40 call sites keep
// the shape they have and there is one place where the question can change.

/**
 * Refuse a caller that arrived over the network, and say which question was asked.
 *
 * Three kinds of route call this, and the last two are the ones worth explaining. The first write
 * files this machine owns, spawn a process holding the operator's `gh` credentials, or list its
 * directories — reaching those from the network is obviously worse than reaching a route that
 * only reads. The second are **reads of board contents**: the elements, the images, the documents,
 * the library and the snapshots. They were left open when the first set was guarded, on the
 * reasoning that a read is the safe half; #366 decided that it is not. A board bound to an
 * interface was publishing everything on it to whoever reached the port, and the only honest
 * choice between guarding the reads and writing down that they are open was to guard them.
 *
 * The third are the **writes of board contents**, and #456 is where the same question was put to
 * them. Guarding the reads alone had left a board bound to an interface as something odd: nobody
 * on the network could read it, and anybody reaching the port could still draw on it, empty it
 * (`DELETE /api/elements/clear` copies first, and it still empties it) and fill its file store.
 * The two answers on offer were to guard them as well or to write down that they are open, which
 * `docs/rest-api.md` had been doing in one sentence; a sentence is not a decision, and the
 * asymmetry was the shape the routes happened to have rather than anything anybody chose. They
 * are guarded. The two `/result` routes go with them rather than being excused as "the browser
 * answering back": the browser that would answer cannot open its socket off loopback at all since
 * #366, so nothing is lost, and what is refused is a network caller resolving somebody else's
 * pending export by guessing a request id.
 *
 * **Until #501 all of that asked about the bind**, and so a board on any interface was inert for
 * everybody — including the browser on the host machine, which is loopback and whose request was
 * refused anyway. A bind on every interface and a bind on one address of a private overlay were
 * treated alike, so the
 * careful configuration was punished exactly as hard as the reckless one, and there was no
 * configuration in which this board could be reached from a second machine, however narrow. It
 * asks about the caller now, so the consequence changes shape rather than going away: what a
 * *stranger* gets from a board on an interface is still nothing in either direction, and what the
 * operator gets on the machine it runs on is the whole board. A reverse proxy is unaffected
 * either way — it reaches this server on loopback, which is the configuration
 * `EXCALIDRAW_ALLOWED_HOSTS` exists for.
 *
 * **And #522 is the credential that answer was waiting for.** #501 refused every remote caller
 * because there was nobody to ask about: the only identity was one per-start bearer token, which
 * a second machine cannot read off a filesystem it is not on. #502 gave the board a registry and
 * #503 the gesture that writes into it, and until this funnel consulted them a device could
 * complete the whole approval, hold a secret nothing refused, and reach not one route. So a
 * caller that is not on this machine is admitted here on exactly one ground — `res.locals.device`,
 * set by the token gate above when the credential it carried verified against the registry — and
 * refused on every other. That is one named, revocable, per-device record and not a widening: a
 * board with no device paired behaves exactly as it did, and so does one whose operator has
 * turned authentication off, because with no gate there is no `res.locals.device` for anybody.
 *
 * What a device reaches by being admitted here is the whole of this funnel, which is the board
 * and the boards, the files, the images, the exports, the snapshots, the viewport, the projects,
 * the directory picker and the restart button — `docs/SECURITY.md` enumerates it. What it does
 * **not** reach is anything still guarded on the bind: the routes that spawn `gh` with the
 * operator's own credentials stay the operator's, and so does the pairing desk, which is
 * `notTheHost`'s and is how a device is approved in the first place.
 *
 * `res.req` rather than a second parameter, because a funnel is only one place to change while
 * nothing has to be threaded through the call sites to reach it. Express sets it on every
 * response, and it is the request this reply is being written for.
 *
 * `X-Forwarded-For` is not read; `core/caller-gate.ts` says at length why not, and takes an
 * address rather than a request so that it cannot start.
 *
 * Three controls stand in front of these routes and none replaces another. The token (#350) is
 * what the caller carries, and it is a `VIBEMAXXING_NO_AUTH` away from not being there — which
 * is the state every check in `scripts/` runs in. The origin gate
 * (`src/core/origin-gate.ts`) asks a browser question, `Origin` and `Host`, and its own comment
 * says a program that can set headers can set any header. This asks where the packets came from,
 * which is the one thing about a caller that nobody can forge, and it answers 403 to a remote
 * request holding a perfectly good token.
 */
function offLoopback(res: Response, what: string): boolean {
  if (callerIsLocal(res.req)) return false;
  if (res.locals.device) return false;
  res.status(403).json({
    success: false,
    // The credential, not the bind. A caller here has already satisfied the token gate — a
    // remote request holding the board's own token lands exactly here — so telling it about
    // loopback would send whoever reads this to rebind a server that is bound correctly, when
    // what they are missing is an approved device (`docs/devices.md`).
    error: `${what} only for a caller on this machine, or one on a device this board has `
      + `approved. This request came from `
      + `${res.req.socket?.remoteAddress ?? 'an address this server could not read'} `
      + 'and carried no approved device\'s credential.'
  });
  return true;
}

/**
 * Whether the two features that *act on this machine* are this caller's to use.
 *
 * A different question from the funnel above, and the reason it is different is the reason #518
 * gave for leaving it alone: the funnel asks who may **read** the records, and this asks whether
 * a shell and a coding agent may be started at all. Its old answer was the bind and nothing else
 * — `LOOPBACK_ADDRESSES.includes(HOST)` — because a board reachable from the network offered
 * remote code execution to whoever reached the port, and there was nobody to tell apart from
 * whoever.
 *
 * There is now: an approved device is one named, revocable record that the operator wrote by
 * looking at a card and pressing approve. So the bind stays the answer for a caller with no
 * credential — an interface-bound board still refuses the terminal and the implement agent to
 * its own operator, who has a loopback board a keystroke away — and a device is the second way
 * to be entitled rather than a hole in the first.
 *
 * Taken with no response at all where a run of the board's own asks the question of *itself*
 * (`interactiveTabRefusal`, `implementTerminalHost`): nobody is calling there, and the bind is
 * the whole of the answer.
 *
 * This is one predicate on purpose. The two capability flags — `queue` on `GET /api/implement`,
 * and whether a terminal can be had — and the two refusals behind them are halves of the same
 * rule, and a board that drew a toggle its own route then refused would be lying to whoever
 * pressed it. That is what #518 objected to and it is answered by moving both halves together,
 * not by leaving the flag behind.
 */
function actingFor(res: Response | null): boolean {
  if (LOOPBACK_ADDRESSES.includes(HOST) || HOST === 'localhost') return true;
  return Boolean(res?.locals.device);
}

// API Routes

// Get all elements
app.get('/api/elements', async (req: Request, res: Response) => {
  if (offLoopback(res, 'The board is read')) return;

  try {
    // What is on this board — which cannot be answered until this board has been read back.
    await whenBoardsRestored();
    const elementsArray = Array.from(elementsFor(workspaceIdFrom(req)).values());
    res.json({
      success: true,
      elements: elementsArray,
      count: elementsArray.length
    });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Create new element
app.post('/api/elements', (req: Request, res: Response) => {
  if (offLoopback(res, 'The board is drawn on')) return;

  try {
    const params = CreateElementSchema.parse(req.body);
    const workspaceId = workspaceIdFrom(req);
    const store = elementsFor(workspaceId);
    logger.info('Creating element via API', { type: params.type, workspace: workspaceId });

    // Prioritize passed ID (for MCP sync), otherwise generate new ID
    const id = params.id || generateId();
    const element: ServerElement = {
      id,
      ...params,
      fontFamily: normalizeFontFamily(params.fontFamily),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    // Resolve arrow bindings against existing elements
    if (element.type === 'arrow' || element.type === 'line') {
      resolveArrowBindings([element], store);
    }

    store.set(id, element);

    // Broadcast to all connected clients
    const message: ElementCreatedMessage = {
      type: 'element_created',
      element: element
    };
    broadcast(message, workspaceId);

    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Update element
app.put('/api/elements/:id', (req: Request, res: Response) => {
  if (offLoopback(res, 'An element is changed')) return;

  try {
    const { id } = req.params;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = UpdateElementSchema.parse({ id, ...body });
    const workspaceId = workspaceIdFrom(req);
    const store = elementsFor(workspaceId);

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const existingElement = store.get(id);
    if (!existingElement) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const updatedElement: ServerElement = {
      ...existingElement,
      ...updates,
      fontFamily: updates.fontFamily !== undefined ? normalizeFontFamily(updates.fontFamily) : existingElement.fontFamily,
      updatedAt: new Date().toISOString(),
      version: (existingElement.version || 0) + 1
    };

    // Keep Excalidraw text source in sync when clients update text via REST.
    // If originalText lags behind text, rendered wrapping/position can drift.
    const hasTextUpdate = Object.prototype.hasOwnProperty.call(body, 'text');
    const hasOriginalTextUpdate = Object.prototype.hasOwnProperty.call(body, 'originalText');
    if (updatedElement.type === EXCALIDRAW_ELEMENT_TYPES.TEXT && hasTextUpdate && !hasOriginalTextUpdate) {
      const incomingText = updates.text ?? '';
      const existingText = typeof existingElement.text === 'string' ? existingElement.text : '';
      const existingOriginalText = typeof existingElement.originalText === 'string'
        ? existingElement.originalText
        : '';
      const existingOriginalHasBr = /<\s*b\s*r\s*\/?\s*>/i.test(existingOriginalText);
      const normalizedExistingText = normalizeLineBreakMarkup(existingText);
      const normalizedExistingOriginalText = normalizeLineBreakMarkup(existingOriginalText);

      // Handle common cleanup flow: caller normalizes the rendered text value.
      // In this case, prefer normalized originalText so words aren't split by stale wraps.
      if (existingOriginalHasBr && incomingText === normalizedExistingText && normalizedExistingOriginalText) {
        updatedElement.text = normalizedExistingOriginalText;
        updatedElement.originalText = normalizedExistingOriginalText;
      } else {
        updatedElement.originalText = incomingText;
      }
    }

    store.set(id, updatedElement);

    // Broadcast to every client on this board except the one that asked for it. The author
    // already knows what it wrote, and the response below carries the whole element for it
    // to apply; what it does not need is the server's copy merged back over its live scene
    // a debounce behind (#190). Every other browser on the board has no other way to hear.
    const message: ElementUpdatedMessage = {
      type: 'element_updated',
      element: updatedElement
    };
    broadcast(message, workspaceId, clientIdFrom(req));

    // Moving/resizing a shape must drag its bound arrows along. Sent to the author too:
    // these are elements it did not write and does not otherwise know have moved.
    const geometryChanged = ['x', 'y', 'width', 'height']
      .some(key => Object.prototype.hasOwnProperty.call(body, key));
    if (geometryChanged && updatedElement.type !== 'arrow' && updatedElement.type !== 'line') {
      for (const arrow of rerouteBoundArrows(id, store)) {
        broadcast({ type: 'element_updated', element: arrow } as ElementUpdatedMessage, workspaceId);
      }
    }

    res.json({
      success: true,
      element: updatedElement
    });
  } catch (error) {
    logger.error('Error updating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * Empty one board's store (must be before the `/:id` route, or `clear` reads as an id).
 *
 * The copy is taken here rather than in whoever asked, because everything that empties a
 * board comes through this one route and only one of those callers has a person in front of
 * it: the header's `Clear Canvas` confirms first, but the MCP `clear_canvas` tool, the CLI's
 * `clear --yes` and `restore_snapshot` — which clears *before* it restores, and says
 * `canvas was cleared` when the restore then fails — do not, and must not start to. A
 * confirmation in front of this route would break an agent-facing contract; a copy behind it
 * breaks nothing and is what makes any of them recoverable (#345).
 *
 * The path it went to is in the response, so the caller can say it. A backup nobody is told
 * about is a backup nobody restores.
 */
app.delete('/api/elements/clear', async (req: Request, res: Response) => {
  if (offLoopback(res, 'The board is emptied')) return;

  try {
    const workspaceId = workspaceIdFrom(req);
    const store = elementsFor(workspaceId);
    const count = store.size;
    const backup = await backupBoardBefore(workspaceId);
    store.clear();

    broadcast({
      type: 'canvas_cleared',
      timestamp: new Date().toISOString()
    }, workspaceId);

    logger.info(`Canvas cleared: ${count} elements removed`
      + (backup ? `; the board as it was is in ${backup}` : ''));

    res.json({
      success: true,
      message: `Cleared ${count} elements`,
      count,
      backup
    });
  } catch (error) {
    logger.error('Error clearing canvas:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Delete element
app.delete('/api/elements/:id', (req: Request, res: Response) => {
  if (offLoopback(res, 'An element is deleted')) return;

  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const workspaceId = workspaceIdFrom(req);
    const store = elementsFor(workspaceId);
    if (!store.has(id)) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    store.delete(id);

    // Broadcast to all connected clients
    const message: ElementDeletedMessage = {
      type: 'element_deleted',
      elementId: id!
    };
    broadcast(message, workspaceId);

    res.json({
      success: true,
      message: `Element ${id} deleted successfully`
    });
  } catch (error) {
    logger.error('Error deleting element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * Query parameters this route must not read as element fields.
 *
 * It is the only route in the file that treats what it does not recognise as data, which makes
 * it the only one where a name the *transport* already spent is spent a second time. Both of
 * these are such names: `?workspace=` chooses the board (`WORKSPACE_QUERY_KEYS`, and #457 is
 * what happens without this), and `?token=` is the spelling of the board token a caller uses
 * when it cannot set a header — the WebSocket constructor's case, allowed on ordinary requests
 * so that `curl` has one spelling that works everywhere.
 *
 * Nothing is lost by excluding them. A stored element has no `workspace` or `token` property to
 * match against: which board an element is on is which `Map` it is in, not a field written on
 * it, so the filter these names produced could only ever match nothing.
 */
const SEARCH_RESERVED_PARAMS = new Set<string>([...WORKSPACE_QUERY_KEYS, TOKEN_QUERY]);

// Query elements with filters
app.get('/api/elements/search', async (req: Request, res: Response) => {
  // With no query at all this is `GET /api/elements` by another name, so it carries the same
  // guard. A lock beside an open door is not a decision, it is the shape the routes happened
  // to have. The wait below is here for the same reason: a search of a board that has not been
  // read back is a search of an empty board, and it answers "nothing matched".
  if (offLoopback(res, 'The board is searched')) return;

  try {
    await whenBoardsRestored();
    const { type, x_min, x_max, y_min, y_max, ...rest } = req.query;
    // What is left over is the arbitrary-field filter, minus the names above that are addressing
    // rather than data. Dropped here rather than in the loop below, so that `filters` means the
    // same thing at every line that reads it.
    const filters = Object.fromEntries(
      Object.entries(rest).filter(([key]) => !SEARCH_RESERVED_PARAMS.has(key)));
    let results = Array.from(elementsFor(workspaceIdFrom(req)).values());

    // Filter by type if specified
    if (type && typeof type === 'string') {
      results = results.filter(element => element.type === type);
    }

    // Filter by bounding box if specified
    if (x_min !== undefined || x_max !== undefined || y_min !== undefined || y_max !== undefined) {
      const xMin = x_min !== undefined ? Number(x_min) : -Infinity;
      const xMax = x_max !== undefined ? Number(x_max) : Infinity;
      const yMin = y_min !== undefined ? Number(y_min) : -Infinity;
      const yMax = y_max !== undefined ? Number(y_max) : Infinity;

      results = results.filter(el =>
        el.x >= xMin &&
        el.x <= xMax &&
        el.y >= yMin &&
        el.y <= yMax
      );
    }

    // Apply additional exact-match filters
    if (Object.keys(filters).length > 0) {
      results = results.filter(element => {
        return Object.entries(filters).every(([key, value]) => {
          return (element as any)[key] === value;
        });
      });
    }

    res.json({
      success: true,
      elements: results,
      count: results.length
    });
  } catch (error) {
    logger.error('Error querying elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Get element by ID
app.get('/api/elements/:id', async (req: Request, res: Response) => {
  if (offLoopback(res, 'An element is read')) return;

  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    // Before the lookup, and it matters more here than on the two reads above: a board that has
    // not been read back yet answers this one **404**, which says the element does not exist
    // rather than that the board is empty.
    await whenBoardsRestored();
    const element = elementsFor(workspaceIdFrom(req)).get(id);

    if (!element) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error fetching element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Helper: compute edge point for an element given a direction toward a target
function computeEdgePoint(
  el: ServerElement,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;

  if (el.type === 'diamond') {
    // Diamond edge: use diamond geometry (rotated square)
    const hw = (el.width || 0) / 2;
    const hh = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    // Scale factor to reach diamond edge
    const scale = (absDx / hw + absDy / hh) > 0
      ? 1 / (absDx / hw + absDy / hh)
      : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    // Ellipse edge: parametric intersection
    const a = (el.width || 0) / 2;
    const b = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + b };
    const angle = Math.atan2(dy, dx);
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) };
  }

  // Rectangle: find intersection with edges
  const hw = (el.width || 0) / 2;
  const hh = (el.height || 0) / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  // Check if ray intersects top/bottom edge or left/right edge
  if (Math.abs(tanA * hw) <= hh) {
    // Intersects left or right edge
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    // Intersects top or bottom edge
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

// Helper: resolve arrow bindings in a batch
function resolveArrowBindings(
  batchElements: ServerElement[],
  store: Map<string, ServerElement>
): void {
  const elementMap = new Map<string, ServerElement>();
  batchElements.forEach(el => elementMap.set(el.id, el));

  // Also check existing elements for cross-batch references
  store.forEach((el, id) => {
    if (!elementMap.has(id)) elementMap.set(id, el);
  });

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;

    if (!startRef && !endRef) continue;

    const startEl = startRef ? elementMap.get(startRef.id) : undefined;
    const endEl = endRef ? elementMap.get(endRef.id) : undefined;

    // Calculate arrow path from edge to edge
    const startCenter = startEl
      ? { x: startEl.x + (startEl.width || 0) / 2, y: startEl.y + (startEl.height || 0) / 2 }
      : { x: el.x, y: el.y };
    const endCenter = endEl
      ? { x: endEl.x + (endEl.width || 0) / 2, y: endEl.y + (endEl.height || 0) / 2 }
      : { x: el.x + 100, y: el.y };

    const GAP = 8;
    const startPt = startEl
      ? computeEdgePoint(startEl, endCenter.x, endCenter.y)
      : startCenter;
    const endPt = endEl
      ? computeEdgePoint(endEl, startCenter.x, startCenter.y)
      : endCenter;

    // Apply gap: move start point slightly away from source, end point slightly away from target
    const startDx = endPt.x - startPt.x;
    const startDy = endPt.y - startPt.y;
    const startDist = Math.sqrt(startDx * startDx + startDy * startDy) || 1;
    const endDx = startPt.x - endPt.x;
    const endDy = startPt.y - endPt.y;
    const endDist = Math.sqrt(endDx * endDx + endDy * endDy) || 1;

    const finalStart = {
      x: startPt.x + (startDx / startDist) * GAP,
      y: startPt.y + (startDy / startDist) * GAP
    };
    const finalEnd = {
      x: endPt.x + (endDx / endDist) * GAP,
      y: endPt.y + (endDy / endDist) * GAP
    };

    // Set arrow position and points
    el.x = finalStart.x;
    el.y = finalStart.y;
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];

    // Do NOT delete `start` and `end` here.
    // Excalidraw's frontend `convertToExcalidrawElements` method looks for these exact properties
    // to calculate mathematically sound `startBinding`, `endBinding`, `focus`, `gap`, and `boundElements`.
  }
}

// After a shape's geometry changes, recompute every arrow bound to it so the
// visual connection follows the shape — bindings are otherwise only resolved
// at creation time, which left arrows floating at stale coordinates when
// update/align/distribute moved their endpoints. Returns the re-routed arrows.
function rerouteBoundArrows(
  movedId: string,
  store: Map<string, ServerElement>
): ServerElement[] {
  const rerouted: ServerElement[] = [];
  store.forEach(el => {
    if (el.type !== 'arrow' && el.type !== 'line') return;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;
    if (startRef?.id !== movedId && endRef?.id !== movedId) return;
    resolveArrowBindings([el], store);
    el.updatedAt = new Date().toISOString();
    el.version = (el.version || 0) + 1;
    rerouted.push(el);
  });
  return rerouted;
}

// Batch create elements
app.post('/api/elements/batch', (req: Request, res: Response) => {
  if (offLoopback(res, 'The board is drawn on')) return;

  try {
    const { elements: elementsToCreate } = req.body;
    const batchWorkspaceId = workspaceIdFrom(req);
    const batchStore = elementsFor(batchWorkspaceId);

    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of elements'
      });
    }

    const createdElements: ServerElement[] = [];

    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData);
      // Prioritize passed ID (for MCP sync), otherwise generate new ID
      const id = params.id || generateId();
      const element: ServerElement = {
        id,
        ...params,
        fontFamily: normalizeFontFamily(params.fontFamily),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };

      createdElements.push(element);
    });

    // Resolve arrow bindings (computes positions, startBinding, endBinding, boundElements)
    resolveArrowBindings(createdElements, batchStore);

    // Store all elements after binding resolution
    createdElements.forEach(el => batchStore.set(el.id, el));

    // Broadcast to all connected clients
    const message: BatchCreatedMessage = {
      type: 'elements_batch_created',
      elements: createdElements
    };
    broadcast(message, batchWorkspaceId);

    res.json({
      success: true,
      elements: createdElements,
      count: createdElements.length
    });
  } catch (error) {
    logger.error('Error batch creating elements:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Convert Mermaid diagram to Excalidraw elements
app.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
  if (offLoopback(res, 'A diagram is converted onto the board')) return;

  try {
    const { mermaidDiagram, config } = req.body;

    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mermaid diagram definition is required'
      });
    }

    logger.info('Received Mermaid conversion request', {
      diagramLength: mermaidDiagram.length,
      hasConfig: !!config
    });

    // Broadcast to all WebSocket clients to process the Mermaid diagram
    broadcast({
      type: 'mermaid_convert',
      mermaidDiagram,
      config: config || {},
      timestamp: new Date().toISOString()
    });

    // Return the diagram for frontend processing
    res.json({
      success: true,
      mermaidDiagram,
      config: config || {},
      message: 'Mermaid diagram sent to frontend for conversion.'
    });
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Sync elements from frontend (overwrite sync)
app.post('/api/elements/sync', (req: Request, res: Response) => {
  if (offLoopback(res, 'The board is written back')) return;

  try {
    const { elements: frontendElements, timestamp } = req.body;

    // `debug`, not `info`: the browser autosyncs whenever anything on the canvas moves, so this
    // and the reconciliation below were two lines per nudge in a file nothing rotated — the bulk
    // of the 14 MB a day #348 measured. A sync that goes wrong still says so at `warn`.
    logger.debug(`Sync request received: ${frontendElements.length} elements`, {
      timestamp,
      elementCount: frontendElements.length
    });

    // Validate input data
    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({
        success: false,
        error: 'Expected elements to be an array'
      });
    }

    // Record element count before sync
    const syncWorkspaceId = workspaceIdFrom(req);
    const store = elementsFor(syncWorkspaceId);
    const beforeCount = store.size;

    // Reconcile instead of clear-and-replace. A payload is what one client knows,
    // not the whole truth: an element the client never saw (created through the API
    // moments earlier) must survive. Absence means "no information", never "delete" —
    // deletions travel explicitly as isDeleted, the same contract Excalidraw uses
    // when reconciling collaborative scenes.
    let successCount = 0;
    let updatedCount = 0;
    let staleCount = 0;
    let deletedCount = 0;
    // Elements that won the race but arrived without what the server had written on them.
    // Logged because it is the only visible trace of a crossing, and #118 was invisible.
    let carriedCount = 0;
    const processedElements: ServerElement[] = [];

    frontendElements.forEach((element: any, index: number) => {
      try {
        // Ensure element has ID, generate one if missing
        const elementId = element.id || generateId();
        const existing = store.get(elementId);

        if (element.isDeleted) {
          // An explicit tombstone. Only honour it when it is newer than what we
          // hold, so a stale client cannot resurrect-then-delete a fresher edit.
          if (!existing) return;                       // already gone
          if (!isNewerVersion(element, existing)) { staleCount++; return; }
          store.delete(elementId);
          deletedCount++;
          return;
        }

        if (existing && !isNewerVersion(element, existing)) {
          // Our copy is newer — keep it and let the broadcast correct the client.
          staleCount++;
          processedElements.push(existing);
          return;
        }

        // Winning the version race does not win the whole element. `version` is the
        // browser's number — bumped on every keystroke and nudge, while the server bumps
        // it once per state change — so a payload that crosses a server write reverts it.
        // The fields the server authors are therefore taken out of the race entirely;
        // `element-authorship.ts` has the measurement behind that, and #118 is what it
        // cost. Everything else about the element is still the browser's.
        const authored = preserveServerAuthored(element as ServerElement, existing);
        if (existing && authored !== element) carriedCount++;

        // Add server metadata. Note version comes from the incoming element: it is
        // what makes the next reconciliation possible, so it must not be reset.
        const processedElement: ServerElement = {
          ...authored,
          id: elementId,
          syncedAt: new Date().toISOString(),
          source: 'frontend_sync',
          syncTimestamp: timestamp,
          version: typeof element.version === 'number' ? element.version : 1
        };

        // Store to memory
        store.set(elementId, processedElement);
        processedElements.push(processedElement);
        successCount++;
        if (existing) updatedCount++;

      } catch (elementError) {
        logger.warn(`Failed to process element ${index}:`, elementError);
      }
    });

    logger.debug(
      `Sync reconciled: ${successCount} applied (${updatedCount} updates), ` +
      `${deletedCount} deleted, ${staleCount} ignored as stale, ` +
      `${carriedCount} kept their server-authored state, ${store.size} total`
    );

    // 3. Broadcast sync event to all WebSocket clients
    broadcast({
      type: 'elements_synced',
      count: successCount,
      timestamp: new Date().toISOString(),
      source: 'manual_sync'
    }, syncWorkspaceId);

    // 4. Return sync results
    res.json({
      success: true,
      message: `Successfully synced ${successCount} elements`,
      count: successCount,
      updated: updatedCount,
      deleted: deletedCount,
      stale: staleCount,
      syncedAt: new Date().toISOString(),
      beforeCount,
      afterCount: store.size
    });

  } catch (error) {
    logger.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message,
      details: 'Internal server error during sync operation'
    });
  }
});

// ─── Paired devices (who else can reach this board) ───────────
//
// The management half of the registry in `core/device-registry.ts`. Once a second machine can be
// paired there is a third, and a laptop that was sold, and a phone paired at an airport that
// should not still be on the list — so the list, the name and the revoke are the feature and the
// pairing is only its first minute.
//
// Two credentials reach these routes and they are not the same caller. The **host** is the
// operator: the board token, which is a file only this account can read, and it is not on the
// list. A **paired device** carries a credential of its own and `res.locals.device` names which
// one. The split below is that distinction and nothing else:
//
//   - the **list** is answered to either, because a device that cannot see the list cannot see
//     that it is on one, and "sign this machine out" needs somewhere to press;
//   - a **rename** is the host's, because the name is the operator's word for a machine and a
//     device renaming its neighbours is not a thing it has any standing to do;
//   - a **revoke** is the host's, and a device's own — revoking the device you are reading this
//     on is allowed and is not special-cased into a refusal. The operator on loopback cannot
//     lock themselves out (the board token is a file, not a device), and a paired device signing
//     itself out is the ordinary case rather than the dangerous one.
//
// `notTheHost` in front of all three, and that is the one thing here #522 changed. It was
// `offLoopback`, which asked the identical question until that issue taught the funnel to admit
// an approved device — at which point these three would have widened along with everything else,
// silently, as a side effect of a change about the scene. They do not. **Host-only, full stop:**
// the list, the rename and the revoke are the operator's, on the machine the board runs on, and
// a device reading its own record would put the management surface on the network for a
// convenience nobody asked for.
//
// So the split above is now a split between two callers that both reach here from *this*
// machine: the operator's browser holding the board token, and a local process holding a device
// credential. It is kept rather than flattened because it is the honest description of what the
// routes do — `res.locals.device` is what tells them apart wherever a credential arrives — and
// because a device signing itself out is a legitimate thing for these routes to answer when the
// gate in front of them lets it ask.

/** Every socket a device holds, closed. The count, so a caller is told what it disconnected. */
function closeSocketsOfDevice(deviceId: string, reason: string): number {
  let closed = 0;
  for (const [socket, held] of [...socketDevices.entries()]) {
    if (held !== deviceId) continue;
    socketDevices.delete(socket);
    try {
      // 4003, an application code: 1008 (policy violation) is reserved for the endpoint that is
      // *rejecting a message*, and nothing this socket sent is what is wrong with it. The reason
      // travels to the other end, where it is the only explanation the device will get.
      socket.close(4003, reason);
    } catch { /* already going */ }
    closed++;
  }
  return closed;
}

app.get('/api/devices', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'Paired devices are listed')) return;
  try {
    const asked = res.locals.device as DeviceRecord | undefined;
    res.json({
      success: true,
      devices: listDevices().map(deviceView),
      // Which of them is the caller, so the surface can say "this is the device you are reading
      // this on" before it offers to revoke it. Null for the host, which is not on the list.
      self: asked?.id ?? null
    });
  } catch (error) {
    logger.error('Could not list paired devices:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.patch('/api/devices/:id', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'A paired device is renamed')) return;
  if (res.locals.device) {
    res.status(403).json({
      success: false,
      error: 'Only the machine this board runs on may rename a device.'
    });
    return;
  }
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  if (!name.trim()) {
    res.status(400).json({ success: false, error: 'A device needs a name.' });
    return;
  }
  const id = req.params.id ?? '';
  try {
    if (!renameDevice(id, name)) {
      res.status(404).json({ success: false, error: 'No device on this board has that id.' });
      return;
    }
    // Read back rather than assembled from the request: the registry is the record, and a
    // surface that redrew from what it sent would show a rename that had not landed.
    const devices = listDevices().map(deviceView);
    res.json({ success: true, device: devices.find(entry => entry.id === id) ?? null, devices });
  } catch (error) {
    logger.error('Could not rename a paired device:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.delete('/api/devices/:id', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'A paired device is revoked')) return;
  const asked = res.locals.device as DeviceRecord | undefined;
  const id = req.params.id ?? '';
  if (asked && asked.id !== id) {
    res.status(403).json({
      success: false,
      error: 'A paired device may sign itself out, and only itself.'
    });
    return;
  }
  try {
    // Named before it goes, because what a caller is told afterwards is the name and the record
    // is gone by then.
    const removed = listDevices().find(entry => entry.id === id) ?? null;
    if (!revokeDevice(id)) {
      res.status(404).json({ success: false, error: 'No device on this board has that id.' });
      return;
    }
    // After the record is gone, so a socket that reconnects in the gap between the two is
    // refused by the gate rather than let back in and closed again.
    const closed = closeSocketsOfDevice(id, 'This device was revoked.');
    if (closed) logger.info(`Closed ${closed} socket(s) held by the device that was revoked.`);
    res.json({
      success: true,
      device: removed ? deviceView(removed) : null,
      socketsClosed: closed,
      // So a device that signed itself out knows the page it is looking at is now a stranger.
      self: asked?.id === id,
      devices: listDevices().map(deviceView)
    });
  } catch (error) {
    logger.error('Could not revoke a paired device:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Peer boards (the other machine on this strip) ────────────
//
// The operator's half of federation, in three routes: point this board at another one, see what
// it is holding, and forget one. `docs/federation.md` is the shape and this is where it is
// reachable from a page.
//
// **`notTheHost` in front of all three, and not a new copy of the rule.** Registering a peer is
// how this board learns to carry a credential to another machine, so a paired device asking this
// board to pair with a third would be a chain nobody approved — and the funnel every other route
// sits behind admits an approved device since #522, which is exactly the caller that must not be
// able to ask for this. The device management routes above are guarded the same way and for the
// same reason.
//
// **Forgetting a peer is this end only.** The secret leaves this machine's file; the device
// record on the other machine is untouched and stays on that operator's list until they revoke
// it. The two registries are independent, and `docs/federation.md` says so out loud because
// assuming otherwise is what leaves a row nobody recognises on a list somebody reads in six
// months.

/**
 * What this board keeps about the machines it has been approved by, and what it will say about
 * each of them right now.
 *
 * Two desks, because they answer two questions and neither should have to know the other's: one
 * runs the gesture that turns an address into a credential, and one holds the last thing each
 * peer said about its projects. Neither is passed a transport, a clock or a writer from here —
 * the defaults are the real ones, and the seams exist so a check can drive the arithmetic
 * without a socket or a file.
 */
const peerStrip = createPeerStrip({ seen: (peerId) => { touchPeer(peerId); } });

const peerAskDesk = createPeerAskDesk({
  // Wrapped rather than passed bare, so that a peer approved a moment ago has its projects on
  // the strip on the next render instead of at the next tick of the timer below.
  record: (peer) => {
    const written = addPeer(peer);
    if (written.ok) refreshPeersSoon();
    return written;
  },
  known: () => listPeers().map((peer) => ({ baseUrl: peer.baseUrl }))
});

/** Every peer, in the shape the strip desk takes one. The secret is carried, never shown. */
function stripPeers(): StripPeer[] {
  return listPeers().map((peer) => ({
    id: peer.id,
    name: peer.name,
    baseUrl: peer.baseUrl,
    secret: peer.secret
  }));
}

/**
 * One peer as a route may answer with it.
 *
 * Built by naming the fields it includes, for `core/remote-workspace-view.ts`'s reason: the one
 * field a `PeerRecord` holds that must never leave this process is the secret, and a projection
 * assembled by spreading the record and deleting a key is a projection that leaks the next
 * secret-shaped field somebody adds.
 */
function peerView(peer: PeerRecord): Record<string, unknown> {
  return {
    id: peer.id,
    name: peer.name,
    baseUrl: peer.baseUrl,
    addedAt: peer.addedAt,
    lastSeenAt: peer.lastSeenAt,
    status: peerStrip.mark({
      id: peer.id, name: peer.name, baseUrl: peer.baseUrl, secret: peer.secret
    })
  };
}

/**
 * The strip, for whoever is asking.
 *
 * Merged for the operator's own page and **not** for a peer. A board asking this one for its
 * projects is asking about *this* machine; handing it back the projects of a third would put a
 * board on its own strip one hop away, under a namespaced id it does not use for itself, and two
 * boards paired both ways would each carry the other's copy of their own tabs.
 *
 * Appended rather than interleaved: the local registry is the order the operator arranged, and
 * where they have arranged one across machines it is `PUT /api/workspaces/order` that says so.
 */
function mergedStrip(local: Workspace[], res: Response): (Workspace | PeerStripEntry)[] {
  if (res.locals.device) return local;
  return [...local, ...peerStrip.entries(stripPeers())];
}

/**
 * The same strip, in the order a caller just asked for.
 *
 * The frontend reconciles optimistically against the list a write answers with, so a merge that
 * came back short would drop a peer's tabs the moment somebody dragged one — the registry this
 * board writes holds only the ids it owns, and the rest of the order has to survive the round
 * trip rather than be rebuilt by the reconcile.
 *
 * Ids the caller did not name keep their own order and go last, which is what a list that grew
 * between the render and the drop should do.
 */
function orderedStrip(
  local: Workspace[],
  res: Response,
  wanted: string[] | null
): (Workspace | PeerStripEntry)[] {
  const rows = mergedStrip(local, res);
  if (!wanted?.length) return rows;
  const at = new Map(wanted.map((id, index) => [id, index]));
  return [...rows].sort((left, right) =>
    (at.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (at.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

/**
 * The probe runs here, on a timer, and never on a request.
 *
 * A page polling the strip must not be what wakes a sleeping peer, and a route that asked its
 * peers when it was asked would spend every sleeping machine's connect budget on the one call the
 * page cannot render without. `checking` exists as a real state precisely so that the first
 * answer after a start is honest rather than a guess.
 *
 * `unref`, so a process with nothing else to do is not held open by this; and a round that is
 * still running is not started again, which `createPeerStrip` already guarantees per peer.
 */
const peerStripTimer = setInterval(() => {
  const peers = stripPeers();
  if (!peers.length) return;
  peerStrip.refresh(peers).catch((error) => {
    logger.debug(`A round of peer probes did not finish: ${(error as Error).message}`);
  });
}, PEER_STRIP_REFRESH_MS);
peerStripTimer.unref();

/** The gesture in flight, asked more often than the strip: an operator is standing at a screen. */
const peerAskTimer = setInterval(() => {
  peerAskDesk.poll().catch((error) => {
    logger.debug(`A pairing attempt did not finish its poll: ${(error as Error).message}`);
  });
}, PEER_ASK_POLL_MS);
peerAskTimer.unref();

/** Ask every peer now rather than at the next tick — an operator has just changed the list. */
function refreshPeersSoon(): void {
  const peers = stripPeers();
  if (!peers.length) return;
  peerStrip.refresh(peers).catch(() => { /* the next tick says the same thing */ });
}

/**
 * Point this board at another one.
 *
 * It answers **the code** and not the peer: what happens next is the operator walking to the
 * other machine and approving the request showing the same six digits. The peer appears on
 * `GET /api/peers` once that machine has approved it, which is the second answer and the reason
 * this is not one blocking call.
 *
 * An address nothing answers on is **registered rather than refused** — `unreachable` is a state
 * and not a rejection, and a machine that is asleep does not refuse a connection, it hangs. What
 * is refused is a string that is not an address at all: that is a typo, and a typo recorded as a
 * state is a row the operator then has to work out how to get rid of.
 */
app.post('/api/peers', async (req: Request, res: Response) => {
  if (notTheHost(req, res, 'A peer board is registered')) return;

  const outcome = await peerAskDesk.ask({
    name: typeof req.body?.name === 'string' ? req.body.name : '',
    baseUrl: typeof req.body?.baseUrl === 'string' ? req.body.baseUrl : '',
    // What the *other* operator sees asking, which is not what this one calls that machine. A
    // caller may say so outright; the machine's own name is what a person at the other keyboard
    // has the best chance of recognising.
    as: typeof req.body?.as === 'string' && req.body.as.trim() ? req.body.as : osHostname()
  });

  if (!outcome.ok) {
    return res.status(outcome.status).json({ success: false, error: outcome.error });
  }

  logger.info(`Asked the board at ${outcome.ask.baseUrl} to pair, as "${outcome.ask.name}": `
    + `${outcome.ask.state}.`);
  // 202: something has been started and there is no peer yet. The code is the whole of what the
  // operator has to act on, and it is in the answer rather than behind a second call.
  res.status(202).json({
    success: true,
    pending: outcome.ask,
    peers: listPeers().map(peerView)
  });
});

/** Which boards approved this one, what each is doing, and what is still being asked. */
app.get('/api/peers', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'Peer boards are listed')) return;
  try {
    res.json({
      success: true,
      peers: listPeers().map(peerView),
      pending: peerAskDesk.pending()
    });
  } catch (error) {
    logger.error('Could not list the peer boards:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * Forget a peer, or give up on an attempt to become one.
 *
 * One route for both because one id names one thing: a peer's id is the one the other machine
 * approved this one under, and an attempt's is this board's own. The secret goes with the peer,
 * out of the file — and the device record on the other machine is untouched, which is the
 * asymmetry `docs/federation.md` states rather than a shortcoming of this route.
 */
app.delete('/api/peers/:id', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'A peer board is forgotten')) return;

  const id = req.params.id ?? '';
  try {
    const held = listPeers().find((peer) => peer.id === id) ?? null;
    if (held && forgetPeer(id)) {
      peerStrip.forget({
        id: held.id, name: held.name, baseUrl: held.baseUrl, secret: held.secret
      });
      return res.json({
        success: true,
        forgotten: { id: held.id, name: held.name, baseUrl: held.baseUrl },
        // Said back rather than left to a document nobody is reading at that moment.
        note: `The secret is gone from ${peerRegistryPath()}. The device record on ${held.name} `
          + 'is untouched and is that operator\'s to revoke.',
        peers: listPeers().map(peerView),
        pending: peerAskDesk.pending()
      });
    }
    if (peerAskDesk.cancel(id)) {
      return res.json({
        success: true,
        cancelled: id,
        peers: listPeers().map(peerView),
        pending: peerAskDesk.pending()
      });
    }
    res.status(404).json({
      success: false,
      error: 'No peer board and no pairing attempt on this board has that id.'
    });
  } catch (error) {
    logger.error('Could not forget a peer board:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Workspaces API (one project per board) ───────────────────

// Every route in this block calls `offLoopback`, declared above the first route of the file.
// Most of them write files this machine owns, and one lists its directories, so reaching them
// from the network would be strictly worse than reaching a route that only reads a project. The
// read below is guarded for the same reason rather than in spite of being a read: it does not
// read *a* project, it reads the map of all of them — every registered project's absolute path,
// and a WSL project's path inside its distro too.
//
// Loaded per request rather than cached at boot: a project's board.config.json gets
// edited while the server runs, and restarting to notice a config change would be silly.
app.get('/api/workspaces', async (_req: Request, res: Response) => {
  if (offLoopback(res, 'Projects are listed')) return;

  try {
    const workspaces = await loadWorkspaces(registryPath());
    res.json({
      success: true,
      // Constant now, and kept rather than dropped because what it says is still worth
      // saying: this board has somewhere to record a project, so registering one will work.
      // It used to mean "`EXCALIDRAW_WORKSPACES` is set", and the page read it as permission
      // to draw the tab strip at all — which hid the `+` on exactly the board that needed it.
      // `registryPath()` cannot answer nothing, so the honest value here is `true`. Whether
      // any project has been *added* is the list below, in the same payload; the boolean that
      // has to be read without one is `/health`'s `workspaces`.
      configured: true,
      workspaces: mergedStrip(workspaces, res)
    });
  } catch (error) {
    logger.error('Failed to load workspaces:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * Add a project to the registry.
 *
 * The registry is re-read per request, so an appended entry is live on the next call with
 * no restart — which is what makes a `+` on the tab strip cheap rather than a feature with
 * a server bounce in the middle of it.
 */
app.post('/api/workspaces', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Projects are added')) return;

  try {
    const result = await addWorkspace(registryPath(), {
      path: typeof req.body?.path === 'string' ? req.body.path : '',
      ...(typeof req.body?.id === 'string' ? { id: req.body.id } : {}),
      ...(typeof req.body?.distro === 'string' ? { distro: req.body.distro } : {})
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    logger.info(`Workspace "${result.workspace.id}" added at ${result.workspace.path}`);
    res.status(201).json({ success: true, workspace: result.workspace, workspaces: result.workspaces });
  } catch (error) {
    logger.error('Failed to add a workspace:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * Take a project off the board.
 *
 * The other half of the `+`, and the thing whose absence made the first mistake a stranger
 * makes permanent: the wrong folder picked, or a project moved after registering, left a tab
 * that `loadWorkspace` marks broken rather than dropping, and the only way out was
 * hand-editing a JSON file whose path the reader has never been told.
 *
 * **It removes a line from the registry, and nothing else.** The project directory is not
 * this board's to delete and neither is its `board.config.json` — which is what the
 * confirmation in the settings dialog promises, in those words.
 *
 * The one thing that is arguably the board's own is the drawing, saved beside the registry
 * and copied nowhere. It is kept, so a project removed by mistake and added back comes back
 * drawn, and `?board=delete` is how a caller who means otherwise says so. An opt-in rather
 * than a side effect, because nothing else has that scene.
 *
 * A run in flight is refused rather than orphaned. The worktree, the branch and the pull
 * request a run is in the middle of all hang off the entry this would delete, and the process
 * writing to them would carry on against a project the board no longer knows: the refusal
 * names the runs so the reader knows what to wait for.
 */
app.delete('/api/workspaces/:id', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Projects are removed')) return;

  const id = req.params.id ?? '';

  // Spelled out rather than "anything that is not `delete` means keep": a typo in the one
  // parameter that decides whether a drawing survives should be an error, not a default.
  const board = typeof req.query.board === 'string' && req.query.board ? req.query.board : 'keep';
  if (board !== 'keep' && board !== 'delete') {
    return res.status(400).json({
      success: false,
      error: `board must be "keep" or "delete", not "${board}". `
        + 'Leaving it out keeps the board this project was drawn on.'
    });
  }

  const inFlight = runningImplements(normalizeWorkspaceId(id));
  if (inFlight.length) {
    return res.status(409).json({
      success: false,
      error: `"${id}" still has ${inFlight.length} implementation(s) running, and removing it now `
        + 'would orphan them: the worktree, the branch and the pull request would outlive the '
        + `project they belong to. In flight: ${inFlight.map((run) => run.issueUrl).join(', ')}`,
      running: inFlight.map((run) => run.issueUrl)
    });
  }

  try {
    const result = await removeWorkspace(registryPath(), id);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    // After the registry write, never before it: a board forgotten on a removal that then
    // failed would stop being saved while its project was still on the strip.
    const dropped = await dropBoardState(result.removed.id, { deleteFile: board === 'delete' });
    logger.info(
      `Workspace "${result.removed.id}" removed from the registry; ${result.removed.path} was left alone`
      + `${dropped.deleted ? `, and its saved board at ${dropped.file} was deleted` : ''}.`
    );
    res.json({
      success: true,
      removed: result.removed,
      workspaces: result.workspaces,
      board: dropped
    });
  } catch (error) {
    logger.error('Failed to remove a workspace:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * The order the tabs are in.
 *
 * Above `/api/workspaces/:id/config` only for readability — the two cannot collide, one
 * being two segments after `/api/workspaces` and the other one. The whole list every time
 * rather than "move this one to position n": a permutation is checked against what the
 * registry holds in a single comparison, while an index is a guess about a list the caller
 * may have been looking at some seconds ago.
 *
 * **The order may span machines and this board writes only its own half.** A strip carrying a
 * peer's projects is one strip, so the list that arrives here names ids no registry on this
 * machine has ever heard of. Dropping them would be the wrong answer twice over: the write would
 * be refused for naming a project that is not registered, and the list it answered with would
 * come back short of the tabs the page is holding. So an id in the peer namespace is passed
 * through — not written, because there is nothing here to write it into, and not refused, because
 * the operator dragging a tab is describing one strip.
 */
app.put('/api/workspaces/order', async (req: Request, res: Response) => {
  if (offLoopback(res, 'The order of the projects is written')) return;

  try {
    const result = await reorderWorkspaces(registryPath(), req.body?.ids, {
      // Named by the namespace rather than by "anything unregistered": a stale client naming a
      // project that has been removed is still the mistake the refusal above exists to catch.
      foreign: isRemoteWorkspaceId
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    const wanted = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : null;
    logger.info(`Workspace order set: ${result.workspaces.map((workspace) => workspace.id).join(', ')}`);
    res.json({ success: true, workspaces: orderedStrip(result.workspaces, res, wanted) });
  } catch (error) {
    logger.error('Failed to reorder the workspaces:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/** A project's config as it is on disk, which is what an editor has to start from. */
app.get('/api/workspaces/:id/config', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Project settings are read')) return;

  try {
    const result = await readWorkspaceConfig(registryPath(), req.params.id ?? '');
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    res.json({ success: true, config: result.config });
  } catch (error) {
    logger.error('Failed to read a workspace config:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.put('/api/workspaces/:id/config', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Project settings are saved')) return;

  try {
    const id = req.params.id ?? '';
    // Resolved before the write, because an `effort` is refused against the backend this
    // project's agent runs under and not against one global list. A project the registry does
    // not know is left to `writeWorkspaceConfig` to report by name; the default it is judged
    // against until then refuses exactly what the board refused before backends existed.
    const workspace = (await loadWorkspaces(registryPath()).catch(() => []))
      .find((candidate) => candidate.id === id);
    const result = await writeWorkspaceConfig(
      registryPath(),
      id,
      req.body?.config,
      workspace ? agentBackendsFor(workspace) : DEFAULT_AGENT_BACKENDS,
      workspace ? agentBackendChoicesFor(workspace) : enabledAgentBackends()
    );
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    res.json({ success: true, workspace: result.workspace, workspaces: result.workspaces });
  } catch (error) {
    logger.error('Failed to write a workspace config:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/** The project picker's other half — see `src/core/directory-browse.ts` for why. */
app.get('/api/fs/directories', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Directories are listed')) return;

  const asked = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const listing = await listDirectories(asked);
    res.json({ success: true, ...listing });
  } catch (error) {
    res.status(400).json({ success: false, error: `Cannot list ${asked || 'the roots'}: ${(error as Error).message}` });
  }
});

// ─── Issue block ──────────────────────────────────────────────
//
// Turns an observation written on the board into a researched GitHub issue by running
// an agent inside the project. This is the most dangerous thing the server does: it
// spawns a process with full repository access. Hence three guards — opt-in by env var,
// loopback only, and one run per element. They outlive the token #350 put in front of every
// route, because that token is a file this account can read: it shuts out another account and
// says nothing about a process already running as this one.
//
// Two commands rather than one, because a workspace may live in a WSL distro and a command
// is a path: the host's `claude.exe` is `No such file or directory` inside a distro, and the
// distro's `claude` is nowhere on the host. `agentCommandFor` picks per workspace and falls
// back to the native one, which is what keeps a command written without an absolute path
// working in both.
//
// Each half carries the backend it runs under as well as the command, and both come from
// `agentGrantsFromEnv`: `EXCALIDRAW_AGENT_BACKEND` names the agent, the adapter supplies its
// binary, its permission posture and its stream flags, and the two command variables below stay
// exactly what they were — the `raw` backend, an arbitrary command line spawned byte for byte,
// which is what every board configured before backends existed has. `core/agent-backend.ts` is
// where the three keys are read and `core/agents/` is where the backends live.
const ISSUE_AGENT_GRANTS: AgentGrants = agentGrantsFromEnv('issue');
const ISSUE_AGENT_COMMANDS: AgentCommands = agentCommandsOf(ISSUE_AGENT_GRANTS);

/** Whether any board at all may research. A workspace's own answer comes later. */
const ISSUE_AGENT_CONFIGURED = Boolean(ISSUE_AGENT_COMMANDS.native || ISSUE_AGENT_COMMANDS.wsl);

/**
 * The command a workspace's agent runs, or a refusal saying which variable would grant one.
 *
 * Per workspace rather than per server, because being enabled is now a fact about the pair:
 * a board with only `_WSL` set can research a distro-backed project and not a native one,
 * and the reverse. Naming the variable that is missing is the whole value of refusing here
 * rather than letting a run start and exit 127 somewhere the reader cannot see.
 */
function agentCommandRefusal(
  workspace: Workspace,
  commands: AgentCommands,
  what: string,
  variable: string
): string | null {
  if (agentCommandFor(workspace, commands)) return null;

  const where = workspace.environment.kind === 'wsl'
    ? { wanted: `${variable}_WSL or ${variable}`, names: `the WSL distro "${workspace.environment.distro}" names it` }
    : { wanted: variable, names: 'this machine names it' };
  // The backend variable first, because it is the answer for a board that has an agent
  // installed and no command line anywhere — which is every first run.
  return `${what} is not enabled for workspace "${workspace.id}". `
    + `Set ${settingName('AGENT_BACKEND')} to one of ${KNOWN_BACKEND_NAMES}, `
    + `or ${where.wanted} to the agent command as ${where.names}.`;
}

/**
 * The spec a run is spawned from, or a refusal written to the response.
 *
 * `grants` rather than `commands`, because a project may have picked one of the backends the
 * operator enabled and the command that reaches its binary travels with the backend. The
 * refusal is still asked of `commands`: what it is answering is "did this board grant this
 * role anything at all", which is a question about the operator and not about the project.
 */
function agentCommandOrRefuse(
  res: Response,
  workspace: Workspace,
  grants: AgentGrants,
  role: 'issue' | 'implement',
  what: string,
  variable: string
): AgentCommandSpec | null {
  const commands = agentCommandsOf(grants);
  const refusal = agentCommandRefusal(workspace, commands, what, variable);
  if (!refusal) return agentGrantFor(workspace, grants, role);
  res.status(404).json({ success: false, error: refusal });
  return null;
}

/**
 * What a block's research run has done, kept in memory beside the block that started it.
 *
 * This was a bare `Set<string>` — the guard that stops a second click opening a second issue,
 * and nothing else. A set can say *that* a run is in flight and never anything about it, which
 * is why a running block's panel had one fixed sentence to show for however long the
 * investigation took. It is a map now for the one fact that cannot go on the element: the
 * token totals change throughout a run, so writing them onto a shape would bump its `version`
 * and broadcast an update every time — the churn `docs/trap-export-noise.md` covers, arriving
 * through the other door. The two instants *do* go on the element, because they are written
 * once each and a block has to read correctly with nothing selected and no network.
 *
 * **The record outlives the run**, deliberately, the way `ImplementRecord` and `recreateRuns`
 * do. The panel's last read happens after the run settles — the ending arrives over the socket
 * as an element update, which carries the state and not the figures — so a record deleted at
 * the end would lose the total at exactly the moment it became worth reading. The reset route
 * is what clears one.
 */
interface IssueRunRecord {
  /** `running` until the run settles, then whichever state the block was left in. */
  state: 'running' | 'created' | 'failed';
  startedAt: string;
  /** Null while it is still going, which is what makes the clock live rather than a total. */
  endedAt: string | null;
  /**
   * What the run has spent, when the agent is willing to say.
   *
   * Null is the normal case and not a failure: it means the configured command does not ask
   * its agent for a machine-readable stream. See `src/core/agent-usage.ts`.
   */
  usage: AgentUsage | null;
}

/** The research runs, by element id. A second click must not open a second issue. */
const issueRuns = new Map<string, IssueRunRecord>();

/**
 * Whether a run is in flight *in this process*, which is what every guard here asks.
 *
 * Not "is there a record": a settled record is kept so the panel can read the total one last
 * time, and reading `has()` against this map would refuse a block a second run for the rest of
 * the server's life.
 */
const issueRunInFlight = (elementId: string): boolean =>
  issueRuns.get(elementId)?.state === 'running';

/**
 * Token counts onto the record, and nowhere else.
 *
 * The research-side twin of `recordImplementUsage`, and ignored once the run has settled for
 * the same reason: a report can still be in flight when the process closes, and it must not
 * resurrect a finished record.
 */
function recordIssueUsage(elementId: string, usage: AgentUsage): void {
  const existing = issueRuns.get(elementId);
  if (!existing || existing.state !== 'running') return;
  issueRuns.set(elementId, { ...existing, usage });
}

/**
 * Write the state onto a block, and the look that goes with it.
 *
 * Here rather than in the browser because this is where the state is authored: the
 * appearance then persists, exports and reaches every connected tab through the update
 * that already carries the state. A browser deriving it on render would have to derive it
 * again on every path that draws a block, and a block saved to `docs/board.excalidraw`
 * would go back to looking like a draft.
 *
 * At module level rather than inside the run, because the run is no longer the only writer:
 * a block that lost its state is put back with the same two writes, through
 * `applyIssueToBlock` below.
 */
function markIssueState(
  workspaceId: string,
  elementId: string,
  state: string,
  extra: Record<string, unknown> = {}
): void {
  const store = elementsFor(workspaceId);
  const current = store.get(elementId);
  if (!current) return;
  const updated: ServerElement = {
    ...current,
    ...issueBlockAppearance(state),
    customData: { ...(current.customData ?? {}), issueState: state, ...extra },
    updatedAt: new Date().toISOString(),
    version: (current.version || 0) + 1
  };
  store.set(elementId, updated);
  broadcast({ type: 'element_updated', element: updated } as ElementUpdatedMessage, workspaceId);
}

/**
 * Record on a block the issue it stands for: the state, the URL, the title, the look.
 *
 * Only the title is written onto `customData`, not the label alone: wrapping text to a box
 * and refitting the box needs font metrics, and the server has none. Writing the label here
 * produced a 518px title inside a 400px block, on one line, in a box still sized for the
 * observation. The browser owns geometry — it reads `issueTitle` and relays the block itself.
 *
 * The observation is kept rather than discarded: it is the wording that produced this
 * particular issue, and the panel still shows it.
 *
 * Best-effort by design where a run calls it: the issue is already created by the time this
 * runs, so a failure here must not turn a successful run into a failed block.
 */
async function applyIssueToBlock(
  workspace: Workspace,
  workspaceId: string,
  elementId: string,
  issueUrl: string,
  observation: string
): Promise<void> {
  const store = elementsFor(workspaceId);
  const detail = await fetchIssue(workspace, issueUrl);
  if (!detail.title) return;

  markIssueState(workspaceId, elementId, 'created', {
    issueUrl,
    issueError: null,
    issueTitle: detail.title,
    observation
  });

  const label = Array.from(store.values()).find(
    (candidate) => candidate.type === 'text'
      && (candidate as ServerElement & { containerId?: string }).containerId === elementId
  );
  const container = store.get(elementId);
  if (!label || !container) return;

  // Lay the title out rather than just writing it. Excalidraw wraps bound text and
  // refits its container in redrawTextBoundingBox, which runs on its own edit paths —
  // never on an element that arrives from outside. Writing the text alone left a title
  // wider than its box, on one line, in a box still sized for the observation.
  // Excalidraw draws bound text at 20 when the element carries no size of its own, and
  // laying the title out for 16 produced a box too short for the text and a wrap that
  // came too late. The size is written back below rather than merely assumed, so the
  // browser and this calculation use the same number by construction — matching a
  // default this code does not own would only hold until that default moved.
  const fontSize = typeof label.fontSize === 'number' ? label.fontSize : DEFAULT_BOUND_TEXT_FONT_SIZE;
  const containerWidth = typeof container.width === 'number' ? container.width : 400;
  const laid = layoutLabel(detail.title, containerWidth, fontSize);

  const containerHeight = Math.max(laid.containerHeight, fontSize * 2);
  const updatedContainer: ServerElement = {
    ...container,
    height: containerHeight,
    updatedAt: new Date().toISOString(),
    version: (container.version || 0) + 1
  };
  store.set(elementId, updatedContainer);
  broadcast({ type: 'element_updated', element: updatedContainer } as ElementUpdatedMessage, workspaceId);

  const updatedLabel: ServerElement = {
    ...label,
    text: laid.text,
    fontSize,
    width: laid.width,
    height: laid.height,
    // Centred in the container, the way Excalidraw centres bound text itself.
    x: (updatedContainer.x ?? 0) + (containerWidth - laid.width) / 2,
    y: (updatedContainer.y ?? 0) + (containerHeight - laid.height) / 2,
    updatedAt: new Date().toISOString(),
    version: (label.version || 0) + 1
  };
  store.set(updatedLabel.id, updatedLabel);
  broadcast({ type: 'element_updated', element: updatedLabel } as ElementUpdatedMessage, workspaceId);
}

app.post('/api/issue-block/:id', async (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';

  if (!ISSUE_AGENT_CONFIGURED) {
    return res.status(404).json({
      success: false,
      error: `Issue blocks are disabled. Set ${settingName('AGENT_BACKEND')} to one of ${KNOWN_BACKEND_NAMES}, or ${settingName('ISSUE_AGENT')} to the agent command, to enable them.`
    });
  }

  // Running an agent is remote code execution for anyone who can reach this port.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'Issue blocks only run while the server is bound to loopback.'
    });
  }

  const workspaceId = workspaceIdFrom(req);
  const store = elementsFor(workspaceId);
  const element = store.get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  if (custom.issueUrl) {
    return res.status(409).json({
      success: false,
      error: 'This block already has an issue.',
      issueUrl: custom.issueUrl
    });
  }
  if (issueRunInFlight(elementId)) {
    return res.status(409).json({ success: false, error: 'A run is already in flight for this block.' });
  }

  // A shape's label is a separate element bound to it, so reading element.text alone
  // would find nothing for the normal way of writing inside a box.
  const boundText = Array.from(store.values()).find(
    (candidate) => candidate.type === 'text' &&
      (candidate as ServerElement & { containerId?: string }).containerId === elementId
  );
  const observation = typeof req.body?.observation === 'string' && req.body.observation.trim()
    ? req.body.observation.trim()
    : [element.text, boundText?.text]
        .find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
  if (!observation) {
    return res.status(400).json({ success: false, error: 'The block has no observation to work from.' });
  }

  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return res.status(400).json({
      success: false,
      error: `Workspace "${workspaceId}" is not registered, so there is no project to run in.`
    });
  }
  if (workspace.error) {
    return res.status(400).json({ success: false, error: `Workspace is unusable: ${workspace.error}` });
  }

  /**
   * Where the issue would be created — and a refusal, on the block, when there is nowhere.
   *
   * Writing an observation down is the part that has to work before GitHub is connected, and
   * since #316 it does: the notes column and its `+` are the canvas's own and need no project.
   * Turning one into an issue is not. The agent is told to create it "with `gh` in this
   * repository", so a project with no repository at all sends a coding agent off to spend
   * minutes discovering that — a run that looks exactly like a working one until it fails with
   * whatever `gh` said. Refused here instead, before the spawn, which is the decision #316
   * records: refuse at the run rather than at the `+`.
   *
   * `repo` in `board.config.json` first and the `origin` remote second, the way
   * `interruptedRuns` already resolves it: a checkout that has a GitHub remote has told us
   * where its issues go, and asking it to repeat that in a config file would refuse a project
   * that works. A remote that is not on `github.com` names itself in the refusal rather than
   * being reported as no remote at all — #322's rule, and the case where the reader is looking
   * at an `origin` and being told there is none.
   *
   * The reason goes onto the block as well as into the response. The panel showing it is one
   * selection away from being closed, and the block is what the reader comes back to.
   */
  const origin = await originRemote(workspace);
  const repo = workspace.repo || origin.repo;
  if (!repo) {
    const reason = 'This project has no GitHub repository to create the issue in'
      + (origin.url
        ? ` — its "origin" is ${origin.url}, which is not a ${GITHUB_HOST} remote. `
          + `This board only opens issues on ${GITHUB_HOST}. `
        : `. Set "repo" in board.config.json, or add a ${GITHUB_HOST} "origin" remote. `)
      + 'The observation is kept either way.';
    markIssueState(workspaceId, elementId, 'failed', { issueError: reason });
    logger.warn(`Issue block ${elementId} refused: workspace "${workspaceId}" names no repository`);
    return res.status(400).json({ success: false, error: reason });
  }

  const agent = agentCommandOrRefuse(
    res, workspace, ISSUE_AGENT_GRANTS, 'issue', 'Researching', settingName('ISSUE_AGENT')
  );
  if (!agent) return;

  const startedAt = new Date().toISOString();
  issueRuns.set(elementId, { state: 'running', startedAt, endedAt: null, usage: null });
  const markState = (state: string, extra: Record<string, unknown> = {}) =>
    markIssueState(workspaceId, elementId, state, extra);

  /**
   * The end of the run, written to the record and the block in one place.
   *
   * One function rather than an `issueEndedAt` beside each of the three `markState` calls
   * below, because the ending is what the clock is subtracting against: a path that settled a
   * block and forgot the instant would leave a total ticking forever, and that is precisely
   * the failure a reader cannot see. `issueStartedAt` needs no carrying — `markIssueState`
   * merges onto the `customData` already there.
   */
  const settle = (state: 'created' | 'failed', extra: Record<string, unknown> = {}): void => {
    const endedAt = new Date().toISOString();
    const existing = issueRuns.get(elementId);
    if (existing) issueRuns.set(elementId, { ...existing, state, endedAt });
    markState(state, { ...extra, issueEndedAt: endedAt });
  };

  // Two instants, not a duration: a duration kept here would have to be rewritten to stay
  // true, and every rewrite bumps the element's `version` and broadcasts it. The browser
  // subtracts instead, and the board never knows the clock is running.
  markState('running', { issueStartedAt: startedAt, issueEndedAt: null });
  // Answer immediately: an investigation takes minutes, and a request held open that
  // long looks indistinguishable from a hang. Progress arrives over the socket.
  res.status(202).json({ success: true, state: 'running', elementId });

  let images: MaterializedImages = NO_IMAGES;
  try {
    // The images are written before the spawn and removed in the `finally` below, on the
    // failure path as much as on the success one — they exist only while the run does.
    // A failure to write them is not a failure of the run: the observation is still worth
    // investigating, and an image is not worth the investigation.
    try {
      images = await materializeIssueImages(
        workspace,
        issueImageIds(element.customData),
        (fileId) => files.get(fileId),
        elementId
      );
    } catch (error) {
      logger.warn(`Issue block ${elementId}: could not prepare reference images — ${(error as Error).message}`);
    }

    const result = await runIssueAgent(workspace, observation, {
      agent,
      imagePaths: images.paths,
      notFoundVariable: settingName('ISSUE_AGENT_WSL'),
      onUsage: (usage) => recordIssueUsage(elementId, usage)
    });
    if (result.ok && result.issueUrl) {
      settle('created', { issueUrl: result.issueUrl, issueError: null, observation });
      logger.info(`Issue block ${elementId} created ${result.issueUrl}`);

      // The issue exists now, so it no longer belongs where the observation was written —
      // the notes column, which the canvas draws for itself and which no project item can
      // be in. The issue the agent created is on the project, in whichever column its
      // *Item added to project* workflow put it; that decision is made outside this
      // repository and cannot be read back, so this move is what makes the landing column
      // something we know rather than something we hope for.
      //
      // Deliberately not awaited and never fatal, exactly as for the In Progress move: the
      // issue is already created by the time this runs, and a `gh` working through its
      // retries must not hold the block in `running`. A failed board write costs a log line.
      // A run that created *no* issue reaches the branch below instead and moves nothing —
      // there is nothing to move, and the draft is deliberately kept.
      void moveIssueToColumn(workspace, result.issueUrl, todoColumn(workspace))
        .then((column) => { if (column) logger.info(`${result.issueUrl} was researched, so its card moved to "${column}"`); })
        .catch((error) => logger.warn(
          `Could not move ${result.issueUrl} on the project board: ${(error as Error).message}`
        ));

      try {
        await applyIssueToBlock(workspace, workspaceId, elementId, result.issueUrl, observation);
      } catch (error) {
        logger.warn(`Issue block ${elementId}: could not read back the issue — ${(error as Error).message}`);
      }
    } else {
      settle('failed', { issueError: result.error });
      logger.warn(`Issue block ${elementId} failed: ${result.error}`);
    }
  } catch (error) {
    settle('failed', { issueError: (error as Error).message });
  } finally {
    await images.cleanup();
  }
});

/**
 * What a block's research run has done so far, with no `gh` behind it.
 *
 * Its own route rather than an extension of `GET /api/issue-block/:id/issue`, which is the
 * question the panel is *not* asking here: that one reads the issue from GitHub and answers 404
 * for a block that has none — which is every block with a run in flight. This reads memory and
 * costs nothing, so the panel can poll it while a run is live the way it polls the implement
 * record.
 *
 * The clock is deliberately not the reason to call it. Both instants are on the element, so a
 * block already reads correctly with nothing selected and no network; what only lives here is
 * the token total, because a figure that changes throughout a run cannot go on a shape without
 * broadcasting an update every time it does.
 *
 * Behind the funnel like everything else under `/api`, since #508/#518. That it reads memory
 * rather than shelling out to `gh` was the reasoning it was written with, and it is not the
 * question the guard asks: what a stranger gets here is what this machine's agents have been
 * doing with this machine's repository, which is not less of a publication for having cost no
 * subprocess.
 */
app.get('/api/issue-block/:id/run', (req: Request, res: Response) => {
  if (offLoopback(res, 'A research run is read')) return;

  res.json({ success: true, run: issueRuns.get(req.params.id ?? '') ?? null });
});

/**
 * Tell a block which issue it already produced.
 *
 * The way back from #118. A block whose state was overwritten by a browser sync carries no
 * `issueState` and no `issueUrl`, and nothing else in this file can touch it: `DELETE`
 * resets a `running` block and this one is not running, and `POST` would start a **second**
 * research run for an issue that already exists, because the guard that refuses one reads
 * `issueUrl`. Deleting the block by hand was the only answer, and it throws away the
 * observation with it.
 *
 * So the block is told the answer instead. It is the same two writes the end of a successful
 * run makes — `applyIssueToBlock` — and therefore leaves a block indistinguishable from one
 * whose run was recorded properly: `reconcileDrafts` can retire it, the panel renders the
 * issue, and `POST` refuses it a second run.
 *
 * **It does not create anything.** The URL names an issue that already exists; the route
 * reads it and refuses if `gh` cannot. That is what keeps this from being a way to write an
 * arbitrary URL onto a block and have the board believe it.
 *
 * Guarded like the read route rather than like the run route: it starts no agent and touches
 * no repository, but it does shell out to `gh` holding your credentials, so loopback only.
 */
app.post('/api/issue-block/:id/adopt', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Adopting an issue')) return;

  const elementId = req.params.id ?? '';
  const workspaceId = workspaceIdFrom(req);
  const store = elementsFor(workspaceId);
  const element = store.get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  if (custom.kind !== 'issue') {
    return res.status(400).json({ success: false, error: 'That shape is not an issue block.' });
  }
  // A block that already knows its issue has nothing to adopt, and quietly pointing one at a
  // different issue would lose the first without saying so.
  if (custom.issueUrl) {
    return res.status(409).json({
      success: false,
      error: 'This block already has an issue.',
      issueUrl: custom.issueUrl
    });
  }
  if (issueRunInFlight(elementId)) {
    return res.status(409).json({
      success: false,
      error: 'A run is in flight for this block right now. Wait for it rather than guessing its answer.'
    });
  }

  const issueUrl = typeof req.body?.issueUrl === 'string' ? req.body.issueUrl.trim() : '';
  if (!isIssueUrl(issueUrl)) {
    return res.status(400).json({
      success: false,
      // The same sentence the other four take, since #322: one refusal, naming the host it
      // requires, wherever an issue URL is typed rather than clicked.
      error: issueUrlRefusal(issueUrl)
    });
  }

  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return res.status(400).json({
      success: false,
      error: `Workspace "${workspaceId}" is not registered, so there is no project to read the issue in.`
    });
  }

  // The observation is whatever the block still says, the way the run reads it — the text is
  // about to be replaced by the issue's title, so this is the last moment it can be kept.
  const boundText = Array.from(store.values()).find(
    (candidate) => candidate.type === 'text' &&
      (candidate as ServerElement & { containerId?: string }).containerId === elementId
  );
  const observation = typeof custom.observation === 'string' && custom.observation.trim()
    ? custom.observation.trim()
    : [element.text, boundText?.text]
        .find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';

  try {
    await applyIssueToBlock(workspace, workspaceId, elementId, issueUrl, observation);
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: `Could not read ${issueUrl}: ${(error as Error).message}`
    });
  }

  const adopted = (store.get(elementId)?.customData ?? {}) as Record<string, unknown>;
  if (!adopted.issueUrl) {
    // `applyIssueToBlock` writes nothing for an issue with no title, which is what a `gh`
    // that answered about something else looks like. Saying so beats a silent 200.
    return res.status(502).json({
      success: false,
      error: `${issueUrl} came back without a title, so nothing was written onto the block.`
    });
  }
  res.json({ success: true, issueUrl, issueTitle: adopted.issueTitle ?? null, elementId });
});

/**
 * Clear a stuck `running` state so the block can be tried again.
 *
 * A run has no ceiling any more, so nothing kills a wedged agent and nothing else ever
 * clears that state — and a block left in it is dead: the panel hides the create control
 * there. This is the way back, and the implement path's opposite number (`DELETE
 * .../implement`), for the same reason and with the same honesty about what it does.
 *
 * It clears state; it does not stop an agent. Nothing here can reach into a process the
 * server no longer owns. What it can do is refuse while a run is in flight *in this
 * process*, which is the case that matters: `issueRuns` is in memory, so after a
 * restart it is empty while the element still carries `running` from browser sync — only
 * the server can tell a live run from an abandoned one.
 *
 * The issue itself is untouched, which is what stops a reset becoming a second issue for
 * one observation: `POST` guards on `customData.issueUrl`, and that stays.
 */
app.delete('/api/issue-block/:id', (req: Request, res: Response) => {
  // Behind the funnel like the other reset, and it was not — it has been answering a caller on
  // the network for as long as it has existed, and nothing said so. #518 guarded the two resets
  // it could see; this one was invisible to `scripts/check-guarded-routes-documented.mjs`,
  // which reads a route's body as everything up to the next `app.<method>` declaration and
  // found `implementingRefused`'s bind test eighteen hundred lines below, in a slice that is
  // not this route at all. #522 moved that test off the bind, the borrowed guard went with it,
  // and the classifier said `open` about a route that writes to a block on somebody's board.
  if (offLoopback(res, 'An issue block\'s run is reset')) return;

  const elementId = req.params.id ?? '';
  const workspaceId = workspaceIdFrom(req);
  const store = elementsFor(workspaceId);
  const element = store.get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  if (issueRunInFlight(elementId)) {
    return res.status(409).json({
      success: false,
      error: 'A run is in flight for this block right now. Resetting would only hide it.'
    });
  }

  // The run is being declared lost, so what it claimed about itself goes with the state: a
  // block left carrying the instants would keep showing a clock for a run nobody is waiting
  // for, and the record behind it would keep answering the panel's poll.
  issueRuns.delete(elementId);
  const {
    issueState, issueError, issueStartedAt, issueEndedAt, ...rest
  } = (element.customData ?? {}) as Record<string, unknown>;
  const resetTo = rest.issueUrl ? 'created' : 'draft';
  const updated: ServerElement = {
    ...element,
    // The look goes back with the state. This route is the other writer of `issueState`,
    // so a block reset here would otherwise keep whatever the stuck run had painted on it.
    ...issueBlockAppearance(resetTo),
    // A block that already produced an issue is `created`, whatever the stuck state said.
    // Dropping the state outright would send that card back to offering a run the POST
    // route would then refuse.
    customData: rest.issueUrl ? { ...rest, issueState: 'created' } : rest,
    updatedAt: new Date().toISOString(),
    version: (element.version || 0) + 1
  };
  store.set(elementId, updated);
  broadcast({ type: 'element_updated', element: updated } as ElementUpdatedMessage, workspaceId);

  logger.info(`Issue block ${elementId} reset from "${issueState ?? 'no state'}"`
    + `${issueError ? ', and its error cleared' : ''}`);
  res.json({ success: true, elementId });
});

/**
 * Issues read recently enough to hand back without spawning another `gh`.
 *
 * Selecting a block used to cost a whole `gh issue view`, every time, for text that had not
 * changed — and the panel drew its controls from "not read yet" for the whole of that
 * second. The panel remembers what it read too; this is the half that means a burst of
 * clicks, or two tabs open on one board, still only asks GitHub once.
 *
 * Only the issue is memoised. The implement record is read fresh on every request, because
 * it costs nothing to read and is the fact most likely to have changed since.
 */
const issueMemo = new IssueMemo<IssueDetail>(memoWindow(env('ISSUE_MEMO_MS')));

// ─── Implementing an issue ────────────────────────────────────
//
// The issue block's opposite number, and its opposite in permissions. The issue agent is
// deliberately powerless — gh, git and reading, nothing that writes. An agent that
// implements has to write code, so it gets its own command and its own opt-in: enabling
// issue blocks must not quietly enable repository writes. That separation is why the WSL
// half is a pair rather than one variable: a board that granted a distro an agent for
// research must not thereby have granted it one that writes.
const IMPLEMENT_AGENT_GRANTS: AgentGrants = agentGrantsFromEnv('implement');
const IMPLEMENT_AGENT_COMMANDS: AgentCommands = agentCommandsOf(IMPLEMENT_AGENT_GRANTS);

/** Whether any board at all may implement. A workspace's own answer comes later. */
const IMPLEMENT_AGENT_CONFIGURED = Boolean(
  IMPLEMENT_AGENT_COMMANDS.native || IMPLEMENT_AGENT_COMMANDS.wsl
);

/**
 * Which backend each of one project's two agents will actually be run under.
 *
 * Read per workspace rather than per server, for the reason `agentCommandFor` gives: a project
 * inside a WSL distro may have been granted a different agent from a native one, so the pair is
 * a fact about the project and not about the board. It is asked when a project's settings are
 * saved, because a reasoning effort is the backend's own vocabulary and the write path has to
 * refuse a level *this* project's agent could not be handed.
 *
 * The board's own answer, deliberately, not the project's pick: this is what a project that
 * names no backend of its own runs, and what the settings dialog judges against when the patch
 * in front of it names none either. A patch that *does* name one is judged against that —
 * `validateWorkspaceConfigPatch` reads it before it reads anything else.
 */
function agentBackendsFor(workspace: Workspace): AgentBackends {
  return {
    issue: agentCommandFor(workspace, ISSUE_AGENT_COMMANDS)?.backend ?? DEFAULT_AGENT_BACKEND,
    implement: agentCommandFor(workspace, IMPLEMENT_AGENT_COMMANDS)?.backend ?? DEFAULT_AGENT_BACKEND,
  };
}

/** The backends a project in this environment may name for itself, and no others. */
function agentBackendChoicesFor(workspace: Workspace) {
  return enabledAgentBackends(workspace.environment.kind === 'wsl' ? 'wsl' : 'native');
}

// ─── Do the agents actually run? ──────────────────────────────
//
// Both of the flags above mean only that a string is non-empty, and for a long time that was
// all `/health` could say about the most quietly broken thing on the board. `core/agent-
// preflight.ts` is the answer: it runs argv[0] of each configured command with `--version`,
// per role and per environment, and what comes back is a line at startup and the `agents`
// field below. See that module for why the command is not re-run whole and why nothing that
// reaches the wire carries it.
const AGENT_ROLES: AgentRoleCommands[] = agentRoles({
  issue: ISSUE_AGENT_COMMANDS,
  implement: IMPLEMENT_AGENT_COMMANDS,
});

/**
 * What `/health` says about the agents, replaced once when the probes land.
 *
 * A value rather than a promise, and read synchronously, because `/health` is what `stop`,
 * auto-start and the restart supervisor all wait on: a route that awaited a `wsl.exe` round
 * trip would make a slow distro into a board that looks like it never came up. Until the
 * probes finish this says `probing`, which is true.
 */
let AGENT_PREFLIGHT: AgentsHealth = initialAgents(AGENT_ROLES);

/**
 * Ask, once, at startup — after `listen`, and never awaited by anything.
 *
 * The registry is read for one thing only: a project inside a distro, which is the only
 * environment a WSL command can be tried in. A board with none pays nothing, which is most of
 * them. Failures here are statuses rather than exceptions, so the whole of this is wrapped
 * once: a preflight that could stop the board coming up would be worse than the silence it
 * replaces.
 */
async function runAgentPreflight(): Promise<void> {
  // Said once, here, rather than inside the parser: a value that names nothing leaves the board
  // with no agent at all, and every other symptom of that — no buttons, a run that never starts
  // — reads as something else entirely. `parseAgentBackends` drops what it cannot read silently
  // because it is called on every registry load; this is the one call that happens once.
  for (const variable of ['AGENT_BACKEND', 'AGENT_BACKEND_WSL'] as const) {
    const written = env(variable)?.trim();
    if (written && parseAgentBackends(written).length === 0) {
      logger.warn(`${settingName(variable)}="${written}" names no backend this board knows. `
        + `The names are ${KNOWN_BACKEND_NAMES}; nothing was enabled by it.`);
    }
  }

  try {
    // `registryPath()` rather than the raw variable, since #399: the registry has a per-OS
    // default now, and a board whose only projects come from that default has projects like
    // any other — including one inside a distro, which is the whole reason this reads it.
    const workspaces = await loadWorkspaces(registryPath()).catch(() => []);
    const wslWorkspace = workspaces.find(
      (workspace) => workspace.environment.kind === 'wsl' && !workspace.error
    ) ?? null;

    AGENT_PREFLIGHT = await preflightAgents({ roles: AGENT_ROLES, wslWorkspace });

    for (const line of preflightLines(AGENT_PREFLIGHT, AGENT_ROLES)) {
      if (line.level === 'warn') logger.warn(line.message);
      else logger.info(line.message);
    }
  } catch (error) {
    logger.warn(`Agent preflight could not run: ${(error as Error).message}`);
  }
}

// ─── Is `gh` there, and is it logged in? ──────────────────────
//
// The same question one layer over, about the one binary every GitHub feature on this board
// goes through. It fails as quietly as the agents do and in more ways: not installed, not
// logged in, a token without the `project` scope, a project the account cannot see — and
// until #317 all four arrived on the canvas as the same blank corner. `core/github-status.ts`
// is where the two commands are run and what their output is allowed to say.

/**
 * What `/health` says about `gh`, replaced once when the probe lands.
 *
 * A value read synchronously, for exactly the reason `AGENT_PREFLIGHT` is: `/health` is what
 * `stop`, auto-start and the restart supervisor wait on, and a route that awaited a `gh` that
 * reaches the network would turn a slow morning into a board that looks like it never came up.
 * Until the probe finishes this says `probing`, which is true.
 *
 * The host's own `gh`, not any one board's: this field describes the machine, and a server
 * with no projects registered at all still has an answer to give. The per-workspace answer —
 * which is the one a distro-backed project needs — is `GET /api/github-status`.
 */
let GH_PREFLIGHT: GithubHealth = initialGithub();

/** Ask, once, at startup — after `listen`, and never awaited by anything. */
async function runGithubPreflight(): Promise<void> {
  try {
    const status = await readGithubStatus(null);
    GH_PREFLIGHT = githubHealth(status);
    const line = githubPreflightLine(status);
    if (line.level === 'warn') logger.warn(line.message);
    else logger.info(line.message);
  } catch (error) {
    logger.warn(`GitHub preflight could not run: ${(error as Error).message}`);
  }
}

/**
 * One `gh` interrogation per workspace, behind the same memo the issue reads use.
 *
 * The window matters here more than it does there. The canvas asks this on a *failing* poll,
 * and a poll comes round every twenty seconds — so without a memo a board whose `gh` is broken
 * would spawn two more processes every twenty seconds forever, to be told the same thing.
 *
 * `IssueMemo` unchanged rather than a second cache: it is already generic, already keyed by
 * workspace, and already drops failures instead of remembering them, which is the property
 * that matters when the thing being remembered is a `gh` that fails intermittently at connect.
 * The second half of its key is a constant here — there is one status per workspace.
 */
const GH_STATUS_KEY = 'gh-status';
const ghStatusMemo = new IssueMemo<GithubStatus>(
  memoWindow(env('GH_STATUS_MEMO_MS'))
);

/**
 * And the same for "can this account push", which every run start now asks.
 *
 * A second instance rather than a second setting: the two answers have different types, but
 * they are the same *question* — one `gh` interrogation about this workspace, worth reusing for
 * a few seconds and worth nothing after that. So it shares `GH_STATUS_MEMO_MS` and holds the
 * property that matters most here, which is `IssueMemo`'s joining of reads already in flight:
 * the queue starts runs in a loop, and four starts in one pass are one `gh repo view`.
 *
 * `readPushAccess` never rejects, so unlike a status read this memo also remembers "nobody
 * could say" — which is the answer a board with no `gh` at all gives, on every card, for ever.
 * Remembering it is what keeps that board from spawning a doomed process per start.
 */
const GH_PUSH_KEY = 'gh-push';
const ghPushMemo = new IssueMemo<PushAccess>(
  memoWindow(env('GH_STATUS_MEMO_MS'))
);

// ─── Blockers only a person can clear ─────────────────────────
//
// Ten human blockers were being detected and then merely refused, and `core/founder-blockers.ts`
// named every one of them. This is the wiring: the four places this server learns of one, the
// pass that closes them again, and nothing else. Every rule about what a card may *say* lives in
// `core/founder-action-text.ts` and is enforced at the write, so nothing here composes prose.

/**
 * How often the board looks for these on its own, and closes the ones that have gone.
 *
 * Minutes rather than seconds, and that is the whole of the cost argument: a pass spawns one
 * `gh --version` and one `gh auth status` per project, and a board that is perfectly well pays
 * for them for ever. Five minutes is fast enough that a founder who has just run `gh auth login`
 * in a terminal sees the card close while they are still looking at the board, and slow enough
 * that a healthy board makes two processes per project per five minutes.
 *
 * `0` turns the pass off. What a *refusal* notices is unaffected by it — those producers run on
 * the request that was refused, not on a timer.
 */
const FOUNDER_PASS_MS = (() => {
  const configured = env('FOUNDER_PASS_MS');
  if (configured === undefined || configured.trim() === '') return 300_000;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300_000;
})();

/**
 * Publish one newly recorded action, on the same terms as the two automatic card moves.
 *
 * **The opt-in is not read here, and that is the reconciliation.** This issue was written
 * expecting to gate publication itself; #540 landed while it was being built and settled the
 * policy one layer down, where it belongs — `publishFounderAction` reads the workspace's
 * `projectFounderPublishOff` suppression, refuses a board with no project before spawning
 * anything, and warns by name for a project with no founder column. A second switch here would
 * be a second answer to one question, and the two would drift. So what is left of this issue's
 * half is the call.
 *
 * Not awaited and never fatal, exactly as for the In Progress and Todo moves: the store is the
 * record and GitHub is a projection of it, so a publication that fails costs a log line and
 * leaves the card where a person can read it. A workspace is needed at all — the host-level
 * pass has none, and a board nobody registered has no project to publish to either way.
 *
 * **One at a time per card, and that set is load-bearing.** The caller retries an unpublished
 * record on every sighting, because a publication is one `gh` against a project that may well
 * have been unreachable at the moment the blocker was noticed — a signed-out CLI is exactly the
 * blocker most likely to stop its own card going up. But the retry is fire-and-forget, and the
 * store guard inside the publisher is read *before* it spawns: without this, one pass every few
 * seconds would put a dozen publications in flight that each read "not published yet" and each
 * create a draft item. The store cannot see an attempt that has not finished; this can.
 */
const publishingFounderActions = new Set<string>();

function publishFounderAction(workspace: Workspace | null, record: FounderActionRecord): void {
  if (!workspace || publishingFounderActions.has(record.key)) return;
  publishingFounderActions.add(record.key);
  void publishFounderActionTo(workspace, record)
    .then((itemId) => {
      if (itemId) logger.info(`Founder action "${record.key}" was published as ${itemId}`);
    })
    .catch((error) => logger.warn(
      `Could not publish the founder action "${record.key}": ${(error as Error).message}`
    ))
    .finally(() => publishingFounderActions.delete(record.key));
}

/**
 * Notice one blocker, or nothing at all.
 *
 * Every producer in this file funnels through here, and it is deliberately the only door: the
 * dedupe is the store's key, so four producers that noticed the same thing have to compose the
 * same key without having heard of one another — which they do by handing over a
 * `FounderBlocker` and letting `founderActionKey` compose it.
 *
 * A null blocker is the ordinary answer and is not an error: `blockerForPushAccess` yields null
 * for a verdict nobody could settle, `blockerForGhFailure` for a failure that is not one of the
 * named conditions, and both of those are the permissive rule the column depends on.
 *
 * A record the register refuses is a warning and no card. That is a defect in this file rather
 * than in the operator's machine — the corpus is fixed and the edits are validated — so it is
 * said out loud rather than swallowed.
 */
function noticeFounderBlocker(
  workspaceId: string,
  workspace: Workspace | null,
  found: FounderBlocker | null | undefined
): FounderActionRecord | null {
  if (!found) return null;

  // Read before the write, so "this is the first sighting" is a fact rather than a comparison
  // of two timestamps that can land in the same millisecond. Only a first sighting publishes.
  const key = founderActionKey(workspaceId, found.kind, found.discriminator);
  const already = readFounderAction(workspaceId, key);

  const written = recordFounderAction({
    workspaceId,
    kind: found.kind,
    discriminator: found.discriminator,
    fields: founderActionFor(found),
    evidence: found.evidence,
  });
  if (!written.ok || !written.record) {
    logger.warn(`A founder action for "${found.key}" was not recorded: `
      + written.faults.map((fault) => `${fault.field} ${fault.rule} (${fault.detail})`).join('; '));
    return null;
  }

  if (!already) {
    logger.info(`Founder action "${written.record.key}" was recorded: ${written.record.fields.title}`);
  }
  // Every sighting of a record that has not been published yet, rather than the first one only.
  // A publication is one `gh` against a project that may have been unreachable at the moment
  // the blocker was noticed — a signed-out CLI is precisely the blocker most likely to stop its
  // own card being published — and #540's contract is that such a failure "leaves the record
  // unpublished and re-publishable". Publishing on the first sighting alone would make that
  // sentence false. Publishing twice is impossible: `publishFounderAction` reads the store back
  // before it spawns anything, which is the guard that also survives a restart.
  if (!written.record.publishedItemId) publishFounderAction(workspace, written.record);
  return written.record;
}

/**
 * Close every open record this snapshot can honestly close.
 *
 * Called wherever a fresh probe answer exists rather than from one place, because the answers
 * arrive in different rooms: the pass has the GitHub status, and `beginImplement` has the push
 * permission the moment it reads one. Neither of them probes for this — the whole rule is that
 * settling adds no `gh` at all.
 *
 * `satisfied` and nothing else. `still-blocked` leaves the card where it is, and `cannot-say`
 * is the verifier refusing to guess, which is the property that keeps this from closing a card
 * because the network had a bad minute.
 */
function settleFounderActions(workspaceId: string, snapshot: FounderSnapshot): void {
  for (const record of openFounderActions(workspaceId)) {
    const verdict = verifyAgainst(record.kind, snapshot);
    if (verdict.settled !== 'satisfied') continue;
    if (!resolveFounderAction(workspaceId, record.key, 'probe')) continue;
    logger.info(`Founder action "${record.key}" was closed by a re-probe: ${verdict.why}`);
  }
}

/**
 * One pass over one board: what `gh` says about itself, and what that closes.
 *
 * `readGithubStatus` is the only detector that goes through `spawnProbe` rather than `runGh`,
 * which makes it the only one that sees a missing or signed-out CLI on a board with no project
 * and no repository — the fresh clone this column exists for. Every other producer here needs
 * somebody to have asked for something first.
 */
async function founderPassOver(workspace: Workspace | null, workspaceId: string): Promise<void> {
  let github: GithubStatus | null = null;
  try {
    github = await ghStatusMemo.read(
      workspace ? workspace.id : `${workspaceId} host`,
      GH_STATUS_KEY,
      () => readGithubStatus(workspace)
    );
  } catch (error) {
    logger.warn(`Founder pass: gh could not be read for "${workspaceId}": ${(error as Error).message}`);
    return;
  }

  noticeFounderBlocker(workspaceId, workspace, blockerForGithubStatus(github));
  settleFounderActions(workspaceId, { github, agent: implementAgentHealth(workspace) });
}

/** What the startup preflight found for the implement agent in this board's environment. */
function implementAgentHealth(workspace: Workspace | null): AgentEnvironmentHealth | null {
  const kind = workspace?.environment.kind === 'wsl' ? 'wsl' : 'native';
  return AGENT_PREFLIGHT.implement?.environments?.[kind] ?? null;
}

/**
 * Every board this pass covers.
 *
 * The registered projects, or the host's own `gh` when there are none — a machine with nothing
 * registered is exactly the machine most likely to be blocked, and answering "no workspaces, so
 * nothing to say" would leave the column empty on the board it was built for. A workspace the
 * registry could not resolve is skipped: that is a board problem, and a board problem is not a
 * founder action.
 */
async function founderProducerPass(): Promise<void> {
  const workspaces = await loadWorkspaces(registryPath()).catch(() => []);
  const usable = workspaces.filter((workspace) => !workspace.error);
  if (usable.length === 0) {
    await founderPassOver(null, DEFAULT_WORKSPACE_ID);
    return;
  }
  for (const workspace of usable) {
    await founderPassOver(workspace, normalizeWorkspaceId(workspace.id));
  }
}

/**
 * The timer, started once and `unref`'d so it is never why a process stays alive.
 *
 * The first pass waits out an interval rather than running at startup. Two probes per project
 * in the first second of every server start is a cost every check in `scripts/` would pay for a
 * feature none of them is about, and nothing is lost by it: the blockers that matter at the
 * moment somebody clicks are recorded by the refusal itself.
 */
let founderTimer: NodeJS.Timeout | null = null;

function startFounderProducer(): void {
  if (FOUNDER_PASS_MS <= 0 || founderTimer) return;
  founderTimer = setInterval(() => { void founderProducerPass(); }, FOUNDER_PASS_MS);
  founderTimer.unref?.();
}

/**
 * How many implementations one workspace may have in flight at once.
 *
 * It used to be unlimited, and unlimited by accident: nothing counted runs, because the
 * only guard was per issue. Now that each run has a checkout of its own, several at once
 * are safe rather than merely tolerated — so the default is a number greater than one, and
 * a small one, because every run is a whole coding agent building and testing on this
 * machine. `0` means no cap; `1` serialises.
 */
const IMPLEMENT_CONCURRENCY = (() => {
  const configured = env('IMPLEMENT_CONCURRENCY');
  if (configured === undefined || configured.trim() === '') return 4;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 4;
})();

/**
 * Write an implementation's state everywhere it is shown.
 *
 * The record against the issue URL is the truth. The copy on the elements is a convenience
 * with one job: a block has to read correctly with nothing selected and with no network,
 * which is the same reason the issue title is kept on the element. Every element carrying
 * this issue gets the copy, so an authored block and a mirrored card cannot disagree.
 *
 * `null` clears rather than writes, which is what the reset does.
 *
 * The two instants travel with the state and the token counts deliberately do not. Every
 * write here bumps a `version` on every element carrying the issue and broadcasts it,
 * which is the bookkeeping that makes exports churn — so what goes on an element has to be
 * something that changes when the state does and not otherwise. `startedAt` and `endedAt`
 * are written once each; a browser holding either of them can run a clock off it without
 * asking anyone. Usage changes throughout a run, so it stays on the record alone.
 */
function recordImplement(
  workspaceId: string,
  issueUrl: string,
  record: ImplementRecord | null
): void {
  if (record) writeImplement(workspaceId, issueUrl, record);
  else clearImplement(workspaceId, issueUrl);

  // A run is the one thing the board does that changes the issue on GitHub: it ends in a
  // pull request, and a pull request is what closes it. So whatever was remembered about
  // the issue is dropped here rather than waited out — the panel's next selection is where
  // "closed by #N" has to appear, and it must not be answered from before the run.
  issueMemo.forget(workspaceId, issueUrl);

  const store = elementsFor(workspaceId);
  for (const [id, element] of store) {
    const custom = (element.customData ?? {}) as Record<string, unknown>;
    if (custom.issueUrl !== issueUrl) continue;

    const {
      implementState, implementUrl, implementError, implementStartedAt, implementEndedAt, ...rest
    } = custom;
    const updated: ServerElement = {
      ...element,
      customData: record
        ? {
            ...rest,
            implementState: record.state,
            implementUrl: record.url,
            implementError: record.error,
            implementStartedAt: record.startedAt,
            implementEndedAt: record.endedAt
          }
        : rest,
      updatedAt: new Date().toISOString(),
      version: (element.version || 0) + 1
    };
    store.set(id, updated);
    broadcast({ type: 'element_updated', element: updated } as ElementUpdatedMessage, workspaceId);
  }
}

/**
 * What a run has accumulated so far, to carry into the record that replaces this one.
 *
 * `recordImplement` takes a whole record, and a run writes three or four of them: running,
 * running-with-a-worktree, then done or failed. Rebuilding each from literals is how the
 * start time would quietly be lost halfway through — so it is read back rather than
 * remembered.
 */
function carriedImplement(
  workspaceId: string,
  issueUrl: string
): Pick<ImplementRecord, 'startedAt' | 'usage' | 'terminal' | 'recovered' | 'pid' | 'reclaimed'> {
  const existing = readImplement(workspaceId, issueUrl);
  return {
    startedAt: existing?.startedAt ?? null,
    usage: existing?.usage ?? null,
    // Carried like the token counts: it arrives in the middle of a run, from the spawn, and a
    // record rebuilt from literals halfway through would lose the one fact that says whether
    // anybody is still waiting on this run.
    pid: existing?.pid ?? null,
    // And this one is never carried forward as anything but null. A reclaim is a fact about the
    // record it closed; a run that goes on to report for itself has settled honestly, and
    // leaving the evidence on it would say the server took a slot back that it did not.
    reclaimed: null,
    // Carried for the same reason the start time is: the session is opened once, in the
    // middle of the run, and a record rebuilt from literals at the end would forget which
    // tab the run happened in exactly when somebody goes looking for its transcript.
    terminal: existing?.terminal ?? null,
    // And this one is a *bound*, so losing it does not merely forget something — it grants a
    // second recovery. Carried rather than remembered for exactly that reason.
    recovered: existing?.recovered ?? false,
  };
}

/**
 * Token counts onto the record, and nowhere else.
 *
 * Deliberately not `recordImplement`: these arrive throughout a run, and writing each one
 * onto every element carrying the issue would bump a version and broadcast an update every
 * time — the churn the clock is careful to avoid, arriving through the other door. The
 * panel polls the record every four seconds and picks them up there, and a block with
 * nothing selected has no use for them.
 *
 * Ignored once the run has settled: a report can still be in flight when the process
 * closes, and it must not resurrect a finished record.
 */
function recordImplementUsage(
  workspaceId: string,
  issueUrl: string,
  usage: ImplementUsage
): void {
  const existing = readImplement(workspaceId, issueUrl);
  if (!existing || existing.state !== 'running') return;
  writeImplement(workspaceId, issueUrl, { ...existing, usage });
}

/**
 * The session a run was given, onto the record and nowhere else.
 *
 * The same reasoning as `recordImplementUsage`, and the same door: this arrives in the
 * middle of a run, and `recordImplement` would write it onto every element carrying the
 * issue — a version bump and a broadcast each — for a fact a block with nothing selected
 * cannot show. The panel reads the record, and the tab is on the canvas already.
 *
 * Ignored once the run has settled, so a session announced late cannot resurrect a finished
 * record.
 */
function recordImplementTerminal(
  workspaceId: string,
  issueUrl: string,
  terminal: string
): void {
  const existing = readImplement(workspaceId, issueUrl);
  if (!existing || existing.state !== 'running') return;
  writeImplement(workspaceId, issueUrl, { ...existing, terminal });
}

/**
 * The process a run is in, onto the record and nowhere else.
 *
 * The same door as the token counts and the terminal session, for the same reason: it arrives
 * in the middle of a run and no block with nothing selected can show it.
 *
 * **Both calls matter and the second matters more.** A pid on a `running` record says this
 * process is still waiting on a child; `null` says the agent has returned and the server is
 * finishing up — asking GitHub about the pull request, releasing the checkout — which is work
 * that takes seconds and must never be mistaken for a wedge. The sighting kept in
 * `implement-reclaim.ts` is dropped alongside it so a record that gets a new process, as a
 * recovered second attempt does, is not reclaimed on what was seen about the first.
 *
 * Ignored once the run has settled, so a spawn reported late cannot resurrect a finished
 * record — including one this server has just reclaimed.
 */
function recordImplementPid(workspaceId: string, issueUrl: string, pid: number | null): void {
  forgetSighting(workspaceId, issueUrl);
  const existing = readImplement(workspaceId, issueUrl);
  if (!existing || existing.state !== 'running') return;
  writeImplement(workspaceId, issueUrl, { ...existing, pid });
}

/**
 * What a request to start a run is answered with.
 *
 * The answer is a value rather than a response written in place, because the routes are no
 * longer the only caller: the queue starts runs through this same function and has no
 * request to answer — what it needs is the *status*, since `409` is precisely how it is told
 * the cap is full and to come back later. A second entrance that skipped these guards would
 * be a second way for one issue to become two pull requests.
 */
interface ImplementAnswer {
  status: number;
  body: Record<string, unknown>;
  /**
   * The founder action this refusal filed, when it filed one.
   *
   * Beside the answer and deliberately not inside `body`: every status, body and sentence this
   * function produces is byte-identical to what it produced before founder actions existed, and
   * a field added to the body would be that promise broken on the first caller that compares
   * one. The queue is what reads this — a card refused every interval is worth naming by what a
   * person has to go and do, rather than by repeating what `gh` said about it.
   */
  founderAction?: FounderActionRecord | null;
}

/**
 * Start an implementation for one issue, however it was asked for.
 *
 * Both routes land here — the element one for an authored block, the URL one for a mirrored
 * card that has no element at all — and so does the queue, so the guards are stated once and
 * cannot drift apart. It returns as soon as the run is under way rather than when the run
 * ends: implementing has no time limit, so a held-open request would only look like a hang.
 *
 * `resume` is the same run with one thing added to the prompt, and one guard added in front of
 * it. Not a route of its own: everything below — the per-issue guard, the cap, the worktree,
 * the release — is identical, and a second copy of it would be a second place for the guard
 * that stops one issue becoming two pull requests to be got wrong.
 */
async function beginImplement(
  workspaceId: string,
  issueUrl: string,
  options: { resume?: boolean; interactive?: boolean } = {}
): Promise<ImplementAnswer> {
  if (!isIssueUrl(issueUrl)) {
    return { status: 400, body: { success: false, error: issueUrlRefusal(issueUrl) } };
  }

  const existing = readImplement(workspaceId, issueUrl);
  if (existing?.state === 'running') {
    return {
      status: 409,
      body: { success: false, error: 'An implementation is already in flight for this issue.' }
    };
  }
  // Resuming is a claim about the past — that there is an attempt to continue — so it is
  // refused when the server does not agree there was one. A resume that quietly became a
  // fresh run would be the exact failure this feature exists to stop, arriving through the
  // button that was meant to prevent it.
  if (options.resume && existing?.state !== 'interrupted') {
    return {
      status: 409,
      body: {
        success: false,
        error: existing
          ? `There is no interrupted run to resume for this issue; it is ${existing.state}.`
          : 'There is no interrupted run to resume for this issue.'
      }
    };
  }
  if (existing?.state === 'done' && existing.url) {
    // The same reasoning that stops one observation becoming two issues.
    return {
      status: 409,
      body: {
        success: false,
        error: 'This issue already has an implementation.',
        implementUrl: existing.url
      }
    };
  }

  // Before the slot is claimed, because this refusal has nothing to undo: the board either
  // has an interactive tab to give or it has not, and neither answer depends on the run.
  const interactiveRefusal = options.interactive ? await interactiveTabRefusal(workspaceId) : null;
  if (interactiveRefusal) {
    return { status: 409, body: { success: false, error: interactiveRefusal } };
  }

  // Before the count, and never between it and the claim below. A slot held by a run that is
  // over is not a slot, and a click refused by one is #357 arriving through the other door: a
  // board whose queue is off has nothing else that would ever notice.
  await reclaimStalledRuns(workspaceId);

  // A board that can start runs faster than a machine can finish them needs a budget, and a
  // refusal has to say which run is holding the slot to be worth reading. It is not only a
  // budget: a cap that leaks puts two `git worktree add` in the same instant, and they
  // collide on the shared `.git/config`.
  const inFlight = runningImplements(workspaceId);
  if (IMPLEMENT_CONCURRENCY > 0 && inFlight.length >= IMPLEMENT_CONCURRENCY) {
    return {
      status: 409,
      body: {
        success: false,
        error: `This workspace already has ${inFlight.length} implementation(s) running, which is the limit `
          + `set by ${settingName('IMPLEMENT_CONCURRENCY')}. In flight: ${inFlight.map((run) => run.issueUrl).join(', ')}`,
        running: inFlight.map((run) => run.issueUrl)
      }
    };
  }

  // The slot is claimed here, before the first `await`, and that placement is the whole
  // guard. Counting and claiming have to be one uninterrupted step: while this write sat
  // below the registry read, two clicks arriving together both counted before either
  // claimed, both passed, and the cap was exceeded by however many fitted in the window.
  // Nothing between the count above and this line yields, so there is no window left.
  //
  // This is also the one write of the start time. Everything after it carries this instant
  // forward, and everything showing a duration subtracts from it rather than being told one.
  recordImplement(workspaceId, issueUrl, {
    state: 'running',
    url: null,
    error: null,
    worktree: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    usage: null,
    terminal: null,
    // This is the one write that starts a run rather than continuing one, so it is where the
    // recovery allowance is handed out. Every record after it carries this forward.
    recovered: false,
    // Nothing has been spawned yet — the claim is made before the first `await` on purpose —
    // so there is no process to name until `runImplementation` gets one.
    pid: null,
    reclaimed: null
  });

  /**
   * Give the slot back, for a run refused after it was claimed.
   *
   * The cost of claiming first is that the refusals below now have something to undo, and a
   * slot held by a run that never started would shrink the cap until the server restarts —
   * the same defect pointing the other way. What was there before the claim is put back
   * rather than cleared, so a previous failure's error survives an attempt that got no
   * further than the registry.
   */
  const releaseSlot = (): void => recordImplement(workspaceId, issueUrl, existing);

  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    releaseSlot();
    return {
      status: 400,
      body: {
        success: false,
        error: `Workspace "${workspaceId}" is not registered, so there is no project to work in.`
      }
    };
  }
  if (workspace.error) {
    releaseSlot();
    return {
      status: 400,
      body: { success: false, error: `Workspace is unusable: ${workspace.error}` }
    };
  }

  // After the claim, so it goes through `releaseSlot` like every other late refusal: a
  // workspace whose environment was never granted a command must not hold a slot for it.
  const agentRefusal = agentCommandRefusal(
    workspace, IMPLEMENT_AGENT_COMMANDS, 'Implementing', settingName('IMPLEMENT_AGENT')
  );
  if (agentRefusal) {
    releaseSlot();
    // A board that was never granted a command for this environment is somebody's decision to
    // make, not this process's: the card names the environment and the variable that grants
    // one. `unconfigured` rather than `not found` because that is precisely what was asked —
    // `agentCommandRefusal` answers on there being no command at all, having probed nothing.
    const founderAction = noticeFounderBlocker(workspaceId, workspace, blockerForAgentPreflight({
      role: 'implement',
      environment: workspace.environment.kind === 'wsl' ? 'wsl' : 'native',
      variable: workspace.environment.kind === 'wsl'
        ? `${settingName('IMPLEMENT_AGENT')}_WSL`
        : settingName('IMPLEMENT_AGENT'),
      binary: null,
      resolved: 'unconfigured',
    }));
    return { status: 404, body: { success: false, error: agentRefusal }, founderAction };
  }

  // The last question asked before anything exists to clean up, and the only one about GitHub:
  // can this account push? Everything downstream of here assumes it can — the worktree is cut
  // with no upstream because the agent's own `git push -u` writes one, the prompt demands a
  // pull request URL as the last line it prints, and `releaseWorktree` deletes the branch with
  // `git branch -d`, which only succeeds once it has merged. A clone rather than a fork
  // therefore bought a full run and got `Agent finished without returning a pull request URL`,
  // with the commits stranded in a worktree that the next server start reports as interrupted.
  //
  // Deliberately *after* the claim and behind `releaseSlot`, unlike the interactive refusal:
  // this one needs the workspace, which is two awaits below where the slot is taken. It is
  // still before `ensureWorktree`, which is the placement that matters — a refusal here leaves
  // no directory, no branch and no record behind it.
  //
  // 403 rather than 409: this is not a conflict with what the board is doing, it is a
  // permission the board cannot change.
  const push = await ghPushMemo.read(workspaceId, GH_PUSH_KEY, () => readPushAccess(workspace));
  // The answer this just read is the freshest one anybody has, so it is also what settles a
  // push card that has been open since the last refusal. No probe is added by it: this is the
  // probe, and an account that has been forked to since is closed here rather than never.
  settleFounderActions(workspaceId, { push });
  if (push.verdict === 'no') {
    releaseSlot();
    // Only a `no` — the verdict GitHub stated. `unknown` starts the run and files nothing, for
    // the reason `github-push.ts` gives: a probe that could not learn anything must not refuse
    // a reader through a second door after declining to refuse them through the first.
    const founderAction = noticeFounderBlocker(workspaceId, workspace, blockerForPushAccess(push));
    return { status: 403, body: { success: false, error: pushRefusal(push) }, founderAction };
  }
  if (push.verdict === 'unknown') {
    // Info rather than warn: a board whose `origin` is not on github.com, or which has no `gh`
    // at all, is a supported board and its every run would otherwise raise a warning. The line
    // exists so that a run which *did* fail at the push can be traced back to the moment the
    // probe declined to say.
    logger.info(`Push permission for "${workspaceId}" could not be settled, so the run starts: ${push.why}`);
  }

  // Not awaited: the run outlives the answer, which is the whole reason the answer is 202.
  // Its failures are recorded against the issue rather than thrown at whoever asked.
  void runImplementation(workspace, issueUrl, options);
  return { status: 202, body: { success: true, state: 'running', issueUrl } };
}

/**
 * Why this board cannot give a run an interactive tab, or null when it can.
 *
 * **This is the one place a missing tab stops a run**, and it is deliberate. Everywhere else
 * a tab is offered and never required — `implementTerminalHost` returns null and the run
 * happens in a private child exactly as it did before the terminal existed, because a 409
 * from the cap must never be what stops an implementation from starting. Here the reader
 * asked for the tab. Falling back would hand them a run with its print flags removed and no
 * interface to draw with them: no screen, no token counts, and nothing to type into — worse
 * than the run they would have got by not asking. A refusal that says which of the three is
 * missing is the honest answer, and the click that produced it can simply be made again
 * without the ask.
 *
 * A 409 rather than a 400, like the cap: a conflict with what this board *is*, not a request
 * that was malformed.
 */
async function interactiveTabRefusal(workspaceId: string): Promise<string | null> {
  if (!terminalAvailable()) {
    return 'An interactive run needs a terminal tab to run in, and the terminal is off on '
      + `this board. Set ${settingName('TERMINAL')} to turn it on, or start the run without asking `
      + 'for a tab to answer.';
  }
  if (!await loadPty()) {
    return 'An interactive run needs a pseudoterminal, and this board has none — either no '
      + `@lydell/node-pty binary for this platform, or ${settingName('TERMINAL_PTY')}=0. On pipes `
      + 'there is no interface to draw and nothing to type into, so the terminal tab would '
      + 'be the same read-only screen an ordinary run gets.';
  }
  if (terminalSessionsFor(workspaceId).size >= TERMINAL_SESSION_LIMIT) {
    return `An interactive run needs one of this board's ${TERMINAL_SESSION_LIMIT} terminal `
      + 'tabs, and all of them are in use. Close one first, or start the run without asking '
      + 'for a tab to answer.';
  }
  return null;
}

/**
 * The run itself, once the slot is claimed and the workspace is known to be usable.
 *
 * Split from the guards above so that starting a run and *answering* a request are two
 * things: the queue does the first without the second. Everything here is written to the
 * record against the issue, which is where a click, a card and a queue pass all read it.
 */
async function runImplementation(
  workspace: Workspace,
  issueUrl: string,
  options: { resume?: boolean; interactive?: boolean } = {}
): Promise<void> {
  const workspaceId = workspace.id;

  // The board says Todo until something says otherwise, and starting the run is the
  // something. Deliberately not awaited: the project and the agent are independent, and a
  // `gh` working through its retries must not hold an implementation up. Deliberately not
  // fatal either — a board write that fails costs a log line and nothing else, because the
  // point of the run is the pull request, not the column.
  void moveIssueToColumn(workspace, issueUrl, inProgressColumn(workspace))
    .then((column) => { if (column) logger.info(`${issueUrl} is being implemented, so its card moved to "${column}"`); })
    .catch((error) => logger.warn(
      `Could not move ${issueUrl} on the project board: ${(error as Error).message}`
    ));

  let worktree: ImplementWorktree | null = null;
  try {
    worktree = await ensureWorktree(workspace, issueUrl);
    if (worktree) {
      recordImplement(workspaceId, issueUrl, {
        state: 'running', url: null, error: null, worktree: worktree.path, endedAt: null,
        ...carriedImplement(workspaceId, issueUrl)
      });
    }

    // Read here rather than remembered from the record: the record says a run was interrupted,
    // the worktree says what is actually in it, and the second is what the agent is about to
    // be looking at. Nothing has touched the checkout between the guard above and this line,
    // and `ensureWorktree` reuses it rather than rebuilding it.
    const resuming = options.resume
      ? (await interruptedRuns(workspace)).find((run) => run.issueUrl === issueUrl)?.worktree ?? null
      : null;

    // Offered, never required. With no terminal on this board — or with its tabs all taken —
    // this is null and the run happens in a private child, which is the only thing it could
    // do before the two features knew about each other.
    const host = implementTerminalHost(workspace, issueUrl);

    // The run, and then at most once more.
    //
    // **The loop is the whole of the recovery, and it is a loop rather than a second call into
    // this function on purpose.** Re-entering would move the card to In Progress again, cut the
    // worktree again and reset the start time; worse, it would have to pass the cap and the
    // per-issue guard, which would either refuse it or need a way around them — a second door
    // into starting a run, which is the thing `beginImplement`'s comment exists to prevent.
    // Here the slot is already held, the state stays `running` for the reader, and the checkout
    // survives between the two attempts because the release happens after both.
    let unfinished: UnfinishedRun | null = null;
    let result: AgentRun;
    let landing: Landing;
    for (;;) {
      result = await runImplementAgent(workspace, issueUrl, {
        // Resolved here rather than handed down: `beginImplement` has already refused a
        // workspace with no command for its environment, so by this line there is one.
        //
        // And the per-run "interactive" is now the *mode* the backend is asked for, rather than
        // a rewritten command line. Everything downstream reads the invocation the backend
        // built — `AgentInvocation.prompt.via` decides whether the tab gets a pseudoterminal
        // and whether the prompt goes to stdin or travels as the last argument,
        // `AgentAdapter.streams` decides whether there are token counts to read. For the `raw`
        // backend that is still the operator's own command with its print flags removed, which
        // is the same request they make by leaving them out of `EXCALIDRAW_IMPLEMENT_AGENT`,
        // made once instead of forever; a command with none in it comes back byte for byte.
        agent: agentGrantFor(workspace, IMPLEMENT_AGENT_GRANTS, 'implement') as AgentCommandSpec,
        ...(options.interactive ? { interactive: true } : {}),
        notFoundVariable: settingName('IMPLEMENT_AGENT_WSL'),
        worktree,
        resuming,
        unfinished,
        // Reached only when the configured command already streams. Otherwise the agent
        // prints prose at exit, there is nothing to read, and this is never called.
        onUsage: (usage) => recordImplementUsage(workspaceId, issueUrl, usage),
        // Which process the run is in while it is in one, and null the moment it is not. This
        // is the whole of what makes a wedged record distinguishable from a working one.
        onPid: (pid) => recordImplementPid(workspaceId, issueUrl, pid),
        ...(host ? { host } : {})
      });

      // What the agent printed is not what happened. A run that prints a pull request URL has
      // proved that a pull request exists, and nothing more — so the one participant that knows
      // whether it landed is asked before the record is written. Only for a run that claims to
      // have produced one: the other paths never asked GitHub anything and must not start.
      const pull = result.ok && result.url
        ? await fetchPullLanding(workspace, result.url)
        : null;
      landing = landingFor({
        ok: result.ok, url: result.url, error: result.error, output: result.output, pull
      });

      if (readImplement(workspaceId, issueUrl)?.recovered) break;
      const held = await recoverable(workspace, issueUrl, result, landing, worktree);
      if (!held) break;

      logger.warn(
        `${issueUrl} ended without landing anything and is being finished: ${landing.error}`
      );
      // Written before the second attempt starts, not after it: this is the bound, and a bound
      // recorded on the way out is one a crash in between hands back.
      recordImplement(workspaceId, issueUrl, {
        state: 'running', url: landing.url, error: null, worktree: worktree?.path ?? null,
        endedAt: null, ...carriedImplement(workspaceId, issueUrl), recovered: true
      });
      unfinished = { pullRequest: landing.url, worktree: held.worktree };
    }

    const kept = await releaseWorktreeFor(workspace, worktree, issueUrl);

    recordImplement(workspaceId, issueUrl, {
      state: landing.state, url: landing.url, error: landing.error, worktree: kept,
      ...carriedImplement(workspaceId, issueUrl), endedAt: new Date().toISOString(),
      // Said again rather than carried: a settled run is in no process at all, and a stale pid
      // on it would be a pid the machine is free to hand to somebody else.
      pid: null
    });
    if (landing.state === 'done') logger.info(`${issueUrl} implemented at ${landing.url}`);
    else logger.warn(`${issueUrl} implementation ${landing.state}: ${landing.error}`);
  } catch (error) {
    recordImplement(workspaceId, issueUrl, {
      state: 'failed',
      url: null,
      error: (error as Error).message,
      worktree: await releaseWorktreeFor(workspace, worktree, issueUrl),
      ...carriedImplement(workspaceId, issueUrl),
      endedAt: new Date().toISOString(),
      pid: null
    });
  }

  // A run settling is the moment a slot frees, and the only one this process can be sure of.
  // The timer exists for the other kind of change — a card dragged into Todo on GitHub — and
  // would find this one too, twenty or thirty seconds later; here it costs nothing to be
  // prompt about the thing the queue is actually for.
  void dispatchQueue(workspaceId);
}

// ─── The queue ────────────────────────────────────────────────
//
// On, and the server starts the oldest Todo issue whenever a slot frees. The switch itself is
// `implement-queue.ts`; this is what turns it into runs, and it is here rather than in the
// browser because the browser's poll is gated on tab visibility on purpose. A queue that
// stopped advancing when the tab was hidden would stop during exactly the hours it exists for.

/**
 * How often a draining workspace looks at its board.
 *
 * The event that matters — a run settling — is dispatched on directly, so this is only for
 * the changes this process cannot see: a card dragged into Todo on GitHub, an issue closed,
 * a slot freed by a reset. Every pass while the queue is on and a slot is free costs one `gh`
 * process, which is why the pass gives up before reading anything when the queue is off or
 * the cap is full, and why the timer does not exist at all until something turns a queue on.
 */
const IMPLEMENT_QUEUE_MS = (() => {
  const configured = env('IMPLEMENT_QUEUE_MS');
  if (configured === undefined || configured.trim() === '') return 30_000;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 250 ? parsed : 30_000;
})();

/**
 * How long a pass may hold the guard below before a later one stops believing in it.
 *
 * The guard is a saving, not a correctness property — the cap is enforced by the claim made
 * before `beginImplement`'s first `await`, so two overlapping passes cannot start one issue
 * twice or exceed the cap. What an unbounded guard *can* do is kill the queue outright: one
 * pass that never returns holds its workspace for the life of the process while the toggle
 * still draws "on", which is #263's second hypothesis and is silent in every direction.
 *
 * Four intervals, and never under five seconds. A healthy pass is one board read; the read
 * gives up on its own after three `gh` attempts of thirty seconds, so the default interval
 * puts this at two minutes — comfortably past the slowest read that is still going to
 * answer. A board configured to drain every few seconds gets a bound of the same order,
 * which is what makes this assertable in a check rather than only in an afternoon.
 */
const QUEUE_PASS_MS = Math.max(4 * IMPLEMENT_QUEUE_MS, 5_000);

/**
 * The workspaces with a pass in flight, and when that pass started.
 *
 * A pass reads the board and then starts runs one at a time, so two passes overlapping —
 * the timer and a run settling in the same instant — would each be working from a board read
 * before the other started. The claim guard would still hold the cap, but the second pass
 * would spend a `gh` read to be told no, every time.
 *
 * The instant is what bounds it. Each pass carries a number of its own so a stale one that
 * finally returns clears its own entry and not the entry of whatever replaced it — without
 * that, the recovery below would hand the guard to a new pass and then have it deleted out
 * from under it by the corpse of the old one.
 */
const draining = new Map<string, { pass: number; startedAt: number }>();
let queuePasses = 0;

/** Whether this workspace has room for one more run right now. */
function slotFree(workspaceId: string): boolean {
  return IMPLEMENT_CONCURRENCY <= 0
    || runningImplements(workspaceId).length < IMPLEMENT_CONCURRENCY;
}

/**
 * How long a run whose process has gone waits before its slot comes back.
 *
 * A grace rather than a formality: a run's process ending is not the run ending. The pid is
 * cleared from the record the instant the agent's promise resolves, so a `running` record still
 * carrying one has not reached the server's own tidying up — but that clearing is delivered on a
 * turn of the loop a pass can be ahead of. Waiting for a second sighting closes the window and
 * costs a wedged run one interval.
 *
 * Reused as the floor on the *other* evidence, which is a different thing said with the same
 * number on purpose: a run that started a moment ago is not what any of this is for, and asking
 * GitHub about one would spend a `gh` process to be told so.
 */
const IMPLEMENT_RECLAIM_MS = (() => {
  const configured = env('IMPLEMENT_RECLAIM_MS');
  if (configured === undefined || configured.trim() === '') return 30_000;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
})();

/**
 * Give back every slot held by a run that is over and never said so.
 *
 * The two evidences in `implement-reclaim.ts`, gathered in the order they cost. The process
 * check is one `kill(pid, 0)` per running record and is made every time. Asking GitHub is a
 * process per record, so it is made only when the cap is full — which is the only state in which
 * a stale record is costing anything, and is precisely the state #357 was observed in: four
 * slots, one held by a run whose pull request had merged four hours earlier, and a board that
 * could say only `cap-full`.
 *
 * **Nothing here stops anything.** A reclaim closes a record; the agent, if there somehow still
 * is one, goes on exactly as it was and its own report — when it comes — overwrites this. That is
 * the whole reason the evidence has to be positive: the cost of being wrong is another agent
 * started beside one that is still writing, and no clock can tell those apart.
 *
 * Said out loud, once per reclaim, because it is the one thing that happens to a run without
 * anybody asking for it. The queue reports it as a pass of its own as well; this line is what a
 * board with no queue on it still gets.
 */
async function reclaimStalledRuns(workspaceId: string): Promise<ReclaimedRun[]> {
  const reclaimed: ReclaimedRun[] = [];
  // Read before anything is given back, not after. A cheap reclaim below frees a slot, and
  // asking "is there room now" would then skip the expensive half for the very reason the pass
  // was worth making — leaving the remaining stale records to be found one interval at a time.
  // What decides it is the state this pass *arrived* in.
  const stuck = !slotFree(workspaceId);

  for (const entry of runningImplements(workspaceId)) {
    const { issueUrl, ...record } = entry;
    const gone = goneProcessReclaim(workspaceId, issueUrl, record.pid, IMPLEMENT_RECLAIM_MS);
    if (!gone) continue;
    recordImplement(workspaceId, issueUrl, {
      ...record,
      // The state a restart's inference already uses, and the one **Resume** already offers
      // back: what is left of this run is a checkout, which is exactly what `interrupted` means.
      state: 'interrupted',
      error: gone.detail,
      endedAt: new Date().toISOString(),
      pid: null,
      reclaimed: gone
    });
    reclaimed.push({ issueUrl, reclaimed: gone });
    logger.warn(`Reclaimed the slot held by ${issueUrl}: ${gone.detail}`);
  }

  // The expensive half buys one thing — a slot — so it is not paid for by a board that had one
  // to spare when this began.
  if (!stuck) return reclaimed;

  const workspaces = await loadWorkspaces(registryPath()).catch(() => []);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) return reclaimed;

  for (const entry of runningImplements(workspaceId)) {
    const { issueUrl, ...record } = entry;
    const startedAt = record.startedAt ? Date.parse(record.startedAt) : NaN;
    if (Number.isFinite(startedAt) && Date.now() - startedAt < IMPLEMENT_RECLAIM_MS) continue;

    let issue: IssueDetail;
    try {
      // Behind the memo an issue block and a queue pass already read through, so a board stuck
      // at its cap asks GitHub about each held issue once a window rather than once a pass.
      issue = await issueMemo.read(workspaceId, issueUrl, () => fetchIssue(workspace, issueUrl));
    } catch (error) {
      // A `gh` that will not answer has taught us nothing, which is not the same as a run that
      // is still going — and treating it as one would invent an ending for a run that has none.
      logger.warn(`Could not ask GitHub whether ${issueUrl} is over: ${(error as Error).message}`);
      continue;
    }
    if (issue.state.toUpperCase() !== 'CLOSED') continue;

    for (const pull of issue.closedBy) {
      // Closed is not landed. An issue closed as not planned, or closed by hand, says nothing
      // about the run — so the pull request GitHub names as having closed it is asked, and only
      // `merged` counts. `fetchPullLanding` answers null for every failure, which falls through
      // here as "learned nothing" exactly as it should.
      if (await fetchPullLanding(workspace, pull.url) !== 'merged') continue;
      const landed = landedReclaim(pull.url);
      recordImplement(workspaceId, issueUrl, {
        ...record,
        state: 'done',
        url: pull.url,
        error: null,
        endedAt: new Date().toISOString(),
        pid: null,
        reclaimed: landed
      });
      reclaimed.push({ issueUrl, reclaimed: landed });
      logger.warn(`Reclaimed the slot held by ${issueUrl}: ${landed.detail}`);
      break;
    }
  }

  return reclaimed;
}

/**
 * Start as many queued issues as there are free slots, oldest first.
 *
 * The board is read **uncapped**. `projectCardLimit` decides what is *drawn*, and reading the
 * drawn mirror would mean working from a truncated column — the queue would drain what fits
 * on screen and silently never reach the rest. `moveIssueToColumn` reads uncapped for the
 * same reason.
 *
 * Each start goes through `beginImplement`, so the cap is enforced where it always was: at
 * the claim made before the first `await`. A `409` here is read as "not yet" and ends the
 * pass rather than being retried — a click that raced this pass has taken the slot, and the
 * next pass will find whatever it left.
 *
 * A card with any record against it is passed over, whatever the record says. `running` is
 * obvious; `done` and `failed` are the same rule as the block's — a run happened, and asking
 * for it again is a decision for whoever is reading the failure, not for a loop. That is also
 * what stops a broken build from being retried forever: the queue tries each issue once.
 *
 * **Every exit is recorded.** A pass gives up in six places, and five of them used to do it
 * without a word — `logger.info` reaches the log file and never the console, so a queue that
 * was on and starting nothing was indistinguishable from a queue that was on with nothing to
 * start. `recordQueuePass` is what `GET /api/implement` answers with and what the toggle on
 * the mirror is drawn from, so the reason arrives everywhere the queue is visible.
 */
async function dispatchQueue(workspaceId: string): Promise<void> {
  if (!IMPLEMENT_AGENT_CONFIGURED) return;
  if (!queueEnabled(workspaceId)) return;

  const inFlight = draining.get(workspaceId);
  if (inFlight) {
    if (Date.now() - inFlight.startedAt < QUEUE_PASS_MS) return;
    // Past the bound, so this pass is not coming back and waiting on it is waiting forever.
    // Loud, because it is the one queue state nothing else can be inferred from: the runs
    // below still go through the same claim guard, so proceeding cannot double-start
    // anything — it can only cost one extra `gh` read.
    logger.warn(
      `Queue: the pass on "${workspaceId}" has been running for `
      + `${Math.round((Date.now() - inFlight.startedAt) / 1000)}s and is being given up on. `
      + 'Something it awaited — the board read, most likely — has not come back.'
    );
  }

  const pass = ++queuePasses;
  draining.set(workspaceId, { pass, startedAt: Date.now() });

  let started = 0;
  /** What the pass ran into, replaced as it gets further. Recorded whichever exit it takes. */
  let outcome: { reason: QueuePassReason; detail: string } = {
    reason: 'nothing-startable',
    detail: 'The column held nothing this queue may start.'
  };

  try {
    // Before the cap is looked at, because a record that is over is exactly what makes the cap
    // lie. Reported instead of starting anything, so the reader sees the reclaim rather than a
    // queue that unstuck itself for no stated reason; the next pass, one interval later, fills
    // the slots it gave back.
    const reclaimed = await reclaimStalledRuns(workspaceId);
    if (reclaimed.length > 0) {
      outcome = { reason: 'reclaimed', detail: reclaimDetail(reclaimed) };
      return;
    }

    if (!slotFree(workspaceId)) {
      outcome = capFullOutcome(workspaceId);
      return;
    }

    const workspaces = await loadWorkspaces(registryPath());
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace || workspace.error || !workspace.githubProject) {
      outcome = {
        reason: 'no-project',
        detail: !workspace
          ? `Workspace "${workspaceId}" is no longer registered.`
          : workspace.error
            ? `This board is unusable: ${workspace.error}`
            : 'This board has no "githubProject" in its board.config.json, so there is no column to drain.'
      };
      return;
    }

    const board = await readProjectBoard(workspace, { cardLimit: 0 });
    const target = todoColumn(workspace);
    const column = findColumn(board, target.name);
    if (!column) {
      outcome = {
        reason: 'no-column',
        detail: `No "${target.name}" column on this project, so there is nothing to drain. `
          + `Name the column as "${target.setting}" in board.config.json.`
      };
      return;
    }

    // Which cards are waiting on an issue that has not closed.
    //
    // Resolved here rather than inside `startableCards`, which stays pure and instant: this
    // costs a `gh` read per card inspected. So it walks the column in the order the queue
    // would take it and stops as soon as it has found enough startable cards to fill every
    // free slot — on a healthy board that is the first one or two, and the reads are behind
    // the same memo an issue block uses.
    // The URL comes along with the state because a dependency's *record* is the other half of
    // whether it can ever be met, and a record is keyed by URL.
    const onBoard = new Map<number, { state: string | null; url: string | null }>();
    for (const section of board.sections) {
      for (const boardCard of section.cards) {
        if (boardCard.number !== null) {
          onBoard.set(boardCard.number, { state: boardCard.state, url: boardCard.url });
        }
      }
    }
    const free = IMPLEMENT_CONCURRENCY <= 0
      ? column.cards.length
      : Math.max(0, IMPLEMENT_CONCURRENCY - runningImplements(workspaceId).length);
    const blocked = new Set<number>();
    const waiting: string[] = [];
    /**
     * The dependencies that can never be met, which is a different fact from waiting.
     *
     * A dependency that is open and has no record is waiting: something will start it, and a
     * queue that shouted about that would be shouting about the rule working. A dependency
     * that is open and already holds a *settled* record is a deadlock — the loop below skips
     * any issue `readImplement` answers for, so nothing this queue does will ever start it
     * again, and every card built on it waits forever.
     */
    const deadlocked: string[] = [];
    let clear = 0;
    for (const candidate of startableCards(column.cards)) {
      if (clear >= free) break;
      if (candidate.number === null) { clear++; continue; }
      let unmet: number[] = [];
      try {
        const detail = await issueMemo.read(
          workspaceId,
          candidate.url as string,
          () => fetchIssue(workspace, candidate.url as string)
        );
        unmet = dependenciesOf(detail.body).filter((number) => {
          const known = onBoard.get(number);
          // A dependency this board has never heard of cannot be resolved, and a declaration
          // nothing can answer must not be what stops a queue: it starts.
          return known !== undefined && known.state !== 'CLOSED';
        });
      } catch (error) {
        // The body is an optimisation, not a gate. A read that fails leaves the card exactly
        // as startable as it was before this existed.
        logger.warn(`Queue: could not read ${candidate.url} for its dependencies: ${(error as Error).message}`);
      }
      if (unmet.length === 0) { clear++; continue; }
      blocked.add(candidate.number);
      waiting.push(`#${candidate.number} waits on ${unmet.map((n) => `#${n}`).join(', ')}`);
      for (const number of unmet) {
        const url = onBoard.get(number)?.url;
        const record = url ? readImplement(workspaceId, url) : null;
        if (!record || record.state === 'running') continue;
        deadlocked.push(
          `#${candidate.number} waits on #${number}, whose run is already recorded `
          + `"${record.state}" while the issue is open`
        );
      }
    }
    if (deadlocked.length > 0) {
      // Above `blocked` because it is the same set of cards seen more exactly: every card here
      // is also waiting, and reporting the milder fact would be the silence this exists to end.
      outcome = {
        reason: 'deadlocked',
        detail: `Waiting on work nothing will start again: ${deadlocked.join('; ')}. `
          + 'Reset the run or land the issue by hand — the queue will not start it a second time.'
      };
    } else if (blocked.size > 0) {
      outcome = {
        reason: 'blocked',
        detail: `Waiting on work that has not landed: ${waiting.join('; ')}.`
      };
    }

    /**
     * The cards this pass asked for and was told no about, other than by the cap.
     *
     * Counted rather than logged and forgotten. A refusal that is not `202` or `409` is a
     * decision about this board — an account that cannot push to `origin` is the one that
     * exists today, answered `403` — and nothing between two passes changes it, so the same
     * card is refused every interval for ever while `outcome` sits at its default and the
     * board draws a healthy idle queue.
     */
    let refusals = 0;
    let firstRefusal = '';

    for (const card of startableCards(column.cards, blocked)) {
      // Re-read on every iteration rather than counted once: the queue is not the only thing
      // that can take a slot, and turning it off has to stop the pass it is in the middle of.
      if (!queueEnabled(workspaceId)) return;
      if (!slotFree(workspaceId)) {
        outcome = capFullOutcome(workspaceId);
        return;
      }
      const issueUrl = card.url as string;
      if (readImplement(workspaceId, issueUrl)) continue;

      const answer = await beginImplement(workspaceId, issueUrl);
      if (answer.status === 202) {
        started++;
        logger.info(`Queue: started ${issueUrl} on "${workspaceId}"`);
        continue;
      }
      if (answer.status === 409) {
        // A click that raced this pass has taken the slot. Read as "not yet", and reported
        // as the cap it is: the slot is held by a run, whoever asked for it.
        outcome = capFullOutcome(workspaceId, String(answer.body.error ?? ''));
        return;
      }
      logger.warn(`Queue: ${issueUrl} was refused (${answer.status}): ${answer.body.error}`);
      refusals++;
      if (!firstRefusal) {
        // The founder action's title where there is one, because that is the sentence written
        // for whoever has to act. `gh`'s own wording is what the reader was being given before,
        // and it names a permission, a repository and a `git remote set-url` — true, and not
        // the thing to say to somebody looking at a queue that has stopped.
        firstRefusal = answer.founderAction
          ? `${issueUrl} was refused ${answer.status}, and it needs you: `
            + `${answer.founderAction.fields.title}`
          : `${issueUrl} was refused ${answer.status} — ${answer.body.error ?? ''}`;
      }
    }

    if (refusals > 0) {
      // Above whatever the dependency pass found, because those cards are the ones this queue
      // could *not* try and these are the ones it did: a card refused every interval is the
      // sharper fact, and it is the one nothing will resolve on its own. A pass that also
      // started something is reported as `started` regardless — that is the `finally` below,
      // and a queue that is draining is not stalled however many of the rest it was refused.
      outcome = {
        reason: 'refused',
        detail: `${refusals} card(s) in "${target.name}" were refused, and the next pass will be `
          + `refused the same way. The first: ${firstRefusal}`
      };
    }
  } catch (error) {
    // A board that cannot be read is a `gh` blip or a project that has gone; either way the
    // queue is a background convenience and must not take the server down with it.
    outcome = { reason: 'unreadable', detail: `The board could not be read: ${(error as Error).message}` };
    logger.warn(`Queue: could not drain "${workspaceId}": ${(error as Error).message}`);
  } finally {
    // Only its own entry: a pass given up on above keeps running, and the one that replaced
    // it must survive the corpse returning.
    if (draining.get(workspaceId)?.pass === pass) draining.delete(workspaceId);
    if (queueEnabled(workspaceId)) {
      reportQueuePass(workspaceId, started > 0
        ? { reason: 'started', detail: `Started ${started} run(s).`, started }
        : { ...outcome, started });
    }
  }
}

/** The cap's own words, naming the runs holding the slots so the reader knows who to ask. */
function capFullOutcome(workspaceId: string, said = ''): { reason: QueuePassReason; detail: string } {
  const inFlight = runningImplements(workspaceId);
  return {
    reason: 'cap-full',
    detail: said || `All ${inFlight.length} slot(s) are taken, which is the limit set by `
      + `${settingName('IMPLEMENT_CONCURRENCY')}. Holding them: ${inFlight.map((run) => run.issueUrl).join(', ')}`
  };
}

/**
 * Record the pass, and say it out loud the first time it is a stall.
 *
 * Out loud on the *change* rather than on every pass, because a stalled queue stalls on a
 * timer: warning each time would put the same sentence in the console every interval until
 * somebody turned it off, and a line that repeats forever is a line nobody reads. What is
 * worth interrupting for is the transition — the pass where the queue stopped being able to
 * do what it was switched on to do, or started being able to again.
 */
function reportQueuePass(
  workspaceId: string,
  pass: { reason: QueuePassReason; detail: string; started: number }
): void {
  const previous = lastQueuePass(workspaceId);
  const recorded = recordQueuePass(workspaceId, { ...pass, at: new Date().toISOString() });
  if (!recorded.stalled) {
    if (previous?.stalled) logger.warn(`Queue: "${workspaceId}" is draining again.`);
    return;
  }
  if (previous?.stalled && previous.reason === recorded.reason && previous.detail === recorded.detail) return;
  logger.warn(`Queue: "${workspaceId}" is on and starting nothing — ${recorded.detail}`);
}

/**
 * The timer, which exists only while some workspace is draining.
 *
 * Started when the first queue goes on and stopped when the last goes off, rather than
 * running from startup: a board nobody has switched on must cost no `gh` at all. `unref` so
 * it is never the reason a process stays alive.
 */
let queueTimer: NodeJS.Timeout | null = null;

function syncQueueTimer(): void {
  const active = queuedWorkspaces();
  if (active.length > 0 && !queueTimer) {
    queueTimer = setInterval(() => {
      for (const workspaceId of queuedWorkspaces()) void dispatchQueue(workspaceId);
    }, IMPLEMENT_QUEUE_MS);
    queueTimer.unref?.();
  } else if (active.length === 0 && queueTimer) {
    clearInterval(queueTimer);
    queueTimer = null;
  }
}

/**
 * What a queue looks like from outside: on or off, the column it would drain, and whether the
 * last pass over it could do anything.
 *
 * `lastPass` is null until a pass has run since the switch was last flipped, which is the
 * honest answer for the seconds between the click and the first pass — and for a queue that
 * is off, where "the last pass" would be describing a decision somebody has already undone.
 * `stalled` is lifted out of it because it is the one bit the board draws, and a mirror that
 * had to know the reason vocabulary to draw a toggle would have to be edited every time a
 * reason is added. `announce` is the second bit, for the same reason and at the same cost:
 * whether this is worth putting a box over somebody's canvas for is a fact about the taxonomy,
 * and it is answered here rather than by a list of reason names in the browser.
 */
function queueStateFor(workspace: Workspace | undefined, workspaceId: string): {
  enabled: boolean;
  column: string;
  stalled: boolean;
  announce: boolean;
  lastPass: QueuePass | null;
} {
  const pass = lastQueuePass(workspaceId);
  return {
    enabled: queueEnabled(workspaceId),
    column: workspace ? todoColumn(workspace).name : DEFAULT_TODO_COLUMN,
    stalled: Boolean(pass?.stalled),
    announce: Boolean(pass && reasonAnnounces(pass.reason)),
    lastPass: pass
  };
}

/**
 * Whether a run that just ended is worth finishing, and what it left to finish.
 *
 * Three gates, and each of them refuses a different thing that would otherwise turn one
 * automatic second attempt into a loop or into damage.
 *
 * **Only a `failed` landing.** `done` shipped. `blocked` is the agent having stopped for a
 * person on purpose — sending a second one at it would force the merge the first refused, which
 * is the failure #409 added that state to make impossible.
 *
 * **Only a clean exit.** A turn that ended while a background command was still pending exits
 * **zero**, which is the shape of both runs this exists for. A non-zero exit is a command that
 * could not be found or an agent that blew up, and a null one is a timeout or a refusal made
 * before anything spawned — a broken machine or a decision, neither of which a second identical
 * attempt improves.
 *
 * **Only a run that got somewhere.** A pull request that exists, or a checkout holding commits
 * or changes. With neither there is nothing to *finish*, and re-entering would be a plain re-run
 * — which is exactly what `dispatchQueue`'s "the queue tries each issue once" refuses, and the
 * rule this feature has to stay inside rather than quietly overturn.
 *
 * Derived from git rather than remembered, and read while the checkout is still there —
 * `releaseWorktreeFor` runs after this, and it removes a worktree with nothing uncommitted in
 * it even when that worktree holds commits the base branch has never seen.
 */
async function recoverable(
  workspace: Workspace,
  issueUrl: string,
  result: AgentRun,
  landing: Landing,
  worktree: ImplementWorktree | null
): Promise<{ worktree: HeldWorktree | null } | null> {
  if (landing.state !== 'failed') return null;
  if (result.code !== 0) return null;

  let held: HeldWorktree | null = null;
  if (worktree) {
    try {
      const wanted = worktree.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      held = (await worktreesHoldingWork(workspace)).find(
        (candidate) => candidate.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === wanted
      ) ?? null;
    } catch (error) {
      // A git that will not answer is not a reason to refuse a recovery for a run that has a
      // pull request — and not a reason to grant one for a run whose only evidence was this.
      logger.warn(`Could not read what ${issueUrl} left in its checkout: ${(error as Error).message}`);
    }
  }

  if (!landing.url && !held) return null;
  return { worktree: held };
}

/**
 * Tidy up after a run, and report what could not be tidied.
 *
 * A worktree holding uncommitted changes is kept, because those changes are the only copy
 * of themselves — an agent that died partway through a change leaves exactly that, and a
 * server that swept it away would be destroying the only evidence of what went wrong. It
 * is a warning in the log and a path on the record, so the run that failed is recoverable
 * by hand.
 */
async function releaseWorktreeFor(
  workspace: Workspace,
  worktree: ImplementWorktree | null,
  issueUrl: string
): Promise<string | null> {
  if (!worktree) return null;
  try {
    const released = await releaseWorktree(workspace, worktree);
    if (released.removed) return null;
    logger.warn(`Worktree kept for ${issueUrl}: uncommitted work at ${released.path}`);
    return released.path;
  } catch (error) {
    logger.warn(`Could not release the worktree for ${issueUrl}: ${(error as Error).message}`);
    return worktree.path;
  }
}

/**
 * Give back, at startup, the runs the previous process took with it.
 *
 * A run cannot survive the process that spawned it — the agent is a child, and the tree goes
 * together — so anything found here is over, whatever it looked like when it stopped. That is
 * what makes this safe to do once, on the way up, with nothing running to race against.
 *
 * Derived, not restored: `implement-recovery.ts` reads git, and git is the only participant
 * that was still there. Only runs the map does not already know about are written, which at
 * startup is all of them and would matter if this were ever called again.
 *
 * Not awaited by the caller, and not fatal. It spawns a handful of git processes per project,
 * and a board must not wait on them to start answering — the cost of that is that the record
 * appears a moment after the port opens, which is a moment nobody is looking at a panel in.
 */
async function recoverInterruptedRuns(): Promise<void> {
  let workspaces: Workspace[];
  try {
    workspaces = await loadWorkspaces(registryPath());
  } catch (error) {
    logger.warn(`Could not look for interrupted implementations: ${(error as Error).message}`);
    return;
  }

  for (const workspace of workspaces) {
    if (workspace.error) continue;
    try {
      for (const run of await interruptedRuns(workspace)) {
        if (readImplement(workspace.id, run.issueUrl)) continue;
        const held: HeldWorktree = run.worktree;
        recordImplement(workspace.id, run.issueUrl, {
          state: 'interrupted',
          url: null,
          error: describeInterrupted(held),
          worktree: held.path,
          // Both null on purpose. The worktree knows what was done and not when it was
          // started or when it stopped, and an instant invented here would run a clock in
          // the panel counting time nobody spent.
          startedAt: null,
          endedAt: null,
          usage: null,
          // Nothing survives a restart here either: the sessions were the previous server's
          // and went down with it, so an id recovered from a worktree would name a tab that
          // stopped existing.
          terminal: null,
          // Nor does this, and it must not be inferred: whether the lost run had already spent
          // its recovery is not written in the checkout. `false` is the honest reading, and it
          // costs nothing — an `interrupted` run is offered to a person through **Resume**
          // rather than continued automatically, and that offer has never been rationed.
          recovered: false,
          // Nor this: the process was the previous server's child and went down with it, and a
          // pid read off a checkout would name whatever the machine has since handed it to.
          pid: null,
          // Inferred, not reclaimed. This record was derived from git at startup rather than
          // taken back from a slot it was holding, and saying otherwise would put evidence on
          // it that nothing gathered.
          reclaimed: null
        });
        logger.warn(
          `${run.issueUrl} was being implemented when a previous server stopped; `
          + `its checkout is still at ${held.path} (${held.commits} commit(s), ${held.changes} uncommitted path(s))`
        );
      }
    } catch (error) {
      logger.warn(
        `Could not look for interrupted implementations in "${workspace.id}": ${(error as Error).message}`
      );
    }
  }
}

/** A project's tracked board file, read, or nothing — with when it was last written. */
async function readBoardFile(
  workspaceId: string,
  boardFile: string
): Promise<{ scene: BoardScene; modifiedAt: number } | null> {
  try {
    const [raw, stats] = await Promise.all([
      fs.readFile(boardFile, 'utf-8'),
      fs.stat(boardFile)
    ]);
    const scene = parseBoardScene(raw);
    if (!scene.elements.length) {
      logger.warn(`Board for "${workspaceId}" at ${boardFile} has no elements to load.`);
      return null;
    }
    return { scene, modifiedAt: stats.mtimeMs };
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'there is no such file'
      : (error as Error).message;
    logger.warn(`Board for "${workspaceId}" not loaded from ${boardFile}: ${reason}`);
    return null;
  }
}

/**
 * The scene a board comes back with, out of the two places it may have been kept.
 *
 * The state this process saved last (`core/board-state.ts`) is the newer of the two by
 * definition — it is written a second after every change — so it is what the board comes
 * back as. Unless the tracked board file has been written *since*, which is what a pull, a
 * merge or a fresh export looks like from here: then the file is the base, because somebody
 * deliberately changed it, and the elements only this process ever knew about are put back on
 * top so that a draft with no copy anywhere else is not the price of updating the board.
 *
 * Sorted by `index` when both contributed. Excalidraw treats fractional indices as valid only
 * while they increase along the array, and an array that reads as broken has its indices
 * regenerated from the array order — which is how twenty labels once ended up underneath the
 * cards they label (`scripts/export-board.mjs`).
 */
function chooseSeed(
  workspaceId: string,
  boardFile: string | null,
  saved: SavedBoard | null,
  fromFile: { scene: BoardScene; modifiedAt: number } | null
): { scene: BoardScene; from: string } | null {
  if (saved && (!fromFile || saved.savedAt >= fromFile.modifiedAt)) {
    return { scene: saved.scene, from: saved.file };
  }
  if (!fromFile) return null;
  if (!saved) return { scene: fromFile.scene, from: String(boardFile) };

  const known = new Set(fromFile.scene.elements.map((element) => element.id));
  const only = saved.scene.elements.filter((element) => !known.has(element.id));
  const indexOf = (element: ServerElement): string => {
    const index = (element as unknown as { index?: unknown }).index;
    return typeof index === 'string' ? index : '';
  };
  const elements = [...fromFile.scene.elements, ...only]
    .sort((left, right) => (indexOf(left) < indexOf(right) ? -1 : indexOf(left) > indexOf(right) ? 1 : 0));

  logger.info(
    `${boardFile} is newer than ${saved.file} for "${workspaceId}", so it is the board; `
    + `${only.length} element(s) only this process had were kept from the saved state.`
  );
  return {
    scene: { elements, files: { ...saved.scene.files, ...fromFile.scene.files } },
    from: `${boardFile} (+ ${only.length} from ${saved.file})`
  };
}

/**
 * The board a project that has never had one comes up on, or nothing.
 *
 * `__dirname` is `dist/` once compiled, so the default is this build's own `docs/`, the way
 * `TOOL_DOCS_DIR` is — the repository's in a checkout and the package's in an installed copy,
 * where `files` ships it beside the documents its cards point at. A project registered through
 * the `+` gets a config with a name and possibly a `docsDir` and no `board` at all, which used
 * to mean a blank canvas: nothing explaining the section keys, the blocks or the tabs, and
 * `Alt+P` and `Alt+G` doing nothing at all, because those keys are declared by board data and
 * there was none.
 *
 * `undefined`, not falsy, exactly as `DOCS_DIR` and `LIBRARY` are read: an **explicitly empty**
 * setting is how a board says it wants new projects to come up blank, which is a thing somebody
 * has to be able to say now that unset no longer means none. Every self-contained check sets it
 * empty (`scripts/lib/spawn-canvas.mjs`) for the reason that helper deletes the rest of the
 * machine's configuration — a throwaway project growing a board it never asked for decides
 * assertions about element counts and about where a click lands, in checks that are about
 * neither. `scripts/check-welcome-board.mjs` is the one that unsets it again.
 */
const WELCOME_BOARD_SETTING = env('WELCOME_BOARD');
const WELCOME_BOARD_FILE = WELCOME_BOARD_SETTING === undefined
  ? path.resolve(__dirname, '../docs/welcome.excalidraw')
  : (WELCOME_BOARD_SETTING ? path.resolve(WELCOME_BOARD_SETTING) : null);

/**
 * The welcome board, for a project that has nothing else to come up as — or nothing.
 *
 * Three conditions, and each of them is a way of saying *nobody has been here yet*:
 *
 * - there is a welcome board to seed from at all: `WELCOME_BOARD` set empty is a board saying
 *   its projects come up blank, and that answer is honoured before anything else is read.
 * - the project declares no `board`. One that declares a file it cannot read is a project with
 *   a board and a problem, and it stays empty and says so — putting a welcome board over that
 *   would answer a broken path with a board the reader never asked for.
 * - nothing was chosen from the two places a board is kept, which the caller has already
 *   established by the time this runs.
 * - and this canvas has never written a state file for it *at all*. That is the strict form of
 *   "no saved state", and it is what makes this happen once: a board somebody emptied has a
 *   saved scene with no elements in it, which `readBoardState` reports as nothing to come back
 *   as — so the looser reading would put the welcome board back over a deliberate clear, every
 *   start, forever.
 *
 * Past the first seed nothing here runs again: the elements land in a store that is already
 * marked as worth saving, the file appears a second later, and every later start reads that.
 */
async function welcomeSeed(
  workspaceId: string,
  boardFile: string | null
): Promise<{ scene: BoardScene; from: string } | null> {
  if (!WELCOME_BOARD_FILE || boardFile) return null;
  if (await boardStateExists(workspaceId)) return null;

  const welcome = await readBoardFile(workspaceId, WELCOME_BOARD_FILE);
  if (!welcome) return null;

  logger.info(`"${workspaceId}" has no board of its own; seeding the welcome board.`);
  return { scene: welcome.scene, from: WELCOME_BOARD_FILE };
}

/**
 * Put one registered board's saved scene into its store, and say it is worth saving from now
 * on.
 *
 * Opt-in as far as the *tracked* file goes: a project that declares no `board` still grows no
 * file anywhere near itself, which is the only way a board that is genuinely meant to start
 * blank can stay blank. What it does gain is the state this process keeps of it — outside
 * every project, in the canvas's own state directory — because a draft on a board that
 * declares no file has even fewer places to survive than one on a board that does.
 *
 * What it also gains, and only on the very first start, is the welcome board: a project that
 * declares no `board` and that this canvas has never saved has nothing at all to show, and a
 * blank canvas is where every one of them used to arrive. `welcomeSeed` is the whole of that
 * decision, and it still writes nothing into the project.
 *
 * Seeded by the *normalised* id. `elementsFor` normalises its argument and the registry
 * does not, so the raw id would reach the same store — but `broadcast` compares against
 * what a socket registered, which is normalised, and a project id with a capital letter
 * would be seeded correctly and told to nobody.
 */
async function seedBoardFromFile(workspace: Workspace): Promise<void> {
  if (workspace.error) return;
  await seedBoard(normalizeWorkspaceId(workspace.id), workspace.boardFile, welcomeSeed);
}

/**
 * The same, for a board that is not a registered project: `default`.
 *
 * Which is the board of somebody who has registered nothing at all, and it used to be the
 * only board on the canvas that structurally could not be saved (#314) — seeding walked the
 * registry, so nothing ever called `persistBoardFor` for it, and the store itself was a plain
 * `Map` that could not have reported a change if anything had. It has no tracked board file
 * and never will: nothing on disk is a project's, so there is nothing to seed it from but the
 * state this canvas keeps of it.
 *
 * And no welcome board either, which is why `fallback` is a parameter rather than something
 * this function decides. `default` is not a project somebody registered and has no directory,
 * no documents and no settings behind it; a welcome board there would be a canvas somebody
 * opened to draw on, filled with cards about projects they have not added.
 */
async function seedBoard(
  workspaceId: string,
  boardFile: string | null,
  fallback?: (workspaceId: string, boardFile: string | null)
    => Promise<{ scene: BoardScene; from: string } | null>
): Promise<void> {
  const store = elementsFor(workspaceId);

  const [saved, fromFile] = await Promise.all([
    readBoardState(workspaceId),
    boardFile ? readBoardFile(workspaceId, boardFile) : Promise.resolve(null)
  ]);

  // After the read and before the first write, so a board that could not be read is still
  // saved from now on — and so that a failed read can never be written over what it failed
  // to read before anybody has seen it.
  persistBoardFor(workspaceId);

  // Empty at startup, which is when this runs — except for the twenty-odd milliseconds between
  // the port accepting and the boards being back, and one `POST /api/elements` in there is
  // enough (#468). The autosync is the likeliest caller: a browser reconnecting to a board that
  // has just restarted syncs its whole scene, every second.
  //
  // That used to return, and returning was the seed cancelling itself rather than declining to
  // overwrite. The saved scene was never loaded; the `return` was above the line that grants
  // this board permission to save, so nothing drawn on it for the rest of the process reached
  // the disk either; and the file was left holding the old scene, which the next start brought
  // back over everything the session did. So the scene goes *underneath* what is already there
  // instead. The one thing this must never do — land on top of a board somebody is working on —
  // it still cannot: `store.has` below is the whole of the guard this replaces, element by
  // element rather than all-or-nothing.
  const written = store.size;
  if (written) {
    logger.warn(`A write arrived before its saved board did: "${workspaceId}" already holds `
      + `${written} element(s), and the saved scene is being loaded underneath them.`);
    // That write reported a change to a board that had no permission to save yet, and a
    // dropped notification is not repeated. Said again now the permission exists, so a board
    // that took one write and is then left alone is still written out.
    scheduleBoardStateSave(workspaceId);
  }

  const chosen = chooseSeed(workspaceId, boardFile, saved, fromFile)
    ?? (fallback ? await fallback(workspaceId, boardFile) : null);
  if (!chosen) return;
  const scene = chosen.scene;

  const restored = scene.elements.filter((element) => !store.has(element.id));
  for (const element of restored) store.set(element.id, element);
  // Content-addressed and process-wide, so a file already held is the same file.
  for (const [id, file] of Object.entries(scene.files)) if (!files.has(id)) files.set(id, file);

  // A direct store write tells nobody. A browser that connected while the read was in
  // flight took its `initial_elements` from an empty store, and would sit on a blank canvas
  // until something else made it refetch. What it is told is what was actually put in: an
  // element the board already held is one that browser sent, and it is not news to anybody.
  broadcast({ type: 'elements_batch_created', elements: restored } as BatchCreatedMessage, workspaceId);

  const kept = scene.elements.length - restored.length;
  logger.info(`Loaded ${restored.length} element(s) into "${workspaceId}" from ${chosen.from}`
    + (kept ? `, leaving ${kept} the board already held` : ''));
}

/**
 * Give every board back the scene it was saved with — the registered ones, and `default`.
 *
 * Boards are read concurrently rather than in turn: one of them lives on the `wsl$` share,
 * where a read crosses the distro boundary and is slow when the distro is running and
 * refused when it is not — and none of that is a reason for the three local boards to wait.
 * A board that cannot be read is warned about and skipped, one board at a time, for the
 * reason `loadWorkspace` returns a broken project instead of hiding it.
 *
 * `default` is seeded whatever the registry says, including when it could not be read at all:
 * a canvas whose registry is unreadable is precisely a canvas somebody is about to draw on
 * with no project of their own, and that is the board this exists for. It is skipped only if
 * a registered project happens to carry that id, which would otherwise seed one store twice.
 */
async function seedBoardsFromFiles(): Promise<void> {
  let workspaces: Workspace[] = [];
  try {
    workspaces = await loadWorkspaces(registryPath());
  } catch (error) {
    logger.warn(`Could not look for boards to load: ${(error as Error).message}`);
  }

  const seeds = workspaces.map((workspace) => ({
    id: workspace.id,
    seed: () => seedBoardFromFile(workspace)
  }));
  if (!workspaces.some((workspace) => normalizeWorkspaceId(workspace.id) === DEFAULT_WORKSPACE_ID)) {
    seeds.push({
      id: DEFAULT_WORKSPACE_ID,
      seed: () => seedBoard(DEFAULT_WORKSPACE_ID, null)
    });
  }

  await Promise.all(seeds.map(async ({ id, seed }) => {
    try {
      await seed();
    } catch (error) {
      logger.warn(`Could not load the board for "${id}": ${(error as Error).message}`);
    }
  }));
}

/**
 * The restore above, as something a request can wait for.
 *
 * `Promise.resolve()` until `listen` replaces it, and that is not a placeholder standing in
 * for the real thing: nothing can reach a route before the port accepts, and the seed is
 * started from inside the callback that opens it.
 */
let boardsRestored: Promise<void> = Promise.resolve();

/**
 * Whether that has already happened, which after the first second or so it always has.
 *
 * The wait below costs a promise and a timer, and every read of every board for the rest of the
 * process would pay it to be told the same thing. This is what makes it a boolean read instead:
 * the window is the first twenty milliseconds of a start, and nothing reopens it.
 */
let boardsAreBack = false;

/**
 * How long a read of a board's contents waits for that board to have been read back.
 *
 * Two orders of magnitude above what it costs — forty saved boards are back in about
 * twenty-five milliseconds — because the number is not there to bound the normal case. It is
 * there for the board on the `wsl$` share whose read crosses a distro boundary: refused is
 * fast, but *hung* is not, and a read of a local board must not wait on that for ever. When it
 * expires the board is answered as it stands, which is the old behaviour, with the one thing
 * the old behaviour never had — a line saying the answer may be short.
 */
const BOARD_RESTORE_CEILING_MS = 10_000;

/** Said once. A ceiling that has expired once will expire on every read after it. */
let restoreCeilingSaid = false;

/**
 * Answer for a board only once it has been read back.
 *
 * The saved boards are put into their stores by `seedBoardsFromFiles`, which `listen` starts
 * and deliberately does not await — a slow read must not sit between the port opening and the
 * board being usable. The other end of that decision was never closed: for the twenty-odd
 * milliseconds between the two, the server was up, `/health` said `healthy`, and every read of
 * a board answered with an empty one. Not "not ready", not an error — a board with nothing on
 * it, which is indistinguishable from a board somebody lost the contents of. That is what
 * `scripts/check-notes-column-without-project-browser.mjs` reported as a draft not surviving a
 * restart, one run in four (#441), and what anything that auto-starts a canvas and reads it the
 * moment `/health` answers is standing in.
 *
 * So the reads that say *what is on this board* wait here, and nothing else does. `/health`
 * must not: it is the readiness probe the CLI, the MCP server and every check in `scripts/`
 * poll, and `core/canvas-client.ts` reads a non-200 from it as a foreign service on the port
 * rather than as a canvas still starting — delaying it, or answering 503 from it, would refuse
 * the board instead of the request.
 *
 * Nor do the writes, and #468 is where that was decided rather than assumed. A write in the
 * window used to destroy the session, which is worse than a read answering short — but the
 * repair belongs in `seedBoard`, which now loads the saved scene underneath whatever arrived
 * early instead of standing down. Waiting here would have cost every write the ceiling below on
 * a board whose restore has hung, on a canvas that syncs its whole scene once a second, and
 * would have left the case where that ceiling *expires* exactly as broken as it was.
 */
async function whenBoardsRestored(): Promise<void> {
  if (boardsAreBack) return;

  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<'expired'>((resolve) => {
    ceiling = setTimeout(() => resolve('expired'), BOARD_RESTORE_CEILING_MS);
    // Nothing here is a reason for the process to stay alive.
    ceiling.unref?.();
  });

  try {
    // Caught rather than propagated: a board that could not be read has already said so, one
    // board at a time, and a read of some *other* board is not the place to raise it again.
    const outcome = await Promise.race([
      boardsRestored.then(() => 'restored' as const, () => 'restored' as const),
      expiry
    ]);
    if (outcome === 'expired' && !restoreCeilingSaid) {
      restoreCeilingSaid = true;
      logger.warn(
        `The saved boards were still being read after ${BOARD_RESTORE_CEILING_MS} ms; `
        + 'answering reads with the boards as they stand. Anything not back yet will look empty.'
      );
    }
  } finally {
    if (ceiling) clearTimeout(ceiling);
  }
}

/** The agent writes to the repository, so every entrance carries the same two guards. */
function implementingRefused(res: Response): boolean {
  if (!IMPLEMENT_AGENT_CONFIGURED) {
    res.status(404).json({
      success: false,
      error: `Implementing is disabled. Set ${settingName('AGENT_BACKEND')} to one of ${KNOWN_BACKEND_NAMES}, or ${settingName('IMPLEMENT_AGENT')} to the agent command, to enable it.`
    });
    return true;
  }
  // This agent writes to the repository, which makes reaching this route from the network
  // strictly worse than reaching the issue route. `actingFor` rather than the bind alone since
  // #522: an approved device is a caller with a name and a revoke, which is the thing the bind
  // was standing in for the absence of.
  if (!actingFor(res)) {
    res.status(403).json({
      success: false,
      error: 'Implementing only runs while the server is bound to loopback, or for a device '
        + 'this board has approved.'
    });
    return true;
  }
  return false;
}

app.post('/api/issue-block/:id/implement', async (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';
  if (implementingRefused(res)) return;

  const workspaceId = workspaceIdFrom(req);
  const element = elementsFor(workspaceId).get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  const issueUrl = typeof custom.issueUrl === 'string' ? custom.issueUrl : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'This block has no issue to implement.' });
  }

  const answer = await beginImplement(workspaceId, issueUrl, {
    resume: req.body?.resume === true,
    interactive: req.body?.interactive === true
  });
  res.status(answer.status).json(answer.body);
});

/**
 * The same thing, for a shape the server has never seen.
 *
 * A mirrored card is drawn from GitHub and never synced, so there is no element id to name
 * it by — but there is an issue, and the issue is what is being implemented.
 *
 * `resume: true` continues an interrupted attempt instead of starting one. A flag on the
 * existing route rather than a route of its own, because it is one run either way: what
 * changes is a paragraph of the prompt, and every guard around it is the same.
 *
 * `interactive: true` asks for the tab to be one the reader can answer, and is a flag here
 * for the same reason: it is the same run, in the same worktree, with the same prompt. What
 * it changes is the command line — the print flags come off it, so everything downstream
 * that already reads the command's *shape* gives the run a pseudoterminal, hands it the
 * prompt as an argument and leaves stdin to the reader. This is #220's comment: the choice
 * between the two shapes was the operator's command line and a server restart, and it is now
 * also a click. The queue never asks for it — an interactive run does not end by itself.
 */
app.post('/api/implement', async (req: Request, res: Response) => {
  if (implementingRefused(res)) return;

  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'No issue URL was given.' });
  }

  const answer = await beginImplement(workspaceIdFrom(req), issueUrl, {
    resume: req.body?.resume === true,
    interactive: req.body?.interactive === true
  });
  res.status(answer.status).json(answer.body);
});

/**
 * Turn this workspace's queue on or off.
 *
 * Behind the same two guards as starting a run, and for the same reason: this is a switch
 * that spawns coding agents against a repository, one per free slot, with nobody clicking.
 * A canvas reachable from the network must not be able to flip it.
 *
 * Turning it on dispatches immediately rather than waiting out an interval — the click is
 * the moment somebody said "start draining", and a button that appeared to do nothing for
 * half a minute would be clicked again.
 */
app.post('/api/implement/queue', async (req: Request, res: Response) => {
  if (implementingRefused(res)) return;

  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'The queue is set with { "enabled": true | false }.' });
  }

  const workspaceId = workspaceIdFrom(req);
  const enabled = req.body.enabled === true;
  setQueueEnabled(workspaceId, enabled);
  syncQueueTimer();
  logger.info(`Queue: "${workspaceId}" is ${enabled ? 'on' : 'off'}`);
  if (enabled) void dispatchQueue(workspaceId);

  const workspaces = await loadWorkspaces(registryPath()).catch(() => []);
  res.json({
    success: true,
    queue: queueStateFor(workspaces.find((candidate) => candidate.id === workspaceId), workspaceId)
  });
});

/**
 * Clear a stuck implementation so the block can be tried again.
 *
 * The timeout used to guarantee that a wedged run could not hold a block in `running`
 * forever. Implementing has no timeout — a clock that kills a working agent halfway
 * through a change is worse than one that never fires — so that guarantee has to come
 * from somewhere, and this is it.
 *
 * This clears state; it does not stop an agent. Nothing here can reach into a process the
 * server no longer owns, and a button that claimed to would be lying. What it can do is
 * refuse while a run is in flight *in this process*, which is the case that actually
 * matters: the state on the element cannot tell a live run from an abandoned one, and the
 * server can.
 */
function resetImplement(res: Response, workspaceId: string, issueUrl: string): void {
  if (isImplementing(workspaceId, issueUrl)) {
    res.status(409).json({
      success: false,
      error: 'An implementation is running right now. Resetting would only hide it.'
    });
    return;
  }

  recordImplement(workspaceId, issueUrl, null);
  res.json({ success: true, issueUrl });
}

/**
 * The same reset again, addressed by element.
 *
 * Refused before the element is looked at, and that order is the point rather than tidiness:
 * this route read the store first, so a 404 for a block that is not on the board and a 400 for
 * one that is told a caller on the network which block ids this board holds — an oracle a
 * refusal written after the lookup would have left open. One question, asked first.
 */
app.delete('/api/issue-block/:id/implement', (req: Request, res: Response) => {
  if (offLoopback(res, 'An implementation record is reset')) return;

  const elementId = req.params.id ?? '';
  const workspaceId = workspaceIdFrom(req);
  const element = elementsFor(workspaceId).get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  const issueUrl = typeof custom.issueUrl === 'string' ? custom.issueUrl : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'This block has no issue to reset.' });
  }

  resetImplement(res, workspaceId, issueUrl);
});

/**
 * Just the implementation's state, with no issue read behind it.
 *
 * A card with a run in flight has to find out when it finishes, and it cannot be told:
 * there is no element for the socket to update. So it asks — and asking must not cost a
 * `gh` process each time, which is what reading through /api/issue would.
 *
 * With no `url`, every record for the workspace instead. Once several runs can be in
 * flight at once, "what is running right now" is a real question, and it used to have no
 * answer: the state was reachable only one issue at a time, by a caller who already knew
 * which issue to ask about. Finished runs come back too — one of the things worth knowing
 * is which run left a worktree behind.
 *
 * The queue rides on that same answer rather than on a route of its own: the mirror already
 * asks this once per poll, for the marks on the cards, and the toggle's two appearances have
 * to survive every redraw — so the state that decides them has to arrive with the redraw's
 * own data or it will be one poll behind. `queue` is **absent** rather than off when
 * implementing is disabled or the server is not bound to loopback, because a button that
 * cannot do anything should not be drawn at all.
 *
 * That last test is still not the funnel — it is `actingFor`, which asks whether this caller may
 * *act on this machine*, and the funnel asks who may read the records at all. It was the bind
 * alone until #522, on the reasoning that the toggle it decides turns `POST /api/implement/queue`
 * on and that route is bind-guarded with the rest of the implement agent, so drawing the button
 * on an interface-bound board would be a lie to whoever pressed it. That reasoning is why both
 * halves moved together rather than only this one: an approved device passes `actingFor` here
 * *and* at `implementingRefused`, so the toggle a device is drawn is a toggle that works, and the
 * operator on loopback of an interface-bound board is still shown nothing, because for them
 * nothing has changed.
 *
 * The funnel is #508/#518, and this was the closest thing here to a decided exemption — it
 * dropped `queue` off loopback on purpose, which is precisely the shape of a route somebody
 * looked at and half-guarded. What it went on answering was every run's state, its pull
 * request, its `error` text and the absolute path of the worktree it left on this machine.
 */
app.get('/api/implement', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Implementation records are read')) return;

  const workspaceId = workspaceIdFrom(req);
  const issueUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (issueUrl) {
    return res.json({ success: true, implement: readImplement(workspaceId, issueUrl) });
  }

  const offered = IMPLEMENT_AGENT_CONFIGURED && actingFor(res);
  const workspaces = offered
    ? await loadWorkspaces(registryPath()).catch(() => [])
    : [];

  res.json({
    success: true,
    runs: listImplement(workspaceId),
    concurrency: IMPLEMENT_CONCURRENCY,
    ...(offered
      ? { queue: queueStateFor(workspaces.find((candidate) => candidate.id === workspaceId), workspaceId) }
      : {})
  });
});

/** The same reset, for a mirrored card with no element behind it. */
app.delete('/api/implement', (req: Request, res: Response) => {
  if (offLoopback(res, 'An implementation record is reset')) return;

  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'No issue URL was given.' });
  }
  resetImplement(res, workspaceIdFrom(req), issueUrl);
});

/**
 * The issue behind a card, read live, with whatever is known about implementing it.
 *
 * Addressed by URL rather than by element because a mirrored card has no element. The
 * implement record rides along so selecting a card costs one round trip rather than two.
 */
app.get('/api/issue', async (req: Request, res: Response) => {
  // Reading is not writing, but it still spawns a process holding the user's gh
  // credentials — the same reason the run route is loopback-only.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'Issues only read while the server is bound to loopback.'
    });
  }

  const issueUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!isIssueUrl(issueUrl)) {
    return res.status(400).json({ success: false, error: issueUrlRefusal(issueUrl) });
  }

  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) {
    return res.status(400).json({
      success: false,
      error: workspace?.error ?? `Workspace "${workspaceId}" is not registered.`
    });
  }

  try {
    const issue = await issueMemo.read(workspaceId, issueUrl, () => fetchIssue(workspace, issueUrl));
    res.json({ success: true, issue, implement: readImplement(workspaceId, issueUrl) });
  } catch (error) {
    // 502: the failure is GitHub's or gh's, not the caller's request.
    res.status(502).json({ success: false, error: (error as Error).message });
  }
});

/**
 * Add an observation to an issue that already exists.
 *
 * Between the two agent runs there was nothing to say anything with. The issue agent is
 * told to end with the questions it could not answer, and the implement agent is told to
 * decide them alone because nobody can answer mid-run — so an answer, or anything the
 * observation missed, had to be typed on github.com in another window.
 *
 * Keyed by URL for the same reason implementing is: the panel also serves a mirrored card
 * the server has never seen, which has no element id to name it by.
 *
 * The loopback guard and nothing else. This writes to GitHub, so a canvas reachable from
 * the network must not reach it — but it starts no agent and touches no repository, so
 * `POST /api/project-board/move` is the precedent rather than the implement routes' opt-in
 * environment variable.
 */
app.post('/api/issue/comment', async (req: Request, res: Response) => {
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'Issues only take comments while the server is bound to loopback.'
    });
  }

  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!isIssueUrl(issueUrl)) {
    return res.status(400).json({ success: false, error: issueUrlRefusal(issueUrl) });
  }

  // Posted as typed, trailing newlines and all — the point of this route is that the text
  // arrives unchanged. Only "is there anything here at all" is judged, and an accidental
  // click on an empty box must not become an empty comment on somebody's issue.
  const body = typeof req.body?.body === 'string' ? req.body.body : '';
  if (!body.trim()) {
    return res.status(400).json({ success: false, error: 'An empty observation has nothing to add.' });
  }

  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) {
    return res.status(400).json({
      success: false,
      error: workspace?.error ?? `Workspace "${workspaceId}" is not registered.`
    });
  }

  try {
    await commentOnIssue(workspace, issueUrl, body);
  } catch (error) {
    // 502: the failure is GitHub's or gh's, not the caller's request.
    return res.status(502).json({ success: false, error: (error as Error).message });
  }

  // Read back so the panel can show the comment without a reload. Deliberately after the
  // post has been reported as succeeding: a read that fails is not a comment that failed,
  // and telling the reader otherwise would invite a second one.
  //
  // The memo is dropped first, because the comment just made whatever it holds wrong — and
  // the read that replaces it becomes what the next selection is served.
  issueMemo.forget(workspaceId, issueUrl);
  try {
    const issue = await issueMemo.read(workspaceId, issueUrl, () => fetchIssue(workspace, issueUrl));
    res.json({ success: true, issue });
  } catch (error) {
    logger.warn(`Commented on ${issueUrl} but could not read it back: ${(error as Error).message}`);
    res.json({ success: true, issue: null });
  }
});

// ─── Researching an issue again ───────────────────────────────
//
// **Add observations** above can only append. A comment cannot correct a body, and the next
// reader of an issue this board opened is an unattended coding agent — which is then asked to
// reconcile two texts that contradict each other, when what the reader wanted was one text
// that is right. So a first investigation that went the wrong way is rewritten rather than
// annotated: the same issue number, the same project card, the same comments.
//
// That is only defensible while nothing has been built against the issue, which is what the
// Todo gate below is. Rewriting a body under a live implement agent would change the
// specification behind its back, with no way to tell the agent that read the issue when it
// started.

/** What a recreate run has done so far, kept against the issue rather than a shape. */
interface RecreateRecord {
  state: 'running' | 'done' | 'failed';
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * What the run has spent, when the agent is willing to say.
   *
   * The same opt-in as everywhere else — null unless the configured command already asks for
   * a machine-readable stream — and here for the reason `docs/whats-next.md` gives about the
   * two research runs: they are one seam, not two, so a rewrite reports its spending the way
   * a first investigation does. See `src/core/agent-usage.ts`.
   */
  usage: AgentUsage | null;
}

/**
 * The runs, per workspace and issue URL.
 *
 * In memory and against the URL, because there is nothing else to hang it on: a mirrored card
 * has no element, has no `issueState` to hold `running`, and is redrawn from GitHub on every
 * poll. The panel polls this while its run is in flight, the way it polls the implement
 * record, and that is the whole lifetime — a recreate that was interrupted by a restart is
 * simply forgotten, which is honest: nothing on GitHub is left half-written by one, because
 * the edit an agent makes is a single call that either happened or did not.
 */
const recreateRuns = new Map<string, RecreateRecord>();
const recreateKey = (workspaceId: string, issueUrl: string): string => `${workspaceId}\n${issueUrl}`;

/**
 * Why this issue may not be researched again, or null when it may.
 *
 * Strict Todo, and strict about what "Todo" is: the workspace's own `projectTodoColumn`,
 * matched the way every other column lookup here is. A card in *No Status*, or in a column
 * somebody invented, has nothing started against it either — but "in Todo" is what the
 * observation this came from asked for, it is where a research run already puts a created
 * issue, and it is the rule a reader can predict without knowing this function.
 *
 * A board with no project has no column at all, so there is nothing to gate on and nothing is
 * read: a dormant board stays exactly as dormant as it was.
 */
async function todoColumnRefusal(workspace: Workspace, issueUrl: string): Promise<string | null> {
  if (!workspace.githubProject) return null;

  // Uncapped: the cap decides what is *drawn*, and a card hidden behind it would read here as
  // an issue that is not on the project at all. `readProjectBoard` follows every page of items
  // for the same reason — the page size used to be a second cap this one did not lift.
  const board = await readProjectBoard(workspace, { cardLimit: 0 });
  const target = todoColumn(workspace);
  const found = board.sections
    .flatMap((section) => section.cards.map((card) => ({ section, card })))
    .find((entry) => entry.card.url === issueUrl);

  if (!found) {
    return `${issueUrl} is not on this project, so there is no "${target.name}" column it could be waiting in.`;
  }
  if (found.section.name.trim().toLowerCase() !== target.name.trim().toLowerCase()) {
    return `Its card is in "${found.section.name}", not "${target.name}". An issue is only researched again `
      + 'while nothing has been started against it.';
  }
  return null;
}

/**
 * Rewrite an issue this board opened, from new observations.
 *
 * Guarded like the run route rather than like the comment route, because it spawns an agent:
 * `EXCALIDRAW_ISSUE_AGENT` set, loopback only, and one run in flight per issue URL.
 *
 * **It is not a second entrance to `POST /api/issue-block/:id`.** That route still answers 409
 * for any block carrying an `issueUrl`, and `DELETE` still refuses to make such a block
 * runnable — the guard that stops one observation becoming two issues is untouched, because
 * this one opens no issue at all.
 */
app.post('/api/issue/recreate', async (req: Request, res: Response) => {
  if (!ISSUE_AGENT_CONFIGURED) {
    return res.status(404).json({
      success: false,
      error: `Researching an issue again is disabled. Set ${settingName('ISSUE_AGENT')} to the agent command to enable it.`
    });
  }
  if (offLoopback(res, 'Issues are researched again')) return;

  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!isIssueUrl(issueUrl)) {
    return res.status(400).json({ success: false, error: issueUrlRefusal(issueUrl) });
  }

  // Kept as typed, trailing newlines and all: the observations are what the run is *about*,
  // and they are posted to the issue verbatim. Only "is there anything here at all" is judged.
  const observations = typeof req.body?.observations === 'string' ? req.body.observations : '';
  if (!observations.trim()) {
    return res.status(400).json({ success: false, error: 'There is nothing to research again.' });
  }

  const workspaceId = workspaceIdFrom(req);
  const key = recreateKey(workspaceId, issueUrl);
  if (recreateRuns.get(key)?.state === 'running') {
    return res.status(409).json({ success: false, error: 'A recreate is already in flight for this issue.' });
  }

  const implementing = readImplement(workspaceId, issueUrl);
  if (implementing) {
    return res.status(409).json({
      success: false,
      error: `This workspace holds an implementation against this issue (${implementing.state}). `
        + 'Rewriting it now would change the specification an agent has already read.'
    });
  }

  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) {
    return res.status(400).json({
      success: false,
      error: workspace?.error ?? `Workspace "${workspaceId}" is not registered.`
    });
  }

  const agent = agentCommandOrRefuse(
    res, workspace, ISSUE_AGENT_GRANTS, 'issue', 'Researching an issue again',
    settingName('ISSUE_AGENT')
  );
  if (!agent) return;

  // Read rather than taken from the memo: a thirty-second-old "OPEN" is fine for drawing a
  // panel and is not fine for deciding whether to send an agent at somebody's issue.
  try {
    const issue = await fetchIssue(workspace, issueUrl);
    if (issue.state.toUpperCase() === 'CLOSED') {
      return res.status(409).json({
        success: false,
        error: 'This issue is closed, so there is nothing left to research again.'
      });
    }
  } catch (error) {
    // 502: the failure is GitHub's or gh's, not the caller's request.
    return res.status(502).json({ success: false, error: (error as Error).message });
  }

  try {
    const refusal = await todoColumnRefusal(workspace, issueUrl);
    if (refusal) return res.status(409).json({ success: false, error: refusal });
  } catch (error) {
    return res.status(502).json({ success: false, error: (error as Error).message });
  }

  recreateRuns.set(key, {
    state: 'running', error: null, startedAt: new Date().toISOString(), endedAt: null, usage: null
  });
  // Answer immediately: an investigation takes minutes, and a request held open that long
  // looks indistinguishable from a hang. The panel polls the record.
  res.status(202).json({ success: true, state: 'running', issueUrl });

  /**
   * The totals onto the record, and nowhere else — there is nowhere else for a rewrite.
   *
   * A recreate leaves nothing on a shape while it runs, on purpose: a mirrored card has no
   * element at all. Ignored once the run has settled, so a report still in flight when the
   * process closes cannot resurrect a finished record.
   */
  const takeUsage = (usage: AgentUsage): void => {
    const existing = recreateRuns.get(key);
    if (!existing || existing.state !== 'running') return;
    recreateRuns.set(key, { ...existing, usage });
  };

  const settle = (state: 'done' | 'failed', error: string | null): void => {
    const existing = recreateRuns.get(key);
    recreateRuns.set(key, {
      state,
      error,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      // Read back rather than rebuilt from a literal, for the reason `carriedImplement`
      // exists: the figures arrive throughout the run, and a record reassembled at the end
      // would throw them away exactly when the total became worth reading.
      usage: existing?.usage ?? null
    });
    // Whatever was remembered about the issue is now wrong twice over — the comment below and,
    // on the success path, the body itself. Dropped rather than waited out, so selecting the
    // card straight afterwards shows what the run produced instead of what it replaced.
    issueMemo.forget(workspaceId, issueUrl);
  };

  try {
    // The observations reach the issue before the agent does, and they reach it as a comment.
    // Two reasons, and both are about what is left behind: a body that changed with nothing on
    // the issue explaining why is a body nobody can review, and a run that dies having posted
    // this has left the reader exactly where **Add observations** would have — which is a far
    // better failure than one that loses what they typed. Never fatal, for the same reason a
    // board write is not: the rewrite is the point, and `gh` drops a socket here often enough.
    try {
      await commentOnIssue(workspace, issueUrl, observations);
    } catch (error) {
      logger.warn(`Recreate ${issueUrl}: could not record the observations on the issue — ${(error as Error).message}`);
    }

    const result = await runReviseAgent(workspace, issueUrl, observations, {
      agent,
      notFoundVariable: settingName('ISSUE_AGENT_WSL'),
      onUsage: takeUsage
    });

    // A run is read as successful from the URL it printed, the way researching is — and here
    // there is one right answer. An agent that named a different issue opened one rather than
    // rewriting this one, and recording that as a rewrite would be the board believing that
    // the issue in front of the reader is now correct when it is untouched.
    if (result.ok && result.issueUrl === issueUrl) {
      settle('done', null);
      logger.info(`Recreate: ${issueUrl} was researched again and rewritten`);
    } else if (result.ok && result.issueUrl) {
      settle('failed', `The agent answered with ${result.issueUrl} rather than rewriting ${issueUrl}.`);
      logger.warn(`Recreate ${issueUrl}: the agent answered with ${result.issueUrl}`);
    } else {
      settle('failed', result.error ?? 'The agent finished without rewriting the issue.');
      logger.warn(`Recreate ${issueUrl} failed: ${result.error}`);
    }
  } catch (error) {
    settle('failed', (error as Error).message);
  }
});

/**
 * What a recreate has done so far, with no `gh` behind it.
 *
 * The panel cannot be told: a mirrored card has no element for the socket to update, and a
 * recreate leaves nothing on a shape while it runs. So it asks, and asking has to be free.
 *
 * Free to the panel, and behind the funnel to everybody else since #508/#518: the panel doing
 * the asking is on this machine, and the state of a run over somebody's repository is not a
 * thing to hand a caller who is not.
 */
app.get('/api/issue/recreate', (req: Request, res: Response) => {
  if (offLoopback(res, 'A recreate run is read')) return;

  const issueUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'No issue URL was given.' });
  }
  res.json({
    success: true,
    recreate: recreateRuns.get(recreateKey(workspaceIdFrom(req), issueUrl)) ?? null
  });
});

/**
 * The issue behind a block, read live.
 *
 * Read at selection time rather than copied onto the element at creation time: the body
 * is kilobytes that would otherwise ride in every autosync payload and every export, and
 * it would go stale as soon as anyone edited the issue on GitHub.
 */
app.get('/api/issue-block/:id/issue', async (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';

  // Reading is not writing, but it still spawns a process holding the user's gh
  // credentials — the same reason the run route is loopback-only.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'Issue blocks only read while the server is bound to loopback.'
    });
  }

  const workspaceId = workspaceIdFrom(req);
  const element = elementsFor(workspaceId).get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  const issueUrl = typeof custom.issueUrl === 'string' ? custom.issueUrl : '';
  if (!issueUrl) {
    return res.status(404).json({ success: false, error: 'This block has no issue yet.' });
  }

  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) {
    return res.status(400).json({
      success: false,
      error: workspace?.error ?? `Workspace "${workspaceId}" is not registered.`
    });
  }

  try {
    // The same memo the URL-addressed route uses: one issue, one read, whichever shape asked
    // for it — an authored block and a mirrored card must not each spawn a `gh` of their own.
    const issue = await issueMemo.read(workspaceId, issueUrl, () => fetchIssue(workspace, issueUrl));
    res.json({ success: true, issue });
  } catch (error) {
    // 502: the failure is GitHub's or gh's, not the caller's request.
    res.status(502).json({ success: false, error: (error as Error).message });
  }
});

// ─── Project board mirror ─────────────────────────────────────
//
// A region of the canvas showing the workspace's GitHub project: one section per option
// of a single-select field, cards newest-first, and a drag between columns written back.
// Dormant unless a project says `githubProject`, so a board that has none never grows one.
//
// Both directions go through `gh`. It is already required by the issue agent, and the PATH
// and WSL traps around it are already paid for. It does *not* arrive with the `project`
// scope — `gh auth login` never asks for it, so both directions fail on a default login
// until `gh auth refresh -s project` has been run once, and `classifyGhFailure` is what says
// so rather than letting GitHub's token inventory reach the canvas alone (#319).

/**
 * The workspace a project-board request is about, or a reason it is not usable.
 *
 * The reason is carried alongside the sentence rather than left to be read out of it. Both
 * answer 404 — the canvas draws nothing and says nothing for either, because neither is
 * somebody's board being broken — but a payload whose only machine-readable part is English
 * prose is one the next reader has to parse to act on.
 */
type ProjectWorkspaceRefusal = {
  error: string;
  reason: 'no-workspace' | 'no-project';
  /**
   * The board itself, when there is one — a project refused is not always a workspace refused.
   *
   * Only `no-project` carries it, and only one caller reads it: the founder column, which is
   * drawn on this very answer and takes its name from the workspace. A board that renamed the
   * column it publishes into and then dropped its `githubProject` would otherwise be drawn a
   * second column under the default name, which is the duplicate this column is built to avoid.
   */
  workspace?: Workspace;
};

/**
 * The founder column this board's canvas should draw, or nothing at all to draw.
 *
 * It rides on the project-board answer rather than on a route of its own because it is drawn
 * by the region that answer draws, on the same twenty-second poll — the mirror is rebuilt
 * from scratch every time and remembers nothing, so what it knows has to arrive with the
 * draw. `GET /api/founder-actions` (#547) is a different question with a different consumer:
 * the panel, which reads one record whole and answers it.
 *
 * **It is sent on the 404 as well**, which is the case this column exists for. The first
 * founder action a fresh clone produces is "sign `gh` in", and a clone that has not signed in
 * has no `githubProject` either — so the board with no project is precisely the board with
 * something waiting, and a payload that only carried this on success would draw the column
 * everywhere except where it is needed first.
 *
 * The name is the workspace's own answer, through `founderColumn` in `project-board.ts` —
 * the resolver #540 publishes a draft item with. Where the project already declares a column
 * of that name, the layout draws none of its own, so the two cannot show the same work twice.
 */
function founderMirrorColumn(
  workspaceId: string,
  workspace: Workspace | null
): { columnName: string; cards: FounderCard[] } | null {
  const open = openFounderActions(workspaceId);
  if (open.length === 0) return null;
  return {
    // The same answer `publishFounderAction` publishes into, from the same resolver: one
    // column named once. A board that has no workspace at all — an id nobody registered —
    // gets the default, which is what a board with no opinion would have got anyway.
    columnName: workspace ? founderColumn(workspace).name : DEFAULT_FOUNDER_COLUMN,
    cards: open.map((record) => ({ key: record.key, title: record.fields.title })),
  };
}

async function projectWorkspace(
  req: Request
): Promise<{ workspace: Workspace } | ProjectWorkspaceRefusal> {
  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return {
      error: `Workspace "${workspaceId}" is not registered, so it has no GitHub project.`,
      reason: 'no-workspace'
    };
  }
  if (workspace.error) {
    return { error: `Workspace is unusable: ${workspace.error}`, reason: 'no-workspace' };
  }
  if (!workspace.githubProject) {
    return {
      error: 'This board has no "githubProject" in its board.config.json.',
      reason: 'no-project',
      workspace
    };
  }
  return { workspace };
}

app.get('/api/project-board', async (req: Request, res: Response) => {
  // Reading is not writing, but it still spawns a process holding the user's gh
  // credentials — the same reason the issue block's read route is loopback-only.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'The project board only reads while the server is bound to loopback.'
    });
  }

  const resolved = await projectWorkspace(req);
  const founder = founderMirrorColumn(
    workspaceIdFrom(req),
    ('workspace' in resolved ? resolved.workspace : null) ?? null
  );
  if ('error' in resolved) {
    // 404 rather than 400: the feature is absent for this board, not misused.
    // The founder column rides along all the same — see `founderColumn` for why this answer
    // is the one that most needs it.
    return res.status(404).json({
      success: false, reason: resolved.reason, error: resolved.error, ...(founder ? { founder } : {})
    });
  }

  try {
    const board = await readProjectBoard(resolved.workspace);
    res.json({ success: true, board, ...(founder ? { founder } : {}) });
  } catch (error) {
    // 422 rather than 404, and that split is the point of #317. A 404 is the canvas's
    // instruction to draw nothing and say nothing, which is right for the boards that have no
    // project and wrong for the one board whose operator wrote a URL and got silence. The
    // `reason` says the same thing in the body, for a reader that has the payload and not the
    // status line.
    if (error instanceof ProjectUrlUnparseable) {
      return res.status(422).json({
        success: false, reason: 'bad-project-url', error: (error as Error).message
      });
    }
    if (error instanceof NoProjectConfigured) {
      return res.status(404).json({
        success: false, reason: 'no-project', error: (error as Error).message
      });
    }
    // 502: the failure is GitHub's or gh's, not the caller's request.
    logger.warn(`Project board read failed: ${(error as Error).message}`);
    res.status(502).json({ success: false, error: (error as Error).message });
  }
});

/**
 * `GET /api/github-status` — whether `gh` is there and logged in, for this board.
 *
 * Loopback-only, like every other route that runs `gh`: this one spawns nothing on anybody's
 * behalf, but what it answers with is the account name and the token's scopes, and a canvas
 * reachable from the network must not hand those out.
 *
 * The consumer is the canvas, on a poll that just failed. `GET /api/project-board` can say
 * that `gh` refused; only this can say *why* — not installed, not logged in, or logged in
 * without the `project` scope, which are three different things for the reader to go and do.
 */
app.get('/api/github-status', async (req: Request, res: Response) => {
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'The GitHub status only answers while the server is bound to loopback.'
    });
  }

  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(registryPath()).catch(() => []);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null;

  // A workspace that is not registered, or one the registry could not resolve, is still a
  // question this route can answer — about the host's own `gh`. Refusing would hide the one
  // failure most likely to be behind an unusable board on a fresh clone.
  const target = workspace && !workspace.error ? workspace : null;

  try {
    const status = await ghStatusMemo.read(
      target ? target.id : `${workspaceId} host`,
      GH_STATUS_KEY,
      () => readGithubStatus(target)
    );
    res.json({ success: true, workspace: target ? target.id : null, gh: status });
  } catch (error) {
    // `readGithubStatus` turns every failure into a status rather than an exception, so this
    // is the registry or the environment giving way underneath it. Reported rather than
    // swallowed: a canvas that asked why GitHub is broken must not be answered with silence
    // by the route that exists to end silence.
    logger.warn(`GitHub status could not be read: ${(error as Error).message}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * Move a card to another column.
 *
 * Behind the same loopback guard as the issue block's run route, and for a stronger
 * reason: this one writes. A canvas reachable from the network must not be able to
 * rearrange somebody's project board.
 */
app.post('/api/project-board/move', async (req: Request, res: Response) => {
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'The project board only moves cards while the server is bound to loopback.'
    });
  }

  const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId.trim() : '';
  const optionId = typeof req.body?.optionId === 'string' ? req.body.optionId.trim() : '';
  if (!itemId || !optionId) {
    return res.status(400).json({ success: false, error: 'A move needs an itemId and an optionId.' });
  }

  const resolved = await projectWorkspace(req);
  if ('error' in resolved) {
    return res.status(404).json({
      success: false, reason: resolved.reason, error: resolved.error
    });
  }

  try {
    const board = await moveCard(resolved.workspace, itemId, optionId);
    res.json({ success: true, board });
  } catch (error) {
    // The same split as the read route above, and here for consistency rather than because a
    // drag can reach it: a card cannot be dragged on a board whose mirror never drew.
    if (error instanceof ProjectUrlUnparseable) {
      return res.status(422).json({
        success: false, reason: 'bad-project-url', error: (error as Error).message
      });
    }
    if (error instanceof NoProjectConfigured) {
      return res.status(404).json({
        success: false, reason: 'no-project', error: (error as Error).message
      });
    }
    if (error instanceof NotOnThisBoard) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }
    logger.warn(`Project board move failed: ${(error as Error).message}`);
    res.status(502).json({ success: false, error: (error as Error).message });
  }
});

// ─── Library API (shared shapes) ──────────────────────────────
//
// Recurring shapes were rebuilt by hand on every board, so consistency depended on
// repeating literal coordinates and colours. A library turns them into named pieces.
// A project's own library wins over the shared one, so a project can extend or
// override the common set without editing it.
async function readLibrary(filePath: string): Promise<unknown[]> {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  if (!Array.isArray(parsed?.libraryItems)) {
    throw new Error('Not an .excalidrawlib file: no libraryItems array');
  }
  return parsed.libraryItems;
}

/**
 * The shared library this build ships with, beside the server rather than beside the caller.
 *
 * `docs/shared-library.md` says every board without a library of its own depends on this one
 * file, and it is the only place an issue block comes from — `customData.kind = "issue"` is not
 * something any Excalidraw control sets. It was reachable only through `EXCALIDRAW_LIBRARY`, so
 * an installed copy, or a checkout whose operator never exported the variable, offered no shared
 * source at all and the `+` on the notes column answered a toast.
 *
 * Resolved from this module rather than from the working directory: `__dirname` is `<root>/dist`
 * in a checkout and `<package>/dist` in an installed copy, and `../docs` is the shipped file in
 * both.
 */
const packagedLibrary = path.join(__dirname, '..', 'docs', 'blocks.excalidrawlib');

app.get('/api/library', async (req: Request, res: Response) => {
  if (offLoopback(res, 'The library is read')) return;

  const sources: { origin: string; path: string }[] = [];

  // `??`, not `||`: an *explicitly empty* `EXCALIDRAW_LIBRARY` is how a board says it wants no
  // shared shapes at all, which is a thing a workspace shipping its own set needs to be able to
  // say now that unset no longer means none.
  const shared = env('LIBRARY') ?? packagedLibrary;
  if (shared) {
    sources.push({ origin: 'shared', path: path.resolve(shared) });
  }

  const workspaceId = workspaceIdFrom(req);
  if (workspaceId !== DEFAULT_WORKSPACE_ID) {
    const workspaces = await loadWorkspaces(registryPath());
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace?.libraryFile) {
      sources.push({ origin: 'workspace', path: path.resolve(workspace.libraryFile) });
    }
  }

  const libraryItems: unknown[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    try {
      libraryItems.push(...(await readLibrary(source.path)));
    } catch (error) {
      // A broken library must not block the canvas: the board is still usable
      // without its shapes, and a blank page would hide the real problem.
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `not found: ${source.path}`
        : (error as Error).message;
      errors.push(`${source.origin} library ${reason}`);
      logger.warn(`Library skipped — ${source.origin}: ${reason}`);
    }
  }

  res.json({ success: true, libraryItems, errors });
});

// ─── The terminal ─────────────────────────────────────────────
//
// A shell the server owns, running in a workspace, streaming as it goes. It is a strictly
// worse thing to leave reachable than the issue block — that one spawns a process with a
// fixed prompt, this one runs whatever arrives — so it copies the issue block's guards
// exactly: opt in by environment variable, loopback only, and a capped number of sessions
// per workspace.
//
// The count was one and is now `TERMINAL_SESSION_LIMIT`, which is a guard **relaxed** rather
// than removed: a page that could ask in a loop would otherwise be asking for as many shells
// as it liked. The other two are untouched.
//
// `EXCALIDRAW_TERMINAL` unset means these routes do not exist. Not "answer 403", not
// "answer with an empty session": 404, the same shape the issue block uses, so a canvas
// that never turned it on cannot tell a disabled feature from an absent one.
const TERMINAL_SETTING = env('TERMINAL') || null;

/**
 * Every session, by board and then by id.
 *
 * Two levels rather than a joined key, because both questions get asked: "which sessions
 * does this board have" is the list a viewer connects into, and "which session is this" is
 * every route below.
 */
const terminalSessions = new Map<string, Map<string, TerminalSession>>();

/** What the next session on a board is called. Never reused, so an id is never ambiguous. */
const terminalCounters = new Map<string, number>();

function terminalSessionsFor(workspaceId: string): Map<string, TerminalSession> {
  const existing = terminalSessions.get(workspaceId);
  if (existing) return existing;
  const created = new Map<string, TerminalSession>();
  terminalSessions.set(workspaceId, created);
  return created;
}

/** Short and readable, because it is also what a tab on the block is labelled with. */
function nextTerminalId(workspaceId: string): string {
  const next = (terminalCounters.get(workspaceId) ?? 0) + 1;
  terminalCounters.set(workspaceId, next);
  return `s${next}`;
}

/** One session, as a viewer that has not been watching needs it. */
function terminalReplay(session: TerminalSession): Record<string, unknown> {
  return { session: session.summary(), scrollback: session.scrollback, sequence: session.sequence };
}

/**
 * The two guards, in one place.
 *
 * Returns true when the request has been answered and the caller must stop. Written once
 * rather than per route because five routes with the guards copied five times is five
 * chances to leave one out, and the one left out would be the hole.
 */
function terminalRefused(res: Response): boolean {
  if (!TERMINAL_SETTING) {
    res.status(404).json({
      success: false,
      error: `The terminal is disabled. Set ${settingName('TERMINAL')} to enable it.`
    });
    return true;
  }
  // A shell on this port is remote code execution for anyone who can reach it — for *anyone*,
  // which since #522 is no longer the same set as "anyone off this machine": `actingFor` reads
  // the approved device the token gate resolved, and an approved device is somebody rather than
  // anyone.
  if (!actingFor(res)) {
    res.status(403).json({
      success: false,
      error: 'The terminal only runs while the server is bound to loopback, or for a device '
        + 'this board has approved.'
    });
    return true;
  }
  return false;
}

/**
 * The session a request names, or the answer explaining why there is none.
 *
 * The id is optional, and what makes that safe is that its absence is never *guessed* at.
 * With one session open there is nothing to be ambiguous between, and the routes stay
 * scriptable by hand the way `docs/terminal.md` describes them. With several, an unnamed
 * request is a 400 that lists them rather than a shell chosen by iteration order — "whichever
 * one is open" is precisely the defect that made tabs impossible.
 */
function requireTerminal(req: Request, res: Response): TerminalSession | null {
  const sessions = terminalSessionsFor(workspaceIdFrom(req));
  const named = typeof req.body?.sessionId === 'string'
    ? req.body.sessionId
    : (typeof req.query.sessionId === 'string' ? req.query.sessionId : null);

  if (named) {
    const session = sessions.get(named);
    if (!session) {
      res.status(404).json({ success: false, error: `No terminal session "${named}" is open for this board.` });
      return null;
    }
    return session;
  }

  if (sessions.size === 0) {
    res.status(404).json({ success: false, error: 'No terminal session is open for this board.' });
    return null;
  }
  if (sessions.size > 1) {
    res.status(400).json({
      success: false,
      error: `This board has ${sessions.size} terminal sessions open, so the request must name one in "sessionId".`,
      sessions: Array.from(sessions.keys())
    });
    return null;
  }
  return sessions.values().next().value ?? null;
}

/**
 * Whether a session could be opened at all, for a caller with no response to write.
 *
 * `res` is optional and null is not "no opinion": it is the board asking about *itself*, for a
 * run it is about to start on its own account, where there is no caller and the bind is the
 * whole answer. A request that has one passes it, so that a paired device is offered the tab
 * the same route would then give it.
 */
function terminalAvailable(res: Response | null = null): boolean {
  return Boolean(TERMINAL_SETTING) && actingFor(res);
}

/** What opening a session came to, for a caller that has to say why it did not. */
type TerminalStart =
  | { ok: true; session: TerminalSession }
  | { ok: false; reason: 'cap' | 'error'; error: string };

/**
 * Open a session on a board, however it was asked for.
 *
 * The route was the only entrance until a run needed one too, and a second copy of this
 * would be a second place for the cap to be counted, the id to be allocated and the
 * announcement to be broadcast — three things a board can only survive having once. So both
 * come through here, and the *only* difference between them is what is in `options`: a
 * reader's session names no command of its own, no directory and no owner, which is what
 * keeps it byte for byte the session it was.
 *
 * `watch` is what a caller that is not a socket needs: the chunks and the ending, as they
 * happen. The broadcast happens either way — a run being watched by the server is still a
 * run every open board should see.
 */
async function startTerminalSession(
  workspace: Workspace,
  shellCommand: string,
  pty: PtyModule | null,
  options: TerminalSessionOptions = {},
  watch: { onOutput?: (chunk: string) => void; onExit?: (code: number | null) => void } = {}
): Promise<TerminalStart> {
  const workspaceId = workspace.id;
  const sessions = terminalSessionsFor(workspaceId);
  if (sessions.size >= TERMINAL_SESSION_LIMIT) {
    return {
      ok: false,
      reason: 'cap',
      error: `This board already has ${sessions.size} terminal sessions open, `
        + `which is the cap of ${TERMINAL_SESSION_LIMIT}. Close one first.`
    };
  }

  const sessionId = nextTerminalId(workspaceId);
  let session: TerminalSession;
  try {
    session = new TerminalSession(sessionId, workspace, shellCommand, {
      // The two readers of one stream, kept apart. The tap reads for a pull request URL and
      // for token counts, and both live in the JSON envelopes the transcript has rendered
      // away by the time `onOutput` fires — so the tap takes the raw chunk and only the
      // browser is sent the readable one.
      onRaw: (data) => {
        watch.onOutput?.(data);
      },
      onOutput: (data, sequence) => {
        broadcast({ type: 'terminal_output', sessionId, data, sequence } as WebSocketMessage, workspaceId);
      },
      onExit: (code) => {
        // Dropped from the map here rather than on the DELETE, because a shell that ended
        // on its own — `exit`, or a crash — has to free the slot too. Only if it is still
        // the one under that id: ids are never reused, so this is belt and braces, but a
        // session evicting a successor is exactly the bug the old single-slot map could have.
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        broadcast({ type: 'terminal_exit', sessionId, code } as WebSocketMessage, workspaceId);
        watch.onExit?.(code);
      }
    }, pty, options);
  } catch (error) {
    logger.error('Could not start a terminal:', error);
    return { ok: false, reason: 'error', error: (error as Error).message };
  }

  // A ConPTY reports no process id until its console host has connected, and a session
  // announced before then would carry a 0 into the block and into `taskkill` on the way out.
  await session.started;

  sessions.set(sessionId, session);
  broadcast({
    type: 'terminal_session',
    session: session.summary(),
    scrollback: session.scrollback,
    sequence: session.sequence
  } as WebSocketMessage, workspaceId);

  return { ok: true, session };
}

app.post('/api/terminal', async (req: Request, res: Response) => {
  if (terminalRefused(res)) return;

  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(registryPath());
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return res.status(400).json({
      success: false,
      error: `Workspace "${workspaceId}" is not registered, so there is no project to run in.`
    });
  }
  if (workspace.error) {
    return res.status(400).json({ success: false, error: `Workspace is unusable: ${workspace.error}` });
  }

  // Which mode this session will be in has to be settled before the shell is named: the
  // default shell is spelled differently for each. PowerShell's `-Command -` refuses to
  // start at all when stdin is a terminal, so a PTY session asks for the plain REPL.
  const pty = await loadPty();
  // A command in the body names what to run instead of the configured shell, and a `cwd`
  // names where. Neither grants anything the route did not already grant — a shell is a
  // thing you type commands and `cd` into — and both are still behind the same three
  // guards. They exist because the server itself needs to ask for a session that is not the
  // default one, and a facility only the server can reach is one nothing can check by hand.
  const asked = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
  const shellCommand = asked || shellCommandFrom(TERMINAL_SETTING, workspace, pty ? 'pty' : 'pipe');
  if (!shellCommand) {
    return res.status(404).json({
      success: false,
      error: `The terminal is disabled. Set ${settingName('TERMINAL')} to enable it.`
    });
  }
  // One path, spelled the way the caller's own environment spells it: inside a WSL distro
  // only `innerPath` is ever used, and outside one only `path` is, so a caller that gives
  // the right spelling for its workspace is right in both.
  const cwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
    ? { path: req.body.cwd.trim(), innerPath: req.body.cwd.trim() }
    : null;

  const started = await startTerminalSession(workspace, shellCommand, pty, { directory: cwd });
  if (!started.ok) {
    // Still a 409 for the cap, and still for the same reason it was one when the cap was 1:
    // the number of shells a board may run is a guard, and a request past it is a conflict
    // with that guard rather than a request that failed. It names the cap, because a refusal
    // that does not say what the limit is leaves a caller retrying against a wall it cannot see.
    if (started.reason === 'cap') {
      return res.status(409).json({
        success: false,
        error: started.error,
        sessions: Array.from(terminalSessionsFor(workspaceId).values()).map((one) => one.summary())
      });
    }
    return res.status(500).json({ success: false, error: started.error });
  }

  // 202, like starting an agent: the shell is running, and what it produces arrives over
  // the socket rather than in this response.
  res.status(202).json({ success: true, session: started.session.summary() });
});

/**
 * A place for an implementation to run where the board can show it, or nothing at all.
 *
 * Nothing at all whenever the terminal is not there to be had — the two opt-ins are separate
 * switches and always were, so a board that enabled implementing and not the terminal must
 * go on implementing exactly as it did. Everything past that point is `runAgent`'s to fall
 * back from, which is why this returns null rather than refusing.
 *
 * **Which of the two kinds of tab it is, the invocation says.** A run whose prompt goes to
 * stdin ends it there, so the session is opened on pipes — a pseudoterminal has no end of file
 * to give, see `TerminalSessionOptions.input`. A run whose prompt travels as an argument keeps
 * stdin for the reader, so it is given a terminal and the tab is something to answer rather
 * than something to watch. With no PTY binding to be had there is no interface to draw either,
 * so that run falls back to the first kind.
 *
 * **That used to be read off the operator's command line, and the argument for reading it was
 * a good one that has stopped applying.** It ran: the board must not append flags to a command
 * it does not own, so the shape of what the operator wrote is the only honest signal, and a
 * pattern looking for `-p` is exactly as legitimate as the one looking for
 * `--output-format stream-json` that turns on the token counts. Both halves are still true of
 * the `raw` backend, which is every board configured today, and `agents/raw.ts` is where those
 * two patterns now live, private to it. Neither is true of
 * a *named* backend: it builds the argv, so writing a flag into it is not rewriting anybody's
 * command, and `codex exec --json` is non-interactive and streaming while saying neither flag —
 * read the old way it would have been handed a pseudoterminal it cannot use and then, because
 * a pty tab is taken for an interface, had its exit code thrown away. So the question is asked
 * of `AgentInvocation.prompt.via`, which every backend answers about the argv it wrote itself.
 */
function implementTerminalHost(workspace: Workspace, issueUrl: string): AgentHost | null {
  if (!terminalAvailable()) return null;

  return async ({ adapter, invocation, directory, prompt, onOutput }) => {
    let announce: (code: number | null) => void = () => { /* replaced below */ };
    const exited = new Promise<number | null>((resolve) => { announce = resolve; });

    // Loaded only for a run that could use one, and `prompt.stdin` is what says so: a binding is
    // worth having exactly where stdin is being kept for a reader. A run whose prompt goes on
    // stdin took `null` here from the day this existed — a pseudoterminal has no end of file to
    // close the prompt with — and a headless run that merely takes its prompt on argv, which is
    // `codex exec --json`, wants pipes for a different reason: a pseudoterminal wraps its output
    // at `cols`, and a wrapped JSON envelope is no longer JSON. Neither is a regular expression
    // over the command line a second time.
    const pty = invocation.prompt.stdin === 'reader' ? await loadPty() : null;
    const started = await startTerminalSession(workspace, invocation.line, pty, {
      directory,
      owner: { agent: 'implement', issueUrl, label: issueTabLabel(issueUrl) },
      input: prompt,
      agent: { adapter, invocation }
    }, { onOutput, onExit: (code) => announce(code) });

    if (!started.ok) {
      logger.info(`${issueUrl} is being implemented without a tab: ${started.error}`);
      return null;
    }

    // On the record alone, like the token counts and for the same reason: it arrives in the
    // middle of a run, and writing it onto every element carrying the issue would bump a
    // version and broadcast an update for something no block with nothing selected can use.
    recordImplementTerminal(workspace.id, issueUrl, started.session.id);

    return {
      id: started.session.id,
      exited,
      close: () => started.session.close(),
      // Asked of the session rather than of the command a second time: what it actually got
      // is the answer, and a machine with no binary for its platform gets `pipe` from a
      // command line that reads interactive.
      interactive: started.session.mode === 'pty' && !started.session.readOnly,
      // A pseudoterminal is connected on a thread of its own and reports `0` until it is, so
      // anything that is not a real pid is `null`: no evidence at all is better than evidence
      // about process zero.
      pid: started.session.pid && started.session.pid > 0 ? started.session.pid : null
    };
  };
}

/** What the tab says: the issue, short enough to be a tab. */
function issueTabLabel(issueUrl: string): string {
  const number = /\/issues\/(\d+)/.exec(issueUrl)?.[1];
  return number ? `#${number}` : 'issue';
}

// A list, in the order the sessions were opened, each with its own transcript. Not "the
// session and its scrollback" any more: the singular was the shape of the old rule, and a
// caller that reads one field cannot tell a board with two tabs from a board with one.
app.get('/api/terminal', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;

  const sessions = terminalSessionsFor(workspaceIdFrom(req));
  res.json({
    success: true,
    limit: TERMINAL_SESSION_LIMIT,
    sessions: Array.from(sessions.values()).map((session) => ({
      ...session.summary(),
      scrollback: session.scrollback,
      sequence: session.sequence
    }))
  });
});

app.post('/api/terminal/input', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;
  const session = requireTerminal(req, res);
  if (!session) return;

  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  if (!data) {
    return res.status(400).json({ success: false, error: 'Nothing to send: "data" must be a non-empty string.' });
  }

  // A session whose stdin was spent on a prompt has nothing for these bytes to reach, and
  // `write()` drops them. Answering 202 with a sequence number for a dropped keystroke is
  // reporting delivery that did not happen — every layer above then agrees the agent was
  // told something nobody told it. 409, like the cap: a conflict with what this session is,
  // not a request that failed.
  if (session.readOnly) {
    return res.status(409).json({
      success: false,
      readOnly: true,
      error: `Terminal session "${session.id}" is read-only: its stdin was spent on the `
        + 'prompt of the agent running in it, so there is nothing a keystroke can reach.'
    });
  }

  // 202 rather than 200: the shell has been handed the bytes, and what it does with them
  // comes back over the socket. Waiting here for output would be waiting for a prompt that
  // a piped shell never prints.
  res.status(202).json({ success: true, sequence: session.write(data) });
});

app.post('/api/terminal/resize', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;
  const session = requireTerminal(req, res);
  if (!session) return;

  const cols = Number(req.body?.cols);
  const rows = Number(req.body?.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
    return res.status(400).json({ success: false, error: 'cols and rows must both be positive numbers.' });
  }

  session.resize(Math.floor(cols), Math.floor(rows));
  broadcast({
    type: 'terminal_resized',
    sessionId: session.id,
    cols: Math.floor(cols),
    rows: Math.floor(rows)
  } as WebSocketMessage, workspaceIdFrom(req));
  res.json({ success: true, session: session.summary() });
});

app.delete('/api/terminal', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;
  const session = requireTerminal(req, res);
  if (!session) return;

  session.close();
  // By id, not by board: closing one tab must leave the others running, and a delete keyed
  // on the workspace would take the whole strip with it.
  terminalSessionsFor(workspaceIdFrom(req)).delete(session.id);
  res.json({ success: true, closed: true, sessionId: session.id });
});

/**
 * Nothing outlives the server.
 *
 * A shell is a process, and a process whose parent has gone is a process nobody can stop
 * from the board any more — the same shape as the constraint `docs/issue-block.md` records
 * about a reset: nothing here can reach into a process the server no longer owns. So the
 * sessions are closed on the way out rather than left to be inherited.
 */
function closeAllTerminals(): void {
  for (const sessions of terminalSessions.values()) {
    for (const session of sessions.values()) session.close();
  }
  terminalSessions.clear();
}

// On `exit` alone, and not on SIGTERM or SIGINT. Importing this module must not start the
// server — `isMainModule` at the bottom of the file is that rule — and a signal handler
// registered here would be registered by an importer too, which in Node means Ctrl+C stops
// terminating that process. `exit` has no such effect, it fires on the way out of the
// shutdown path the signals already have, and `close()` is synchronous, which is what an
// exit handler needs.
process.on('exit', closeAllTerminals);

// ─── Docs API (markdown shown for the selected element) ───────
//
// A shape can carry `customData.docKey`; this serves the matching markdown so the
// canvas can show the reasoning behind a box without leaving the drawing.

/**
 * The documentation shipped with the tool, rather than with the project on screen.
 *
 * `__dirname` is `dist/` once compiled, so this is this build's own `docs/` — the repository's
 * in a checkout, and the package's in an installed copy, where `files` ships `docs/*.md`.
 */
const TOOL_DOCS_DIR = path.resolve(__dirname, '../docs');

/**
 * Where a board with no `docsDir` of its own reads documents from.
 *
 * `EXCALIDRAW_DOCS_DIR` was the install directory retyped by hand — an absolute path into one
 * checkout, in one operator's `.env` — and unset meant the route was off. So the tool could not
 * serve documentation it publishes in its own package, on the machine it was installed on, and
 * the only thing standing between a fresh clone and a dead card was a file no clone has.
 *
 * `undefined`, not falsy: an *explicitly empty* `EXCALIDRAW_DOCS_DIR` is how a board says it
 * wants no fallback at all, which is a thing a setup serving only per-project documents needs
 * to be able to say now that unset no longer means none. Serving arbitrary files from an
 * unauthenticated local API is still not a default — this serves one directory, this build's
 * own, and `DOC_KEY_PATTERN` plus the containment check below are what bound it to
 * `<dir>/<key>.md`.
 */
const DOCS_DIR_SETTING = env('DOCS_DIR');
const DOCS_DIR = DOCS_DIR_SETTING === undefined
  ? TOOL_DOCS_DIR
  : (DOCS_DIR_SETTING ? path.resolve(DOCS_DIR_SETTING) : null);

// Keys become filenames, so anything that could climb out of DOCS_DIR is rejected
// outright rather than normalised — a rejected key is obvious, a rewritten one is not.
const DOC_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Why a doc could not be served, in a form a caller can branch on.
 *
 * The two 404s are different problems with different repairs — a board one setting away
 * from working, and a document nobody has written — and the panel used to map both to
 * "no document yet", which pointed the reader at the wrong one. The prose stays for
 * anything reading the API by hand; the code is what the panel switches on.
 */
const NO_DOCS_DIR = 'no-docs-dir';
const NO_DOC = 'no-doc';

app.get('/api/docs/:key', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Documents are read')) return;

  const key = req.params.key ?? '';
  if (!DOC_KEY_PATTERN.test(key) || key.includes('..')) {
    return res.status(400).json({ success: false, error: 'Invalid doc key' });
  }

  // Each board reads its own project's docs, except for the keys that name a block this server
  // draws. `DOCS_DIR` is the fallback underneath both, for a canvas with no registered project
  // to resolve a directory from and for a project that carries no `docsDir` of its own.
  const workspaceId = workspaceIdFrom(req);
  let docsDir = DOCS_DIR;
  if (TOOL_DOC_KEYS.has(key)) {
    docsDir = TOOL_DOCS_DIR;
  } else if (workspaceId !== DEFAULT_WORKSPACE_ID) {
    const workspaces = await loadWorkspaces(registryPath());
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace?.docsDir) docsDir = path.resolve(workspace.docsDir);
  }

  if (!docsDir) {
    return res.status(404).json({
      success: false,
      code: NO_DOCS_DIR,
      error: `No docs directory for this board. Set docsDir in board.config.json, or ${settingName('DOCS_DIR')}.`
    });
  }

  const filePath = path.resolve(docsDir, `${key}.md`);
  // Defence in depth: even with the pattern above, confirm we stayed inside the root.
  if (filePath !== docsDir && !filePath.startsWith(docsDir + path.sep)) {
    return res.status(400).json({ success: false, error: 'Invalid doc key' });
  }

  try {
    const markdown = await fs.readFile(filePath, 'utf-8');
    res.json({ success: true, key, workspace: workspaceId, markdown });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return res.status(404).json({ success: false, code: NO_DOC, error: `No doc for key "${key}"` });
    }
    logger.error(`Failed to read doc "${key}":`, error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Files API (for image elements) ───────────────────────────

/**
 * The files one board's elements actually point at.
 *
 * The store itself is not per-board — a file is content-addressed by id and two boards may
 * legitimately reference the same one — so the scoping is by reference rather than by
 * ownership: the ids that the workspace's own image elements and issue blocks name. What
 * this replaces is `GET /api/files` handing back every dataURL the process holds for every
 * board, which on a board full of screenshots is megabytes fetched to draw a canvas that
 * needed none of them.
 */
function filesForWorkspace(workspaceId: string): Record<string, ExcalidrawFile> {
  const scoped: Record<string, ExcalidrawFile> = {};
  // The same walk the save uses, so what a board is served can never be a different set from
  // what it is saved with (#343).
  for (const id of referencedFileIds(elementsFor(workspaceId).values())) {
    const file = files.get(id);
    if (file) scoped[id] = file;
  }
  return scoped;
}

// GET the files this board's elements reference
app.get('/api/files', (req: Request, res: Response) => {
  if (offLoopback(res, 'A board\'s images are read')) return;

  res.json({ files: filesForWorkspace(workspaceIdFrom(req)) });
});

/**
 * One file by id.
 *
 * `GET /api/files` returns every dataURL the process holds, which is the wrong request
 * for a panel that wants to show the two images a block has attached — on a board full
 * of screenshots that is megabytes to render a thumbnail.
 */
app.get('/api/files/:id', (req: Request, res: Response) => {
  if (offLoopback(res, 'An image is read')) return;

  const file = files.get(req.params.id as string);
  if (!file) {
    return res.status(404).json({ success: false, error: `File with ID ${req.params.id} not found` });
  }
  res.json({ success: true, file });
});

// POST add/update files (batch)
app.post('/api/files', (req: Request, res: Response) => {
  if (offLoopback(res, 'A board\'s images are added to')) return;

  const body = req.body;
  const fileList: ExcalidrawFile[] = Array.isArray(body) ? body : (body?.files || []);
  for (const f of fileList) {
    if (f.id && f.dataURL) {
      files.set(f.id, { id: f.id, dataURL: f.dataURL, mimeType: f.mimeType || 'image/png', created: f.created || Date.now() });
    }
  }
  // Broadcast files to connected clients
  broadcast({ type: 'files_added', files: fileList }, workspaceIdFrom(req));
  res.json({ success: true, count: fileList.length });
});

// DELETE a file
app.delete('/api/files/:id', (req: Request, res: Response) => {
  if (offLoopback(res, 'An image is deleted')) return;

  const id = req.params.id as string;
  if (files.delete(id)) {
    broadcast({ type: 'file_deleted', fileId: id }, workspaceIdFrom(req));
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: `File with ID ${id} not found` });
  }
});

// Image export: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingExport {
  resolve: (data: { format: string; data: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  collectionTimeout: ReturnType<typeof setTimeout> | null;
  bestResult: { format: string; data: string } | null;
}
const pendingExports = new Map<string, PendingExport>();

app.post('/api/export/image', (req: Request, res: Response) => {
  if (offLoopback(res, 'The board is exported')) return;

  try {
    const { format, background } = req.body;

    if (!format || !['png', 'svg'].includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'format must be "png" or "svg"'
      });
    }

    // The board being exported, resolved before the guard: what has to be open in a browser
    // is *this* board, not any board at all. A tab on another project cannot render it, and
    // letting it try is how an export of one board came back with another board's scene.
    const exportWorkspaceId = workspaceIdFrom(req);

    if (clientsWatching(exportWorkspaceId) === 0) {
      return res.status(503).json({
        success: false,
        error: `No frontend client is on the board "${exportWorkspaceId}". Open it in a browser first.`
      });
    }

    const requestId = generateId();

    const exportPromise = new Promise<{ format: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingExports.get(requestId);
        pendingExports.delete(requestId);
        // If we collected any result during the window, use it
        if (pending?.bestResult) {
          resolve(pending.bestResult);
        } else {
          reject(new Error('Export timed out after 30 seconds'));
        }
      }, 30000);

      pendingExports.set(requestId, { resolve, reject, timeout, collectionTimeout: null, bestResult: null });
    });

    // Re-broadcast current elements so all connected clients (including stale ones)
    // sync to the canonical server state before exporting
    const filesObj = filesForWorkspace(exportWorkspaceId);
    broadcast({
      type: 'initial_elements',
      elements: Array.from(elementsFor(exportWorkspaceId).values()),
      ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
    } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> }, exportWorkspaceId);

    // Give browsers time to process the reload before requesting export
    setTimeout(() => {
      broadcast({
        type: 'export_image_request',
        requestId,
        format,
        background: background ?? true
      }, exportWorkspaceId);
    }, 800);

    exportPromise
      .then(result => {
        res.json({
          success: true,
          format: result.format,
          data: result.data
        });
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating image export:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Image export: result (Frontend -> Express -> MCP)
app.post('/api/export/image/result', (req: Request, res: Response) => {
  if (offLoopback(res, 'An export is answered')) return;

  try {
    const { requestId, format, data, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingExports.get(requestId);
    if (!pending) {
      // Already resolved by another client, or expired — ignore silently
      return res.json({ success: true });
    }

    if (error) {
      // Don't reject on error — another WebSocket client may still succeed.
      logger.warn(`Export error from one client (requestId=${requestId}): ${error}`);
      return res.json({ success: true });
    }

    // Keep the largest response (most complete canvas state wins)
    if (!pending.bestResult || data.length > pending.bestResult.data.length) {
      pending.bestResult = { format, data };
    }

    // Start a short collection window on the first response, then resolve with best
    if (!pending.collectionTimeout) {
      pending.collectionTimeout = setTimeout(() => {
        const p = pendingExports.get(requestId);
        if (p?.bestResult) {
          clearTimeout(p.timeout);
          pendingExports.delete(requestId);
          p.resolve(p.bestResult);
        }
      }, 3000);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing export result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Viewport control: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingViewport {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingViewports = new Map<string, PendingViewport>();

const viewportRequestSchema = z.object({
  scrollToContent: z.boolean().optional(),
  scrollToElementIds: z.array(z.string().min(1)).min(1).optional(),
  viewportZoomFactor: z.number().positive().max(1).optional(),
  scrollToElementId: z.string().min(1).optional(),
  zoom: z.number().min(0.1).max(10).optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional()
}).superRefine((params, ctx) => {
  const modes = [
    params.scrollToContent === true,
    params.scrollToElementIds !== undefined,
    params.scrollToElementId !== undefined,
    params.zoom !== undefined || params.offsetX !== undefined || params.offsetY !== undefined
  ].filter(Boolean).length;

  if (modes !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Specify exactly one viewport mode: scrollToContent, scrollToElementIds, scrollToElementId, or manual zoom/offset'
    });
  }
  if (params.viewportZoomFactor !== undefined &&
      params.scrollToContent !== true &&
      params.scrollToElementIds === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['viewportZoomFactor'],
      message: 'viewportZoomFactor requires scrollToContent or scrollToElementIds'
    });
  }
});

app.post('/api/viewport', (req: Request, res: Response) => {
  if (offLoopback(res, 'The viewport is moved')) return;

  try {
    const {
      scrollToContent,
      scrollToElementIds,
      scrollToElementId,
      viewportZoomFactor,
      zoom,
      offsetX,
      offsetY
    } = viewportRequestSchema.parse(req.body);

    // The board whose camera is being moved. Sent to everyone, this was the one path that
    // reached across browser windows: an agent scrolling its own project board scrolled
    // every board anybody had open (#156).
    const viewportWorkspaceId = workspaceIdFrom(req);

    if (clientsWatching(viewportWorkspaceId) === 0) {
      return res.status(503).json({
        success: false,
        error: `No frontend client is on the board "${viewportWorkspaceId}". Open it in a browser first.`
      });
    }

    const requestId = generateId();

    const viewportPromise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingViewports.delete(requestId);
        reject(new Error('Viewport request timed out after 10 seconds'));
      }, 10000);

      pendingViewports.set(requestId, { resolve, reject, timeout });
    });

    broadcast({
      type: 'set_viewport',
      requestId,
      scrollToContent,
      scrollToElementIds,
      scrollToElementId,
      viewportZoomFactor,
      zoom,
      offsetX,
      offsetY
    }, viewportWorkspaceId);

    viewportPromise
      .then(result => {
        res.json(result);
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating viewport change:', error);
    res.status(error instanceof z.ZodError ? 400 : 500).json({
      success: false,
      error: error instanceof z.ZodError
        ? error.issues.map(issue => issue.message).join('; ')
        : (error as Error).message
    });
  }
});

// Viewport control: result (Frontend -> Express -> MCP)
app.post('/api/viewport/result', (req: Request, res: Response) => {
  if (offLoopback(res, 'A viewport change is answered')) return;

  try {
    const { requestId, success, message, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingViewports.get(requestId);
    if (!pending) {
      return res.json({ success: true });
    }

    if (error || success === false) {
      clearTimeout(pending.timeout);
      pendingViewports.delete(requestId);
      pending.reject(new Error(error || message || 'Viewport update failed'));
      return res.json({ success: true });
    }

    clearTimeout(pending.timeout);
    pendingViewports.delete(requestId);
    pending.resolve({ success: true, message: message || 'Viewport updated' });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing viewport result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: save
app.post('/api/snapshots', (req: Request, res: Response) => {
  if (offLoopback(res, 'A snapshot is taken')) return;

  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Snapshot name is required'
      });
    }

    const workspaceId = workspaceIdFrom(req);
    const snapshot: Snapshot = {
      name,
      elements: Array.from(elementsFor(workspaceId).values()),
      createdAt: new Date().toISOString()
    };

    snapshotsFor(workspaceId).set(name, snapshot);
    logger.info(`Snapshot saved: "${name}" on "${workspaceId}" with ${snapshot.elements.length} elements`);

    res.json({
      success: true,
      name,
      elementCount: snapshot.elements.length,
      createdAt: snapshot.createdAt
    });
  } catch (error) {
    logger.error('Error saving snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: list
app.get('/api/snapshots', (req: Request, res: Response) => {
  if (offLoopback(res, 'Snapshots are listed')) return;

  try {
    const list = Array.from(snapshotsFor(workspaceIdFrom(req)).values()).map(s => ({
      name: s.name,
      elementCount: s.elements.length,
      createdAt: s.createdAt
    }));

    res.json({
      success: true,
      snapshots: list,
      count: list.length
    });
  } catch (error) {
    logger.error('Error listing snapshots:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: get by name
app.get('/api/snapshots/:name', (req: Request, res: Response) => {
  if (offLoopback(res, 'A snapshot is read')) return;

  try {
    const { name } = req.params;
    const workspaceId = workspaceIdFrom(req);
    const snapshot = snapshotsFor(workspaceId).get(name!);

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Snapshot "${name}" not found on "${workspaceId}"`
      });
    }

    res.json({
      success: true,
      snapshot
    });
  } catch (error) {
    logger.error('Error fetching snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Serve the frontend
app.get('/', (req: Request, res: Response) => {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Please run "npm run build" first.');
    }
  });
});

/**
 * What kind of canvas this is, which `status` cannot say.
 *
 * A server auto-started by `ensureCanvasRunning` inherits whatever environment its caller
 * held, and an MCP server started by an editor holds no `EXCALIDRAW_*` at all — so a stand-in
 * binds the board's port with no registry, no terminal and no agents, and answers everything
 * `/health` says above these fields exactly as the board it replaced did. Telling the two
 * apart took three more requests. These fields are the difference, and they are read from the
 * same expressions the routes themselves are gated on, so they cannot drift from what the
 * instance actually does.
 *
 * One function rather than an object literal in `/health`, because the restart supervisor
 * checks the replacement against exactly this: what it must find is what this instance is,
 * not a second list that can quietly stop matching.
 */
function canvasIdentity(): CanvasIdentity {
  return {
    // "Was this canvas pointed at a registry, or has the one it found got projects in it",
    // not "is a variable set". The two were the same question until the registry path grew a
    // default: every canvas resolves one now, so the old expression alone would answer
    // `configured` for the very stand-in this field exists to unmask. See
    // `hasWorkspaceRegistry` for why both clauses are there.
    workspaces: hasWorkspaceRegistry() ? 'configured' : 'none',
    terminal: Boolean(TERMINAL_SETTING),
    // The agents fail the most quietly of the three: the routes answer, the blocks draw, the
    // buttons are there, and pressing one does nothing. **Per role, never one** — the
    // variables are separate so that turning on issue blocks cannot quietly turn on repository
    // writes, and a single field here would hide the very asymmetry that split exists for.
    //
    // It used to be two booleans, and both of them meant "a string is non-empty", which is the
    // one thing about an agent that cannot go wrong. Now it is what the preflight found out by
    // running the binary, per role *and* per environment — the second axis matters because a
    // host path configured on a board with a project inside a distro is found in one and
    // missing in the other, and one flag could only ever have reported one of the two.
    //
    // What it never carries is the command line: these are somebody's paths and permission
    // flags, and this route is unauthenticated on loopback. `backend` is a name out of a list
    // `core/agent-preflight.ts` holds and `version` is a version number, both by construction.
    agents: AGENT_PREFLIGHT,
    // And the binary underneath every GitHub feature on the board, which failed as quietly as
    // the agents did and had nothing here at all until #317. `resolved` and a version number
    // only: the login, the token's scopes and `gh`'s own stderr are on `/api/github-status`,
    // which is loopback-only. This route is not.
    gh: GH_PREFLIGHT
  };
}

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    elements_count: totalElementCount(),
    websocket_clients: clients.size,
    // Identity for `stop`: it must only ever signal a process that both
    // identifies as this service AND self-reports its pid — never a pid
    // from a stale pidfile or an unrelated app squatting on the port.
    service: 'mcp-excalidraw-canvas',
    pid: process.pid,
    // Which build is answering, which `service` and `pid` between them could not say.
    //
    // An auto-started canvas is detached and unref'd, so it outlives the session that started
    // it; on an `npx -y <pkg>@latest` update path the second run of an upgraded tool meets the
    // first run's server, still holding the port and still serving the previous `dist/frontend`.
    // That is `docs/trap-stale-server.md` — "the old one keeps answering, silently, with the old
    // code" — and the reason it was silent is that nothing on the wire named the build. This is
    // the field `core/spawn.ts` compares before it attaches to a responder.
    //
    // Here rather than in `canvasIdentity()`, for the reason `platform` is here: that object is
    // what a *replacement* must match, and a restart is expressly how a board changes version.
    version: PACKAGE_VERSION,
    // What a restart would end, counted across every workspace rather than one. `restart` reads
    // it before it stops anything: the server hosts the coding agents, so stopping it stops them,
    // and doing that to somebody mid-implement without saying so is the failure this pre-empts.
    implementing: runningImplementCount(),
    // Which machine this board is running on, for a page that has to describe it. The Add-a-
    // project dialog's example path is the only concrete path this tool ever shows, and it
    // was a `C:` one everywhere — the wrong syntax for the platform two thirds of readers are
    // standing on. Here rather than in `canvasIdentity()`: that is what a *replacement* has to
    // match, and a restart cannot change the platform, so putting it there would add a
    // comparison that can never be false and imply it could.
    platform: process.platform,
    ...canvasIdentity()
  });
});

// ─── Pairing a second machine ─────────────────────────────────
//
// The gesture, in four routes: a device asks, the operator is shown what asked, the operator
// approves the one whose code matches the screen in front of them, and the waiting device
// collects its secret on its next poll and never again. The rules that make that a gesture
// rather than a hole — the code, the once-only handover, the expiry, the per-address limit and
// the ceiling — are in `core/pairing.ts`, which is where they can be driven by a check without a
// check having to wait out an expiry.

/**
 * One desk for this board.
 *
 * Nothing on it survives a restart, deliberately: a pending request is a gesture in progress and
 * ending it is correct. What survives is the approved device, which is why the desk is handed
 * `addDevice` — the registry (#502) is what mints a secret and writes a record, and this is the
 * only place in the server that calls it.
 */
const pairingDesk = createPairingDesk({ mint: addDevice });

/**
 * Who is calling, taken off the socket and from nowhere else.
 *
 * Not `X-Forwarded-For`. A header any caller can set would turn the one property of a request
 * nobody can forge into one everybody can, and a remote caller would approve itself by asking
 * politely. A reverse proxy reaches this server *on* loopback, which is why a proxied board
 * keeps working without this knowing the proxy exists.
 */
function callerAddress(req: Request): string {
  return req.socket.remoteAddress ?? '';
}

/**
 * Refuse a caller that is not on this machine, and say which question was asked.
 *
 * The counterpart of `offLoopback`, asking the other half of the question: that one is about the
 * **bind** and this one is about the **caller**. Approving a device is the operator's action on
 * the operator's own computer, and a pairing route a pending device could approve is not a
 * gesture, it is a formality.
 */
function notTheHost(req: Request, res: Response, what: string): boolean {
  if (isLoopbackCaller(callerAddress(req))) return false;
  logger.warn(`Refused ${req.method} ${req.path} from ${callerAddress(req)}: ${what}`);
  res.status(403).json({
    success: false,
    error: `${what} only from the machine this board is running on.`
  });
  return true;
}

/**
 * A device asks to be let in.
 *
 * Open, with no credential, because asking for a credential is what this is. Bounded, because
 * what it does is put a row on the operator's screen: a refusal here is a 429 and a line in the
 * log, never a dialog — a stranger who can make the operator's board shout is a stranger who has
 * found a way to make them stop reading it.
 */
app.post('/api/pair/request', (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const outcome = pairingDesk.request({
    name,
    remoteAddress: callerAddress(req),
    host: typeof req.headers.host === 'string' ? req.headers.host : ''
  });

  if (!outcome.ok) {
    if (outcome.refusal === 'unnamed') {
      return res.status(400).json({
        success: false,
        error: 'A device asking to pair has to propose a name for itself, so that the operator '
          + 'has something to recognise it by.'
      });
    }
    // info rather than warn: this is the bound working, and the console on this machine is warn
    // and above. A refused request is not something to put in front of the operator.
    logger.info(`Refused a pairing request from ${callerAddress(req)}: ${outcome.refusal}.`);
    return res.status(429).json({
      success: false,
      error: 'This board is not taking another pairing request right now. Try again shortly.'
    });
  }

  logger.info(`A device calling itself "${outcome.pending.name}" asked to pair from `
    + `${outcome.pending.remoteAddress} as ${outcome.pending.host}.`);
  // The code and the identifier, and nothing else. Whether the operator has looked at it yet is
  // what the poll below is for, and there is nothing secret in this answer at all.
  res.json({
    success: true,
    requestId: outcome.pending.requestId,
    code: outcome.pending.code,
    expiresAt: outcome.pending.expiresAt
  });
});

/**
 * What became of a request — and, on exactly one poll, the secret.
 *
 * Open for the same reason the route above is: the device holding this `requestId` is the device
 * that has no credential yet. `unknown` is the answer to a consumed request and to one nobody
 * issued, which is deliberate: a poll is not a way to find out whether a request exists.
 */
app.get('/api/pair/status', (req: Request, res: Response) => {
  const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : '';
  const status = pairingDesk.status({ requestId });
  if (status.state === 'approved') {
    logger.info(`A paired device collected its credential (${status.deviceId}).`);
  }
  res.json({ success: true, ...status });
});

/**
 * What is waiting for the operator: every live request, with what there is to recognise it by.
 *
 * The operator's route, so it is behind the token and behind the caller check like the approval
 * it precedes. The `Host` and the remote address are here because they are the two things a
 * person can judge and this server cannot — only the operator can tell `mac.tailnet.ts.net` from
 * a name that merely resolves here.
 */
app.get('/api/pair/pending', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'Pending pairing requests are read')) return;
  res.json({ success: true, requests: pairingDesk.pending() });
});

/**
 * The operator approves one of them, by the code they can read off the other screen.
 *
 * The code is required rather than decorative. Without it the operator is confirming that a
 * request exists, and a stranger's request racing theirs is approved by somebody who assumed the
 * dialog was about their own laptop; with it, the operator is choosing between requests.
 *
 * The device is written down before the answer goes out. An approval the operator watched
 * succeed which then did not survive the next restart is worse than a refusal they can see.
 */
app.post('/api/pair/approve', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'A device is approved')) return;

  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
  const code = typeof req.body?.code === 'string' ? req.body.code : '';

  // The registry writes inside `approve`, and it throws rather than warning when it cannot. It
  // throws before the pending record is touched, so a board whose state directory has gone
  // read-only leaves the request approvable rather than consuming the gesture on a failure.
  let outcome;
  try {
    outcome = pairingDesk.approve({ requestId, code });
  } catch (error) {
    logger.error('Could not write the paired device registry:', error);
    return res.status(500).json({
      success: false,
      error: `Nothing was paired: the device could not be written to ${deviceRegistryPath()} `
        + `(${(error as Error).message}). The request is still waiting, so this can be tried again.`
    });
  }

  if (!outcome.ok) {
    if (outcome.reason === 'code-mismatch') {
      // 409 and not 403: the request is real and the operator may still approve it. What
      // disagrees is the code, which is the one thing this route exists to make them compare.
      return res.status(409).json({
        success: false,
        error: 'That code does not match the request. Read the code off the screen of the device '
          + 'asking, and approve the request showing the same one.'
      });
    }
    return res.status(404).json({
      success: false,
      error: 'There is no pairing request waiting under that identifier. It may have expired, or '
        + 'the device may already have collected its secret.'
    });
  }

  // warn rather than info, unlike the registry's own line: on this machine the console is warn
  // and above, and letting a second machine onto this board is something the operator watching
  // the server should see said.
  logger.warn(`Paired "${outcome.device.name}" (${outcome.device.id}), approved from `
    + `${outcome.device.approvedFrom} for ${outcome.device.host}.`);
  // The secret is not in this answer. It goes to the device that asked, on its next poll, and
  // the operator never sees it — there is nothing here for them to copy anywhere.
  res.json({ success: true, deviceId: outcome.device.id, name: outcome.device.name });
});

/**
 * The other answer, and the one dismissing the dialog gives (#504).
 *
 * A dialog that can only be answered `yes` is a dialog people learn to answer `yes`. So the
 * screen offers refuse as prominently as approve, Escape is a refusal rather than a deferral,
 * and both of them arrive here — which is what lets the waiting device be *told*, instead of
 * spinning until an expiry it cannot see and then being told nothing in particular.
 *
 * No code is required, unlike the approval. The operator refusing does not have to have decided
 * which of two requests they are refusing; the worst a refusal aimed at the wrong one can do is
 * make somebody ask again, and a refusal that had to be typed could not be a dismissal.
 */
app.post('/api/pair/refuse', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'A device is refused')) return;

  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
  if (!pairingDesk.refuse({ requestId })) {
    return res.status(404).json({
      success: false,
      error: 'There is no pairing request waiting under that identifier. It may have expired, or '
        + 'it may already have been answered.'
    });
  }

  logger.info(`Refused a pairing request (${requestId}).`);
  res.json({ success: true });
});

/**
 * Whether the caller may drive this board at all — the page's own question, before it renders.
 *
 * Behind every gate the board's other routes are behind and behind nothing extra, because the
 * answer *is* those gates: 200 means this caller is one the board answers, 401 that it holds no
 * credential, 403 that it is reaching this board under a name the board does not answer for. The
 * page needs the difference before it decides what to be (#504) — a board, or the screen that
 * says how to become one — and asking any other route the same question would mean reading a
 * refusal about the scene and guessing that it was about admission.
 *
 * Deliberately not one of `PAIRING_OPEN_PATHS`, and deliberately carrying no guard of its own:
 * a caller this server admits has to get 200 here, so the answer stays the guards' rather than
 * becoming a second copy of them that can disagree with them. That is also what makes it
 * forward-compatible with the rest of this milestone — the day the caller guard learns to read a
 * device's record, this route says so without being edited.
 */
app.get('/api/pair/admission', (_req: Request, res: Response) => {
  res.json({ success: true, admitted: true });
});

/**
 * Restart this server, from somewhere that is not inside it.
 *
 * The board could not restart its own server, and the improvised answer sawed off the branch
 * it sat on: a terminal block is a child of the server, so killing the server killed the shell
 * running the kill, and the replacement came from whatever auto-started first — a stand-in
 * with none of the board's environment, holding the port and answering `status: healthy`.
 *
 * So this route does exactly two things: it hands a **supervisor** the identity the
 * replacement has to have, and then it leaves. Everything after that happens in a process
 * outside this one's tree (`src/core/restart-supervisor.ts`), which is the only place it can
 * happen from.
 *
 * The answer goes out before the exit — the button on the board is waiting for it, and a
 * restart that closed the socket without replying would be indistinguishable from a crash.
 *
 * Loopback-guarded like every other route that acts on this machine rather than reading a
 * project: restarting is an operator's action on the operator's own computer.
 */
app.post('/api/restart', (_req: Request, res: Response) => {
  if (offLoopback(res, 'The canvas server is restarted')) return;

  const log = restartLogPath(PORT);
  let supervisor: number | null = null;
  try {
    supervisor = spawnRestartSupervisor({
      port: PORT,
      host: HOST,
      oldPid: process.pid,
      expect: canvasIdentity(),
      log
    });
  } catch (error) {
    logger.error('Failed to start the restart supervisor:', error);
    return res.status(500).json({ success: false, error: (error as Error).message });
  }

  // Nothing has been killed yet, so a supervisor that did not start is simply a restart that
  // did not happen — reported, with the board still up.
  if (supervisor === null) {
    logger.error('The restart supervisor was spawned but reported no pid; the server stays up.');
    return res.status(500).json({
      success: false,
      error: 'Could not start the process that would bring the server back up; nothing was stopped.'
    });
  }

  // The board is being replaced rather than stopped, and the reader's tab is watching it happen.
  // So the secret goes with it: written where the replacement will take it, and kept out of the
  // exit handlers' cleanup. Without this the tab comes back to a board that reports itself up and
  // then refuses everything it asks — see `core/auth-token.ts`.
  handingOver = true;
  if (AUTH_TOKEN) {
    try {
      writeTokenHandover(PORT, AUTH_TOKEN);
    } catch (error) {
      // Said, and not fatal: the restart still happens and the board still comes up. What is lost
      // is the tab, which has to be re-opened with `vibemaxxing` — worth a line, not a refusal.
      logger.warn(`Could not hand this board's token to its replacement: ${(error as Error).message}. `
        + 'The open tab will have to be re-opened after the restart.');
    }
  }

  // warn rather than info: on this machine the console is warn and above, and a process about
  // to exit on purpose should say so where somebody watching the server can see it.
  logger.warn(`Restart requested: supervisor ${supervisor} will replace pid ${process.pid}. Log: ${log}`);

  res.json({
    success: true,
    pid: process.pid,
    supervisor,
    log,
    // What the board's confirmation already told the reader, repeated where a script can read
    // it: terminal sessions and in-memory run state do not survive; the canvas does.
    costs: ['terminal-sessions', 'in-flight-implementations']
  });

  // Once, whichever comes first: `finish` is the response actually on the wire, and the timer
  // is there because a client that hangs up must not leave the server half-restarted with a
  // supervisor already waiting for it to go.
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    setTimeout(() => process.exit(0), 100).unref();
  };
  res.on('finish', leave);
  setTimeout(leave, 2000).unref();
});

/**
 * Where the operator's own script writes what their coding agent told it.
 *
 * Unset is off, and off is a 404 rather than an empty list: nothing on this board reads an
 * agent's limits by default, and a route that answered `[]` would look like a board whose
 * sessions had never run rather than one that was never asked to look.
 */
const AGENT_LIMITS_DIR = (env('AGENT_LIMITS') ?? '').trim();

/**
 * The backend that reads it, or none.
 *
 * Resolved once, at startup, because the answer cannot change while the process lives — see
 * `limitsReaders`, which is also where the reason it is not the board's *configured* backend
 * is written down.
 */
const AGENT_LIMITS_READER = limitsReaders()[0] ?? null;

/**
 * One read of that directory, however many tabs asked.
 *
 * The same shape `IssueMemo` uses and for the same reason, at a much shorter window: a
 * board with four project tabs open polls this four times a minute on the same second, and
 * all four want the same handful of files. Five seconds is long enough to collapse that
 * burst and short enough that it can never be the reason a reading looks stale.
 */
const AGENT_LIMITS_MEMO_MS = 5000;
let agentLimitsMemo: { reading: Promise<AgentLimitsReading[]>; at: number } | null = null;

function readAgentLimitsMemoized(reader: AgentAdapter): Promise<AgentLimitsReading[]> {
  if (agentLimitsMemo && Date.now() - agentLimitsMemo.at < AGENT_LIMITS_MEMO_MS) {
    return agentLimitsMemo.reading;
  }
  const reading = (async () => {
    const workspaces = await loadWorkspaces(registryPath()).catch(() => []);
    const distros = workspaces
      .map((workspace) => workspace.environment)
      .filter((environment): environment is { kind: 'wsl'; distro: string } => environment.kind === 'wsl')
      .map((environment) => environment.distro);
    // Non-null: a reader is one that has the method, which is what put it in the list.
    return reader.readLimits!(AGENT_LIMITS_DIR, distros);
  })();
  const entry = { reading, at: Date.now() };
  agentLimitsMemo = entry;
  // A failed read is never remembered, for the reason `IssueMemo` gives: one bad moment
  // must not be five seconds of a blank HUD.
  reading.catch(() => { if (agentLimitsMemo === entry) agentLimitsMemo = null; });
  return reading;
}

/**
 * What each coding-agent environment on this machine has spent, and who spent it.
 *
 * Global rather than workspace-scoped, because it describes machines rather than projects —
 * the `/health` family, not the `/api/elements` one. Loopback only, and the guard comes
 * before the 404: this serves an email address, so whether it is configured is itself
 * something a board on a LAN address should not be answering.
 *
 * A build with no backend that can read limits answers the same 404 as one that was never
 * configured, and deliberately: both are "there is nothing here to show", and a reader who has
 * set the variable is told which of the two it is by the sentence rather than by the code.
 */
app.get('/api/agent-limits', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Agent limits are read')) return;

  if (!AGENT_LIMITS_DIR || !AGENT_LIMITS_READER) {
    return res.status(404).json({
      success: false,
      error: !AGENT_LIMITS_READER
        ? 'No coding agent this board knows can report what it has spent.'
        : `Agent limits are off. Set ${settingName('AGENT_LIMITS')} to the directory your `
          + 'agent writes its usage files into.'
    });
  }

  try {
    const environments = await readAgentLimitsMemoized(AGENT_LIMITS_READER);
    res.json({ success: true, staleAfterSeconds: STALE_AFTER_SECONDS, environments });
  } catch (error) {
    logger.error('Failed to read the agent limits directory:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Sync status endpoint
app.get('/api/sync/status', (req: Request, res: Response) => {
  res.json({
    success: true,
    elementCount: totalElementCount(),
    workspaces: activeWorkspaceIds().length,
    timestamp: new Date().toISOString(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024), // MB
    },
    websocketClients: clients.size
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
//
// The server never scans. `PORT` is a pin and the preference is a starting point, and both are
// final here — the search that turns an occupied port into a free one happens in the launch
// path (core/port.ts, from the CLI entry point), before anything captured a URL. A server that
// moved itself would come up somewhere its own caller is not looking.
const PORT = explicitPort() ?? preferredPort();
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_GUARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (isOpen: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };

    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findExistingLoopbackListener(port: number): Promise<string | null> {
  for (const host of LOOPBACK_ADDRESSES) {
    if (await canConnect(host, port)) {
      return host;
    }
  }
  return null;
}

/**
 * A fatal startup failure, said twice: into the platform log, and into a file beside the pidfile.
 *
 * The second one is the only one the caller can read. This process is normally spawned detached
 * with `stdio: 'ignore'` — see core/spawn.ts for why that stays — so a message on stderr reaches
 * nobody, and the launcher was left reporting an eight-second health timeout that named neither
 * the port nor what was on it. The launcher clears this file before spawning and relays whatever
 * is in it if this process dies.
 */
function failStartup(message: string): void {
  logger.error(message);
  try {
    const file = startupLogPath(PORT);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${new Date().toISOString()} ${message}
`, 'utf-8');
  } catch { /* the log above is what is left */ }
  process.exit(1);
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const address = (error as NodeJS.ErrnoException & { address?: string }).address || HOST;
    failStartup(
      `Canvas server port ${PORT} is already in use on ${formatHostForUrl(address)}: `
      + 'something else is listening there. Stop it, or start with PORT unset and let the '
      + 'launch path pick a free port.'
    );
  } else if (error.code === 'EACCES') {
    failStartup(`Canvas server cannot bind ${formatHostForUrl(HOST)}:${PORT}: permission denied.`);
  } else {
    failStartup(`Failed to start canvas server: ${error.message}`);
  }
});

async function startServer(): Promise<void> {
  // Before anything can be served, and here rather than at the declaration because `PORT` is
  // resolved at the bottom of this file. A restart left its secret for this start (see
  // `core/auth-token.ts`); any other start makes one, and the handover — if a restart wrote one
  // and never came back — is taken and deleted either way.
  if (AUTH_REQUIRED) {
    AUTH_TOKEN = consumeTokenHandover(PORT) ?? newToken();
  } else {
    AUTH_TOKEN = null;
    // Cleared even here: a board that wants no token must not leave one lying in the directory
    // for the next start on this port to adopt.
    removeTokenHandover(PORT);
  }

  if (LOOPBACK_GUARD_HOSTS.has(HOST)) {
    const existingHost = await findExistingLoopbackListener(PORT);
    if (existingHost) {
      failStartup(
        `Refusing to start canvas server on ${formatHostForUrl(HOST)}:${PORT}: ` +
        `${formatHostForUrl(existingHost)}:${PORT} is already listening. ` +
        'This prevents duplicate IPv4/IPv6 canvas servers from splitting state.'
      );
    }
  }

  // Only the process that actually wrote the pidfile may remove it —
  // a concurrent-start loser exiting on EADDRINUSE must not delete the
  // winner's pidfile.
  let ownsPidFile = false;

  server.listen(PORT, HOST, () => {
    const hostForUrl = formatHostForUrl(HOST);
    // The product, not the proof of concept this line was named after three years ago, and read
    // out of `core/version.ts` rather than written here — the same source the CLI's own launch
    // line prints from, so the next rename lands in `package.json` alone. That old name was the
    // last of its kind under `src/` and `frontend/`, and `check-startup-brand.mjs` reads the
    // whole tracked set to keep it that way rather than pinning this one file.
    logger.info(`${productName()} server running on http://${hostForUrl}:${PORT}`);
    logger.info(`WebSocket server running on ws://${hostForUrl}:${PORT}`);

    // Written only after listen succeeds so stale files can't shadow a
    // server that never came up; lets the CLI's `stop` command find us.
    writePidFile(PORT, process.pid);
    // And the token, on the same terms and for a sharper version of the same reason: a
    // concurrent-start loser that wrote its own would replace the winner's, and every caller
    // reading that file would then be refused by the board that is actually running.
    //
    // A failure here is fatal rather than a warning. Nothing can drive a board whose token
    // cannot be read — not the page, not the CLI, not the MCP server — and it would answer
    // `status: healthy` throughout, which is the failure that is hardest to diagnose from
    // outside. `warn` when there is no token at all, because a board anything on the machine
    // can drive is worth one line on the console.
    if (AUTH_TOKEN) {
      try {
        writeAuthToken(PORT, AUTH_TOKEN);
      } catch (error) {
        failStartup(`Canvas server cannot write its token to ${tokenFilePath(PORT)}: `
          + `${(error as Error).message}. Nothing would be able to drive this board.`);
      }
    } else {
      // `info`, so it reaches the log file and not the console. Every check in `scripts/` starts
      // its board with this set, and one of them asserts that an unconfigured board warns about
      // nothing at all — a line here on `warn` is a paragraph of stderr under the whole suite.
      logger.info(`${settingName('NO_AUTH')}=1: this board has no token, so anything that can `
        + 'reach the port drives it — see docs/SECURITY.md.');
    }
    // And beside it, the port itself — the one thing a later command cannot work out on its
    // own once the port stopped being a constant. It is written, never trusted: every reader
    // probes /health before believing it.
    writeCanvasState({ port: PORT, pid: process.pid, url: canvasUrlFor(PORT, HOST) });
    ownsPidFile = true;

    // The boards, and then whatever the last process was in the middle of when it stopped.
    // Started here rather than before `listen` so neither a slow read nor a slow git can
    // delay the board coming up, and deliberately not awaited: nothing else depends on
    // either having finished.
    //
    // In that order, because recovery writes what it derives from git onto the elements
    // carrying the issue, and it can only write onto elements that are in the store when it
    // looks. The other order leaves a recovered `interrupted` run recorded but undrawn.
    //
    // Kept rather than discarded, so a read of a board can wait for the board: not awaiting it
    // is what makes the port open promptly, and `whenBoardsRestored` is what stops that being
    // paid for with an empty answer.
    boardsRestored = seedBoardsFromFiles();
    // Settled either way: a board that could not be read has said so, and a read waiting on it
    // has nothing further to wait for.
    void boardsRestored.then(() => { boardsAreBack = true; }, () => { boardsAreBack = true; });
    void boardsRestored.then(recoverInterruptedRuns);

    // And the one question nothing used to ask: do the agents this board is configured with
    // actually run? Here for the same reason as the line above — a `wsl.exe` round trip must
    // not sit between the port opening and the board being usable — and separately, because
    // neither depends on the other.
    void runAgentPreflight();
    // And the same question about `gh`, which every GitHub feature on the board goes through
    // and which fails in more ways than the agents do. Separately again: neither waits on the
    // other, and a `gh auth status` that reaches the network must not delay either.
    void runGithubPreflight();

    // And beside them, the one reporter every `gh`-backed feature on this board files founder
    // blockers through. Installed here rather than at the four call sites for the reason
    // `setTerminalGhReporter` gives: a producer wired in per call site is one that will be
    // forgotten at the next call site. `runGh` invokes it at the rethrow it already has, and
    // only for a failure no retry can fix — which is the definition of "a person has to act".
    //
    // It is handed the failure itself: `said` and `remedy` are separate fields, and reading
    // `.message` instead would put a tool's stderr on a card written for a person.
    setTerminalGhReporter((workspace, failure) => {
      noticeFounderBlocker(
        normalizeWorkspaceId(workspace.id), workspace, blockerForGhFailure(failure)
      );
    });
    // And the pass that closes them again. First fire is one interval away — see the comment
    // on `startFounderProducer` for why nothing runs at startup.
    startFounderProducer();
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}, shutting down canvas server`);
    // Whatever the debounce still owes, written now. Not the whole of the save half — a
    // process that is killed outright never gets here, which is why the debounce is a second
    // rather than a minute — but a shutdown that discarded the last edit would be the same
    // loss #225 is about, arriving through the one door that could have been closed politely.
    flushBoardStateSaves();
    if (ownsPidFile) { removePidFile(PORT); removeCanvasState(PORT); if (!handingOver) removeAuthToken(PORT); }
    server.close(() => process.exit(0));
    // Force-exit if open sockets keep the server from closing promptly
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('exit', () => {
    flushBoardStateSaves();
    if (ownsPidFile) { removePidFile(PORT); removeCanvasState(PORT); if (!handingOver) removeAuthToken(PORT); }
  });
}

// Start the canvas server only when this file is the process entry point
// (`node dist/server.js`, `npm run canvas`, or spawned by the CLI/MCP
// auto-start). Importing this module must never start the server.
if (isMainModule(import.meta.url)) {
  void startServer();
}

export { startServer };
export default app;
