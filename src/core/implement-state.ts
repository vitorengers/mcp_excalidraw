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
 * In memory, like the element store — and that is why `interrupted` exists. A restart empties
 * this map, so a run killed with its server used to come back as nothing at all: the board
 * showed a card in **In Progress** and the server answered `0 runs recorded`, while the work
 * sat on disk held by nobody. The map is not the thing that survives; the worktree is. What
 * comes back at startup is read off git and written here, so the run that was lost is at least
 * a run the process knows about.
 */

/**
 * `interrupted` is the state no run ever writes for itself.
 *
 * The others are transitions this process made: it started a run, and the run settled one
 * way or the other. `interrupted` is an inference made at startup about a run this process
 * never saw — a checkout named after an issue with commits the base does not have, or a dirty
 * tree, and no agent anywhere working in it. A run cannot survive the process that spawned it,
 * so anything found in that shape is over, whatever it looked like when it stopped.
 *
 * `blocked` is the run that ended correctly without landing anything. The implement prompt
 * sanctions exactly one way to do that — leave the pull request open, say what could not be
 * reconciled, and stop for a person — and until this existed that agent was recorded
 * identically to one that walked away mid-sentence. It is neither a success nor a failure, and
 * naming it is what stops the next thing that reads this signal from sending a second agent to
 * force a merge the first one refused on purpose. See `implement-landing.ts`.
 */
export type ImplementState = 'running' | 'done' | 'failed' | 'interrupted' | 'blocked';

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
  /**
   * The terminal session the run is being shown in, or null when it had no tab.
   *
   * Null is not a failure and is the ordinary answer on most boards: `EXCALIDRAW_TERMINAL`
   * is a separate opt-in from `EXCALIDRAW_IMPLEMENT_AGENT`, and a board whose session cap
   * is already full gives its next run no tab either. A run without one is the run this
   * board did before it had a terminal at all — so this records *where the run went*, and
   * never whether it may go.
   */
  terminal: string | null;
  /**
   * Whether this run has already spent its one automatic recovery.
   *
   * The bound, and it lives on the record rather than in a local variable because the record is
   * what survives everything that rebuilds it — `carriedImplement` carries it the way it carries
   * the start time, so a second attempt cannot be granted twice by a code path that forgot.
   *
   * `dispatchQueue` states the opposite rule on purpose, and it is there to stop a broken build
   * being retried forever: *"the queue tries each issue once"*. An automatic recovery is a
   * second attempt by another name, so this is what reconciles the two — one, ever, recorded
   * against the run so that whoever reads the board is told a run already failed once rather
   * than a clean story about a first attempt.
   */
  recovered: boolean;
}

/** Cumulative token counts for a run, as the agent reported them. */
export interface ImplementUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * The reasoning share of `outputTokens`, or null when the agent never broke it down.
   *
   * Inside the output figure rather than beside it — reasoning is billed as output — so the
   * two must not be added together anywhere. See `agent-usage.ts`.
   */
  thinkingTokens: number | null;
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
 * How many runs are in flight anywhere in this process, across every workspace.
 *
 * The cap counts per workspace, because that is the thing being capped. This counts across all
 * of them, because the thing it answers for is the *process*: `restart` ends the server, and
 * with it every coding agent the server is hosting, whichever board asked for it. A caller with
 * no workspace to ask about — the CLI has none, `docs/cli.md` says so — could otherwise only
 * ever be told about `default`, and a registered project's runs are not in that one.
 */
export function runningImplementCount(): number {
  let running = 0;
  for (const records of byWorkspace.values()) {
    for (const record of records.values()) {
      if (record.state === 'running') running++;
    }
  }
  return running;
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
