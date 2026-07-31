import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import dotenv from 'dotenv';

/**
 * Where this tool's configuration comes from, and in what order.
 *
 * Until #304 the only answer was `<cwd>/.env`, and `.env` is gitignored, has no tracked example,
 * and lives wherever the caller's shell happened to be. A double-clicked launcher has an
 * unpredictable working directory — `C:\Windows\System32` from a shortcut, `/` from a `.desktop`
 * entry, the home directory from Finder — so it can never find one, and the board comes up with
 * no workspaces, no terminal and no agents while answering `status: healthy` on the port the
 * real board was meant to hold.
 *
 * So there are three sources now, layered explicitly, lowest first:
 *
 *   1. `<state-dir>/config.json` — a flat JSON object of the same variable names, in a
 *      directory chosen from the platform rather than from the caller. `config.example.json`
 *      at the root of this repository is the tracked copy of what it can hold.
 *   2. `<cwd>/.env` — unchanged, for every caller that already had one. A *launched* board's
 *      working directory is the state directory (`core/spawn.ts` passes it explicitly), so for
 *      a board this is the `.env` beside `config.json`; for a CLI or MCP process it is still
 *      the one beside the shell.
 *   3. **the real environment** — what the process was actually started with, and it wins.
 *      An operator who exports `EXCALIDRAW_TERMINAL=1` for one run gets it for that run.
 *
 * Loading is idempotent and happens on import, so no entry point can read `process.env` before
 * the layers are applied: the hazard with `dotenv.config()` called in a module *body* is that
 * every import of that module's own graph has already run. `core/env.ts` is the side-effect
 * module the entry points import for exactly that reason, and it is this.
 *
 * `EXCALIDRAW_NO_DOTENV=1` turns both file layers off — the `.env` and the state file alike.
 * It is what every check sets (`scripts/lib/spawn-canvas.mjs`), and it exists because of what
 * layering under the environment means in reverse: the only values a file can supply are
 * exactly the ones a caller deliberately removed. `check-workspace-settings.mjs` builds a
 * server with no implement agent to prove `/api/implement` answers 404, and on a machine with
 * an `.env` it got the operator's real coding agent back and started one.
 *
 * The state-directory functions live here rather than in `core/pidfile.ts`, which chose them
 * before #304, because `config.json` is in that directory too and because this module must not
 * import the logger: the logger reads `LOG_LEVEL` and `LOG_FILE_PATH` in its own body, and it
 * cannot be evaluated before the layers are applied. `pidfile.ts` re-exports them, so every
 * caller that had them from there still does.
 */

/** Values a `config.json` may hold, once flattened to the strings an environment holds. */
export type SettingsMap = Record<string, string>;

/**
 * The directory the platform keeps per-user state in — the *parent*, not the application's own
 * folder inside it.
 *
 * `EXCALIDRAW_STATE_HOME` overrides it, and exists so a check can give a run a throwaway state
 * directory of its own. Without it there is no way to exercise the pidfile and the state files
 * except against the real one, which on this machine holds the board the maintainer is looking
 * at. Read from the environment only, never from `config.json`: the file would be naming the
 * directory it is in.
 */
function stateHome(): string {
  const override = process.env.EXCALIDRAW_STATE_HOME;
  if (override) return override;
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  }
  return process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
}

/** Read per call rather than captured: a check may be simulating another platform. */
function leaf(name: 'next' | 'legacy'): string {
  if (process.platform === 'win32') {
    return name === 'next' ? 'VibeMaxxing-Canvas' : 'Excalidraw-Canvas';
  }
  return name === 'next' ? 'vibemaxxing-canvas' : 'excalidraw-canvas';
}

/**
 * Where runtime artifacts are written today. Still the legacy directory, deliberately, for the
 * reason `core/identity.ts` gives: a directory rename orphans the pidfile, and `stop` then
 * cannot find the server it started while the port stays held.
 */
export function stateDir(): string {
  return path.join(stateHome(), leaf('legacy'));
}

/**
 * Where a reader looks, new directory first. The rename flips what `stateDir()` returns; this
 * list is what makes that flip survivable, so it ships one release ahead of it.
 */
export function stateDirCandidates(): string[] {
  return [path.join(stateHome(), leaf('next')), stateDir()];
}

/** The state directory, made if it is not there yet. */
export function ensureStateDir(): string {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function settingsFilePath(): string {
  return path.join(stateDir(), 'config.json');
}

/** Every place a `config.json` could be, in the order a reader should try them. */
export function settingsFilePaths(): string[] {
  return stateDirCandidates().map(dir => path.join(dir, 'config.json'));
}

/**
 * Read one `config.json` into the flat string map an environment is.
 *
 * Every key is read — there is no allowlist here, deliberately. Which of the `EXCALIDRAW_*`
 * survive into a near-zero-config release is a separate question, and a list kept here would
 * answer it by accident, silently dropping whatever it had not been told about.
 *
 * A missing file is the ordinary case and says nothing. A malformed one says so on stderr and
 * is then ignored: refusing to start because a configuration file has a stray comma would make
 * the launch path *more* fragile than the `.env` it replaces, not less.
 */
export function readSettingsFile(file: string = settingsFilePath()): SettingsMap {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`Ignoring ${file}: it is not valid JSON (${(error as Error).message}).\n`);
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(`Ignoring ${file}: it must be a JSON object of "NAME": "value" pairs.\n`);
    return {};
  }

  const values: SettingsMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      process.stderr.write(`Ignoring "${key}" in ${file}: only strings, numbers and booleans.\n`);
      continue;
    }
    values[key] = String(value);
  }
  return values;
}

/** The first `config.json` that is there, across both state-directory spellings. */
function readSettingsFiles(): SettingsMap {
  for (const file of settingsFilePaths()) {
    if (fs.existsSync(file)) return readSettingsFile(file);
  }
  return {};
}

/** The `.env` layer: `EXCALIDRAW_ENV_FILE`, or the file beside this process's working directory. */
export function envFilePath(): string {
  const named = process.env.EXCALIDRAW_ENV_FILE;
  return named && named.trim() ? named : path.join(process.cwd(), '.env');
}

function readEnvFile(): SettingsMap {
  try {
    // `dotenv.parse` rather than `dotenv.config`, which writes straight into `process.env` and
    // would put the file above the real environment for anything it happened to reach first.
    // Same parser, and here the layering is decided in one place instead.
    return dotenv.parse(fs.readFileSync(envFilePath()));
  } catch {
    return {};
  }
}

/**
 * The values that should be applied on top of `environment`, given the two file layers.
 *
 * Pure, and exported, because the order is the whole feature: a check can state it as three
 * maps and an expected answer rather than by starting three servers.
 */
export function mergeSettings(
  fromFile: SettingsMap,
  fromEnvFile: SettingsMap,
  environment: NodeJS.ProcessEnv
): SettingsMap {
  const merged: SettingsMap = { ...fromFile, ...fromEnvFile };
  const applied: SettingsMap = {};
  for (const [key, value] of Object.entries(merged)) {
    if (environment[key] === undefined) applied[key] = value;
  }
  return applied;
}

let loaded = false;
let realEnv: NodeJS.ProcessEnv | null = null;

/**
 * Apply the layers to `process.env`, once.
 *
 * Runs on import (bottom of this file) so that no module body can read a variable before the
 * files have been folded in — which is also what puts the port resolution downstream of it:
 * `resolveCanvasUrl` in `core/port.ts` reads `PORT` and `EXCALIDRAW_CANVAS_PORT`, and a port
 * named in `config.json` has to be in the environment by then to count for anything.
 */
export function loadSettings(): void {
  if (loaded) return;
  loaded = true;
  realEnv = { ...process.env };

  if (process.env.EXCALIDRAW_NO_DOTENV === '1') return;

  const applied = mergeSettings(readSettingsFiles(), readEnvFile(), realEnv);
  for (const [key, value] of Object.entries(applied)) process.env[key] = value;
}

/**
 * The environment this process was *started* with, before any file layer.
 *
 * What `core/spawn.ts` hands the canvas server it launches. Passing `process.env` instead is
 * what made the launch directory decide what the board is: the CLI had already folded its own
 * `<cwd>/.env` in, so a `.env` in whatever directory somebody typed the command in arrived in
 * the board as if it had been exported. The child re-reads the files itself, from a working
 * directory the caller does not choose.
 */
export function realEnvironment(): NodeJS.ProcessEnv {
  loadSettings();
  return { ...(realEnv ?? process.env) };
}

export interface SettingsFileWrite {
  file: string;
  created: boolean;
}

/**
 * Put a `config.json` there on first launch, holding the resolved port and nothing else.
 *
 * The point is that it *exists*: a file somebody can open and add a registry to beats a
 * documented convention about a gitignored file in a directory the launcher cannot predict.
 * Nothing else is written, because everything else is a decision this has no business making
 * on the operator's behalf — `config.example.json` is where the rest is spelled out.
 *
 * The port is written as `EXCALIDRAW_CANVAS_PORT` rather than as `PORT`, which is the same
 * number with a different promise attached: #303 made `PORT` a **pin** that is never scanned
 * past, and `EXCALIDRAW_CANVAS_PORT` the port to *try first*. Writing the pin would quietly
 * convert every later launch on this machine into one that fails when something else holds
 * that port, instead of walking to the next free one.
 *
 * Never overwrites: after the first run this file is the operator's.
 */
export function ensureSettingsFile(port: number): SettingsFileWrite {
  for (const existing of settingsFilePaths()) {
    if (fs.existsSync(existing)) return { file: existing, created: false };
  }
  const file = settingsFilePath();
  ensureStateDir();
  fs.writeFileSync(file, `${JSON.stringify({ EXCALIDRAW_CANVAS_PORT: port }, null, 2)}\n`, 'utf-8');
  return { file, created: true };
}

loadSettings();
