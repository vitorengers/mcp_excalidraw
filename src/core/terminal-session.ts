/**
 * A shell the server owns, running in a workspace, streaming as it goes.
 *
 * This is a strictly more dangerous thing than the issue agent, which
 * `docs/issue-block.md` already calls the most dangerous thing this server does: that one
 * spawns a process with a fixed prompt, this one spawns a process that runs whatever
 * arrives over an API with no authentication. So it copies the same guards, and the copy is
 * deliberate — opt in by environment variable, loopback only, and one session per
 * workspace. The routes in `src/server.ts` apply them.
 *
 * Piped, not a PTY. A real PTY is what a full-screen program needs — Claude Code's own
 * interface included — and every PTY for Node is a native module, which would be the first
 * native dependency in a package published to npm and the first thing that needs a compiler
 * to install. A pipe runs commands and streams their output, which is what this surface was
 * asked for. `docs/terminal.md` records what that costs.
 */
import { spawn, spawnSync, ChildProcess } from 'child_process';
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
import { agentPath, buildAgentCommand } from './issue-agent.js';

/**
 * How much transcript is kept for a socket that connects late.
 *
 * Held server-side and replayed on connect, because the shape on the board is derived: it
 * is rebuilt every session and carries none of this, and a scrollback in `customData`
 * would be synced, exported and committed. A ceiling because a session left running with
 * something noisy in it must not grow without one.
 */
export const SCROLLBACK_LIMIT = 200_000;

/** What a block reports before anything has resized it. */
export const DEFAULT_GRID = { cols: 80, rows: 24 };

/**
 * The shell to start when the setting says "on" but does not say which.
 *
 * PowerShell on Windows rather than `cmd.exe` because `pwd`, `ls` and `cat` all mean
 * something there, and a terminal whose first command fails on the platform's own spelling
 * is a poor first impression. `-Command -` reads commands from stdin and writes each one's
 * output as it is produced; `-NoProfile` keeps a machine's own profile out of a shell this
 * server started.
 */
export function defaultShellCommand(workspace: Workspace): string {
  if (workspace.environment.kind === 'wsl') return 'bash';
  if (process.platform === 'win32') return 'powershell.exe -NoLogo -NoProfile -Command -';
  return 'bash';
}

/**
 * What `EXCALIDRAW_TERMINAL` means.
 *
 * Unset — or empty — is no shell at all, which is what makes the routes refuse: the feature
 * does not exist unless somebody turned it on. A bare switch means the default shell for
 * the workspace; anything else is taken as the command to run, which is how a check can put
 * a stub where a shell would be, and how a machine that prefers `bash` on Windows says so.
 */
export function shellCommandFrom(
  setting: string | undefined | null,
  workspace: Workspace
): string | null {
  const value = (setting ?? '').trim();
  if (!value) return null;
  return /^(1|true|on|yes|enabled|default)$/i.test(value) ? defaultShellCommand(workspace) : value;
}

/**
 * The shell, in the workspace's own environment.
 *
 * `buildAgentCommand` and nothing new: a WSL-backed project has to run inside the distro at
 * the path the distro names, because a Windows UNC path is not a working directory `git`
 * in there can act on. That trap is already paid for once, and paying for it twice is how
 * the two paths drift.
 */
export function buildTerminalCommand(
  workspace: Workspace,
  shellCommand: string
): { command: string; args: string[]; cwd: string | undefined } {
  return buildAgentCommand(workspace, shellCommand);
}

export interface TerminalSessionSummary {
  workspaceId: string;
  /** The directory the shell was started in, as the workspace's own environment names it. */
  cwd: string;
  shell: string;
  pid: number | null;
  startedAt: string;
  cols: number;
  rows: number;
  /** Set once the shell has exited; null while it is running. */
  exitCode: number | null;
}

export interface TerminalSessionHooks {
  onOutput: (data: string, sequence: number) => void;
  onExit: (code: number | null) => void;
}

/**
 * One shell, one workspace, one transcript.
 *
 * Chunks go out as they arrive rather than being accumulated and read once the process
 * exits, which is the one thing that makes this a terminal instead of another
 * `runAgent`: there, `stdout += chunk` and a single read on close is why a board can say a
 * run is `running` and nothing more.
 */
export class TerminalSession {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly startedAt = new Date().toISOString();

  private readonly child: ChildProcess;
  private readonly hooks: TerminalSessionHooks;
  private buffer = '';
  private sequenceNumber = 0;
  private cols = DEFAULT_GRID.cols;
  private rows = DEFAULT_GRID.rows;
  /** Whether the shell has gone, kept apart from *how*: a killed process reports no code. */
  private hasExited = false;
  private exitCode: number | null = null;
  private closing = false;

  constructor(workspace: Workspace, shellCommand: string, hooks: TerminalSessionHooks) {
    const { command, args, cwd } = buildTerminalCommand(workspace, shellCommand);
    this.workspaceId = workspace.id;
    this.shell = shellCommand;
    // What the shell itself will report from `pwd`, which for a WSL project is not the
    // path this process used to spawn it.
    this.cwd = workspace.environment.kind === 'wsl' ? workspace.innerPath : (cwd ?? workspace.path);
    this.hooks = hooks;

    logger.info(`Starting terminal for workspace "${workspace.id}"`, { command, cwd: this.cwd });

    this.child = spawn(command, args, {
      cwd,
      // The same PATH the agents get: a server started before the GitHub CLI was installed
      // would otherwise hand this shell a PATH without it, and `gh` is most of what anyone
      // types in here.
      env: { ...process.env, PATH: agentPath() },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.emit(chunk));
    // Merged rather than kept apart: a terminal shows one stream, and interleaving is the
    // information — an error belongs after the command that caused it.
    this.child.stderr?.on('data', (chunk: string) => this.emit(chunk));
    this.child.stdin?.on('error', () => { /* the shell may be gone before a write lands */ });

    this.child.on('error', (error) => {
      this.emit(`\n[the shell could not be started: ${error.message}]\n`);
      this.settle(null);
    });
    this.child.on('close', (code) => this.settle(code));
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get alive(): boolean {
    return !this.hasExited;
  }

  get scrollback(): string {
    return this.buffer;
  }

  get sequence(): number {
    return this.sequenceNumber;
  }

  summary(): TerminalSessionSummary {
    return {
      workspaceId: this.workspaceId,
      cwd: this.cwd,
      shell: this.shell,
      pid: this.pid,
      startedAt: this.startedAt,
      cols: this.cols,
      rows: this.rows,
      exitCode: this.exitCode,
    };
  }

  /**
   * Send a line to the shell, and put it in the transcript.
   *
   * The echo is written here rather than in the browser because the transcript is what a
   * late socket replays: a shell reading a pipe echoes nothing, so without this the
   * scrollback would be answers with no questions in it, and a second viewer would see
   * output nobody appeared to ask for.
   */
  write(data: string): number {
    if (!this.alive) return this.sequenceNumber;
    this.emit(data);
    this.child.stdin?.write(data);
    return this.sequenceNumber;
  }

  /**
   * Record the grid the block now stands for.
   *
   * Recorded, not pushed: there is no PTY here, so there is no `TIOCSWINSZ` to send and
   * nothing inside the shell is told. It is still worth keeping — it is what a second
   * viewer sizes its own block from, and it is the one piece of state a PTY would need on
   * the day one arrives.
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * End the session, and take whatever it was running with it.
   *
   * `stdin.end()` first, which is how a shell reading a pipe exits of its own accord, then
   * the process. On Windows the tree is killed explicitly: `child.kill()` reaches the shell
   * and not the command running inside it, and a session closed while something was running
   * would otherwise leave that something behind with nothing left to stop it.
   */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    try { this.child.stdin?.end(); } catch { /* already gone */ }
    if (!this.alive) return;

    const pid = this.pid;
    if (process.platform === 'win32' && pid) {
      const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      if (killed.status === 0) return;
    }
    try { this.child.kill(); } catch { /* already gone */ }
  }

  /** Append to the transcript, trim it to the ceiling, and hand the chunk on. */
  private emit(chunk: string): void {
    if (!chunk) return;
    this.sequenceNumber += 1;
    this.buffer = (this.buffer + chunk).slice(-SCROLLBACK_LIMIT);
    this.hooks.onOutput(chunk, this.sequenceNumber);
  }

  private settle(code: number | null): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.exitCode = code;
    logger.info(`Terminal for workspace "${this.workspaceId}" exited`, { code });
    this.hooks.onExit(code);
  }
}
