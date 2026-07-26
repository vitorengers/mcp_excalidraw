import React, { useEffect, useState } from 'react'
import { Sidebar } from '@excalidraw/excalidraw'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import './ElementDocsPanel.css'

export const DOCS_SIDEBAR_NAME = 'element-docs'

type DocState =
  | { status: 'empty' }
  | { status: 'loading'; key: string }
  | { status: 'loaded'; key: string; html: string }
  | { status: 'missing'; key: string }
  | { status: 'error'; key: string; message: string }

interface Props {
  /** `customData.docKey` of the selected element, or null when nothing is selected. */
  docKey: string | null
  /** Label shown as the panel heading — usually the shape's own text. */
  title?: string | null
  /** Board the shape belongs to; each project serves docs from its own directory. */
  workspace: string
  docked: boolean
  onDock: (docked: boolean) => void
}

/**
 * Side panel showing the markdown attached to the selected shape.
 *
 * A box on the board holds a short label; the reasoning behind it does not fit and
 * does not belong in a drawing. This renders that reasoning next to the canvas so
 * reading it never means leaving the board.
 */
export const ElementDocsPanel: React.FC<Props> = ({ docKey, title, workspace, docked, onDock }) => {
  const [doc, setDoc] = useState<DocState>({ status: 'empty' })

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

  return (
    <Sidebar name={DOCS_SIDEBAR_NAME} docked={docked} onDock={onDock}>
      <Sidebar.Header />
      <div className="element-docs">
        {doc.status === 'empty' && (
          <p className="element-docs__hint">Select a shape to see its documentation.</p>
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
    </Sidebar>
  )
}
