import React, { useCallback, useEffect, useRef, useState } from 'react'
import { readDeviceCredential, writeDeviceCredential, forgetDeviceCredential } from '../storage'
import './PairingWaiting.css'

/**
 * The screen on the device asking, which is what loads instead of the board.
 *
 * This is the first thing a person sees on a machine that is not the one running the board, and
 * before #504 that thing was a 403 with the origin gate's sentence in it, or — where the operator
 * had already named the authority — a blank canvas and a console full of refused sockets. Either
 * way the reader's question was "is this thing even here", and neither answered it.
 *
 * So the page says three things, in this order, and nothing else: the code, that it is waiting,
 * and where to go and approve it. The code first because that is the half the person carries to
 * the other screen; the rest because a screen that shows a number and no instruction is a screen
 * that gets refreshed.
 *
 * The two answers that are not "approved" get screens of their own, and that is the point of
 * having states at all rather than a spinner:
 *
 *  - **refused** — the operator said no, on purpose, and the device is told so and offered
 *    another go. A device that spun until the expiry would have the person walking back to the
 *    other machine to find out what happened;
 *  - **expired** — nobody answered within the three minutes the request lives, which is a
 *    different sentence and a different thing to do about it.
 *
 * A device that already holds a credential does not ask again. It reached this screen because the
 * board did not admit it, and asking would write a second record into the operator's registry for
 * a machine that is already in it. What it offers instead is to pair again on purpose, which
 * forgets the credential it has first.
 */

/** How often the device asks what became of its request. Fast: a person is watching two screens. */
const POLL_MS = 1500

type Phase = 'asking' | 'waiting' | 'refused' | 'expired' | 'failed' | 'paired'

interface Asked {
  requestId: string
  code: string
  expiresAt: number
}

/**
 * What this device proposes to be called.
 *
 * A browser cannot read the machine's name — there is no such API, and the one thing that came
 * closest was removed for fingerprinting. So this is the coarsest honest description of what is
 * asking, and the dialog on the other end marks it as the device's own claim rather than as a
 * fact, which is the only reason a guess is good enough here.
 */
function proposeName(): string {
  const agent = navigator.userAgent
  const platform = /Windows/i.test(agent) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(agent) ? 'a Mac'
      : /Android/i.test(agent) ? 'Android'
        : /iPhone|iPad|iPod/i.test(agent) ? 'iOS'
          : /Linux/i.test(agent) ? 'Linux'
            : 'an unrecognised system'
  const browser = /Edg\//.test(agent) ? 'Edge'
    : /Firefox\//.test(agent) ? 'Firefox'
      : /Chrome\//.test(agent) ? 'Chrome'
        : /Safari\//.test(agent) ? 'Safari'
          : 'A browser'
  return `${browser} on ${platform}`
}

export const PairingWaiting: React.FC = () => {
  const [phase, setPhase] = useState<Phase>(() => (readDeviceCredential() ? 'paired' : 'asking'))
  const [asked, setAsked] = useState<Asked | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const gone = useRef(false)

  useEffect(() => () => { gone.current = true }, [])

  /** Ask, and hold what came back. The only thing here that is not idempotent. */
  const ask = useCallback(async (): Promise<void> => {
    setPhase('asking')
    setNote(null)
    try {
      const response = await fetch('/api/pair/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: proposeName() }),
      })
      const body = await response.json().catch(() => ({})) as {
        success?: boolean; error?: string; requestId?: string; code?: string; expiresAt?: number
      }
      if (gone.current) return
      if (!response.ok || !body.success || !body.requestId || !body.code) {
        setPhase('failed')
        setNote(body.error ?? `This board answered ${response.status} and did not say why.`)
        return
      }
      setAsked({ requestId: body.requestId, code: body.code, expiresAt: body.expiresAt ?? 0 })
      setPhase('waiting')
    } catch (error) {
      if (gone.current) return
      setPhase('failed')
      // The one failure a reader can act on without knowing anything about this tool: they are
      // looking at the wrong address, or the machine is not answering at all.
      setNote(`This board could not be reached at ${window.location.host} (${(error as Error).message}).`)
    }
  }, [])

  useEffect(() => {
    if (phase === 'paired') return
    if (!asked) void ask()
    // Deliberately once, on the first render that wants a request. Every later ask is a press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * The poll, and the one place the credential is taken and kept.
   *
   * `approved` is answered exactly once by the server and the pending record dies with it, so
   * this is the only chance there will ever be to write the value down — which is why it is
   * written before anything else happens, and why the reload comes after.
   */
  useEffect(() => {
    if (phase !== 'waiting' || !asked) return undefined
    let stopped = false
    const read = async (): Promise<void> => {
      let body: { state?: string; credential?: string }
      try {
        const response = await fetch(
          `/api/pair/status?requestId=${encodeURIComponent(asked.requestId)}`, { cache: 'no-store' })
        body = await response.json() as { state?: string; credential?: string }
      } catch {
        return // the next tick asks again; a board being restarted is not an answer
      }
      if (stopped || gone.current) return
      if (body.state === 'approved' && body.credential) {
        writeDeviceCredential(body.credential)
        // Into a board it can now drive, rather than into this screen with a credential behind
        // it: everything the page holds about being unadmitted was decided before it loaded.
        window.location.reload()
        return
      }
      if (body.state === 'refused') { setPhase('refused'); return }
      if (body.state === 'unknown') { setPhase('expired'); return }
    }
    void read()
    const timer = window.setInterval(() => { void read() }, POLL_MS)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [asked, phase])

  /** Start over, forgetting a credential this board plainly does not accept. */
  const pairAgain = useCallback((): void => {
    forgetDeviceCredential()
    setAsked(null)
    void ask()
  }, [ask])

  const askAgain = useCallback((): void => {
    setAsked(null)
    void ask()
  }, [ask])

  return (
    <div className="pairing-waiting" data-pairing-waiting="" data-state={phase}>
      <div className="pairing-waiting__card">
        <p className="pairing-waiting__board">VibeMaxxing board at {window.location.host}</p>

        {phase === 'asking' && (
          <>
            <h1 className="pairing-waiting__headline">Asking this board to let this device in…</h1>
            <p className="pairing-waiting__body">
              It will answer with a code in a moment.
            </p>
          </>
        )}

        {phase === 'waiting' && asked && (
          <>
            <h1 className="pairing-waiting__headline">Waiting to be approved</h1>
            <p className="pairing-waiting__code-label">This device&rsquo;s code is</p>
            <p className="pairing-waiting__code" data-pairing-code="">{asked.code}</p>
            <p className="pairing-waiting__body">
              Go to the machine this board is running on. A request is waiting on its screen:
              approve the one showing this same code.
            </p>
            <p className="pairing-waiting__aside">
              The board opens by itself here once it is approved. Nothing has to be typed on this
              device. The request stops being approvable after about three minutes.
            </p>
          </>
        )}

        {phase === 'refused' && (
          <>
            <h1 className="pairing-waiting__headline">This board refused this device</h1>
            <p className="pairing-waiting__body">
              Somebody at the machine running the board said no. If that was not deliberate — if
              the code on their screen was not the one that was on this one — ask again and compare
              them.
            </p>
            <button className="pairing-waiting__button" data-pairing-ask-again="" onClick={askAgain}>
              Ask again
            </button>
          </>
        )}

        {phase === 'expired' && (
          <>
            <h1 className="pairing-waiting__headline">Nobody answered in time</h1>
            <p className="pairing-waiting__body">
              A request stops being approvable after about three minutes, and this one did. It was
              not refused; it simply ran out.
            </p>
            <button className="pairing-waiting__button" data-pairing-ask-again="" onClick={askAgain}>
              Ask again
            </button>
          </>
        )}

        {phase === 'failed' && (
          <>
            <h1 className="pairing-waiting__headline">This device could not ask</h1>
            <p className="pairing-waiting__body">{note}</p>
            <button className="pairing-waiting__button" data-pairing-ask-again="" onClick={askAgain}>
              Try again
            </button>
          </>
        )}

        {phase === 'paired' && (
          <>
            <h1 className="pairing-waiting__headline">This device is paired, and was not let in</h1>
            <p className="pairing-waiting__body">
              It holds a credential from an earlier approval, and this board did not accept it. The
              device may have been revoked on the other machine, or this board may not yet answer
              for the name this device reached it under: <code>{window.location.host}</code>
            </p>
            <p className="pairing-waiting__aside">
              Pairing again forgets the credential this device is holding and asks for a new one,
              which the person at the other machine has to approve.
            </p>
            <button className="pairing-waiting__button" data-pairing-ask-again="" onClick={pairAgain}>
              Pair this device again
            </button>
          </>
        )}
      </div>
    </div>
  )
}
