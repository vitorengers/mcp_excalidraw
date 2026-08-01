/**
 * A shell the server owns, running in a workspace, streaming as it goes.
 *
 * This is a strictly more dangerous thing than the issue agent, which
 * `docs/issue-block.md` already calls the most dangerous thing this server does: that one
 * spawns a process with a fixed prompt, this one spawns a process that runs whatever
 * arrives over the API. So it copies the same guards, and the copy is deliberate — opt in by
 * environment variable, loopback only, and a **capped** number of sessions per workspace. The
 * routes in `src/server.ts` apply them. They stayed after #350 put a token in front of every
 * route: that token is a file this account can read, so it says nothing about a process already
 * running as this account, which is who these guards are for.
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
import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
// `resolveExecutable` moved to `issue-agent.ts` — `agentPath()` asks it the same question
// there, and one PATH lookup shared is one that cannot drift from the terminal's.
import { AgentDirectory, agentEnv, buildAgentCommand, resolveExecutable } from './issue-agent.js';
import { deliverStdin, type AgentAdapter, type AgentInvocation } from './agent-adapter.js';
import { adapterFor } from './agents/index.js';
// Named rather than taken from the adapter module: a shell somebody typed into a tab is a
// command line and nothing else, so reading it is a request for the `raw` backend's reading,
// and this import is where that is said out loud.
import { commandLineInvocation } from './agents/raw.js';
import { AgentStreamRenderer } from './agent-stream-render.js';
import { env as settingValue, settingName } from './settings.js';

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
 * arrives over the API, and anything running as this account can read the token in front of it,
 * so the count is one of the three things standing between the feature and a machine. Tabs relax it from 1 to N; they do not remove it, and
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

/**
 * How long a piped shell's process group is given to go on `SIGTERM` before it is killed.
 *
 * Short, because nothing is waiting on it — `close()` schedules the follow-up rather than
 * blocking on it — and because the window is only worth having for a process that handles the
 * signal at all. Long enough for a shell to reap what it was running and exit, which is the
 * whole of what a well-behaved one does with a `SIGTERM`.
 */
const GROUP_KILL_GRACE = 400;

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

/** What the setting reads as, when the setting is what turned the binding off. */
const PTY_DISABLED_REASON = `${settingName('TERMINAL_PTY')}=0`;

/**
 * Why the import produced no binding, written once, inside the memoised load below.
 *
 * Inside rather than beside it because the load is memoised: a reason set on the way out of
 * `loadPty()` would be right for the first session of a board's life and null for every one
 * after it, which is the shape of bug that makes a diagnostic worse than none.
 */
let ptyImportReason: string | null = null;

/**
 * Why this machine has no pseudoterminal, or null while it has one.
 *
 * Recomputed on every `loadPty()` rather than latched, so that the setting is asked afresh:
 * the import is a once-per-process fact and `EXCALIDRAW_TERMINAL_PTY` is not.
 */
let ptyReason: string | null = null;

export function ptyDisabled(setting: string | undefined | null = settingValue('TERMINAL_PTY')): boolean {
  return /^(0|false|off|no|disabled)$/i.test((setting ?? '').trim());
}

/**
 * The reason there is no PTY here, as the last `loadPty()` found it, or null.
 *
 * Read by a session on its way to being a pipe, so that the block can say *why* it is one.
 * Null before anything has asked, which is honest: nothing has been found out yet.
 */
export function ptyUnavailableReason(): string | null {
  return ptyReason;
}

export async function loadPty(): Promise<PtyModule | null> {
  if (ptyDisabled()) {
    ptyReason = PTY_DISABLED_REASON;
    return null;
  }
  if (!ptyLoad) {
    ptyLoad = (async () => {
      try {
        const loaded = await import(/* @vite-ignore */ PTY_SPECIFIER) as { spawn?: unknown; default?: unknown };
        const candidate = (typeof loaded.spawn === 'function' ? loaded : loaded.default) as PtyModule | undefined;
        if (!candidate || typeof candidate.spawn !== 'function') {
          ptyImportReason = `${PTY_SPECIFIER} imported without a spawn function, so there is no binding to use`;
          logger.warn('No PTY binding is available, so the terminal will use pipes', { reason: ptyImportReason });
          return null;
        }
        return candidate;
      } catch (error) {
        // `warn` rather than `info`, because the console transport is warn and up: on `info`
        // the one line naming the cause reached the log file alone, and a reader whose every
        // session had quietly become a pipe had no reason to open it. The message is the
        // library's own — it names the missing package (`@lydell/node-pty-linux-x64`) or the
        // link failure, which is the part anybody can act on.
        ptyImportReason = (error as Error).message;
        logger.warn('No PTY binding is available, so the terminal will use pipes', { reason: ptyImportReason });
        return null;
      }
    })();
  }
  const binding = await ptyLoad;
  ptyReason = binding ? null : ptyImportReason;
  return binding;
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
 *
 * Everywhere else it is the reader's own login shell, and that is `posixLoginShell` below.
 * A POSIX shell needs no second spelling: handed three pipes it reads its commands from
 * stdin already, so both modes get the same string.
 *
 * The WSL branch is the one place a POSIX board still gets `bash` outright, and it is not an
 * oversight: the command is run through `wsl.exe` into a distro, where the `$SHELL` this
 * process can see is the *host's* and describes a machine the shell will never run on.
 */
export function defaultShellCommand(workspace: Workspace, mode: TerminalMode = 'pipe'): string {
  if (workspace.environment.kind === 'wsl') return 'bash';
  if (process.platform === 'win32') {
    return mode === 'pty'
      ? 'powershell.exe -NoLogo -NoProfile'
      : 'powershell.exe -NoLogo -NoProfile -Command -';
  }
  return posixLoginShell();
}

/**
 * The shell a POSIX machine says its owner uses, or the best absolute path there is.
 *
 * This used to be the literal string `bash`, decided on a machine whose only non-Windows
 * case is a WSL Ubuntu whose login shell really is bash. It is wrong twice over anywhere
 * else. On macOS the login shell has been zsh since Catalina and `/bin/bash` is Apple's 3.2
 * from 2007, so a reader opening the headline feature got a shell with none of their rc
 * files, aliases or prompt. On a minimal Debian, an Alpine, or a container image carrying
 * only dash or ash, `bash` is not on `PATH` at all and the session dies in the spawn.
 *
 * `$SHELL` is what a login sets to the shell that machine's owner chose, so it is read
 * first — and only when it is **absolute**, because a bare name is exactly the thing being
 * fixed and a relative one would be resolved against a working directory that has nothing to
 * do with it. `startsWith('/')` rather than `isAbsolute`, so the question stays "is this a
 * POSIX path" on whichever platform is asking: `path.isAbsolute` answers for the host's
 * spelling, and this branch is about the other one.
 *
 * Unset — a daemon, a container, a cron — falls back to `/bin/bash` where it is there and
 * `/bin/sh` where it is not. That is the open question the issue named, decided both ways
 * round: `/bin/bash` is the closest match to what this returned before, so a machine that
 * had it keeps the shell it had, and `/bin/sh` is the only one POSIX guarantees, so a
 * machine that has no bash gets a shell rather than a spawn error. Either way the answer is
 * a path rather than a name, which is what the failure above was.
 */
function posixLoginShell(shell: string | undefined = process.env.SHELL): string {
  const named = (shell ?? '').trim();
  if (named.startsWith('/')) return named;
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
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
  shell: AgentInvocation | string,
  directory?: AgentDirectory | null,
  prompt?: string | null
): { command: string; args: string[]; cwd: string | undefined } {
  return buildAgentCommand(workspace, shell, directory, prompt);
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
   * The agent's prompt, delivered wherever the invocation says it goes.
   *
   * **Where is not this option's to say, and it never was the caller's.** The backend running
   * knows what its CLI reads: `claude -p` takes the prompt on stdin and needs the end of file
   * that closes it, `codex exec` takes it as an argument and reads a piped stdin beside one as
   * mere context. So this is the prompt, and `AgentInvocation.prompt` is the channel.
   *
   * A prompt on stdin is **why such a session runs on pipes**. A pseudoterminal has no end of
   * file to send: measured on ConPTY, a child reading stdin sees neither `^Z` nor `^D` as one
   * and simply goes on reading, so a `claude -p` handed its prompt that way would wait forever
   * for a prompt that never ended. The constructor therefore ignores the PTY binding for such a
   * run rather than leaving the trap for a caller to fall into — and `mode` in the summary says
   * `pipe`, so the block does not claim otherwise. `docs/terminal.md` records the measurement.
   *
   * A prompt on argv leaves stdin unspent, and what becomes of it is the invocation's answer
   * too: kept for the reader, which is what a pseudoterminal is *for*, or closed empty, because
   * a CLI handed a pipe with no writer blocks in `read()` rather than starting.
   */
  input?: string | null;
  /**
   * The agent this session is running, when it is running one rather than a shell.
   *
   * Two things come from it and nothing else does: the argv the process is spawned with — so
   * a backend that builds its own flags is not re-derived from the string this session
   * *displays* — and the grammar the transcript is rendered in. Absent, the command is taken
   * as a command line and read the way the `raw` backend reads one, which is exactly what
   * this class did before backends existed and is right for a shell somebody typed.
   */
  agent?: { adapter: AgentAdapter; invocation: AgentInvocation } | null;
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
  /**
   * Why it is `pipe`, when that is a fallback, and null when it is not.
   *
   * The mode says *what* happened and this says *why*, which is the difference between a
   * reader knowing their board behaves differently from the one in the documentation and
   * knowing what to install. Three answers: the import error's own message on a platform
   * `@lydell/node-pty` ships no prebuilt binary for, `EXCALIDRAW_TERMINAL_PTY=0` where the
   * fallback was asked for, and null where nothing needs explaining — a working PTY, or a
   * session whose stdin was spent on a prompt, which is on pipes by construction on every
   * machine there is and would be mislabelled by a cause belonging to this one.
   */
  pipeReason: string | null;
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
  /** Why the mode is `pipe`, where that is a fallback. See `TerminalSessionSummary`. */
  readonly pipeReason: string | null;
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
   * Set only when the invocation this session is running speaks while it works.
   *
   * `AgentAdapter.streams` is the same question that decides whether the token meter runs, and
   * asking it once is deliberate: the counts and the readable transcript are the two halves of
   * a run a reader can follow, and a session whose agent does not stream keeps the old path
   * byte for byte. What it is *not* any more is a regular expression over the command line this
   * session displays — `codex exec --json` streams and says none of Claude Code's flags, so the
   * old reading left that tab full of raw JSON Lines.
   */
  private render: AgentStreamRenderer | null = null;
  private cols = DEFAULT_GRID.cols;
  private rows = DEFAULT_GRID.rows;
  /** Whether the shell has gone, kept apart from *how*: a killed process reports no code. */
  private hasExited = false;
  private exitCode: number | null = null;
  private closing = false;
  /** Whether stdin is gone — spent on a prompt or closed behind one — which is read-only. */
  private readonly stdinClosed: boolean;

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
    // The agent's own invocation where there is one, and the command line read the way the
    // `raw` backend reads one where there is not — a shell somebody typed into a tab is
    // exactly that, and this is what the class did before backends existed.
    const adapter = options.agent?.adapter ?? adapterFor('raw');
    const invocation = options.agent?.invocation ?? commandLineInvocation(shellCommand);
    // The prompt is handed over unconditionally, and `buildTerminalCommand` puts it on argv only
    // where this invocation says it goes there. The invocation has the only word on that — not a
    // caller's flag beside it, which could only ever disagree with it, and not the presence of a
    // binding, which is a fact about this machine rather than about what the CLI reads.
    const { command, args, cwd } = buildTerminalCommand(
      workspace, invocation, directory, options.input ?? null
    );
    // Whether there is a terminal to give is a different question with a different answer, and
    // `prompt.stdin` is the one that answers it: a run that keeps stdin for a reader is a run
    // worth drawing an interface for, and one that spends or closes it is not. A prompt on
    // stdin could never have had one — a pseudoterminal has no end of file — and `codex exec
    // --json`, which takes its prompt on argv, must not have one either: a pseudoterminal wraps
    // at `cols`, and a wrapped JSON envelope is no longer JSON.
    const binding = options.input && invocation.prompt.stdin !== 'reader' ? null : pty;
    // Asked of the invocation rather than of the string this session displays: a named backend
    // spells the flag itself, and for `raw` the two are the same question about the same text.
    this.render = adapter.streams(invocation) ? new AgentStreamRenderer(adapter) : null;
    this.id = id;
    this.workspaceId = workspace.id;
    this.shell = shellCommand;
    this.mode = binding ? 'pty' : 'pipe';
    this.owner = options.owner ?? null;
    // Read off the binding rather than off where the prompt went, because the question is what a
    // keystroke could reach. A session given a prompt and put on pipes has had its stdin closed
    // either way — spent on the prompt, or closed empty behind a prompt that travelled on argv —
    // and in neither case is there anything left to type into.
    this.stdinClosed = Boolean(options.input) && !binding;
    // A cause only where there is one to give. A prompt on stdin puts the session on pipes
    // whatever the machine can offer — a pseudoterminal has no end of file — so naming this
    // board's missing binding there would explain a tab with something that did not decide it.
    this.pipeReason = this.mode === 'pipe' && !this.stdinClosed ? ptyUnavailableReason() : null;
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
      // A process group of its own, so that `close()` has something to signal other than the
      // shell. Without it the shell sits in the *server's* group, which is not a group anything
      // may be aimed at, and what the shell started outlives the tab it was started in — see
      // `killGroup`. POSIX only: `detached` on Windows means a new console window, and the tree
      // there is taken down by `taskkill /T` rather than by a signal.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.emit(chunk));
    // Merged rather than kept apart: a terminal shows one stream, and interleaving is the
    // information — an error belongs after the command that caused it.
    this.child.stderr?.on('data', (chunk: string) => this.emit(chunk));
    this.child.stdin?.on('error', () => { /* the shell may be gone before a write lands */ });

    // The prompt and the end of file the agent is waiting for — or, where the prompt went out
    // on argv above, the end of file alone, because a CLI handed a pipe with no writer waits on
    // it rather than starting. Not echoed into the transcript the way `write()` echoes what was
    // typed: several hundred words of instruction ahead of the first line the agent prints
    // would bury the run in the thing the tab was opened to watch.
    if (options.input) deliverStdin(this.child.stdin, invocation, options.input);

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

  /** Whether stdin is gone, so there is nothing a keystroke could reach. */
  get readOnly(): boolean {
    return this.stdinClosed;
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
      pipeReason: this.pipeReason,
      pid: this.pid,
      startedAt: this.startedAt,
      cols: this.cols,
      rows: this.rows,
      exitCode: this.exitCode,
      owner: this.owner,
      readOnly: this.stdinClosed,
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
    // A session that was handed a prompt has had its stdin closed — spent on the prompt, or
    // closed empty behind one that went out on argv — so there is nothing for a keystroke to
    // reach. Echoing it anyway would put the reader's typing in the transcript and let it read
    // as though the agent had received it.
    if (this.stdinClosed) return this.sequenceNumber;
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
   * the process. The tree is killed explicitly rather than the shell alone: `child.kill()`
   * reaches the shell and not the command running inside it, and a session closed while
   * something was running would otherwise leave that something behind with nothing left to
   * stop it. A PTY is no different — the shell is the console's, and what it started is
   * still its own child.
   *
   * How the tree is reached is the platform's answer, not ours. Windows has `taskkill /T`,
   * which walks the parent links, and it stays exactly what it was: first, and the end of
   * this method when it works. POSIX has no such walk and does not need one — a piped shell
   * is spawned `detached`, so it leads a process group, and `killGroup` signals the group.
   * The pty path is left on `pty.kill()` deliberately: closing a pseudoterminal master
   * already hangs up the foreground group, so a group kill there would be a second answer
   * to a question that has one, on a code path this issue has no measurement for.
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
    } else if (this.child && pid && this.killGroup(pid)) {
      return;
    }
    try { this.pty ? this.pty.kill() : this.child?.kill(); } catch { /* already gone */ }
  }

  /**
   * Take down the process group a piped shell leads, or say that there was none to take down.
   *
   * `SIGTERM` first, because the group is a shell and whatever it was running, and both
   * deserve the chance to go the way they would have gone had someone typed `exit` — a
   * `npm run build` gets to remove its half-written output, a dev server gets to release its
   * port. `SIGKILL` follows for the ones that do not take the hint. Aimed at `-pid` both
   * times: the group id of a `detached` child is its own pid, and a group id outlives its
   * leader for as long as any member of the group is still there, which is precisely the
   * case this exists for.
   *
   * The follow-up is scheduled rather than waited for, and `unref`'d. `close()` is called
   * from a route and from the `exit` handler, both of which are synchronous, and blocking
   * either for a grace period would stall the board on the way to a tab closing. So an
   * ordinary close gets both signals and a close on the way out of the process gets the
   * first one, which is the polite one and the one a shutdown should be sending anyway.
   *
   * `false` means the signal never landed — no such group, which on this path means the
   * shell was gone before we got here, or a platform that has no groups at all. Either way
   * the caller falls back to the single-pid kill it always did.
   */
  private killGroup(pid: number): boolean {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      return false;
    }
    const timer = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* the group went, which is the point */ }
    }, GROUP_KILL_GRACE);
    timer.unref();
    return true;
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
