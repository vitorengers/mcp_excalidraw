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
  /**
   * The checkout this run is happening in, and afterwards the one it left behind.
   *
   * A worktree with nothing uncommitted in it is removed when the run ends, so this goes
   * back to null. A worktree that still holds work is kept — it is the only copy of that
   * work — and then this is the only thing that says where it is.
   */
  worktree: string | null;
  /**
   * When the run started, ISO.
   *
   * One number rather than a duration, and written once rather than ticked. A duration
   * kept here would have to be refreshed to stay true, and refreshing it means a write per
   * second per running block — every one of them bumping an element's `version` and
   * churning every export. An instant is true for as long as the run lasts, and whoever is
   * looking at it can subtract.
   */
  startedAt: string | null;
  /** When it settled, ISO. Null while it is still going, which is what makes it live. */
  endedAt: string | null;
  /**
   * What the run has spent, when the agent is willing to say.
   *
   * Null is the normal case and not a failure: it means the configured command does not
   * ask its agent for a machine-readable stream, so nothing observable about tokens ever
   * reaches this process. See `agent-usage.ts`.
   */
  usage: ImplementUsage | null;
}

/** Cumulative token counts for a run, as the agent reported them. */
export interface ImplementUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A record with the issue it belongs to, which the map holds as a key rather than a field. */
export interface ImplementEntry extends ImplementRecord {
  issueUrl: string;
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
 * Every implementation this workspace knows about.
 *
 * "What is running right now" is the question parallel runs create, and until this existed
 * nothing could answer it: the state was reachable only one issue URL at a time, by a
 * caller who already knew which URL to ask about. Finished runs are listed too — a caller
 * that wants only the live ones filters on `state`, and one that wants to know what a run
 * left behind needs the finished ones.
 */
export function listImplement(workspaceId: string): ImplementEntry[] {
  return [...forWorkspace(workspaceId)].map(([issueUrl, record]) => ({ issueUrl, ...record }));
}

/** The runs in flight *in this process*, which is what a cap counts. */
export function runningImplements(workspaceId: string): ImplementEntry[] {
  return listImplement(workspaceId).filter((entry) => entry.state === 'running');
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
