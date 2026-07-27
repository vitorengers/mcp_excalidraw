/**
 * Reference images for an issue block, put where the agent can read them.
 *
 * An observation reaches the agent as one string on stdin, and there is no second channel:
 * a dataURL pasted into that string would be megabytes of base64 the agent cannot decode.
 * What the agent does have is `Read`, which renders an image. So the images are written to
 * disk before the run, the prompt names the paths, and the files are removed afterwards.
 *
 * They are written **inside the project** rather than into a temp directory, for two
 * reasons. A WSL-backed project runs through `wsl.exe`, and a Windows temp path has no
 * spelling that distro can open — but the project itself has one, `innerPath`, which is
 * exactly the translation this file uses. And a file under the working directory is one
 * the agent is unambiguously allowed to read; in `-p` mode a refused tool call is silent,
 * so a path outside the project would fail as an agent that simply ignored the images.
 *
 * The directory is transient by construction: it exists only while a run does, and the
 * caller removes it on the failure path as well as the success one.
 */
import fs from 'fs/promises';
import logger from '../utils/logger.js';
import { ExcalidrawFile } from '../types.js';
import { Workspace } from './workspaces.js';

/** Where a run's images live, relative to the project root. */
export const ISSUE_IMAGE_DIR = '.excalidraw-issue-images';

export interface MaterializedImages {
  /** Paths spelled the way the agent's own environment spells them. */
  paths: string[];
  /** Attached ids that had no image behind them, and were skipped. */
  skipped: string[];
  /** Removes everything this wrote. Safe to call when nothing was written. */
  cleanup: () => Promise<void>;
}

/** Nothing attached, nothing to clean up. */
export const NO_IMAGES: MaterializedImages = {
  paths: [],
  skipped: [],
  cleanup: async () => { /* nothing was written */ },
};

/**
 * File extension per mime type.
 *
 * The name matters because the agent decides how to read a file by its extension; an
 * image written as `.bin` is a file it will not look at.
 */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

/** The bytes behind a dataURL, or null when it is not one that carries any. */
export function decodeDataUrl(dataURL: unknown): { data: Buffer; mimeType: string } | null {
  if (typeof dataURL !== 'string') return null;

  const match = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(dataURL);
  if (!match) return null;

  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = /;base64/i.test(match[2] ?? '');
  const payload = match[3] ?? '';

  let data: Buffer;
  try {
    data = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return null;
  }
  return data.length ? { data, mimeType } : null;
}

/** The ids a block has attached. Anything that is not a list of ids reads as none. */
export function issueImageIds(customData: unknown): string[] {
  const value = (customData as Record<string, unknown> | null | undefined)?.issueImages;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

/** A directory name that cannot escape the project or surprise a filesystem. */
function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'run';
}

/**
 * Write the attached images into the project and return the paths the agent will see.
 *
 * A file that is missing, unreadable or not a dataURL is skipped rather than fatal: the
 * observation is still worth investigating, and losing the whole run to one dead
 * reference would cost the user the investigation over an image.
 */
export async function materializeIssueImages(
  workspace: Workspace,
  fileIds: readonly string[],
  lookup: (fileId: string) => ExcalidrawFile | undefined,
  runKey: string
): Promise<MaterializedImages> {
  if (!fileIds.length) return NO_IMAGES;

  const separator = workspace.path.includes('\\') ? '\\' : '/';
  const parentHostDir = `${workspace.path}${separator}${ISSUE_IMAGE_DIR}`;
  const hostDir = `${parentHostDir}${separator}${safeSegment(runKey)}`;
  const innerDir = `${workspace.innerPath}/${ISSUE_IMAGE_DIR}/${safeSegment(runKey)}`;

  const cleanup = async (): Promise<void> => {
    try {
      await fs.rm(hostDir, { recursive: true, force: true });
      // Leave nothing behind in the project: the parent goes too, unless another run
      // is using it, in which case removing a non-empty directory simply fails.
      await fs.rmdir(parentHostDir).catch(() => undefined);
    } catch (error) {
      logger.warn(`Could not remove issue images at ${hostDir}: ${(error as Error).message}`);
    }
  };

  await fs.mkdir(hostDir, { recursive: true });

  const paths: string[] = [];
  const skipped: string[] = [];

  for (const fileId of fileIds) {
    const file = lookup(fileId);
    const decoded = decodeDataUrl(file?.dataURL);
    if (!decoded) {
      skipped.push(fileId);
      continue;
    }

    const mimeType = file?.mimeType || decoded.mimeType;
    const extension = EXTENSIONS[mimeType.toLowerCase()] ?? 'png';
    const name = `image-${paths.length + 1}.${extension}`;

    try {
      await fs.writeFile(`${hostDir}${separator}${name}`, decoded.data);
      paths.push(`${innerDir}/${name}`);
    } catch (error) {
      logger.warn(`Could not write reference image ${fileId}: ${(error as Error).message}`);
      skipped.push(fileId);
    }
  }

  if (skipped.length) {
    logger.warn(`Issue images skipped, no bytes behind them: ${skipped.join(', ')}`);
  }
  if (!paths.length) {
    // Nothing was written, so the directory would only be litter.
    await cleanup();
    return { paths: [], skipped, cleanup: async () => { /* already removed */ } };
  }

  return { paths, skipped, cleanup };
}
