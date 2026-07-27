/**
 * What a shape standing for an issue looks like, and what its panel offers.
 *
 * Pure, and separate from both the server and the component, for the reason
 * `project-board-layout.ts` gives about arithmetic: appearance decided inside a React
 * component can only be checked by driving a browser, and appearance authored once in a
 * library file cannot be checked at all. Before this module, `draft`, `running`, `created`
 * and `failed` were four states with one look — because no code owned the question.
 *
 * Colours are steps on Excalidraw's own palette rather than a scheme invented here. The
 * second stage is the first stage one step darker, which is what "similar, but settled"
 * has to mean if a board is to stay readable at a glance.
 */

/** The stages an authored issue block passes through, as written in `customData.issueState`. */
export type IssueBlockState = 'draft' | 'running' | 'created' | 'failed';

export interface BlockAppearance {
  strokeColor: string;
  backgroundColor: string;
  strokeStyle: 'solid' | 'dashed';
}

/**
 * Written on the board, no issue behind it yet.
 *
 * These are the values `docs/blocks.excalidrawlib` ships, and `check-block-appearance.mjs`
 * holds the two together: a mapping that disagreed with the library would repaint every
 * block the first time anything touched it.
 */
const FIRST_STAGE: BlockAppearance = {
  strokeColor: '#f08c00',
  backgroundColor: '#fff9db',
  strokeStyle: 'dashed',
};

/** An issue exists. Same hue, one step down the ramp, and the outline closes. */
const SECOND_STAGE: BlockAppearance = {
  strokeColor: '#e67700',
  backgroundColor: '#fff3bf',
  strokeStyle: 'solid',
};

/**
 * How a block should be drawn for the state it is in.
 *
 * Only `created` is a second stage. `running` and `failed` deliberately keep the first-stage
 * look: both are blocks with no issue behind them, which is exactly what the dashed outline
 * says, and the panel already reports which of the two a block is in. Giving a failed run a
 * colour of its own would spend the board's one remaining visual distinction on the state a
 * block spends the least time in.
 */
export function issueBlockAppearance(state: IssueBlockState | string | null | undefined): BlockAppearance {
  return state === 'created' ? SECOND_STAGE : FIRST_STAGE;
}

/** A pull request GitHub says closed an issue. */
export interface ClosingPullRequest {
  number: number;
  url: string;
}

/** GitHub's own view of an issue, as far as closing it goes. */
export interface IssueClosure {
  /** `OPEN` or `CLOSED` as `gh` reports it, or null before the read lands. */
  githubState: string | null;
  /** `COMPLETED`, `NOT_PLANNED`, or null. */
  stateReason?: string | null;
  closedBy?: ClosingPullRequest[];
}

const isClosed = (githubState: string | null | undefined): boolean =>
  typeof githubState === 'string' && githubState.toUpperCase() === 'CLOSED';

/** A run as a shape or a record reports it, including "nothing known about one". */
export type PanelRunState = 'running' | 'done' | 'failed' | 'interrupted' | null;

/**
 * Whether the panel offers **Implement / Fix**.
 *
 * Two facts decide it, and until now only one was consulted. The run record says whether an
 * agent is already on it; the issue says whether there is anything left to do. A closed,
 * shipped issue was still offering to be implemented, and the panel had already read the
 * state it needed to know better.
 *
 * A `null` state is an issue not read yet, not an open one — the button stays, because a
 * control that appeared a second after every selection would read as a glitch.
 *
 * An `interrupted` run keeps it, deliberately, alongside **Resume**. Starting over on work
 * somebody else began is sometimes the right call — a previous attempt can have gone the wrong
 * way entirely — and it has to stay possible and stay a separate decision from continuing.
 */
export function offersImplement(input: {
  githubState: string | null;
  implementState: PanelRunState;
}): boolean {
  if (isClosed(input.githubState)) return false;
  return input.implementState !== 'running' && input.implementState !== 'done';
}

/**
 * Whether the panel offers **Resume**.
 *
 * Only for a run the server found interrupted, which means only for one with a checkout still
 * holding work. Everything else has nothing to continue: a `failed` run reported its own
 * failure and its worktree was released, a `done` one has its pull request, a `running` one is
 * being worked on right now, and a `null` one never started.
 *
 * Separate from `offersImplement` rather than a mode of it, because the two answer different
 * questions — "is there anything left to do" and "is there anything already done" — and a
 * single control that silently changed meaning depending on state is how somebody starts over
 * on top of work they did not know was there.
 */
export function offersResume(input: {
  githubState: string | null;
  implementState: PanelRunState;
}): boolean {
  if (isClosed(input.githubState)) return false;
  return input.implementState === 'interrupted';
}

export interface ClosureView {
  /** What GitHub reports as having closed it. Usually one, occasionally none. */
  pullRequests: ClosingPullRequest[];
  /** What to say when there is no pull request to link to. Null when there is one. */
  note: string | null;
}

/**
 * What the panel says about a closed issue, or null when it is open.
 *
 * "Closed" and "closed by a pull request" are different facts and the second is not an
 * inference: `gh` reports it, so it is asked for rather than guessed at. An issue closed
 * with no pull request is the ordinary case for one closed by hand, and one closed as not
 * planned is a decision rather than an omission — both are said plainly instead of being
 * drawn as a gap where a link should have been.
 */
export function closureView(input: IssueClosure): ClosureView | null {
  if (!isClosed(input.githubState)) return null;

  const pullRequests = (input.closedBy ?? []).filter(
    (candidate) => Boolean(candidate) && typeof candidate.url === 'string' && candidate.url.length > 0
  );
  if (pullRequests.length) return { pullRequests, note: null };

  const reason = (input.stateReason ?? '').toUpperCase();
  if (reason === 'NOT_PLANNED') return { pullRequests, note: 'Closed as not planned.' };
  return { pullRequests, note: 'Closed. No pull request is recorded as closing it.' };
}
