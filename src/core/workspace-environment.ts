/**
 * Which machine a project — or a reading — is about.
 *
 * Three lines, alone in a file, and the reason is the boundary they have to cross. This type
 * belongs to `workspace-paths.ts` by rights and was declared there, but that module opens with
 * `import path from 'path'` and reads `process.platform`, and `frontend/tsconfig.json` compiles
 * with `types: []` on purpose — so anything on the frontend's side of the boundary that names
 * this type, even with `import type`, pulls `path`, `process` and `NodeJS` into a program that
 * has none of them and fails `check-frontend-types.mjs` on four errors about `workspace-paths`
 * and nothing about itself.
 *
 * `AgentAdapter` is on that side: `agent-stream-render.ts` names it and `TerminalPanel.tsx`
 * imports from there, so **`agent-adapter.ts` must stay free of Node**. It declares
 * `AgentLimitsReading`, which is about a machine, which is this. Hence a module with no imports
 * at all, which any half of this repository can name.
 *
 * `workspace-paths.ts` re-exports it, so every caller that had it from there still does.
 */

/**
 * The host this process runs on, or a WSL distro reached through `wsl.exe`.
 *
 * A distro is *declared*, never detected: the registry is where a board says one exists, and
 * `workspace-paths.ts` is where a path in either spelling is reduced to one of these.
 */
export type WorkspaceEnvironment =
  | { kind: 'native' }
  | { kind: 'wsl'; distro: string };
