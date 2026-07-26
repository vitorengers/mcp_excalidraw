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

## Why serve it at all

Excalidraw stores libraries in browser local storage, per origin and per browser. That is
invisible to version control, does not survive a different machine, and cannot be reviewed. A
library that lives in the project and is served on load is a file like any other — it can be
committed, diffed and shared.
