# Shared library

`GET /api/library` serves the Excalidraw library items every board opens with, so a shape drawn
once is available on all of them.

Two sources, concatenated in this order:

1. **The environment-wide library**, `EXCALIDRAW_LIBRARY` — shapes shared across every project
2. **The project's own**, `library` in its `board.config.json` — shapes that only make sense on
   one board

A project with no library of its own still gets the shared one. A missing or malformed file is
reported alongside the items that did load rather than failing the whole request: one broken
library should not leave every board with no shapes at all.

## How it is set up here

`EXCALIDRAW_LIBRARY` points at this repository's `docs/blocks.excalidrawlib`, which holds the
tool's own blocks — the **Issue block** and a plain **Card**. Those are primitives of the tool
rather than shapes belonging to one project, so every board gets them:

```
board-tool  -> Issue block, Card
fica-ai     -> Issue block, Card, Decisão, Risco, Concluído
default     -> Issue block, Card
```

`board.config.json` deliberately does **not** also name that file under `library`. The two
sources are concatenated, so pointing both at one file serves every item twice.

The library is the only way to add a functional block from inside the canvas: what makes one
functional is `customData.kind`, and no Excalidraw control sets it. It survives the round-trip
because `restore` preserves `customData` explicitly.

A docs block cannot be shipped this way — its `docKey` differs per shape and there is no UI to
set one, so that stays an API call.

## Why items land in different sections

Excalidraw splits the panel by each item's `status`: `unpublished` items appear under **Personal
Library**, `published` ones under **Excalidraw Library**. The blocks here are `unpublished`, so
they show under Personal Library. It is a display detail, not a difference in behaviour, and it
is worth knowing before concluding a library failed to load.

## Why serve it at all

Excalidraw stores libraries in browser local storage, per origin and per browser. That is
invisible to version control, does not survive a different machine, and cannot be reviewed. A
library that lives in the project and is served on load is a file like any other — it can be
committed, diffed and shared.
