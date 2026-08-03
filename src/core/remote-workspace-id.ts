/**
 * DRAFT — the obvious first spelling, kept only long enough to prove the check red.
 *
 * A peer's board is named `<peer>:<workspace>`, the way a namespace usually is. It round-trips
 * perfectly: everything minted here splits back to exactly the pair it was made from.
 */

/** The character class a workspace id has to stay inside. */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface RemoteWorkspacePair {
  peerId: string;
  workspaceId: string;
}

export type RemoteWorkspaceIdMint =
  | { ok: true; id: string }
  | { ok: false; refusal: string };

export function mintRemoteWorkspaceId(peerId: string, workspaceId: string): RemoteWorkspaceIdMint {
  if (typeof peerId !== 'string' || !ID.test(peerId)) {
    return { ok: false, refusal: `"${String(peerId)}" is not a peer id.` };
  }
  if (typeof workspaceId !== 'string' || !ID.test(workspaceId)) {
    return { ok: false, refusal: `"${String(workspaceId)}" is not a workspace id.` };
  }
  return { ok: true, id: `${peerId}:${workspaceId}` };
}

export function splitRemoteWorkspaceId(id: string): RemoteWorkspacePair | null {
  if (typeof id !== 'string') return null;
  const at = id.indexOf(':');
  if (at < 0) return null;
  return { peerId: id.slice(0, at), workspaceId: id.slice(at + 1) };
}

export function isRemoteWorkspaceId(id: string): boolean {
  return splitRemoteWorkspaceId(id) !== null;
}
