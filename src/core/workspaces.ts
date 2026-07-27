/**
 * Workspace registry.
 *
 * A registry file lists projects; each project then describes its own board settings
 * in a `board.config.json` at its root, the way it already carries a package manifest.
 * Settings therefore travel with the project instead of accumulating in one machine's
 * global config.
 */
import fs from 'fs/promises';
import logger from '../utils/logger.js';
import {
  resolveWorkspacePath,
  resolveInWorkspace,
  ResolvedPath,
  WorkspaceEnvironment,
} from './workspace-paths.js';

/**
 * Effort levels the agent CLI accepts, as `claude --help` states them.
 *
 * Kept as a list rather than a free string because a typo here is only discovered when a
 * run fails minutes later, in a process nobody is watching.
 */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

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
}

export interface WorkspaceAgents {
  issue: AgentSettings;
  implement: AgentSettings;
}

export interface WorkspaceConfig {
  name?: string;
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
   * Unset, the option named `In Progress` is used — the same reliance on GitHub's own
   * defaults the `+` already makes on the first column. A board that renamed it says so
   * here; a board that has no such column gets no move rather than a guess.
   */
  projectInProgressColumn?: string;
  /**
   * Column an issue is moved to when the run that researched it finishes.
   *
   * Unset, the option named `Todo` is used. The first column is where a hand-written block
   * is drafted, and it is where GitHub's *Item added to project* workflow leaves the issue
   * the agent creates — so without this move the two populations share one column and only a
   * person can tell them apart. A board that has no such column gets no move rather than a
   * guess.
   */
  projectTodoColumn?: string;
  /** Per-project model, effort and ceiling for each agent. See WorkspaceAgentConfig. */
  agents?: WorkspaceAgentsConfig;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  innerPath: string;
  environment: WorkspaceEnvironment;
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
 */
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await fs.rename(temporary, filePath);
}

const NO_AGENT_SETTINGS: AgentSettings = { model: null, effort: null, timeoutMs: null };

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

  return { model, effort, timeoutMs };
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

/**
 * Read the registry and resolve every workspace in it.
 *
 * Returns an empty list when no registry is configured — multi-project support stays
 * dormant rather than inventing a default project.
 */
export async function loadWorkspaces(registryPath: string | undefined): Promise<Workspace[]> {
  if (!registryPath) return [];

  let registry: { workspaces?: RegistryEntry[] };
  try {
    registry = (await readJson(registryPath)) as { workspaces?: RegistryEntry[] };
  } catch (error) {
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

const NO_REGISTRY: WorkspaceWriteRefusal = {
  ok: false,
  status: 503,
  error: 'No workspace registry is configured, so there is nowhere to record a project. '
    + 'Point EXCALIDRAW_WORKSPACES at a registry file and restart the board.',
};

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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, registry: { workspaces: [] }, entries: [] };
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
 * A minimal config for a project that has none.
 *
 * Without it a brand new tab arrives already marked broken — `No board.config.json at …`
 * is exactly what `loadWorkspace` says about a project it cannot read — which is a poor
 * greeting for a project the user has just chosen. Best-effort: a project directory that
 * refuses the write is still worth registering, and it will simply show that error.
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
  try {
    await writeJsonFile(configPath, { name });
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
  registryPath: string | undefined,
  request: NewWorkspace
): Promise<WorkspaceWriteResult> {
  if (!registryPath) return NO_REGISTRY;

  const given = typeof request?.path === 'string' ? request.path.trim() : '';
  if (!given) return { ok: false, status: 400, error: 'A project needs a path.' };

  const distro = typeof request.distro === 'string' && request.distro.trim()
    ? request.distro.trim()
    : undefined;
  const resolved = resolveWorkspacePath(given, distro);

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

/** Fields a project's config may carry that are plain strings. */
const STRING_FIELDS = [
  'name', 'docsDir', 'board', 'library', 'repo',
  'githubProject', 'projectField', 'projectInProgressColumn', 'projectTodoColumn',
] as const;

const AGENT_KINDS = ['issue', 'implement'] as const;
const AGENT_FIELDS = ['model', 'effort', 'timeoutSeconds'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
      }
    }
  }

  return { ok: true, patch };
}

/** Where a registered workspace keeps its config, and what is in it now. */
async function configFileOf(
  registryPath: string | undefined,
  id: string
): Promise<{ ok: true; workspace: Workspace; configPath: string; config: Record<string, unknown> } | WorkspaceWriteRefusal> {
  if (!registryPath) return NO_REGISTRY;

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
  registryPath: string | undefined,
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
  registryPath: string | undefined,
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
