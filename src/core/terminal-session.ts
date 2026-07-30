/**
 * A shell the server owns, running in a workspace, streaming as it goes.
 *
 * This is a strictly more dangerous thing than the issue agent, which
 * `docs/issue-block.md` already calls the most dangerous thing this server does: that one
 * spawns a process with a fixed prompt, this one spawns a process that runs whatever
 * arrives over an API with no authentication. So it copies the same guards, and the copy is
 * deliberate — opt in by environment variable, loopback only, and a **capped** number of
 * sessions per workspace. The routes in `src/server.ts` apply them.
 *
 * A PTY where there is one, and a pipe where there is not. A pipe runs commands and streams
 * their output, and that is all it can ever do: a process on three pipes sees `stdin.isTTY`
 * false, and every full-screen program — `vim`, `top`, Claude Code's own interface — asks
 * that first and takes its non-interactive path. So the PTY is what the session prefers,
 * from an `optionalDependency` with prebuilt binaries loaded at runtime; a machine that has
 * no binary for its platform still gets the pipe rather than a server that will not start.
 * Which of the two it got is in the summary, because a feature that behaves differently on
 * two machines with no way to tell them apart is worse than one that only does less.
 * `docs/terminal.md` records what each mode costs.
 */
import { spawn, spawnSync, ChildProcess } from 'child_process';
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
// `resolveExecutable` moved to `issue-agent.ts` — `agentPath()` asks it the same question
// there, and one PATH lookup shared is one that cannot drift from the terminal's.
import { AgentDirectory, agentEnv, buildAgentCommand, resolveExecutable } from './issue-agent.js';
import { streamsUsage } from './agent-usage.js';
import { AgentStreamRenderer } from './agent-stream-render.js';

/**
 * How much transcript is kept for a socket that connects late.
 *
 * Held server-side and replayed on connect, because the shape on the board is derived: it
 * is rebuilt every session and carries none of this, and a scrollback in `customData`
 * would be synced, exported and committed. A ceiling because a session left running with
 * something noisy in it must not grow without one.
 */
export const SCROLLBACK_LIMIT = 200_000;

/**
 * How many shells one board may have running at once.
 *
 * The rule used to be one, and that was a guard rather than an oversight: this runs whatever
 * arrives over an unauthenticated API, so the count is one of the three things standing
 * between the feature and a machine. Tabs relax it from 1 to N; they do not remove it, and
 * "unbounded" would remove it — a page that could ask in a loop would be asking for as many
 * shells as it liked.
 *
 * Eight because it is more tabs than anyone opens on one board and still a number the
 * machine notices: at `SCROLLBACK_LIMIT` per session it is a worst case of 1.6 MB of
 * transcript held server-side, which is a ceiling worth having rather than one worth fearing.
 * The ceiling stays **per session** rather than becoming a per-board budget, because a shared
 * budget would make one noisy session eat another one's history — the transcripts would then
 * disagree about how far back a board remembers depending on which tab was busy.
 */
export const TERMINAL_SESSION_LIMIT = 8;

/** What a block reports before anything has resized it. */
export const DEFAULT_GRID = { cols: 80, rows: 24 };

/** Whether the shell is talking to a terminal or to three pipes. */
export type TerminalMode = 'pty' | 'pipe';

/** The slice of the PTY binding this uses, named so nothing here depends on its types. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string | undefined;
      env?: Record<string, string>;
      useConpty?: boolean;
    }
  ): PtyProcess;
}

/**
 * The PTY binding, once, or null.
 *
 * `@lydell/node-pty` rather than `node-pty` itself: the objection this feature was built
 * around was that a PTY would be "the first thing here that needs a compiler to install",
 * and that fork ships the binary per platform as its own `optionalDependencies`
 * (`win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`),
 * so `npm install` on any of them fetches a prebuilt `.node` and never runs `node-gyp`.
 * Anywhere else npm skips the optional dependency, the import below throws, and this
 * returns null.
 *
 * The specifier is held in a variable on purpose: a bare `import('@lydell/node-pty')` is a
 * static dependency as far as the compiler is concerned, and `tsc` in a clean checkout that
 * skipped the optional install would fail on a module that is allowed to be missing.
 *
 * `EXCALIDRAW_TERMINAL_PTY=0` forces the pipe. That is what a machine with no prebuilt
 * binary gets for free, and having a way to ask for it deliberately is what lets that path
 * be checked on a machine where the binary is present.
 */
const PTY_SPECIFIER = '@lydell/node-pty';
let ptyLoad: Promise<PtyModule | null> | null = null;

export function ptyDisabled(setting: string | undefined | null = process.env.EXCALIDRAW_TERMINAL_PTY): boolean {
  return /^(0|false|off|no|disabled)$/i.test((setting ?? '').trim());
}

export async function loadPty(): Promise<PtyModule | null> {
  if (ptyDisabled()) return null;
  if (!ptyLoad) {
    ptyLoad = (async () => {
      try {
        const loaded = await import(/* @vite-ignore */ PTY_SPECIFIER) as { spawn?: unknown; default?: unknown };
        const candidate = (typeof loaded.spawn === 'function' ? loaded : loaded.default) as PtyModule | undefined;
        if (!candidate || typeof candidate.spawn !== 'function') return null;
        return candidate;
      } catch (error) {
        logger.info('No PTY binding is available, so the terminal will use pipes', {
          reason: (error as Error).message
        });
        return null;
      }
    })();
  }
  return ptyLoad;
}

/**
 * The shell to start when the setting says "on" but does not say which.
 *
 * PowerShell on Windows rather than `cmd.exe` because `pwd`, `ls` and `cat` all mean
 * something there, and a terminal whose first command fails on the platform's own spelling
 * is a poor first impression. `-NoProfile` keeps a machine's own profile out of a shell this
 * server started.
 *
 * The two modes need two spellings of it, and this is not a preference. `-Command -` reads
 * commands from stdin, and PowerShell refuses it outright when stdin is a terminal —
 * "'-' was specified as the argument to -Command, but standard input has not been
 * redirected" — printing its usage and exiting. Handed a real console it wants to be the
 * console's shell, which is also what makes it echo, edit lines and colour its own prompt.
 */
export function defaultShellCommand(workspace: Workspace, mode: TerminalMode = 'pipe'): string {
  if (workspace.environment.kind === 'wsl') return 'bash';
  if (process.platform === 'win32') {
    return mode === 'pty'
      ? 'powershell.exe -NoLogo -NoProfile'
      : 'powershell.exe -NoLogo -NoProfile -Command -';
  }
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
  workspace: Workspace,
  mode: TerminalMode = 'pipe'
): string | null {
  const value = (setting ?? '').trim();
  if (!value) return null;
  return /^(1|true|on|yes|enabled|default)$/i.test(value)
    ? defaultShellCommand(workspace, mode)
    : value;
}

/**
 * The shell, in the workspace's own environment.
 *
 * `buildAgentCommand` and nothing new: a WSL-backed project has to run inside the distro at
 * the path the distro names, because a Windows UNC path is not a working directory `git`
 * in there can act on. That trap is already paid for once, and paying for it twice is how
 * the two paths drift.
 *
 * `directory` is the same argument the agents already pass, and it arrives here for the same
 * reason: an implementation runs in `<project>-worktrees/issue-<n>` rather than in the
 * project, so a session hosting one has to start there. Omitted — which is every session a
 * reader opens — the shell starts in the project, exactly as it did.
 */
export function buildTerminalCommand(
  workspace: Workspace,
  shellCommand: string,
  directory?: AgentDirectory | null,
  prompt?: string | null
): { command: string; args: string[]; cwd: string | undefined } {
  return buildAgentCommand(workspace, shellCommand, directory, prompt);
}

/**
 * A watcher that takes the shell down when the server goes, whether the server saw it or not.
 *
 * `docs/terminal.md` promises that every session is closed when the server goes down, and a
 * piped shell kept that promise by itself: its stdin was the server's, and a closed pipe is
 * an EOF the shell exits on. A shell on a terminal has no such tie. On Windows the console
 * is serviced by a `conhost` the pseudoconsole owns rather than by the server, so the shell
 * is reparented onto it and a server killed outright — which is what `kill` is on Windows,
 * with no handler of ours getting to run — leaves a PowerShell attached to a console nobody
 * is reading. Measured, that happened on roughly half of the hard kills.
 *
 * So the promise gets a keeper: one detached process per PTY session that watches the two
 * pids and does what the server would have done. It is deliberately the smallest thing that
 * can be: no imports of ours, no state, and it exits the moment the shell does — which for
 * an ordinary `close()` is within one tick, because `close()` kills the shell first.
 */
const REAPER = `
const [owner, shell] = process.argv.slice(1).map(Number);
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
const timer = setInterval(() => {
  if (gone(shell)) { clearInterval(timer); process.exit(0); }
  if (!gone(owner)) return;
  clearInterval(timer);
  if (process.platform === 'win32') {
    require('child_process').spawnSync('taskkill', ['/PID', String(shell), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-shell, 'SIGKILL'); } catch {}
    try { process.kill(shell, 'SIGKILL'); } catch {}
  }
  process.exit(0);
}, 400);
`;

/** How far back a cut may look for the escape it might be standing in the middle of. */
const MAX_SEQUENCE = 4096;

/**
 * Where the escape sequence starting at `start` ends, or null if it does not end here.
 *
 * Only as much of the grammar as a boundary needs: CSI (`ESC [`) runs to a byte in
 * `@`–`~`; OSC and the string escapes (`DCS`, `SOS`, `PM`, `APC`) run to `BEL` or to `ST`
 * (`ESC \`); the charset designators take one more byte; anything else is two bytes long.
 */
function sequenceEnd(text: string, start: number): number | null {
  const limit = Math.min(text.length, start + MAX_SEQUENCE);
  const next = text[start + 1];
  if (next === undefined) return null;

  if (next === '[') {
    for (let index = start + 2; index < limit; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return null;
  }

  if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
    for (let index = start + 2; index < limit; index++) {
      if (text.charCodeAt(index) === 0x07) return index + 1;
      if (text.charCodeAt(index) === 0x1b && text[index + 1] === '\\') return index + 2;
    }
    return null;
  }

  return '()*+#%'.includes(next) ? start + 3 : start + 2;
}

/**
 * Keep the last `limit` characters, without cutting through an escape sequence.
 *
 * On a plain byte stream any offset is a boundary, which is what the old
 * `buffer.slice(-LIMIT)` assumed. On a stream from a PTY it is not: a cut through
 * `ESC [ 3 1 m` leaves `1m`, and every viewer that replays the scrollback then prints two
 * characters nobody wrote — or, for a cut through an OSC, swallows everything up to the
 * next terminator. The ceiling is still a ceiling; what gives is the exact offset, which
 * moves forward past the sequence it landed in.
 */
export function trimScrollback(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.length - limit;
  const floor = Math.max(0, cut - MAX_SEQUENCE);
  for (let index = cut - 1; index >= floor; index--) {
    if (text.charCodeAt(index) !== 0x1b) continue;
    const end = sequenceEnd(text, index);
    // Only a sequence that is still open at the cut moves it; one that closed before it is
    // already whole on the far side, and an unterminated run is not treated as a sequence
    // at all rather than being allowed to swallow the rest of the transcript.
    return text.slice(end !== null && end > cut ? end : cut);
  }
  return text.slice(cut);
}

/**
 * Whose session this is, when the board opened it for something rather than for a reader.
 *
 * The leftover `docs/whats-next.md` named: a session the server opened for an agent is one
 * nobody typed into, and a tab labelled `s4` beside three shells the reader started is
 * indistinguishable from them. Null for every session a reader opens, which is what keeps
 * those tabs exactly what they were.
 */
export interface TerminalSessionOwner {
  /** Which of the board's agents is running here. */
  agent: 'implement';
  /** The issue it is working on, which is the thing worth clicking through to. */
  issueUrl: string;
  /** What the tab says. Short enough to be one: `#128`. */
  label: string;
}

/**
 * What a session is opened with, beyond the shell itself.
 *
 * Every field is absent for a session a reader opened, and that is the point: the three
 * together are the whole of what makes an agent's session different from a shell's, so a
 * reader's session takes the path it took before any of this existed.
 */
export interface TerminalSessionOptions {
  /** Where the shell starts, when that is not the project directory. */
  directory?: AgentDirectory | null;
  owner?: TerminalSessionOwner | null;
  /**
   * Written to the process's stdin once, which is then closed.
   *
   * This is how an agent's prompt arrives, and it is **why an owned session runs on pipes**.
   * A pseudoterminal has no end of file to send: measured on ConPTY, a child reading stdin
   * sees neither `^Z` nor `^D` as one and simply goes on reading, so a `claude -p` handed
   * its prompt that way would wait forever for a prompt that never ended. The constructor
   * therefore ignores the PTY binding when this is set, rather than leaving the trap for a
   * caller to fall into — and `mode` in the summary says `pipe`, so the block does not
   * claim otherwise. `docs/terminal.md` records the measurement.
   *
   * Unless `interactive` says the prompt need not go through stdin at all.
   */
  input?: string | null;
  /**
   * Hand `input` to the command as its last argument, and keep the pseudoterminal.
   *
   * The measurement above constrains how a prompt is *delivered*, not whether the thing
   * receiving it can be an interface. `claude [options] [prompt]` takes one as an argument
   * and starts an interactive session with it, so nothing has to be ended and stdin is never
   * spent — which is what leaves it free for the reader. `write()` then works, `mode` says
   * `pty`, and the tab is a terminal rather than a window onto one.
   *
   * Ignored without a PTY binding, and that is the fallback rather than an oversight: on
   * three pipes `stdin.isTTY` is false and a full-screen program takes its non-interactive
   * path anyway, so a session that could not be a terminal delivers the prompt the way it
   * always did.
   */
  interactive?: boolean;
}

export interface TerminalSessionSummary {
  /**
   * Which session this is, on a board that may have several.
   *
   * Short and readable — `s1`, `s2` — because it is also what a tab is labelled with, and a
   * tab strip is no place for a generated id. Unique for the life of the server, which is
   * the whole life of a session: nothing here survives a restart.
   */
  id: string;
  workspaceId: string;
  /** The directory the shell was started in, as the workspace's own environment names it. */
  cwd: string;
  shell: string;
  /** Whether the shell got a terminal or three pipes. The block says which. */
  mode: TerminalMode;
  pid: number | null;
  startedAt: string;
  cols: number;
  rows: number;
  /** Set once the shell has exited; null while it is running. */
  exitCode: number | null;
  /** Whose session this is, or null for one a reader opened. */
  owner: TerminalSessionOwner | null;
  /**
   * Whether there is anything for a keystroke to reach.
   *
   * False for every session a reader opens and for an agent's interactive one; true only
   * where stdin was spent on a prompt and closed behind it. It is in the summary because
   * the board has to be able to *say* so: a tab that quietly swallowed what was typed and
   * answered with a sequence number was reporting delivery for bytes it dropped.
   */
  readOnly: boolean;
}

export interface TerminalSessionHooks {
  /**
   * What the transcript shows and the browser is sent — rendered, when the command streams.
   *
   * Not what the process wrote. A streaming agent's envelopes are turned into readable lines
   * on the way here, and a chunk that completes no line does not reach this at all, so the
   * sequence counts what a reader saw rather than what a socket delivered.
   */
  onOutput: (data: string, sequence: number) => void;
  /**
   * Every byte the process wrote, before anything is done to it.
   *
   * This is what `runHostedAgent` accumulates for `extractGithubUrl` and feeds to
   * `UsageMeter`, and both of them parse the envelopes `onOutput` has by then deleted. The
   * two are separate hooks precisely so that making the block readable cannot cost a run its
   * pull request URL.
   */
  onRaw?: (data: string) => void;
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
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly mode: TerminalMode;
  readonly owner: TerminalSessionOwner | null;
  readonly startedAt = new Date().toISOString();

  /**
   * Settled once the shell has a process id.
   *
   * A pipe has one the moment `spawn` returns. A ConPTY does not: the console host is
   * connected on a thread of its own and the binding reports `pid` as 0 until it is, which
   * would put a 0 in the session the route answers with and hand `taskkill` a pid that
   * means "every process in this console" on the way out. The route awaits this before it
   * says the session is open, which it already had every right to do — the response is a
   * 202 about a shell that is running.
   */
  readonly started: Promise<void>;

  private readonly child: ChildProcess | null = null;
  private readonly pty: PtyProcess | null = null;
  private readonly hooks: TerminalSessionHooks;
  private buffer = '';
  private sequenceNumber = 0;
  /**
   * Set only when the command asks its agent for a machine-readable stream.
   *
   * `streamsUsage` is the same predicate that already decides whether the token meter runs, and
   * reusing it is deliberate: one flag in the operator's command line turns on the counts and
   * the readable transcript together, and a session whose command does not stream keeps the
   * old path byte for byte. The server still never appends the flag itself.
   */
  private render: AgentStreamRenderer | null = null;
  private cols = DEFAULT_GRID.cols;
  private rows = DEFAULT_GRID.rows;
  /** Whether the shell has gone, kept apart from *how*: a killed process reports no code. */
  private hasExited = false;
  private exitCode: number | null = null;
  private closing = false;
  /** Whether stdin was spent on a prompt, which is what makes this session read-only. */
  private readonly promptSent: boolean;

  constructor(
    id: string,
    workspace: Workspace,
    shellCommand: string,
    hooks: TerminalSessionHooks,
    pty: PtyModule | null = null,
    options: TerminalSessionOptions = {}
  ) {
    const directory = options.directory ?? null;
    // A prompt goes to the command's argv or to its stdin, never to both, and which one
    // decides everything else about the session: on argv the binding is kept and the tab is
    // a terminal; on stdin the binding has to go, because a pseudoterminal has no end of
    // file — see `TerminalSessionOptions.input` for the measurement that settles it.
    const asArgument = Boolean(options.interactive && options.input && pty);
    const { command, args, cwd } = buildTerminalCommand(
      workspace, shellCommand, directory, asArgument ? options.input : null
    );
    const binding = options.input && !asArgument ? null : pty;
    // Read off the command as configured, before anything wraps it for a distro: the flag is
    // the operator's, and it means the same thing on either side of the boundary.
    this.render = streamsUsage(shellCommand) ? new AgentStreamRenderer() : null;
    this.id = id;
    this.workspaceId = workspace.id;
    this.shell = shellCommand;
    this.mode = binding ? 'pty' : 'pipe';
    this.owner = options.owner ?? null;
    this.promptSent = Boolean(options.input) && !asArgument;
    // What the shell itself will report from `pwd`, which for a WSL project is not the
    // path this process used to spawn it.
    this.cwd = workspace.environment.kind === 'wsl'
      ? (directory?.innerPath ?? workspace.innerPath)
      : (cwd ?? workspace.path);
    this.hooks = hooks;

    logger.info(`Starting terminal "${id}" for workspace "${workspace.id}"`, { command, cwd: this.cwd, mode: this.mode });

    // The same environment the agents get: a PATH the GitHub CLI is on, because `gh` is
    // most of what anyone types in here, and no nested-session marker, because a shell
    // opened on a board that has been up for hours is not nested inside anything.
    const env = agentEnv();

    if (binding) {
      this.pty = binding.spawn(resolveExecutable(command, env.PATH ?? ''), args, {
        // What the shell is told it is talking to. Without it a program has no way to know
        // it may use colour, and `TERM=dumb` is what an unset one is taken to mean.
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd,
        env: { ...stringEnv(env), TERM: 'xterm-256color', ...truecolorEnv(this.render) }
      });
      this.pty.onData((chunk) => this.emit(chunk));
      this.pty.onExit(({ exitCode }) => this.settle(exitCode ?? null));
      this.started = this.waitForPid();
      return;
    }

    this.started = Promise.resolve();
    this.child = spawn(command, args, {
      cwd,
      env,
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

    // The prompt, and then the end of file the agent is waiting for. Not echoed into the
    // transcript the way `write()` echoes what was typed: several hundred words of
    // instruction ahead of the first line the agent prints would bury the run in the thing
    // the tab was opened to watch.
    if (options.input) this.child.stdin?.end(options.input);

    this.child.on('error', (error) => {
      this.emit(`\n[the shell could not be started: ${error.message}]\n`);
      this.settle(null);
    });
    this.child.on('close', (code) => this.settle(code));
  }

  get pid(): number | null {
    return this.pty ? this.pty.pid : (this.child?.pid ?? null);
  }

  get alive(): boolean {
    return !this.hasExited;
  }

  /** Whether stdin was spent on a prompt, so there is nothing a keystroke could reach. */
  get readOnly(): boolean {
    return this.promptSent;
  }

  get scrollback(): string {
    return this.buffer;
  }

  get sequence(): number {
    return this.sequenceNumber;
  }

  summary(): TerminalSessionSummary {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      cwd: this.cwd,
      shell: this.shell,
      mode: this.mode,
      pid: this.pid,
      startedAt: this.startedAt,
      cols: this.cols,
      rows: this.rows,
      exitCode: this.exitCode,
      owner: this.owner,
      readOnly: this.promptSent,
    };
  }

  /**
   * Send what was typed to the shell, whatever it was.
   *
   * Bytes, not a line: with a terminal in front of it the browser sends `\r` for Enter,
   * `\x03` for Ctrl+C and `ESC [ A` for an arrow, and a route that appended a newline to
   * every one of those would make three of them mean nothing.
   *
   * The echo is the difference between the two modes. A shell reading a pipe echoes
   * nothing, so the session writes what it was sent into the transcript itself — otherwise
   * the scrollback would be answers with no questions in it, and a second viewer would see
   * output nobody appeared to ask for. A shell on a terminal echoes for itself, and a
   * session that still added its own would show every keystroke twice.
   */
  write(data: string): number {
    if (!this.alive) return this.sequenceNumber;
    // A session that was handed a prompt has had its stdin closed behind it, so there is
    // nothing for a keystroke to reach. Echoing it anyway would put the reader's typing in
    // the transcript and let it read as though the agent had received it.
    if (this.promptSent) return this.sequenceNumber;
    if (this.pty) {
      this.pty.write(data);
      return this.sequenceNumber;
    }
    this.emit(data);
    this.child?.stdin?.write(data);
    return this.sequenceNumber;
  }

  /**
   * Tell the shell how big the block it is drawn in has become.
   *
   * Pushed now, not merely recorded: a program that repaints a screen repaints it to the
   * width it was told, so a size the child never hears about shows up as output wrapped at
   * eighty columns inside a block twice that wide. With no PTY there is still no
   * `TIOCSWINSZ` to send, and the number is kept for what it was always good for — the
   * block a second viewer draws.
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (!this.pty || !this.alive) return;
    try {
      this.pty.resize(cols, rows);
    } catch (error) {
      logger.debug('Could not resize the terminal', { error: (error as Error).message });
    }
  }

  /**
   * End the session, and take whatever it was running with it.
   *
   * `stdin.end()` first for a piped shell, which is how one exits of its own accord, then
   * the process. On Windows the tree is killed explicitly: `child.kill()` reaches the shell
   * and not the command running inside it, and a session closed while something was running
   * would otherwise leave that something behind with nothing left to stop it. A PTY is no
   * different — the shell is the console's, and what it started is still its own child.
   */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    try { this.child?.stdin?.end(); } catch { /* already gone */ }
    if (!this.alive) return;

    const pid = this.pid;
    if (process.platform === 'win32' && pid) {
      const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      if (killed.status === 0) return;
    }
    try { this.pty ? this.pty.kill() : this.child?.kill(); } catch { /* already gone */ }
  }

  /** Poll until the console host has connected, then set the keeper on the pair of them. */
  private async waitForPid(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (this.hasExited) return;
      if (this.pty && this.pty.pid > 0) return this.startReaper(this.pty.pid);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    logger.warn(`The terminal "${this.id}" for workspace "${this.workspaceId}" never reported a process id`);
  }

  /** Detached and unreferenced: it has to outlive this process to be of any use. */
  private startReaper(shellPid: number): void {
    try {
      spawn(process.execPath, ['-e', REAPER, String(process.pid), String(shellPid)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    } catch (error) {
      logger.warn('Could not start the terminal keeper; a hard kill may leave the shell behind', {
        error: (error as Error).message
      });
    }
  }

  /** Append to the transcript, trim it to the ceiling, and hand the chunk on. */
  private emit(chunk: string): void {
    if (!chunk) return;

    // The tap first, and unconditionally: it is reading for a pull request URL and for token
    // counts, both of which live in the envelopes the renderer is about to remove.
    this.hooks.onRaw?.(chunk);

    const shown = this.render ? this.render.feed(chunk) : chunk;
    // A chunk that completed no line is not silence, it is a half-written one. Showing it
    // would put a torn envelope in the transcript, and counting it would spend a sequence
    // number on nothing.
    if (!shown) return;

    this.sequenceNumber += 1;
    this.buffer = trimScrollback(this.buffer + shown, SCROLLBACK_LIMIT);
    this.hooks.onOutput(shown, this.sequenceNumber);
  }

  private settle(code: number | null): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.exitCode = code;
    logger.info(`Terminal "${this.id}" for workspace "${this.workspaceId}" exited`, { code });
    this.hooks.onExit(code);
  }
}

/**
 * Whether the child is told the terminal it has been given is a 24-bit one.
 *
 * `TERM=xterm-256color` is a name, and a name is where a program's colour decision stops:
 * `supports-color`, which nearly every Node CLI reaches for, promotes to 24-bit only when
 * `COLORTERM` says `truecolor` or `24bit`, and on the name alone it settles for 256. Node's own
 * `tty.WriteStream.getColorDepth` reads the same variable. So a program that would have drawn
 * its own brand colour drew the nearest of 256 instead, and this board then repainted *that*
 * with whichever of its sixteen it landed nearest — a downgrade the board asked for by omission.
 * xterm.js renders 24-bit, so there was nothing to protect. This is the same kind of statement
 * as the `NO_COLOR` strip in `agentEnv`: the board describing the terminal it is really handing
 * over, rather than filtering what the child may do with it. `NO_COLOR` still wins where an
 * operator holds it, because every library reads that first.
 *
 * **It stops at the tab an emulator draws**, which is why the renderer is the question. A tab the
 * board renders itself — `Implement / Fix`, `--output-format stream-json` — is drawn as a
 * document whose colours are slot *names* resolved against the reader's palette, and a document
 * has no answer for `38;2;r;g;b` but the default ink. Promoting that child would turn a tool's
 * coloured output from sixteen resolvable slots into an unresolvable literal, which is colour
 * lost rather than gained. So the tab that repaints itself gets the promotion and the tab the
 * board composes does not.
 */
function truecolorEnv(render: AgentStreamRenderer | null): Record<string, string> {
  return render ? {} : { COLORTERM: 'truecolor' };
}

/** `process.env` as the PTY binding wants it: no holes where a variable was unset. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
