# Trap: the agent outlives the issue it already created

A real investigation reads source, checks existing issues and drafts prose. The first genuine
run overran ten minutes — **having already created the issue**. The agent creates it and then
keeps working: tidying its notes, verifying, answering itself.

If the timeout simply killed the process and reported failure, the block would show an error for
work that fully succeeded, and the next click would open a second issue for the same
observation.

## The first answer, and why it was not enough

On timeout, the run salvages the URL from whatever the agent printed before the kill:

```ts
const salvaged = extractGithubUrl(stdout, options.expects);
resolve({
  ok: Boolean(salvaged),
  url: salvaged,
  ...
});
```

`extractGithubUrl` takes the **last** match in the output, not the first, because the agent may
well have listed existing issues on its way to creating the new one.

That reads as a guarantee that a slow success is never reported as a failure, and it was
written down as one. It is not. The configured command is `claude -p` with no
`--output-format stream-json`, and a `-p` run writes nothing until it exits — so at the kill
`stdout` is empty and there is nothing to salvage. The trap fired again a year later, at
1200s, on a run that had created its issue: `Agent timed out after 1200s without returning an
issue URL`.

The salvage is still there, because it does work for a command that streams. It is not what
protects the run.

## What actually does

The ceiling is gone. Neither agent has one by default — `EXCALIDRAW_ISSUE_AGENT_TIMEOUT` and
`EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT` (seconds) put one back for anyone who wants it, and a
board that pins one in its launcher keeps it until that file is edited.

The ceiling's other job was that a wedged agent could not hold the block in `running` forever
with no way back. That is now the reset: a running block offers **Reset — the run was lost**,
and `DELETE /api/issue-block/:id` clears the state without touching an issue the run may have
created. `docs/issue-block.md` has both halves.
