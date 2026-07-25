/**
 * Path handling for workspaces that may live on Windows or inside WSL.
 *
 * The same project has two names. From Windows a WSL project is reachable as
 * `\\wsl.localhost\Ubuntu-22.04\home\me\proj`; from inside WSL it is `/home/me/proj`.
 * Registering both forms would create two workspaces for one project, so every path
 * is reduced to a single canonical shape before anything compares them.
 */
import path from 'path';

export type WorkspaceEnvironment =
  | { kind: 'native' }
  | { kind: 'wsl'; distro: string };

export interface ResolvedPath {
  /** The path as given, only cleaned up. */
  input: string;
  /** Comparable form — lower-cased, forward slashes, no trailing separator. */
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
  const canonical = stripTrailingSeparator(toForwardSlashes(absolute)).toLowerCase();
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
