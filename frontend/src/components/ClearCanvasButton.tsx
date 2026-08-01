import React, { useEffect, useRef, useState } from 'react'
import './ClearCanvasButton.css'

/**
 * Emptying the board, from the bar the board is drawn under.
 *
 * The button is upstream's and was unguarded: one press fetched every element and deleted it,
 * with no dialog and nothing to say afterwards. That was survivable while the store was memory
 * only — a drawing is somebody's to redraw — but every board is written back to disk a second
 * after it changes now, so the press reaches the *file*. Before #225 it cost a session; since
 * #225 it costs the board.
 *
 * The button stays rather than going. Excalidraw's own menu offers Reset canvas behind a
 * confirmation, so removing this would leave the gesture available and only remove the one
 * copy of it this product controls — and it is the only one that clears the *store*, which is
 * the half that is saved. What it grows instead is the two things a destructive control owes:
 *
 * 1. **A confirmation that names what it is about to take.** This board and this many
 *    elements, not "are you sure?", which tells a reader nothing they did not already know —
 *    the same judgement `RestartButton` was built on, and the reason a reader with two projects
 *    open can tell which one they are standing on before they answer.
 * 2. **A way back.** The count comes from the server rather than from the scene because the
 *    store is what gets emptied, and `DELETE /api/elements/clear` copies it beside the board's
 *    saved state before it does. Where that copy went is what the caller says afterwards.
 *
 * A board with nothing on it opens no dialog. There is nothing to confirm and nothing to
 * lose, and a confirmation for a no-op teaches a reader to dismiss the one that matters.
 */

type Phase = 'idle' | 'counting' | 'confirming' | 'clearing'

interface ClearCanvasButtonProps {
  /** What this board is called, as the tab says it. */
  boardName: string
  /** How many elements the store holds — asked at the moment of the press, not remembered. */
  readCount: () => Promise<number>
  /** Empty it. Saying what happened is the caller's, which is where the canvas already is. */
  onClear: () => Promise<void>
  /** Nothing to confirm: no board is on screen yet. */
  disabled?: boolean
}

export const ClearCanvasButton: React.FC<ClearCanvasButtonProps> = ({
  boardName, readCount, onClear, disabled = false,
}) => {
  const [phase, setPhase] = useState<Phase>('idle')
  const [count, setCount] = useState(0)
  const wrapper = useRef<HTMLDivElement | null>(null)
  /** Set when this unmounts, so a count that outlives the component stops touching state. */
  const gone = useRef(false)

  useEffect(() => () => { gone.current = true }, [])

  useEffect(() => {
    if (phase !== 'confirming') return undefined
    const dismiss = (event: MouseEvent): void => {
      if (!wrapper.current?.contains(event.target as Node)) setPhase('idle')
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPhase('idle')
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [phase])

  const open = async (): Promise<void> => {
    if (phase === 'confirming') { setPhase('idle'); return }
    setPhase('counting')
    let held = 0
    try {
      held = await readCount()
    } catch (error) {
      // The count is the whole content of the dialog, so a board that cannot be counted is a
      // board this must not offer to empty on a guess.
      console.warn('Could not read what is on the board, so Clear Canvas asked nothing:', error)
      if (!gone.current) setPhase('idle')
      return
    }
    if (gone.current) return
    setCount(held)
    setPhase(held > 0 ? 'confirming' : 'idle')
  }

  const clear = async (): Promise<void> => {
    setPhase('clearing')
    try {
      await onClear()
    } finally {
      if (!gone.current) setPhase('idle')
    }
  }

  return (
    <div className="clear-canvas" ref={wrapper}>
      <button
        className="btn-secondary clear-canvas__button"
        onClick={() => { void open() }}
        disabled={disabled || phase === 'counting' || phase === 'clearing'}
        aria-expanded={phase === 'confirming'}
        aria-haspopup="dialog"
        title={`Delete every element on ${boardName}. It asks first, and keeps a copy beside the board’s saved state.`}
      >
        Clear Canvas
      </button>

      {phase === 'confirming' && (
        <div className="clear-canvas__confirm" role="dialog" aria-label="Clear this board">
          <p className="clear-canvas__lede">
            Clear <strong>{boardName}</strong>?
          </p>
          <p className="clear-canvas__detail">
            {count === 1
              ? 'Its 1 element is deleted from the store, and from the copy of this board saved on disk.'
              : `All ${count} elements are deleted from the store, and from the copy of this board saved on disk.`}
          </p>
          <p className="clear-canvas__detail">
            The board as it is now is written to a file beside its saved state first. The canvas
            says where when it is done.
          </p>
          <div className="clear-canvas__actions">
            <button className="btn-secondary clear-canvas__cancel" onClick={() => setPhase('idle')}>
              Cancel
            </button>
            <button className="btn-primary clear-canvas__go" onClick={() => { void clear() }}>
              Clear {count === 1 ? 'it' : `all ${count}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
