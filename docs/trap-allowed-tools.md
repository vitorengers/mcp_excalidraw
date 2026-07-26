# Trap: the headless agent is blocked without `--allowedTools`

`claude -p` runs non-interactively. Any command that would need approval is not prompted for —
it is refused. So the issue agent investigates the repository perfectly well, writes a good
issue in its head, and then cannot run `gh`. It exits **code 0, with no URL**.

Exit code 0 is what makes this expensive. Nothing failed. The server sees a clean exit, finds no
URL in stdout, and reports that the agent finished without producing one — which reads as the
agent being confused, not as the agent being muzzled.

## The configuration

```
EXCALIDRAW_ISSUE_AGENT='C:/Users/vtr_d/.local/bin/claude.exe -p --allowedTools "Bash(gh:*) Bash(git:*) Read Grep Glob"'
```

The list is deliberately narrow: `gh` and `git`, plus reading. **No `Write`, no `Edit`, no open
`Bash`.** The agent opens issues; it does not touch the repository. This is not a formality —
the block spawns a process with full repository access from an API that has no authentication.

## Why quoting matters

`--allowedTools` takes one argument containing spaces. The command string is tokenised by
`tokenizeCommand()` in `src/core/issue-agent.ts`, which keeps quoted runs together and consumes
the quotes. There is no shell in the spawn, so nothing else would strip them.
