# Trap: port 3000 is unusable on this machine

The canvas defaults to port 3000. On this machine it can never work there.

A Windows portproxy rule maps `0.0.0.0:3000` to `localhost:3000` — that is, to itself. The
`iphlpsvc` service answers on the listening socket and the connection dies in the loop. Nothing
in the canvas server is involved, which is exactly why it is hard to see: the server starts
fine, reports healthy, and every request hangs.

Whatever starts the board therefore sets `PORT=3737` — see [running.md](running.md) — and the
throwaway instances used by the check scripts use 3838.

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
