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
    error: escaped.length
      ? `Config field(s) outside the workspace, ignored: ${escaped.join(', ')}`
      : null,
  };
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
    const key = resolveWorkspacePath(workspace.innerPath,
      workspace.environment.kind === 'wsl' ? workspace.environment.distro : undefined).canonical;
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
