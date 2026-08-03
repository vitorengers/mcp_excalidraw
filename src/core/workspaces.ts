/**
 * Workspace registry.
 *
 * A registry file lists projects; each project then describes its own board settings
 * in a `board.config.json` at its root, the way it already carries a package manifest.
 * Settings therefore travel with the project instead of accumulating in one machine's
 * global config.
 */
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { originRemote } from './implement-worktree.js';
import { env, stateDir, stateDirCandidates } from './settings.js';
import {
  resolveWorkspacePath,
  resolveInWorkspace,
  ResolvedPath,
  WorkspaceEnvironment,
  wslUnsupportedHere,
} from './workspace-paths.js';
// The shapes module rather than the reader: this is the write path, and `project-board.ts`
// spawns `gh`. What is needed here is the pattern the reader will hold the value to.
import { githubProjectRefusal, parseProjectUrl } from './project-board-types.js';
// The reader after all, for three strings — and only for three strings. The column names a
// project's config falls back to are declared beside the resolvers that apply them, so that a
// config refused here for naming the same column twice is refused against the very value the
// board would have used. Duplicating them here is how the refusal and the resolver drift
// apart, and the whole point of the refusal is that they cannot.
import {
  DEFAULT_FOUNDER_COLUMN, DEFAULT_IN_PROGRESS_COLUMN, DEFAULT_TODO_COLUMN,
} from './project-board.js';
// One question only — what reasoning-effort levels does this backend take — and it is asked of
// the backend rather than answered here, because a level is the backend's own vocabulary. It was
// answered here, once, by a constant documented as "as `claude --help` states them", which is one
// backend's answer given to all of them: a board pointed at Codex had `minimal` refused, though
// Codex takes it. Kept as a list rather than free text because a level nothing checks is only
// discovered when a run fails minutes later, in a process nobody is watching.
import { DEFAULT_AGENT_BACKEND, agentBackendId, type AgentBackendId } from './agent-adapter.js';
import {
  KNOWN_BACKEND_NAMES, backendNames, boardAgentBackend, enabledAgentBackends,
} from './agent-backend.js';
import { agentEfforts } from './agents/index.js';

/** What the registry is called when nobody has named a file for it. */
const REGISTRY_FILENAME = 'workspaces.json';

/**
 * Where the list of projects is, and it is always somewhere.
 *
 * `EXCALIDRAW_WORKSPACES` used to be the whole answer, and `undefined` was a state the rest
 * of the tool then had to have opinions about: the registry was read-only, `POST
 * /api/workspaces` refused with a 503 naming the variable, and the tab strip — which is where
 * the `+` that would have set it lives — removed itself. A first-run reader got a blank canvas
 * with no tabs, no `+` and no message, and the only way out was a variable named in a document
 * they had no reason to be reading. Nothing about "which projects are open" is unanswerable
 * before it is configured; the answer is simply "none yet".
 *
 * So the variable stays the explicit answer and there is a default underneath it: a file in
 * the same per-user directory the pidfile, the restart log and `config.json` are already in
 * (`core/settings.ts`, which owns that choice for all of them). `readRegistry` treats a
 * missing file as the empty registry, so nothing is written until the first project is added.
 *
 * Both spellings of the state directory are looked in, newest first, for the reason
 * `settingsFilePaths()` gives: the directory rename ships one release ahead of itself, and a
 * reader that only knew one name would orphan somebody's projects the day it flips. A *new*
 * registry is written where `stateDir()` says, which is the same place everything else lands.
 */
export function registryPath(): string {
  const named = env('WORKSPACES')?.trim();
  if (named) return named;

  for (const dir of stateDirCandidates()) {
    const candidate = path.join(dir, REGISTRY_FILENAME);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(stateDir(), REGISTRY_FILENAME);
}

/**
 * Whether this canvas is somebody's board rather than a scratch one, answered without waiting.
 *
 * `/health` is the one caller, and what it reports there is load-bearing: `docs/running.md`
 * tells the operator to read it first, because an MCP server attached to an editor can
 * auto-start a canvas onto the board's port and answer `status: healthy` while being a canvas
 * with nothing on it.
 *
 * Two clauses, and both are needed once the registry path has a default:
 *
 *   - **the variable was set.** This is what the field used to mean on its own, and it is
 *     still the operator saying "this is the board" out loud. It stays first because it is
 *     also the only evidence a caller has that a value *reached* the server —
 *     `check-env-isolation.mjs` reads this field to prove a `.env` was read at all, with a
 *     registry path that deliberately does not exist.
 *   - **or the registry it resolved has projects in it.** The clause the default made
 *     necessary: with no variable set, every canvas resolves a registry, so the first clause
 *     alone would report `configured` for the very stand-in this field exists to unmask.
 *
 * A board that has both, one, or neither is therefore reported as what it is, and the case the
 * field was invented for — an editor's MCP child holding no `EXCALIDRAW_*`, on a machine whose
 * real board names its registry — still answers `none`.
 *
 * Deliberately cheap and deliberately synchronous: it counts entries rather than resolving
 * them, so a project directory that has gone missing does not change the answer, and
 * `canvasIdentity()` stays the plain snapshot the restart supervisor compares against.
 */
export function hasWorkspaceRegistry(): boolean {
  if (env('WORKSPACES')?.trim()) return true;

  try {
    const parsed = JSON.parse(readFileSync(registryPath(), 'utf-8')) as { workspaces?: unknown };
    return Array.isArray(parsed?.workspaces) && parsed.workspaces.length > 0;
  } catch {
    // No file, or one nobody can parse. Either way this canvas is showing no projects, which
    // is what the field is being asked.
    return false;
  }
}

/** The two agents a project may retune, which are the two the board spawns. */
export const AGENT_KINDS = ['issue', 'implement'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * Which backend each of a project's two agents runs under.
 *
 * Both halves, because they are two grants rather than one: an operator may have Claude Code
 * researching and something else writing code, and a level one of them takes is not thereby a
 * level the other does. Everything here that judges an effort is judged per kind for that reason.
 */
export type AgentBackends = Record<AgentKind, AgentBackendId>;

/**
 * What a caller that has not been told gets, and it is what every board resolves to today.
 *
 * `raw` — the passthrough — is the shipped default of the whole runtime, and it spells effort
 * Claude Code's way, so this is exactly the one global list that used to live here. A caller
 * that names no backend therefore validates against precisely what it validated against before
 * backends existed. Naming a *different* backend comes from configuration that does not exist
 * yet; what exists now is the seam it will arrive through.
 */
export const DEFAULT_AGENT_BACKENDS: AgentBackends = {
  issue: DEFAULT_AGENT_BACKEND,
  implement: DEFAULT_AGENT_BACKEND,
};

/**
 * The backends a project may name, which is only ever a subset of what the operator enabled.
 *
 * Choosing which binary runs is *granting*, not retuning — the rule this whole file is built on
 * — so the set comes from the operator's environment and a project picks within it. A board that
 * enabled one backend has projects that can name that one and nothing else, which is the
 * ordinary case and the safe one; a board that enabled none refuses every `backend` a project
 * could write, which is the correct answer for a board that granted no agent.
 */
export type AgentBackendChoices = readonly AgentBackendId[];

/**
 * Why a `backend` was refused, in the words the settings dialog will show.
 *
 * Two different mistakes, and a message that could not tell them apart would send an operator
 * to fix the wrong thing: a name no backend has is a typo, and a name that exists but was never
 * enabled is a board that has not granted it. Both name the value, the way an unknown agent
 * field already does.
 */
function refuseBackend(kind: string, value: string, choices: AgentBackendChoices): string {
  const known = agentBackendId(value)
    ? `"${value}" is a backend this board knows, but nothing in this board's environment enabled it.`
    : `"${value}" is not a backend at all — the names are ${KNOWN_BACKEND_NAMES}.`;
  return `"agents.${kind}.backend" must be one of ${backendNames(choices)} — the backends this `
    + `board's operator enabled. ${known} A project picks among the agents the operator granted; `
    + 'it cannot grant one.';
}

/**
 * Why an effort was refused, in the words the settings dialog will show.
 *
 * The backend is named because without it the message cannot tell the two mistakes apart. A
 * level that is a typo and a level that belongs to the *other* backend read identically as "not
 * one of …", and the second one is the case where the operator was right about the word and
 * wrong about which agent was going to be handed it.
 */
function refuseEffort(kind: string, backend: AgentBackendId, value: string): string {
  const levels = agentEfforts(backend);
  if (!levels.length) {
    return `"agents.${kind}.effort" cannot be set: this project's ${kind} agent runs under the `
      + `"${backend}" backend, which has no reasoning effort to set. Clear it, or point the agent `
      + 'at a backend that takes one.';
  }
  return `"agents.${kind}.effort" must be one of ${levels.join(', ')} — the levels the `
    + `"${backend}" backend takes, which is what this project's ${kind} agent runs under. `
    + `"${value}" is not one of them; another backend may spell it, and this one would hand it `
    + 'to a CLI that refuses the run.';
}

/**
 * Where a project keeps the workflows its agents may be told to follow.
 *
 * At the project root and committed, which rules out the three more obvious homes. `CLAUDE.md`
 * is loaded by interactive runs too, so a pipeline meant for board runs would leak into every
 * session somebody opens by hand. Under `docsDir` it is configurable, and its markdown turns
 * into documentation cards on the board. And a dot-directory — `.agent`, `.agents`, `.claude` —
 * is the one shape a project has most likely gitignored already, which would resolve on the
 * maintainer's checkout and be absent in every board run: an implementation runs in a worktree
 * cut from the default branch, so a file that is not committed is not there.
 */
export const AGENT_WORKFLOW_DIR = 'agent-workflows';

/**
 * What a workflow may be called.
 *
 * A slug rather than a path, so that a name which does not resolve can be reported as one
 * file rather than as "somewhere under the project". It is also the first of the two guards
 * against a config reaching outside its own project — `resolveInWorkspace` is the second.
 */
export const AGENT_WORKFLOW_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The project-relative file a workflow slug names. */
export function agentWorkflowFile(slug: string): string {
  return `${AGENT_WORKFLOW_DIR}/${slug}.md`;
}

/**
 * What a project may say about how its agents run.
 *
 * Deliberately *not* a command. Agents are off unless the operator set
 * EXCALIDRAW_ISSUE_AGENT or EXCALIDRAW_IMPLEMENT_AGENT, and if a config file could supply
 * a command from nothing then editing a JSON file inside any registered project would
 * start an unattended agent with whatever permissions it liked, on a board where nobody
 * allowed one. A project may retune what the operator granted; it may never grant it.
 */
export interface WorkspaceAgentConfig {
  /**
   * Which of the backends the operator enabled this agent runs under.
   *
   * The one field here that looks like a capability and is not one. It cannot name a binary,
   * cannot name a command and cannot reach a backend the board's own environment did not
   * enable — `EXCALIDRAW_AGENT_BACKEND` is the grant, and this is a choice among what it
   * granted. A project that names something outside that set is refused with the name in the
   * message, on the way in and again on the way out.
   *
   * Unset is the board's own, which is the first backend the operator named.
   */
  backend?: string;
  /** Passed through as `--model`. Unset means the board's own default. */
  model?: string;
  /** Passed through as `--effort`. Unset means the board's own default. */
  effort?: string;
  /** Ceiling on a run, in seconds. Unset means the environment's, which may be none. */
  timeoutSeconds?: number;
  /**
   * Slug naming `agent-workflows/<slug>.md`, whose text is injected into the run's prompt.
   *
   * The one field here that is about *how the agent works* rather than how well it runs, and
   * still not a capability: the text reaches the prompt and nothing else. It does not touch
   * argv, the environment, `--allowedTools` or `--dangerously-skip-permissions`, so it can
   * only tell an agent how to use what the operator already granted.
   */
  workflow?: string;
}

export interface WorkspaceAgentsConfig {
  issue?: WorkspaceAgentConfig;
  implement?: WorkspaceAgentConfig;
}

/** One agent's settings, resolved. Null everywhere means "whatever the board does". */
export interface AgentSettings {
  /**
   * The backend this project picked, or null for the board's own.
   *
   * Resolved on the way in — a name the operator did not enable is dropped here rather than
   * carried to a run — so anything non-null is a backend this board is allowed to spawn.
   */
  backend: AgentBackendId | null;
  model: string | null;
  effort: string | null;
  timeoutMs: number | null;
  /**
   * The workflow slug exactly as configured, or null.
   *
   * Unresolved on purpose: whether the name is usable is settled per run, by
   * `loadAgentWorkflow`, so that an unusable one refuses the run instead of vanishing.
   */
  workflow: string | null;
}

export interface WorkspaceAgents {
  issue: AgentSettings;
  implement: AgentSettings;
}

export interface WorkspaceConfig {
  name?: string;
  /**
   * The language the issues this board opens for the project are written in.
   *
   * Unset is English, which is what the prompt said outright before this field existed. It
   * is here because the prompt was right to *fix* the language and wrong to fix it to one:
   * an agent taking the language from the repository it just read is issue #20, and a board
   * that opens issues in several repositories cannot answer that with one constant. A
   * project whose own conventions require Portuguese was getting every card this tool opened
   * for it written against its own rule.
   *
   * Free text, and a language name rather than a code: it is read by a model, not by a
   * lookup table, so `Brazilian Portuguese` says more than `pt-BR` and costs nothing.
   */
  language?: string;
  docsDir?: string;
  board?: string;
  library?: string;
  repo?: string;
  githubProject?: string;
  /**
   * Single-select field the project board's columns come from.
   *
   * Overridable because it has to be guessed: a user-owned project has no board view, so
   * `verticalGroupByFields` is empty and the grouping is not discoverable. `Status` is the
   * default only because it is what GitHub creates.
   */
  projectField?: string;
  /** Cards a section shows before it starts hiding them. */
  projectCardLimit?: number;
  /**
   * Column an issue is moved to when its implementation starts.
   *
   * Unset, the option named `In Progress` is used — what GitHub calls that column on a
   * project it created. A board that renamed it says so here; a board that has no such
   * column gets no move rather than a guess.
   */
  projectInProgressColumn?: string;
  /**
   * Column an issue is moved to when the run that researched it finishes.
   *
   * Unset, the option named `Todo` is used. A hand-written block is drafted in the canvas's
   * own notes column, which is not on the project at all; the issue the agent creates lands
   * wherever the project's *Item added to project* workflow puts it, which this code cannot
   * read. This move is what makes that column known instead of assumed. A board that has no
   * such column gets no move rather than a guess.
   */
  projectTodoColumn?: string;
  /**
   * Column a founder action is published into, as a draft item — the work only a person can do.
   *
   * Unset, the option named `Founder Actions` is used — this tool's own suggestion rather than
   * one of GitHub's, because no project GitHub creates has such a column. A project that keeps
   * one under another name says so here, and a project with neither gets no draft item rather
   * than one dropped in a guessed column.
   *
   * It may not be either of the two above, as configured or as defaulted. The implement queue
   * drains a column by name, so a founder action sitting in that column would be picked up as
   * work an agent can start; the two settings above and this one are refused together rather
   * than allowed to coincide.
   */
  projectFounderColumn?: string;
  /**
   * Stop publishing founder actions to the project at all.
   *
   * A **suppression** rather than a switch, and the asymmetry with the implement queue is the
   * decision: that one starts coding agents against a repository and is rightly off until
   * somebody says so, while this one writes a draft item to a column. A draft spawns nothing —
   * `startableCards` cannot pick one up — and the column exists precisely so that a blocker is
   * seen without anybody going to look for it, so a feature whose whole point is visibility must
   * not ship invisible. Unset is therefore publishing, and this is for a board that wants its
   * project left alone.
   */
  projectFounderPublishOff?: boolean;
  /** Per-project model, effort, ceiling and workflow for each agent. See WorkspaceAgentConfig. */
  agents?: WorkspaceAgentsConfig;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  innerPath: string;
  environment: WorkspaceEnvironment;
  /** Null means English — see `WorkspaceConfig.language`. */
  language: string | null;
  docsDir: string | null;
  boardFile: string | null;
  libraryFile: string | null;
  repo: string | null;
  githubProject: string | null;
  /** Null means "whatever the project board reader defaults to". */
  projectField: string | null;
  projectCardLimit: number | null;
  /** Null means "the column named In Progress, if the project has one". */
  projectInProgressColumn: string | null;
  /** Null means "the column named Todo, if the project has one". */
  projectTodoColumn: string | null;
  /** Null means "the column named Founder Actions, if the project has one". */
  projectFounderColumn: string | null;
  /** True stops founder actions being published to the project. Unset publishes. */
  projectFounderPublishOff: boolean;
  /** Per-agent overrides; null fields fall through to the board's own environment. */
  agents: WorkspaceAgents;
  /** Populated when this workspace could not be fully loaded. */
  error: string | null;
}

interface RegistryEntry {
  id?: string;
  path?: string;
  distro?: string;
}

export const WORKSPACE_CONFIG_FILENAME = 'board.config.json';

/**
 * The overlay: the same settings, for the one machine rather than for the repository.
 *
 * A project's config travels with the project, which is right for `name`, `board` and
 * `docsDir` — they describe the tool — and wrong for `repo` and `githubProject`, which
 * describe an *account*. This repository shipped both of the latter in its tracked config, so
 * a stranger who registered a clone of the release got a board mirroring the maintainer's
 * GitHub project and refusing to drag any card on it.
 *
 * So the answers that belong to one person go in a second file beside the first, gitignored,
 * and it wins where the two disagree. The second reason is the settings dialog: it writes this
 * file, and a dialog writing into a git-tracked config means every settings edit dirties the
 * working tree of whatever project is open.
 */
export const WORKSPACE_LOCAL_CONFIG_FILENAME = 'board.config.local.json';

/**
 * The shared config with the local one laid over it.
 *
 * Shallow, apart from `agents`: those merge one level down, so a machine that pins a model for
 * the implement agent does not erase the issue agent the project configured for everybody.
 */
function mergeWorkspaceConfig(
  shared: Record<string, unknown>,
  local: Record<string, unknown> | null
): Record<string, unknown> {
  if (!local) return shared;
  const merged: Record<string, unknown> = { ...shared, ...local };
  if (isPlainObject(shared.agents) && isPlainObject(local.agents)) {
    merged.agents = { ...shared.agents, ...local.agents };
  }
  return merged;
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Write JSON where a reader might be looking.
 *
 * Through a temporary file and a rename, because the registry belongs to whoever runs the
 * board rather than to this repository: a crash halfway through a plain write would leave
 * them holding half a file, and the board reads that file on every request.
 *
 * The directory is made first, for the one file whose directory may genuinely not exist yet:
 * the default registry sits in the per-user state directory, and a board that has never
 * written a pidfile has never made it.
 */
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await fs.rename(temporary, filePath);
}

const NO_AGENT_SETTINGS: AgentSettings = {
  backend: null, model: null, effort: null, timeoutMs: null, workflow: null,
};

/**
 * Read one agent's settings out of a config that a human, or another program, wrote.
 *
 * Lenient on purpose: a value of the wrong type is dropped with a warning rather than
 * thrown, because this runs inside the load that every tab depends on and one project's
 * bad field must not empty the whole strip. The write path is where a wrong type is
 * refused — see `validateWorkspaceConfigPatch`.
 */
function readAgentSettings(
  kind: string,
  id: string,
  raw: unknown,
  backend: AgentBackendId,
  choices: AgentBackendChoices
): AgentSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_AGENT_SETTINGS;
  const config = raw as WorkspaceAgentConfig;

  // Read first, because everything else about a run is judged against the backend that will
  // *run* it: an effort is the backend's own vocabulary, and judging a picked backend's level
  // against the board's would refuse a word the CLI takes.
  let picked: AgentBackendId | null = null;
  if (typeof config.backend === 'string' && config.backend.trim()) {
    const candidate = config.backend.trim();
    const named = agentBackendId(candidate);
    if (named && choices.includes(named)) picked = named;
    // Dropped rather than obeyed, and said out loud: a project that named a backend nobody
    // granted is asking this board to run a binary it was never allowed to run, and the run it
    // gets instead is the board's own.
    else {
      logger.warn(`Workspace "${id}": ignoring agents.${kind}.backend "${candidate}" — this board enabled ${backendNames(choices)}`);
    }
  } else if (config.backend !== undefined && config.backend !== null) {
    logger.warn(`Workspace "${id}": ignoring agents.${kind}.backend — it must be a backend name, not ${typeof config.backend}`);
  }
  const running = picked ?? backend;

  const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : null;

  let effort: string | null = null;
  if (typeof config.effort === 'string' && config.effort.trim()) {
    const candidate = config.effort.trim();
    const levels = agentEfforts(running);
    if (levels.includes(candidate)) effort = candidate;
    // The backend is named here for the same reason the refusal names it: dropped silently, a
    // level meant for the other backend is indistinguishable from a typo, and this warning is
    // the only record a run has that its project asked for something it did not get.
    else if (levels.length) {
      logger.warn(`Workspace "${id}": ignoring agents.${kind}.effort "${candidate}" — the "${running}" backend takes ${levels.join(', ')}`);
    } else {
      logger.warn(`Workspace "${id}": ignoring agents.${kind}.effort "${candidate}" — the "${running}" backend has no reasoning effort to set`);
    }
  }

  const seconds = config.timeoutSeconds;
  const timeoutMs = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : null;

  // Carried through exactly as written, and *not* checked here. The leniency above is right
  // for a model and an effort — a dropped one costs a run its tuning and nothing else — but a
  // workflow that is quietly dropped is a run that looks completely normal and does something
  // other than what the project asked for. So a name that turns out to be unusable refuses the
  // run instead; `loadAgentWorkflow` is where that happens, per run, with the file named.
  // A value that is not text at all is a different mistake, refused on the way in by
  // `validateWorkspaceConfigPatch`, and warned about here rather than carried into a refusal
  // that could not explain itself.
  let workflow: string | null = null;
  if (typeof config.workflow === 'string') {
    workflow = config.workflow.trim() || null;
  } else if (config.workflow !== undefined && config.workflow !== null) {
    logger.warn(`Workspace "${id}": ignoring agents.${kind}.workflow — it must be a workflow name, not ${typeof config.workflow}`);
  }

  return { backend: picked, model, effort, timeoutMs, workflow };
}

function readAgents(
  id: string,
  config: WorkspaceConfig,
  backends: AgentBackends,
  choices: AgentBackendChoices
): WorkspaceAgents {
  const agents = config.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return { issue: NO_AGENT_SETTINGS, implement: NO_AGENT_SETTINGS };
  }
  return {
    issue: readAgentSettings('issue', id, agents.issue, backends.issue, choices),
    implement: readAgentSettings('implement', id, agents.implement, backends.implement, choices),
  };
}

function idFromPath(resolved: ResolvedPath): string {
  const segments = resolved.innerPath.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? 'workspace';
  return last.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

/**
 * Load one workspace. A project whose config is missing or malformed is still
 * returned — listed with an `error` — because a single broken project should not
 * hide the others, and a workspace that silently disappears is harder to debug
 * than one that shows up broken.
 */
async function loadWorkspace(
  entry: RegistryEntry,
  backends: AgentBackends | null,
  choices: AgentBackendChoices | null
): Promise<Workspace | null> {
  if (!entry?.path) {
    logger.warn('Workspace entry without a path, skipping', { entry });
    return null;
  }

  const resolved = resolveWorkspacePath(entry.path, entry.distro);
  const id = entry.id?.trim() || idFromPath(resolved);

  // Per workspace rather than per registry, because a distro may have been granted a different
  // agent from the machine: the environment this project lives in decides both which backend it
  // runs by default and which ones it may name.
  const environment = resolved.environment.kind === 'wsl' ? 'wsl' : 'native';
  const board = backends ?? {
    issue: boardAgentBackend(environment),
    implement: boardAgentBackend(environment),
  };
  const enabled = choices ?? enabledAgentBackends(environment);

  const base: Workspace = {
    id,
    name: id,
    path: resolved.hostPath,
    innerPath: resolved.innerPath,
    environment: resolved.environment,
    language: null,
    docsDir: null,
    boardFile: null,
    libraryFile: null,
    repo: null,
    githubProject: null,
    projectField: null,
    projectCardLimit: null,
    projectInProgressColumn: null,
    projectTodoColumn: null,
    projectFounderColumn: null,
    projectFounderPublishOff: false,
    agents: { issue: NO_AGENT_SETTINGS, implement: NO_AGENT_SETTINGS },
    error: null,
  };

  // Before the config is looked for, because off Windows there is nowhere to look: `hostPath`
  // falls back to the inner POSIX path, so the honest answer — no `wsl.exe` on this machine —
  // would otherwise arrive as `No board.config.json at /home/me/proj`, which reads as a
  // missing file rather than as a project this board cannot reach at all. The tab is broken
  // either way; this is the difference between a reason and a symptom.
  const unsupported = resolved.environment.kind === 'wsl' ? wslUnsupportedHere() : null;
  if (unsupported) {
    logger.warn(`Workspace "${id}" is unusable — ${unsupported}`);
    return { ...base, error: unsupported };
  }

  const configPath = resolveInWorkspace(resolved, WORKSPACE_CONFIG_FILENAME);
  if (!configPath) {
    return { ...base, error: 'Could not resolve the workspace config path' };
  }

  let shared: Record<string, unknown>;
  try {
    shared = (await readJson(configPath)) as Record<string, unknown>;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const reason = err.code === 'ENOENT'
      ? `No ${WORKSPACE_CONFIG_FILENAME} at ${resolved.hostPath}`
      : `Invalid ${WORKSPACE_CONFIG_FILENAME}: ${(error as Error).message}`;
    logger.warn(`Workspace "${id}" is unusable — ${reason}`);
    return { ...base, error: reason };
  }

  // Absent is the ordinary case and says nothing; present and unreadable is reported, for the
  // same reason the shared file is. An overlay that is silently ignored is a board that reads
  // its settings from a file the operator can see is right there.
  const localPath = resolveInWorkspace(resolved, WORKSPACE_LOCAL_CONFIG_FILENAME);
  let local: Record<string, unknown> | null = null;
  if (localPath) {
    try {
      const parsed = await readJson(localPath);
      if (!isPlainObject(parsed)) {
        const reason = `Invalid ${WORKSPACE_LOCAL_CONFIG_FILENAME}: it is not a JSON object`;
        logger.warn(`Workspace "${id}" is unusable — ${reason}`);
        return { ...base, error: reason };
      }
      local = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const reason = `Invalid ${WORKSPACE_LOCAL_CONFIG_FILENAME}: ${(error as Error).message}`;
        logger.warn(`Workspace "${id}" is unusable — ${reason}`);
        return { ...base, error: reason };
      }
    }
  }

  const config = mergeWorkspaceConfig(shared, local) as WorkspaceConfig;

  // Unlike a field pointing outside the project, this one is not survivable: a project whose
  // founder column *is* a column the queue works on has no safe reading. Honouring it hands
  // work no agent can do to the loop that starts agents; ignoring it silently leaves the
  // board resolving a name the operator can see is wrong right there in the file. So the
  // project loads broken and says which two keys disagree — the same shape as a config that
  // will not parse, and for the same reason.
  const collision = founderColumnCollision(config as Record<string, unknown>);
  if (collision) {
    logger.warn(`Workspace "${id}" is unusable — ${collision}`);
    return { ...base, error: collision };
  }

  // A config pointing outside its own project is treated as a mistake, not honoured.
  const docsDir = config.docsDir ? resolveInWorkspace(resolved, config.docsDir) : null;
  const boardFile = config.board ? resolveInWorkspace(resolved, config.board) : null;
  const libraryFile = config.library ? resolveInWorkspace(resolved, config.library) : null;

  const escaped = [
    config.docsDir && !docsDir ? 'docsDir' : null,
    config.board && !boardFile ? 'board' : null,
    config.library && !libraryFile ? 'library' : null,
  ].filter(Boolean);

  return {
    ...base,
    name: config.name?.trim() || id,
    language: config.language?.trim() || null,
    docsDir,
    boardFile,
    libraryFile,
    repo: config.repo?.trim() || null,
    githubProject: config.githubProject?.trim() || null,
    projectField: config.projectField?.trim() || null,
    projectCardLimit: Number.isFinite(config.projectCardLimit)
      ? Number(config.projectCardLimit)
      : null,
    projectInProgressColumn: config.projectInProgressColumn?.trim() || null,
    projectTodoColumn: config.projectTodoColumn?.trim() || null,
    projectFounderColumn: config.projectFounderColumn?.trim() || null,
    // Only `true` suppresses. Anything else — unset, absent, or a value somebody typed that is
    // not a boolean — is a board that publishes, which is what the default has to be.
    projectFounderPublishOff: config.projectFounderPublishOff === true,
    agents: readAgents(id, config, board, enabled),
    error: escaped.length
      ? `Config field(s) outside the workspace, ignored: ${escaped.join(', ')}`
      : null,
  };
}

/** A loaded workspace back in the form the path helpers compare. */
function resolveOf(workspace: Workspace): ResolvedPath {
  return resolveWorkspacePath(
    workspace.innerPath,
    workspace.environment.kind === 'wsl' ? workspace.environment.distro : undefined
  );
}

/** What a project wrote down about how this run should work, or why it will not run. */
export type AgentWorkflowLoad =
  | { ok: true; text: string | null }
  | { ok: false; error: string };

/**
 * Read the workflow a project selected for one of its agents, or refuse the run.
 *
 * **Unresolved is a refusal, not a shrug**, and that is deliberately unlike everything else in
 * a project's config. A `docsDir` pointing outside its project is ignored and the workspace
 * still loads, because the cost of that is a panel that shows nothing and says why. The cost of
 * a workflow quietly not applied is a run that looks entirely normal — the agent works, opens
 * its pull request, reports success — and did the wrong thing, in a process nobody was
 * watching. There is nothing to notice afterwards except the absence of what was asked for, so
 * it is refused before it starts, naming the file it looked for.
 *
 * Read from the **project**, not from the run's worktree, so every run of a project gets the
 * same text: a worktree is cut from the default branch, which is also why the file has to be
 * committed rather than left in a gitignored corner.
 *
 * Two guards against a config reaching outside its own project, and both are needed: the slug
 * shape refuses `..`, a separator and a drive letter by name, and `resolveInWorkspace` refuses
 * the same shapes again on the join. A null out of it counts as unresolved rather than as
 * unset, so a hand-edited config cannot become a silently workflow-less run.
 */
export async function loadAgentWorkflow(
  workspace: Workspace,
  kind: 'issue' | 'implement',
  settings: AgentSettings | null | undefined
): Promise<AgentWorkflowLoad> {
  const slug = settings?.workflow?.trim();
  if (!slug) return { ok: true, text: null };

  const setting = `agents.${kind}.workflow`;
  const refuse = (reason: string): AgentWorkflowLoad => ({
    ok: false,
    error: `${setting} in "${workspace.name}" selects the workflow "${slug}", and ${reason} `
      + 'This run was refused rather than run without the workflow it was configured with.',
  });

  if (!AGENT_WORKFLOW_SLUG.test(slug)) {
    return refuse(
      `that is not a workflow name — it must match ${AGENT_WORKFLOW_SLUG.source} and name `
      + `${agentWorkflowFile('<slug>')} inside the project. It is not a path.`
    );
  }

  const relative = agentWorkflowFile(slug);
  const filePath = resolveInWorkspace(resolveOf(workspace), relative);
  if (!filePath) {
    return refuse(`${workspace.innerPath}/${relative} does not resolve inside the project.`);
  }
  // Forward slashes so the path reads the same in a log, an error on a block and the config
  // that named it, on a board that mixes Windows and WSL projects.
  const named = filePath.replace(/\\/g, '/');

  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return refuse(err.code === 'ENOENT'
      ? `there is no file at ${named}.`
      : `${named} could not be read: ${(error as Error).message}.`);
  }
  if (!text.trim()) return refuse(`${named} is empty.`);

  return { ok: true, text };
}

/**
 * Read the registry and resolve every workspace in it.
 *
 * Returns an empty list when there is nothing to read. A registry file that is not there is
 * the ordinary state of a board nobody has added a project to yet — it says nothing and is
 * logged at debug, the same reading `readRegistry` takes on the write side. A file that is
 * there and cannot be read is a different thing and still an error.
 *
 * `backends` is which agent each project's two roles will be run under, and `choices` is which
 * ones a project may name for itself. Both are read only to judge what a config may say — a
 * reasoning-effort level is the backend's own vocabulary, and a backend a project names has to
 * be one the operator enabled.
 *
 * Both default to **the environment this process was started with**, per workspace, rather than
 * to a constant: the dozen callers here — the CLI, the checks, a health probe — are asking about
 * paths and repositories and have no board around them, and answering them with `raw` on a
 * board whose operator named Codex would refuse levels that board takes. A caller that knows
 * better passes them; a check with no agent variables set reads exactly what it read before
 * backends existed, because that environment enables nothing and resolves to `raw`.
 */
export async function loadWorkspaces(
  registryPath: string,
  backends: AgentBackends | null = null,
  choices: AgentBackendChoices | null = null
): Promise<Workspace[]> {
  if (!registryPath) return [];

  let registry: { workspaces?: RegistryEntry[] };
  try {
    registry = (await readJson(registryPath)) as { workspaces?: RegistryEntry[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug(`No workspace registry at ${registryPath} yet; this board has no projects.`);
      return [];
    }
    logger.error(`Could not read workspace registry at ${registryPath}: ${(error as Error).message}`);
    return [];
  }

  if (!Array.isArray(registry?.workspaces)) {
    logger.error('Workspace registry must contain a "workspaces" array');
    return [];
  }

  const loaded = await Promise.all(
    registry.workspaces.map((entry) => loadWorkspace(entry, backends, choices))
  );

  // Two spellings of one project would otherwise register twice; the canonical path
  // is what makes the UNC and POSIX forms of a WSL project collapse together.
  const seen = new Map<string, Workspace>();
  for (const workspace of loaded) {
    if (!workspace) continue;
    const key = resolveOf(workspace).canonical;
    if (seen.has(key)) {
      logger.warn(`Duplicate workspace ignored: ${workspace.path}`);
      continue;
    }
    if ([...seen.values()].some((existing) => existing.id === workspace.id)) {
      logger.warn(`Duplicate workspace id "${workspace.id}" ignored: ${workspace.path}`);
      continue;
    }
    seen.set(key, workspace);
  }

  return [...seen.values()];
}

// ─── Writing ──────────────────────────────────────────────────
//
// Everything below writes files this repository does not own: the registry belongs to
// whoever runs the board and lives outside the project, and a board.config.json belongs
// to the project it sits in. Two rules follow from that and are kept by every function
// here. Read, modify, write — never re-serialise the shape this module understands, or a
// key it has never heard of disappears the first time somebody uses the UI. And refuse
// loudly: a `+` that silently did nothing would be the worse failure.

/** What a caller could not do, and why, in a shape a route can answer with. */
export interface WorkspaceWriteRefusal {
  ok: false;
  status: number;
  error: string;
}

export interface WorkspaceWritten {
  ok: true;
  workspace: Workspace;
  workspaces: Workspace[];
}

export type WorkspaceWriteResult = WorkspaceWritten | WorkspaceWriteRefusal;

// There used to be a `NO_REGISTRY` refusal here — a 503 telling the caller to point
// `EXCALIDRAW_WORKSPACES` at a file and restart the board, returned by every function below
// when the path was `undefined`. `registryPath()` cannot answer `undefined`, so the refusal
// became unreachable, and an unreachable refusal naming a variable a first-run reader has
// never set is worse than none: it was the only thing the `+` could ever have said back.

interface Registry {
  workspaces?: unknown;
  [key: string]: unknown;
}

/** The registry as it is on disk, or a refusal describing what is wrong with it. */
async function readRegistry(registryPath: string): Promise<
  { ok: true; registry: Registry; entries: RegistryEntry[] } | WorkspaceWriteRefusal
> {
  let parsed: unknown;
  try {
    parsed = await readJson(registryPath);
  } catch (error) {
    // A registry that was configured but never created is the empty registry: the board
    // is being asked to add its first project, which is exactly that case.
    //
    // `entries` is the array *inside* `registry`, never a second empty one that looks the
    // same. Every caller appends to `entries` and then writes `registry`, so two arrays here
    // meant the first project on a not-yet-created registry was pushed into a list nobody
    // wrote: the file appeared, held `{"workspaces": []}`, and the `+` reported a 500 saying
    // the project did not load back. The path below never had the bug, because there the
    // parsed object is the one both fields come from.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const fresh: Registry = { workspaces: [] };
      return { ok: true, registry: fresh, entries: fresh.workspaces as RegistryEntry[] };
    }
    return {
      ok: false,
      status: 500,
      error: `Could not read the workspace registry at ${registryPath}: ${(error as Error).message}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 500, error: `The workspace registry at ${registryPath} is not a JSON object.` };
  }

  const registry = parsed as Registry;
  if (registry.workspaces === undefined) registry.workspaces = [];
  if (!Array.isArray(registry.workspaces)) {
    return { ok: false, status: 500, error: 'The workspace registry must contain a "workspaces" array.' };
  }

  return { ok: true, registry, entries: registry.workspaces as RegistryEntry[] };
}

/** The id an entry ends up with, which is not always the id it wrote down. */
function idOfEntry(entry: RegistryEntry): string | null {
  const declared = entry?.id?.trim();
  if (declared) return declared;
  if (!entry?.path) return null;
  return idFromPath(resolveWorkspacePath(entry.path, entry.distro));
}

/**
 * The folder a project is looked at for, and only that one.
 *
 * One convention, checked on disk. Guessing a second name, or writing the field for a
 * folder that is not there, would put a path into somebody else's config that nothing
 * ever resolves — which is worse than the blank the settings dialog offers to fill.
 */
const CONVENTIONAL_DOCS_DIR = 'docs';

/** Whether the project keeps its documents where projects usually keep them. */
async function hasConventionalDocsDir(resolved: ResolvedPath): Promise<boolean> {
  const docsPath = resolveInWorkspace(resolved, CONVENTIONAL_DOCS_DIR);
  if (!docsPath) return false;
  try {
    return (await fs.stat(docsPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A minimal config for a project that has none.
 *
 * Without it a brand new tab arrives already marked broken — `No board.config.json at …`
 * is exactly what `loadWorkspace` says about a project it cannot read — which is a poor
 * greeting for a project the user has just chosen. Best-effort: a project directory that
 * refuses the write is still worth registering, and it will simply show that error.
 *
 * `docsDir` is written when — and only when — the folder is actually there. Documentation
 * reaches a board through `docsDir` alone, so a config without it is a board on which every
 * `docKey` answers 404, and that was the state every project added through the `+` arrived
 * in. Read from disk rather than assumed: a project that keeps its documents somewhere else
 * still gets the blank, and sets it in the project settings dialog.
 *
 * `repo` follows the same rule one step further out: it is read from the project's own
 * `origin`, and left out entirely when there is no GitHub remote to read. It used to be a
 * value this repository shipped in its tracked config, which meant every clone of it named
 * the maintainer's repository — an answer about whoever wrote the file rather than about the
 * checkout in front of the board. `githubProject` gets no such treatment and never will:
 * a project board belongs to an account, nothing on disk implies one, and a guess there points
 * `gh` at somebody else's board.
 *
 * This runs when the config is created and at no other time. A project already registered
 * keeps whatever its config says, including the absence — repairing files this repository
 * does not own, behind the user's back, is not something a registration should do.
 */
async function ensureWorkspaceConfig(resolved: ResolvedPath): Promise<void> {
  const configPath = resolveInWorkspace(resolved, WORKSPACE_CONFIG_FILENAME);
  if (!configPath) return;

  try {
    await fs.access(configPath);
    return;
  } catch { /* there is none, which is the case this exists for */ }

  const segments = resolved.innerPath.split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? 'Project';
  const config: WorkspaceConfig = { name };
  if (await hasConventionalDocsDir(resolved)) config.docsDir = CONVENTIONAL_DOCS_DIR;

  // Best-effort, like the rest of this function: a directory that is no repository, a git
  // that will not start, a remote that is not GitHub — each of those is a project with no
  // `repo` key, which is exactly what it was before this line existed.
  try {
    const { repo } = await originRemote({
      environment: resolved.environment,
      path: resolved.hostPath,
      innerPath: resolved.innerPath,
    });
    if (repo) config.repo = repo;
  } catch (error) {
    logger.warn(`Could not read the origin remote of ${resolved.hostPath}: ${(error as Error).message}`);
  }

  try {
    await writeJsonFile(configPath, config);
  } catch (error) {
    logger.warn(`Could not write ${WORKSPACE_CONFIG_FILENAME} into ${resolved.hostPath}: ${(error as Error).message}`);
  }
}

export interface NewWorkspace {
  path: string;
  id?: string;
  distro?: string;
}

/**
 * Add one project to the registry and return the list as it now reads.
 *
 * The order of the guards is deliberate. A duplicate is refused before the directory is
 * stat-ed, because refusing a duplicate does not need the directory to be reachable —
 * and a WSL project registered from inside its distro is frequently not reachable from
 * this process at all, so the other order would answer "no such directory" for a project
 * that is plainly already registered.
 */
export async function addWorkspace(
  registryPath: string,
  request: NewWorkspace
): Promise<WorkspaceWriteResult> {
  const given = typeof request?.path === 'string' ? request.path.trim() : '';
  if (!given) return { ok: false, status: 400, error: 'A project needs a path.' };

  const distro = typeof request.distro === 'string' && request.distro.trim()
    ? request.distro.trim()
    : undefined;
  const resolved = resolveWorkspacePath(given, distro);

  // First of the guards, and before the registry is even read: a project this board could
  // never run is not a project it should write down. Both spellings are refused — the
  // `distro` field and a `\\wsl.localhost\…` path, which needs no field to resolve as WSL —
  // because the tab that entry produced would come up broken with this same sentence on it.
  if (distro || resolved.environment.kind === 'wsl') {
    const unsupported = wslUnsupportedHere();
    if (unsupported) {
      return {
        ok: false,
        status: 400,
        error: `${unsupported}. Nothing was written to the registry.`,
      };
    }
  }

  const read = await readRegistry(registryPath);
  if (!read.ok) return read;
  const { registry, entries } = read;

  const duplicate = entries.find(
    (entry) => entry?.path && resolveWorkspacePath(entry.path, entry.distro).canonical === resolved.canonical
  );
  if (duplicate) {
    return {
      ok: false,
      status: 409,
      error: `That project is already registered as "${idOfEntry(duplicate) ?? duplicate.path}". `
        + 'Two spellings of one path are one project.',
    };
  }

  const id = typeof request.id === 'string' && request.id.trim()
    ? request.id.trim()
    : idFromPath(resolved);
  if (entries.some((entry) => idOfEntry(entry) === id)) {
    return { ok: false, status: 409, error: `The id "${id}" is already taken by another project.` };
  }

  try {
    const stats = await fs.stat(resolved.hostPath);
    if (!stats.isDirectory()) {
      return { ok: false, status: 400, error: `Not a directory: ${resolved.hostPath}` };
    }
  } catch (error) {
    return { ok: false, status: 400, error: `Cannot read ${resolved.hostPath}: ${(error as Error).message}` };
  }

  // Stored canonically rather than as typed, so the file keeps one spelling per project:
  // a WSL project by its inner path plus its distro, anything else by its absolute path.
  entries.push(resolved.environment.kind === 'wsl'
    ? { id, path: resolved.innerPath, distro: resolved.environment.distro }
    : { id, path: resolved.innerPath });

  try {
    await writeJsonFile(registryPath, registry);
  } catch (error) {
    return { ok: false, status: 500, error: `Could not write the registry at ${registryPath}: ${(error as Error).message}` };
  }

  await ensureWorkspaceConfig(resolved);

  const workspaces = await loadWorkspaces(registryPath);
  const workspace = workspaces.find((candidate) => candidate.id === id);
  if (!workspace) {
    return {
      ok: false,
      status: 500,
      error: `"${id}" was written to the registry but did not load back from it.`,
    };
  }
  return { ok: true, workspace, workspaces };
}

/**
 * A removal either happened or did not. `WorkspaceWritten` cannot describe it: there is no
 * workspace left to hand back, and the entry as the *file* had it — the path a confirmation
 * promised to leave alone — is the only account of what went.
 */
export interface WorkspaceRemoved {
  ok: true;
  removed: { id: string; path: string; distro?: string };
  workspaces: Workspace[];
}

export type WorkspaceRemoveResult = WorkspaceRemoved | WorkspaceWriteRefusal;

/**
 * Take a project out of the registry.
 *
 * The other half of `addWorkspace`, and it was missing for long enough to be the first thing
 * a stranger could not undo: pick the wrong folder, or move a project after registering it,
 * and the tab stayed for good — `loadWorkspace` marks such an entry broken rather than
 * dropping it, `reorderWorkspaces` refuses a list that leaves an id out, and the only way
 * back was hand-editing a file outside this repository whose path the reader was never told.
 *
 * **A line of the registry, and nothing else.** The project directory belongs to whoever
 * made it and its `board.config.json` belongs to the project — neither is this board's to
 * delete, and the confirmation in the settings dialog promises exactly that. The one thing
 * that is arguably the board's own is the drawing saved beside the registry, and that is the
 * route's decision rather than this function's: `board-state.ts` owns those files, and
 * importing it here would point the registry module at the module that reads the registry.
 *
 * **Exactly one entry**, the first whose id matches, in the same read–modify–write the rest
 * of this file uses so keys nobody here understands survive. Two entries can resolve to one
 * id — `loadWorkspaces` warns and drops the second — and removing both on one request would
 * be deleting a line of somebody's file that no tab on screen stood for.
 */
export async function removeWorkspace(
  registryPath: string,
  id: unknown
): Promise<WorkspaceRemoveResult> {
  const wanted = typeof id === 'string' ? id.trim() : '';
  if (!wanted) return { ok: false, status: 400, error: 'A removal needs the id of a project.' };

  const read = await readRegistry(registryPath);
  if (!read.ok) return read;
  const { registry, entries } = read;

  const at = entries.findIndex((entry) => idOfEntry(entry) === wanted);
  if (at < 0) {
    // Named against the *registry* rather than against `loadWorkspaces`, so an entry that
    // failed to load is still removable: a project whose folder has been deleted is exactly
    // the tab somebody is trying to get rid of, and answering "not registered" about a line
    // that is plainly in the file would be the old dead end wearing a 404.
    const known = entries.map(idOfEntry).filter(Boolean);
    return {
      ok: false,
      status: 404,
      error: `No project "${wanted}" is registered. `
        + `The board currently has: ${known.join(', ') || 'no projects'}.`,
    };
  }

  const [dropped] = entries.splice(at, 1);

  try {
    await writeJsonFile(registryPath, registry);
  } catch (error) {
    return { ok: false, status: 500, error: `Could not write the registry at ${registryPath}: ${(error as Error).message}` };
  }

  return {
    ok: true,
    removed: {
      id: wanted,
      path: typeof dropped?.path === 'string' ? dropped.path : '',
      ...(typeof dropped?.distro === 'string' ? { distro: dropped.distro } : {}),
    },
    workspaces: await loadWorkspaces(registryPath),
  };
}

/** A reorder either happened, or did not and says why. There is no one workspace it is about. */
export type WorkspaceOrderResult =
  | { ok: true; workspaces: Workspace[] }
  | WorkspaceWriteRefusal;

/**
 * Write down the order the tabs are in.
 *
 * The order *is* the array order of the registry and has never been anything else: the strip
 * renders `GET /api/workspaces` verbatim and that route answers `loadWorkspaces` verbatim. So
 * there is nothing to add to the file — this permutes the entries already in it.
 *
 * **A permutation or nothing.** The list must name exactly the workspaces the registry loads
 * back, each once. Anything else is refused before a byte is written rather than applied as
 * far as it goes: this is somebody else's file, a caller sending a stale list has an idea of
 * the board that is already wrong, and a half-applied order is harder to notice than a
 * refusal that says which id was the problem.
 *
 * Entries are moved **whole**, never rebuilt, so a `colour` or a comment somebody added by
 * hand travels with the project it was written on — the same rule `addWorkspace` keeps for
 * the file and `writeWorkspaceConfig` keeps for a project's config.
 *
 * Ordered against the *loaded* ids rather than against the raw entries, because the loaded
 * list is what the strip shows and therefore what a drag is expressed in. An entry the loader
 * dropped — a duplicate path, a duplicate id, an entry with no path at all — has no tab and
 * so no position to state; it is kept, in its own relative order, after the ones that do.
 * Kept, because deleting a line of somebody's registry is not what a reorder was asked to do.
 *
 * **An id this machine does not own is passed through rather than refused**, when the caller
 * says which those are. A tab strip carrying a peer board's projects (`docs/federation.md`) is
 * one strip, so a drag on it names ids no registry here has ever held; refusing the write would
 * make an order spanning two machines unexpressible, and dropping them would answer the caller
 * with a list short of the tabs it is holding. Nothing is written for them — there is nowhere
 * here to write one — and the permutation below still has to name every project this registry
 * does load, exactly once, because a caller working from a stale list is the mistake that rule
 * exists to catch. `foreign` is a predicate rather than "anything unregistered" for that reason.
 */
export interface ReorderOptions {
  /** Whether an id belongs to a machine this registry does not answer for. */
  foreign?: (id: string) => boolean;
}

export async function reorderWorkspaces(
  registryPath: string,
  ids: unknown,
  options: ReorderOptions = {}
): Promise<WorkspaceOrderResult> {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.trim())) {
    return {
      ok: false,
      status: 400,
      error: 'The order must be an array of workspace ids, listing every registered project exactly once.',
    };
  }
  const wanted = (ids as string[]).map((id) => id.trim());
  const foreign = options.foreign ?? (() => false);
  // The half of the order this registry is answerable for. The rest is still a position on the
  // strip — it is just not a position in a file on this machine.
  const mine = wanted.filter((id) => !foreign(id));

  const read = await readRegistry(registryPath);
  if (!read.ok) return read;
  const { registry, entries } = read;

  const current = await loadWorkspaces(registryPath);
  const known = current.map((workspace) => workspace.id);

  const missing = known.filter((id) => !mine.includes(id));
  const unknown = mine.filter((id) => !known.includes(id));
  // Over the whole list, foreign ids included: one tab cannot be in two places whoever owns it.
  const repeated = [...new Set(wanted.filter((id, at) => wanted.indexOf(id) !== at))];
  if (missing.length || unknown.length || repeated.length) {
    const said = [
      unknown.length ? `${unknown.join(', ')} — not registered` : null,
      missing.length ? `${missing.join(', ')} — registered but left out` : null,
      repeated.length ? `${repeated.join(', ')} — listed more than once` : null,
    ].filter(Boolean).join('; ');
    return {
      ok: false,
      status: 400,
      error: `The order must list every registered project exactly once (${said}). `
        + `The board currently has: ${known.join(', ') || 'no projects'}. `
        + 'Nothing was written — reload the list and try again.',
    };
  }

  // First match wins, so two entries that collapsed onto one id under `loadWorkspaces` cannot
  // both claim the one position that id has on the strip.
  const remaining = [...entries];
  const ordered: RegistryEntry[] = [];
  for (const id of mine) {
    const at = remaining.findIndex((entry) => idOfEntry(entry) === id);
    if (at >= 0) ordered.push(...remaining.splice(at, 1));
  }
  registry.workspaces = [...ordered, ...remaining];

  try {
    await writeJsonFile(registryPath, registry);
  } catch (error) {
    return { ok: false, status: 500, error: `Could not write the registry at ${registryPath}: ${(error as Error).message}` };
  }

  return { ok: true, workspaces: await loadWorkspaces(registryPath) };
}

/** Fields a project's config may carry that are plain strings. */
const STRING_FIELDS = [
  'name', 'language', 'docsDir', 'board', 'library', 'repo',
  'githubProject', 'projectField', 'projectInProgressColumn', 'projectTodoColumn',
  'projectFounderColumn',
] as const;

const AGENT_FIELDS = ['backend', 'model', 'effort', 'timeoutSeconds', 'workflow'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Why a `githubProject` was refused, in the words the settings dialog will show.
 *
 * The diagnosis is `githubProjectRefusal` in `project-board-types.ts`, shared with the read
 * path that refuses the same value when a config was edited by hand (#317). Only the tail is
 * this caller's: "Nothing was written" is true of a refused save and false of a refused read.
 */
function refuseGithubProject(value: string): string {
  return `${githubProjectRefusal(value)} Nothing was written.`;
}

/** The one column setting the implement queue does not work on. */
const FOUNDER_COLUMN_SETTING = 'projectFounderColumn';

/**
 * The two it does, paired with what the board falls back to — read at call time, not here.
 *
 * `project-board.js` and this module are a cycle: it needs `Workspace`, which is a type and
 * therefore elided, but the runtime edge exists anyway through `gh.js` → `issue-agent.js`,
 * which imports `loadAgentWorkflow` from here as a value. Whichever of the two is entered
 * first, the other's module body runs while its exports are still in the temporal dead zone,
 * so a top-level `DEFAULT_TODO_COLUMN` here is a `ReferenceError` at import — measured, not
 * guessed. Inside a function the read happens after both bodies have finished, which is why
 * this is a function and must stay one. `scripts/check-founder-column-setting.mjs` imports
 * `project-board.js` before this module and would fail to load at all if it were hoisted.
 */
const queueColumnSettings = (): readonly { setting: string; fallback: string }[] => [
  { setting: 'projectInProgressColumn', fallback: DEFAULT_IN_PROGRESS_COLUMN },
  { setting: 'projectTodoColumn', fallback: DEFAULT_TODO_COLUMN },
];

/** A config value read the way `loadWorkspace` reads one: trimmed, and blank is unset. */
function configuredColumn(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Why a founder column pointed at a column the queue works on is refused, or `null`.
 *
 * The queue drains exactly one column, resolved by name at dispatch time, and `findColumn`
 * matches `trim().toLowerCase()`. So a founder column with a name of its own is invisible to
 * the start loop by construction — and that construction holds only while the two names
 * differ. A config that makes them the same is the one route by which a founder action, which
 * is by definition work no agent can do, reaches the column an agent starts from; it is closed
 * here, by name, before the board ever reads the project.
 *
 * Compared **as resolved** rather than as written, on both sides. A project that never wrote
 * `projectTodoColumn` and calls its founder column `Todo` collides with the default just as
 * squarely as one that wrote both, and a project that renamed its queue column onto the
 * founder default collides from the other side; the board would resolve those to one column
 * either way, so both are refused. Case and surrounding whitespace are folded for the same
 * reason `findColumn` folds them: they are what the board would fold when it looked the column
 * up.
 *
 * The message names **both** keys, because either one of them is a legitimate thing to change
 * and this code has no way to know which one the reader meant.
 */
function founderColumnCollision(config: Record<string, unknown>): string | null {
  const founder = configuredColumn(config[FOUNDER_COLUMN_SETTING]) ?? DEFAULT_FOUNDER_COLUMN;
  const wanted = founder.toLowerCase();

  for (const { setting, fallback } of queueColumnSettings()) {
    const configured = configuredColumn(config[setting]);
    const queue = configured ?? fallback;
    if (queue.toLowerCase() !== wanted) continue;
    return `"${FOUNDER_COLUMN_SETTING}" is "${founder}"`
      + `${configuredColumn(config[FOUNDER_COLUMN_SETTING]) ? '' : ' by default'}`
      + `, and "${setting}" ${configured ? 'names' : 'defaults to'} the same column "${queue}". `
      + `The implement queue works on that column, so a founder action there would be started `
      + `as work. Give one of them a name of its own in ${WORKSPACE_CONFIG_FILENAME}.`;
  }
  return null;
}

/**
 * Check a config edit before any of it reaches disk.
 *
 * This is the half of the "one broken project should not hide the others" promise that a
 * writer owes: `loadWorkspace` calls `config.name?.trim()` outside its own try/catch, so a
 * config whose `name` is a number throws, rejects the `Promise.all` in `loadWorkspaces`,
 * and `GET /api/workspaces` answers 500 — every tab disappears. That is latent while
 * configs are hand-written by one person and stops being latent the moment a UI writes
 * them, so nothing of the wrong type is written in the first place. (Hardening the read
 * path against a config edited by hand is a separate matter, and a separate issue.)
 *
 * A field it has never heard of is refused rather than stored, so a typo says so instead
 * of quietly doing nothing — and so that "a project may never grant an agent" cannot be
 * worked around by inventing a `command` field.
 *
 * `backends` is which agent each of this project's two roles will actually be run under, and it
 * is what an `effort` is judged against: the levels are the backend's own vocabulary, so a list
 * that does not come from the backend can only refuse a level one CLI takes or accept one
 * another would exit on. Defaulted for the callers that have no board around them.
 *
 * `choices` is the other half of the same rule, and it is what makes a `backend` field safe to
 * accept at all: a project picks among the backends the operator enabled, so a name outside
 * that set is refused here by name rather than written and silently ignored later. Defaulted
 * from the environment, which for a board that enabled nothing is the empty set — every
 * `backend` a project could write is refused, which is the correct answer for a board that
 * granted no agent.
 */
export function validateWorkspaceConfigPatch(
  patch: unknown,
  backends: AgentBackends = DEFAULT_AGENT_BACKENDS,
  choices: AgentBackendChoices = enabledAgentBackends()
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPlainObject(patch)) return { ok: false, error: 'The config must be a JSON object.' };

  const known = new Set<string>([...STRING_FIELDS, 'projectCardLimit', 'agents']);
  for (const [key, value] of Object.entries(patch)) {
    if (!known.has(key)) {
      return { ok: false, error: `"${key}" is not a project setting. Known settings: ${[...known].join(', ')}.` };
    }

    if ((STRING_FIELDS as readonly string[]).includes(key)) {
      if (value !== null && typeof value !== 'string') {
        return { ok: false, error: `"${key}" must be text, or null to clear it.` };
      }
      // The one string field with a shape, because it is the one whose failure is silent:
      // the mirror answers 404 for a URL it cannot parse, the canvas reads 404 as "this
      // board has no project", and a board configured with a value that can never resolve
      // is indistinguishable from a board that named none. Refused here, where somebody is
      // looking at the field they just typed into.
      if (key === 'githubProject' && typeof value === 'string' && value.trim()
          && !parseProjectUrl(value)) {
        return { ok: false, error: refuseGithubProject(value.trim()) };
      }
      continue;
    }

    if (key === 'projectCardLimit') {
      if (value === null) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        return { ok: false, error: '"projectCardLimit" must be a whole number of cards, or null to clear it.' };
      }
      continue;
    }

    // agents
    if (value === null) continue;
    if (!isPlainObject(value)) return { ok: false, error: '"agents" must be a JSON object, or null to clear it.' };
    for (const [kind, settings] of Object.entries(value)) {
      if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
        return { ok: false, error: `"agents.${kind}" is not an agent. Known agents: ${AGENT_KINDS.join(', ')}.` };
      }
      if (settings === null) continue;
      if (!isPlainObject(settings)) {
        return { ok: false, error: `"agents.${kind}" must be a JSON object, or null to clear it.` };
      }
      // Settled before the loop, because an effort is judged against the backend that will run
      // it and `Object.entries` gives no order to rely on: a patch naming `codex-cli` and
      // `minimal` together has to be judged as the pair it is, whichever key was typed first.
      let running = backends[kind as AgentKind];
      if (settings.backend !== undefined && settings.backend !== null) {
        if (typeof settings.backend !== 'string') {
          return {
            ok: false,
            error: `"agents.${kind}.backend" must be a backend name, or null to use the board's own.`,
          };
        }
        const named = settings.backend.trim();
        const picked = named ? agentBackendId(named) : null;
        if (named && (!picked || !choices.includes(picked))) {
          return { ok: false, error: refuseBackend(kind, named, choices) };
        }
        if (picked) running = picked;
      }

      for (const [field, setting] of Object.entries(settings)) {
        if (!(AGENT_FIELDS as readonly string[]).includes(field)) {
          return {
            ok: false,
            error: `"agents.${kind}.${field}" is not an agent setting. Known settings: ${AGENT_FIELDS.join(', ')}. `
              + 'A project retunes the agent the board already allows; it cannot supply a command of its own.',
          };
        }
        if (setting === null) continue;
        if (field === 'timeoutSeconds') {
          if (typeof setting !== 'number' || !Number.isFinite(setting) || setting <= 0) {
            return { ok: false, error: `"agents.${kind}.timeoutSeconds" must be a positive number of seconds, or null for no ceiling of its own.` };
          }
          continue;
        }
        if (typeof setting !== 'string') {
          return { ok: false, error: `"agents.${kind}.${field}" must be text, or null to use the board default.` };
        }
        // Already settled above, and settled first: it is what `running` was read from.
        if (field === 'backend') continue;
        if (field === 'effort' && setting.trim()
            && !agentEfforts(running).includes(setting.trim())) {
          return { ok: false, error: refuseEffort(kind, running, setting.trim()) };
        }
        // A name, not a path. Refused here as well as per run because this is the surface a
        // person types into, and "agent-workflows/x.md" is exactly what somebody would write.
        if (field === 'workflow' && setting.trim()
            && !AGENT_WORKFLOW_SLUG.test(setting.trim())) {
          return {
            ok: false,
            error: `"agents.${kind}.workflow" must be a name matching ${AGENT_WORKFLOW_SLUG.source}, `
              + `naming ${agentWorkflowFile('<slug>')} in the project — not a path. The text in that `
              + 'file is given to the agent; it grants the project nothing it did not already have.',
          };
        }
      }
    }
  }

  // After the loop, so a `projectFounderColumn` that is a number is refused as the wrong type
  // rather than as a collision with a column it could never have named. The three column
  // settings are judged together for the same reason a `backend` and an `effort` are: the
  // patch is what the dialog holds in full — every field on every save, changed or not — and
  // a pair is only wrong as a pair. A hand-made `PUT` carrying one of the three and not the
  // others is judged against the defaults rather than against what the file already says, and
  // `loadWorkspace` is the backstop there: `writeWorkspaceConfig` reads the project back
  // through it, so a collision assembled that way arrives as a project marked broken.
  const collision = founderColumnCollision(patch);
  if (collision) return { ok: false, error: `${collision} Nothing was written.` };

  return { ok: true, patch };
}

/** One of the two files a project's settings can be in, and what is in it now. */
interface ConfigFile {
  path: string;
  /** Null for an overlay that is not there — the ordinary case, and not an error. */
  config: Record<string, unknown> | null;
}

interface ConfigFiles {
  ok: true;
  workspace: Workspace;
  shared: ConfigFile;
  local: ConfigFile;
}

/** Read one settings file, distinguishing "not there" from "there and unreadable". */
async function readConfigFile(
  filePath: string
): Promise<{ ok: true; config: Record<string, unknown> | null } | WorkspaceWriteRefusal> {
  try {
    const parsed = await readJson(filePath);
    if (!isPlainObject(parsed)) {
      return { ok: false, status: 409, error: `${filePath} is not a JSON object, so it cannot be edited from here.` };
    }
    return { ok: true, config: parsed };
  } catch (error) {
    // A project with no config yet is being given its first one; a malformed one is left
    // alone, because overwriting it would destroy whatever the operator was in the middle
    // of writing.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, config: null };
    return {
      ok: false,
      status: 409,
      error: `${filePath} could not be read (${(error as Error).message}), so it will not be overwritten from here.`,
    };
  }
}

/** Where a registered workspace keeps its settings — both files — and what is in each. */
async function configFileOf(
  registryPath: string,
  id: string
): Promise<ConfigFiles | WorkspaceWriteRefusal> {
  const workspaces = await loadWorkspaces(registryPath);
  const workspace = workspaces.find((candidate) => candidate.id === id);
  if (!workspace) return { ok: false, status: 404, error: `Workspace "${id}" is not registered.` };

  const resolved = resolveOf(workspace);
  const configPath = resolveInWorkspace(resolved, WORKSPACE_CONFIG_FILENAME);
  const localPath = resolveInWorkspace(resolved, WORKSPACE_LOCAL_CONFIG_FILENAME);
  if (!configPath || !localPath) {
    return { ok: false, status: 500, error: `Could not resolve where "${id}" keeps its ${WORKSPACE_CONFIG_FILENAME}.` };
  }

  const shared = await readConfigFile(configPath);
  if (!shared.ok) return shared;
  const local = await readConfigFile(localPath);
  if (!local.ok) return local;

  return {
    ok: true,
    workspace,
    shared: { path: configPath, config: shared.config },
    local: { path: localPath, config: local.config },
  };
}

/**
 * A project's settings as they are on disk, for a UI that has to edit them.
 *
 * The overlay laid over the shared file, because what the dialog has to show is what is *in
 * force*: a field showing the shared value while the board obeys the overlay is a dialog that
 * lies twice — once about the setting, and again when saving it appears to do nothing.
 */
export async function readWorkspaceConfig(
  registryPath: string,
  id: string
): Promise<{ ok: true; config: Record<string, unknown> } | WorkspaceWriteRefusal> {
  const found = await configFileOf(registryPath, id);
  if (!found.ok) return found;
  return { ok: true, config: mergeWorkspaceConfig(found.shared.config ?? {}, found.local.config) };
}

/** Apply one setting to one config object, in place. Shared by both files. */
function applySetting(config: Record<string, unknown>, key: string, value: unknown): void {
  if (key === 'agents') {
    const agents = isPlainObject(config.agents) ? { ...config.agents } : {};
    if (value === null) {
      delete config.agents;
      return;
    }
    for (const [kind, settings] of Object.entries(value as Record<string, unknown>)) {
      if (settings === null) { delete agents[kind]; continue; }
      const merged: Record<string, unknown> = isPlainObject(agents[kind]) ? { ...agents[kind] as Record<string, unknown> } : {};
      for (const [field, setting] of Object.entries(settings as Record<string, unknown>)) {
        if (setting === null || (typeof setting === 'string' && !setting.trim())) delete merged[field];
        else merged[field] = typeof setting === 'string' ? setting.trim() : setting;
      }
      if (Object.keys(merged).length) agents[kind] = merged;
      else delete agents[kind];
    }
    if (Object.keys(agents).length) config.agents = agents;
    else delete config.agents;
    return;
  }

  if (value === null || (typeof value === 'string' && !value.trim())) delete config[key];
  else config[key] = typeof value === 'string' ? value.trim() : value;
}

/**
 * Apply one edit to a project's settings, keeping everything it does not mention.
 *
 * `null` clears a field rather than storing a null, so a config stays the small readable
 * file somebody would have hand-written. Agent settings merge one level down, so setting
 * a model does not erase an effort configured beside it.
 *
 * **Each setting goes back to the file it was read from.** A project with no
 * `board.config.local.json` is the case this always handled and behaves identically; where
 * there is one, a setting the overlay already carries is written to the overlay and everything
 * else to the shared file. The two alternatives are both wrong in a way a user would meet
 * immediately: writing everything to the shared file leaves the edit shadowed by the overlay,
 * so saving appears to do nothing, and writing everything to the overlay copies the whole
 * config into a file nobody shares, so the project's own settings stop reaching this machine.
 * The dialog sends every field on every save, changed or not, which is what makes this a
 * question with a wrong answer rather than an academic one.
 */
export async function writeWorkspaceConfig(
  registryPath: string,
  id: string,
  patch: unknown,
  backends: AgentBackends = DEFAULT_AGENT_BACKENDS,
  choices: AgentBackendChoices = enabledAgentBackends()
): Promise<WorkspaceWriteResult> {
  const valid = validateWorkspaceConfigPatch(patch, backends, choices);
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };

  const found = await configFileOf(registryPath, id);
  if (!found.ok) return found;

  const shared = { ...(found.shared.config ?? {}) };
  const local = found.local.config ? { ...found.local.config } : null;
  const touched: Record<string, unknown>[] = [];

  for (const [key, value] of Object.entries(valid.patch)) {
    const target = local && key in local ? local : shared;
    applySetting(target, key, value);
    if (!touched.includes(target)) touched.push(target);
  }

  // An edit that names no setting still writes the shared file, which is what it did before
  // there were two: that is the call a project with no config at all is given its first one by.
  const writes: [string, Record<string, unknown>][] = [];
  if (!touched.length || touched.includes(shared)) writes.push([found.shared.path, shared]);
  if (local && touched.includes(local)) writes.push([found.local.path, local]);

  for (const [filePath, contents] of writes) {
    try {
      await writeJsonFile(filePath, contents);
    } catch (error) {
      return { ok: false, status: 500, error: `Could not write ${filePath}: ${(error as Error).message}` };
    }
  }

  // The same backends the patch was judged against, so that what is written and what is read
  // back cannot disagree about whether an effort survived.
  const workspaces = await loadWorkspaces(registryPath, backends, choices);
  const workspace = workspaces.find((candidate) => candidate.id === id);
  if (!workspace) {
    return { ok: false, status: 500, error: `"${id}" did not load back after its config was written.` };
  }
  return { ok: true, workspace, workspaces };
}
