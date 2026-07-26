# Trap: the agent outlives the issue it already created

A real investigation reads source, checks existing issues and drafts prose. The first genuine
run overran ten minutes — **having already created the issue**. The agent creates it and then
keeps working: tidying its notes, verifying, answering itself.

If the timeout simply killed the process and reported failure, the block would show an error for
work that fully succeeded, and the next click would open a second issue for the same
observation.

## What it does instead

On timeout, the run salvages the URL from whatever the agent printed before the kill:

```ts
const salvaged = extractIssueUrl(stdout);
resolve({
  ok: Boolean(salvaged),
  issueUrl: salvaged,
  ...
});
```

A slow success is reported as a success. Only a timeout with no URL anywhere in stdout is a
failure.

`extractIssueUrl` takes the **last** match in the output, not the first, because the agent may
well have listed existing issues on its way to creating the new one.

The ceiling is twenty minutes, overridable with `EXCALIDRAW_ISSUE_AGENT_TIMEOUT` in seconds. It
exists only so a wedged agent cannot hold the block in `running` forever with no way back.
