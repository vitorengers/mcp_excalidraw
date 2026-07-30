# Trap: a check's own server was decided by the machine, not by the check

A self-contained check starts a canvas server, tells it exactly what to be, and asserts what it
does. Two things used to arrive uninvited — the environment and the port — and both of them
answered questions the check thought it was asking.

## The `.env` put back what a check had deleted

`src/server.ts` and `src/core/config.ts` both call `dotenv.config()`, so the server reads
`<cwd>/.env`, and the checks spawn it with `cwd: repoRoot`, where a working machine keeps an
untracked `.env` with a dozen `EXCALIDRAW_*` values in it.

The dangerous part is the rule dotenv is safest known for: **it never overwrites a variable that
is already set**. Read the other way round, the only variables it *can* set are the ones the
caller left unset — which, for a check, means precisely the ones it deleted on purpose.

`scripts/check-workspace-settings.mjs` builds its "nothing granted" server by leaving
`EXCALIDRAW_IMPLEMENT_AGENT` out, and POSTs `/api/implement` expecting a 404. On a machine with
an `.env` it got the operator's real `claude.exe -p --dangerously-skip-permissions` back, so
*running the check started a coding agent against a fabricated issue URL*.
`scripts/check-health-identity.mjs` stripped every `EXCALIDRAW_*` from the child environment by
hand for the same reason, and was defeated the same way — `/health` reads
`process.env.EXCALIDRAW_WORKSPACES` live, in the child, after dotenv has run there.

The same mechanism reached anything else that loaded the built modules:
`scripts/check-issue-timeout.mjs` reads `DEFAULT_TIMEOUT_MS` out of
`dist/core/issue-agent.js` in a child of its own, and `issue-agent.js` pulls in `config.js`,
which reads the file.

**The fix is an opt-out the caller sets, not a change to what dotenv does.**
`EXCALIDRAW_NO_DOTENV=1` makes both entry points skip the file entirely, and
`EXCALIDRAW_ENV_FILE` names a different one when a caller wants a specific configuration rather
than none. An environment variable rather than a `--no-dotenv` flag, because the checks already
control the child's environment and cannot as easily control its argv at every call site.

## The port was a guess with a band around it

Ninety-six checks computed the port they listened on as a base number plus the process id,
modulo the width of a band. Nothing coordinated the bands, and they overlapped:
`check-agent-stream-render-browser.mjs` took 35700-35899 for its server and 36100-36299 for
Chrome, which is exactly `check-terminal-paper-browser.mjs`'s server range, whose own CDP range
36500-36699 sits inside `check-board-subsections-browser.mjs`'s. Two dozen more took a second
server or a CDP port by adding a small number to the first, with no probe at all.

Two checks running at once could therefore land on the same port, and the failure read as a bug
in the feature rather than in the arithmetic. Worse, `scripts/check-local-bind.mjs` read
`process.env.PORT` first — and `PORT=3737` is in the development machine's session — so it bound
nothing, health-checked the operator's **live board**, and reported the duplicate-startup case
green.

**The band is not fixable, because a band is only ever correct while nothing else is running.**
`scripts/lib/free-port.mjs` asks the kernel: bind port `0`, read back what it gave, close it. A
probe has a race between the close and the caller's own listen, and that is the failure worth
having — `EADDRINUSE` at startup rather than a silent collision with somebody else's server.
`freePort()` also remembers every port it has handed out this run, so two calls in one check are
distinct; `freePorts(n)` holds all `n` probes open at once for the same guarantee.

## Where it lives now

Both answers are in one place, so a new check gets them without knowing any of the above:

- `scripts/lib/free-port.mjs` — `freePort()` and `freePorts(n)`.
- `scripts/lib/spawn-canvas.mjs` — `startCanvas({ port, env, cwd })`, which deletes every
  inherited `EXCALIDRAW_*`, drops `PORT` and `HOST`, sets `EXCALIDRAW_NO_DOTENV=1`, applies the
  check's own values, and returns the child with a buffered log reader.

`scripts/check-env-isolation.mjs` and `scripts/check-port-allocation.mjs` are what keep them
true: the first watches one server read a planted `.env` and then proves the next one does not,
and the second fails on any check that reintroduces a hand-computed port or spawns
`dist/server.js` itself.

A check that legitimately needs the file can ask for it — `startCanvas({ allowDotenv: true })` —
and exactly one does, for exactly that reason.
