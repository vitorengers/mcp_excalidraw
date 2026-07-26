# Sync reconciliation

`POST /api/elements/sync` is how the browser hands its scene back to the server. It used to
`clear()` the store and rewrite it from the payload, which made **absence mean deletion**.
An element created through the API seconds earlier — one the browser had never seen — vanished
on the next autosync. The API and the canvas were fighting over the same store, and the canvas
always won.

## The rule now

Merge by `id`:

- the incoming element wins when its `version` is higher than the stored one;
- `versionNonce` breaks the tie when versions are equal, so two clients converge on the same
  winner rather than on whoever spoke last;
- an element the payload never mentions is **left alone**;
- deletion is explicit — it travels as a tombstone, an element carrying `isDeleted: true`.

`version` is preserved rather than reset, because it is what makes the *next* reconciliation
possible. Overwriting it with `1` would make every stored element look older than everything
that arrives afterwards.

## Where it lives

- Endpoint: `src/server.ts`, the `/api/elements/sync` handler
- Store: `src/core/element-store.ts` — one `Map` per workspace
- Check: `scripts/check-sync-reconcile.mjs`

## Why the check matters

Run `node scripts/check-sync-reconcile.mjs --url http://127.0.0.1:3838` against an empty
instance. Four cases: the API element survives a sync that omits it, a tombstone removes while
an absence does not, the newest version wins a race, and `version` is not overwritten. Against
the old clear-and-replace code the first case fails immediately.
