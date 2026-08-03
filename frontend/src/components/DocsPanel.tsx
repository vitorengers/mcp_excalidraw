import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { closureView, offersImplement, offersRecreate, offersResume } from '../../../src/core/issue-appearance'
import type { ClosingPullRequest, PanelRunState } from '../../../src/core/issue-appearance'
import { clipboardImages, isWritableTarget, panelTakesPaste } from '../../../src/core/pasted-images'
import { forgetIssue, recallIssue, rememberImplement, rememberIssue } from '../issue-cache'
import './DocsPanel.css'

type DocState =
  | { status: 'empty' }
  | { status: 'loading'; key: string }
  | { status: 'loaded'; key: string; html: string }
  | { status: 'missing'; key: string }
  /** The board has no docs directory at all, so no key on it could ever resolve. */
  | { status: 'no-docs-dir'; key: string; message: string }
  | { status: 'error'; key: string; message: string }

/**
 * The code the docs route sends with the 404 it means as "this board has none".
 *
 * The route answers both "no directory" and "no such file" with a 404, and the panel used
 * to map both to `missing` and throw the body away — so a project one setting away from
 * working reported a per-document problem, and nothing on screen pointed at the setting.
 */
const NO_DOCS_DIR = 'no-docs-dir'

export interface IssueTarget {
  id: string
  state: 'draft' | 'running' | 'created' | 'failed'
  issueUrl?: string | null
  issueError?: string | null
  /** Kept on the element so the card reads correctly with nothing selected. */
  issueTitle?: string | null
  /** The text that produced the issue, preserved when the label was retitled. */
  observation?: string | null
  /**
   * When the research run started and stopped, ISO. Kept on the element for the reason the
   * implement pair below is: a block has to read correctly with nothing selected and no
   * network, and a clock ticking on the server would rewrite the shape once a second.
   */
  issueStartedAt?: string | null
  issueEndedAt?: string | null
  /** Files attached as reference material for the run, by id in the server's file store. */
  images?: string[]
  /** Set once an agent has been asked to implement the issue. */
  implementState?: PanelRunState
  implementUrl?: string | null
  implementError?: string | null
  /**
   * When the run started and stopped, ISO. Kept on the element for the same reason the
   * title is: a block has to read correctly with nothing selected and no network.
   */
  implementStartedAt?: string | null
  implementEndedAt?: string | null
  /**
   * Whether this shape is one whose issue is still waiting, so it may be researched again.
   *
   * A mirrored card carries it because the mirror stamps the Todo column onto the card; an
   * authored block is `true` because there is no column to read. Undefined is a shape from
   * before this existed, and reads as "no".
   */
  recreatable?: boolean
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

// ─── The work only a person can do ────────────────────────────

/** The card's own face: which record this is, and whether it is still asking. */
export interface FounderTarget {
  key: string
  kind?: string | null
  state: 'open' | 'resolved' | 'dismissed'
  /** The one line drawn on the card, which is all a card carries. */
  title?: string | null
}

/** The fields the register is a schema for. Plain sentences, never markup. */
export interface FounderFields {
  title: string
  what: string
  why: string
  steps: string[]
  confirm: string
}

/** What the machine saw, which is the one part written for an engineer. */
export interface FounderEvidence {
  command?: string
  said?: string
  source?: string
}

/** One turn of the conversation, exactly as it was said. */
export interface FounderChatTurn {
  role: 'founder' | 'agent'
  text: string
  at: string
}

/** A founder action as `GET /api/founder-actions` hands it over. */
export interface FounderAction {
  key: string
  kind?: string | null
  state: 'open' | 'resolved' | 'dismissed'
  fields: FounderFields
  evidence?: FounderEvidence | null
  chat?: FounderChatTurn[]
  resolvedBy?: 'probe' | 'person' | null
}

/**
 * What this board can offer for a founder action.
 *
 * **Read from `GET /api/founder-actions`, never discovered by pressing something.** A POST
 * probe against a route that exists would perform the write it was probing for: a resolve
 * probe settles the card, and a chat probe starts an agent.
 */
export interface FounderControls {
  resolve: boolean
  chat: boolean
  /** Why there is no chat here, for a panel that would otherwise show an empty space. */
  chatRefusal?: string | null
}

/** What pressing Done answered. */
export interface FounderResolved {
  ok: boolean
  /** The probe's own sentence when it refused, which is what the panel shows in place. */
  error?: string | null
  /** Why it settled, when it did. */
  why?: string | null
  /** False when nothing could check it, which the panel says out loud. */
  verified?: boolean
  action?: FounderAction | null
}

/** What one chat turn has done so far, and the item as the store now holds it. */
export interface FounderChatState {
  run: {
    state: 'running' | 'done' | 'failed'
    error: string | null
    /** The plain sentence a refused revision earns, or null. */
    refusal: string | null
  } | null
  action: FounderAction | null
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
  /**
   * `resume` continues an attempt whose server did not survive it, in the checkout that
   * attempt left behind, rather than starting the issue again from nothing. It is the same
   * call because it is the same run — one parameter rather than a second handler, so the two
   * cannot drift into disagreeing about which issue is being worked on.
   */
  onImplementIssue?: (issue: IssueTarget, resume?: boolean, interactive?: boolean) => Promise<string | null>
  /** Clears a `running` state whose agent is gone. Does not stop a live run. */
  onResetImplement?: (issue: IssueTarget) => Promise<string | null>
  /** The same, for the run that researches the issue. Neither run has a time limit. */
  onResetIssue?: (issue: IssueTarget) => Promise<string | null>
  /**
   * Tells a block which issue it already produced, for a run whose result never reached it.
   *
   * Neither of the two above can help there: the block is not `running`, so there is nothing
   * to reset, and it carries no `issueUrl`, so a run would open a second issue for an
   * observation that already has one. Answers with an error to show, or null.
   */
  onAdoptIssue?: (issue: IssueTarget, issueUrl: string) => Promise<string | null>
  /**
   * Adds an observation to the issue as a GitHub comment — an answer to a question the
   * issue agent left open, or whatever the observation missed. Keyed by issue like the
   * two above, and for the same reason.
   */
  onAddComment?: (issue: IssueTarget, body: string) => Promise<CommentPosted>
  /**
   * Sends an agent back at an issue that already exists, to investigate it again and rewrite
   * it in place — the same number, the same card, the same comments.
   *
   * Offered only while nothing has been started against the issue, because a rewrite past
   * that point changes the specification behind a running agent's back. Answers with an error
   * to show, or null; the outcome arrives minutes later and is polled for.
   */
  onRecreateIssue?: (issue: IssueTarget, observations: string) => Promise<string | null>
  /**
   * Set when the selected shape is a founder card — a thing only a person can do.
   *
   * Never set at the same time as `issue`: `resolvePanelTarget` answers the founder question
   * first precisely so that a founder card cannot look like an issue, because every control
   * that offers to build something keys off `issue` alone.
   */
  founder?: FounderTarget | null
  /** The record behind that card, as the poll last read it. Null until the first read lands. */
  founderAction?: FounderAction | null
  founderControls?: FounderControls | null
  /** Press Done. Answers the probe's refusal, or the settled record. */
  onResolveFounder?: (key: string) => Promise<FounderResolved>
  /** Ask a question about it. Answers an error to show, or null; the reply arrives later. */
  onSendFounderChat?: (key: string, message: string) => Promise<string | null>
  /** What that turn has done so far, and the item as the store now holds it. */
  onReadFounderChat?: (key: string) => Promise<FounderChatState | null>
}

/**
 * A step as the reader gets it: any ordinal a producer transcribed belongs to the list.
 *
 * The same strip `renderFounderAction` makes, written again here rather than imported, for the
 * reason `FounderTargetState` is written out again in `core/panel-target.ts`: this is browser
 * code, and the register is enforced at the write. The numbering is therefore the `<ol>`'s —
 * which is the numbering the record was stored with, because the register refuses a run of
 * ordinals that is not consecutive.
 */
const founderStep = (step: string): string =>
  (step ?? '').replace(/^\s*(?:step\s+)?(\d+)\s*[.):\-–—]\s+/i, '').trim()

/** A turn's time, in the reader's own format, or nothing when it was never stamped. */
function turnTime(iso: string): string {
  if (!iso) return ''
  const when = new Date(iso)
  return Number.isNaN(when.getTime()) ? '' : when.toLocaleTimeString()
}

/**
 * The whole of a founder action, in the reading column the docs card already is.
 *
 * **Inside the anchored card rather than as an overlay of its own**, which is what keeps #241
 * from happening a second time: two overlays sharing `--board-z-overlay` are stacked by DOM
 * order, and a second one added here would cover the docs card it was drawn beside. Nothing is
 * added to `obstacles` because there is nothing new on that layer.
 *
 * The card is 720 pixels wide — the same reading column a whole GitHub issue body uses — and a
 * founder action is deliberately far shorter than that. So it is laid out to look finished at
 * that length: short blocks with room between them, the steps carrying most of the height, and
 * **no second scrollable region**. A transcript with a scrollbar of its own inside a card that
 * already has one is two places to be lost in.
 *
 * `Evidence` is closed. It is the one part written for an engineer, and a founder action that
 * opens showing a command line and a tool's stderr has undone the feature on its first frame.
 */
const FounderPanel: React.FC<{
  target: FounderTarget
  action: FounderAction | null
  controls: FounderControls | null
  onResolve?: (key: string) => Promise<FounderResolved>
  onSend?: (key: string, message: string) => Promise<string | null>
  onRead?: (key: string) => Promise<FounderChatState | null>
}> = ({ target, action, controls, onResolve, onSend, onRead }) => {
  /**
   * The record as this panel now knows it, which is not always what the poll last drew.
   *
   * Done settles it and a chat may revise it, and both answers come back from the route that
   * did the work — so the panel takes them rather than waiting out a poll. The board's own copy
   * catches up on its next pass; until then this is the newer of the two.
   */
  const [live, setLive] = useState<FounderAction | null>(action)
  const [resolving, setResolving] = useState(false)
  /** The probe's own sentence when it refused. Shown in place; the panel stays open. */
  const [refusal, setRefusal] = useState<string | null>(null)
  /** What settling it said, once it settled. */
  const [settledWhy, setSettledWhy] = useState<string | null>(null)
  const [verified, setVerified] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [run, setRun] = useState<FounderChatState['run']>(null)
  /** The turns this panel has shown, ahead of the store when one has just been typed. */
  const [turns, setTurns] = useState<FounderChatTurn[]>(action?.chat ?? [])

  // A record belongs to the card it was read for, and the panel outlives the selection — so
  // everything above is written again when the selected key changes, during render rather than
  // in an effect. An effect runs after the paint, and one frame late is the previous card's
  // steps under this card's title.
  const [shownFor, setShownFor] = useState(target.key)
  if (shownFor !== target.key) {
    setShownFor(target.key)
    setLive(action)
    setTurns(action?.chat ?? [])
    setRefusal(null)
    setSettledWhy(null)
    setVerified(null)
    setDraft('')
    setChatError(null)
    setRun(null)
  }

  // The poll caught up, and nothing local is newer: take it. A record the panel has already
  // changed is left alone until the selection does, or a settle would be undone by the tick
  // that follows it.
  useEffect(() => {
    if (!action || live) return
    setLive(action)
    setTurns(action.chat ?? [])
  }, [action, live])

  /**
   * Follow the run until it settles, then take the item as the store now holds it.
   *
   * Polled rather than pushed, exactly as a recreate is: there is no element for the socket to
   * update — a founder card is redrawn from the server on every pass — and the reply, the
   * revised steps and the refusal all arrive at once, from the store.
   */
  useEffect(() => {
    if (!onRead || run?.state !== 'running') return
    let cancelled = false
    const read = (): void => {
      void onRead(target.key).then((state) => {
        if (cancelled || !state) return
        setRun(state.run)
        if (state.action) {
          setLive(state.action)
          setTurns(state.action.chat ?? [])
        }
      })
    }
    const timer = setInterval(read, 1200)
    read()
    return () => { cancelled = true; clearInterval(timer) }
  }, [onRead, target.key, run?.state])

  const record = live ?? action
  const fields = record?.fields ?? null
  const evidence = record?.evidence ?? null
  const settled = (record?.state ?? target.state) !== 'open'
  const evidenceRows: [string, string][] = [
    ['Command', evidence?.command ?? ''],
    ['Said', evidence?.said ?? ''],
    ['Where', evidence?.source ?? '']
  ].filter((row): row is [string, string] => Boolean(row[1]))

  const send = async (): Promise<void> => {
    if (!onSend || sending || run?.state === 'running') return
    const message = draft
    setSending(true)
    setChatError(null)
    // Shown at once, before the network: the founder has to see what they said land, and the
    // route writes it to the store before it spawns anything, so the two agree.
    setTurns((current) => [...current, { role: 'founder', text: message, at: new Date().toISOString() }])
    const error = await onSend(target.key, message)
    setSending(false)
    if (error) {
      setChatError(error)
      // Put the words back in the box: they are the only copy of themselves.
      setTurns((current) => current.slice(0, -1))
      return
    }
    setDraft('')
    setRun({ state: 'running', error: null, refusal: null })
  }

  return (
    <div className="element-docs__founder">
      <h2 className="element-docs__title">{fields?.title ?? target.title ?? 'A thing only you can do'}</h2>

      {!record && <p className="element-docs__hint">Reading this item…</p>}

      {fields && (
        <>
          <p className="element-docs__founder-what">{fields.what}</p>
          <p className="element-docs__founder-why">{fields.why}</p>

          <ol className="element-docs__founder-steps">
            {fields.steps.map((step, at) => (
              <li key={`${at}-${step}`}>{founderStep(step)}</li>
            ))}
          </ol>

          <p className="element-docs__founder-confirm">{fields.confirm}</p>

          {/* Closed, and closed is the whole requirement: showing it by default undoes the
              feature. `<details>` rather than a button of our own so that the disclosure is
              the platform's — it opens on Enter and on Space, and a reader who never opens it
              pays nothing for it. */}
          {evidenceRows.length > 0 && (
            <details className="element-docs__founder-evidence">
              <summary>Evidence</summary>
              <dl>
                {evidenceRows.map(([name, value]) => (
                  <React.Fragment key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </details>
          )}
        </>
      )}

      <div className="element-docs__actions">
        {!settled && controls?.resolve && onResolve && (
          <button
            type="button"
            className="element-docs__collapse element-docs__action element-docs__founder-done"
            disabled={resolving}
            onClick={async () => {
              setResolving(true)
              setRefusal(null)
              const answer = await onResolve(target.key)
              setResolving(false)
              if (!answer.ok) {
                // In place, and the panel stays open — the rule the comment box already
                // follows, where an error keeps the draft.
                setRefusal(answer.error ?? 'It could not be settled.')
                return
              }
              setRefusal(null)
              setSettledWhy(answer.why ?? null)
              setVerified(answer.verified === true)
              if (answer.action) setLive(answer.action)
            }}
          >
            {resolving ? 'Checking…' : 'Done'}
          </button>
        )}
      </div>

      {refusal && <p className="element-docs__error element-docs__founder-refusal">{refusal}</p>}

      {settled && (
        <p className="element-docs__hint element-docs__founder-settled">
          {settledWhy
            ?? (record?.resolvedBy === 'probe'
              ? 'This was checked and it is done.'
              : 'This was marked done.')}
          {verified === false && ' Nothing here could check it, so it is recorded as taken on trust.'}
        </p>
      )}

      {/* The conversation. Below the steps, because it is about them. */}
      <section className="element-docs__founder-chat">
        {turns.length > 0 && (
          <div className="element-docs__founder-transcript">
            {turns.map((turn, at) => (
              <article
                key={`${at}-${turn.at}`}
                className={`element-docs__founder-turn element-docs__founder-turn--${turn.role}`}
              >
                <p className="element-docs__comment-meta">
                  {[turn.role === 'founder' ? 'You' : 'The agent', turnTime(turn.at)]
                    .filter(Boolean).join(' · ')}
                </p>
                {turn.role === 'agent'
                  ? (
                    // An agent's reply is markdown written by something this board started, so
                    // it reaches the DOM the way every other such body does — through `marked`
                    // and `DOMPurify`.
                    <div
                      className="element-docs__body"
                      dangerouslySetInnerHTML={{ __html: render(turn.text) }}
                    />
                  )
                  : <p className="element-docs__founder-said">{turn.text}</p>}
              </article>
            ))}
          </div>
        )}

        {run?.state === 'running' && (
          <p className="element-docs__hint">Asking…</p>
        )}
        {run?.state === 'failed' && (
          <p className="element-docs__error">{run.error ?? 'The question was not answered.'}</p>
        )}
        {/* Said plainly, and separately from the reply: a revision the register refused leaves
            the item as it was, and a founder who is not told has silently got an unchanged
            card. */}
        {run?.refusal && <p className="element-docs__hint">{run.refusal}</p>}

        {controls?.chat && onSend && (
          <div className="element-docs__compose">
            <textarea
              className="element-docs__draft element-docs__founder-draft"
              value={draft}
              placeholder="Ask about this — which plan to buy, whether the free one is enough, or say you have done it."
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="element-docs__actions">
              <button
                type="button"
                className="element-docs__collapse element-docs__action element-docs__founder-send"
                // A second send while one is in flight is refused here rather than by the
                // server's 409: the reader should not be able to start a second agent and
                // then be told off for it.
                disabled={sending || run?.state === 'running' || !draft.trim()}
                onClick={() => { void send() }}
              >
                {sending || run?.state === 'running' ? 'Asking…' : 'Ask'}
              </button>
            </div>
            {chatError && <p className="element-docs__error">{chatError}</p>}
          </div>
        )}
        {controls && !controls.chat && controls.chatRefusal && (
          <p className="element-docs__hint">{controls.chatRefusal}</p>
        )}
      </section>
    </div>
  )
}

/** What is known about implementing the issue, wherever it was learned. */
interface ImplementView {
  state: PanelRunState
  url: string | null
  error: string | null
  /** The two ends of the run, ISO. `endedAt` null while it is still going. */
  startedAt: string | null
  endedAt: string | null
  /** Token totals, when the configured agent command reports them. Usually null. */
  usage: {
    inputTokens: number
    outputTokens: number
    /** Part of `outputTokens`, not a third total. Null when the agent never said. */
    thinkingTokens: number | null
  } | null
  /** Whether this run already spent its one automatic second attempt. */
  recovered: boolean
}

/** Nothing known about a run, which is also what a reset leaves behind. */
const NO_IMPLEMENT: ImplementView = {
  state: null, url: null, error: null, startedAt: null, endedAt: null, usage: null, recovered: false
}

/**
 * The three things any run has to show for itself: when it began, when it stopped, what it
 * spent.
 *
 * Named apart from `ImplementView` because there are three runs on this panel now — the
 * implementation, the investigation that produced the issue, and the one that rewrites it —
 * and they agree about nothing except this. What they disagree about is where the parts come
 * from: an implementation keeps all three on one record, while a research run keeps the
 * instants on the element and the figures on a record, so the panel assembles them.
 */
type RunView = Pick<ImplementView, 'startedAt' | 'endedAt' | 'usage'>

/** Nothing known about a run yet, which is what every selection starts from. */
const NO_RUN: RunView = { startedAt: null, endedAt: null, usage: null }

/** A research run as `GET /api/issue-block/:id/run` and `GET /api/issue/recreate` hand it over. */
const runView = (record: Record<string, unknown> | null | undefined): RunView => ({
  startedAt: (record?.startedAt as string) ?? null,
  endedAt: (record?.endedAt as string) ?? null,
  usage: (record?.usage as ImplementView['usage']) ?? null
})

/** An implementation record as the server hands it over, in the shape the panel wants. */
const implementView = (record: Record<string, unknown> | null | undefined): ImplementView => ({
  state: (record?.state as ImplementView['state']) ?? null,
  url: (record?.url as string) ?? null,
  error: (record?.error as string) ?? null,
  startedAt: (record?.startedAt as string) ?? null,
  endedAt: (record?.endedAt as string) ?? null,
  usage: (record?.usage as ImplementView['usage']) ?? null,
  // A `RunView` carried this line and no `RunView` has the field, so the one thing that reads
  // it — the second-attempt notice, on a `running` and on a `failed` block — never saw
  // anything but `undefined`. It belongs to the implementation record, which is where the
  // server writes it.
  recovered: record?.recovered === true
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
 *
 * A hook rather than a component because there are two readings of the same elapsed time on
 * that line now — the duration and the rate beside it — and two components each holding their
 * own `setInterval` would be two clocks that agree only by luck. Null when the run has no
 * start to measure from.
 */
function useElapsedMs(startedAt: string | null, endedAt: string | null): number | null {
  const started = startedAt ? Date.parse(startedAt) : NaN
  const ended = endedAt ? Date.parse(endedAt) : NaN
  const live = !Number.isFinite(ended)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, startedAt])

  if (!Number.isFinite(started)) return null
  return (live ? now : ended) - started
}

/**
 * `806 tok/s`, or `1.2k tok/s` once a run is spending faster than a reader can add up.
 *
 * Everything the run has spent — input and output both — over how long it took, which is the
 * division a reader would do from the two figures beside it and the clock in front of them.
 * Not output alone: what the two totals answer together is *what this board is consuming*, and
 * with cache reads inside `in` that is where nearly all of it is.
 *
 * Null rather than `0` in three cases, and they are the same case: the run has not said enough
 * to divide. No usage reported at all — which is most runs, since the agent command has to
 * stream it — nothing spent yet, or less than a second to average over. A rate over half a
 * second is not an average, it is the sampling interval.
 */
function averageRate(totalTokens: number, elapsedMs: number | null): string | null {
  if (elapsedMs === null || elapsedMs < 1000 || totalTokens <= 0) return null
  const perSecond = totalTokens / (elapsedMs / 1000)
  // One decimal below ten, because a slow run rounded to the nearest whole token a second is
  // `0 tok/s` — the one thing this is not allowed to say about a run that has spent something.
  return `${perSecond >= 10 ? formatTokens(Math.round(perSecond)) : perSecond.toFixed(1)} tok/s`
}

/**
 * The run's progress: how long it has taken, and what it has spent when it says.
 *
 * One renderer for all three runs on this panel rather than one each. They are shown in
 * different places and started by different buttons, but *what* is worth saying about a run in
 * flight is the same question with the same answer, and a second copy of this would be a
 * second answer to it — reading `28.4k out` beside one run and `28400 output` beside the next.
 *
 * The tokens are absent far more often than not — they arrive only when the board's
 * configured agent command already asks for a machine-readable stream — so the layout has
 * to read properly with the clock alone.
 *
 * Reasoning is rarer still, and it hangs off `out` rather than standing beside it: those
 * tokens are billed as output and are already counted there, so a third `·` segment would
 * read as a third total to be added to the other two. In brackets it reads as what it is —
 * how much of the figure in front of it went on thinking rather than on saying anything.
 * Absent when the agent never broke it down, which is not the same as a run that thought
 * for nothing.
 *
 * The rate is last because it is derived from everything in front of it: the two totals over
 * the clock, and nothing that is not already on the line. A total says what a run cost and
 * says nothing about whether it is *going*; two runs at the same total are the same picture
 * whether one of them spent it in a minute and the other in an hour.
 */
const RunProgress: React.FC<{ run: RunView }> = ({ run }) => {
  const elapsedMs = useElapsedMs(run.startedAt, run.endedAt)
  if (!run.startedAt) return null
  const thinking = run.usage?.thinkingTokens
  // A finished run's average is a fact about that run, so it stops with `endedAt` — the clock
  // it divides by is the frozen one, not a live one that would walk the figure towards zero
  // for as long as the panel is left open.
  const rate = run.usage
    ? averageRate(run.usage.inputTokens + run.usage.outputTokens, elapsedMs)
    : null
  return (
    <p className="element-docs__progress">
      {elapsedMs !== null && formatDuration(elapsedMs)}
      {run.usage && (
        <span className="element-docs__tokens">
          {' · '}{formatTokens(run.usage.inputTokens)} in
          {' · '}{formatTokens(run.usage.outputTokens)} out
          {typeof thinking === 'number' && (
            <span
              className="element-docs__thinking"
              title="Of the output tokens, how many the agent spent on internal reasoning. Its own estimate, and already inside the figure before it."
            >
              {' ('}{formatTokens(thinking)} thinking{')'}
            </span>
          )}
          {rate && (
            <span
              className="element-docs__rate"
              title="Input and output together, averaged over the whole run. A finished run's average stops with it."
            >
              {' · '}{rate}
            </span>
          )}
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
  // `NO_IMPLEMENT` under the remembered copy rather than instead of it: the cache holds three
  // of these seven fields, so spreading it alone left a view missing the four it does not keep.
  const fromShape: ImplementView | null = issue?.implementState
    ? {
        ...NO_IMPLEMENT,
        ...(remembered?.implement ?? {}),
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
    implement: fromShape ?? (remembered ? { ...NO_IMPLEMENT, ...remembered.implement } : NO_IMPLEMENT)
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
  onImplementIssue, onResetImplement, onResetIssue, onAdoptIssue, onAddComment,
  onRecreateIssue, onAttachImages, onDetachImage,
  founder, founderAction, founderControls, onResolveFounder, onSendFounderChat, onReadFounderChat
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
  /**
   * The observations a rewrite is being asked for, and what became of the run.
   *
   * Separate state from the comment box above rather than one box with two buttons: the two
   * write different things — one appends to the issue, the other replaces it — and a control
   * that changed meaning depending on which button was pressed last is how somebody rewrites
   * an issue they meant to annotate.
   */
  const [recreating, setRecreating] = useState(false)
  const [recreateDraft, setRecreateDraft] = useState('')
  const [recreateSending, setRecreateSending] = useState(false)
  const [recreateState, setRecreateState] = useState<PanelRunState>(null)
  const [recreateError, setRecreateError] = useState<string | null>(null)
  /** The clock and the totals of the rewrite, off the same record its state comes from. */
  const [recreateRun, setRecreateRun] = useState<RunView>(NO_RUN)
  /**
   * What the block's own research run has spent.
   *
   * Only the figures are read here. The two instants are on the element and arrive over the
   * socket, so the clock is already right before this lands — which is what keeps a block
   * readable with no network, and what stops the poll being the thing the clock depends on.
   */
  const [issueRun, setIssueRun] = useState<RunView>(NO_RUN)
  /**
   * Whether the research run was still going the last time this looked.
   *
   * The same reason `wasRunning` exists for the implementation: the ending arrives over the
   * socket as an element update carrying the state and not the figures, so a run that settles
   * under the reader's eyes needs one last read to replace whatever total was polled while it
   * was still going.
   */
  const wasResearching = useRef(false)
  /**
   * Whether the run being watched is one this panel started.
   *
   * The record outlives the run — it is kept against the issue URL until the server restarts
   * — so a card selected an hour later would otherwise still be announcing a rewrite nobody
   * is waiting for. Only the panel that started one reports its ending.
   */
  const wasRecreating = useRef(false)
  // The URL of an issue this block already produced, and whether the box for it is open.
  const [adopting, setAdopting] = useState(false)
  const [adoptUrl, setAdoptUrl] = useState('')
  const [adoptError, setAdoptError] = useState<string | null>(null)
  const [adopted, setAdopted] = useState(false)

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
          if (body?.code === NO_DOCS_DIR) {
            setDoc({ status: 'no-docs-dir', key: docKey, message: body?.error ?? '' })
            return
          }
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
    // Half-written observations belong to the issue they were being written about, and a run
    // being watched belongs to the shape that started it — neither is carried across.
    setRecreating(false)
    setRecreateDraft('')
    setRecreateState(null)
    setRecreateError(null)
    wasRecreating.current = false
    // Both sets of figures belong to the run they were spent on, and the polls above are one
    // tick behind a selection that changed — so they are cleared rather than carried, or the
    // next block would open showing what the last one spent.
    setRecreateRun(NO_RUN)
    setIssueRun(NO_RUN)
    wasResearching.current = false
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

  /**
   * What the block's research run is spending, while it spends it.
   *
   * Polled rather than pushed, and only the figures are polled. They cannot ride on the
   * element: a total that changes throughout a run would bump the shape's `version` and
   * broadcast an update every time it moved, which is the churn the clock beside it is
   * careful to avoid. So the server keeps them on a record and the panel asks — a read of
   * memory, with no `gh` behind it.
   *
   * The last read is the one that matters and is why the record outlives the run: the ending
   * arrives over the socket as an element update, carrying the state and not the figures, so
   * without it the panel would keep whichever total it happened to poll while the run was
   * still going.
   */
  useEffect(() => {
    const blockId = issue?.id
    if (!blockId || !issueState) return

    let cancelled = false
    const read = (): void => {
      fetch(`/api/issue-block/${encodeURIComponent(blockId)}/run?workspace=${encodeURIComponent(workspace)}`)
        .then((response) => response.json())
        .then((body) => {
          if (cancelled || !body?.success) return
          setIssueRun(runView(body.run))
        })
        .catch(() => undefined)
    }

    if (issueState !== 'running') {
      if (wasResearching.current) read()
      wasResearching.current = false
      return () => { cancelled = true }
    }

    wasResearching.current = true
    read()
    const timer = setInterval(read, 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [issue?.id, issueState, workspace])

  /**
   * Whether the issue is being researched again, and what that run left behind.
   *
   * Polled rather than pushed, for the reason the implement record is: a mirrored card has no
   * element for the socket to update, and a recreate writes nothing onto a shape while it
   * runs. Read once on every selection too, so a reader who clicked away from a run and back
   * is told it is still going rather than being offered to start a second one.
   *
   * A run that settles under the reader's eyes is the case this exists for: the body on
   * screen is now the one the run replaced, and everything remembering it — the server's memo
   * and this browser's cache — has to be dropped before the issue is read again.
   */
  useEffect(() => {
    if (!issueUrl || issueState !== 'created') return

    let cancelled = false
    const read = (): void => {
      fetch(`/api/issue/recreate?url=${encodeURIComponent(issueUrl)}&workspace=${encodeURIComponent(workspace)}`)
        .then((response) => response.json())
        .then((body) => {
          if (cancelled || !body?.success) return
          const record = (body.recreate ?? null) as Record<string, unknown> | null
          const state = (record?.state as PanelRunState) ?? null
          setRecreateState(state === 'done' && !wasRecreating.current ? null : state)
          setRecreateError(
            state === 'failed' ? ((record?.error as string) ?? 'The run failed.') : null
          )
          setRecreateRun(runView(record))
        })
        .catch(() => undefined)
    }

    if (recreateState !== 'running') {
      if (wasRecreating.current) {
        wasRecreating.current = false
        forgetIssue(workspace, issueUrl)
        fetch(`/api/issue?url=${encodeURIComponent(issueUrl)}&workspace=${encodeURIComponent(workspace)}`)
          .then((response) => response.json())
          .then((body) => {
            if (cancelled || !body?.success) return
            const view = implementView(body.implement)
            rememberIssue(workspace, issueUrl, { issue: body.issue ?? {}, implement: view })
            setIssueDetail(loadedIssue(body.issue ?? {}))
          })
          .catch(() => undefined)
      } else {
        read()
      }
      return () => { cancelled = true }
    }

    const timer = setInterval(read, 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [issueUrl, issueState, workspace, recreateState])

  /**
   * Ask for the issue to be researched again, from what is in the box.
   *
   * Optimistic like starting a run is, and for the same reason: the route answers as soon as
   * the agent is under way and the result arrives minutes later. On a refusal the text stays
   * in the box — it is the only copy of itself.
   */
  const startRecreate = async (): Promise<void> => {
    if (!issue || !onRecreateIssue) return

    setRecreateSending(true)
    setRecreateError(null)
    const error = await onRecreateIssue(issue, recreateDraft)
    setRecreateSending(false)
    if (error) {
      setRecreateError(error)
      return
    }
    wasRecreating.current = true
    setRecreateState('running')
    setRecreating(false)
    setRecreateDraft('')
  }

  // What GitHub says about the issue, once it has said anything. Null while it is being
  // read, which is not the same as open — the controls below treat it as "unknown" rather
  // than guessing, so nothing appears and then vanishes a second later.
  const githubState = issueDetail.status === 'loaded' ? issueDetail.state : null
  const closure = closureView({
    githubState,
    stateReason: issueDetail.status === 'loaded' ? issueDetail.stateReason : null,
    closedBy: issueDetail.status === 'loaded' ? issueDetail.closedBy : []
  })

  /**
   * Start the run behind either button.
   *
   * Optimistic, because the run itself answers immediately and the result arrives later —
   * over the socket for a block, by asking for a card. The clock starts from here for the
   * same reason, and is replaced by the server's own instant the moment one arrives.
   *
   * Written through to what is remembered as well, or the next selection would paint the
   * record from before the click and offer to start the run a second time.
   *
   * One function for all three controls: what differs between resuming, starting over and
   * asking for a tab to answer is a flag the server reads, and everything the panel does
   * about it — the optimistic state, the cache, the failure — is identical. A board that can
   * only refuse the third one with a 409 needs that failure to land where the other two do.
   */
  const startRun = async (resume: boolean, interactive = false): Promise<void> => {
    if (!issue || !onImplementIssue) return

    const started: ImplementView = {
      ...NO_IMPLEMENT, state: 'running', startedAt: new Date().toISOString()
    }
    setImplement(started)
    if (issueUrl) rememberImplement(workspace, issueUrl, started)
    const error = await onImplementIssue(issue, resume, interactive)
    if (error) {
      const failed: ImplementView = { ...NO_IMPLEMENT, state: 'failed', error }
      setImplement(failed)
      if (issueUrl) rememberImplement(workspace, issueUrl, failed)
    }
  }

  return (
    <div className="element-docs">
      {/* First, and above the document: a founder card carries no `issue`, so nothing below
          this can draw an Implement, Resume, Fix or Recreate control for one. */}
      {founder && (
        <FounderPanel
          key={founder.key}
          target={founder}
          action={founderAction ?? null}
          controls={founderControls ?? null}
          onResolve={onResolveFounder}
          onSend={onSendFounderChat}
          onRead={onReadFounderChat}
        />
      )}

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
                {implement.state !== null && <RunProgress run={implement} />}

                {implement.state === 'running' && (
                  <>
                    <p className="element-docs__hint">
                      {implement.recovered
                        ? 'The first attempt ended without opening or merging a pull request, '
                          + 'so a second one is finishing it. This is the last — nothing tries again '
                          + 'after it.'
                        : 'An agent is implementing this issue in the project. There is no time '
                          + 'limit on the run.'}
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

                {/* Not a failure and not a run: an attempt whose server died, found again by
                    looking at the checkout it left behind. Said in words because the board
                    deliberately draws it as nothing — a card that changed outline on its own
                    at every restart would be worse than one that stayed put. */}
                {implement.state === 'interrupted' && (
                  <p className="element-docs__hint">
                    {implement.error
                      ?? 'A previous attempt at this issue was interrupted and its checkout still holds work.'}
                    {' '}Resume continues in that checkout, after reading what is in it;
                    Implement / Fix starts the issue again. There is nothing to reset — this is
                    read from the checkout, so it comes back until the work there is finished or
                    thrown away.
                  </p>
                )}

                {implement.state === 'failed' && (
                  <p className="element-docs__error">{implement.error ?? 'The run failed.'}</p>
                )}

                {/* Said after the failure rather than instead of it. A run that was tried twice
                    and failed anyway is a different thing from one that failed once, and a board
                    that tells the same story about both invites a third attempt by hand. */}
                {implement.state === 'failed' && implement.recovered && (
                  <p className="element-docs__hint">
                    This was tried twice — the first attempt ended without a pull request and a
                    second was started to finish it. Nothing will try again on its own.
                  </p>
                )}

                {/* A run that ended correctly without landing anything: the agent could not
                    reconcile a conflict and stopped for a person, which its prompt tells it to
                    do. A hint rather than an error, because nothing here went wrong — and not a
                    new button, because the action row already carries five. */}
                {implement.state === 'blocked' && (
                  <p className="element-docs__hint">
                    {implement.error
                      ?? 'The run stopped and asked for a person. Its pull request is open.'}
                  </p>
                )}

                {/* The pull request of a run that did not land. Separate from the "Implemented"
                    link above and deliberately worded differently: that one is gated on `done`
                    and would otherwise call an unmerged pull request shipped. A board that has
                    just been told where the pull request is must still say where it is. */}
                {implement.state !== 'done' && implement.url && (
                  <a
                    className="element-docs__issue-link"
                    href={implement.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Not merged · {implement.url.replace(/^https:\/\/github\.com\//, '')}
                  </a>
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

                  {/* Beside adding observations, because the two are the same gesture with
                      different consequences: one appends to the issue, the other replaces
                      it. Offered only while nothing has been started against the issue —
                      past that, rewriting a body would change the specification behind a
                      running agent's back. */}
                  {onRecreateIssue && recreateState !== 'running'
                    && offersRecreate({
                      githubState,
                      implementState: implement.state,
                      recreatable: issue.recreatable === true
                    }) && (
                    <button
                      type="button"
                      className="element-docs__collapse element-docs__action"
                      onClick={() => {
                        setRecreateError(null)
                        setRecreating((open) => !open)
                      }}
                    >
                      Recreate with observations
                    </button>
                  )}

                  {/* Before Implement / Fix, because for an interrupted run it is the
                      answer more often — and because the two must not be one control that
                      changes meaning with the state, which is how somebody starts over on
                      top of work they did not know was there. */}
                  {offersResume({ githubState, implementState: implement.state }) && onImplementIssue && (
                    <button
                      type="button"
                      className="element-docs__collapse element-docs__action"
                      onClick={() => startRun(true)}
                    >
                      Resume
                    </button>
                  )}

                  {offersImplement({ githubState, implementState: implement.state }) && onImplementIssue && (
                    <button
                      type="button"
                      className="element-docs__collapse element-docs__action"
                      onClick={() => startRun(false)}
                    >
                      Implement / Fix
                    </button>
                  )}

                  {/* The same run, in a tab that is something to answer rather than something
                      to watch — #220. It was the shape of `EXCALIDRAW_IMPLEMENT_AGENT` and a
                      server restart, which is a setting nobody reading the board could find,
                      and it has now been asked for twice.

                      Beside "Implement / Fix" rather than instead of it, because the trade is
                      real and belongs to whoever is clicking: an interactive run does not end
                      by itself and the token figures go silent, so the queue wants the
                      headless one. Offered wherever the ordinary run is, and last, so the
                      button under the pointer is still the one it always was. */}
                  {offersImplement({ githubState, implementState: implement.state }) && onImplementIssue && (
                    <button
                      type="button"
                      className="element-docs__collapse element-docs__action"
                      title="The same run, in a terminal tab you can type into: the prompt goes to the agent as an argument instead of down its stdin, so it starts its own interface. It will not end by itself — close the tab when it is done — and it reports no token counts."
                      onClick={() => startRun(false, true)}
                    >
                      Implement, and let me answer
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

                {recreating && onRecreateIssue && (
                  <div className="element-docs__compose">
                    <textarea
                      className="element-docs__draft"
                      value={recreateDraft}
                      autoFocus
                      placeholder="What the first investigation got wrong. An agent reads the issue, its comments and this, investigates the repository again, and rewrites the issue in place — same number, same comments."
                      onChange={(event) => setRecreateDraft(event.target.value)}
                    />
                    <div className="element-docs__actions">
                      <button
                        type="button"
                        className="element-docs__collapse element-docs__action"
                        disabled={recreateSending || !recreateDraft.trim()}
                        onClick={() => { void startRecreate() }}
                      >
                        {recreateSending ? 'Starting…' : 'Research it again'}
                      </button>
                      <button
                        type="button"
                        className="element-docs__collapse element-docs__action"
                        disabled={recreateSending}
                        onClick={() => {
                          setRecreating(false)
                          setRecreateDraft('')
                          setRecreateError(null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {recreateState === 'running' && (
                  <p className="element-docs__hint">
                    An agent is investigating this issue again and will rewrite it in place.
                    The observations are already on the issue as a comment. This takes minutes,
                    and there is no time limit on the run.
                  </p>
                )}
                {recreateState === 'done' && (
                  <p className="element-docs__hint">
                    The issue was rewritten. Its number, its card and its comments are unchanged.
                  </p>
                )}
                {/* Under whichever sentence applies, because the sentence says what is
                    happening and this says how far in. A rewrite keeps both instants on its
                    record, so the total stays on screen once it is over rather than
                    disappearing at the moment it is worth reading. */}
                {recreateState !== null && <RunProgress run={recreateRun} />}
                {recreateError && <p className="element-docs__error">{recreateError}</p>}
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
              {/* The number that sentence was missing. Assembled from two sources on purpose:
                  the instants come off the element, so the clock is right on the first frame
                  and with no network, and only the totals wait for the poll — a figure that
                  moves throughout a run cannot live on a shape without rewriting it every
                  time it moves. */}
              <RunProgress
                run={{
                  startedAt: issue.issueStartedAt ?? issueRun.startedAt,
                  endedAt: issue.issueEndedAt ?? issueRun.endedAt,
                  usage: issueRun.usage
                }}
              />
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

          {/* Below the run rather than beside it, and worded as a statement of fact rather
              than as an action: this is for the block whose run succeeded and whose result
              never came back (#118), and the wrong reading of it — "make an issue for this"
              — is the button directly above. Offered wherever a run is, because that is
              exactly the state such a block is stranded in: no `issueUrl`, so nothing else
              in the panel can reach it, and a run would open a second issue for an
              observation that already has one. */}
          {issue.state !== 'created' && issue.state !== 'running' && onAdoptIssue && (
            <div className="element-docs__adopt">
              {!adopting && (
                <button
                  type="button"
                  className="element-docs__collapse"
                  onClick={() => { setAdoptError(null); setAdopting(true) }}
                >
                  This block already has an issue
                </button>
              )}

              {adopting && (
                <div className="element-docs__compose">
                  <p className="element-docs__hint">
                    For a run that made its issue and never got the URL back onto the block.
                    The issue is read to confirm it exists; nothing new is created.
                  </p>
                  <input
                    type="url"
                    className="element-docs__url"
                    value={adoptUrl}
                    autoFocus
                    placeholder="https://github.com/owner/repo/issues/94"
                    onChange={(event) => setAdoptUrl(event.target.value)}
                  />
                  <div className="element-docs__actions">
                    <button
                      type="button"
                      className="element-docs__collapse element-docs__action"
                      disabled={adopted || !adoptUrl.trim()}
                      onClick={async () => {
                        setAdopted(true)
                        setAdoptError(null)
                        const error = await onAdoptIssue(issue, adoptUrl.trim())
                        setAdopted(false)
                        // The URL stays in the box on a failure: retyping it is the one thing
                        // a reader who mistyped it does not want to do twice.
                        if (error) { setAdoptError(error); return }
                        setAdoptUrl('')
                        setAdopting(false)
                      }}
                    >
                      {adopted ? 'Reading the issue…' : 'Record it on this block'}
                    </button>
                    <button
                      type="button"
                      className="element-docs__collapse element-docs__action"
                      disabled={adopted}
                      onClick={() => { setAdopting(false); setAdoptUrl(''); setAdoptError(null) }}
                    >
                      Cancel
                    </button>
                  </div>
                  {adoptError && <p className="element-docs__error">{adoptError}</p>}
                </div>
              )}
            </div>
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

      {/* Not a missing document — a board that could not have found one. The repair is a
          setting, and it is already in the UI, so the card names where it is rather than
          leaving the reader to guess which of the two problems they have. */}
      {doc.status === 'no-docs-dir' && (
        <>
          <h2 className="element-docs__title">{title || doc.key}</h2>
          <p className="element-docs__hint">
            This board has no docs directory, so <code>{doc.key}</code> — and every other
            document on it — cannot be found.
          </p>
          <p className="element-docs__hint">
            Set <strong>Docs folder</strong> in the project settings, reachable from the
            gear on this project&rsquo;s tab, to the folder inside the project where its
            markdown lives.
          </p>
          {doc.message && <p className="element-docs__hint">{doc.message}</p>}
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
