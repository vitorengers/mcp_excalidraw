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
import { stateDir, stateDirCandidates } from './settings.js';
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
  const named = process.env.EXCALIDRAW_WORKSPACES?.trim();
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
  if (process.env.EXCALIDRAW_WORKSPACES?.trim()) return true;

  try {
    const parsed = JSON.parse(readFileSync(registryPath(), 'utf-8')) as { workspaces?: unknown };
    return Array.isArray(parsed?.workspaces) && parsed.workspaces.length > 0;
  } catch {
    // No file, or one nobody can parse. Either way this canvas is showing no projects, which
    // is what the field is being asked.
    return false;
  }
}

/**
 * Effort levels the agent CLI accepts, as `claude --help` states them.
 *
 * Kept as a list rather than a free string because a typo here is only discovered when a
 * run fails minutes later, in a process nobody is watching.
 */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

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
  model: null, effort: null, timeoutMs: null, workflow: null,
};

/**
 * Read one agent's settings out of a config that a human, or another program, wrote.
 *
 * Lenient on purpose: a value of the wrong type is dropped with a warning rather than
 * thrown, because this runs inside the load that every tab depends on and one project's
 * bad field must not empty the whole strip. The write path is where a wrong type is
 * refused — see `validateWorkspaceConfigPatch`.
 */
function readAgentSettings(kind: string, id: string, raw: unknown): AgentSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_AGENT_SETTINGS;
  const config = raw as WorkspaceAgentConfig;

  const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : null;

  let effort: string | null = null;
  if (typeof config.effort === 'string' && config.effort.trim()) {
    const candidate = config.effort.trim();
    if ((AGENT_EFFORTS as readonly string[]).includes(candidate)) effort = candidate;
    else logger.warn(`Workspace "${id}": ignoring agents.${kind}.effort "${candidate}" — not one of ${AGENT_EFFORTS.join(', ')}`);
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

  return { model, effort, timeoutMs, workflow };
}

function readAgents(id: string, config: WorkspaceConfig): WorkspaceAgents {
  const agents = config.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return { issue: NO_AGENT_SETTINGS, implement: NO_AGENT_SETTINGS };
  }
  return {
    issue: readAgentSettings('issue', id, agents.issue),
    implement: readAgentSettings('implement', id, agents.implement),
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
async function loadWorkspace(entry: RegistryEntry): Promise<Workspace | null> {
  if (!entry?.path) {
    logger.warn('Workspace entry without a path, skipping', { entry });
    return null;
  }

  const resolved = resolveWorkspacePath(entry.path, entry.distro);
  const id = entry.id?.trim() || idFromPath(resolved);

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

  let config: WorkspaceConfig;
  try {
    config = (await readJson(configPath)) as WorkspaceConfig;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const reason = err.code === 'ENOENT'
      ? `No ${WORKSPACE_CONFIG_FILENAME} at ${resolved.hostPath}`
      : `Invalid ${WORKSPACE_CONFIG_FILENAME}: ${(error as Error).message}`;
    logger.warn(`Workspace "${id}" is unusable — ${reason}`);
    return { ...base, error: reason };
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
    agents: readAgents(id, config),
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
 */
export async function loadWorkspaces(registryPath: string): Promise<Workspace[]> {
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

  const loaded = await Promise.all(registry.workspaces.map(loadWorkspace));

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
 */
export async function reorderWorkspaces(
  registryPath: string,
  ids: unknown
): Promise<WorkspaceOrderResult> {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.trim())) {
    return {
      ok: false,
      status: 400,
      error: 'The order must be an array of workspace ids, listing every registered project exactly once.',
    };
  }
  const wanted = (ids as string[]).map((id) => id.trim());

  const read = await readRegistry(registryPath);
  if (!read.ok) return read;
  const { registry, entries } = read;

  const current = await loadWorkspaces(registryPath);
  const known = current.map((workspace) => workspace.id);

  const missing = known.filter((id) => !wanted.includes(id));
  const unknown = wanted.filter((id) => !known.includes(id));
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
  for (const id of wanted) {
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
] as const;

const AGENT_KINDS = ['issue', 'implement'] as const;
const AGENT_FIELDS = ['model', 'effort', 'timeoutSeconds', 'workflow'] as const;

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
 */
export function validateWorkspaceConfigPatch(
  patch: unknown
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
        if (field === 'effort' && setting.trim()
            && !(AGENT_EFFORTS as readonly string[]).includes(setting.trim())) {
          return { ok: false, error: `"agents.${kind}.effort" must be one of ${AGENT_EFFORTS.join(', ')}.` };
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

  return { ok: true, patch };
}

/** Where a registered workspace keeps its config, and what is in it now. */
async function configFileOf(
  registryPath: string,
  id: string
): Promise<{ ok: true; workspace: Workspace; configPath: string; config: Record<string, unknown> } | WorkspaceWriteRefusal> {
  const workspaces = await loadWorkspaces(registryPath);
  const workspace = workspaces.find((candidate) => candidate.id === id);
  if (!workspace) return { ok: false, status: 404, error: `Workspace "${id}" is not registered.` };

  const configPath = resolveInWorkspace(resolveOf(workspace), WORKSPACE_CONFIG_FILENAME);
  if (!configPath) {
    return { ok: false, status: 500, error: `Could not resolve where "${id}" keeps its ${WORKSPACE_CONFIG_FILENAME}.` };
  }

  let config: Record<string, unknown> = {};
  try {
    const parsed = await readJson(configPath);
    if (!isPlainObject(parsed)) {
      return { ok: false, status: 409, error: `${configPath} is not a JSON object, so it cannot be edited from here.` };
    }
    config = parsed;
  } catch (error) {
    // A project with no config yet is being given its first one; a malformed one is left
    // alone, because overwriting it would destroy whatever the operator was in the middle
    // of writing.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        status: 409,
        error: `${configPath} could not be read (${(error as Error).message}), so it will not be overwritten from here.`,
      };
    }
  }

  return { ok: true, workspace, configPath, config };
}

/** A project's config exactly as it is on disk, for a UI that has to edit it. */
export async function readWorkspaceConfig(
  registryPath: string,
  id: string
): Promise<{ ok: true; config: Record<string, unknown> } | WorkspaceWriteRefusal> {
  const found = await configFileOf(registryPath, id);
  if (!found.ok) return found;
  return { ok: true, config: found.config };
}

/**
 * Apply one edit to a project's config, keeping everything it does not mention.
 *
 * `null` clears a field rather than storing a null, so a config stays the small readable
 * file somebody would have hand-written. Agent settings merge one level down, so setting
 * a model does not erase an effort configured beside it.
 */
export async function writeWorkspaceConfig(
  registryPath: string,
  id: string,
  patch: unknown
): Promise<WorkspaceWriteResult> {
  const valid = validateWorkspaceConfigPatch(patch);
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };

  const found = await configFileOf(registryPath, id);
  if (!found.ok) return found;

  const config = { ...found.config };
  for (const [key, value] of Object.entries(valid.patch)) {
    if (key === 'agents') {
      const agents = isPlainObject(config.agents) ? { ...config.agents } : {};
      if (value === null) {
        delete config.agents;
        continue;
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
      continue;
    }

    if (value === null || (typeof value === 'string' && !value.trim())) delete config[key];
    else config[key] = typeof value === 'string' ? value.trim() : value;
  }

  try {
    await writeJsonFile(found.configPath, config);
  } catch (error) {
    return { ok: false, status: 500, error: `Could not write ${found.configPath}: ${(error as Error).message}` };
  }

  const workspaces = await loadWorkspaces(registryPath);
  const workspace = workspaces.find((candidate) => candidate.id === id);
  if (!workspace) {
    return { ok: false, status: 500, error: `"${id}" did not load back after its config was written.` };
  }
  return { ok: true, workspace, workspaces };
}
