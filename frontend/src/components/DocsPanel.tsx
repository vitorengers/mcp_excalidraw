import React, { useEffect, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
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
}

/** The issue itself, read live when a created block is selected. */
type IssueDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; title: string; html: string; state: string; number: number }
  | { status: 'error'; message: string }

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
}

/** What is known about implementing the issue, wherever it was learned. */
interface ImplementView {
  state: 'running' | 'done' | 'failed' | null
  url: string | null
  error: string | null
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
  onImplementIssue, onResetImplement, onResetIssue, onAttachImages, onDetachImage
}) => {
  const [doc, setDoc] = useState<DocState>({ status: 'empty' })
  const [issueDetail, setIssueDetail] = useState<IssueDetailState>({ status: 'idle' })
  const [implement, setImplement] = useState<ImplementView>({ state: null, url: null, error: null })
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

  // An authored block carries a copy of the state, which arrives over the socket and is
  // what makes a block read correctly before any fetch lands. A card carries none, so this
  // simply never fires for one.
  useEffect(() => {
    if (!issue?.implementState) return
    setImplement({
      state: issue.implementState,
      url: issue.implementUrl ?? null,
      error: issue.implementError ?? null
    })
  }, [issue?.implementState, issue?.implementUrl, issue?.implementError])

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
        const html = DOMPurify.sanitize(marked.parse(body.markdown ?? '', { async: false }) as string)
        setDoc({ status: 'loaded', key: docKey, html })
      })
      .catch((error: Error) => {
        if (!cancelled) setDoc({ status: 'error', key: docKey, message: error.message })
      })

    return () => { cancelled = true }
  }, [docKey, workspace])

  const issueState = issue?.state ?? null
  const issueUrl = issue?.issueUrl ?? null

  // A refusal belongs to the block it was refused for, and to the state it was refused in.
  // The panel outlives both, so it would otherwise carry one to the next block selected.
  useEffect(() => { setResetError(null) }, [issue?.id, issueState])

  // Read by issue URL, not by element id: a mirrored card is drawn from GitHub and never
  // reaches the server, so it has no id to ask about — but it has the issue, which is the
  // thing being read. Read on selection rather than stored, so an edit made on GitHub
  // shows up here without the board being touched.
  useEffect(() => {
    if (!issueUrl || issueState !== 'created') {
      setIssueDetail({ status: 'idle' })
      setImplement({ state: null, url: null, error: null })
      return
    }

    let cancelled = false
    setIssueDetail({ status: 'loading' })

    fetch(`/api/issue?url=${encodeURIComponent(issueUrl)}&workspace=${encodeURIComponent(workspace)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (cancelled) return
        if (!response.ok) {
          setIssueDetail({ status: 'error', message: body?.error ?? `HTTP ${response.status}` })
          return
        }
        // Issue bodies are written by an agent and by whoever edits them on GitHub —
        // sanitise for the same reason the docs are sanitised.
        const html = DOMPurify.sanitize(marked.parse(body.issue?.body ?? '', { async: false }) as string)
        setIssueDetail({
          status: 'loaded',
          title: body.issue?.title ?? '',
          html,
          state: body.issue?.state ?? '',
          number: body.issue?.number ?? 0
        })
        setImplement({
          state: body.implement?.state ?? null,
          url: body.implement?.url ?? null,
          error: body.implement?.error ?? null
        })
      })
      .catch((error: Error) => {
        if (!cancelled) setIssueDetail({ status: 'error', message: error.message })
      })

    return () => { cancelled = true }
  }, [issueUrl, issueState, workspace])

  // An authored block hears the result over the socket, as an element update. A card
  // cannot — there is no element — so while a run is in flight it asks. This reads only
  // the record, so it costs no `gh` process.
  useEffect(() => {
    if (!issueUrl || implement.state !== 'running') return

    let cancelled = false
    const timer = setInterval(() => {
      fetch(`/api/implement?url=${encodeURIComponent(issueUrl)}&workspace=${encodeURIComponent(workspace)}`)
        .then((response) => response.json())
        .then((body) => {
          if (cancelled || !body?.success) return
          setImplement({
            state: body.implement?.state ?? null,
            url: body.implement?.url ?? null,
            error: body.implement?.error ?? null
          })
        })
        .catch(() => undefined)
    }, 4000)

    return () => { cancelled = true; clearInterval(timer) }
  }, [issueUrl, implement.state, workspace])

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
                          else setImplement({ state: null, url: null, error: null })
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

                {implement.state !== 'done' && implement.state !== 'running' && onImplementIssue && (
                  <button
                    type="button"
                    className="element-docs__collapse"
                    onClick={async () => {
                      // Optimistic, because the run itself answers immediately and the
                      // result arrives later — over the socket for a block, by asking for
                      // a card.
                      setImplement({ state: 'running', url: null, error: null })
                      const error = await onImplementIssue(issue)
                      if (error) setImplement({ state: 'failed', url: null, error })
                    }}
                  >
                    Implement / Fix
                  </button>
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
