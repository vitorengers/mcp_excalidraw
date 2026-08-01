/**
 * Path handling for workspaces that may live on Windows or inside WSL.
 *
 * The same project has two names. From Windows a WSL project is reachable as
 * `\\wsl.localhost\Ubuntu-22.04\home\me\proj`; from inside WSL it is `/home/me/proj`.
 * Registering both forms would create two workspaces for one project, so every path
 * is reduced to a single canonical shape before anything compares them.
 */
import path from 'path';

// Declared in a module of its own, and re-exported here so that every caller that had it from
// this file still does. The reason it moved is written down where it went: this module imports
// `path` and reads `process`, and the frontend's type check compiles `agent-adapter.ts`, which
// has to be able to name it.
import type { WorkspaceEnvironment } from './workspace-environment.js';
export type { WorkspaceEnvironment };

/**
 * Why a WSL-backed project cannot be used on this machine, or null when it can.
 *
 * `wsl` is a Windows environment and nothing else: every command built for one is
 * `wsl.exe` with a distro after it — `buildAgentCommand`, the worktree's own `git`, the
 * `gh` the project board mirror polls with. Off Windows there is no such binary, so a
 * board that resolved a `wsl` workspace anyway answered `spawn wsl.exe ENOENT` to every
 * one of them, naming a program the reader has never heard of and never installed.
 *
 * The platform is a parameter with a default rather than a read of `process.platform`
 * inside the caller, so a check can ask what a mac would be told without being a mac.
 *
 * If a remote or container backend is ever wanted for mac and Linux, it is a new
 * `WorkspaceEnvironment` kind — `{ kind: 'ssh' }`, `{ kind: 'container' }` — with a
 * command builder of its own, not `wsl` renamed. The three share the shape and share
 * neither the path translation nor the `--exec bash -lc` quoting.
 */
export function wslUnsupportedHere(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null;
  return `WSL-backed projects are Windows-only; this board is running on ${platform}`;
}

export interface ResolvedPath {
  /** The path as given, only cleaned up. */
  input: string;
  /**
   * Comparable form — forward slashes, no trailing separator, and lower-cased only where
   * two spellings really are one directory. See `foldPathCase`.
   */
  canonical: string;
  /** Path usable by this process to read files. */
  hostPath: string;
  /** Path as seen from inside the workspace's own environment. */
  innerPath: string;
  environment: WorkspaceEnvironment;
}

/** `\\wsl.localhost\<distro>\rest` and the older `\\wsl$\<distro>\rest`. */
const WSL_UNC = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)[\\/]?(.*)$/i;

function stripTrailingSeparator(value: string): string {
  // Keep a lone separator or a bare drive root: "C:/" is a path, "C:" is ambiguous.
  if (value.length <= 1) return value;
  if (/^[A-Za-z]:\/$/.test(value)) return value;
  return value.replace(/[\\/]+$/, '');
}

function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Fold a native path's case, but only on a platform whose filesystem does.
 *
 * The canonical form is a project's identity — `loadWorkspaces` dedupes on it and
 * `addWorkspace` refuses a duplicate on it — so folding case decides whether two directories
 * are one project. On Windows they are. On Linux `/home/me/Board` and `/home/me/board` are two
 * directories, and folding made registering the second answer a 409 saying two spellings of one
 * path are one project, while a registry that already held both silently dropped one.
 *
 * macOS is treated as Linux. Its default APFS volume is case-insensitive, so folding would
 * usually be harmless there, but a case-sensitive volume behaves exactly like Linux — and which
 * of the two a path sits on is not knowable from the path string. A rule keyed on the
 * filesystem is not one this can implement from a string, so only the platform that is always
 * case-insensitive folds.
 *
 * `wsl:` canonical forms fold regardless of this, and deliberately: WSL is reachable only from
 * Windows, and the distro name there really is case-insensitive.
 */
export function foldPathCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Resolve a workspace path into every form we need.
 *
 * `distroHint` names the distro for a POSIX path that is known to be WSL-backed —
 * from inside WSL a path looks identical to a native Linux one, so it cannot be
 * detected, only declared.
 */
export function resolveWorkspacePath(input: string, distroHint?: string): ResolvedPath {
  const trimmed = stripTrailingSeparator(input.trim());

  const uncMatch = trimmed.match(WSL_UNC);
  if (uncMatch) {
    const distro = uncMatch[1] ?? '';
    const rest = toForwardSlashes(uncMatch[2] ?? '');
    const innerPath = `/${rest}`.replace(/\/+/g, '/');
    const hostPath = stripTrailingSeparator(`\\\\wsl.localhost\\${distro}\\${rest.replace(/\//g, '\\')}`);
    return {
      input: trimmed,
      // Canonical form is keyed on distro + inner path, so the UNC and POSIX
      // spellings of one project collapse onto the same key.
      canonical: `wsl:${distro.toLowerCase()}:${innerPath.toLowerCase()}`,
      hostPath,
      innerPath,
      environment: { kind: 'wsl', distro },
    };
  }

  const isPosix = trimmed.startsWith('/');
  if (isPosix && distroHint) {
    const innerPath = stripTrailingSeparator(toForwardSlashes(trimmed));
    return {
      input: trimmed,
      canonical: `wsl:${distroHint.toLowerCase()}:${innerPath.toLowerCase()}`,
      // Reading the files still happens from this process, which on Windows means
      // going through the UNC share.
      hostPath: process.platform === 'win32'
        ? stripTrailingSeparator(`\\\\wsl.localhost\\${distroHint}${innerPath.replace(/\//g, '\\')}`)
        : innerPath,
      innerPath,
      environment: { kind: 'wsl', distro: distroHint },
    };
  }

  const absolute = path.resolve(trimmed);
  const canonical = foldPathCase(stripTrailingSeparator(toForwardSlashes(absolute)));
  return {
    input: trimmed,
    canonical: `native:${canonical}`,
    hostPath: absolute,
    innerPath: toForwardSlashes(absolute),
    environment: { kind: 'native' },
  };
}

/** True when both spellings point at the same project. */
export function isSameWorkspace(a: string, b: string, distroHint?: string): boolean {
  return resolveWorkspacePath(a, distroHint).canonical === resolveWorkspacePath(b, distroHint).canonical;
}

/**
 * Join a project-relative path (`docs/decisoes`) onto a resolved workspace.
 *
 * Returns null when the relative path escapes the workspace: these come from a config
 * file, and a config that reaches outside its own project is a mistake worth surfacing
 * rather than quietly honouring.
 */
export function resolveInWorkspace(workspace: ResolvedPath, relative: string): string | null {
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return null;

  const normalized = toForwardSlashes(relative).replace(/^\/+/, '');
  if (normalized.split('/').includes('..')) return null;

  const hostSeparator = workspace.hostPath.includes('\\') ? '\\' : '/';
  const joined = `${workspace.hostPath}${hostSeparator}${normalized.replace(/\//g, hostSeparator)}`;
  return stripTrailingSeparator(joined);
}
