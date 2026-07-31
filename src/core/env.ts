// Configuration for every entry point (MCP server, CLI, canvas server), applied here and
// nowhere else.
//
// It lives in a module of its own, apart from the configuration it feeds, because the CLI entry
// point has to read the files *before* it resolves which canvas URL to use and before anything
// captures one. Importing `config.js` that early would freeze `EXPRESS_SERVER_URL` a resolution
// too soon; importing this does the files and nothing else — which is also what lets a `PORT`
// or an `EXCALIDRAW_CANVAS_PORT` named in `config.json` count: it is in the environment by the
// time `core/port.ts` resolves against it.
//
// Since #304 there are three layers rather than one file: `<state-dir>/config.json`, then
// `<cwd>/.env`, then the real environment, which wins. `core/settings.ts` is all of it,
// including why `EXCALIDRAW_NO_DOTENV=1` turns both file layers off.
import { loadSettings } from './settings.js';

loadSettings();

export {};
