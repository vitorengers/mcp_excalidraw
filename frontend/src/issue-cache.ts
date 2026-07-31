/**
 * What the panel already knows about an issue, kept somewhere the panel cannot lose.
 *
 * The card is unmounted the moment nothing is selected — `AnchoredDocsPanel` returns null
 * when there is nothing to show — so everything the panel had read died with it, and the
 * next click on the same block started again from *"Reading the issue…"* and from a
 * `githubState` of null, which is what put **Implement / Fix** on closed and already-running
 * issues for a second at a time.
 *
 * Module level rather than component state, for exactly that reason: this has to outlive
 * every mount of the panel, and it is not something to render from — a component that
 * re-rendered because a cache entry changed would be a different design with different bugs.
 *
 * **In memory only, and never on the element.** A copy written into `customData` would ride
 * in every autosync payload and every export, and would go stale the moment anyone edited
 * the issue on GitHub — which is precisely why the body is read at selection in the first
 * place. So this is remembered for the length of a session and revalidated on every
 * selection: what it buys is the frame, not the freshness.
 */

import type { IssueData } from './components/DocsPanel'

/**
 * What is known about implementing the issue, as the server last reported it.
 *
 * `PanelRunState` rather than a fourth hand-written copy of the same strings. This one had
 * silently fallen a state behind — `interrupted` never made it here — and nothing caught it:
 * `frontend/` is not type-checked by `tsc` and `vite build` only strips types, so a remembered
 * run in a state this union did not list came back on the next selection as something else.
 */
import type { PanelRunState } from '../../src/core/issue-appearance'

export interface CachedImplement {
  state: PanelRunState
  url: string | null
  error: string | null
}

/** One `GET /api/issue` answer, as the panel would render it. */
export interface CachedIssue {
  issue: IssueData
  implement: CachedImplement
}

/**
 * How many issues to keep.
 *
 * A board is tens of issues and an issue body is kilobytes, so this is not a memory
 * problem — but a map that only ever grows is a memory problem eventually, and a session
 * on this board is measured in days. The oldest entry goes; on a board this size that is a
 * bound rather than a policy anyone will notice.
 */
const REMEMBERED = 100

/**
 * Keyed by workspace as well as URL.
 *
 * Two boards can be two checkouts of one repository: the issue is the same, but the
 * implement record that rides with it belongs to one project and not the other.
 */
const keyOf = (workspace: string, issueUrl: string): string => `${workspace}\n${issueUrl}`

const remembered = new Map<string, CachedIssue>()

export function recallIssue(workspace: string, issueUrl: string): CachedIssue | null {
  return remembered.get(keyOf(workspace, issueUrl)) ?? null
}

export function rememberIssue(workspace: string, issueUrl: string, value: CachedIssue): void {
  const key = keyOf(workspace, issueUrl)
  // Deleted first so a re-read moves to the end of the insertion order, and the entry that
  // falls off is the one nobody has looked at for longest.
  remembered.delete(key)
  remembered.set(key, value)
  while (remembered.size > REMEMBERED) {
    const oldest = remembered.keys().next()
    if (oldest.done) break
    remembered.delete(oldest.value)
  }
}

/**
 * Forget an issue, because something just rewrote it.
 *
 * The one caller is a recreate landing. Everything else this cache holds goes stale the
 * ordinary way — a revalidation on the next selection replaces it — but a rewritten body is a
 * change the panel *caused*, and the copy it is holding is of the issue the run replaced.
 * Selecting the card straight afterwards has to show the new one, and stale-while-revalidate
 * would paint the old body first.
 */
export function forgetIssue(workspace: string, issueUrl: string): void {
  remembered.delete(keyOf(workspace, issueUrl))
}

/**
 * Patch what is remembered about the run, leaving the issue alone.
 *
 * The panel starts a run itself, and an optimistic **running** that the cache did not hear
 * about would be undone by the next selection painting the record from before the click.
 * Does nothing when the issue was never read: there is no body to attach it to, and the
 * next selection will read one.
 */
export function rememberImplement(
  workspace: string,
  issueUrl: string,
  implement: CachedImplement
): void {
  const existing = recallIssue(workspace, issueUrl)
  if (!existing) return
  rememberIssue(workspace, issueUrl, { ...existing, implement })
}
