# Security policy

The trust model this tool asks you to accept, written down, because the strongest statement of
it used to be a paragraph inside [terminal.md](terminal.md) — a page nobody reads before
installing.

**VibeMaxxing is a local canvas server that can spawn coding agents and real shells, and its
API has no authentication.** Everything below is what that means and what stands in front of
it. It is here rather than in the README because the README is where somebody decides to
install this, and this is what they are deciding.

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
interface on a server whose API has no authentication.

So the question this document answers is not "what can the tool do" — it can do what you can
do. It is **who can make it do that**, and the answer is: whatever can reach the port, subject
to the guards below.

## What is off by default

Five switches turn a drawing canvas into something that runs code. Every one of them is
**unset by default**, and each is a *command line you write*, not a vendor the tool picked —
the tool runs the command you gave it, so the agent's own permissions are whatever that
command grants.

| Switch | What turning it on grants |
|---|---|
| `EXCALIDRAW_ISSUE_AGENT` | `POST /api/issue-block/:id` spawns this command line to research an observation and open a GitHub issue with your `gh` credentials. One fixed prompt, one run at a time per block. Deliberately a read-and-`gh` agent — [issue-block.md](issue-block.md) |
| `EXCALIDRAW_ISSUE_AGENT_WSL` | The same, inside a WSL-backed project's distro. Unset, it falls back to `EXCALIDRAW_ISSUE_AGENT`, which resolves inside a distro only if it was written without an absolute path |
| `EXCALIDRAW_IMPLEMENT_AGENT` | `POST /api/issue-block/:id/implement` spawns this command line **with repository write access**: a git worktree of its own, commits, a push, a pull request, and — where the project's own memory says so, as this one's does — the merge. Up to `EXCALIDRAW_IMPLEMENT_CONCURRENCY` (default 4) at once |
| `EXCALIDRAW_IMPLEMENT_AGENT_WSL` | The same, inside the distro, with the same fallback. It is the *research/implement* split that never crosses: enabling research must not thereby enable repository writes, which is why these are four variables and not two |
| `EXCALIDRAW_TERMINAL` | `POST /api/terminal` starts a **real shell** and `POST /api/terminal/input` types into it — whatever arrives over the API, run as you. At most eight sessions per board; the ninth is a 409. Unset, every terminal route is a 404 rather than a 403 — [terminal.md](terminal.md) |

Two more are worth knowing about even though they grant nothing on their own:
`EXCALIDRAW_GH_COMMAND` names the `gh` binary the server invokes, and `EXCALIDRAW_EXPORT_DIR`
is the base directory an MCP file export may write into. Both are paths, and a path is a
decision about what runs and what is overwritten.

Turning any of the five on is a decision to let **anything that can reach this server** trigger
that command. The rest of this document is about who that is.

## Where it listens

`HOST` defaults to **`127.0.0.1`**, and `PORT` to 3737 — a preference the launch path walks
past to the next free port, not a pin ([running.md](running.md)).

`HOST=0.0.0.0` publishes the board on **every network interface**, and the API has no built-in
authentication of any kind: no token, no password, no session. Everyone who can route a packet
to that port is the operator as far as this server is concerned. Do not do it on a network you
do not control, and put access control in front of it if you do it at all.

What a non-loopback bind actually exposes, because the dangerous half refuses to run there:

- **Refused with 403 off loopback** — the issue block and the implement run, the terminal, the
  workspace registry and project settings, the directory picker, the GitHub project mirror and
  card moves, `/api/github-status`, `/api/claude-status`, and the restart route. The board says
  so on itself rather than drawing an empty region.
- **Still answered** — the drawing canvas: elements, files, image export, viewport, snapshots
  and `GET /api/docs/:key`. Read and write, by anyone who can reach the port. Treat everything
  on a board bound that way as public and as anybody's to change.

The guard is a test of the **bind address**, not of the caller's address: a server on
`0.0.0.0` refuses those routes for the loopback client too. That is the intended trade — a
board published on an interface is a drawing canvas and nothing else.

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
  shell's scrollback on connect, and it is a door CORS never covered at all.

`scripts/check-cross-origin.mjs` holds both sides of this.

**What the gate does not defend against is a local program.** Any process that can open a
socket to the port — yours, or another account's on a machine you share — sends no `Origin` at
all and drives the whole API, including the switches above. Loopback is not a permission
boundary between users. On a shared machine, a board with the agents or the terminal enabled is
a shell for everybody with a login on it.

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

The registry, the per-board scene state, the pidfile and `config.json` sit in a per-user state
directory ([configuration.md](configuration.md)); the log file goes where `LOG_FILE_PATH` says.
The board holds whatever you drew on it. None of it is encrypted, and none of it is sent
anywhere by this tool — the network calls it makes are `gh` to GitHub, and whatever the agent
command line you configured does on its own account.

## Related

- [issue-block.md](issue-block.md) — the research agent, and the guards on it
- [terminal.md](terminal.md) — the shells, the session cap, and why the cap is a number
- [running.md](running.md) — every `EXCALIDRAW_*` variable, with its default
- [workspaces.md](workspaces.md) — what a project is, and what a board is pointed at
