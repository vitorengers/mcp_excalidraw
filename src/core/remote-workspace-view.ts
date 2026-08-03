/**
 * DRAFT — the shape this issue exists to refuse, kept only long enough to run the check
 * against it. A projection built by spreading the workspace and deleting the keys somebody
 * happened to think of.
 */

import type { Workspace } from './workspaces.js';

export function projectWorkspaceForPeer(workspace: Workspace): Record<string, unknown> {
  const view: Record<string, unknown> = { ...workspace };
  delete view.path;
  delete view.innerPath;
  delete view.docsDir;
  return view;
}
