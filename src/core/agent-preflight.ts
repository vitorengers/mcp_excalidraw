/**
 * Whether the agents this board is configured with can actually be run.
 *
 * `/health` used to answer that question with two booleans, and both of them meant only that a
 * string was non-empty. Nothing ever ran the binary, so a typo in a path, a CLI that was never
 * installed, and a command that resolves on the host but not inside a distro all presented
 * identically: a board that answers `status: healthy`, draws every block, offers every button
 * and does nothing when one is pressed. `docs/running.md` says outright that the agents fail
 * the most quietly of the three, and the only thing that could tell the reader otherwise was
 * `commandNotFoundHint` — a diagnosis that arrives *after* a run has already failed with exit
 * 127, somewhere the reader has to go looking for it.
 *
 * So this runs argv[0] of each configured command with `--version`, once per role and per
 * environment, and turns the quietest failure in the product into a line at startup.
 *
 * **argv[0] and `--version`, and nothing more clever than that.** The command string is the
 * operator's, and re-running it whole would re-run their `--dangerously-skip-permissions` at
 * every boot. `tokenizeCommand` gives the binary; `--version` is the one argument a CLI can be
 * asked for without doing anything. What that cannot see is a wrapper — `node ./agent.mjs`
 * probes `node` — and that is written down as the known limit of a preflight built against
 * today's command strings rather than pretended away. A backend adapter is where a command
 * stops being an opaque string.
 *
 * **Three rules the shape of this module comes from:**
 *
 *  1. *Non-fatal and time-boxed.* Running an unknown binary is a spawn the board did not use to
 *     do, and in the WSL case it costs a `wsl.exe` round trip per start. Every probe has a
 *     deadline, every failure is a status rather than an exception, and the server does not
 *     await any of it before it listens — a slow distro must not become a slow board.
 *  2. *Nothing that reaches the wire may carry the command line.* `/health` is unauthenticated
 *     on loopback and a command line here is somebody's absolute path with their permission
 *     flags in it. `backend` is a name from a list this module holds, never the operator's own
 *     binary; `version` is a version number extracted from the output, never the output.
 *  3. *Unconfigured is not a failure.* Most boards have no agent, and a preflight that warned
 *     about it would be a preflight nobody reads.
 *
 * `scripts/check-agent-preflight.mjs` holds all of it.
 */
import { spawn } from 'child_process';
import path from 'path';
import type { AgentRole } from './agent-adapter.js';
import { AgentCommands, buildAgentCommand, singleQuoted, tokenizeCommand } from './issue-agent.js';
import { Workspace } from './workspaces.js';
import { wslUnsupportedHere } from './workspace-paths.js';
import { settingName } from './settings.js';

/**
 * The two agents, declared in `agent-adapter.ts` because an adapter is asked which role it is
 * invoking, and re-exported here where every caller already had it.
 */
export type { AgentRole };

/** The environments a command may have to run in — the halves of `AgentCommands`. */
export type AgentEnvironmentKind = 'native' | 'wsl';

export const AGENT_ENVIRONMENT_KINDS: readonly AgentEnvironmentKind[] = ['native', 'wsl'];

/**
 * What the board knows about one role in one environment.
 *
 * `probing` is here because the probe is not awaited before the server listens: a `/health`
 * asked in the first second gets an honest "still asking" rather than a blocking route or a
 * wrong answer. `not probed` is the other honest gap — a command is configured for a distro
 * but this board has no project in one, so there is nothing to run it in and nothing is spent
 * finding that out.
 */
export type AgentResolution =
  | 'unconfigured'
  | 'unsupported'
  | 'not probed'
  | 'probing'
  | 'found'
  | 'not found'
  | 'unknown';

export interface AgentEnvironmentHealth {
  /** A backend this board recognises, or null. Never the operator's own binary name. */
  backend: string | null;
  resolved: AgentResolution;
  /** A version number and nothing else — see `versionNumber`. */
  version: string | null;
}

export interface AgentRoleHealth {
  /** Whether any command at all is configured for this role, in any environment. */
  configured: boolean;
  environments: Record<AgentEnvironmentKind, AgentEnvironmentHealth>;
}

export type AgentsHealth = Record<AgentRole, AgentRoleHealth>;

/** One role as the board holds it: the commands, and the variable that would grant them. */
export interface AgentRoleCommands {
  role: AgentRole;
  /** The `ISSUE_AGENT` / `IMPLEMENT_AGENT` setting, spelled by `settingName`; WSL adds `_WSL`. */
  variable: string;
  commands: AgentCommands;
}

/** What one probe came back with, whether or not anything ran. */
export interface ProbeRun {
  /** Exit code, or null when the process was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `ENOENT` and friends — the spawn itself failed, so nothing ran at all. */
  spawnError: string | null;
  timedOut: boolean;
}

export interface ProbeSpec {
  command: string;
  args: string[];
  cwd?: string | undefined;
  /**
   * The child's environment, or nothing to inherit this process's.
   *
   * Nothing is what the agent probes pass, and that is unchanged from before this field
   * existed. `core/github-status.ts` is the caller that needs it: the GitHub CLI is not on
   * `PATH` on every machine this runs on, and `agentPath()` is the answer `runGh` already
   * uses — a preflight that probed a bare `PATH` would report the CLI missing on a board
   * where every `gh` call succeeds.
   */
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * The spawn, as a seam.
 *
 * Nothing in `src/` passes one; the server calls `preflightAgents` and gets the real spawn
 * below. It exists so a check can assert what a distro would answer without requiring a
 * distro — the same reasoning `agentPath`'s `AgentPathProbe` is built on, and the alternative
 * is a preflight whose WSL half is only testable on the one platform that has WSL.
 */
export type ProbeRunner = (spec: ProbeSpec, timeoutMs: number) => Promise<ProbeRun>;

/**
 * How long a probe may take before it is given up on.
 *
 * The distro number is the larger one because a cold `wsl.exe` has a distro to start before it
 * has a binary to look for. Both are ceilings on something nothing waits for, so the cost of
 * being generous is a `/health` that says `probing` for a few seconds longer.
 */
const PROBE_TIMEOUT_MS: Record<AgentEnvironmentKind, number> = { native: 8000, wsl: 20000 };

/**
 * The agent CLIs this board can name.
 *
 * An allowlist rather than "whatever the binary is called", and that is rule 2 above: the
 * basename of an operator's command is a piece of their command line, and a board that echoed
 * it back on an unauthenticated route would be leaking the thing this field exists to avoid
 * leaking. A command that is not on this list reports `backend: null` — "not one I know",
 * which is a true and harmless answer. The list grows when a backend adapter is written for
 * something, not when somebody installs something.
 */
const KNOWN_BACKENDS = [
  'claude', 'codex', 'gemini', 'cursor-agent', 'aider', 'opencode', 'goose', 'amp', 'copilot',
];

/** The backend a command names, or null when it is not one this board knows. */
export function knownBackend(command: string): string | null {
  const binary = tokenizeCommand(command)[0];
  if (!binary) return null;
  const base = path.basename(binary.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  return KNOWN_BACKENDS.includes(base) ? base : null;
}

/**
 * A version number out of whatever the tool printed, or null.
 *
 * Extracted rather than passed through, because the output is the tool's and a tool is free to
 * print its own install path in it. A dotted number cannot be a path, a flag or a command line,
 * so what comes back is safe by construction rather than by inspection.
 */
export function versionNumber(text: string): string | null {
  // The lookbehind rather than `\b`, because `\b` does not exist between the `v` and the `2`
  // of `v24.4.1` and the match would start at the `4` — a version number this board invented.
  const match = /(?<![\w.])v?(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?)/.exec(text);
  return match ? (match[1] ?? null) : null;
}

/**
 * The command this role would use in this environment, or null.
 *
 * The same answer `agentCommandFor` gives a workspace, and deliberately the same: a preflight
 * that probed a command the runs would not use would be reporting on something else. That
 * includes the one-way fallback — a distro with no `_WSL` command of its own runs the native
 * one, which is why a host path configured on a board with a WSL project is a real failure
 * this can now see before anybody presses anything.
 */
export function commandForEnvironment(
  kind: AgentEnvironmentKind,
  commands: AgentCommands
): string | null {
  const spec = kind === 'wsl' ? commands.wsl ?? commands.native : commands.native;
  return spec?.command ?? null;
}

/**
 * The argv one probe runs, or null when there is no binary in the command at all.
 *
 * The distro half goes through `buildAgentCommand`, rather than spelling `wsl.exe -d … --exec
 * bash -lc` a second time: the quoting there was paid for once already (`--exec`, not `--`,
 * and why), and a probe that reached a distro by a different route would be proving that route
 * works rather than the one the runs use.
 */
export function probeSpec(
  kind: AgentEnvironmentKind,
  command: string,
  wslWorkspace: Workspace | null
): ProbeSpec | null {
  const binary = tokenizeCommand(command)[0];
  if (!binary) return null;
  if (kind === 'wsl') {
    if (!wslWorkspace) return null;
    return buildAgentCommand(wslWorkspace, `${singleQuoted(binary)} --version`);
  }
  return { command: binary, args: ['--version'], cwd: undefined };
}

/**
 * The real spawn: output captured, deadline enforced, nothing ever thrown.
 *
 * Exported because `core/github-status.ts` asks the same question of a different binary, and
 * every line below is about *not throwing* rather than about agents: a second copy would be a
 * second place for a spawn error, a deadline or a stream to be handled differently.
 */
export const spawnProbe: ProbeRunner = (spec, timeoutMs) => new Promise<ProbeRun>((resolve) => {
  let settled = false;
  let stdout = '';
  let stderr = '';
  const finish = (run: ProbeRun): void => {
    if (settled) return;
    settled = true;
    resolve(run);
  };

  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    finish({ code: null, stdout: '', stderr: '', spawnError: errorCode(error), timedOut: false });
    return;
  }

  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* already gone */ }
    finish({ code: null, stdout, stderr, spawnError: null, timedOut: true });
  }, timeoutMs);
  timer.unref?.();

  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', (error) => {
    clearTimeout(timer);
    finish({ code: null, stdout, stderr, spawnError: errorCode(error), timedOut: false });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    finish({ code, stdout, stderr, spawnError: null, timedOut: false });
  });
});

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'SPAWN_FAILED';
}

/** The shell's two ways of saying it could not find the thing it was asked for. */
const NOT_FOUND_OUTPUT = /command not found|no such file or directory|is not recognized/i;
/** `wsl.exe` failing on its own account rather than on the binary's. */
const NO_DISTRO_OUTPUT = /no distribution|not registered|WslRegisterDistribution/i;

/**
 * What one run means.
 *
 * The two environments read differently, and that asymmetry is the whole reason this is a
 * function rather than `code === 0`:
 *
 *  - **native** — the spawn *is* the test. `ENOENT` means the binary is not there; anything
 *    that started is there, whatever it thought of `--version`. A CLI that exits 1 on an
 *    unknown flag is installed, and reporting it missing would send the reader to reinstall
 *    something they already have.
 *  - **wsl** — the spawn only proves `wsl.exe` is there. The verdict on the agent is inside,
 *    where `bash -lc` reports a missing command as 127, so that is what is read. An `ENOENT`
 *    on `wsl.exe` itself is not a missing agent at all; it is a machine with no WSL.
 */
function interpret(kind: AgentEnvironmentKind, run: ProbeRun): AgentResolution {
  if (run.spawnError) {
    if (kind === 'wsl') return run.spawnError === 'ENOENT' ? 'unsupported' : 'unknown';
    return run.spawnError === 'ENOENT' ? 'not found' : 'unknown';
  }
  if (run.timedOut) return 'unknown';
  const output = `${run.stdout}\n${run.stderr}`;
  if (kind === 'wsl') {
    if (NO_DISTRO_OUTPUT.test(output)) return 'unknown';
    if (run.code === 127 || NOT_FOUND_OUTPUT.test(output)) return 'not found';
    return run.code === null ? 'unknown' : 'found';
  }
  return 'found';
}

/**
 * What can be said about one role and one environment without spawning anything.
 *
 * Null when a probe is the only way to know, which is what makes the two callers below one
 * piece of reasoning rather than two: `initialAgents` turns null into `probing`, and
 * `preflightAgents` turns it into a run.
 */
function withoutProbing(
  kind: AgentEnvironmentKind,
  command: string | null,
  platform: NodeJS.Platform
): AgentResolution | null {
  // First, because it is the plainest thing that can be true and most boards are it. A board
  // with no agent is not a board with a broken one, whatever platform it is on.
  if (!command) return 'unconfigured';
  if (kind === 'wsl' && wslUnsupportedHere(platform)) return 'unsupported';
  return null;
}

function environmentHealth(
  command: string | null,
  resolved: AgentResolution,
  version: string | null = null
): AgentEnvironmentHealth {
  return { backend: command ? knownBackend(command) : null, resolved, version };
}

/**
 * The answer before anything has run: every environment settled or `probing`.
 *
 * `/health` reads this from the moment the server listens, so the route never waits and never
 * invents. See rule 1 — the probe is not on the path to the board coming up.
 */
export function initialAgents(
  roles: readonly AgentRoleCommands[],
  platform: NodeJS.Platform = process.platform
): AgentsHealth {
  const agents = {} as AgentsHealth;
  for (const role of roles) {
    const environments = {} as Record<AgentEnvironmentKind, AgentEnvironmentHealth>;
    for (const kind of AGENT_ENVIRONMENT_KINDS) {
      const command = commandForEnvironment(kind, role.commands);
      environments[kind] = environmentHealth(command, withoutProbing(kind, command, platform) ?? 'probing');
    }
    agents[role.role] = {
      configured: Boolean(role.commands.native || role.commands.wsl),
      environments,
    };
  }
  return agents;
}

export interface PreflightOptions {
  roles: readonly AgentRoleCommands[];
  /**
   * A registered project inside a distro, or null when this board has none.
   *
   * Null is why `not probed` exists: without a project in a distro there is no distro to run
   * the command in, and inventing one — the default distro, say — would be probing an
   * environment the board never uses. It is also the reason the common board pays nothing:
   * no WSL project, no `wsl.exe` round trip.
   */
  wslWorkspace: Workspace | null;
  run?: ProbeRunner;
  platform?: NodeJS.Platform;
}

/** The full answer, once every probe that can run has run. */
export async function preflightAgents(options: PreflightOptions): Promise<AgentsHealth> {
  const run = options.run ?? spawnProbe;
  const platform = options.platform ?? process.platform;
  const agents = {} as AgentsHealth;

  for (const role of options.roles) {
    const environments = {} as Record<AgentEnvironmentKind, AgentEnvironmentHealth>;
    for (const kind of AGENT_ENVIRONMENT_KINDS) {
      const command = commandForEnvironment(kind, role.commands);
      const settled = withoutProbing(kind, command, platform);
      if (settled || !command) {
        environments[kind] = environmentHealth(command, settled ?? 'unconfigured');
        continue;
      }
      const spec = probeSpec(kind, command, options.wslWorkspace);
      if (!spec) {
        environments[kind] = environmentHealth(command, 'not probed');
        continue;
      }
      const result = await run(spec, PROBE_TIMEOUT_MS[kind]);
      const resolved = interpret(kind, result);
      environments[kind] = environmentHealth(
        command,
        resolved,
        resolved === 'found' ? versionNumber(`${result.stdout}\n${result.stderr}`) : null
      );
    }
    agents[role.role] = {
      configured: Boolean(role.commands.native || role.commands.wsl),
      environments,
    };
  }
  return agents;
}

/** How each state reads in a sentence, in the environment it was found in. */
const ENVIRONMENT_NAMED: Record<AgentEnvironmentKind, string> = {
  native: 'native',
  wsl: 'WSL',
};

function variableFor(role: AgentRoleCommands, kind: AgentEnvironmentKind): string {
  return kind === 'wsl' ? `${role.variable}_WSL` : role.variable;
}

/**
 * What to say about the result, at startup, on the operator's own console and log.
 *
 * This is the one place the binary is named, and it is named on purpose: the reader is the
 * person who wrote the command, on the machine it is configured on, and a warning that says
 * "something is not on PATH" without saying what sends them to look for it. Rule 2 is about
 * `/health` and `doctor`, which answer a socket; nothing here goes over one.
 *
 * `warn` for exactly one case, because `warn` is the only level the console shows and a level
 * that fires on every board is a level nobody reads. A missing binary is a board whose buttons
 * do nothing. Everything else — found, unconfigured, no distro to look in — is `info`.
 */
export function preflightLines(
  agents: AgentsHealth,
  roles: readonly AgentRoleCommands[]
): Array<{ level: 'info' | 'warn'; message: string }> {
  const lines: Array<{ level: 'info' | 'warn'; message: string }> = [];

  for (const role of roles) {
    const health = agents[role.role];
    if (!health) continue;

    if (!health.configured) {
      lines.push({
        level: 'info',
        message: `Agent preflight: no ${role.role} agent is configured. Set ${role.variable} `
          + `(or ${role.variable}_WSL for a project inside a distro) to turn it on. `
          + 'Nothing is wrong; this board simply does not run one.',
      });
      continue;
    }

    for (const kind of AGENT_ENVIRONMENT_KINDS) {
      const environment = health.environments[kind];
      if (!environment) continue;
      const command = commandForEnvironment(kind, role.commands);
      const binary = command ? tokenizeCommand(command)[0] ?? command : null;
      const where = ENVIRONMENT_NAMED[kind];
      const variable = variableFor(role, kind);

      if (environment.resolved === 'not found') {
        lines.push({
          level: 'warn',
          message: `Agent preflight: the ${role.role} agent is configured for the ${where} `
            + `environment, but "${binary}" was not found there — the button will be on the `
            + `board and pressing it will do nothing. Set ${variable} to a command that `
            + `environment can run.`,
        });
      } else if (environment.resolved === 'found') {
        lines.push({
          level: 'info',
          message: `Agent preflight: the ${role.role} agent runs in the ${where} environment`
            + `${environment.version ? ` (version ${environment.version})` : ''}.`,
        });
      } else if (environment.resolved === 'not probed') {
        lines.push({
          level: 'info',
          message: `Agent preflight: the ${role.role} agent has a command for the ${where} `
            + 'environment, and this board has no project in a distro to try it in.',
        });
      } else if (environment.resolved === 'unknown') {
        lines.push({
          level: 'info',
          message: `Agent preflight: the ${role.role} agent's ${where} command neither answered `
            + 'nor reported itself missing. It may still work; the preflight could not say.',
        });
      }
    }
  }
  return lines;
}

/**
 * The same report in prose, for `doctor` — built from what `/health` answered and nothing else.
 *
 * That constraint is the point rather than an accident of where it is called from: `doctor`
 * never holds the command line, so there is nothing for it to leak. What it can say is which
 * variable to set, which is the actionable half and is a name this repository publishes.
 */
export function doctorLines(agents: AgentsHealth, roles: readonly AgentRoleCommands[]): string[] {
  const lines: string[] = [];
  for (const role of roles) {
    const health = agents[role.role];
    if (!health) continue;
    if (!health.configured) {
      lines.push(`${role.role}: not configured. Set ${role.variable} to turn it on.`);
      continue;
    }
    for (const kind of AGENT_ENVIRONMENT_KINDS) {
      const environment = health.environments[kind];
      if (!environment || environment.resolved === 'unconfigured') continue;
      const where = ENVIRONMENT_NAMED[kind];
      const named = environment.backend ? ` [${environment.backend}]` : '';
      const version = environment.version ? ` version ${environment.version}` : '';
      const advice = environment.resolved === 'not found'
        ? ` Set ${variableFor(role, kind)} to a command that environment can run.`
        : '';
      // No separator characters in the prose, deliberately: a check scans this output for a
      // path and a slash between two words is indistinguishable from one.
      lines.push(`${role.role} in the ${where} environment${named}: ${environment.resolved}${version}.${advice}`);
    }
  }
  return lines;
}

/**
 * The roles as the board holds them, from the four variables that grant them.
 *
 * Here rather than in `server.ts` so that `doctor` — which has no command lines at all and
 * must not acquire any — can still name the same variables in the same order the board
 * reports them in.
 */
export function agentRoles(commands: { issue: AgentCommands; implement: AgentCommands }): AgentRoleCommands[] {
  return [
    { role: 'issue', variable: settingName('ISSUE_AGENT'), commands: commands.issue },
    { role: 'implement', variable: settingName('IMPLEMENT_AGENT'), commands: commands.implement },
  ];
}

/** The roles with no commands in them, for a reader that only ever saw `/health`. */
export function namedRoles(): AgentRoleCommands[] {
  return agentRoles({
    issue: { native: null, wsl: null },
    implement: { native: null, wsl: null },
  });
}
