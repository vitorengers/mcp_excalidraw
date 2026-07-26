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

## It bites outside the agent too

`gh` is not on the interactive PATH on this machine either. A shell command that calls it plainly
fails with "not recognized"; use the full path, or prepend the directory first.

And `gh` resolves the repository from the git remotes, where `upstream` wins — so
`gh issue list` in this checkout lists **yctimlin/mcp_excalidraw's** issues, not this fork's.
Pass `--repo vitorengers/mcp_excalidraw` to mean this one.
