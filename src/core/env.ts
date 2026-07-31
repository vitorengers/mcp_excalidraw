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
// Since #304 there are layers rather than one file: `<state-dir>/config.json`, then `<cwd>/.env`,
// then the real environment, then an explicit flag. `core/settings.ts` is all of it, including
// why `NO_DOTENV=1` turns both file layers off.
//
// The import order below is load-bearing and is the reason this module exists twice over.
// `settings.js` first, because its body applies the layers; `logger.js` second, because its body
// reads `LOG_LEVEL` and `LOG_FILE_PATH` and would otherwise read them from an environment the
// files had not reached yet. That ordering is also why `settings.ts` cannot import the logger
// itself, and so hands what it has to say to a sink instead — deprecation of the `<cwd>/.env`
// layer, and of the old variable prefix.
import { loadSettings, onSettingNotice } from './settings.js';
import logger from '../utils/logger.js';

loadSettings();

onSettingNotice(({ level, message }) => {
  if (level === 'warn') logger.warn(message);
  else logger.info(message);
});

export {};
