/**
 * Where an implementation's state lives: against the issue, not against a shape.
 *
 * It used to live in `customData` on the element that started it, which worked for exactly
 * as long as there was one shape per issue. The project mirror broke that: a mirrored card
 * is kept out of the autosync on purpose and is redrawn from GitHub on every read, so it
 * has no id the server knows and nothing written onto it survives the next poll. A card
 * could not start an implementation, and could not show one already running.
 *
 * Keying on the issue URL is not just a way to reach a card. Whether an issue is being
 * implemented is a fact about the issue — two shapes standing for the same issue must not
 * be able to disagree about it, and one issue must not become two pull requests because it
 * was asked for twice through two shapes.
 *
 * In memory, like the element store. A run lost to a restart is what the reset is for.
 */

export type ImplementState = 'running' | 'done' | 'failed';

export interface ImplementRecord {
  state: ImplementState;
  /** The pull request, once there is one. */
  url: string | null;
  error: string | null;
}

/** One map per workspace: two projects can have issue numbers that collide. */
const byWorkspace = new Map<string, Map<string, ImplementRecord>>();

function forWorkspace(workspaceId: string): Map<string, ImplementRecord> {
  let records = byWorkspace.get(workspaceId);
  if (!records) {
    records = new Map<string, ImplementRecord>();
    byWorkspace.set(workspaceId, records);
  }
  return records;
}

export function readImplement(workspaceId: string, issueUrl: string): ImplementRecord | null {
  return forWorkspace(workspaceId).get(issueUrl) ?? null;
}

export function writeImplement(
  workspaceId: string,
  issueUrl: string,
  record: ImplementRecord
): void {
  forWorkspace(workspaceId).set(issueUrl, record);
}

export function clearImplement(workspaceId: string, issueUrl: string): void {
  forWorkspace(workspaceId).delete(issueUrl);
}

/**
 * Whether a run is in flight *in this process*.
 *
 * Nothing else can write this map, so `running` here is the live truth — unlike the copy
 * mirrored onto elements, which a browser can sync back and which therefore cannot tell a
 * live run from an abandoned one.
 */
export function isImplementing(workspaceId: string, issueUrl: string): boolean {
  return readImplement(workspaceId, issueUrl)?.state === 'running';
}
