/**
 * How long a read issue is worth reusing before asking `gh` again.
 *
 * `GET /api/issue` spawns a `gh issue view`, which costs a little over a second on the
 * machine this was reported from and rather more when the first attempt drops at connect.
 * Clicking the same card three times in a row spent three of them on text that had not
 * changed — so a short memo, per workspace and issue URL, sits in front of the read.
 *
 * Deliberately short-lived and deliberately in memory. A copy that survived a restart would
 * be the stored copy `github-issue.ts` argues against: the body is fetched at selection so
 * that an edit made on GitHub shows up without the board being touched, and a memo measured
 * in seconds keeps that true while still collapsing a burst of clicks into one process.
 */

/** In flight as well as finished, so five selections at once are one `gh`, not five. */
interface Memo<T> {
  /** Resolves to the read; rejected reads are dropped rather than remembered. */
  reading: Promise<T>;
  /** When the read finished, or null while it has not. A read in flight never expires. */
  finishedAt: number | null;
}

/**
 * Thirty seconds.
 *
 * Long enough that a reader clicking between two cards, or reselecting the one they just
 * closed, pays for one read; short enough that an issue edited on github.com in the next
 * window shows up on the board without a reload. Nothing in the repository settles this
 * number — `EXCALIDRAW_ISSUE_MEMO_MS` overrides it, and `0` turns it off entirely, which
 * leaves the server exactly as it was before this existed.
 */
export const DEFAULT_MEMO_MS = 30_000;

export function memoWindow(configured: string | undefined): number {
  if (configured === undefined || configured.trim() === '') return DEFAULT_MEMO_MS;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MEMO_MS;
}

/**
 * One issue read per workspace and URL.
 *
 * Two boards can be two checkouts of one repository, where the issue is the same but the
 * `gh` that reads it runs somewhere else — so the workspace is part of the key rather than
 * an implementation detail of the caller.
 */
export class IssueMemo<T> {
  private readonly entries = new Map<string, Memo<T>>();

  constructor(private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  private static keyOf(workspaceId: string, issueUrl: string): string {
    return `${workspaceId}\n${issueUrl}`;
  }

  /**
   * The remembered read, or a new one.
   *
   * A failure is never remembered: `gh` fails here intermittently at connect, and a memo
   * that held onto that would turn one dropped socket into thirty seconds of a broken
   * panel. It is dropped as soon as it is known, so the next selection tries again.
   */
  read(workspaceId: string, issueUrl: string, read: () => Promise<T>): Promise<T> {
    const key = IssueMemo.keyOf(workspaceId, issueUrl);
    const existing = this.entries.get(key);
    if (existing && (existing.finishedAt === null || this.now() - existing.finishedAt < this.windowMs)) {
      return existing.reading;
    }

    const entry: Memo<T> = { reading: read(), finishedAt: null };
    // Registered before it is awaited, so requests that arrive while it runs join it.
    if (this.windowMs > 0) this.entries.set(key, entry);
    entry.reading.then(
      () => { entry.finishedAt = this.now(); },
      () => { if (this.entries.get(key) === entry) this.entries.delete(key); }
    );
    return entry.reading;
  }

  /**
   * Drop what is remembered about an issue, because something just changed it.
   *
   * The two callers are the board's own writes: an observation posted from the panel, and a
   * run starting, finishing or being cleared — a run ends in a pull request, and a pull
   * request is what closes the issue.
   */
  forget(workspaceId: string, issueUrl: string): void {
    this.entries.delete(IssueMemo.keyOf(workspaceId, issueUrl));
  }
}
