# Trap: the old server does not die on its own

Start a new canvas while an old one still holds the port and the new process fails to bind and
exits. The old one keeps answering — **silently, with the old code**.

This is the worst failure mode in the project, because everything looks like it worked. The
browser reconnects. Requests succeed. The fix you just built is not there, and every attempt to
debug it is reasoning about source that is not running.

## What to do

Kill by PID before starting. `start-board.ps1` already does it:

```powershell
$busy = Get-NetTCPConnection -LocalPort 3737 -State Listen -ErrorAction SilentlyContinue
foreach ($pid in ($busy.OwningProcess | Select-Object -Unique)) {
  Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}
```

`GET /health` returns the `pid` of whatever is actually answering. When a change seems to have
had no effect, compare that against the process you believe you started — it is the fastest way
to catch this.

## The related guard

`startServer()` refuses to start when another loopback listener already holds the port, which
stops a second server from splitting state across IPv4 and IPv6. That guard makes the duplicate
*fail loudly*; it does nothing about the original still running.
`scripts/check-local-bind.mjs` covers both.
