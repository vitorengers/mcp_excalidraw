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
  error: string | null
}

interface Props {
  workspaces: WorkspaceSummary[]
  activeId: string
  onSelect: (id: string) => void
}

/**
 * Tab strip for switching boards.
 *
 * Hidden entirely when no registry is configured — a single-board setup should not
 * grow a row of chrome showing one tab it cannot act on.
 */
export const WorkspaceTabs: React.FC<Props> = ({ workspaces, activeId, onSelect }) => {
  if (workspaces.length === 0) return null

  return (
    <div className="workspace-tabs" role="tablist" aria-label="Boards">
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeId
        const isWsl = workspace.environment.kind === 'wsl'
        return (
          <button
            key={workspace.id}
            role="tab"
            aria-selected={isActive}
            className={`workspace-tab${isActive ? ' workspace-tab--active' : ''}${workspace.error ? ' workspace-tab--broken' : ''}`}
            // The path is what disambiguates two projects with the same name, and the
            // error is why a tab looks broken — both belong in the tooltip.
            title={[workspace.path, workspace.error].filter(Boolean).join('\n')}
            onClick={() => onSelect(workspace.id)}
          >
            {isWsl && <span className="workspace-tab__badge">WSL</span>}
            <span className="workspace-tab__name">{workspace.name}</span>
            {workspace.error && <span className="workspace-tab__warn" aria-hidden="true">!</span>}
          </button>
        )
      })}
    </div>
  )
}
