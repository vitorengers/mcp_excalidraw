# Trap: the headless agent is blocked without `--allowedTools`

`claude -p` runs non-interactively. Any command that would need approval is not prompted for —
it is refused. So the issue agent investigates the repository perfectly well, writes a good
issue in its head, and then cannot run `gh`. It exits **code 0, with no URL**.

Exit code 0 is what makes this expensive. Nothing failed. The server sees a clean exit, finds no
URL in stdout, and reports that the agent finished without producing one — which reads as the
agent being confused, not as the agent being muzzled.

## The configuration

```
EXCALIDRAW_ISSUE_AGENT='<agent-binary> -p --allowedTools "Bash(gh issue list:*) Bash(gh issue view:*) Bash(gh issue create:*) Bash(gh issue edit:*) Bash(gh issue comment:*) Bash(gh project item-add:*) Bash(git log:*) Bash(git show:*) Bash(git diff:*) Bash(git blame:*) Read Grep Glob WebFetch WebSearch"'
```

**Every rule names a sub-command, not a binary**, and that is where the narrowness actually
lives. A rule naming a binary grants every verb the binary has. This list used to name two of
them — all of `gh`, all of `git` — under the sentence *"the agent opens issues; it does not
touch the repository"*, and that sentence was not true of it: whole `git` is `git commit`,
`git push --force` and `git config`, and whole `gh` is `gh repo delete`, `gh issue develop`,
which creates a branch, and `gh api -X DELETE` against any repository the operator's
credentials reach. The block spawns this agent from an API with no authentication, and the
prompt sends it to read this repository and the open web and to act on what it finds, so page
content was deciding what an account-level write reach did while the one document written to be
believed about permissions said there was none.

**No `Write`, no `Edit`, no open `Bash`** was always true and is not the interesting half. The
two tables below are the claim, and `scripts/check-issue-agent-allowlist.mjs` parses the list
out of the line above and holds every row of both to it, so neither table can drift from the
list without going red.

### What the list permits

| Command | Why the agent has it |
| --- | --- |
| `gh issue list` | step 2 of the prompt — an observation an open issue already covers gets a comment, not a duplicate |
| `gh issue view <url> --comments` | a rewrite run reads the issue as it stands, and its comments, before touching it |
| `gh issue create --body-file -` | what the run is for |
| `gh issue edit <url> --body-file -` | a rewrite edits in place, so the number, the card and the comments all stay valid |
| `gh issue comment <url> --body-file -` | what it does instead of duplicating |
| `gh project item-add 5 --owner vitorengers --url <issue-url>` | "add it to the configured project": a board is the record, and work that lands off it disappears |
| `git log --oneline -20` | the investigation the prompt asks for, over history rather than over the working tree |
| `git show <sha>` | the same, for one commit |
| `git diff <sha>..<sha>` | the same, across two |
| `git blame <path>` | who last changed the line the observation is about |

Reading the working tree is `Read`, `Grep` and `Glob`, which is why no `cat`, `ls` or `rg` rule
is needed here — and why an agent that wants to run one is refused, silently, as below.

### What the list refuses

| Command | What it would be |
| --- | --- |
| `git commit -m x` | a commit in the checkout the board handed it |
| `git push --force` | that commit, or anything else, over a branch on the remote |
| `git config user.email nobody@example.com` | rewriting the identity every later commit is made under |
| `git checkout -b anything` | moving the checkout other work is running in |
| `gh issue develop 1 --checkout` | a branch on the remote — the one `gh issue` verb that writes code |
| `gh repo delete vitorengers/vibemaxxing --yes` | exactly what it says, on anything the credentials reach |
| `gh api -X DELETE repos/vitorengers/vibemaxxing/git/refs/heads/main` | the same reach, through the API rather than a named verb |
| `gh pr merge 1 --squash` | landing code nobody reviewed |
| `gh auth token` | printing the credential itself into a transcript the board renders |
| `git log --oneline && git commit -m x` | nothing: a compound command is judged one segment at a time |

### The cost of narrowing, and why it is paid anyway

The refusals above are what this is for. Every *other* refusal is the trap at the top of this
document, one document along: a sub-command nobody predicted — `gh search issues`, `gh pr view`,
`git grep` — is refused with no prompt, and the run exits 0 having quietly not looked. That cost
is real, it lands entirely on the reads, and it is the reason the wider list survived as long as
it did.

It is paid anyway, because the two failures are not the same size. A refused read costs one run,
which comes back with no URL and says so on the block. The reach that was granted instead was
one page of attacker-chosen text away from a force-push under the operator's credentials, on any
repository they can reach, from a process nobody was watching. And a refused read is something an
operator can fix — add another `Bash(<binary> <verb>:*)` rule — while the other is not.

**Widen it by verb, never by binary.** A rule naming `gh` or `git` with no verb after it is the
state this document describes, restored, and both tables here stop being true the moment one
appears.

**The scoping was confirmed by running the CLI, not remembered**, because the whole fix rests on
its flag parser honouring more than the binary name:

- `--allowedTools "Bash(gh issue:*)"` runs `gh issue list` and refuses `gh repo view`;
- `--allowedTools "Bash(git log:*)"` refuses `git commit --allow-empty -m x`;
- and refuses `git log --oneline && git commit --allow-empty -m x`, so a compound command is
  judged per segment rather than by its first word;
- and several such rules in **one** argument all apply, so the list is split on the parentheses
  and not on the spaces inside each rule: four of them in one argument ran `gh issue list` and
  still refused `gh repo view`.

Every refusal there exits 0 with no result, which is this document's subject and the shape the
cost above takes.

## The same trap, one tool along

An enumerated list is also a deny list, and the trap above is a property of the list rather than
of `gh`. `WebFetch` and `WebSearch` were missing from it for as long as it existed, while the
prompt ordered the agent to research whatever the repository does not settle — so the agent was
told to look something up and refused the means, silently, exiting 0. Confirmed both ways by
running the command: without them, `Claude requested permissions to use WebFetch, but you
haven't granted it yet`; with them, the fetch and the search both go through. Same exit code.

They are read-only, so the narrowness that matters — nothing that writes code — is untouched. The
scoped form is `WebFetch(domain:example.com)`, or `WebFetch(domain:*.example.com)` for
subdomains; `WebSearch` takes no argument. Scoping is left off here because a host nobody
predicted is refused the same silent way, which is the defect rather than a fix for it.

## Why quoting matters

`--allowedTools` takes one argument containing spaces. The command string is tokenised by
`tokenizeCommand()` in `src/core/issue-agent.ts`, which keeps quoted runs together and consumes
the quotes. There is no shell in the spawn, so nothing else would strip them.
