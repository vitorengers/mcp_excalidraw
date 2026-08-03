// First, and it has to stay first: it takes the board token out of the address bar and wraps
// `window.fetch` before anything else can call it. `WorkspaceDialogs.tsx` fetches at module
// scope, so "before the first render" would already be too late. See ./auth.ts.
import './auth'
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { PairingWaiting } from './components/PairingWaiting'
import '@excalidraw/excalidraw/index.css'

/**
 * What this page is: a board, or the screen that says how to become one (#504).
 *
 * A device that has never been paired reaches this board under a name it does not answer for and
 * holds no credential, so every route it asks refuses it. Rendering the board anyway is what gave
 * the reader a blank canvas and a console full of refused sockets — a page that had loaded and
 * could not say why it was empty. So the decision is made once, before anything mounts, and the
 * answer is one of two whole screens rather than a board with the middle missing.
 *
 * The question is put to `GET /api/pair/admission`, which sits behind every gate the board's own
 * routes sit behind and behind nothing extra, so its answer *is* the guard's: 200 for a caller
 * this board admits, 401 for one holding no credential, 403 for one reaching it under a name this
 * board does not answer for. Asking any other route would mean reading a refusal about the scene
 * and guessing it was about admission.
 */
type Admission = 'asking' | 'admitted' | 'unadmitted'

/** The hosts a browser reaches this board on when it is the machine running it. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

async function readAdmission(): Promise<Admission> {
  /*
   * The machine running the board never sees this screen, and that is a decision rather than an
   * optimisation. A loopback page that is refused is refused for a reason pairing cannot fix — a
   * board bound to an interface refuses its own operator's reads today, and #501 is what changes
   * that — and offering to pair the browser that is already on the host would be answering the
   * wrong question with a code the operator would have to read off their own screen.
   *
   * It is also what keeps every existing board, and every check in `scripts/`, exactly as it was:
   * they all reach their board at loopback.
   */
  if (LOOPBACK_HOSTS.has(window.location.hostname)) return 'admitted'
  try {
    const response = await fetch('/api/pair/admission', { cache: 'no-store' })
    return response.ok ? 'admitted' : 'unadmitted'
  } catch {
    // A board that cannot be reached at all is not a board that admitted us. The waiting screen
    // is where that has a sentence; here it would be a blank page again.
    return 'unadmitted'
  }
}

const PairingGate: React.FC = () => {
  const [admission, setAdmission] = useState<Admission>('asking')

  useEffect(() => {
    let gone = false
    void readAdmission().then((answer) => { if (!gone) setAdmission(answer) })
    return () => { gone = true }
  }, [])

  // Nothing, and briefly: one request against loopback, and rendering either screen under it
  // would mean drawing a board that is about to be replaced or a code that was never asked for.
  if (admission === 'asking') return null
  return admission === 'admitted' ? <App /> : <PairingWaiting />
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <PairingGate />
  </React.StrictMode>,
)
