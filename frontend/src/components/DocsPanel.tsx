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
  /** Set when the selected shape is an issue block. */
  issue?: IssueTarget | null
  onCreateIssue?: (id: string) => void
}

/**
 * Everything the documentation panel shows, with no opinion about where it sits.
 *
 * Split out from the panel itself so the fetching, sanitising and the
 * loading / missing / error / loaded states are written once. What changed when the
 * panel moved off the window edge was its position, not any of this.
 */
export const DocsPanelBody: React.FC<DocsPanelBodyProps> = ({
  docKey, title, workspace, collapsible, onToggleCollapse, issue, onCreateIssue
}) => {
  const [doc, setDoc] = useState<DocState>({ status: 'empty' })
  const [issueDetail, setIssueDetail] = useState<IssueDetailState>({ status: 'idle' })

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

  const issueId = issue?.id ?? null
  const issueState = issue?.state ?? null

  // The issue is read on selection, not stored on the element — so an edit made on
  // GitHub shows up here without the board being touched.
  useEffect(() => {
    if (!issueId || issueState !== 'created') {
      setIssueDetail({ status: 'idle' })
      return
    }

    let cancelled = false
    setIssueDetail({ status: 'loading' })

    fetch(`/api/issue-block/${encodeURIComponent(issueId)}/issue?workspace=${encodeURIComponent(workspace)}`)
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
      })
      .catch((error: Error) => {
        if (!cancelled) setIssueDetail({ status: 'error', message: error.message })
      })

    return () => { cancelled = true }
  }, [issueId, issueState, workspace])

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
            <p className="element-docs__hint">
              Researching the repository and drafting the issue. This takes minutes.
            </p>
          )}

          {issue.state === 'failed' && (
            <p className="element-docs__error">{issue.issueError ?? 'The run failed.'}</p>
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
