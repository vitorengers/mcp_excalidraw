import React, { useState } from 'react'
import './WorkspaceTabs.css'

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
}

interface Props {
  workspaces: WorkspaceSummary[]
  activeId: string
  /**
   * Whether a registry exists at all.
   *
   * Separate from the list being empty, because those are different boards: with no
   * registry there is nowhere to add a project and the strip stays hidden, while an empty
   * registry is a board waiting for its first project and must show the `+` that adds it.
   */
  configured: boolean
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
 * Hidden entirely when no registry is configured — a single-board setup should not
 * grow a row of chrome showing one tab it cannot act on.
 */
export const WorkspaceTabs: React.FC<Props> = ({
  workspaces, activeId, configured, onSelect, onAdd, onConfigure, onReorder
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

  if (!configured && workspaces.length === 0) return null

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
            // why a tab looks broken, and the chord is the half of "reorder" that a pointer
            // never discovers — all three belong in the tooltip.
            title={[
              workspace.path,
              workspace.error,
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
              <span className="workspace-tab__name">{workspace.name}</span>
              {workspace.error && <span className="workspace-tab__warn" aria-hidden="true">!</span>}
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
      <button
        className="workspace-tabs__add"
        aria-label="Add a project"
        title="Add a project"
        onClick={onAdd}
      >
        +
      </button>
    </div>
  )
}
