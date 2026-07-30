/**
 * Whether a board starts the next Todo issue by itself, and which issue that is.
 *
 * The cap refuses rather than defers: `POST /api/implement` answers `409` once a workspace
 * already has `EXCALIDRAW_IMPLEMENT_CONCURRENCY` runs in flight, naming the runs holding the
 * slots. That is the right answer to a *click* — somebody is there to read it — and the wrong
 * one to a backlog, because coming back later is a person watching the board. The queue is
 * the deferral: on, and every slot that frees is filled with the oldest issue in Todo.
 *
 * **In memory, and off after a restart.** The same decision `implement-state.ts` makes, for a
 * stronger reason: this switch spawns coding agents against a repository. A server that came
 * back up and quietly resumed starting runs would be doing that with nobody present, and the
 * thing that survived the restart would be a decision made before whatever caused it. Turning
 * it on is one click.
 *
 * **Per workspace**, like the cap and the implement registry — two boards on one server drain
 * their own projects or neither.
 *
 * Nothing here dispatches. The state and the choice of "which issue next" are pure and live
 * beside each other so both can be checked without a server; `dispatchQueue` in `server.ts` is
 * what turns the answer into a run, because starting one means the claim guard, the worktree
 * and the agent command, none of which belong in a decision this small.
 */
import { BoardCard, oldestFirst } from './project-board.js';

/** The workspaces whose queue is on. Empty at startup, which is the whole of "off by default". */
const enabled = new Set<string>();

export function queueEnabled(workspaceId: string): boolean {
  return enabled.has(workspaceId);
}

export function setQueueEnabled(workspaceId: string, on: boolean): void {
  if (on) enabled.add(workspaceId);
  else enabled.delete(workspaceId);
  // Whichever way it was flipped, whatever the last pass ran into belongs to the queue that
  // was on before it. A switch that came back on carrying "the cap was full" would be
  // describing a state nobody has looked at since, and a switch that is off is not stalled —
  // it is off, which the toggle already says.
  passes.delete(workspaceId);
}

/**
 * Why the last pass over a workspace started nothing.
 *
 * A queue that is on and cannot start anything looked exactly like a queue that is on and
 * idle — from the board, from the console and from the API — and the difference is the whole
 * of #263. `dispatchQueue` gives up in six places and five of them are silent; a pass whose
 * every exit is recorded is one a reader can ask about.
 *
 * Kept beside the switch rather than in `server.ts` because it is the same kind of fact: a
 * per-workspace scrap of memory about a queue, of no use to anything that is not looking at
 * one, and gone when the process is.
 */
export type QueuePassReason =
  /** It started at least one run. Not a stall. */
  | 'started'
  /** The column held nothing this queue may start. On and idle, which is a healthy state. */
  | 'nothing-startable'
  /** Every slot is taken. The detail names the runs holding them. */
  | 'cap-full'
  /** The project has no column by the configured name, so there is nothing to drain. */
  | 'no-column'
  /** The workspace is gone, unusable, or has no GitHub project on it. */
  | 'no-project'
  /** The board read failed — `gh` unresolvable, an expired login, a GitHub outage. */
  | 'unreadable';

export interface QueuePass {
  reason: QueuePassReason;
  /** A sentence a reader can act on, naming whatever the reason has to name. */
  detail: string;
  /** When the pass ended, ISO. */
  at: string;
  /** How many runs it started. */
  started: number;
  /**
   * Whether this is a queue that wanted to start something and could not.
   *
   * `nothing-startable` is deliberately not a stall: an empty column is the normal resting
   * state of a drained board, and a board that shouted about it would be shouting always.
   */
  stalled: boolean;
}

const passes = new Map<string, QueuePass>();

/** Whether a reason means the queue wanted to start something and could not. */
export function reasonStalls(reason: QueuePassReason): boolean {
  return reason !== 'started' && reason !== 'nothing-startable';
}

export function recordQueuePass(
  workspaceId: string,
  pass: Omit<QueuePass, 'stalled'>
): QueuePass {
  const recorded: QueuePass = { ...pass, stalled: reasonStalls(pass.reason) };
  passes.set(workspaceId, recorded);
  return recorded;
}

export function lastQueuePass(workspaceId: string): QueuePass | null {
  return passes.get(workspaceId) ?? null;
}

/**
 * Every workspace currently draining.
 *
 * What the timer walks. It is also what says whether the timer should exist at all: a server
 * where nobody has turned the queue on must not be spawning a `gh` process on an interval,
 * which is the cost the browser's own poll already refuses to pay for a hidden tab.
 */
export function queuedWorkspaces(): string[] {
  return [...enabled];
}

/**
 * The cards in a column the queue may start, oldest first.
 *
 * Four kinds of card are passed over, and each of them would otherwise be a run nobody asked
 * for:
 *
 *  - **anything that is not an issue.** A draft item has no issue to implement and a pull
 *    request is the output of a run, not its input.
 *  - **a closed issue.** The block does not offer the button on one either — the work is over,
 *    and an agent sent at it would open a pull request against a settled decision.
 *  - **a card from another repository.** A project may hold them; this board has one checkout,
 *    and it is not that issue's. `draggable` is the flag that already carries "this board's to
 *    act on", set from the workspace's own `repo`.
 *  - **anything with no URL**, which is what the two above are addressed by.
 *
 * What is *not* filtered here is whether a run already happened: that is the implement
 * registry's answer rather than the board's, and it is the caller's to ask, one card at a
 * time, so the count it is working against stays live while it starts them.
 */
export function startableCards(cards: readonly BoardCard[]): BoardCard[] {
  return cards
    .filter((card) => card.contentType === 'Issue'
      && Boolean(card.url)
      && card.state !== 'CLOSED'
      && card.draggable !== false)
    .sort(oldestFirst);
}
