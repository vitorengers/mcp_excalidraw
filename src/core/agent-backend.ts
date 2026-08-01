/**
 * Which agent this board runs, named — rather than composed out of four command lines.
 *
 * Configuring an agent used to mean writing `EXCALIDRAW_ISSUE_AGENT`,
 * `EXCALIDRAW_ISSUE_AGENT_WSL`, `EXCALIDRAW_IMPLEMENT_AGENT` and
 * `EXCALIDRAW_IMPLEMENT_AGENT_WSL` by hand, each carrying a binary path, a model, an effort,
 * permission flags and stream flags — five decisions per variable, four times, none of them
 * checked, and nothing anywhere that discovered the binary. A first run therefore came up
 * `status: healthy`, drew every block, offered every button and did nothing when one was
 * pressed. The adapters have known how to write those flags since #326 and #327. What was
 * missing was a way to say *which adapter*, and a binary for it to run.
 *
 * So there are three keys, and none of them is a command line:
 *
 *  - **`AGENT_BACKEND`** — the backends this board may run, the first being the one it does
 *    run. `claude-code`, `codex-cli`, `raw`.
 *  - **`AGENT_BACKEND_WSL`** — the same, inside a distro, and only where the distro differs.
 *    Unset it is the machine's answer, which is right for the overwhelmingly common case of one
 *    agent installed in both places.
 *  - **`AGENT_ARGS`** — anything an operator wants pinned onto every run, appended after
 *    everything a backend or a project writes.
 *
 * ## Why the list, and why the first entry is special
 *
 * `AGENT_BACKEND` takes more than one name because a project may pick among the backends the
 * operator enabled — `workspaces.ts:184-192` is the rule, and choosing which binary runs is
 * *granting*, so it can only ever be a choice among what was already granted. One name is the
 * ordinary board and means "and no project may pick anything else"; the first name is what a
 * project that picks nothing runs.
 *
 * ## Why the distro half is bare and the machine's half is a path
 *
 * `resolveExecutable` answers "where is `claude` on this machine", and that answer is a host
 * path — `C:/Users/x/.local/bin/claude.exe` — which is `No such file or directory` inside a
 * distro. So discovery runs for the native half only, and the distro half keeps the bare
 * binary name for the `bash -lc` on the other side of the boundary to look up itself. Two
 * lookups, each performed where it can be performed, rather than one answer that is wrong in
 * one of the two places.
 *
 * ## `raw` is still what a board that names nothing gets
 *
 * Every board that exists, and twenty check scripts, name their agent as a command line and
 * expect it spawned byte for byte. That is `raw`, it is a backend rather than a bypass
 * (`agents/raw.ts`), and it is what this module resolves to when no backend is named: the
 * operator's command line, under `raw`, exactly as before. A backend *named* alongside a
 * command line is the override the pair is for — the operator's binary, the backend's flags.
 *
 * Deliberately free of everything heavier than the environment: no `Workspace`, no spawn, no
 * `resolveExecutable`. Discovery arrives as the `resolve` seam, supplied by `issue-agent.ts`,
 * which is the module that owns the PATH every child of this board is given — and which imports
 * `workspaces.ts`, so a dependency the other way would close a cycle.
 */
import {
  AGENT_BACKEND_IDS, DEFAULT_AGENT_BACKEND, agentBackendId,
  type AgentBackendId, type AgentCommandSpec,
} from './agent-adapter.js';
import { env } from './settings.js';

/** The environments a command may have to run in — the halves of a grant. */
export type AgentEnvironment = 'native' | 'wsl';

/**
 * The binary each backend runs when the operator wrote no command line.
 *
 * The CLI's own name, unqualified, because that is what is on PATH after either project's
 * documented install and because a bare name is the one spelling that resolves on this machine
 * *and* inside a distro. `raw` has none, and cannot: what it runs is whatever the operator
 * wrote, which is the whole of that backend.
 */
export const BACKEND_BINARIES: Record<AgentBackendId, string | null> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  raw: null,
};

/**
 * The backends a variable names, in order, with anything unrecognised dropped.
 *
 * Silent, and the silence is paid for at the one place that can say something useful: the
 * server warns once at startup when a value was set and named nothing, which is the case that
 * matters — a typo there leaves a board with no agent at all. A warning here would be repeated
 * on every workspace load instead.
 */
export function parseAgentBackends(value: string | null | undefined): AgentBackendId[] {
  const named: AgentBackendId[] = [];
  for (const word of (value ?? '').split(',')) {
    const id = agentBackendId(word);
    if (id && !named.includes(id)) named.push(id);
  }
  return named;
}

/** Whether the operator granted any command line at all, which is a `raw` grant. */
function hasCommandLine(): boolean {
  return ['ISSUE_AGENT', 'ISSUE_AGENT_WSL', 'IMPLEMENT_AGENT', 'IMPLEMENT_AGENT_WSL']
    .some((name) => (env(name as 'ISSUE_AGENT')?.trim() ?? '') !== '');
}

/**
 * Every backend a project in this environment may name, in the operator's own order.
 *
 * Read from the environment rather than passed in, because the callers are the workspace
 * loader and the settings write path — neither of which has a board around it, and both of
 * which run wherever a registry is read. `raw` is in the set exactly when a command line was
 * granted, which is what makes "this board enabled the passthrough and nothing else" the true
 * answer for every board configured before backends existed.
 *
 * `any` is the union, for a caller with no workspace in front of it yet.
 */
export function enabledAgentBackends(
  environment: AgentEnvironment | 'any' = 'any'
): readonly AgentBackendId[] {
  const machine = parseAgentBackends(env('AGENT_BACKEND'));
  const distro = parseAgentBackends(env('AGENT_BACKEND_WSL'));
  const named = environment === 'native' ? machine
    : environment === 'wsl' ? (distro.length ? distro : machine)
      : [...machine, ...distro];

  const ids: AgentBackendId[] = [];
  for (const id of named) if (!ids.includes(id)) ids.push(id);
  if (hasCommandLine() && !ids.includes('raw')) ids.push('raw');
  return ids;
}

/**
 * The backend a project in this environment runs when it picks none.
 *
 * The board's own, which is the first name the operator wrote — and `raw` for every board that
 * named none, which is exactly what `DEFAULT_AGENT_BACKEND` has always been.
 */
export function boardAgentBackend(environment: AgentEnvironment): AgentBackendId {
  return enabledAgentBackends(environment)[0] ?? DEFAULT_AGENT_BACKEND;
}

/** What the operator granted one role, before any environment has been chosen. */
export interface AgentGrantSpec {
  /** The backends named for this machine, in order. Empty is "none named". */
  backends?: readonly AgentBackendId[];
  /** The backends named for a distro. Empty falls back to the machine's. */
  wslBackends?: readonly AgentBackendId[];
  /** `ISSUE_AGENT` / `IMPLEMENT_AGENT` — the operator's own command line, or null. */
  command?: string | null;
  /** The `_WSL` half of the same. */
  wslCommand?: string | null;
  /** `AGENT_ARGS`, already tokenised. */
  args?: readonly string[];
  /** Where a bare binary is on this machine. Identity when nothing looks it up. */
  resolve?: (binary: string) => string;
}

/**
 * One role's grants, per environment: every backend the operator enabled, first one first.
 *
 * A list rather than the single `AgentCommandSpec` the board runs, because a project may pick
 * among them. `agentCommandsOf` in `issue-agent.ts` takes the firsts back out for everything
 * that only wants to know what the board itself would run — the preflight, and whether the role
 * is configured at all.
 */
export interface AgentGrants {
  native: readonly AgentCommandSpec[];
  wsl: readonly AgentCommandSpec[];
}

function specsFor(
  ids: readonly AgentBackendId[],
  command: string | null,
  binaryOf: (id: AgentBackendId) => string | null,
  args: readonly string[]
): AgentCommandSpec[] {
  const pinned = args.length ? { args } : {};
  // No backend named: the operator's command line, under the passthrough, which is what every
  // board configured before this module existed has always had.
  if (!ids.length) return command ? [{ backend: DEFAULT_AGENT_BACKEND, command, ...pinned }] : [];

  const specs: AgentCommandSpec[] = [];
  ids.forEach((id, index) => {
    // The operator's own line belongs to the backend they named *first*: it is the binary they
    // spelled for the agent this board runs, and a second backend they merely allowed a project
    // to pick is a different binary entirely.
    const line = index === 0 && command ? command : binaryOf(id);
    if (line) specs.push({ backend: id, command: line, ...pinned });
  });
  return specs;
}

/** One role's grants, from what the operator said and where this machine keeps its binaries. */
export function agentGrants(spec: AgentGrantSpec): AgentGrants {
  const resolve = spec.resolve ?? ((binary: string) => binary);
  const args = spec.args ?? [];
  const machine = spec.backends ?? [];
  const distro = (spec.wslBackends ?? []).length ? (spec.wslBackends ?? []) : machine;

  return {
    native: specsFor(machine, spec.command?.trim() || null,
                     (id) => { const binary = BACKEND_BINARIES[id]; return binary ? resolve(binary) : null; },
                     args),
    // Never resolved: see the note at the top of this file. A path found on the host is the one
    // thing that certainly does not exist on the other side of the boundary.
    wsl: specsFor(distro, spec.wslCommand?.trim() || null, (id) => BACKEND_BINARIES[id], args),
  };
}

/**
 * The grants that apply in one environment, with the one-way fallback intact.
 *
 * A distro with nothing of its own runs the machine's, which is what keeps a command written
 * without an absolute path — `claude -p …` — working in both. The reverse is not symmetric and
 * never was: a grant made for a distro says nothing about what may run on the host.
 */
export function grantedSpecs(
  environment: AgentEnvironment,
  grants: AgentGrants
): readonly AgentCommandSpec[] {
  if (environment !== 'wsl') return grants.native;
  return grants.wsl.length ? grants.wsl : grants.native;
}

/**
 * The spec one run is spawned from: the project's pick, or the board's own.
 *
 * `chosen` has already been validated against `enabledAgentBackends` on the way in — at the
 * settings write path, and again at the load — so what is left here is the case where an
 * operator enabled a backend for one environment and not for the other. Falling back to the
 * board's own is the honest answer for it: the alternative is refusing a run for a project
 * whose configuration was accepted.
 */
export function agentSpecFor(
  environment: AgentEnvironment,
  grants: AgentGrants,
  chosen: AgentBackendId | null | undefined
): AgentCommandSpec | null {
  const specs = grantedSpecs(environment, grants);
  if (!specs.length) return null;
  const picked = chosen ? specs.find((spec) => spec.backend === chosen) : null;
  return picked ?? specs[0] ?? null;
}

/** The names a refusal lists, so a message can say what the operator did enable. */
export function backendNames(ids: readonly AgentBackendId[]): string {
  return ids.length ? ids.join(', ') : 'none';
}

/** Every backend this board knows, for a message about a name that is not one of them. */
export const KNOWN_BACKEND_NAMES = AGENT_BACKEND_IDS.join(', ');
