import './AgentLimitsHud.css'

/** One rate-limit window, exactly as `GET /api/agent-limits` reports it. */
export interface AgentRateWindow {
  usedPercent: number
  /** Unix epoch seconds, or null when the reading did not say. */
  resetsAt: number | null
}

/** One machine's reading. Every field is independently nullable, and null is "not said". */
export interface AgentLimitsReading {
  label: string
  environment: { kind: string; distro?: string }
  account: string | null
  fiveHour: AgentRateWindow | null
  sevenDay: AgentRateWindow | null
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

function windowText(name: string, window: AgentRateWindow | null, nowSeconds: number): JSX.Element {
  // An em dash, not `0%`. A window "appears only for Claude.ai subscribers (Pro/Max) after
  // the first API response in the session", each of the two independently — so absent is the
  // ordinary case, and reporting it as zero would be a claim that nothing has been spent.
  if (!window) {
    return <span className="agent-limits__silent">{name} —</span>
  }
  const resets = untilReset(window.resetsAt, nowSeconds)
  return (
    <span className="agent-limits__window">
      {name} {Math.round(window.usedPercent)}%
      {resets && <span className="agent-limits__resets"> ({resets})</span>}
    </span>
  )
}

/**
 * One row per coding-agent environment on this machine: what it has spent and who spent it.
 *
 * Rendered only when the board is configured to look — `VIBEMAXXING_AGENT_LIMITS` unset
 * makes the route a 404 and this component is never given anything to draw.
 *
 * `data-poll-ms` is the interval the page is actually using, reflected onto the element so
 * that "one poll a minute" is something a reader — and
 * `scripts/check-agent-limits-browser.mjs` — can see rather than take on trust.
 */
export function AgentLimitsHud({
  environments,
  pollMs,
  now = Date.now(),
}: {
  environments: AgentLimitsReading[]
  pollMs: number
  /** Injected so a check can put a countdown at a known point rather than race the clock. */
  now?: number
}): JSX.Element | null {
  if (!environments.length) return null
  const nowSeconds = Math.floor(now / 1000)

  return (
    <div
      className="agent-limits"
      data-poll-ms={pollMs}
      title="Coding agent usage, as each environment last reported it"
    >
      {environments.map((environment) => {
        // "Nobody has run a session here" is a different answer from "this machine is idle",
        // and only one of them is worth a percentage. A row with nothing at all behind it
        // still shows, because a machine missing from the HUD looks like one that is fine.
        const silent = environment.account === null
          && environment.fiveHour === null
          && environment.sevenDay === null
          && environment.observedAt === null

        return (
          <div
            key={environment.label}
            className={`agent-limits__row${environment.stale ? ' agent-limits__row--stale' : ''}`}
          >
            <span className="agent-limits__env">{environment.label}</span>
            {environment.account && (
              <span className="agent-limits__account" title={environment.account}>
                {environment.account}
              </span>
            )}
            {silent ? (
              <span className="agent-limits__unknown">not seen</span>
            ) : (
              <>
                {windowText('5h', environment.fiveHour, nowSeconds)}
                {windowText('7d', environment.sevenDay, nowSeconds)}
                {environment.stale && environment.ageSeconds !== null && (
                  <span className="agent-limits__age">{ageLabel(environment.ageSeconds)}</span>
                )}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default AgentLimitsHud
