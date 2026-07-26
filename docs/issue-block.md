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

## After the issue exists

The block is retitled to the issue it produced: `customData.issueTitle` is stored and the bound
label is rewritten, with the original text kept as `customData.observation`. The observation is
what started the run, but once the issue exists the title is what the card is *about* — a board
full of raw observations reads like a scratchpad.

Selecting the block then renders the issue body in the panel, through the same `marked` +
`DOMPurify` path the docs block uses. The body is fetched from `GET /api/issue-block/:id/issue`
at selection time rather than stored on the element, for two reasons: kilobytes of issue text on
every block would ride in every autosync payload and every export, and a stored copy would go
stale the moment anyone edited the issue on GitHub. Only the title lives on the element, because
a card has to read correctly with nothing selected and with no network.

That route shells out to `gh issue view --json` and carries the same loopback guard as the run
route — reading is not writing, but it still spawns a process holding your `gh` credentials.
`EXCALIDRAW_GH_COMMAND` overrides the binary so `scripts/check-issue-detail.mjs` can stub it.

## The prompt

`ISSUE_AGENT_PROMPT` in `src/core/issue-agent.ts` tells the agent to investigate before writing:
find the root cause and cite it as `file:line`, check whether an open issue already covers it,
read the project's documentation before proposing a solution. Then write context, root cause or
competing hypotheses, scope, a verifiable definition of done, and the assumptions — and never
fill a gap with a guess presented as fact.

It also fixes the output language, and the reason is less obvious than it looks. Issue #20 came
out entirely in Portuguese from an observation written in English — the observation's language
is not what decided it. Step 3 sends the agent to read the project's own documentation before
proposing anything, and that project documents in Portuguese, so the agent took the language
from its surroundings. Nothing in the prompt said otherwise. Now it names English outright.

## Configuration

```
EXCALIDRAW_ISSUE_AGENT='C:/Users/vtr_d/.local/bin/claude.exe -p --model claude-opus-5[1m] --effort high --allowedTools "Bash(gh:*) Bash(git:*) Read Grep Glob"'
EXCALIDRAW_ISSUE_AGENT_TIMEOUT=1200
```

**Pin the model and the effort.** Without `--model` and `--effort` the agent inherits whatever
`~/.claude/settings.json` happens to say, so changing the model of an interactive session
silently changes who writes the issues — and that is not a change anyone would think to look for
when an issue comes out worse than usual. The `[1m]` suffix selects the 1M-context variant.

`--allowedTools` is mandatory. In `-p` mode the agent investigates fine, but any command needing
approval is blocked, so it finishes with exit code 0 and no issue at all. The list is narrow on
purpose — `gh`, `git`, and reading. No `Write`, no `Edit`, no open `Bash`: the agent opens
issues, it does not touch the repository.

A WSL-backed project runs through `wsl.exe --cd <innerPath>`, because the agent has to see the
repository the way `git` and `gh` inside that distro do.
