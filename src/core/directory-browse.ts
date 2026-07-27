/**
 * Listing directories for the project picker.
 *
 * This exists because the browser cannot do it. "I will select the project folder" has no
 * client-side implementation that yields a path: `showDirectoryPicker()` hands back a
 * `FileSystemDirectoryHandle` that deliberately exposes none — sandboxing that is the
 * point of the File System Access API, not an oversight — and `<input webkitdirectory>`
 * gives only paths relative to whatever was chosen. The registry needs an absolute path.
 *
 * So the picker runs here, on the participant that has a filesystem, behind the same
 * loopback guard as everything else on this server that touches the machine.
 */
import fs from 'fs/promises';
import path from 'path';
import { resolveWorkspacePath } from './workspace-paths.js';

export interface DirectoryEntry {
  name: string;
  /** Absolute, forward-slashed, and directly usable as a registry path. */
  path: string;
}

export interface DirectoryListing {
  /** The directory listed, or the empty string for the list of roots. */
  path: string;
  /** Where "up" goes; the empty string means the list of roots. Null at the top. */
  parent: string | null;
  entries: DirectoryEntry[];
}

const forward = (value: string): string => value.replace(/\\/g, '/');

/**
 * The roots to start from.
 *
 * On Windows that is the drive letters, because there is no single filesystem root to
 * open on and a picker that started at `C:/` would have no way to reach `D:/`.
 */
async function listRoots(): Promise<DirectoryListing> {
  if (process.platform !== 'win32') {
    return { path: '', parent: null, entries: [{ name: '/', path: '/' }] };
  }

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map(async (letter) => {
    try {
      await fs.access(`${letter}:/`);
      return { name: `${letter}:`, path: `${letter}:/` };
    } catch {
      return null;
    }
  }));

  return { path: '', parent: null, entries: found.filter((entry): entry is DirectoryEntry => entry !== null) };
}

/**
 * The directories inside one directory, or the roots when given nothing.
 *
 * Files are left out: the picker chooses a project, and a project is a directory. An
 * entry that cannot be read is skipped rather than failing the listing — one unreadable
 * system folder must not make the whole parent unbrowsable.
 */
export async function listDirectories(input?: string | null): Promise<DirectoryListing> {
  const given = typeof input === 'string' ? input.trim() : '';
  if (!given) return listRoots();

  const resolved = resolveWorkspacePath(given);
  const dirents = await fs.readdir(resolved.hostPath, { withFileTypes: true });

  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    let isDirectory = dirent.isDirectory();
    if (!isDirectory && dirent.isSymbolicLink()) {
      // A junction or symlink to a project is still a project.
      try {
        isDirectory = (await fs.stat(path.join(resolved.hostPath, dirent.name))).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (!isDirectory) continue;
    entries.push({ name: dirent.name, path: `${resolved.innerPath.replace(/\/+$/, '')}/${dirent.name}` });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // `dirname` of a drive root is itself, and of `/` is `/`; both mean "there is nowhere
  // further up", which on Windows is the drive list and on POSIX is nothing at all.
  const parentHost = forward(path.dirname(resolved.hostPath));
  const atTop = parentHost === forward(resolved.hostPath);
  const parent = atTop
    ? (process.platform === 'win32' ? '' : null)
    : forward(path.dirname(resolved.innerPath));

  return { path: resolved.innerPath, parent, entries };
}
