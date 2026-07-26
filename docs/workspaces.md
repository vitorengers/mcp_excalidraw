# Workspace registry

One project per board. A registry file lists the projects; each project then describes its own
board settings in a `board.config.json` at its root, the way it already carries a package
manifest. Settings travel with the project instead of piling up in one machine's global config.

## The registry

`EXCALIDRAW_WORKSPACES` points at a JSON file:

```json
{
  "workspaces": [
    { "id": "fica-ai",    "path": "C:/Users/vtr_d/Documents/Projects/FicaAI" },
    { "id": "board-tool", "path": "C:/Users/vtr_d/Documents/Projects/mcp_excalidraw" }
  ]
}
```

`id` is optional — without it the id is derived from the last path segment. A `distro` field
marks a WSL-backed project, and Windows and WSL spellings of the same path collapse onto one
canonical key so a project cannot register twice.

## board.config.json

```json
{
  "name": "Board Tool",
  "docsDir": "docs",
  "board": "docs/board.excalidraw",
  "repo": "vitorengers/mcp_excalidraw",
  "githubProject": "https://github.com/users/vitorengers/projects/5"
}
```

A config field pointing outside its own project is **ignored, not honoured** — the workspace is
still returned, with `error` explaining what was dropped. A project whose config is missing or
malformed is also still listed, carrying its error, because one broken project should not hide
the others and a workspace that silently disappears is harder to debug than one that shows up
broken.

## What reads it

`GET /api/workspaces` loads the registry **per request**, not once at boot: a project's config
gets edited while the server runs, and restarting to notice would be silly. The docs endpoint,
the library endpoint and the issue block each resolve their own workspace the same way.

- `src/core/workspaces.ts` — registry and config loading
- `src/core/workspace-paths.ts` — Windows/WSL path canonicalisation
- `scripts/check-workspaces.mjs`, `scripts/check-workspace-isolation.mjs`
