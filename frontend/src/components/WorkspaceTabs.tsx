import React from 'react'
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
}

/**
 * Tab strip for switching boards.
 *
 * Hidden entirely when no registry is configured — a single-board setup should not
 * grow a row of chrome showing one tab it cannot act on.
 */
export const WorkspaceTabs: React.FC<Props> = ({
  workspaces, activeId, configured, onSelect, onAdd, onConfigure
}) => {
  if (!configured && workspaces.length === 0) return null

  return (
    <div className="workspace-tabs" role="tablist" aria-label="Boards">
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeId
        const isWsl = workspace.environment.kind === 'wsl'
        return (
          <div
            key={workspace.id}
            className={`workspace-tab${isActive ? ' workspace-tab--active' : ''}${workspace.error ? ' workspace-tab--broken' : ''}`}
            // The path is what disambiguates two projects with the same name, and the
            // error is why a tab looks broken — both belong in the tooltip.
            title={[workspace.path, workspace.error].filter(Boolean).join('\n')}
          >
            <button
              role="tab"
              aria-selected={isActive}
              className="workspace-tab__select"
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
