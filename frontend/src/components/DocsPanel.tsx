import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { closureView, offersImplement } from '../../../src/core/issue-appearance'
import type { ClosingPullRequest } from '../../../src/core/issue-appearance'
import { clipboardImages, isWritableTarget, panelTakesPaste } from '../../../src/core/pasted-images'
import { recallIssue, rememberImplement, rememberIssue } from '../issue-cache'
import './DocsPanel.css'

type DocState =
  | { status: 'empty' }
  | { status: 'loading'; key: string }
  | { status: 'loaded'; key: string; html: string }
  | { status: 'missing'; key: string }
  | { status: 'error'; key: string; message: string }

export interface IssueTarget {
  id: string
  state: 'draft' | 'running' | 'created' | 'failed'
  issueUrl?: string | null
  issueError?: string | null
  /** Kept on the element so the card reads correctly with nothing selected. */
  issueTitle?: string | null
  /** The text that produced the issue, preserved when the label was retitled. */
  observation?: string | null
  /** Files attached as reference material for the run, by id in the server's file store. */
  images?: string[]
  /** Set once an agent has been asked to implement the issue. */
  implementState?: 'running' | 'done' | 'failed' | null
  implementUrl?: string | null
  implementError?: string | null
  /**
   * When the run started and stopped, ISO. Kept on the element for the same reason the
   * title is: a block has to read correctly with nothing selected and no network.
   */
  implementStartedAt?: string | null
  implementEndedAt?: string | null
}

/** A comment as the server hands it over. */
export interface IssueCommentData {
  author: string
  body: string
  createdAt: string
  url: string
}

/** The issue as the server hands it over, whether read or written. */
export interface IssueData {
  title: string
  body: string
  state: string
  number: number
  comments?: IssueCommentData[]
  /** Why it is closed, when it is, and what closed it. Absent while it is open. */
  stateReason?: string | null
  closedBy?: ClosingPullRequest[]
}

/** A comment ready to render: its markdown already through `marked` and `DOMPurify`. */
interface RenderedComment {
  author: string
  createdAt: string
  url: string
  html: string
}

/** The issue itself, read live when a created block is selected. */
type IssueDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'loaded'
      title: string
      html: string
      state: string
      number: number
      comments: RenderedComment[]
      /** Why it is closed, when it is: `COMPLETED`, `NOT_PLANNED`, or nothing. */
      stateReason: string | null
      closedBy: ClosingPullRequest[]
    }
  | { status: 'error'; message: string }

/**
 * Issue text on its way to the DOM as HTML.
 *
 * Bodies and comments are written by an agent and by whoever types into GitHub, so a stray
 * script or `javascript:` href has to be taken out before it can run — the same path the
 * docs take.
 */
const render = (markdown: string): string =>
  DOMPurify.sanitize(marked.parse(markdown ?? '', { async: false }) as string)

const loadedIssue = (issue: Partial<IssueData>): IssueDetailState => ({
  status: 'loaded',
  title: issue.title ?? '',
  html: render(issue.body ?? ''),
  state: issue.state ?? '',
  number: issue.number ?? 0,
  comments: (issue.comments ?? []).map((comment) => ({
    author: comment.author ?? '',
    createdAt: comment.createdAt ?? '',
    url: comment.url ?? '',
    html: render(comment.body ?? '')
  })),
  stateReason: issue.stateReason ?? null,
  closedBy: Array.isArray(issue.closedBy) ? issue.closedBy : []
})

/** A comment's date, in the reader's own format, or nothing if GitHub sent none. */
function commentDate(iso: string): string {
  if (!iso) return ''
  const when = new Date(iso)
  return Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString()
}

/** What posting an observation answered with: an error to show, or the issue as it now is. */
export interface CommentPosted {
  error: string | null
  /**
   * The issue after the comment, when it could be read back. Null is not a failure to
   * post — it is a post whose read-back failed, and the panel simply shows no more.
   */
  issue?: IssueData | null
}

export interface CollapsibleTarget {
  id: string
  collapsed: boolean
}

export interface DocsPanelBodyProps {
  /** `customData.docKey` of the selected element, or null when nothing is selected. */
  docKey: string | null
  /** Label shown as the panel heading — usually the shape's own text. */
  title?: string | null
  /** Board the shape belongs to; each project serves docs from its own directory. */
  workspace: string
  /** Set when the selected shape is an image that can be collapsed. */
  collapsible?: CollapsibleTarget | null
  onToggleCollapse?: (id: string) => void
  /** Set when the selected shape stands for an issue — an authored block or a mirrored card. */
  issue?: IssueTarget | null
  onCreateIssue?: (id: string) => void
  /**
   * Attach reference images to a block before it is researched, and take one back off.
   * Both answer with an error to show, or null.
   */
  onAttachImages?: (issue: IssueTarget, chosen: File[]) => Promise<string | null>
  onDetachImage?: (issue: IssueTarget, fileId: string) => Promise<string | null>
  /**
   * Both take the issue rather than an element id: a mirrored card has no element on the
   * server to name, so the issue URL is the only handle the two shapes share. Both answer
   * with an error to show, or null — a card has no element for a failure to arrive on.
   */
  onImplementIssue?: (issue: IssueTarget) => Promise<string | null>
  /** Clears a `running` state whose agent is gone. Does not stop a live run. */
  onResetImplement?: (issue: IssueTarget) => Promise<string | null>
  /** The same, for the run that researches the issue. Neither run has a time limit. */
  onResetIssue?: (issue: IssueTarget) => Promise<string | null>
  /**
   * Adds an observation to the issue as a GitHub comment — an answer to a question the
   * issue agent left open, or whatever the observation missed. Keyed by issue like the
   * two above, and for the same reason.
   */
  onAddComment?: (issue: IssueTarget, body: string) => Promise<CommentPosted>
}

/** What is known about implementing the issue, wherever it was learned. */
interface ImplementView {
  state: 'running' | 'done' | 'failed' | null
  url: string | null
  error: string | null
  /** The two ends of the run, ISO. `endedAt` null while it is still going. */
  startedAt: string | null
  endedAt: string | null
  /** Token totals, when the configured agent command reports them. Usually null. */
  usage: { inputTokens: number; outputTokens: number } | null
}

/** Nothing known about a run, which is also what a reset leaves behind. */
const NO_IMPLEMENT: ImplementView = {
  state: null, url: null, error: null, startedAt: null, endedAt: null, usage: null
}

/** An implementation record as the server hands it over, in the shape the panel wants. */
const implementView = (record: Record<string, unknown> | null | undefined): ImplementView => ({
  state: (record?.state as ImplementView['state']) ?? null,
  url: (record?.url as string) ?? null,
  error: (record?.error as string) ?? null,
  startedAt: (record?.startedAt as string) ?? null,
  endedAt: (record?.endedAt as string) ?? null,
  usage: (record?.usage as ImplementView['usage']) ?? null
})

/** `4:07`, or `1:12:30` once there is an hour to show. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = total >= 3600 ? String(Math.floor(total / 60) % 60).padStart(2, '0') : String(Math.floor(total / 60))
  const hours = Math.floor(total / 3600)
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`
}

/** `28.4k`, because a running total is read at a glance rather than added up. */
function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * How long the run has been going, ticking in the browser.
 *
 * The server writes one instant when the run starts and one when it ends; everything
 * moving here is arithmetic against `Date.now()`. That is the whole design: a duration
 * kept on the server would have to be rewritten to stay true, and rewriting it means an
 * element update — a version bump and a broadcast — every second, for every block with a
 * run in flight. The clock is the cheapest thing on the board, and the board never knows
 * it is running.
 *
 * A finished run is a frozen total: `endedAt` is set, so there is nothing to tick.
 */
const RunClock: React.FC<{ startedAt: string; endedAt: string | null }> = ({ startedAt, endedAt }) => {
  const started = Date.parse(startedAt)
  const ended = endedAt ? Date.parse(endedAt) : NaN
  const live = !Number.isFinite(ended)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, startedAt])

  if (!Number.isFinite(started)) return null
  return <>{formatDuration((live ? now : ended) - started)}</>
}

/**
 * The run's progress: how long it has taken, and what it has spent when it says.
 *
 * The tokens are absent far more often than not — they arrive only when the board's
 * configured agent command already asks for a machine-readable stream — so the layout has
 * to read properly with the clock alone.
 */
const RunProgress: React.FC<{ implement: ImplementView }> = ({ implement }) => {
  if (!implement.startedAt) return null
  return (
    <p className="element-docs__progress">
      <RunClock startedAt={implement.startedAt} endedAt={implement.endedAt} />
      {implement.usage && (
        <span className="element-docs__tokens">
          {' · '}{formatTokens(implement.usage.inputTokens)} in
          {' · '}{formatTokens(implement.usage.outputTokens)} out
        </span>
      )}
    </p>
  )
}

/**
 * Everything already known about a selection, before anything has been asked for.
 *
 * Two sources, and neither is a network call. The shape carries the run — an authored block
 * gets it over the socket, a mirrored card is drawn with it — and the session cache carries
 * the issue if it has been read before. Between them, a block selected a second time has
 * its whole card decided here.
 *
 * The shape wins on the run state where both have one: the cache was written when the issue
 * was last read, and a run may have started since.
 */
function knownAlready(
  issue: IssueTarget | null | undefined,
  workspace: string
): { detail: IssueDetailState; implement: ImplementView } {
  const issueUrl = issue?.state === 'created' ? (issue.issueUrl ?? null) : null
  const remembered = issueUrl ? recallIssue(workspace, issueUrl) : null

  // The shape carries everything about the run except the token totals, which are
  // deliberately kept off elements because they change throughout one — so the remembered
  // copy is what those come from, even when the shape is the newer source for the rest.
  const fromShape: ImplementView | null = issue?.implementState
    ? {
        ...(remembered?.implement ?? NO_IMPLEMENT),
        state: issue.implementState,
        url: issue.implementUrl ?? null,
        error: issue.implementError ?? null,
        startedAt: issue.implementStartedAt ?? null,
        endedAt: issue.implementEndedAt ?? null
      }
    : null

  return {
    detail: !issueUrl
      ? { status: 'idle' }
      : remembered ? loadedIssue(remembered.issue) : { status: 'loading' },
    implement: fromShape ?? remembered?.implement ?? NO_IMPLEMENT
  }
}

/**
 * Everything the documentation panel shows, with no opinion about where it sits.
 *
 * Split out from the panel itself so the fetching, sanitising and the
 * loading / missing / error / loaded states are written once. What changed when the
 * panel moved off the window edge was its position, not any of this.
 */
export const DocsPanelBody: React.FC<DocsPanelBodyProps> = ({
  docKey, title, workspace, collapsible, onToggleCollapse, issue, onCreateIssue,
  onImplementIssue, onResetImplement, onResetIssue, onAddComment, onAttachImages, onDetachImage
}) => {
  const [doc, setDoc] = useState<DocState>({ status: 'empty' })
  const [atSelection] = useState(() => knownAlready(issue, workspace))
  const [issueDetail, setIssueDetail] = useState<IssueDetailState>(atSelection.detail)
  const [implement, setImplement] = useState<ImplementView>(atSelection.implement)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [imageError, setImageError] = useState<string | null>(null)
  /**
   * Why a reset was refused, if it was.
   *
   * Its own state rather than `issueError`: that one is shown for a `failed` block, and a
   * refused reset means the run is still going — writing the refusal there would have to
   * claim the run failed to be seen at all.
   */
  const [resetError, setResetError] = useState<string | null>(null)
  /**
   * Whether the run was still going the last time this looked.
   *
   * Only a run that settles *while it is being watched* needs the extra read below. A
   * block selected long after its run finished already got the whole record from
   * `/api/issue`, and asking again would be a request per selection for nothing.
   */
  const wasRunning = useRef(false)
  // The observation being written, and whether the box for it is open at all.
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)

  const attached = issue?.images ?? []
  // A list is a new array on every render; its contents are what the effect depends on.
  const attachedKey = attached.join(',')

  // The bytes live in the server's file store, not on the element — an element carrying
  // dataURLs would ride in every autosync payload and every export. One request per
  // attached image rather than the whole store, which on a board of screenshots is
  // megabytes to draw two thumbnails.
  useEffect(() => {
    if (!attached.length) {
      setThumbnails({})
      return
    }

    let cancelled = false
    Promise.all(attached.map(async (id) => {
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(id)}`)
        if (!response.ok) return [id, null] as const
        const body = await response.json().catch(() => ({}))
        const dataURL = body?.file?.dataURL
        return [id, typeof dataURL === 'string' ? dataURL : null] as const
      } catch {
        return [id, null] as const
      }
    })).then((entries) => {
      if (cancelled) return
      setThumbnails(Object.fromEntries(
        entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
      ))
    })

    return () => { cancelled = true }
  }, [attachedKey])

  /**
   * Attach whatever screenshot is on the clipboard, on Ctrl+V.
   *
   * The clipboard is how a screenshot arrives at all: `Win+Shift+S` produces a bitmap with
   * no path on disk, which is precisely what a file picker cannot reach.
   *
   * On `document`, in the capture phase, rather than an `onPaste` on the card. Excalidraw
   * registers its own `paste` on `document` and turns the image into a scene element, and
   * the ordinary gesture — click the block, the card opens, Ctrl+V — leaves focus inside
   * the Excalidraw container with the cursor over the canvas, which is exactly the case it
   * claims. A handler scoped to the card would therefore never fire in the one case the
   * feature is for. Capturing at `document` runs before the bubble-phase listener there,
   * and stopping propagation is what keeps the same screenshot off the board.
   *
   * **So a selected draft block changes what Ctrl+V does on the canvas**, which is the
   * decision this makes: the alternative, requiring a click into the card first, is
   * discoverable only if the card says so, and the block is selected because the reader
   * just chose it. Nothing else is touched — the effect exists only while the card does,
   * so with nothing selected, or with a block whose issue exists, Ctrl+V is what it was.
   */
  useEffect(() => {
    if (!issue || !onAttachImages || !panelTakesPaste(issue)) return

    const onPaste = (event: ClipboardEvent): void => {
      // Whatever is being typed into keeps its own paste, block or no block.
      if (isWritableTarget(event.target as HTMLElement | null)) return
      const images = clipboardImages<File>(event.clipboardData)
      if (!images.length) return

      // Taken: not pasted onto the board, and not pasted anywhere else either.
      event.preventDefault()
      event.stopPropagation()
      setImageError(null)
      void onAttachImages(issue, images).then((error) => { if (error) setImageError(error) })
    }

    document.addEventListener('paste', onPaste, true)
    return () => { document.removeEventListener('paste', onPaste, true) }
  }, [issue, onAttachImages])

  // An authored block carries a copy of the state, which arrives over the socket and is
  // what makes a block read correctly before any fetch lands. A card carries none, so this
  // simply never fires for one.
  useEffect(() => {
    if (!issue?.implementState) return
    // The token totals are deliberately not on the element — they change throughout a run,
    // and writing them onto shapes would churn the board — so this keeps whatever the poll
    // below has already learned rather than clearing it.
    setImplement((current) => ({
      ...current,
      state: issue.implementState ?? null,
      url: issue.implementUrl ?? null,
      error: issue.implementError ?? null,
      startedAt: issue.implementStartedAt ?? null,
      endedAt: issue.implementEndedAt ?? null
    }))
  }, [
    issue?.implementState, issue?.implementUrl, issue?.implementError,
    issue?.implementStartedAt, issue?.implementEndedAt
  ])

  useEffect(() => {
    if (!docKey) {
      setDoc({ status: 'empty' })
      return
    }

    // A fast click-through selects several shapes in a row; ignore every response
    // but the one for the shape still selected when it lands.
    let cancelled = false
    setDoc({ status: 'loading', key: docKey })

    fetch(`/api/docs/${encodeURIComponent(docKey)}?workspace=${encodeURIComponent(workspace)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (cancelled) return

        if (response.status === 404) {
          setDoc({ status: 'missing', key: docKey })
          return
        }
        if (!response.ok) {
          setDoc({ status: 'error', key: docKey, message: body?.error ?? `HTTP ${response.status}` })
          return
        }

        // The markdown is local and author-controlled, but it still reaches the DOM
        // as HTML — sanitise so a stray script or javascript: href cannot run.
        setDoc({ status: 'loaded', key: docKey, html: render(body.markdown ?? '') })
      })
      .catch((error: Error) => {
        if (!cancelled) setDoc({ status: 'error', key: docKey, message: error.message })
      })

    return () => { cancelled = true }
  }, [docKey, workspace])

  const issueState = issue?.state ?? null
  const issueUrl = issue?.issueUrl ?? null

  /**
   * Catch up with a selection that changed under a panel that stayed mounted.
   *
   * During render, not in an effect. An effect runs *after* the browser has painted, so
   * state written there is one frame late — and one frame late is this whole defect in
   * miniature: the panel would paint the previous selection's issue, or none, and draw its
   * buttons from that. React re-renders before committing when a component sets its own
   * state during its own render, so nothing half-updated reaches the screen.
   *
   * The panel is usually unmounted between selections, and the initial state above covers
   * that; this is the other path — clicking straight from one block to the next.
   */
  const selection = `${workspace}\n${issue?.id ?? ''}\n${issueUrl ?? ''}\n${issueState ?? ''}`
  const [shownFor, setShownFor] = useState(selection)
  if (shownFor !== selection) {
    setShownFor(selection)
    const known = knownAlready(issue, workspace)
    setIssueDetail(known.detail)
    setImplement(known.implement)
    // A half-written observation belongs to the issue it was being written about, so
    // selecting another shape puts the box away rather than carrying the text across.
    setComposing(false)
    setDraft('')
    setCommentError(null)
  }

  // A refusal belongs to the block it was refused for, and to the state it was refused in.
  // The panel outlives both, so it would otherwise carry one to the next block selected.
  useEffect(() => { setResetError(null) }, [issue?.id, issueState])

  // Read by issue URL, not by element id: a mirrored card is drawn from GitHub and never
  // reaches the server, so it has no id to ask about — but it has the issue, which is the
  // thing being read. Read on selection rather than stored, so an edit made on GitHub
  // shows up here without the board being touched.
  //
  // Stale while revalidate: what the panel already knew is on screen before this runs — the
  // two blocks above put it there — and this is only the read that keeps it honest. The
  // panel is unmounted whenever nothing is selected, so before the cache outside it, every
  // click on the same block paid for a `gh issue view` again and spent that whole second
  // showing controls computed from "not read yet".
  useEffect(() => {
    if (!issueUrl || issueState !== 'created') return

    const remembered = recallIssue(workspace, issueUrl)
    let cancelled = false

    fetch(`/api/issue?url=${encodeURIComponent(issueUrl)}&workspace=${encodeURIComponent(workspace)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (cancelled) return
        if (!response.ok) {
          // A failed revalidation is not a reason to throw away a copy that is almost
          // certainly still right. `gh` drops a socket here often enough that replacing the
          // issue with an error every time it did would be the worse trade.
          if (!remembered) {
            setIssueDetail({ status: 'error', message: body?.error ?? `HTTP ${response.status}` })
          }
          return
        }
        const view = implementView(body.implement)
        rememberIssue(workspace, issueUrl, { issue: body.issue ?? {}, implement: view })
        setIssueDetail(loadedIssue(body.issue ?? {}))
        setImplement(view)
      })
      .catch((error: Error) => {
        if (!cancelled && !remembered) setIssueDetail({ status: 'error', message: error.message })
      })

    return () => { cancelled = true }
  }, [issueUrl, issueState, workspace])

  // An authored block hears the result over the socket, as an element update. A card
  // cannot — there is no element — so while a run is in flight it asks. This reads only
  // the record, so it costs no `gh` process.
  useEffect(() => {
    if (!issueUrl || !implement.state) return

    let cancelled = false
    const read = (): void => {
      fetch(`/api/implement?url=${encodeURIComponent(issueUrl)}&workspace=${encodeURIComponent(workspace)}`)
        .then((response) => response.json())
        .then((body) => {
          if (cancelled || !body?.success) return
          setImplement(implementView(body.implement))
        })
        .catch(() => undefined)
    }

    // One last read when a run settles under the reader's eyes. The ending arrives over
    // the socket as an element update, which carries the state and the two instants but
    // not the token totals — those live on the record alone, precisely so that a figure
    // changing throughout a run never rewrites a shape. Without this the panel would keep
    // whichever total it happened to poll last while the run was still going.
    if (implement.state !== 'running') {
      if (wasRunning.current) read()
      wasRunning.current = false
      return () => { cancelled = true }
    }

    wasRunning.current = true
    const timer = setInterval(read, 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [issueUrl, implement.state, workspace])

  // What GitHub says about the issue, once it has said anything. Null while it is being
  // read, which is not the same as open — the controls below treat it as "unknown" rather
  // than guessing, so nothing appears and then vanishes a second later.
  const githubState = issueDetail.status === 'loaded' ? issueDetail.state : null
  const closure = closureView({
    githubState,
    stateReason: issueDetail.status === 'loaded' ? issueDetail.stateReason : null,
    closedBy: issueDetail.status === 'loaded' ? issueDetail.closedBy : []
  })

  return (
    <div className="element-docs">
      {issue && (
        <div className="element-docs__issue">
          {issue.state === 'created' && issue.issueUrl && (
            <>
              <h2 className="element-docs__title">
                {issueDetail.status === 'loaded' ? issueDetail.title : (issue.issueTitle || 'Issue')}
              </h2>
              <a className="element-docs__issue-link" href={issue.issueUrl} target="_blank" rel="noreferrer">
                {issue.issueUrl.replace(/^https:\/\/github\.com\//, '')}
                {issueDetail.status === 'loaded' && issueDetail.state
                  ? ` · ${issueDetail.state.toLowerCase()}`
                  : ''}
              </a>

              {/* Above the description, because it is an action on the issue rather than
                  part of reading it, and a reader who has decided should not have to
                  scroll a body this long to act. */}
              <div className="element-docs__implement">
                {implement.state === 'done' && implement.url && (
                  <a
                    className="element-docs__issue-link"
                    href={implement.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Implemented · {implement.url.replace(/^https:\/\/github\.com\//, '')}
                  </a>
                )}

                {/* The clock belongs to a finished run as much as to a live one: "it took
                    forty minutes" is the answer to the same question, asked afterwards. */}
                {implement.state !== null && <RunProgress implement={implement} />}

                {implement.state === 'running' && (
                  <>
                    <p className="element-docs__hint">
                      An agent is implementing this issue in the project. There is no time
                      limit on the run.
                    </p>
                    {/* Without a timeout, nothing else ever clears this state. The server
                        refuses while a run is genuinely in flight, so this is a way back
                        from an abandoned one rather than a way to interrupt a live one. */}
                    {onResetImplement && (
                      <button
                        type="button"
                        className="element-docs__collapse"
                        onClick={async () => {
                          const error = await onResetImplement(issue)
                          if (error) setImplement((current) => ({ ...current, error }))
                          else {
                            setImplement(NO_IMPLEMENT)
                            // Written through for the reason the start is: the point of a
                            // reset is that the block can be tried again, and a remembered
                            // `running` would take that back on the next selection.
                            if (issueUrl) rememberImplement(workspace, issueUrl, NO_IMPLEMENT)
                          }
                        }}
                      >
                        Reset — the run was lost
                      </button>
                    )}
                  </>
                )}

                {implement.state === 'failed' && (
                  <p className="element-docs__error">{implement.error ?? 'The run failed.'}</p>
                )}

                {/* A closed issue is done with, and what closed it is worth naming: the
                    pull request is the answer to "was this actually shipped", and it is
                    one gh field away rather than an inference. */}
                {closure?.pullRequests.map((pullRequest) => (
                  <a
                    key={pullRequest.url}
                    className="element-docs__issue-link"
                    href={pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Closed by {pullRequest.url.replace(/^https:\/\/github\.com\//, '')}
                  </a>
                ))}
                {closure?.note && <p className="element-docs__hint">{closure.note}</p>}

                {/* Two actions on one row rather than two rows of one. Adding an
                    observation is offered for as long as the issue exists — including
                    while an implementation runs, because that is exactly when something
                    forgotten turns up — so when Implement / Fix is gone, whether because a
                    run holds it or because the issue is closed, it simply takes the row to
                    itself. */}
                <div className="element-docs__actions">
                  {onAddComment && (
                    <button
                      type="button"
                      className="element-docs__collapse element-docs__action"
                      onClick={() => {
                        setCommentError(null)
                        setComposing((open) => !open)
                      }}
                    >
                      Add observations
                    </button>
                  )}

                  {offersImplement({ githubState, implementState: implement.state }) && onImplementIssue && (
                    <button
                      type="button"
                      className="element-docs__collapse element-docs__action"
                      onClick={async () => {
                        // Optimistic, because the run itself answers immediately and the
                        // result arrives later — over the socket for a block, by asking for
                        // a card. The clock starts from here for the same reason, and is
                        // replaced by the server's own instant the moment one arrives.
                        //
                        // Written through to what is remembered as well, or the next
                        // selection would paint the record from before the click and offer
                        // to start the run a second time.
                        const started: ImplementView = {
                          ...NO_IMPLEMENT, state: 'running', startedAt: new Date().toISOString()
                        }
                        setImplement(started)
                        if (issueUrl) rememberImplement(workspace, issueUrl, started)
                        const error = await onImplementIssue(issue)
                        if (error) {
                          const failed: ImplementView = { ...NO_IMPLEMENT, state: 'failed', error }
                          setImplement(failed)
                          if (issueUrl) rememberImplement(workspace, issueUrl, failed)
                        }
                      }}
                    >
                      Implement / Fix
                    </button>
                  )}
                </div>

                {composing && onAddComment && (
                  <div className="element-docs__compose">
                    <textarea
                      className="element-docs__draft"
                      value={draft}
                      autoFocus
                      placeholder="Answer a question the issue left open, or add what it missed. Posted to the issue as a comment, exactly as written."
                      onChange={(event) => setDraft(event.target.value)}
                    />
                    <div className="element-docs__actions">
                      <button
                        type="button"
                        className="element-docs__collapse element-docs__action"
                        disabled={posting || !draft.trim()}
                        onClick={async () => {
                          setPosting(true)
                          setCommentError(null)
                          const result = await onAddComment(issue, draft)
                          setPosting(false)
                          if (result.error) {
                            // The text stays in the box: it is the only copy of itself.
                            setCommentError(result.error)
                            return
                          }
                          setDraft('')
                          setComposing(false)
                          // The server read the issue back after posting, so this is the
                          // newest copy anyone has — remembered as well as rendered, or the
                          // next selection would show the issue without its own comment.
                          if (result.issue) {
                            setIssueDetail(loadedIssue(result.issue))
                            if (issueUrl) {
                              rememberIssue(workspace, issueUrl, { issue: result.issue, implement })
                            }
                          }
                        }}
                      >
                        {posting ? 'Posting…' : 'Post to the issue'}
                      </button>
                      <button
                        type="button"
                        className="element-docs__collapse element-docs__action"
                        disabled={posting}
                        onClick={() => {
                          setComposing(false)
                          setDraft('')
                          setCommentError(null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    {commentError && <p className="element-docs__error">{commentError}</p>}
                  </div>
                )}
              </div>

              {issueDetail.status === 'loading' && (
                <p className="element-docs__hint">Reading the issue…</p>
              )}
              {issueDetail.status === 'error' && (
                <p className="element-docs__error">Could not read the issue: {issueDetail.message}</p>
              )}
              {issueDetail.status === 'loaded' && (
                <article
                  className="element-docs__body"
                  dangerouslySetInnerHTML={{ __html: issueDetail.html }}
                />
              )}

              {/* Under the body, because that is where they are on GitHub and because an
                  observation added here is only worth adding if it can be read back. */}
              {issueDetail.status === 'loaded' && issueDetail.comments.length > 0 && (
                <section className="element-docs__comments">
                  <h3 className="element-docs__comments-title">
                    {issueDetail.comments.length === 1
                      ? '1 comment'
                      : `${issueDetail.comments.length} comments`}
                  </h3>
                  {issueDetail.comments.map((comment, index) => (
                    <article key={comment.url || index} className="element-docs__comment">
                      <p className="element-docs__comment-meta">
                        {[comment.author, commentDate(comment.createdAt)].filter(Boolean).join(' · ')}
                      </p>
                      <div
                        className="element-docs__body"
                        dangerouslySetInnerHTML={{ __html: comment.html }}
                      />
                    </article>
                  ))}
                </section>
              )}

              {issue.observation && (
                <details className="element-docs__observation">
                  <summary>Original observation</summary>
                  <p>{issue.observation}</p>
                </details>
              )}
            </>
          )}

          {issue.state === 'running' && (
            <>
              <p className="element-docs__hint">
                Researching the repository and drafting the issue. This takes minutes, and
                there is no time limit on the run.
              </p>
              {/* Without a ceiling, nothing else ever clears this state — and the create
                  control is hidden while it holds, so a lost run would kill the block for
                  good. The server refuses while a run is genuinely in flight, so this is a
                  way back from an abandoned one rather than a way to interrupt a live one. */}
              {onResetIssue && (
                <button
                  type="button"
                  className="element-docs__collapse"
                  onClick={async () => {
                    setResetError(await onResetIssue(issue))
                  }}
                >
                  Reset — the run was lost
                </button>
              )}
              {resetError && <p className="element-docs__error">{resetError}</p>}
            </>
          )}

          {issue.state === 'failed' && (
            <p className="element-docs__error">{issue.issueError ?? 'The run failed.'}</p>
          )}

          {/* Said out loud for the reason Ctrl+V is: Enter finishing an edit is this
              board's convention rather than Excalidraw's, so nothing else on screen
              would mention it. Only before the run — a created block's text is the
              issue title, and nobody is writing an observation into it. */}
          {issue.state !== 'created' && issue.state !== 'running' && (
            <p className="element-docs__hint">
              While writing in the block, Enter finishes the edit and Shift+Enter breaks the
              line. Finishing writes the observation down; the button below is what starts
              the run.
            </p>
          )}

          {/* Only before the run: the images are material for the investigation, so
              attaching one to a block whose issue already exists would change nothing.
              A mirrored card never reaches here — it is `created` by construction. */}
          {issue.state !== 'created' && issue.state !== 'running' && onAttachImages && (
            <div className="element-docs__images">
              {attached.length > 0 && (
                <ul className="element-docs__image-list">
                  {attached.map((fileId) => (
                    <li key={fileId} className="element-docs__image">
                      {thumbnails[fileId]
                        ? <img src={thumbnails[fileId]} alt="Attached reference" />
                        : <span className="element-docs__image-missing">missing</span>}
                      {onDetachImage && (
                        <button
                          type="button"
                          className="element-docs__image-remove"
                          title="Remove this image"
                          aria-label="Remove this image"
                          onClick={async () => {
                            setImageError(null)
                            const error = await onDetachImage(issue, fileId)
                            if (error) setImageError(error)
                          }}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {/* A label wrapping a hidden input: a file picker is a native control that
                  cannot be opened from script, so the button has to be the input. */}
              <label className="element-docs__collapse element-docs__attach">
                {attached.length
                  ? `Attach another reference image (${attached.length} attached)`
                  : 'Attach reference images'}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={async (event) => {
                    const chosen = Array.from(event.target.files ?? [])
                    // Cleared so the same file picked twice in a row still fires onChange.
                    event.target.value = ''
                    if (!chosen.length) return
                    setImageError(null)
                    const error = await onAttachImages(issue, chosen)
                    if (error) setImageError(error)
                  }}
                />
              </label>

              {imageError && <p className="element-docs__error">{imageError}</p>}
              {/* The paste is worth saying out loud: it is the way a screenshot arrives,
                  and a keystroke nothing on screen mentions is a keystroke nobody tries. */}
              <p className="element-docs__hint">
                A screenshot on the clipboard can be pasted straight in with Ctrl+V (⌘V on a
                Mac); the button is for images already saved as files.
              </p>
              <p className="element-docs__hint">
                The agent reads these while it investigates. They cannot be uploaded to the
                issue itself, so whatever the issue depends on is written out in words.
              </p>
            </div>
          )}

          {issue.state !== 'created' && issue.state !== 'running' && onCreateIssue && (
            <button
              type="button"
              className="element-docs__collapse"
              onClick={() => onCreateIssue(issue.id)}
            >
              Research and create the issue
            </button>
          )}
        </div>
      )}

      {collapsible && onToggleCollapse && (
        <button
          type="button"
          className="element-docs__collapse"
          onClick={() => onToggleCollapse(collapsible.id)}
        >
          {collapsible.collapsed ? 'Expand image' : 'Collapse image'}
        </button>
      )}

      {doc.status === 'loading' && (
        <p className="element-docs__hint">Loading {doc.key}…</p>
      )}

      {doc.status === 'missing' && (
        <>
          <h2 className="element-docs__title">{title || doc.key}</h2>
          <p className="element-docs__hint">
            No document yet for <code>{doc.key}</code>.
          </p>
        </>
      )}

      {doc.status === 'error' && (
        <p className="element-docs__error">Could not load {doc.key}: {doc.message}</p>
      )}

      {doc.status === 'loaded' && (
        <article
          className="element-docs__body"
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
      )}
    </div>
  )
}
