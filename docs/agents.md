# Choosing the agent

`EXCALIDRAW_ISSUE_AGENT` and `EXCALIDRAW_IMPLEMENT_AGENT` are **command lines**, not a vendor.
The board spawns what they say, hands it a prompt and reads a URL back out of what it printed.
`src/core/agent-preflight.ts` already names nine binaries it recognises at startup, and the only
reason it holds a list at all is that `/health` must not echo somebody's command line back over
an unauthenticated socket.

Since #326 `src/` *can* name a backend — `src/core/agent-adapter.ts` and `src/core/agents/`,
where a backend builds the argv, says whether the run streams and reads its own events — but
the agent variables above, which `docs/running.md` lists, are still read as a command line and
nothing more. Every board is the
`raw` backend: an arbitrary command line, spawned byte for byte, which streams if and only if it
says `--output-format stream-json`. So the recipes below are what an operator writes, and they
are unchanged by that seam existing.

The documentation was the part that assumed. The command was specified once, in the
configuration section of [issue-block.md](issue-block.md#configuration), with the binary
genericised to `<agent-binary>` and Claude Code's flags left around it — `-p`, `--model`,
`--effort`, `--allowedTools`, `--output-format stream-json` — and [running.md](running.md)
repeated those as requirements. Substitute another binary, keep the flags, and you get the
failure [trap-allowed-tools.md](trap-allowed-tools.md) exists to warn about: a run that
investigates the repository perfectly well, is refused the moment it needs `gh`, and exits **0
with no URL**. `-p` is the sharpest case of it. To Claude Code that is `--print`; to Codex CLI
it is `--profile`, which takes an argument, so the same three characters make one CLI
non-interactive and make the other swallow the next token as the name of a profile.

This document is the two recipes that have been worked out, and the rules underneath them that
hold for the third agent nobody has written a recipe for yet.

## What the board requires of any agent

Four things, and they are properties of the run rather than of a product.

1. **It runs non-interactively and exits.** The board waits for the process to end; a CLI that
   draws an interface and returns to its own prompt holds the block in `running` and its slot in
   `EXCALIDRAW_IMPLEMENT_CONCURRENCY` until somebody closes the tab. (Leaving the print flag off
   *on purpose* is a supported thing to do — see [Watching a run instead](#watching-a-run-instead)
   — but it is a choice about one board, not a default.)
2. **It takes its instructions on stdin.** `runAgent` in `src/core/issue-agent.ts` writes the
   whole prompt to the child's stdin and closes it, with no shell in between, because the prompt
   is several hundred words with quotes and backticks in it and passing that as an argument
   breaks on Windows long before the agent sees it. An agent that only accepts a prompt as an
   argument cannot be driven this way. There is exactly one exception, and it is the
   [interactive path](#watching-a-run-instead).
3. **It is permitted to run the `gh` and `git` sub-commands its prompt names, without asking.**
   No prompt can be answered, so a tool that would need approval is not approved — it is
   refused, and the refusal is silent. That cuts both ways, which is why the grant is stated as
   verbs: too little and the run exits 0 having quietly not looked, too much and an issue agent
   can push. Both agents also need the network: `gh` talks to github.com.
4. **It prints the URL on stdout, and last.** `extractGithubUrl` reads raw stdout, so NDJSON,
   prose and a progress spinner around it are all fine; what matters is that the issue or pull
   request URL is in there. The prompt the board writes already orders the agent to print it
   last, so this is a requirement on the agent's *output reaching stdout at all*.

The board holds these of both agents. What differs between the two is power, and deliberately:
the issue agent gets reading, and the handful of `gh` and `git` sub-commands the prompt actually
names, and nothing that writes, so that turning on issue blocks cannot quietly turn on
repository writes. The implement agent has to write code, run the build and run the checks, so
it gets everything.

## Claude Code

```
EXCALIDRAW_ISSUE_AGENT='claude -p --model claude-opus-5[1m] --effort high --allowedTools "Bash(gh issue list:*) Bash(gh issue view:*) Bash(gh issue create:*) Bash(gh issue edit:*) Bash(gh issue comment:*) Bash(gh project item-add:*) Bash(git log:*) Bash(git show:*) Bash(git diff:*) Bash(git blame:*) Read Grep Glob WebFetch WebSearch"'
EXCALIDRAW_IMPLEMENT_AGENT='claude -p --model claude-opus-5[1m] --effort high --allowedTools "Read Grep Glob Write Edit NotebookEdit Task TodoWrite WebFetch WebSearch Bash(git:*) Bash(gh:*) Bash(npm:*) Bash(npx:*) Bash(node:*)"'
```

`-p` is what makes it answer and exit. `--allowedTools` is an enumerated list and therefore also
a *deny* list, so **both** lists cost something: a tool nobody predicted is refused with no
prompt and the run exits 0 having quietly not done it. The issue list is narrow because that is
the point of the split; the implement list is wide and bounded — everything a change needs, and
no arbitrary shell — because since #327 the alternative it replaced was
`--dangerously-skip-permissions` as a *default*, on an agent whose prompt is built from issue
text anybody can write. `WebFetch` and `WebSearch` are in both because both prompts order the
agent to research what the repository does not settle. See
[trap-allowed-tools.md](trap-allowed-tools.md) for both halves, per backend, observed rather
than reasoned about — and widen either list **by name**, never by dropping it.

`VIBEMAXXING_IMPLEMENT_FULL_ACCESS=1` is how a board asks for `--dangerously-skip-permissions`
on purpose. It reaches the implement agent only, and a board that has it — or writes the flag
into the command line itself — says so in a warning at startup.

**Every `Bash` rule in it names a sub-command rather than a binary**, which is why the list is
ten rules long instead of two. A rule naming `gh` or `git` with no verb after it grants every
verb the binary has: `gh repo delete` and `gh api -X DELETE`, `git commit`, `git push --force`
and `git config` — the whole write reach of the account behind `gh`, handed to an agent whose
prompt sends it to read the open web and act on what it finds.
[trap-allowed-tools.md](trap-allowed-tools.md) is the list rule by rule, what each one is for,
and what the narrowing costs: a verb nobody predicted is refused just as silently, so **widen it
by verb, never by binary**.

Add `--output-format stream-json --verbose` to either command to get token counts and a
transcript that arrives as the run goes. Nothing else turns them on, and nothing else is needed.

## Codex CLI

```
EXCALIDRAW_ISSUE_AGENT='codex exec --sandbox workspace-write -c sandbox_workspace_write.network_access=true -m gpt-5.6 -c model_reasoning_effort="high"'
EXCALIDRAW_IMPLEMENT_AGENT='codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.6 -c model_reasoning_effort="high"'
```

`codex exec` is the non-interactive subcommand — bare `codex` is the interface — and its usage
is `codex exec [OPTIONS] [PROMPT]`, where the help for the positional says: *"If not provided as
an argument (or if `-` is used), instructions are read from stdin."* That is rule 2 satisfied
without a flag, and it is why the recipe carries **no** trailing `-`: the interactive path hands
the prompt as an argument instead, and a command line that insists on stdin would then wait for
an end of file that a pseudoterminal cannot give.

Four things about the flags are worth stating, because each one is a way this recipe could have
been plausible and wrong:

- **`-p` is `--profile` here.** Copy Claude Code's `-p` across and Codex reads the next token as
  a profile name — and the board reads that same `-p` as "this command prints and exits", which
  is one of the shapes it sniffs for. Two failures from one character.
- **`--sandbox workspace-write` restricts the network.** The `network_access` key only exists
  under that mode, and without it the sandbox is exactly what a silent `gh` failure looks like.
  It is `-c sandbox_workspace_write.network_access=true` on the command line, the same key as
  `[sandbox_workspace_write] network_access = true` in `config.toml`.
- **`workspace-write` keeps `.git` read-only.** `.git`, `.agents` and `.codex` in the workspace
  root stay protected under a writable root, which is right for the issue agent — it reads the
  repository and writes nothing — and is why the implement recipe does not use that mode: an
  implementation that cannot commit is an implementation that ends with nothing.
  `--dangerously-bypass-approvals-and-sandbox` is the counterpart of Claude Code's
  `--dangerously-skip-permissions`, and it is the same deliberate choice, made by whoever runs
  the board: the implement agent is given the machine. It is the one recipe here that is
  full access, and it is written out rather than assumed for that reason — a named `codex-cli`
  backend writes `--sandbox workspace-write` for the implement role and reaches this row only
  through `VIBEMAXXING_IMPLEMENT_FULL_ACCESS=1`, which is the same choice made where a board can
  see it. Both spellings warn at startup.
- **Effort is a config override, not a flag.** `-c model_reasoning_effort="high"`; `-c` is
  repeatable and its value is parsed as TOML, falling back to the raw string. The quotes are
  consumed by `tokenizeCommand` in `src/core/issue-agent.ts`, which keeps a quoted run together
  and hands the child one argument, so what Codex receives is `model_reasoning_effort=high`.

**This recipe has not been run end to end on this board.** Every flag in it was read out of
Codex CLI's own source and documentation rather than remembered, and the reasoning above is
where each came from — but no Codex binary is installed on the machine this was written on, so
what is asserted here is that the command line is well formed and grants what the four rules
require, not that a run of it opened an issue. Run it once for real before relying on it; that
is the difference between this document and a second source of exit-0 failures.

## What each flag buys, and what a missing one costs

| What you want | Claude Code | Codex CLI | Without an equivalent |
|---|---|---|---|
| Non-interactive | `-p` / `--print` | `codex exec` | The run never ends; the block sits in `running` and holds a concurrency slot |
| A pinned model | `--model <id>` | `-m <id>` | The agent inherits whatever an interactive session last configured, so changing your own model silently changes who writes the issues |
| Pinned effort | `--effort <level>` | `-c model_reasoning_effort="<level>"` | The same, one setting along |
| The `gh` and `git` verbs it needs, no writes | `--allowedTools "Bash(gh issue create:*) Bash(git log:*) …"` — one rule per sub-command, never `Bash(<binary>:*)` | `--sandbox workspace-write` plus `network_access` | Either the agent is refused silently, or the issue agent can write to the repository — this is the one degradation worth refusing to accept |
| `gh`, `git` and everything | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | An implementation that cannot build, test or commit |
| Token counts and a live transcript | `--output-format stream-json --verbose` | — (see below) | The run is timed but not counted, and its output arrives at exit. Not a degraded state; it is the default |

## What the board reads out of your command line

Two flags are read as *shapes* rather than as settings, so there is no second variable to keep in
step with the first, and both are matched as whole arguments. A third pair is written *onto* what
you wrote, which is the same assumption from the other end.

| Read or written | What it decides | Where |
|---|---|---|
| `-p` / `--print` | Whether the run gets a pseudoterminal, and whether the prompt travels on stdin or as the last argument | `runsHeadless`, `src/core/issue-agent.ts` |
| `--output-format stream-json` | Whether a token meter runs, and whether the tab renders a transcript instead of raw NDJSON | `streamsUsage`, `src/core/agent-usage.ts` |
| `--model`, `--effort` | Appended, per project, from `board.config.json` — the last flag is the one the CLI keeps | `agentCommandFor`, `src/core/issue-agent.ts` |

**Every one of them is Claude Code's spelling**, and that is the honest state of it: a Codex run has
`--json` available and the board does not read it, so a Codex board gets a clock and no token
figures. Widening the sniffing so that another agent's flags are understood is a change to the
agent runtime, not to this document — it belongs with the backend adapter that
`agent-preflight.ts` describes as *"where a command stops being an opaque string"*.

The `--model` and `--effort` line is the one to watch when a project overrides them: those two
are appended in Claude Code's spelling, so a project-level model or effort on a board running
Codex would append a flag Codex does not have. Leave `agents.<kind>.model` and
`agents.<kind>.effort` unset there and pin the model in the command line instead — see
[issue-block.md](issue-block.md#what-is-per-project-and-what-stays-global) for what a project
may and may not say.

## Watching a run instead

Leaving the print flag off is supported, and it is the one exception to rule 2. With the
terminal on and a pseudoterminal binding available, an implement command that does **not** say
`-p`/`--print` is given a terminal, the prompt travels as the command's last argument, and stdin
stays yours — the tab becomes something to answer rather than something to watch. What comes off
with the flag is the token counts, the ending (a session ends when you end it) and unattended
runs. [issue-block.md](issue-block.md) has the trade in full, and [terminal.md](terminal.md) has
the measurement that rules out the alternatives.

For Codex this matters twice: `codex exec` still exits on its own, so it settles either way, but
because the prompt then arrives as an argument, a recipe written as `codex exec -` would be
waiting on a stdin nobody is going to close.

## Before you trust a new recipe

- `GET /health` reports `agents`, per role and per environment, from a preflight that **runs**
  the configured binary rather than checking that a variable is non-empty — `found`, `not found`,
  `unconfigured` and the rest. `vibemaxxing doctor` asks the same question from a shell
  ([cli.md](cli.md)). A `not found` also prints a warning line at startup naming the role, the
  environment and the binary.
- That only proves the binary exists. The flags are what fail silently, so the first run of a new
  recipe is worth watching: an issue block that goes to `failed` with *"Agent finished without
  returning an issue URL"* is almost always a permission the command line did not grant.
- A project inside a WSL distro needs the `_WSL` command, spelled as the distro spells it —
  [running.md](running.md) has that, and it is the same argument in a different environment.

`node scripts/check-agents-doc.mjs` holds this document to being usable: two binaries, both
roles, each recipe carrying the flag that makes that binary non-interactive and the grant that
lets it run `gh` and `git`, and the three documents above still linking here.
