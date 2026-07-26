# Issue block

Write an observation into a shape marked `customData.kind = "issue"`, click the button in its
panel, and an agent investigates the repository and opens the issue. The URL comes back onto
the block.

This spawns a process with full read access to a repository from an API that has no
authentication. It is the most dangerous thing this server does, so three guards apply and none
of them is optional:

- it only runs when `EXCALIDRAW_ISSUE_AGENT` is set, so it cannot be reached by default;
- it refuses to run unless the server is bound to loopback;
- one run at a time per element, so a double click cannot open two issues.

## The flow

`POST /api/issue-block/:id` answers **202 immediately** — an investigation takes minutes and a
held-open request would just time out somewhere else. The observation is read from the shape's
own text, or from a text element bound to it. State lands back on the element as
`customData.issueState` (`running` → `created` / `failed`), `issueUrl` and `issueError`.

A second click while a run is in flight gets 409. So does a block that already has an issue.

## The prompt

`ISSUE_AGENT_PROMPT` in `src/core/issue-agent.ts` tells the agent to investigate before writing:
find the root cause and cite it as `file:line`, check whether an open issue already covers it,
read the project's documentation before proposing a solution. Then write context, root cause or
competing hypotheses, scope, a verifiable definition of done, and the assumptions — and never
fill a gap with a guess presented as fact.

It also fixes the output language. The observation is typed on the board in the maintainer's own
language; the issue is a development artifact and those are English. Without that line the agent
mirrored the observation, which is how issue #20 came out in Portuguese.

## Configuration

```
EXCALIDRAW_ISSUE_AGENT='C:/Users/vtr_d/.local/bin/claude.exe -p --allowedTools "Bash(gh:*) Bash(git:*) Read Grep Glob"'
EXCALIDRAW_ISSUE_AGENT_TIMEOUT=1200
```

`--allowedTools` is mandatory. In `-p` mode the agent investigates fine, but any command needing
approval is blocked, so it finishes with exit code 0 and no issue at all. The list is narrow on
purpose — `gh`, `git`, and reading. No `Write`, no `Edit`, no open `Bash`: the agent opens
issues, it does not touch the repository.

A WSL-backed project runs through `wsl.exe --cd <innerPath>`, because the agent has to see the
repository the way `git` and `gh` inside that distro do.
