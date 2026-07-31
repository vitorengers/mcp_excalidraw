/**
 * Restarting the canvas server from a process that is not inside it.
 *
 * A server cannot restart itself. Whatever runs the kill dies with the kill, and what comes
 * up afterwards is then whatever auto-starts first — which, on this machine, once meant an
 * MCP server attached to an editor spawning a replacement that held no `EXCALIDRAW_*` at all.
 * It bound the board's port, answered `status: healthy` with the same `service` marker, and
 * had no registry, no terminal and no agents (`scripts/check-health-identity.mjs`,
 * `docs/running.md`). Every sign said the restart had worked.
 *
 * So the restart is handed to a **supervisor**: a process the server spawns, detached, just
 * before it exits, which then outlives it and brings the replacement up.
 *
 * Three things that are easy to leave out, and each of them was the whole failure once:
 *
 *   - **It carries the environment.** The supervisor is spawned with `{ ...process.env }` from
 *     inside the board, and hands the same on to the server it starts. That is the board's own
 *     environment rather than whatever an editor session happened to be holding, and it is the
 *     half the earlier failure got wrong for free.
 *   - **It waits for the port to actually free.** A server that cannot bind exits quietly
 *     (`docs/trap-stale-server.md`), so a start that races its own kill looks like a silent
 *     failure rather than like the collision it is.
 *   - **It verifies identity, not `status`.** The new server has to report a *different* pid
 *     and the same registry, terminal and agents the old one had. `status: healthy` is exactly
 *     what the stand-in said.
 *
 * On detaching: `detached: true` plus `unref()` was measured on this machine (2026-07-30)
 * against a parent that exits on purpose, and the child survives it. The heavier
 * `Win32_Process.Create` trick recorded in the operator's notes was needed for a different
 * parent — a shell *inside* the board's own process tree, where the whole conpty session goes
 * with the server. Here the parent is the server itself, and node's own detach is enough;
 * `scripts/check-restart-route.mjs` is what would notice if that ever stopped being true,
 * because a supervisor that died with its parent means no second pid ever answers.
 */

import { spawn } from 'child_process';
import net from 'net';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './entry.js';
import { isAcceptedCanvasService } from './identity.js';

/** What the replacement has to be, beyond answering at all. Same shape `/health` reports. */
export interface CanvasIdentity {
  workspaces: string;
  terminal: boolean;
  agents: { issue: boolean; implement: boolean };
}

export interface RestartPlan {
  port: number;
  host: string;
  /** The process being replaced. The supervisor waits for it rather than signalling it. */
  oldPid: number;
  expect: CanvasIdentity;
  /** Where the account of all this is written, because nobody is watching by then. */
  log: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Spawn the supervisor for `plan`, detached, and return its pid.
 *
 * Called from the route handler in the moment before the server exits. The payload goes in
 * base64 on the command line rather than in the environment: an inherited `EXCALIDRAW_*`
 * variable would be handed on to the server the supervisor starts, and the whole point of
 * this path is that the new server's environment is the old one's exactly.
 */
export function spawnRestartSupervisor(plan: RestartPlan): number | null {
  const supervisorJs = fileURLToPath(new URL('./restart-supervisor.js', import.meta.url));
  const payload = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
  const child = spawn(process.execPath, [supervisorJs, payload], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  child.unref();
  return child.pid ?? null;
}

/** The URL a probe should use for a bind host — `0.0.0.0` and `::` are not addresses. */
export function probeUrl(host: string, port: number): string {
  const target = host === '0.0.0.0' || host === '::' || host === 'localhost' ? '127.0.0.1' : host;
  return `http://${target.includes(':') ? `[${target}]` : target}:${port}`;
}

/** Whether a pid exists at all. Signal 0 asks without sending anything. */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Whether anything at all accepts a connection there. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Every address the port could still be held on.
 *
 * The server refuses to start when *either* loopback address is listening — that guard is
 * what keeps an IPv4 and an IPv6 canvas from splitting the state — so waiting on only the one
 * this server was bound to would start a replacement that then exits on its own guard.
 */
function portHolders(host: string): string[] {
  return LOOPBACK.has(host) ? ['127.0.0.1', '::1'] : [host];
}

async function stillHeld(host: string, port: number): Promise<boolean> {
  for (const address of portHolders(host)) {
    if (await accepts(address, port)) return true;
  }
  return false;
}

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs: number, everyMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
}

interface Health {
  service?: string;
  pid?: number;
  workspaces?: string;
  terminal?: boolean;
  agents?: { issue?: boolean; implement?: boolean };
}

async function healthOf(url: string): Promise<Health | null> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() as Health : null;
  } catch {
    return null;
  }
}

/** The new server is the board again, or it is not — and `status: healthy` cannot tell. */
export function matchesIdentity(health: Health | null, expect: CanvasIdentity, pid: number): boolean {
  return health !== null
    && isAcceptedCanvasService(health.service)
    && health.pid === pid
    && health.workspaces === expect.workspaces
    && health.terminal === expect.terminal
    && Boolean(health.agents?.issue) === expect.agents.issue
    && Boolean(health.agents?.implement) === expect.agents.implement;
}

/** The whole restart, from outside the process tree it replaces. */
export async function supervise(plan: RestartPlan): Promise<number> {
  const say = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    try {
      mkdirSync(dirname(plan.log), { recursive: true });
      appendFileSync(plan.log, stamped, 'utf8');
    } catch { /* the log is the courtesy, not the job */ }
    process.stderr.write(stamped);
  };

  const url = probeUrl(plan.host, plan.port);
  say(`supervisor ${process.pid} restarting the canvas on ${plan.host}:${plan.port}, replacing pid ${plan.oldPid}`);

  if (!await until(() => !isAlive(plan.oldPid), 20000)) {
    say(`pid ${plan.oldPid} is still running after 20s — refusing to start a second server on the port it holds`);
    return 1;
  }
  say(`pid ${plan.oldPid} is gone`);

  if (!await until(async () => !await stillHeld(plan.host, plan.port), 20000)) {
    say(`port ${plan.port} is still being listened on after 20s — a server started now would fail to bind and exit quietly`);
    return 1;
  }
  say(`port ${plan.port} is free`);

  // dist/core/restart-supervisor.js -> dist/server.js. The build that is on disk: a restart
  // is not a rebuild, and running one here would put the board's uptime behind a compile.
  const serverJs = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [serverJs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(plan.port), HOST: plan.host }
  });
  child.unref();
  const started = child.pid ?? -1;
  say(`started ${serverJs} as pid ${started}`);

  let last: Health | null = null;
  const up = await until(async () => {
    last = await healthOf(url);
    return matchesIdentity(last, plan.expect, started);
  }, 45000, 250);

  if (!up) {
    say(`the replacement did not come up as the board within 45s. Last /health: ${JSON.stringify(last)}; `
      + `expected pid ${started} with ${JSON.stringify(plan.expect)}`);
    return 1;
  }
  say(`the canvas is back on ${url} as pid ${started}, with the registry, terminal and agents it had`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  const raw = process.argv[2];
  if (!raw) {
    process.stderr.write('restart-supervisor: expected a base64 plan as its only argument\n');
    process.exit(2);
  }
  const plan = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as RestartPlan;
  void supervise(plan).then(code => process.exit(code));
}
