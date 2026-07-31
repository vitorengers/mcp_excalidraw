# Trap: `gh` is missing from the child process PATH

The issue agent is told to create the issue with `gh`. A canvas server started *before* the
GitHub CLI was installed inherits a PATH without it — and the agent, spawned as a child,
inherits that stale PATH in turn. The agent then cannot run the one command the whole feature
depends on.

The symptom points at the agent. The cause is the age of the server process.

## The fix in code

`agentPath()` in `src/core/issue-agent.ts` appends the directories a tool conventionally lives
in when the inherited PATH does not already resolve one. It is the single PATH repair every
child of this server receives: the issue agent, the implement agent, both `gh` runners
(`src/core/gh.ts` and `src/core/github-issue.ts`) and every terminal session all go through
`agentEnv()`, which is `{...process.env, PATH: agentPath()}`.

On Windows:

```
C:/Program Files/GitHub CLI
C:/Program Files (x86)/GitHub CLI
```

Forward slashes on purpose — Windows accepts them, and they cannot be silently eaten as escape
sequences the way a lone backslash before a letter would be. One of the two is appended, and
only when it actually holds a `gh.exe`.

On macOS and Linux:

```
/opt/homebrew/bin                 Homebrew on Apple silicon
/usr/local/bin                    Homebrew on Intel macOS, and the usual local install
/home/linuxbrew/.linuxbrew/bin    Homebrew on Linux
~/.local/bin                      pipx, uv, and Claude Code's own installer
/usr/bin                          the distro's own, which a stripped PATH can lack
```

Every one of those that **exists** and is not already on the PATH is appended — existence
rather than "holds a `gh`", because the agent binary has the identical problem and lives in the
same directories, and a repair that found `gh` while leaving `claude` unfound fixes half of one
launch. Nothing is ever prepended, so this cannot shadow a tool the machine's own PATH chose.

## It is a launcher trap on macOS, not a stale-server one

The Windows half above is about the *age* of the server process. The POSIX half is about how it
was started. A server started from a shell already has Homebrew's prefix on its PATH, so none of
this is reachable there — which is why the function returned the inherited PATH untouched on
those two platforms for as long as it did, and why nothing noticed. A server started from a
double-clicked launcher, from Finder, from a `.desktop` entry or from a LaunchAgent inherits
launchd's minimal PATH: `/usr/bin:/bin:/usr/sbin:/sbin`, where neither `gh` nor the agent binary
can be found. Every `gh` call fails with ENOENT and the board shows a mirror that simply did not
come back.

**The guard is a lookup, not a spelling.** It used to be `/github cli/i` against the incoming
PATH, which can only ever match a Windows Program Files directory name; it is now
`resolveExecutable('gh', …)` — the same lookup `terminal-session.ts` does before handing a
command to the PTY, which is why that function lives in `issue-agent.ts` and is imported from
there rather than copied.

**A version manager is the known gap.** A fixed list cannot see an asdf, nvm or mise install.
The alternative — harvesting the real PATH once at startup with `$SHELL -lc 'printf %s "$PATH"'`
— is what GUI-launched developer tools on macOS do, and it was turned down: it puts a login
shell on the board's startup path, where a shell that prompts, a shell that is slow and a
`$SHELL` that is not POSIX are three new ways for the server to fail to come up. The list costs
five `existsSync` calls and cannot hang. Where it is not enough, `EXCALIDRAW_GH_COMMAND` below
names the binary outright.

`scripts/check-agent-path.mjs` asserts the shape of the repair and
`scripts/check-gh-path-discovery.mjs` asserts that it finds a planted `gh`. Both state the
platform rather than inheriting it, because the failure is only reachable from a GUI-launched
process on a platform this is not developed on.

## It is two machines, and two binaries

`EXCALIDRAW_GH_COMMAND` is the other half of the fix above: where the CLI is not on `PATH` at
all, the environment names it outright. On this machine it holds
`"C:\Program Files\GitHub CLI\gh.exe"`, and that value is the whole of a second trap.

A **WSL-backed project** runs every `gh` call inside its distro, through `bash -lc`. A host path
is not a file that can exist there, so a variable read once for the whole server took the mirror
off every distro-backed board the moment it was set — and the issue panel, a dragged card and
both of the moves a run writes with it. The log says
`bash: line 1: C:\Program Files\GitHub CLI\gh.exe: command not found`; the board says nothing at
all, which is how it reads as a mirror that simply did not come back (#252).

It is latent rather than obvious because it is the *environment* that decides, not the
repository. A server started without the variable runs the bare `gh`, which resolves on the host
and in the distro alike, and every board works. Setting the variable — to fix the host — is what
breaks the distro.

So `ghCommandFor(workspace)` resolves it per project:

| workspace | command |
| --- | --- |
| native | `EXCALIDRAW_GH_COMMAND`, else `gh` |
| WSL | `EXCALIDRAW_GH_COMMAND_WSL`, else `gh` |

The WSL half **does not** fall back to the host override, which is where this differs from
`agentCommandFor`'s deliberately one-way fallback. There, unset means the agent is *disabled*,
so falling back is the difference between working and off, and a bare `claude -p …` resolves in
both environments. Here unset means "the CLI is on `PATH`" — a sentence each environment answers
for itself, and `gh` is the answer that is right in both. Falling back to the host's absolute
path is not a weaker guess; it is the bug.

`scripts/check-gh-command-environment.mjs` drives a real distro across both call sites — the
project board read and the issue read were two independent places building a command line from
that one constant, so a fix applied to one and not the other looks fixed.

## It bites outside the agent too

`gh` is not on the interactive PATH on this machine either. A shell command that calls it plainly
fails with "not recognized"; use the full path, or prepend the directory first.

And `gh` resolves the repository from the git remotes, where `upstream` wins — so
`gh issue list` in this checkout lists **yctimlin/mcp_excalidraw's** issues, not this fork's.
Pass `--repo vitorengers/vibemaxxing` to mean this one.
