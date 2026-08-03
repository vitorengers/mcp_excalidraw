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
  /**
   * It gave slots back from runs that were over and never said so. Not a stall.
   *
   * Its own reason rather than a step inside another one, and reported *instead of* starting
   * anything, which costs a freed slot one interval. That is the price of the last thing #357
   * asks for: the board showed `cap-full` and went on showing it, and a reclaim folded into a
   * pass that reports `started` would leave the reader with a queue that mysteriously
   * unstuck itself. `implement-reclaim.ts` composes the sentence.
   */
  | 'reclaimed'
  /** The project has no column by the configured name, so there is nothing to drain. */
  | 'no-column'
  /** The workspace is gone, unusable, or has no GitHub project on it. */
  | 'no-project'
  /**
   * Every card it could otherwise have started is waiting on an issue still open.
   *
   * Not a stall, for the same reason `nothing-startable` is not: a card waiting on its
   * foundation is the rule working. The detail names who is waiting on what, because a
   * queue that quietly starts nothing is the whole of #263.
   */
  | 'blocked'
  /**
   * Every card it could otherwise have started is waiting on an issue that is open and already
   * holds a settled run.
   *
   * A stall, and the one case where this module disagrees with the paragraph above it.
   * `blocked` is quiet because something will eventually close the foundation; here nothing
   * will — `dispatchQueue` skips any issue the implement registry already answers for, so the
   * dependency cannot be started a second time and every card built on it waits forever. On
   * 2026-08-01 that state was reported as `blocked` for over two hours while the board drew a
   * healthy queue over seven frozen cards, which is the same silence #263 exists to end.
   */
  | 'deadlocked'
  /**
   * Every card it could have started was refused by `POST /api/implement`, and the refusal is
   * one the next pass will get again.
   *
   * A stall, and the plainest one in the register: nothing about the board changes between
   * passes, so the same oldest card is refused for ever. The refusal this exists for is the
   * `403` an account that cannot push to `origin` gets — a decision about a login and a remote,
   * which no amount of waiting alters, and which a person is the only one who can act on. A
   * `409` is deliberately *not* here: the slot is held by a run somebody asked for, so it is
   * the cap, and `cap-full` is what a queue at capacity is called.
   *
   * The detail names how many cards were refused and the first refusal's status and sentence,
   * because the sentence is the whole remedy — `pushRefusal` names the repository, the
   * permission, forking, and the `git remote set-url` that follows it.
   */
  | 'refused'
  /** The board read failed — `gh` unresolvable, an expired login, a GitHub outage. */
  | 'unreadable';

/**
 * Every member of `QueuePassReason`, keyed by itself.
 *
 * The union has no runtime representation, so "every reason is classified" is a claim nothing
 * could assert without it — a check can only iterate names it has, and a list written out in a
 * check is the same list drifting in two places. Written as a record keyed by the union rather
 * than as an array literal because that is what makes it **total**: a member added above with no
 * entry here does not compile, so the taxonomy cannot quietly grow a reason nothing knows about.
 */
const EVERY_REASON: { readonly [K in QueuePassReason]: K } = {
  'started': 'started',
  'nothing-startable': 'nothing-startable',
  'cap-full': 'cap-full',
  'reclaimed': 'reclaimed',
  'no-column': 'no-column',
  'no-project': 'no-project',
  'blocked': 'blocked',
  'deadlocked': 'deadlocked',
  'refused': 'refused',
  'unreadable': 'unreadable',
};

/** The taxonomy as a value, frozen: it is a register to read, not a list to edit. */
export const QUEUE_PASS_REASONS: readonly QueuePassReason[] =
  Object.freeze(Object.values(EVERY_REASON));

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

/**
 * Whether a reason means the queue wanted to start something and could not.
 *
 * **A deny-list, not a switch**, and `reasonAnnounces` below is one too. Anything not named
 * here stalls, and anything not named there is announced — so a reason added to the union is
 * both by default, with no edit to either function. That is deliberate: the reasons that are
 * quiet are the few that describe a queue working, and every other way a pass can end is
 * something a reader has to be told about. `refused` is the case that made it worth writing
 * down: it wants exactly the default, so it has no arm here, and an arm added for it would be
 * a line that reads like a decision while changing nothing. `QUEUE_PASS_REASONS` is what lets
 * a check assert the answers for every member rather than trusting that reading.
 */
export function reasonStalls(reason: QueuePassReason): boolean {
  return reason !== 'started' && reason !== 'nothing-startable' && reason !== 'blocked'
    && reason !== 'reclaimed';
}

/**
 * Whether a reason is worth interrupting a reader on the canvas for.
 *
 * Narrower than `reasonStalls` by exactly one, and `cap-full` is the one. **A full cap is a
 * queue at capacity, not a queue that is stuck**: every slot is held by a run doing what the
 * switch was turned on for, there is nothing for the reader to do, and it clears itself the
 * moment one of them ends. That is the same fact `nothing-startable` and `blocked` are quiet
 * about — a reason firing on every quiet pass is a reason nobody reads (#360).
 *
 * It also repeated, twice over, which is what #483 reports from a live board: the browser
 * forgets what it said whenever a pass is not a stall, so a saturated queue oscillating
 * between `cap-full` and `started` raised the box afresh per completed run; and the sentence
 * names the holders, so swapping one run for another is a new sentence and a new box even
 * with no non-stalled pass in between.
 *
 * The reason itself is not suppressed. `GET /api/implement` still answers `cap-full` naming
 * the runs holding the slots, the toggle still draws its outline broken, and the server still
 * says it once at `warn`; what stops is the interruption. The cases kept are the ones a reader
 * must act on and none of which oscillates: a column renamed on GitHub, a board that is gone,
 * a `gh` that has stopped answering, and a wait nothing will end.
 *
 * What this deliberately no longer surfaces is a cap held by a run that has wedged. That was
 * the original reason for saying it at all, and `cap-full` never could tell that case from a
 * healthy one; since #357 the dead half is `reclaimStalledRuns`' to close, on evidence, under
 * its own reason.
 */
export function reasonAnnounces(reason: QueuePassReason): boolean {
  return reasonStalls(reason) && reason !== 'cap-full';
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
 *
 * `blocked` is the fifth kind, and it arrives as an argument rather than being worked out
 * here on purpose. Whether a card's foundation has landed is a fact about issue bodies and
 * their open state — a `gh` read — and this module's whole shape is that choosing the next
 * issue is pure and instant. The caller resolves it; `dependenciesOf` below is the half that
 * can be reasoned about without a network.
 */
export function startableCards(
  cards: readonly BoardCard[],
  blocked?: ReadonlySet<number>
): BoardCard[] {
  return cards
    .filter((card) => card.contentType === 'Issue'
      && Boolean(card.url)
      && card.state !== 'CLOSED'
      && card.draggable !== false
      && !(blocked && card.number !== null && blocked.has(card.number)))
    .sort(oldestFirst);
}

/** Fenced code, which is somebody showing a declaration rather than making one. */
const FENCED = /^```[\s\S]*?^```/gm;

/**
 * A line that says nothing else: `Depends on #306.` or `Depends on #271, #272.`
 *
 * Anchored to the start of a line with **no leading whitespace**, and the line must contain
 * nothing but the declaration. That narrowness is the point. This is read off issue bodies
 * nobody wrote for a parser, and the two ways to be wrong are not symmetric: matching too
 * eagerly — a `#306` in a sentence, a link, an example — silently freezes the queue on a
 * dependency the author never declared, and there is nothing on the board that would say so.
 * Matching too little only leaves today's behaviour. So prose loses.
 */
const DECLARATION = /^depends on ((?:#\d+\s*,\s*)*#\d+)\s*\.?[ \t]*$/gim;

/**
 * The issue numbers a body declares itself built on, in the order it names them.
 *
 * A number repeated is one dependency. A body that declares nothing yields nothing, which is
 * the overwhelmingly common case and must cost nothing.
 */
export function dependenciesOf(body: string): number[] {
  if (!body) return [];
  const prose = body.replace(FENCED, '');
  const found: number[] = [];
  const seen = new Set<number>();
  for (const match of prose.matchAll(DECLARATION)) {
    for (const token of (match[1] ?? '').split(',')) {
      const number = Number(token.trim().slice(1));
      if (!Number.isInteger(number) || seen.has(number)) continue;
      seen.add(number);
      found.push(number);
    }
  }
  return found;
}
