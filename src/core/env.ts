import dotenv from 'dotenv';

// Load environment variables once for every entry point (MCP server, CLI, canvas server).
//
// It lives in a module of its own, apart from the configuration it feeds, because the CLI entry
// point has to read the `.env` *before* it resolves which canvas URL to use and before anything
// captures one. Importing `config.js` that early would freeze `EXPRESS_SERVER_URL` a resolution
// too soon; importing this does the file and nothing else.
//
// `EXCALIDRAW_NO_DOTENV=1` turns the file off, and it exists because of what dotenv does *not*
// do: it never overwrites a variable that is already set. That sounds like the safe direction
// and is exactly backwards for anything that starts this server with a deliberately reduced
// environment. The checks spawn it with `cwd: repoRoot`, where an operator's untracked `.env`
// lives, so the only variables the file could restore were the ones a check had just removed to
// prove a route is off — and `scripts/check-workspace-settings.mjs` got a real coding agent back
// that way. Every check now goes through `scripts/lib/spawn-canvas.mjs`, which sets this.
//
// `EXCALIDRAW_ENV_FILE` names the file instead of `<cwd>/.env`, for a caller that wants a
// specific configuration rather than none.
if (process.env.EXCALIDRAW_NO_DOTENV !== '1') {
  const envFile = process.env.EXCALIDRAW_ENV_FILE;
  dotenv.config(envFile ? { path: envFile } : undefined);
}

export {};
