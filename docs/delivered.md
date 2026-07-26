# Delivered

Issues #1–#11, all closed. The issue number and the PR number do not line up — the first three
issues were delivered by PRs #4, #5 and #6.

| Issue | What it was | PR |
|---|---|---|
| #1 | **Sync reconciled by version.** `POST /api/elements/sync` cleared the store and rewrote it from the browser payload, so absence meant deletion and API-created elements vanished on the next autosync. Now the merge is by `id`, highest `version` wins, `versionNonce` breaks the tie, and deletion travels as an explicit tombstone. | #4 |
| #2 | **`link` and `customData` accepted by the schemas.** Both were dropped by create and update but survived a sync — an asymmetry that stopped an agent from binding a shape to its documentation through the API. | #5 |
| #3 | **The documentation panel.** A shape with `customData.docKey` opens a sidebar rendering the markdown from `GET /api/docs/:key`. | #6 |
| #7 | **Workspace registry.** One project per board, each with its own `board.config.json`. Windows and WSL spellings of a path collapse onto one canonical key. | #12 |
| #8 | **Per-workspace storage and tabs.** `elements` stopped being one global `Map`; every route resolves its store from `?workspace=`. | #13, #14 |
| #9 | **Shared library.** `GET /api/library` serves the environment `.excalidrawlib` plus the project's own. | #15 |
| #10 | **Collapsible image block.** `customData.collapsed`, with `fullSize` stashed before shrinking. | #16 |
| #11 | **Issue block.** An observation written on the board becomes a researched GitHub issue. | #17, #18, #19 |

## The pattern underneath

Three of the eleven were the same shape of bug: two writers to one store, with no rule for what
happens when they disagree. Clear-and-replace sync (#1), schemas that dropped fields another
path accepted (#2), and a global `Map` shared by every board (#8). The fix each time was to make
the rule explicit rather than to make one writer back off.

Every one of them has a `scripts/check-*.mjs`, written against the old code first so the check
was seen to fail before the fix went in.
