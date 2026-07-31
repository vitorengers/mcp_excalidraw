#!/usr/bin/env node

// Single bin entry for every command this package installs (see package.json
// `bin`, and BIN_NAMES in core/version.ts):
//
//   no arguments  -> launch the board under one of this package's own command names;
//                    MCP stdio server under any other name (see core/entry-name.ts)
//   <subcommand>  -> CLI
//
// IMPORTANT: never statically import ./index.js or ./server.js here.
// index.js evaluates the whole MCP module graph, and server.js used to start
// the Express canvas server on import — the CLI must only ever reach the
// canvas by spawning dist/server.js as a child process (see core/spawn.ts).

import { fileURLToPath } from 'url';

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

// Global --no-open flag, in the environment rather than in a parsed flag for the same reason
// --url is: the bare invocation has no subcommand to hang a flag on, and `vibemaxxing --no-open`
// has to stay the argument-less launch rather than becoming an unknown command. One code path
// downstream — core/open-browser.ts reads the variable and nothing else.
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--no-open') {
    process.env.VIBEMAXXING_NO_OPEN = '1';
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

// What zero arguments mean, decided by the name the command was invoked under.
//
// Under one of this package's own commands it is the launch: bring the board up, open it, print
// one line. Under anything else — including the two names upstream's package installs, which an
// MCP client configuration written before the rename still names — it is the stdio server it has
// always been, reached exactly as it was reached before. core/entry-name.ts holds the rule, and
// the case it cannot decide from a name (every Windows shim, where npm's own shim has already
// thrown the name away) is decided by whether stdin is a terminal.
let mode = 'mcp';
if (argv.length === 0) {
  const { entryMode } = await import('./core/entry-name.js');
  const { BIN_NAMES } = await import('./core/version.js');
  mode = entryMode({
    argv1: process.argv[1],
    entryFile: fileURLToPath(import.meta.url),
    launchNames: BIN_NAMES,
    stdinIsTty: Boolean(process.stdin.isTTY)
  });
}

if (argv.length === 0 && mode === 'mcp') {
  // MCP mode: stdout belongs to the JSON-RPC transport from here on
  const { runServer } = await import('./index.js');
  await runServer();
} else {
  const { runCli } = await import('./cli/run.js');
  await runCli(argv.length === 0 ? ['launch'] : argv);
}

export {};
