#!/usr/bin/env node

// Single bin entry for every package bin (vibemaxxing, mcp-excalidraw-server and
// excalidraw-canvas):
//
//   no arguments  -> MCP stdio server (backward compatible with MCP clients)
//   <subcommand>  -> CLI
//
// IMPORTANT: never statically import ./index.js or ./server.js here.
// index.js evaluates the whole MCP module graph, and server.js used to start
// the Express canvas server on import — the CLI must only ever reach the
// canvas by spawning dist/server.js as a child process (see core/spawn.ts).

// Disable colors to prevent ANSI color codes from breaking JSON parsing
process.env.NODE_DISABLE_COLORS = '1';
process.env.NO_COLOR = '1';

const argv = process.argv.slice(2);

// Global --url flag: must land in the environment before any core module
// (which reads EXPRESS_SERVER_URL at import time) is loaded.
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  if (token === '--url' && argv[i + 1]) {
    process.env.EXPRESS_SERVER_URL = argv[i + 1];
    argv.splice(i, 2);
    break;
  }
  if (token.startsWith('--url=')) {
    process.env.EXPRESS_SERVER_URL = token.slice('--url='.length);
    argv.splice(i, 1);
    break;
  }
}

// Where the canvas is, decided here and nowhere else.
//
// Every module downstream reads one captured `EXPRESS_SERVER_URL`, so this is the only point at
// which a port can still be chosen — before `core/config.js` is loaded by anything. The `.env`
// goes first, because a URL configured there is an explicit answer and must not be scanned past.
if (!process.env.EXPRESS_SERVER_URL) {
  await import('./core/env.js');
  const { resolveCanvasUrl } = await import('./core/port.js');
  const resolved = await resolveCanvasUrl();
  if (resolved) process.env.EXPRESS_SERVER_URL = resolved;
}

if (argv.length === 0) {
  // MCP mode: stdout belongs to the JSON-RPC transport from here on
  const { runServer } = await import('./index.js');
  await runServer();
} else {
  const { runCli } = await import('./cli/run.js');
  await runCli(argv);
}

export {};
