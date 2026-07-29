import React, { useEffect, useState } from 'react'
import './WorkspaceDialogs.css'
import { WorkspaceSummary } from './WorkspaceTabs'

/** Effort levels the agent CLI accepts. Mirrors AGENT_EFFORTS in src/core/workspaces.ts. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

interface DirectoryEntry {
  name: string
  path: string
}

/**
 * Pick a folder and register it as a project.
 *
 * The listing comes from the server, which is not a workaround: the browser cannot learn
 * a folder path at all. `showDirectoryPicker()` returns a handle that deliberately
 * exposes none, and `<input webkitdirectory>` gives only paths relative to the folder
 * chosen — while the registry needs an absolute one. So the participant with a filesystem
 * does the browsing, and the field below accepts a typed path for anyone who already
 * knows where the project is.
 */
export const AddWorkspaceDialog: React.FC<{
  onClose: () => void
  onAdded: (workspace: WorkspaceSummary, workspaces: WorkspaceSummary[]) => void
}> = ({ onClose, onAdded }) => {
  const [path, setPath] = useState('')
  /** Where the listing is, which stops agreeing with the field the moment one is typed. */
  const [location, setLocation] = useState('')
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const browse = (target: string): void => {
    fetch(`/api/fs/directories?path=${encodeURIComponent(target)}`)
      .then((response) => response.json())
      .then((result) => {
        if (!result?.success) {
          setError(result?.error ?? 'That directory could not be read.')
          return
        }
        setError(null)
        setEntries(result.entries ?? [])
        setParent(result.parent ?? null)
        setLocation(result.path ?? target)
        // Opening a folder is also how it gets chosen, so the field follows the walk.
        setPath(result.path ?? target)
      })
      .catch((problem: Error) => setError(problem.message))
  }

  useEffect(() => { browse('') }, [])

  const submit = (): void => {
    const chosen = path.trim()
    if (!chosen || busy) return
    setBusy(true)
    fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: chosen })
    })
      .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok || !body?.success) {
          setError(body?.error ?? 'The project could not be added.')
          setBusy(false)
          return
        }
        onAdded(body.workspace as WorkspaceSummary, (body.workspaces ?? []) as WorkspaceSummary[])
      })
      .catch((problem: Error) => { setError(problem.message); setBusy(false) })
  }

  return (
    <div className="workspace-dialog-backdrop" onClick={onClose}>
      <div className="workspace-dialog" onClick={(event) => event.stopPropagation()}>
        <h2 className="workspace-dialog__title">Add a project</h2>

        <input
          className="workspace-dialog__path"
          type="text"
          value={path}
          placeholder="C:/Users/me/Projects/thing"
          aria-label="Project folder"
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
        />

        {/* Said out loud, or the list below reads as a second empty field. */}
        <p className="workspace-dialog__where">Browsing {location.trim() || 'this machine'}</p>

        <div className="workspace-dialog__browser">
          {parent !== null && (
            <button className="workspace-dialog__entry workspace-dialog__entry--up" onClick={() => browse(parent)}>
              ..
            </button>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              className="workspace-dialog__entry"
              onClick={() => browse(entry.path)}
            >
              {entry.name}
            </button>
          ))}
        </div>

        {error && <p className="workspace-dialog__error">{error}</p>}

        <div className="workspace-dialog__actions">
          <button className="workspace-dialog__cancel" onClick={onClose}>Cancel</button>
          <button className="workspace-dialog__submit" onClick={submit} disabled={busy || !path.trim()}>
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface AgentDraft {
  model: string
  effort: string
  timeoutSeconds: string
}

interface ConfigDraft {
  name: string
  language: string
  docsDir: string
  board: string
  library: string
  repo: string
  githubProject: string
  projectField: string
  projectCardLimit: string
  projectTodoColumn: string
  projectInProgressColumn: string
  issue: AgentDraft
  implement: AgentDraft
}

const EMPTY_AGENT: AgentDraft = { model: '', effort: '', timeoutSeconds: '' }

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): string => (typeof value === 'number' ? String(value) : '')

function agentDraft(raw: unknown): AgentDraft {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_AGENT }
  const settings = raw as Record<string, unknown>
  return {
    model: text(settings.model),
    effort: text(settings.effort),
    timeoutSeconds: number(settings.timeoutSeconds)
  }
}

/** `null` for a field left blank, which is what clears it on disk. */
const orNull = (value: string): string | null => (value.trim() ? value.trim() : null)

function agentPatch(draft: AgentDraft): Record<string, unknown> {
  const seconds = Number(draft.timeoutSeconds)
  return {
    model: orNull(draft.model),
    effort: orNull(draft.effort),
    timeoutSeconds: draft.timeoutSeconds.trim() && Number.isFinite(seconds) && seconds > 0 ? seconds : null
  }
}

/**
 * A project's settings, read from and written back to its own `board.config.json`.
 *
 * Read from the file rather than from the loaded workspace, because the two differ where
 * it matters: the loader resolves `docsDir` into an absolute path and turns an unset
 * agent field into a null that reads identically to a configured one. An editor has to
 * show what is *written*, so blank can go on meaning "use the board default".
 */
export const WorkspaceConfigDialog: React.FC<{
  workspaceId: string
  onClose: () => void
  onSaved: (workspace: WorkspaceSummary, workspaces: WorkspaceSummary[]) => void
}> = ({ workspaceId, onClose, onSaved }) => {
  const [draft, setDraft] = useState<ConfigDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/config`)
      .then((response) => response.json())
      .then((result) => {
        if (cancelled) return
        if (!result?.success) {
          setError(result?.error ?? 'That project config could not be read.')
          return
        }
        const config = (result.config ?? {}) as Record<string, unknown>
        const agents = (config.agents ?? {}) as Record<string, unknown>
        setDraft({
          name: text(config.name),
          language: text(config.language),
          docsDir: text(config.docsDir),
          board: text(config.board),
          library: text(config.library),
          repo: text(config.repo),
          githubProject: text(config.githubProject),
          projectField: text(config.projectField),
          projectCardLimit: number(config.projectCardLimit),
          projectTodoColumn: text(config.projectTodoColumn),
          projectInProgressColumn: text(config.projectInProgressColumn),
          issue: agentDraft(agents.issue),
          implement: agentDraft(agents.implement)
        })
      })
      .catch((problem: Error) => { if (!cancelled) setError(problem.message) })
    return () => { cancelled = true }
  }, [workspaceId])

  const set = (field: keyof ConfigDraft, value: string): void =>
    setDraft((current) => (current ? { ...current, [field]: value } : current))

  const setAgent = (kind: 'issue' | 'implement', field: keyof AgentDraft, value: string): void =>
    setDraft((current) => (current ? { ...current, [kind]: { ...current[kind], [field]: value } } : current))

  const save = (): void => {
    if (!draft || busy) return
    setBusy(true)
    const cards = Number(draft.projectCardLimit)
    fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          name: orNull(draft.name),
          language: orNull(draft.language),
          docsDir: orNull(draft.docsDir),
          board: orNull(draft.board),
          library: orNull(draft.library),
          repo: orNull(draft.repo),
          githubProject: orNull(draft.githubProject),
          projectField: orNull(draft.projectField),
          projectCardLimit: draft.projectCardLimit.trim() && Number.isInteger(cards) && cards > 0 ? cards : null,
          projectTodoColumn: orNull(draft.projectTodoColumn),
          projectInProgressColumn: orNull(draft.projectInProgressColumn),
          agents: { issue: agentPatch(draft.issue), implement: agentPatch(draft.implement) }
        }
      })
    })
      .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok || !body?.success) {
          setError(body?.error ?? 'Those settings could not be saved.')
          setBusy(false)
          return
        }
        onSaved(body.workspace as WorkspaceSummary, (body.workspaces ?? []) as WorkspaceSummary[])
      })
      .catch((problem: Error) => { setError(problem.message); setBusy(false) })
  }

  const field = (label: string, name: keyof ConfigDraft, placeholder = ''): React.ReactElement => (
    <label className="workspace-config__row">
      <span className="workspace-config__label">{label}</span>
      <input
        className="workspace-config__field"
        data-field={name}
        type="text"
        placeholder={placeholder}
        value={String(draft?.[name] ?? '')}
        onChange={(event) => set(name, event.target.value)}
      />
    </label>
  )

  const agentFields = (kind: 'issue' | 'implement', title: string): React.ReactElement => (
    <fieldset className="workspace-config__agent">
      <legend>{title}</legend>
      <label className="workspace-config__row">
        <span className="workspace-config__label">Model</span>
        <input
          className="workspace-config__field"
          data-field={`agents.${kind}.model`}
          type="text"
          placeholder="use board default"
          value={draft?.[kind].model ?? ''}
          onChange={(event) => setAgent(kind, 'model', event.target.value)}
        />
      </label>
      <label className="workspace-config__row">
        <span className="workspace-config__label">Effort</span>
        <select
          className="workspace-config__select"
          data-field={`agents.${kind}.effort`}
          value={draft?.[kind].effort ?? ''}
          onChange={(event) => setAgent(kind, 'effort', event.target.value)}
        >
          <option value="">use board default</option>
          {EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
      <label className="workspace-config__row">
        <span className="workspace-config__label">Time limit (s)</span>
        <input
          className="workspace-config__field"
          data-field={`agents.${kind}.timeoutSeconds`}
          type="text"
          placeholder="use board default"
          value={draft?.[kind].timeoutSeconds ?? ''}
          onChange={(event) => setAgent(kind, 'timeoutSeconds', event.target.value)}
        />
      </label>
    </fieldset>
  )

  return (
    <div className="workspace-dialog-backdrop" onClick={onClose}>
      <div className="workspace-config" onClick={(event) => event.stopPropagation()}>
        <h2 className="workspace-dialog__title">Project settings</h2>

        {!draft && !error && <p className="workspace-config__loading">Reading board.config.json…</p>}

        {draft && (
          <>
            {field('Name', 'name', workspaceId)}
            {/* The language the issues this board opens for the project are written in.
                Blank is English. It is a name a model reads, not a locale code. */}
            {field('Issue language', 'language', 'English')}
            {field('Docs folder', 'docsDir', 'docs')}
            {field('Board file', 'board', 'docs/board.excalidraw')}
            {field('Library file', 'library')}
            {field('GitHub repo', 'repo', 'owner/name')}
            {field('GitHub project', 'githubProject', 'https://github.com/users/…/projects/5')}
            {field('Project field', 'projectField', 'Status')}
            {field('Cards per column', 'projectCardLimit')}
            {/* The two columns this server writes: where a researched issue lands, and
                where an implementation does. Blank means the option GitHub names itself. */}
            {field('Todo column', 'projectTodoColumn', 'Todo')}
            {field('In-progress column', 'projectInProgressColumn', 'In Progress')}

            {/*
              A project retunes the agents the board already allows; blank means the
              board's own setting. It cannot supply a command, so it can never enable an
              agent the operator has not enabled.
            */}
            {agentFields('issue', 'Issue agent')}
            {agentFields('implement', 'Implement agent')}
          </>
        )}

        {error && <p className="workspace-dialog__error">{error}</p>}

        <div className="workspace-dialog__actions">
          <button className="workspace-config__cancel" onClick={onClose}>Cancel</button>
          <button className="workspace-config__save" onClick={save} disabled={busy || !draft}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
