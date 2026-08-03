# Security policy

The trust model this tool asks you to accept, written down, because the strongest statement of
it used to be a paragraph inside [terminal.md](terminal.md) — a page nobody reads before
installing.

**VibeMaxxing is a local canvas server that can spawn coding agents and real shells, behind a
secret only your account can read.** Everything below is what that means and what stands in
front of it. It is here rather than in the README because the README is where somebody decides
to install this, and this is what they are deciding.

Uppercase in `docs/` rather than lowercase like every other document here: GitHub reads a
security policy out of the repository root, `docs/` or `.github/` and nowhere else, and this
is the one of those three the board's own cards can point at.

## Reporting a vulnerability

Use GitHub's private advisory form —
**[Report a vulnerability](https://github.com/vitorengers/vibemaxxing/security/advisories/new)**,
also reachable from the repository's **Security** tab. It is private between you and the
maintainer until there is something to publish, and it needs no address published here.

If that form is not available to you, open an ordinary
[issue](https://github.com/vitorengers/vibemaxxing/issues) saying only that you have a security
report and asking for a private channel. **Do not put the details in it** — an issue in this
repository is public the moment it is filed.

Expect an acknowledgement within **seven days**. This is a single-maintainer project rather
than a staffed one, so that is a real expectation rather than a service level: if a week goes
by with nothing, the report has not been seen, and saying so on the issue is the right next
step.

The version supported is the **latest published one** — `@vitorengers/vibemaxxing` on npm, and
`main` in this repository. There are no maintained release branches to back-port to.

## What it runs as

**You.** The server is a Node process started by the operator, and everything it spawns is a
child of that process: your account, your environment, your `PATH`, your `gh` login, your SSH
keys, your working directories. There is no sandbox, no second user to drop to, and no
container — that path was deleted rather than half-supported, because the image bound every
interface on a server that at the time had no authentication of any kind.

So the question this document answers is not "what can the tool do" — it can do what you can
do. It is **who can make it do that**, and the answer is: whatever can reach the port, subject
to the guards below.

## What is off by default

These switches turn a drawing canvas into something that runs code. Every one of them is
**unset by default**, and each is a *command line you write*, not a vendor the tool picked —
the tool runs the command you gave it, so the agent's own permissions are whatever that
command grants.

| Switch | What turning it on grants |
|---|---|
| `EXCALIDRAW_ISSUE_AGENT` | `POST /api/issue-block/:id` spawns this command line to research an observation and open a GitHub issue with your `gh` credentials. One fixed prompt, one run at a time per block. Deliberately a read-and-`gh` agent — [issue-block.md](issue-block.md) |
| `EXCALIDRAW_ISSUE_AGENT_WSL` | The same, inside a WSL-backed project's distro. Unset, it falls back to `EXCALIDRAW_ISSUE_AGENT`, which resolves inside a distro only if it was written without an absolute path |
| `EXCALIDRAW_IMPLEMENT_AGENT` | `POST /api/issue-block/:id/implement` spawns this command line **with repository write access**: a git worktree of its own, commits, a push, a pull request, and — where the project's own memory says so, as this one's does — the merge. Up to `EXCALIDRAW_IMPLEMENT_CONCURRENCY` (default 4) at once |
| `EXCALIDRAW_IMPLEMENT_AGENT_WSL` | The same, inside the distro, with the same fallback. It is the *research/implement* split that never crosses: enabling research must not thereby enable repository writes, which is why these are four variables and not two |
| `EXCALIDRAW_IMPLEMENT_FULL_ACCESS` | `1` grants the implement agent **every permission there is** — `--dangerously-skip-permissions` for Claude Code, `--sandbox danger-full-access` for Codex CLI — instead of the enumerated grant a named backend writes for it. It reaches that role only, and a board that has it warns at startup. Nothing makes the *issue* agent a full-access one; a full-access flag written into that variable is taken back off — [trap-allowed-tools.md](trap-allowed-tools.md) |
| `EXCALIDRAW_TERMINAL` | `POST /api/terminal` starts a **real shell** and `POST /api/terminal/input` types into it — whatever arrives over the API, run as you. At most eight sessions per board; the ninth is a 409. Unset, every terminal route is a 404 rather than a 403 — [terminal.md](terminal.md) |

Worth knowing about even though they grant nothing on their own:
`EXCALIDRAW_GH_COMMAND` names the `gh` binary the server invokes, and `EXCALIDRAW_EXPORT_DIR`
is the base directory an MCP file export may write into. Both are paths, and a path is a
decision about what runs and what is overwritten.

Turning any of them on is a decision to let **anything that can reach this server** trigger
that command. The rest of this document is about who that is.

## The token in front of the API

Every request under `/api`, and every WebSocket upgrade, has to carry a secret that this start
of the server generated. Without it the answer is **401** and nothing runs.

It is a file rather than a password. The server writes it into your per-user state directory
beside its pidfile — `server-<port>.token`, owner-only — and everything entitled to drive the
board reads it from there: the launcher puts it in the URL it opens in your browser, and the CLI
and the MCP server read the file directly. You never type it, there is nothing to configure, and
it is gone when the server stops. A new start is a new secret — except a **restart**, which is a
replacement rather than a stop: the board hands its secret to the one taking its place, so the tab
watching the Restart button does not come back to a board that refuses it.

The page's half is worth knowing about, because it is what keeps the secret out of your history:
the launcher opens `http://127.0.0.1:<port>/?t=<secret>`, the page reads it once, keeps it in
`sessionStorage` for that tab, and takes it back out of the address bar. So `GET /` and the
static assets stay open — the page cannot read a token out of an address bar it has not loaded
yet — and so does `/health`, which is how any tool finds out what is listening on a port at all.
Neither of those reads a board. If you open the bare URL by hand, the page loads and the board
stays empty; start it with `vibemaxxing`, or reuse the tab the launcher opened.

**What this defends against, and what it does not.** The file's permissions are the operating
system's own boundary between accounts, so another user on a machine you share, and a sandboxed
process that cannot read your state directory, are shut out. Until this existed they were not:
loopback is not a permission boundary, and an `npm postinstall` in a project you had just opened
could start a shell here. A process already running **as you** can read the file, exactly as it
can read your SSH keys, and against that this is worth nothing. That is the deliberate limit of
the control rather than an oversight.

`VIBEMAXXING_NO_AUTH=1` turns it off, and it exists for the checks in `scripts/`, each of which
starts a throwaway board and drives it over plain HTTP. There is no reason to set it on a board
a person uses, and a board started with it writes a line saying so into its log file.

`scripts/check-token-auth.mjs` holds this — the refusal and the acceptance, the file's mode, the
refused upgrade, and, in a real browser, the launcher URL loading a working board whose address
bar no longer carries the secret.

## Where it listens

`HOST` defaults to **`127.0.0.1`**, and `PORT` to 3737 — a preference the launch path walks
past to the next free port, not a pin ([running.md](running.md)).

`HOST=0.0.0.0` puts the board on **every network interface**. The token goes with it, and it is
one secret with no sessions and no accounts behind it: anyone who has it is the operator as far
as this server is concerned, and anyone who has not is refused. Underneath that, **who is
calling** is its own guard and a second answer: a caller whose own address is not loopback — one
that did not reach this server from the machine it runs on — gets **403** from every route worth
reaching, not only the GitHub half, the agents and the terminal, but since #366 every read of
what the board holds and since #456 every write of it. There is nothing left for a stranger to
publish that way and nothing left for one to change. Do not do it on a network you do not
control, and put access control in front of it if you do it at all.

The two are not the same control and neither stands in for the other. The token is what a caller
carries; the caller's address is what the kernel filled in, and it is still the answer with
`VIBEMAXXING_NO_AUTH=1` set, which is the one configuration where the token is not there to help.

What a non-loopback bind actually leaves, now that the reads and the writes are behind the same
guard:

- **Refused with 403 to a caller that is not on this machine** — the issue block and the
  implement run, the terminal, the workspace registry and project settings, the directory picker,
  the GitHub project mirror and card moves, `/api/github-status`, `/api/agent-limits`, the restart
  route, and the board's own contents in both directions: the reads `GET /api/elements`,
  `/api/elements/search`, `/api/elements/:id`, `/api/files`, `/api/files/:id`, `/api/docs/:key`,
  `/api/library` and both snapshot reads, and the writes `POST /api/elements`,
  `PUT`/`DELETE /api/elements/:id`, `DELETE /api/elements/clear`, `/api/elements/batch`,
  `/api/elements/from-mermaid`, `/api/elements/sync`, `POST /api/files`, `DELETE /api/files/:id`,
  `POST /api/snapshots` and the four browser round-trips. The **WebSocket upgrade** is refused
  too, because it sends the whole scene on connect and an HTTP guard cannot see it.
- **Still answered** — `/health`, which is how anything finds out whether a canvas is on a port
  at all, and `GET /api/sync/status`. To a stranger a board bound that way is inert: it publishes
  nothing and takes nothing. To you, on the machine it is running on, it is an ordinary board.

Before #366 the second list was the whole drawing canvas — elements, files, documents, the
library and the snapshots. The two honest options were to guard them or to write down that a
board bound to an interface publishes its contents; they are guarded. The token had landed by
then and does not make the question go away: it is a switch away from being off, and a control
that only holds while a second one is set is not one that was decided.

#456 is the same paragraph about the other direction. Guarding the reads alone had left the
writes as the shape the routes happened to have: nobody on the network could read such a board,
and anybody reaching the port could still draw on it, empty it — `DELETE /api/elements/clear`
copies the board first, and it still empties it — and fill its file store. The two options were
the same two, and so is the answer.

**Since #501 the guard is a test of the caller's address, not of the bind.** It was the bind
until then, and the cost of that was a board on any interface being inert for *everybody* —
including the browser on the host machine, whose request comes from loopback and was refused all
the same. `HOST=0.0.0.0` and an address on a private overlay were punished identically, so a
non-loopback bind answered nothing worth having in any configuration, however narrow. Now the
board on the interface works for you and refuses the network. What lets a second machine in is a
device credential: #502 is the registry it lives in, #503 the pairing that puts one there. Until
a device is paired, remote and refused are the same answer, so nothing a stranger could not reach
before is reachable now.

**`X-Forwarded-For` is not read, and it must not be.** A reverse proxy reaches this server *on
loopback*, which is why a proxy configuration worked before that change and is untouched by it,
and `EXCALIDRAW_ALLOWED_HOSTS` is what tells the origin gate about the name in front of it.
Trusting a forwarded header would turn the one property of a caller nobody can forge into one
anybody can set: a remote caller would simply claim to be loopback. If proxy-awareness is ever
wanted it is a separate, opt-in decision with the proxy's own address pinned. IPv6-mapped IPv4
(`::ffff:127.0.0.1`) is read as loopback, because that is what a dual-stack listener reports for
an ordinary local client. `scripts/check-caller-guard.mjs` holds all of this, including a real
caller on a non-loopback address being refused with a forwarded header in hand.

## The origin gate, and why a bind test is not enough

A page at any origin, running in *your* browser, reaches `127.0.0.1` exactly as the board does.
With CORS defaults, one cross-origin `fetch` to `/api/terminal` was a shell — and a `no-cors`
fetch still executes on this side, so withholding the response is not a defence. Since #270
there is a gate in front of every route, refusing with 403 before the route runs
([src/core/origin-gate.ts](../src/core/origin-gate.ts)):

- **`Origin`** must be one the board is served on. A browser always sends it cross-origin and
  cannot be talked out of it. **Absent is allowed** — the CLI, the MCP server, `curl` and the
  check scripts send none, and a program that can set headers can set any header, so refusing
  them would cost everything and defend nothing.
- **`Host`** must be an authority this server answers for, which is what closes DNS rebinding:
  a name the attacker points at 127.0.0.1 makes their page same-origin, and no `Origin` check
  can see them. `EXCALIDRAW_ALLOWED_HOSTS` is the escape hatch for a real alias or a proxy, and
  a refusal names the authority it expected so a lockout says what to put there.
- The **WebSocket upgrade** goes through the same gate. It streams the scene and every live
  shell's scrollback on connect, and it is a door CORS never covered at all. Since #366 it is
  asked who is calling first, because a program on the network sends no `Origin` and names
  whatever `Host` it likes — the case this gate deliberately allows, and therefore the one only
  an address the kernel filled in can turn away.

`scripts/check-cross-origin.mjs` holds both sides of this;
`scripts/check-board-reads-guard.mjs` holds the caller side of the same two doors, and
`scripts/check-board-writes-guard.mjs` the caller side of everything that changes a board.

**What the gate does not defend against is a local program.** Any process that can open a socket
to the port sends no `Origin` at all, so nothing here sees it — which is why the token above
exists and why it is a file with owner-only permissions rather than a header the gate could have
checked. Between the two, another account on a machine you share is refused; a process running as
you is not, because it can read the file.

## What a run does to your repository

An implement run is the sharpest edge here, so plainly: it gets a **git worktree of its own**
(`<project>-worktrees/issue-<n>`, on a branch cut from the default branch), and inside it an
unattended agent commits, pushes and opens a pull request with your credentials — and merges
it, if the project's own workflow memory says that is how work is done, as this repository's
does. It runs with no human in the loop, by design, and up to four run at once.

Nothing in the tool limits that agent to the worktree; the tool starts a process, and the
process is as constrained as the command line you configured. Point
`EXCALIDRAW_IMPLEMENT_AGENT` at a repository you would not hand to somebody else for an
afternoon, and that is the exposure.

## What it stores

The registry, the per-board scene state, the pidfile, the running server's token and
`config.json` sit in a per-user state directory ([configuration.md](configuration.md)); the log
file goes where `LOG_FILE_PATH` says.
The board holds whatever you drew on it. None of it is encrypted, and none of it is sent
anywhere by this tool — the network calls it makes are `gh` to GitHub, and whatever the agent
command line you configured does on its own account.

## Related

- [issue-block.md](issue-block.md) — the research agent, and the guards on it
- [terminal.md](terminal.md) — the shells, the session cap, and why the cap is a number
- [running.md](running.md) — every `EXCALIDRAW_*` variable, with its default
- [workspaces.md](workspaces.md) — what a project is, and what a board is pointed at
