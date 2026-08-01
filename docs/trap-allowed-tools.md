# Trap: the headless agent is blocked without `--allowedTools`

`claude -p` runs non-interactively. Any command that would need approval is not prompted for —
it is refused. So the issue agent investigates the repository perfectly well, writes a good
issue in its head, and then cannot run `gh`. It exits **code 0, with no URL**.

Exit code 0 is what makes this expensive. Nothing failed. The server sees a clean exit, finds no
URL in stdout, and reports that the agent finished without producing one — which reads as the
agent being confused, not as the agent being muzzled.

## The configuration

```
EXCALIDRAW_ISSUE_AGENT='<agent-binary> -p --allowedTools "Bash(gh:*) Bash(git:*) Read Grep Glob WebFetch WebSearch"'
```

The list is deliberately narrow: `gh` and `git`, plus reading. **No `Write`, no `Edit`, no open
`Bash`.** The agent opens issues; it does not touch the repository. This is not a formality —
the block spawns a process with full repository access, and the token in front of that API (#350)
is a file this account can read — no boundary at all against a process running as this account.

## The same trap, one tool along

An enumerated list is also a deny list, and the trap above is a property of the list rather than
of `gh`. `WebFetch` and `WebSearch` were missing from it for as long as it existed, while the
prompt ordered the agent to research whatever the repository does not settle — so the agent was
told to look something up and refused the means, silently, exiting 0. Confirmed both ways by
running the command: without them, `Claude requested permissions to use WebFetch, but you
haven't granted it yet`; with them, the fetch and the search both go through. Same exit code.

They are read-only, so the narrowness that matters — nothing that writes — is untouched. The
scoped form is `WebFetch(domain:example.com)`, or `WebFetch(domain:*.example.com)` for
subdomains; `WebSearch` takes no argument. Scoping is left off here because a host nobody
predicted is refused the same silent way, which is the defect rather than a fix for it.

## Why quoting matters

`--allowedTools` takes one argument containing spaces. The command string is tokenised by
`tokenizeCommand()` in `src/core/issue-agent.ts`, which keeps quoted runs together and consumes
the quotes. There is no shell in the spawn, so nothing else would strip them.
