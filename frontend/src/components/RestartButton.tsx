import React, { useEffect, useRef, useState } from 'react'
import './RestartButton.css'

/**
 * Restarting the canvas server, from the board it is serving.
 *
 * The server half is `POST /api/restart`, and the reason it exists is that the obvious way to
 * do this from the board — a terminal block — kills the shell running the kill and leaves the
 * port to whatever auto-starts first. So the button asks the server to hand the job to a
 * process outside its own tree, and then waits for a **different pid** to answer. Not for
 * `status: healthy`, which is precisely what the stand-in that once took the port said.
 *
 * Behind a confirmation, because a restart costs things that are not obvious from a button:
 * terminal sessions and in-flight implementation state are in memory and do not survive it.
 * The confirmation names them rather than asking "are you sure?", which tells a reader nothing
 * they did not already know.
 */

/** The hosts a browser reaches this board on when the server is bound to loopback. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Long enough for a server to stop, for the port to free and for a new one to seed its boards. */
const RESTART_TIMEOUT_MS = 90000
const POLL_MS = 500
/** How long the row keeps saying it worked before going quiet again. */
const SETTLED_MS = 6000

interface Health {
  service?: string
  pid?: number
}

type Phase = 'idle' | 'confirming' | 'restarting' | 'done' | 'failed'

async function readHealth(): Promise<Health | null> {
  try {
    const response = await fetch('/health', { cache: 'no-store' })
    return response.ok ? await response.json() as Health : null
  } catch {
    // Expected, and repeatedly: the server this asks is the one being replaced.
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const RestartButton: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle')
  const [note, setNote] = useState<string | null>(null)
  const wrapper = useRef<HTMLDivElement | null>(null)
  /** Set when this unmounts, so a wait that outlives the component stops touching state. */
  const gone = useRef(false)

  useEffect(() => () => { gone.current = true }, [])

  /**
   * Only offered where the route is: the server refuses a restart unless it is bound to
   * loopback, so a board reached over the network would get a 403 from a button that looked
   * live. Shown and disabled rather than hidden — a control that is missing reads as a version
   * without the feature, and this one has a reason it can say.
   */
  const local = LOOPBACK_HOSTS.has(window.location.hostname)

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

  /**
   * Ask, then wait for somebody else to answer.
   *
   * The pid is read *before* the request, because it is the only thing that distinguishes a
   * server that restarted from a server that never went: the port, the URL and every field of
   * `/health` but `pid` are the same either way.
   */
  const restart = async (): Promise<void> => {
    const before = await readHealth()
    setPhase('restarting')
    setNote(null)

    try {
      const response = await fetch('/api/restart', { method: 'POST' })
      const body = await response.json() as { success?: boolean; error?: string; pid?: number }
      if (!response.ok || !body.success) {
        setPhase('failed')
        setNote(body.error ?? `The server refused the restart (${response.status}).`)
        return
      }
    } catch (error) {
      // The exit racing the response is the one failure that is not a failure: the server may
      // be gone before the answer lands. Fall through to the wait, which is the real test.
      console.warn('The restart request did not complete cleanly; waiting for the replacement anyway:', error)
    }

    const was = before?.pid ?? null
    const deadline = Date.now() + RESTART_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      if (gone.current) return
      const now = await readHealth()
      if (now?.service === 'mcp-excalidraw-canvas' && typeof now.pid === 'number' && now.pid !== was) {
        setPhase('done')
        setNote(`Back as pid ${now.pid}.`)
        await sleep(SETTLED_MS)
        if (!gone.current) { setPhase('idle'); setNote(null) }
        return
      }
    }
    if (gone.current) return
    setPhase('failed')
    setNote('No new server answered within 90 seconds. See the restart log named in the server’s output.')
  }

  const label = phase === 'restarting' ? 'Restarting…'
    : phase === 'done' ? 'Restarted'
      : phase === 'failed' ? 'Restart failed'
        : 'Restart Server'

  return (
    <div className="restart-server" ref={wrapper}>
      <button
        className="btn-secondary restart-server__button"
        onClick={() => setPhase((current) => (current === 'confirming' ? 'idle' : 'confirming'))}
        disabled={!local || phase === 'restarting'}
        aria-expanded={phase === 'confirming'}
        aria-haspopup="dialog"
        title={local
          ? 'Stop this canvas server and start it again from a process outside it. Terminal sessions do not survive it.'
          : 'Restarting is only offered on loopback: the server refuses it from anywhere else.'}
      >
        {phase === 'restarting' && <span className="spinner"></span>}
        {label}
      </button>

      {phase === 'confirming' && (
        <div className="restart-server__confirm" role="dialog" aria-label="Restart the canvas server">
          <p className="restart-server__lede">Restart the canvas server?</p>
          <ul className="restart-server__costs">
            <li>Terminal blocks close. A shell and whatever is running in it go with the server.</li>
            <li>Implementations in flight become <em>interrupted</em>, and are re-derived from git.</li>
            <li>The boards survive — they are saved beside the registry, not held in memory.</li>
            <li>This page reconnects by itself. It says Disconnected on the way; no reload.</li>
            <li>It starts the build that is on disk. It does not rebuild.</li>
          </ul>
          <div className="restart-server__actions">
            <button className="btn-secondary" onClick={() => setPhase('idle')}>Cancel</button>
            <button className="btn-primary" onClick={() => { void restart() }}>Restart</button>
          </div>
        </div>
      )}

      {/* Absolutely positioned, so a sentence about what happened never moves the row it is
          reporting on. */}
      {note && phase !== 'confirming' && (
        <p className={`restart-server__note${phase === 'failed' ? ' restart-server__note--failed' : ''}`}>
          {note}
        </p>
      )}
    </div>
  )
}
