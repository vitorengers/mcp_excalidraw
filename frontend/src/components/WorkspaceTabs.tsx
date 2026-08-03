import React, { useState } from 'react'
import './WorkspaceTabs.css'

/**
 * Whether the machine that owns a project is answering, which is four answers and not two.
 *
 * `checking` is a state the strip can be *in* rather than the absence of one: a tab that says
 * nothing while a probe is out is a tab that looks decided. `unreachable` is a machine that
 * never replied — a laptop with its lid shut does not refuse a connection, it hangs — and
 * `refused` is one that replied and would not have us.
 *
 * The same four words as `PeerLivenessState` in `src/core/peer-liveness.ts`, which is what
 * decides them, and written out again here because that module opens sockets — it imports
 * `net`, and the frontend's `tsconfig` compiles everything it can reach, so importing it for
 * the type alone would drag a Node built-in into the browser build. Two copies of four words
 * is two chances for one of them to learn a fifth, and nothing about a fifth word would fail
 * to compile on either side, so `scripts/check-workspace-tab-status-browser.mjs` reads both
 * declarations and fails if they stop agreeing.
 */
export type WorkspaceStatusState = 'checking' | 'online' | 'unreachable' | 'refused'

export interface WorkspaceStatus {
  state: WorkspaceStatusState
  /**
   * Why, in the words of whatever decided it, shown verbatim.
   *
   * A reason rather than a code, because the four states are deliberately coarse and what
   * separates *this* sleeping machine from that one is never going to fit in the union.
   */
  reason?: string | null
}

export interface WorkspaceSummary {
  id: string
  name: string
  path: string
  innerPath: string
  environment: { kind: 'native' } | { kind: 'wsl'; distro: string }
  docsDir: string | null
  repo: string | null
  githubProject: string | null
  /** Null means the project board reader falls back to its own defaults. */
  projectField: string | null
  projectCardLimit: number | null
  error: string | null
  /**
   * Whether the machine holding this project is answering — absent for every project this
   * board owns, and for every project until something starts supplying it.
   *
   * Deliberately **not** folded into `error`. That field is a config-resolution failure and it
   * gates real behaviour: an implement run refuses outright on a workspace carrying one, and
   * the queue treats such a board as unusable. A machine that happens to be asleep written
   * there would make projects that have nothing to do with it start refusing runs, and it
   * would be indistinguishable afterwards from a project whose config is genuinely broken.
   */
  status?: WorkspaceStatus | null
}

/**
 * The word each state prints, because colour is not a message.
 *
 * A reader who cannot tell green from amber, or who is listening to the page rather than
 * looking at it, gets the same four answers as everybody else — which is exactly what the `!`
 * glyph beside it failed to do for the whole of its existence.
 */
const STATUS_LABELS: Record<WorkspaceStatusState, string> = {
  checking: 'Checking',
  online: 'Online',
  unreachable: 'Unreachable',
  refused: 'Refused',
}

/** One line a tooltip can carry, and the accessible name of the marker, from one place. */
const statusSays = (status: WorkspaceStatus): string =>
  (status.reason ? `${STATUS_LABELS[status.state]} — ${status.reason}` : STATUS_LABELS[status.state])

interface Props {
  workspaces: WorkspaceSummary[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onConfigure: (id: string) => void
  /**
   * The whole strip in its new order, not "this one moved to n".
   *
   * The list is what the registry stores and what the route checks in one comparison, and
   * saying it whole means the caller never has to reason about whether an index was counted
   * before or after the tab was lifted out.
   */
  onReorder: (ids: string[]) => void
}

/** The chord that moves the focused tab, so the strip is not a drag-only control. */
const MOVE_KEYS = 'Control+Shift+Left / Control+Shift+Right'

/** The same list with one member carried to another position. */
function movedTo<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]
  const [lifted] = next.splice(from, 1)
  next.splice(to, 0, lifted)
  return next
}

/**
 * Tab strip for switching boards.
 *
 * Always rendered, including with no projects at all. It used to remove itself when there
 * was no registry — `if (!configured && workspaces.length === 0) return null` — and the
 * argument for that was tidiness: a single-board setup should not grow a row of chrome
 * showing one tab it cannot act on. But the `+` that registers a project is *in* this strip,
 * so the tidying hid the only control a board with nothing on it has, on the first screen
 * anybody sees. There is no unconfigured board any more (`registryPath()` always resolves),
 * and an empty strip is one control wide.
 */
export const WorkspaceTabs: React.FC<Props> = ({
  workspaces, activeId, onSelect, onAdd, onConfigure, onReorder
}) => {
  /**
   * The tab currently being carried, by id rather than by index.
   *
   * An index would be read against a list the parent is free to replace mid-drag — the
   * reorder is optimistic, so it does exactly that.
   */
  const [carried, setCarried] = useState<string | null>(null)
  /** Where it would land if it were dropped now, so the strip says so before the drop. */
  const [over, setOver] = useState<string | null>(null)

  /** A board with nothing on it yet, which is the one that has to explain its own `+`. */
  const noProjectsYet = workspaces.length === 0

  const order = workspaces.map((workspace) => workspace.id)

  /** Move one tab to an absolute position, if that is a move at all. */
  const moveTo = (id: string, to: number): void => {
    const from = order.indexOf(id)
    if (from < 0 || to < 0 || to >= order.length || to === from) return
    onReorder(movedTo(order, from, to))
  }

  const endDrag = (): void => { setCarried(null); setOver(null) }

  return (
    <div className="workspace-tabs" role="tablist" aria-label="Boards">
      {workspaces.map((workspace, at) => {
        const isActive = workspace.id === activeId
        const isWsl = workspace.environment.kind === 'wsl'
        const isCarried = carried === workspace.id
        // Which side the marker goes on is settled by the two positions rather than by where
        // in the tab the pointer is: a tab dragged rightwards lands after the one under it,
        // one dragged leftwards before it, which is what `movedTo` will actually do.
        const from = carried ? order.indexOf(carried) : -1
        const isTarget = over === workspace.id && !isCarried && from >= 0
        return (
          <div
            key={workspace.id}
            className={
              `workspace-tab${isActive ? ' workspace-tab--active' : ''}`
              + `${workspace.error ? ' workspace-tab--broken' : ''}`
              + `${isCarried ? ' workspace-tab--carried' : ''}`
              + (isTarget ? (from < at ? ' workspace-tab--drop-after' : ' workspace-tab--drop-before') : '')
            }
            // The path is what disambiguates two projects with the same name, the error is
            // why a tab looks broken, the status is why it may not be answering, and the chord
            // is the half of "reorder" that a pointer never discovers — all four belong in the
            // tooltip. None of them lives *only* here any more: everything on this row that
            // carries meaning is also text somebody listening to the page is told.
            title={[
              workspace.path,
              workspace.error,
              workspace.status ? statusSays(workspace.status) : null,
              `Drag to reorder, or ${MOVE_KEYS}`,
            ].filter(Boolean).join('\n')}
            draggable
            onDragStart={(event) => {
              setCarried(workspace.id)
              // Firefox starts no drag at all without payload, and `move` is what this is.
              event.dataTransfer.effectAllowed = 'move'
              try { event.dataTransfer.setData('text/plain', workspace.id) } catch { /* some browsers refuse */ }
            }}
            onDragOver={(event) => {
              if (!carried || carried === workspace.id) return
              // Without this the drop never fires: the default for a dragover is "not here".
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setOver(workspace.id)
            }}
            onDragLeave={() => setOver((current) => (current === workspace.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              const id = carried ?? event.dataTransfer.getData('text/plain')
              endDrag()
              if (id && id !== workspace.id) moveTo(id, order.indexOf(workspace.id))
            }}
            onDragEnd={endDrag}
          >
            <button
              role="tab"
              aria-selected={isActive}
              className="workspace-tab__select"
              /*
               * Reorder without a pointer, on the tab that has focus.
               *
               * `Ctrl+Shift`, not `Alt`: every board hotkey is `Alt` and nothing else
               * (`isBoardHotkeyChord`), so an `Alt+Arrow` here would be a second meaning for
               * the one modifier the board has taught its reader. Plain arrows are left alone
               * too — on a `role=tablist` they mean *move between tabs*, and taking them for
               * *move the tab* would be the wrong answer to the more common press.
               *
               * Focus follows the tab for free: the rows are keyed by workspace id, so React
               * moves this very button rather than rebuilding the strip, and a second press
               * carries the same tab further.
               */
              aria-keyshortcuts="Control+Shift+ArrowLeft Control+Shift+ArrowRight"
              onKeyDown={(event) => {
                if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return
                const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
                if (!step) return
                // Before the move, or the strip scrolls sideways under a press that moved a tab.
                event.preventDefault()
                moveTo(workspace.id, at + step)
              }}
              onClick={() => onSelect(workspace.id)}
            >
              {isWsl && <span className="workspace-tab__badge">WSL</span>}
              {/*
                Beside the WSL badge rather than folded into the marker at the end, because
                these are two independent facts about one project and a tab may carry both:
                a project whose config is broken can also be on a machine that is asleep, and
                a reader who sees one mark disappear when the other arrives has been told
                something untrue.
              */}
              {workspace.status && (
                <span
                  className={
                    'workspace-tab__badge workspace-tab__status'
                    + ` workspace-tab__status--${workspace.status.state}`
                  }
                >
                  {STATUS_LABELS[workspace.status.state]}
                  {workspace.status.reason
                    && <span className="workspace-tab__aside">{` — ${workspace.status.reason}`}</span>}
                </span>
              )}
              <span className="workspace-tab__name">{workspace.name}</span>
              {/*
                The `!` was `aria-hidden="true"` with its meaning in the `title`, which is to
                say: the one mark on the screen that says this project is broken was hidden
                from the accessibility tree, and what it stood for was reachable only by
                hovering a pointer over the tab. A keyboard user never got there and a screen
                reader was told to skip it.

                So the glyph keeps the `aria-hidden` — it is decoration, and `!` read aloud is
                noise — and the reason goes beside it as real text, off screen but in the tree.
                That makes the marker's accessible name the sentence the tooltip was keeping
                to itself.
              */}
              {workspace.error && (
                <span className="workspace-tab__warn">
                  <span aria-hidden="true">!</span>
                  <span className="workspace-tab__aside">{`Configuration error: ${workspace.error}`}</span>
                </span>
              )}
            </button>
            {/*
              Only on the tab in front. A gear on every tab would offer to edit a project
              the board is not showing, and the settings dialog reads that project's
              config — so the control belongs where the config already applies.
            */}
            {isActive && (
              <button
                className="workspace-tab__config"
                aria-label={`Settings for ${workspace.name}`}
                title="Project settings"
                onClick={() => onConfigure(workspace.id)}
              >
                ⚙
              </button>
            )}
          </div>
        )
      })}
      {/*
        A `+` beside tabs is unambiguous: the tabs say what it would add one of. Alone in an
        empty header it is a glyph with nothing to be read against, on the screen where the
        reader knows least — so with no projects it says so in words. The accessible name is
        the same sentence either way, because it was never the ambiguous half.
      */}
      <button
        className={`workspace-tabs__add${noProjectsYet ? ' workspace-tabs__add--labelled' : ''}`}
        aria-label="Add a project"
        title="Add a project"
        onClick={onAdd}
      >
        {noProjectsYet ? '+ Add a project' : '+'}
      </button>
    </div>
  )
}
