import React, { useCallback, useEffect, useRef, useState } from 'react'
import './DevicesDialog.css'

/**
 * Who else can reach this board, and how to take one of them off the list.
 *
 * Pairing a second machine is a one-time unlock until this exists. Once there is a second
 * device there is a third, and a laptop that was sold, and a phone paired at an airport that
 * should not still be on the list — so the answer to *who can reach my board* has to be a
 * surface a person can read and act on, not a JSON file beside the pidfile.
 *
 * Four things per row, and each of them is there because a person cannot judge a device
 * without it:
 *
 * - **the name, editable here.** The registry holds whatever the device proposed for itself,
 *   and `MacBook-Pro-3` is not what its owner calls it. Editing it is the point rather than a
 *   convenience: a list of machine-generated names is a list nobody can revoke from safely.
 * - **when it was approved, and when it was last seen.** Approved is history; last seen is
 *   what tells a device in use from one nobody has opened in months, which is the question
 *   somebody tidying this list is actually asking.
 * - **the address and `Host` it was approved for**, verbatim. The `Host` is the authority the
 *   device was blessed for, and seeing it is how a reader notices one they do not recognise.
 * - **Revoke.** It takes effect on that device's next request rather than at the next restart,
 *   and it closes the socket the device is holding — which is the half that would otherwise go
 *   on streaming the scene and every live shell's scrollback to a machine just removed.
 *
 * **Revoking the device you are reading this on is allowed**, and warned about rather than
 * refused. The operator on loopback cannot lock themselves out — the board token is a file,
 * not a device, and the host is not on this list — and a paired device revoking itself is a
 * legitimate "sign this machine out". A refusal there would be the surface deciding it knows
 * better than the person pressing it.
 *
 * Beside the project settings rather than on the canvas: this is the board's own
 * configuration and not something drawn on it, and it opens on a board with no project
 * registered at all, which is the state a fresh clone is in.
 */

interface Device {
  id: string
  name: string
  createdAt: string
  /**
   * Null until the device has been seen, and the registry means it: *paired and never used* and
   * *last used in March* are different answers to the question somebody tidying this list is
   * asking, and rendering the first as "unknown" would throw the difference away.
   */
  lastSeenAt: string | null
  approvedFrom: string
  host: string
}

/**
 * A moment, in the words somebody scanning a list reads it in.
 *
 * Relative, because "3 days ago" is the whole of what *last seen* is for and a reader
 * comparing two ISO strings is doing the arithmetic this column exists to have done. The exact
 * instant is kept in `title`, so nothing is lost for whoever needs it.
 */
function when(iso: string | null): string {
  if (iso === null) return 'never'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'unknown'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days < 45) return `${days} days ago`
  const months = Math.round(days / 30)
  return months < 24 ? `${months} months ago` : `${Math.round(months / 12)} years ago`
}

const exact = (iso: string | null): string =>
  (iso !== null && Number.isFinite(Date.parse(iso)) ? iso : '')

export const DevicesDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [devices, setDevices] = useState<Device[] | null>(null)
  /** Which entry is the caller, when the caller is one of them. Null on the host's own board. */
  const [self, setSelf] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The row whose name is being edited, and the draft — one at a time, like the list itself. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** The row whose Revoke was pressed once. A second press is what does it. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Said after a revocation, because the row it describes is gone by the time it is read. */
  const [said, setSaid] = useState<string | null>(null)
  const gone = useRef(false)

  useEffect(() => () => { gone.current = true }, [])

  const load = useCallback((): Promise<void> => fetch('/api/devices', { cache: 'no-store' })
    .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
    .then(({ ok, body }) => {
      if (gone.current) return
      if (!ok || !body?.success) {
        setError(body?.error ?? 'The list of paired devices could not be read.')
        return
      }
      setError(null)
      setDevices(body.devices ?? [])
      setSelf(typeof body.self === 'string' ? body.self : null)
    })
    .catch((problem: Error) => { if (!gone.current) setError(problem.message) }), [])

  useEffect(() => { void load() }, [load])

  // Escape closes it, like every other dialog on this bar. Bound on the document rather than on
  // the panel, so a press lands whether or not focus is still inside it.
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])

  const rename = (device: Device): void => {
    const name = draft.trim()
    if (!name || busy) return
    if (name === device.name) { setEditing(null); return }
    setBusy(true)
    fetch(`/api/devices/${encodeURIComponent(device.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    })
      .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (gone.current) return
        setBusy(false)
        if (!ok || !body?.success) {
          setError(body?.error ?? 'That device could not be renamed.')
          return
        }
        setError(null)
        setEditing(null)
        setDevices(body.devices ?? devices)
      })
      .catch((problem: Error) => { if (!gone.current) { setBusy(false); setError(problem.message) } })
  }

  const revoke = (device: Device): void => {
    if (busy) return
    setBusy(true)
    fetch(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' })
      .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (gone.current) return
        setBusy(false)
        setConfirming(null)
        if (!ok || !body?.success) {
          setError(body?.error ?? 'That device could not be revoked.')
          return
        }
        setError(null)
        setDevices(body.devices ?? [])
        // The count comes from the server: what a revocation disconnected is the half of it
        // nobody can see, so it is the half worth saying out loud.
        const closed = typeof body.socketsClosed === 'number' ? body.socketsClosed : 0
        setSaid(body.self === true
          ? `${device.name} — this device — was signed out. It cannot reach this board again `
            + 'without being paired afresh.'
          : `${device.name} was revoked.${closed > 0
            ? ` ${closed === 1 ? 'Its open connection was' : `Its ${closed} open connections were`} closed.`
            : ''}`)
      })
      .catch((problem: Error) => { if (!gone.current) { setBusy(false); setError(problem.message) } })
  }

  return (
    <div className="workspace-dialog-backdrop" onClick={onClose}>
      <div
        className="devices-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Paired devices"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="workspace-dialog__title">Paired devices</h2>
        <p className="devices-dialog__lede">
          Every device approved to drive this board. A device stays on the list across restarts;
          revoking one takes effect on its next request and closes what it has open.
        </p>

        {error && <p className="workspace-dialog__error" role="alert">{error}</p>}
        {said && <p className="devices-dialog__said" role="status">{said}</p>}

        {devices === null && !error && <p className="devices-dialog__loading">Reading the registry…</p>}

        {devices?.length === 0 && (
          <p className="devices-dialog__empty">
            No device has been paired with this board. Only this machine can reach it — see
            <span> </span><code>docs/devices.md</code>.
          </p>
        )}

        {devices !== null && devices.length > 0 && (
          <ul className="devices-dialog__list">
            {devices.map((device) => (
              <li
                key={device.id}
                className={`devices-dialog__row${device.id === self ? ' devices-dialog__row--self' : ''}`}
                data-device={device.id}
              >
                <div className="devices-dialog__heading">
                  {editing === device.id ? (
                    <>
                      <input
                        className="devices-dialog__name-field"
                        data-field="name"
                        aria-label={`Name for ${device.name}`}
                        value={draft}
                        autoFocus
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') rename(device)
                          // Stopped here rather than left to the document listener, which would
                          // close the whole dialog on the press that means "abandon this edit".
                          if (event.key === 'Escape') { event.stopPropagation(); setEditing(null) }
                        }}
                      />
                      <button
                        className="devices-dialog__save"
                        onClick={() => rename(device)}
                        disabled={busy || !draft.trim()}
                      >
                        Save
                      </button>
                      <button className="devices-dialog__cancel" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="devices-dialog__name">{device.name}</span>
                      {device.id === self && <span className="devices-dialog__badge">this device</span>}
                      <button
                        className="devices-dialog__rename"
                        aria-label={`Rename ${device.name}`}
                        onClick={() => { setDraft(device.name); setEditing(device.id) }}
                      >
                        Rename
                      </button>
                    </>
                  )}
                </div>

                <dl className="devices-dialog__facts">
                  <div>
                    <dt>Last seen</dt>
                    <dd data-fact="lastSeen" title={exact(device.lastSeenAt)}>{when(device.lastSeenAt)}</dd>
                  </div>
                  <div>
                    <dt>Approved</dt>
                    <dd data-fact="approved" title={exact(device.createdAt)}>{when(device.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>From</dt>
                    <dd data-fact="approvedFrom">{device.approvedFrom || 'unrecorded'}</dd>
                  </div>
                  <div>
                    <dt>Host</dt>
                    <dd data-fact="host">{device.host || 'unrecorded'}</dd>
                  </div>
                </dl>

                {confirming === device.id ? (
                  <div className="devices-dialog__confirm">
                    <p className="devices-dialog__warn">
                      {device.id === self
                        ? 'This is the device you are reading this on. Revoking it signs this '
                          + 'machine out: the board stops loading here and cannot be reached '
                          + 'again until it is paired afresh.'
                        : `${device.name} loses access on its next request, and anything it has `
                          + 'open is disconnected.'}
                    </p>
                    <div className="devices-dialog__actions">
                      <button className="devices-dialog__keep" onClick={() => setConfirming(null)}>
                        Keep it
                      </button>
                      <button
                        className="devices-dialog__revoke devices-dialog__revoke--go"
                        onClick={() => revoke(device)}
                        disabled={busy}
                      >
                        {device.id === self ? 'Sign this machine out' : `Revoke ${device.name}`}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="devices-dialog__revoke"
                    aria-label={`Revoke ${device.name}`}
                    onClick={() => { setSaid(null); setConfirming(device.id) }}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="workspace-dialog__actions">
          <button className="workspace-dialog__cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
