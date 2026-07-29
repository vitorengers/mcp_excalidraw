# Claude Code status on the board

The top right of the header shows, one row per environment on this machine, what Claude Code
has spent against its 5-hour and 7-day windows and which account spent it:

```
Windows        me@example.com        5h 24% (1h 04m)   7d 41% (5d 23h)
Ubuntu-22.04   other@example.com     5h —              7d 12% (2d 05h)   1h old
```

Windows and WSL are separate homes, so they are separate credential stores and frequently
separate subscriptions. That is the reason there is a row each rather than one figure: a
percentage attributed to the wrong account is worse than no percentage at all.

Off unless configured. Unset `EXCALIDRAW_CLAUDE_STATUS` and `GET /api/claude-status` answers
404 and nothing renders.

## Why a file, and not a lookup

**The data has no supported pull interface. It is pushed, once, into a live session.**

Claude Code hands its [status line](https://code.claude.com/docs/en/statusline) command a JSON
document on stdin, and that document carries `rate_limits.five_hour.{used_percentage,resets_at}`
and `rate_limits.seven_day` — the source of the `5h:` and `7d:` segments an operator already
reads at the bottom of a session. Nothing asks for it:

- `/status` (organisation, email) and `/usage` (the windows) are **interactive slash commands**.
- The [OpenTelemetry export](https://code.claude.com/docs/en/monitoring-usage) has no
  rate-limit metric and no quota attribute.
- `claude --help` lists no usage subcommand.

There is an undocumented OAuth usage endpoint behind the token in `.credentials.json`. It is not
used here and will not be: that token is authentication material this repository has never
touched, and `CLAUDE_CODE_OAUTH_TOKEN` — the one Anthropic documents for scripting — is
documented as able to make model requests *only*.

So the status line writes the figures down and the board reads them. That script belongs to the
operator already and is the one place the data lands.

**The honest cost is freshness.** A file is only as fresh as the last session that wrote it, so
every reading carries its age and one older than **ten minutes** is drawn amber with that age
beside it. A percentage without its age reads as current when it is not, and that is the one way
this feature could lie rather than say nothing.

The account is likewise the account of the session that wrote the file. `rate_limits` "appears
only for Claude.ai subscribers (Pro/Max) after the first API response in the session", each
window independently — so under API-key auth there are no windows to report, and a row will show
its account and two dashes.

## Setting it up

### 1. Point the board at a directory

```
EXCALIDRAW_CLAUDE_STATUS=C:\Users\you\.claude\board-status
```

A **directory**, not a file, and one directory for the whole machine. The alternative was to
read each home's own file, which for a distro means either guessing at its `$HOME` through the
UNC share or spawning a `wsl.exe` on every poll. A session inside a distro can write to
`/mnt/c/...` itself, so the crossing happens once, in the operator's own script, in the
environment that knows where it is.

One file per environment, by name:

| File | The environment it stands for |
|---|---|
| `native.json` | The host the board runs on — labelled `Windows` there, `Host` elsewhere |
| `wsl-<distro>.json` | A session inside that distro — labelled with the distro's own name |

### 2. Have each status line command write its file

Any script that produces the shape below will do. Every field is optional and absent is
**not zero**:

```json
{
  "account": "me@example.com",
  "fiveHour": { "usedPercent": 23.5, "resetsAt": 1738425600 },
  "sevenDay": { "usedPercent": 41.2, "resetsAt": 1738857600 },
  "observedAt": 1738420000
}
```

`resetsAt` and `observedAt` are Unix epoch seconds — the units Claude Code's own `resets_at`
uses — and an ISO 8601 string is accepted for either. With no `observedAt` the file's own
modification time is used, so a reading always has an age.

Claude Code's own spelling is read too, which makes the shortest possible writer a `jq` that
passes through the object it was handed:

```bash
# in your statusLine command, on stdin
tee >(jq -c '{account: env.CLAUDE_ACCOUNT, rate_limits, observedAt: now}' \
      > "$STATUS_DIR/native.json") | your-existing-status-line
```

`rate_limits.five_hour.used_percentage` / `resets_at` and `rate_limits.seven_day` are accepted
wherever `fiveHour` / `sevenDay` are. The account is not in that schema — Claude Code does not
put the email in the status line document — so it comes from wherever your script can name it.
`~/.claude.json` carries `oauthAccount.emailAddress`, one file per home and therefore per
environment; it is undocumented, so read it defensively:

```bash
jq -r '.oauthAccount.emailAddress // empty' ~/.claude.json
```

From inside WSL, write to the same directory through `/mnt/c`:

```
/mnt/c/Users/you/.claude/board-status/wsl-Ubuntu-22.04.json
```

**Nothing in that file but the fields above is ever served.** The route projects known fields
out rather than echoing what it read, so dumping a wider object into that directory cannot
publish anything else. It is still the operator's directory: do not write a token into it.

## What the board does with it

`GET /api/claude-status` — **global, not workspace-scoped**, because it describes machines
rather than projects, and it sits with `/health` rather than with `/api/elements` for that
reason. **Loopback only**, because it serves an email address, and the guard comes before the
404: on a board bound to a LAN address, whether this is configured is itself not something to
answer.

```json
{
  "success": true,
  "staleAfterSeconds": 600,
  "environments": [
    {
      "label": "Windows",
      "environment": { "kind": "native" },
      "account": "me@example.com",
      "fiveHour": { "usedPercent": 23.5, "resetsAt": 1738425600 },
      "sevenDay": { "usedPercent": 41.2, "resetsAt": 1738857600 },
      "observedAt": 1738420000,
      "ageSeconds": 42,
      "stale": false
    }
  ]
}
```

The environments listed are **the host, plus every distinct `distro` in the registry, plus every
distro a file in the directory names**. A distro is declared and never detected, and the registry
is the only place a board declares one — so a machine you run sessions on but have no project in
could not be enumerated from it. Writing the file is a declaration too. An environment that
answers nothing is listed as *unknown* rather than dropped: a machine missing from the HUD looks
exactly like one that is idle, and only one of those wants attention.

A five-second memo sits in front of the read, so four project tabs polling on the same second are
one pass over the directory.

## The HUD

At the right-hand end of the header, which is the **page's** top right. The canvas viewport's
top right is `layer-ui__wrapper__top-right`, a grid column Excalidraw owns and already keeps its
library trigger in. Being in the header means the HUD cannot become a scene element, cannot reach
a PNG export, and survives **Hide Menus** — which is about Excalidraw's chrome, not this board's.

Polled once a minute while the tab is on screen, and not at all while it is hidden. A minute is
what the observation asked for and is a ceiling rather than a promise: the figures underneath are
only as fresh as the last session. `?claudeStatusPollMs=` on the board's URL overrides the
cadence, clamped to 200 ms – 10 minutes, and the interval in use is on the element as
`data-poll-ms`.

The context window is deliberately **not** here. It is per-conversation, so a board-wide figure
for it would mean nothing.

## Checks

| Script | What it pins down |
|---|---|
| `scripts/check-claude-status.mjs` | Two environments kept apart, an absent window staying `null`, a stale reading flagged, malformed input skipped, the 404 and the 403, and that nothing else from the file comes back |
| `scripts/check-claude-status-browser.mjs` | The HUD in a real browser: both rows top right, clear of Excalidraw's island, surviving `Hide Menus`, one poll a minute and none while hidden, and both themes judged on rendered pixels |

Related: [running.md](running.md) for the variable, [rest-api.md](rest-api.md) for the route,
[workspaces.md](workspaces.md) for where a distro is declared.
