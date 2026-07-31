# Trap: port 3000 is unusable on this machine

The canvas used to default to port 3000. On this machine it can never work there — which is
half of why #303 moved the default to 3737 for everybody.

A Windows portproxy rule maps `0.0.0.0:3000` to `localhost:3000` — that is, to itself. The
`iphlpsvc` service answers on the listening socket and the connection dies in the loop. Nothing
in the canvas server is involved, which is exactly why it is hard to see: the server starts
fine, reports healthy, and every request hangs.

3737 is now the shipped default rather than something whatever starts the board has to set —
see [running.md](running.md). A `PORT` that *is* set is a pin and is never scanned past, so a
machine that still has the portproxy rule and pins 3000 gets the same hang; unpinned, the launch
path walks to the next free port and prints where it went. The check scripts never touch either
number: each asks the kernel for a free port and starts its own instance on it.

## How to recognise it

The server logs a successful bind, `/health` never answers, and there is no error anywhere. If
port 3000 ever behaves this way again:

```
netsh interface portproxy show all
```

A rule whose listen address and connect address are the same host is the one to delete.

## Why it is written down

Because the symptom points at the server. Every instinct says the process failed to start, or
bound the wrong interface, or crashed silently — and all of that is wrong. The fix is one port
number, and finding it the second time should not cost what it cost the first time.
