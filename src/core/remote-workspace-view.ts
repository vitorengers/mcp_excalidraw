/**
 * What a board may say about its projects to a machine that is not this one.
 *
 * `GET /api/workspaces` is guarded for a reason written above it in `core/../server.ts`, and the
 * reason is not that reading is dangerous: it does not read *a* project, it reads the map of all
 * of them — every registered project's absolute path, and a WSL project's path inside its distro
 * too. A federated board is by construction the thing that carries that off the machine. So
 * which fields cross has to be a decision somebody took, in one place, rather than a consequence
 * of forwarding a struct.
 *
 * **Built by construction, never by subtraction.** A view assembled by naming the fields it
 * includes is a view that a field added to `Workspace` next year is absent from until somebody
 * decides otherwise. A view assembled by spreading the workspace and deleting three keys is a
 * view that leaks the next field silently, on the day it is added, to every machine on the list.
 * The two read almost the same and age in opposite directions, which is why this module is a
 * module and why `scripts/check-remote-workspace-view.mjs` is written to fail the second shape:
 * it sweeps a fixture whose every string is a marker, and it holds the key list of
 * `interface Workspace` against the decisions taken here.
 *
 * **Three fields cross.** A tab strip on another machine needs a tab it can name, a tab it can
 * address, and the one fact that changes how a tab is drawn. Everything else in a resolved
 * `Workspace` is either a path — which is the whole thing being withheld — or a setting consumed
 * by the machine that owns the project, on that machine: the language it opens issues in, the
 * project board it reads, the agent it spawns. A request about a peer's project is answered by
 * the peer (#531), so the settings that answer it never have to be here.
 *
 * **`error` is not liveness, and this is the module where that is a decision rather than an
 * oversight.** It is what `core/workspaces.ts` sets when a project's *configuration* cannot be
 * resolved, and it crosses as itself because a misconfigured project is misconfigured on either
 * machine. Whether the machine that owns it is answering at all is `core/peer-liveness.ts`'s
 * four states, attached beside this view rather than folded into it. Conflating them would make
 * a sleeping laptop's projects read as broken, and `error` gates real behaviour: an implement
 * run refuses outright on a project carrying one, and the implementation queue treats that board
 * as unusable. A laptop in a bag would then refuse runs the way a broken `board.config.json`
 * does. See `docs/federation.md`.
 *
 * **No imports, on purpose.** `frontend/tsconfig.json` compiles with `types: []`, so anything
 * the frontend names — even with `import type` — must not reach a Node built-in, directly or
 * through the module it borrows a type from. That is why `Workspace` is not imported here: it
 * lives beside `import path from 'path'`, and naming it would red `check-frontend-types.mjs` on
 * errors about `workspaces.ts` and nothing about this file. `core/workspace-environment.ts` is
 * the same decision written down at three lines. What replaces the import is
 * `ProjectableWorkspace` below, which a resolved `Workspace` satisfies structurally, and the
 * check that reads the interface's keys is what keeps the two from drifting apart in silence.
 */

/**
 * As much of a resolved `Workspace` as this projection reads.
 *
 * Structural rather than imported, for the reason above. It is deliberately the *smallest*
 * shape that works: a `Workspace` is assignable to it, and a `Workspace` that lost one of these
 * three fields would stop being assignable, which is the compile error worth having.
 */
export interface ProjectableWorkspace {
  id: string;
  name: string;
  error: string | null;
}

/**
 * One of another board's projects, as this side of the wire is allowed to know it.
 *
 * Every field here is a field somebody decided to send. Adding one is an edit to this interface,
 * to the projection below, and to the check — which is the cost the design is buying.
 */
export interface RemoteWorkspaceView {
  /**
   * The id the owning board knows the project by.
   *
   * It goes back to that board on every request about the project, so it crosses unchanged.
   * Two boards can perfectly well both hold an `id` of `board`; making one addressable from
   * here without colliding with the other is `core/remote-workspace-id.ts`'s, and it is done
   * *to* this value rather than in place of it — `mintRemoteWorkspaceId` takes the id that
   * arrived here and the peer's own id, and its inverse hands this one back for the upstream
   * URL. So what crosses is the owner's spelling, unmodified.
   */
  id: string;
  /** What a person reads on the tab. The operator's own word for the project. */
  name: string;
  /**
   * The project's configuration could not be resolved — and nothing else.
   *
   * Not *the machine is asleep*, not *the credential was refused*, not *nothing answered*. Those
   * four are `core/peer-liveness.ts`'s and travel beside this, never inside it.
   */
  error: string | null;
}

/**
 * Every field of `Workspace` that is deliberately not on the wire, and why.
 *
 * The list is here so that the decision is reviewable in one place and so that a field added to
 * `Workspace` without a decision is a failing check rather than a leak. It is not what the
 * projection is built from — the projection names its own fields — it is the record of the other
 * half of the same decision.
 *
 * - `path`, `innerPath` — an absolute path on the owner's disk, and the same path inside its WSL
 *   distro. The pair this whole projection exists to keep off the wire.
 * - `environment` — carries the distro's name, which is a fact about the owner's machine; and
 *   `kind` on its own answers a question no strip on *this* machine can act on, because nothing
 *   here ever spawns anything in that distro.
 * - `docsDir`, `boardFile`, `libraryFile` — paths again. Relative or absolute, they describe the
 *   shape of somebody else's checkout, and they are read by the process that can open them.
 * - `agents` — which backend, model, effort, ceiling and workflow the owner's machine runs, and
 *   a workflow slug naming a file in the owner's tree. A run on a peer's project is that
 *   machine's run.
 * - `language` — the language *that* board writes issues in, used where the issue is written.
 * - `repo`, `githubProject`, `projectField`, `projectCardLimit`, `projectInProgressColumn`,
 *   `projectTodoColumn` — the project board is read by the machine that owns the project, and
 *   what crosses is the board it produced rather than the settings that produced it.
 */
export const WITHHELD_FROM_PEERS = [
  'path',
  'innerPath',
  'environment',
  'language',
  'docsDir',
  'boardFile',
  'libraryFile',
  'repo',
  'githubProject',
  'projectField',
  'projectCardLimit',
  'projectInProgressColumn',
  'projectTodoColumn',
  'agents'
] as const;

/**
 * One project, reduced to what another machine may be told about it.
 *
 * Read the body rather than the doc comment: the three named fields are the whole contract, and
 * an input property this function does not name cannot reach the result. That is the property,
 * and it is the reason there is no spread here.
 */
export function projectWorkspaceForPeer(workspace: ProjectableWorkspace): RemoteWorkspaceView {
  return {
    id: workspace.id,
    name: workspace.name,
    error: workspace.error
  };
}

/** What a tab says about a peer this board holds no name for. */
const UNNAMED_PEER = 'another machine';

/**
 * What goes where the path went.
 *
 * The tooltip on a tab shows `workspace.path` because the path is what tells two projects of the
 * same name apart (`frontend/src/components/WorkspaceTabs.tsx`). A peer's project has no path
 * here, and the hole is decided here rather than left for a frontend issue to improvise into: a
 * project's own name and the name this board calls the machine by are enough to disambiguate,
 * and disclose nothing about the peer's disk.
 *
 * The peer's name is the second argument because it is not the owner's to give. It is
 * `PeerRecord.name` in `core/peer-registry.ts` — what this operator calls that machine, theirs
 * to change and keyed on by nothing — so an owning board cannot influence what it is labelled
 * as, and a peer that has not been named yet reads as a sentence rather than as `undefined`.
 */
export function remoteWorkspaceLocation(view: RemoteWorkspaceView, peerName: string): string {
  const peer = peerName.trim() || UNNAMED_PEER;
  return `${view.name} on ${peer}`;
}
