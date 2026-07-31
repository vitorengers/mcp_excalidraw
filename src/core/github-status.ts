/**
 * Whether `gh` is there, and whether it is logged in — asked before anything needs it.
 *
 * Every GitHub failure on this board used to end in the same silence. `runGh` rejects with the
 * last 300 characters of stderr, `GET /api/project-board` turns that into a 502, and the page
 * dropped it on the floor: a missing CLI, a logged-out one, a token without the `project`
 * scope and a project the account cannot see were one blank corner of canvas, repainted every
 * twenty seconds. There was no preflight anywhere — nothing in `src/` ever ran `gh --version`
 * or `gh auth status` — so the board had nothing to say even when it wanted to.
 *
 * This is that preflight. It runs the two commands, per workspace, and turns them into an
 * answer the canvas can put in a sentence.
 *
 * **The rules it inherits from `agent-preflight.ts`, because they are the same rules:**
 *
 *  1. *Non-fatal and time-boxed.* Every probe has a deadline, every failure is a status rather
 *     than an exception, and nothing on the path to the board coming up waits for one.
 *  2. *Nothing that reaches an unauthenticated route may carry the command line.* `/health`
 *     gets `resolved` and a version number and nothing else. The login, the scopes and `gh`'s
 *     own stderr go on `/api/github-status`, which is loopback-only for the same reason every
 *     other `gh` route is.
 *
 * **The whole command, not argv[0].** `agent-preflight` probes the binary alone because an
 * operator's agent command carries their permission flags and re-running it whole at every boot
 * would re-run those. `EXCALIDRAW_GH_COMMAND` is not that: it is a prefix every call in this
 * project already appends a subcommand to, so `<command> --version` is the same shape as
 * `<command> api graphql …`, and probing argv[0] instead would report `node` — which always
 * exists — for a stub or a wrapper that does not work at all.
 */
import {
  ProbeRun,
  ProbeRunner,
  ProbeSpec,
  spawnProbe,
  versionNumber,
} from './agent-preflight.js';
import { agentPath, buildAgentCommand, tokenizeCommand } from './issue-agent.js';
import { ghCommandFor } from './gh.js';
import { env } from './settings.js';
import { Workspace } from './workspaces.js';

/**
 * What the board knows about the CLI itself.
 *
 * `probing` is the honest answer before the startup probe lands, and it exists for the same
 * reason `agent-preflight`'s does: `/health` is what `stop`, auto-start and the restart
 * supervisor wait on, so it answers synchronously or it makes a slow machine look like a board
 * that never came up.
 */
export type GithubResolution = 'probing' | 'found' | 'not found' | 'unknown';

/** What `/health` says about `gh`. No login, no scopes, no stderr — see rule 2. */
export interface GithubHealth {
  resolved: GithubResolution;
  /** A version number and nothing else, extracted by `versionNumber`. */
  version: string | null;
}

/** The full answer, for the loopback-only route. */
export interface GithubStatus extends GithubHealth {
  /** Whether the command ran at all. The spawn is the test — see `interpretVersion`. */
  installed: boolean;
  /** Whether `gh auth status` exited zero. False whenever the CLI could not be run. */
  authenticated: boolean;
  /** The account `gh` says is logged in, or null. */
  login: string | null;
  /** The token's scopes as `gh` printed them, or empty. `project` is the one that matters. */
  scopes: string[];
  /** The first line of whatever `gh` said when a probe failed, raw, or null. */
  error: string | null;
}

/**
 * How long a probe may take.
 *
 * The distro number is the larger one because a cold `wsl.exe` has a distro to start before it
 * has a binary to look for — the same asymmetry `agent-preflight` pays for, for the same
 * reason. `gh auth status` reaches the network on a good day, which is why it is not the
 * smaller of the two.
 */
const TIMEOUT_MS = { native: 8000, wsl: 20000 } as const;

/** The shell's ways of saying it could not find the thing it was asked for. */
const NOT_FOUND_OUTPUT = /command not found|no such file or directory|is not recognized/i;

/** The startup answer, before anything has run. */
export function initialGithub(): GithubHealth {
  return { resolved: 'probing', version: null };
}

/**
 * The spawn one probe runs.
 *
 * `null` is the host's own `gh`, which is what `/health` reports on: that field is about the
 * machine rather than about any one board, and a server with no projects at all still has an
 * answer to give. A workspace goes through `buildAgentCommand` so a project inside a distro is
 * asked about the `gh` *in the distro* — the same route `runGh` takes, because a preflight that
 * reached the CLI another way would be proving that other way works.
 */
export function githubProbeSpec(workspace: Workspace | null, tail: string): ProbeSpec {
  // `agentPath()` for the reason `runGh` uses it: the CLI is not on `PATH` on every machine
  // this runs on, and a preflight probing a bare `PATH` would report it missing on a board
  // where every `gh` call succeeds.
  const childEnv = { ...process.env, PATH: agentPath() };
  if (!workspace) {
    // The command through `env()` rather than `process.env`, which is #311's rule and not a
    // style preference: it may come from `config.json` or a `.env` as well as from the
    // environment, under either prefix, and a preflight that read one layer would answer about
    // a command the runs do not use.
    const tokens = tokenizeCommand(`${env('GH_COMMAND')?.trim() || 'gh'} ${tail}`);
    return { command: tokens[0] ?? 'gh', args: tokens.slice(1), cwd: undefined, env: childEnv };
  }
  return { ...buildAgentCommand(workspace, `${ghCommandFor(workspace)} ${tail}`), env: childEnv };
}

/**
 * What `gh --version` coming back means.
 *
 * The native rule is `agent-preflight`'s, unchanged and for its reason: **the spawn is the
 * test.** `ENOENT` means the binary is not there; anything that started is there, whatever it
 * thought of the flag. A CLI that is installed but broken is a different complaint from a CLI
 * that is missing, and telling the reader to install something they already have sends them the
 * wrong way.
 *
 * Inside a distro the spawn only proves `wsl.exe` is there, so the verdict is the exit code
 * `bash -lc` reports: 127 is a command it could not find.
 */
export function interpretVersion(kind: 'native' | 'wsl', run: ProbeRun): GithubResolution {
  if (run.spawnError) {
    // A spawn error in the distro case is `wsl.exe` failing, which says nothing at all about
    // the CLI inside — a machine with no WSL is not a machine with no `gh`.
    if (kind === 'wsl') return 'unknown';
    return run.spawnError === 'ENOENT' ? 'not found' : 'unknown';
  }
  if (run.timedOut) return 'unknown';
  const output = `${run.stdout}\n${run.stderr}`;
  if (NOT_FOUND_OUTPUT.test(output)) return 'not found';
  if (kind === 'wsl' && run.code === 127) return 'not found';
  return run.code === null ? 'unknown' : 'found';
}

/**
 * The account and the scopes out of what `gh auth status` printed.
 *
 * Two shapes, because both are in the wild: `Logged in to github.com account <login>` is what
 * gh 2.40 and later print, and `Logged in to github.com as <login>` is what everything before
 * it printed. The scopes line quotes each scope in the newer versions and does not in the
 * older ones, so the quotes come off either way.
 *
 * Read out of stdout *and* stderr together: `gh auth status` moved from one to the other
 * between versions, and a parser that picked one would work on exactly the versions it was
 * written against.
 */
export function parseAuthStatus(text: string): { login: string | null; scopes: string[] } {
  const login = /Logged in to \S+ (?:account |as )([A-Za-z0-9][A-Za-z0-9-]*)/.exec(text);
  const scopes = /Token scopes:\s*(.+)/.exec(text);
  return {
    login: login?.[1] ?? null,
    scopes: (scopes?.[1] ?? '')
      .split(',')
      .map((scope) => scope.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  };
}

/** The first line of whatever a failing command said, raw, or null when it said nothing. */
export function firstLine(...streams: string[]): string | null {
  for (const stream of streams) {
    const line = stream.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    if (line) return line;
  }
  return null;
}

export interface GithubStatusOptions {
  run?: ProbeRunner;
}

/**
 * Ask `gh` about itself, once.
 *
 * `auth status` is skipped when `--version` could not be run at all: a login question put to a
 * binary that is not there answers `not found` a second time, more slowly, and the sentence the
 * canvas needs is already settled by the first probe.
 */
export async function readGithubStatus(
  workspace: Workspace | null,
  options: GithubStatusOptions = {}
): Promise<GithubStatus> {
  const run = options.run ?? spawnProbe;
  const kind = workspace?.environment.kind === 'wsl' ? 'wsl' : 'native';

  const version = await run(githubProbeSpec(workspace, '--version'), TIMEOUT_MS[kind]);
  const resolved = interpretVersion(kind, version);
  if (resolved !== 'found') {
    return {
      resolved,
      version: null,
      installed: false,
      authenticated: false,
      login: null,
      scopes: [],
      error: firstLine(version.stderr, version.stdout)
        ?? (version.spawnError ? `gh could not be started: ${version.spawnError}` : null)
        ?? (version.timedOut ? 'gh --version did not answer' : null),
    };
  }

  const auth = await run(githubProbeSpec(workspace, 'auth status'), TIMEOUT_MS[kind]);
  const said = `${auth.stdout}\n${auth.stderr}`;
  const authenticated = !auth.spawnError && !auth.timedOut && auth.code === 0;
  const { login, scopes } = parseAuthStatus(said);

  return {
    resolved,
    version: versionNumber(`${version.stdout}\n${version.stderr}`),
    installed: true,
    authenticated,
    // Only from a run that succeeded. A failed `auth status` still prints the host it tried,
    // and reading a login out of that would report an account that is not logged in.
    login: authenticated ? login : null,
    scopes: authenticated ? scopes : [],
    error: authenticated
      ? null
      : firstLine(auth.stderr, auth.stdout)
        ?? (auth.spawnError ? `gh auth status could not be started: ${auth.spawnError}` : null)
        ?? (auth.timedOut ? 'gh auth status did not answer' : null),
  };
}

/** The `/health` half of an answer: what a reader of that route is allowed to see. */
export function githubHealth(status: GithubStatus): GithubHealth {
  return { resolved: status.resolved, version: status.version };
}

/**
 * What to say about it at startup, on the operator's own console and log.
 *
 * `warn` for the one case that is a board whose GitHub features will do nothing, and `info` for
 * the rest — a level that fires on every board is a level nobody reads. The binary is not named
 * here, unlike the agent preflight: `gh` is `gh`, and the variable that overrides it is the
 * actionable half.
 */
export function githubPreflightLine(status: GithubStatus): { level: 'info' | 'warn'; message: string } {
  if (status.resolved === 'not found') {
    return {
      level: 'warn',
      message: 'GitHub preflight: the gh CLI was not found, so the project mirror, the issue '
        + 'panel and every run will fail silently. Install it, or set EXCALIDRAW_GH_COMMAND '
        + '(EXCALIDRAW_GH_COMMAND_WSL for a project inside a distro) to where it lives.',
    };
  }
  if (status.resolved === 'unknown') {
    return {
      level: 'info',
      message: 'GitHub preflight: gh neither answered nor reported itself missing. It may still '
        + 'work; the preflight could not say.',
    };
  }
  if (!status.authenticated) {
    return {
      level: 'warn',
      message: 'GitHub preflight: gh is installed but not logged in, so the project mirror will '
        + `stay empty. Run "gh auth login".${status.error ? ` gh said: ${status.error}` : ''}`,
    };
  }
  if (!status.scopes.includes('project')) {
    return {
      level: 'warn',
      message: `GitHub preflight: gh is logged in as ${status.login ?? 'an account'} without the `
        + '"project" scope, so the board mirror cannot be read. Run '
        + '"gh auth refresh -s project".',
    };
  }
  return {
    level: 'info',
    message: `GitHub preflight: gh${status.version ? ` ${status.version}` : ''} is logged in as `
      + `${status.login ?? 'an account'}, with the "project" scope.`,
  };
}
