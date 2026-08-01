# MCP server

`src/index.ts`, spoken over stdio. This is the surface an agent gets when the project is
registered as an MCP server: 26 tools it can call directly, without knowing there is an HTTP
server behind them.

## The tools

- **Elements** — `create_element`, `update_element`, `delete_element`, `get_element`,
  `query_elements`, `batch_create_elements`, `duplicate_elements`, `clear_canvas`
- **Arrangement** — `align_elements`, `distribute_elements`, `group_elements`,
  `ungroup_elements`, `lock_elements`, `unlock_elements`
- **Scene** — `describe_scene`, `export_scene`, `import_scene`, `export_to_image`,
  `export_to_excalidraw_url`, `get_canvas_screenshot`, `set_viewport`
- **Snapshots** — `snapshot_scene`, `restore_snapshot`
- **Other** — `create_from_mermaid`, `get_resource`, `read_diagram_guide`

`describe_scene` and `get_canvas_screenshot` are the pair that makes iteration possible: the
agent draws, reads back what it drew, and corrects. Without them it is working blind.

## Configuring a client

The server speaks stdio, and the simplest configuration is `npx` — no clone, no absolute paths,
and the canvas starts itself. A bare invocation is the stdio server for a client and the board
for a person: what decides is stdin, and a client always hands it a pipe. Add `"mcp"` to the
arguments to say so outright.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/.config/Claude/` on Linux. **Cursor**
— `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`. **Antigravity** —
`~/.gemini/antigravity/mcp_config.json`. All three take the same block:

```json
{
  "mcpServers": {
    "vibemaxxing": {
      "command": "npx",
      "args": ["-y", "@vitorengers/vibemaxxing"]
    }
  }
}
```

**OpenCode** — `~/.config/opencode/opencode.json`, or a project-level `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vibemaxxing": {
      "type": "local",
      "command": ["npx", "-y", "@vitorengers/vibemaxxing"],
      "enabled": true
    }
  }
}
```

**Claude Code** and **Codex CLI** configure it from the command line, and list and remove it the
same way:

```bash
claude mcp add vibemaxxing --scope user -- npx -y @vitorengers/vibemaxxing
codex mcp add vibemaxxing -- npx -y @vitorengers/vibemaxxing
```

The key is what a client turns into tool ids. Renaming it from `excalidraw` to `vibemaxxing`
turns `mcp__excalidraw__*` into `mcp__vibemaxxing__*`, so any allowed-tools pattern has to be
updated with it — [trap-allowed-tools.md](trap-allowed-tools.md) is what happens when it is not.
Keep the old key if you also have the upstream package configured: two servers cannot share one.

For a coding agent, the skill and the CLI usually beat an MCP configuration entirely — see
[cli.md](cli.md).

## How it reaches the canvas

Through `src/core/canvas-client.ts`, which calls the same REST API the browser uses, at
`EXPRESS_SERVER_URL`. The MCP server is a client of the canvas server, not a second copy of it —
which is why an element created over MCP shows up in an open browser tab immediately.

If nothing is listening, the client starts the canvas itself. It also refuses to talk to
something that answers on that port but does not identify as this canvas server, rather than
writing elements into a stranger.

## Limitation

The MCP tools never send `?workspace=`, so every one of them operates on the `default` store.
An agent driving the canvas over MCP cannot target a registered project board — only the REST
API can. The same is true of the CLI.
