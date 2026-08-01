import './ClaudeStatusHud.css'

/** One rate-limit window, exactly as `GET /api/claude-status` reports it. */
export interface ClaudeRateWindow {
  usedPercent: number
  /** Unix epoch seconds, or null when the reading did not say. */
  resetsAt: number | null
}

/** One machine's reading. Every field is independently nullable, and null is "not said". */
export interface ClaudeEnvironmentStatus {
  label: string
  environment: { kind: string; distro?: string }
  account: string | null
  fiveHour: ClaudeRateWindow | null
  sevenDay: ClaudeRateWindow | null
  observedAt: number | null
  ageSeconds: number | null
  stale: boolean
}

/**
 * How long until a window resets, in the two largest units that are not zero.
 *
 * `2d 23h` and `1h 04m` rather than `71h` or `64m`: the question a reader is asking of this
 * is "can I keep going", and an answer in one unit makes them do the arithmetic. A reset
 * that has already passed says nothing at all — the next session's status line will report
 * the fresh window, and inventing `0m` here would put a countdown on the screen that is not
 * counting.
 */
function untilReset(resetsAt: number | null, nowSeconds: number): string | null {
  if (resetsAt === null) return null
  const left = resetsAt - nowSeconds
  if (left <= 0) return null
  const days = Math.floor(left / 86400)
  const hours = Math.floor((left % 86400) / 3600)
  const minutes = Math.floor((left % 3600) / 60)
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

/** How old the reading is, in the one unit that reads fastest at a glance. */
function ageLabel(ageSeconds: number): string {
  if (ageSeconds >= 86400) return `${Math.floor(ageSeconds / 86400)}d old`
  if (ageSeconds >= 3600) return `${Math.floor(ageSeconds / 3600)}h old`
  return `${Math.max(1, Math.floor(ageSeconds / 60))}m old`
}

function windowText(name: string, window: ClaudeRateWindow | null, nowSeconds: number): JSX.Element {
  // An em dash, not `0%`. A window "appears only for Claude.ai subscribers (Pro/Max) after
  // the first API response in the session", each of the two independently — so absent is the
  // ordinary case, and reporting it as zero would be a claim that nothing has been spent.
  if (!window) {
    return <span className="claude-status__silent">{name} —</span>
  }
  const resets = untilReset(window.resetsAt, nowSeconds)
  return (
    <span className="claude-status__window">
      {name} {Math.round(window.usedPercent)}%
      {resets && <span className="claude-status__resets"> ({resets})</span>}
    </span>
  )
}

/** One drawn row: which machines it stands for, and the one reading its figures come from. */
interface HudRow {
  key: string
  /** Every environment in the group, in the order the route listed them. */
  labels: string[]
  /** The reading the figures come from: the freshest in the group. */
  reading: ClaudeEnvironmentStatus
}

/**
 * What two readings must share to be one row: the account, ignoring case and surrounding
 * space. An email address is not case-sensitive, and a space a status line left on the end
 * of one is not a second subscription. Blank is `null` — "not said", never a key.
 */
function accountKey(account: string | null): string | null {
  const trimmed = (account ?? '').trim()
  return trimmed ? trimmed.toLowerCase() : null
}

/** Which of two readings a merged row should draw. A reading with no age has none to beat. */
function fresher(candidate: ClaudeEnvironmentStatus, incumbent: ClaudeEnvironmentStatus): boolean {
  if (candidate.ageSeconds === null) return false
  if (incumbent.ageSeconds === null) return true
  return candidate.ageSeconds < incumbent.ageSeconds
}

/**
 * One row per *account*, not per machine — where the machines agree about whose account it is.
 *
 * The windows are per Claude.ai subscription, so two environments signed in as the same person
 * are not two quotas: they are one quota, reported twice, differing only in how stale each copy
 * is. Drawn as two rows that is two percentages for the same number, and a reader has to know
 * which is the later one to know which is true. Merged, the figures come from the freshest
 * reading and the label names every machine behind it.
 *
 * Safe only when the account matches, which is why the key is the account and nothing else.
 * `docs/claude-status.md` argues the other direction for the case this does not cover — two
 * homes are two credential stores and frequently two subscriptions, and a percentage attributed
 * to the wrong account is worse than no percentage at all. **A `null` account joins nobody**,
 * including another `null`: "not said" is not something two machines can have in common.
 *
 * Decided per render, out of the response the page already has. An account that changes
 * mid-session splits or joins a row on the next poll with no state to keep in step — which is
 * the whole reason this lives here and not in the route, where a merged record would have to
 * be a record of something the server does not know.
 */
function rowsByAccount(environments: ClaudeEnvironmentStatus[]): HudRow[] {
  const rows: HudRow[] = []
  const byAccount = new Map<string, HudRow>()

  for (const environment of environments) {
    const key = accountKey(environment.account)
    if (key === null) {
      rows.push({ key: `env:${environment.label}`, labels: [environment.label], reading: environment })
      continue
    }
    const existing = byAccount.get(key)
    if (!existing) {
      const row: HudRow = { key: `account:${key}`, labels: [environment.label], reading: environment }
      byAccount.set(key, row)
      rows.push(row)
      continue
    }
    existing.labels.push(environment.label)
    if (fresher(environment, existing.reading)) existing.reading = environment
  }
  return rows
}

/**
 * One row per Claude Code account on this machine: what it has spent and which machines spent it.
 *
 * Off unless the board was configured to look — `EXCALIDRAW_CLAUDE_STATUS` unset makes the
 * route a 404. That used to render nothing at all, which is the one state this HUD could not
 * tell a reader about: an empty header corner is exactly what a board without the feature
 * looks like, and the answer to "why is there no usage on my board" was in a document nobody
 * had been given a reason to open. So `off` is one muted line naming that document, and the
 * server's own sentence — which names the setting — is on it for a reader who hovers.
 *
 * `data-poll-ms` is the interval the page is actually using, reflected onto the element so
 * that "one poll a minute" is something a reader — and
 * `scripts/check-claude-status-browser.mjs` — can see rather than take on trust.
 */
export function ClaudeStatusHud({
  environments,
  pollMs,
  off = null,
  now = Date.now(),
}: {
  environments: ClaudeEnvironmentStatus[]
  pollMs: number
  /** The server's reason the route is off, or null while it is on. */
  off?: string | null
  /** Injected so a check can put a countdown at a known point rather than race the clock. */
  now?: number
}): JSX.Element | null {
  if (off) {
    return (
      <div className="claude-status" title={off}>
        <span className="claude-status__off">Claude usage off · docs/claude-status.md</span>
      </div>
    )
  }
  if (!environments.length) return null
  const nowSeconds = Math.floor(now / 1000)

  return (
    <div
      className="claude-status"
      data-poll-ms={pollMs}
      title="Claude Code usage, as each environment's status line last reported it"
    >
      {rowsByAccount(environments).map((row) => {
        const reading = row.reading
        // "Nobody has run a session here" is a different answer from "this machine is idle",
        // and only one of them is worth a percentage. A row with nothing at all behind it
        // still shows, because a machine missing from the HUD looks like one that is fine.
        const silent = reading.account === null
          && reading.fiveHour === null
          && reading.sevenDay === null
          && reading.observedAt === null

        return (
          <div
            key={row.key}
            className={`claude-status__row${reading.stale ? ' claude-status__row--stale' : ''}`}
          >
            {/* Joined into one span rather than one each: the flex row wraps between its
                children, so a label in two pieces could wrap and read as two machines —
                which is the mistake this row exists to stop, arriving from the other side. */}
            <span className="claude-status__env" title={row.labels.join(', ')}>
              {row.labels.join(' + ')}
            </span>
            {reading.account && (
              <span className="claude-status__account" title={reading.account}>
                {reading.account}
              </span>
            )}
            {silent ? (
              <span className="claude-status__unknown">not seen</span>
            ) : (
              <>
                {windowText('5h', reading.fiveHour, nowSeconds)}
                {windowText('7d', reading.sevenDay, nowSeconds)}
                {reading.stale && reading.ageSeconds !== null && (
                  <span className="claude-status__age">{ageLabel(reading.ageSeconds)}</span>
                )}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default ClaudeStatusHud
