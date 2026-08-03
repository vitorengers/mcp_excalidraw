import React, { useCallback, useEffect, useRef, useState } from 'react'
import { PAIRING_GRANT_SENTENCE } from '../../../src/core/pairing-grants'
import './PairingApproval.css'

/**
 * The approval, on the machine the board is running on.
 *
 * A device on the network asked to be let in (#503). Nothing about that request is a thing this
 * server can judge: the name is whatever the device typed, the authority is whatever the operator's
 * network calls this machine, and the code is the only thing that ties the row on this screen to
 * the screen the person is actually standing in front of. So this dialog does not ask "pair this
 * device?" — it lays out the four things a person can judge and gets out of the way.
 *
 * The shape is `ClearCanvasButton`'s and `RestartButton`'s, because this is the same kind of
 * decision: one that cannot be taken back quietly. What it does differently is the two ways it
 * differs from a confirmation:
 *
 *  - **It is raised rather than opened.** Nobody pressed anything here; a machine somewhere else
 *    did. So it is a modal over the board rather than a card hanging off a button, and it names
 *    what is asking before it names what it wants.
 *  - **Refuse is the default and dismissing is a refusal.** Escape, the backdrop and the Refuse
 *    button are one answer, and it is `no`. A prompt that can only be answered `yes` teaches
 *    people to answer `yes`, and this is the prompt where that costs a shell.
 *
 * Polled rather than pushed. The board's WebSocket would be the obvious carrier and is the wrong
 * one: it is behind the same guard the rest of the board is, it is refused on a bind this feature
 * exists to make usable, and a request the operator never sees because a socket was reconnecting
 * is the failure that turns a gesture back into a configuration step. Two seconds is faster than a
 * person can walk between two screens.
 */

/** The hosts a browser reaches this board on when it is the machine running it. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** How often the board asks what is waiting. */
const POLL_MS = 2000

interface PendingPairing {
  requestId: string
  code: string
  name: string
  remoteAddress: string
  host: string
}

/** What became of the operator's press. Only a failure has anything to say afterwards. */
type Answering = { requestId: string; error: string } | null

export const PairingApproval: React.FC = () => {
  const [requests, setRequests] = useState<PendingPairing[]>([])
  const [answering, setAnswering] = useState<Answering>(null)
  const [busy, setBusy] = useState(false)
  const refuseButton = useRef<HTMLButtonElement | null>(null)
  const approveButton = useRef<HTMLButtonElement | null>(null)
  const gone = useRef(false)

  useEffect(() => () => { gone.current = true }, [])

  /**
   * Only asked where the route is.
   *
   * `GET /api/pair/pending` refuses a caller that is not on this machine, so a paired device
   * showing the board would poll a 403 every two seconds for as long as it was open. This is the
   * operator's screen and it is only on the operator's screen.
   */
  const isHost = LOOPBACK_HOSTS.has(window.location.hostname)

  useEffect(() => {
    if (!isHost) return undefined
    let stopped = false
    const read = async (): Promise<void> => {
      try {
        const response = await fetch('/api/pair/pending', { cache: 'no-store' })
        if (!response.ok) return
        const body = await response.json() as { requests?: PendingPairing[] }
        if (!stopped && !gone.current) setRequests(body.requests ?? [])
      } catch {
        // The board this asks is the one being restarted, or the network is the loopback
        // interface having a moment. Either way the next tick asks again.
      }
    }
    void read()
    const timer = window.setInterval(() => { void read() }, POLL_MS)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [isHost])

  /**
   * The oldest waiting request, and only ever one.
   *
   * `GET /api/pair/pending` answers oldest first and may hold up to eight. A list of eight
   * prompts is not a thing a person compares a code against — it is a thing they clear — so they
   * are answered one at a time, in the order they arrived. Answering the front one brings the
   * next one up, and every one of them expires on its own.
   */
  const request = requests[0] ?? null

  /** Both answers, which differ only in the route and in what the operator has to have read. */
  const answer = useCallback(async (verdict: 'approve' | 'refuse'): Promise<void> => {
    if (!request || busy) return
    setBusy(true)
    // Optimistic, and deliberately so: the press has to close the dialog now rather than in up
    // to two seconds' time, or the operator presses it again — and the second press lands on
    // whichever request the poll brought up next.
    const answered = request.requestId
    setRequests((held) => held.filter((entry) => entry.requestId !== answered))
    setAnswering(null)
    try {
      const response = await fetch(`/api/pair/${verdict}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The code goes with an approval and not with a refusal: approving is choosing which
        // request to let in, and refusing is declining to choose.
        body: JSON.stringify(verdict === 'approve'
          ? { requestId: answered, code: request.code }
          : { requestId: answered }),
      })
      const body = await response.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (!response.ok || !body.success) {
        if (!gone.current) {
          setAnswering({ requestId: answered, error: body.error ?? `The board refused it (${response.status}).` })
        }
      }
    } catch (error) {
      if (!gone.current) setAnswering({ requestId: answered, error: (error as Error).message })
    } finally {
      if (!gone.current) setBusy(false)
    }
  }, [busy, request])

  /**
   * The keyboard half, and the whole of what makes this dismissible without a mouse.
   *
   * Escape refuses. Tab is trapped between the two buttons, because a dialog a person can tab
   * out of is one they can answer by pressing Enter on whatever the board behind it had focused —
   * and what is behind this one is a canvas full of controls.
   */
  useEffect(() => {
    if (!request) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void answer('refuse')
        return
      }
      if (event.key !== 'Tab') return
      const stops = [refuseButton.current, approveButton.current].filter(Boolean) as HTMLElement[]
      if (stops.length < 2) return
      event.preventDefault()
      const at = stops.indexOf(document.activeElement as HTMLElement)
      const step = event.shiftKey ? -1 : 1
      const next = at === -1 ? 0 : (at + step + stops.length) % stops.length
      stops[next].focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [answer, request])

  /**
   * Refuse takes the focus the moment a request comes up, and again when the next one does.
   *
   * The default answer is the one a key pressed by reflex should give. Keyed on the request
   * rather than on the dialog existing, so a second request arriving does not leave the focus on
   * an Approve the operator aimed at the first one.
   */
  useEffect(() => {
    if (!request) return
    refuseButton.current?.focus()
  }, [request?.requestId])

  if (!isHost) return null

  const failure = answering && !request ? answering.error : null

  return (
    <>
      {request && (
        <div
          className="pairing-approval__scrim"
          // Dismissing is refusing, here as at the Escape key. A backdrop press that merely
          // closed the dialog would leave the device waiting on an answer that was given.
          onMouseDown={() => { void answer('refuse') }}
        />
      )}
      {request && (
        <div
          className="pairing-approval"
          data-pairing-approval=""
          role="dialog"
          aria-modal="true"
          aria-label="A device is asking to pair with this board"
        >
          <p className="pairing-approval__lede">A device is asking to pair with this board.</p>

          {/*
            The code first and largest. It is the only thing on this dialog that ties the request
            to the screen the person can see from here, and it is meant to be read across a desk.
          */}
          <p className="pairing-approval__code-label">The code on its screen should read</p>
          <p className="pairing-approval__code" data-pairing-code="">{request.code}</p>

          <dl className="pairing-approval__facts">
            <dt>It calls itself</dt>
            <dd>
              <span className="pairing-approval__claim" data-pairing-claimed-name="">{request.name}</span>
              {' '}
              {/* Its own claim, and marked as one: nothing checked it, and a stranger types
                  whatever a laptop across the room would have typed. */}
              <span className="pairing-approval__aside">— its own words, not this board&rsquo;s</span>
            </dd>

            <dt>It reached this board as</dt>
            <dd><code data-pairing-host="">{request.host || '(no Host header)'}</code></dd>

            <dt>It came from</dt>
            <dd><code data-pairing-address="">{request.remoteAddress || '(an unrecorded address)'}</code></dd>
          </dl>

          {/*
            One sentence, and it is `src/core/pairing-grants.ts`'s rather than this file's, so a
            check can hold it to the routes it is a claim about.
            See scripts/check-pairing-surfaces-browser.mjs.
          */}
          <p className="pairing-approval__grants" data-pairing-grants="">{PAIRING_GRANT_SENTENCE}</p>

          <p className="pairing-approval__aside">
            A name that resolves to this machine is not the same thing as this board. If you do not
            recognise all three of those, refuse — refusing costs whoever it was one more press.
          </p>

          {answering?.requestId === request.requestId && (
            <p className="pairing-approval__failure">{answering.error}</p>
          )}

          <div className="pairing-approval__actions">
            {/*
              Refuse first in the DOM as well as in the focus order, and the same weight as
              approve. The dangerous press is the one that should take a moment.
            */}
            <button
              ref={refuseButton}
              className="pairing-approval__button pairing-approval__refuse"
              data-pairing-refuse=""
              onClick={() => { void answer('refuse') }}
              disabled={busy}
            >
              Refuse
            </button>
            <button
              ref={approveButton}
              className="pairing-approval__button pairing-approval__approve"
              data-pairing-approve=""
              onClick={() => { void answer('approve') }}
              disabled={busy}
            >
              Approve {request.code}
            </button>
          </div>
        </div>
      )}

      {/* A press that failed after the dialog closed still owes the operator a sentence. */}
      {failure && <p className="pairing-approval__orphan-failure">{failure}</p>}
    </>
  )
}
