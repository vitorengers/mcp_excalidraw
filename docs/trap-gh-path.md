# Trap: `gh` is missing from the child process PATH

The issue agent is told to create the issue with `gh`. A canvas server started *before* the
GitHub CLI was installed inherits a PATH without it — and the agent, spawned as a child,
inherits that stale PATH in turn. The agent then cannot run the one command the whole feature
depends on.

The symptom points at the agent. The cause is the age of the server process.

## The fix in code

`agentPath()` in `src/core/issue-agent.ts` appends the GitHub CLI directory when the inherited
PATH does not already contain it:

```
C:/Program Files/GitHub CLI
C:/Program Files (x86)/GitHub CLI
```

Forward slashes on purpose — Windows accepts them, and they cannot be silently eaten as escape
sequences the way a lone backslash before a letter would be.

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
Pass `--repo vitorengers/mcp_excalidraw` to mean this one.
