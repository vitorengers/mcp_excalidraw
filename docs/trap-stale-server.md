# Trap: the old server does not die on its own

Start a new canvas while an old one still holds the port and the new process fails to bind and
exits. The old one keeps answering — **silently, with the old code**.

This is the worst failure mode in the project, because everything looks like it worked. The
browser reconnects. Requests succeed. The fix you just built is not there, and every attempt to
debug it is reasoning about source that is not running.

## What to do

Kill by PID before starting. [running.md](running.md) carries this as the step before the
build:

```powershell
$busy = Get-NetTCPConnection -LocalPort 3737 -State Listen -ErrorAction SilentlyContinue
foreach ($processId in ($busy.OwningProcess | Select-Object -Unique)) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
```

**`$processId`, never `$pid`.** `$PID` is a read-only automatic variable in PowerShell, so
`foreach ($pid in ...)` throws — and under `$ErrorActionPreference = 'Stop'` that aborts the
whole script. The loop body only runs when something is listening, so the script appeared to
work for months: it failed only when the port was busy, which is the one case the block exists
for. The guard against a stale server was itself disabled by a stale server.

`GET /health` returns the `pid` of whatever is actually answering. When a change seems to have
had no effect, compare that against the process you believe you started — it is the fastest way
to catch this. Watch the handover, though: for a second or two after the kill the old process
can still answer one last request, so a `pid` that looks unchanged may just be a stale reply.
Ask again before concluding anything.

## The related guard

`startServer()` refuses to start when another loopback listener already holds the port, which
stops a second server from splitting state across IPv4 and IPv6. That guard makes the duplicate
*fail loudly*; it does nothing about the original still running.
`scripts/check-local-bind.mjs` covers both.
