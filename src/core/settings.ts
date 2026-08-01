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
 * So there are four sources now, layered explicitly, lowest first:
 *
 *   1. `<state-dir>/config.json` — a flat JSON object of the same variable names, in a
 *      directory chosen from the platform rather than from the caller. `config.example.json`
 *      at the root of this repository is the tracked copy of what it can hold.
 *   2. `<cwd>/.env` — **deprecated**, and kept for every caller that already had one. A
 *      *launched* board's working directory is the state directory (`core/spawn.ts` passes it
 *      explicitly), so for a board this is the `.env` beside `config.json`; for a CLI or MCP
 *      process it is still the one beside the shell. A process that loads one says so, once,
 *      naming the file — so an existing installation migrates by being told rather than by
 *      breaking.
 *   3. **the real environment** — what the process was actually started with. An operator who
 *      exports `EXCALIDRAW_TERMINAL=1` for one run gets it for that run, and it is what keeps
 *      the ~130 checks in `scripts/` working: every one of them configures a throwaway server
 *      by setting variables in the spawn environment.
 *   4. **an explicit override** — what a command-line flag supplies, and it wins. No flag maps
 *      to a setting today (`--url` overrides the canvas URL, which is not one of these), so
 *      `overrideSetting` is the layer's whole surface; it is here because the order has to be
 *      stated in one place before there is a second caller to get it wrong.
 *
 * `resolveSetting` is that order as a pure function, and `env(name)` is the accessor every read
 * site uses. Layers 1 and 2 reach it by being folded into `process.env` at import; layers 3 and
 * 4 are read at the call.
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
 * What a setting is called, and what it used to be called.
 *
 * `EXCALIDRAW_*` is the whole of the user's configuration and the product is VibeMaxxing now,
 * so the prefix has to move — and it cannot move in one commit. An operator whose `config.json`,
 * `.env` or shell profile names the old spelling would otherwise come up with no registry, no
 * terminal and no agents, on a board that answers `status: healthy` and looks fine. So both are
 * read, the new one first, and the old one says so once in the log file.
 *
 * Two names that match this prefix are deliberately *not* settings and are not read through
 * here: `window.EXCALIDRAW_ASSET_PATH` in `frontend/index.html`, which is Excalidraw's own, and
 * the `EXCALIDRAW_ELEMENT_TYPES` constant in `src/index.ts`.
 */
export const SETTING_PREFIX = 'VIBEMAXXING_';
export const LEGACY_SETTING_PREFIX = 'EXCALIDRAW_';

export interface SettingDeclaration {
  /** The bare name, without a prefix. `WORKSPACES` is `VIBEMAXXING_WORKSPACES`. */
  name: string;
  /** What the tool does when it is unset, as the **Default** column of the table says it. */
  fallback: string;
  /** The **What it does** cell, verbatim — Markdown, including any link to another document. */
  description: string;
}

/**
 * Every prefixed variable this tool reads at runtime, declared once.
 *
 * The list is here rather than derived by grepping because it is what `docs/running.md` is
 * *generated from*: `node scripts/generate-settings-docs.mjs` writes the tables in that document
 * out of these three fields, and `check-settings-documented.mjs` fails when what is tracked
 * there is not byte-identical to what this produces. Which is why `description` is the whole
 * table cell and not a summary of one — a second, longer description kept beside the table was
 * the duplication that let a count in prose say "fifteen" for ten variables' worth of merges.
 *
 * A name ending in `_WSL` is Windows-only and is written into the second table, under the
 * section about projects inside a distro. Nothing else keys on the suffix.
 *
 * `PORT` and `HOST` are not here on purpose — they are per-invocation, and `PORT` is a pin the
 * launch path never scans past. Nor are `EXPRESS_SERVER_URL` and `ENABLE_CANVAS_SYNC`, which
 * carry no prefix, are per-invocation in the same way, and are documented in the README beside
 * the MCP client configuration they belong to. The three unprefixed variables that *are* the
 * tool's own are `PLAIN_SETTINGS` below.
 */
export const SETTINGS = [
  {
    name: 'CANVAS_PORT',
    fallback: '`3737`',
    description: 'The port the launch path tries first. A preference, not a pin: with `PORT` unset the search walks past it to the next free port'
  },
  {
    name: 'STATE_HOME',
    fallback: 'per-OS state directory',
    description: 'The parent of the directory holding `config.json`, the pidfile, the restart log and the running board\'s state file. For a check that needs a throwaway one'
  },
  {
    name: 'WORKSPACES',
    fallback: '`workspaces.json` in the state directory',
    description: 'Path to the registry JSON. Unset resolves the per-user default, which is created when the first project is added — see [workspaces.md](workspaces.md)'
  },
  {
    name: 'BOARD_STATE',
    fallback: 'beside the registry',
    description: 'Where each registered board is saved between processes. Unset puts them in a directory named after the registry file, default registry included — [element-store.md](element-store.md)'
  },
  {
    name: 'DOCS_DIR',
    fallback: 'the shipped `docs/`',
    description: 'Where `GET /api/docs/:key` reads from for a board with no `docsDir` of its own. Set it **empty** for a setup that wants per-project documents and no fallback — [docs-block.md](docs-block.md)'
  },
  {
    name: 'LIBRARY',
    fallback: 'the shipped `docs/blocks.excalidrawlib`',
    description: 'An `.excalidrawlib` served to every board, alongside each project\'s own. Set it **empty** for a board that wants no shared shapes at all — [shared-library.md](shared-library.md)'
  },
  {
    name: 'ISSUE_AGENT',
    fallback: 'unset',
    description: 'The command line that researches an observation and opens the issue. Unset means issue blocks do nothing'
  },
  {
    name: 'IMPLEMENT_AGENT',
    fallback: 'unset',
    description: 'The command line that implements one. Unset means the button is not offered'
  },
  {
    name: 'ISSUE_AGENT_TIMEOUT',
    fallback: 'none',
    description: 'Seconds. Unset means no ceiling; a wedged run is handled by the block\'s reset instead'
  },
  {
    name: 'IMPLEMENT_AGENT_TIMEOUT',
    fallback: 'none',
    description: 'The same, for implementing'
  },
  {
    name: 'IMPLEMENT_CONCURRENCY',
    fallback: '`4`',
    description: 'Runs at once. `0` is no cap, `1` serialises. Each one is a whole coding agent building on this machine'
  },
  {
    name: 'IMPLEMENT_QUEUE_MS',
    fallback: '`30000`',
    description: 'How often a workspace with its queue on looks for a free slot. The timer does not exist until a queue is turned on'
  },
  {
    name: 'ISSUE_MEMO_MS',
    fallback: '`30000`',
    description: 'How long one `gh` read of an issue is reused. `0` turns the memo off'
  },
  {
    name: 'GH_STATUS_MEMO_MS',
    fallback: '`30000`',
    description: 'How long one answer about `gh` *itself* — installed, logged in, which scopes — is reused before `GET /api/github-status` asks again. `0` turns the memo off. The canvas asks on a failing poll, so without it a board whose `gh` is broken would spawn two processes every twenty seconds to be told the same thing'
  },
  {
    name: 'GH_COMMAND',
    fallback: '`gh`',
    description: 'The GitHub CLI on **this machine**, when it is not on `PATH` — [trap-gh-path.md](trap-gh-path.md)'
  },
  {
    name: 'CLAUDE_STATUS',
    fallback: 'unset',
    description: 'The directory your Claude Code status line command writes its usage files into. Unset means `GET /api/claude-status` answers 404 and the header shows nothing — [claude-status.md](claude-status.md)'
  },
  {
    name: 'TERMINAL',
    fallback: 'unset',
    description: '`1` for the default shell, or a command line of your own. Unset means the terminal routes answer 404 — [terminal.md](terminal.md)'
  },
  {
    name: 'TERMINAL_PTY',
    fallback: 'unset',
    description: '`0` forces the pipe instead of a real pty, for a machine with no prebuilt binary'
  },
  {
    name: 'EXPORT_DIR',
    fallback: 'working dir',
    description: 'The base directory MCP file exports may write to'
  },
  {
    name: 'ALLOWED_HOSTS',
    fallback: 'loopback names only',
    description: 'Extra `Host` authorities the origin gate accepts, comma-separated, for a real alias or a proxy in front of the board. The refusal names the authority it expected, so a lockout says what to put here'
  },
  {
    name: 'NO_AUTOSTART',
    fallback: 'unset',
    description: '`1` stops the CLI and the MCP server auto-spawning a canvas'
  },
  {
    name: 'NO_DOTENV',
    fallback: 'unset',
    description: '`1` stops both configuration files being read — `<cwd>/.env` and `<state-dir>/config.json` alike — leaving only the real environment. The checks set it, because a file layer only ever fills in variables that are *unset*, which is exactly the set a check deleted on purpose — [trap-check-environment.md](trap-check-environment.md)'
  },
  {
    name: 'ENV_FILE',
    fallback: '`<cwd>/.env`',
    description: 'Read this file instead. Ignored when `EXCALIDRAW_NO_DOTENV=1`, and it does not move `config.json`'
  },
  {
    name: 'ISSUE_AGENT_WSL',
    fallback: 'unset',
    description: 'The issue command, spelled as a **WSL-backed** project\'s distro spells it. Unset falls back to `EXCALIDRAW_ISSUE_AGENT`, which only resolves inside a distro if it was written without an absolute path'
  },
  {
    name: 'IMPLEMENT_AGENT_WSL',
    fallback: 'unset',
    description: 'The same, for implementing. A pair rather than one variable for the reason `EXCALIDRAW_ISSUE_AGENT` and `EXCALIDRAW_IMPLEMENT_AGENT` are a pair: granting a distro research must not thereby grant it repository writes'
  },
  {
    name: 'GH_COMMAND_WSL',
    fallback: '`gh`',
    description: 'The GitHub CLI inside a **WSL-backed** project\'s distro. Unlike the agents\' `_WSL` pair this does **not** fall back to the host value: a host path is exactly what cannot run there'
  }
] as const satisfies readonly SettingDeclaration[];

/**
 * The variables this tool reads that carry no prefix and never did.
 *
 * They are declared here for one reason: until #312 no table anywhere named them, and
 * `LOG_FILE_PATH` is the one a person needs most. The console transport is warn-and-above
 * (`utils/logger.ts`), so every `logger.info` in the server — the deprecation notices this file
 * emits included — goes to the log file and nowhere else, and a reader with no way to find that
 * file concludes the server said nothing.
 *
 * They are *not* in `SETTINGS` and are not reachable through `env()`: `utils/logger.ts` reads
 * them in its own module body, before any layer has been applied, and it must — a logger that
 * imported this module could not be imported *by* it, and `core/env.ts` exists to order the two.
 * So a `config.json` cannot supply them, which is exactly what the generated row says.
 */
export const PLAIN_SETTINGS = [
  {
    name: 'LOG_LEVEL',
    fallback: '`info`',
    description: 'The lowest level written to the log file — `error`, `warn`, `info`, `debug`. The console transport is fixed at warn-and-above whatever this says, so `info` here is how a server\'s own account of a start is read back. `debug` adds the per-sync lines, which is a megabyte a minute on a board somebody is drawing on'
  },
  {
    name: 'LOG_FILE_PATH',
    fallback: 'a per-OS log file',
    description: 'Where that file is — `vibemaxxing status` prints the resolved answer as `logFile`. Unset it is `%LOCALAPPDATA%\\VibeMaxxing-MCP\\vibemaxxing.log` on Windows, `~/Library/Logs/vibemaxxing-mcp.log` on macOS and `$XDG_STATE_HOME/vibemaxxing-mcp/vibemaxxing.log` elsewhere. It rotates at 1 MB across five files, so the whole history is at most 5 MB. Set and unwritable is a refusal to start; unset and unwritable falls back to the temp directory'
  },
  {
    name: 'DEBUG',
    fallback: 'unset',
    description: '`true` writes one line saying debug mode is on. Nothing else reads it — `LOG_LEVEL=debug` is what turns the detail on'
  }
] as const satisfies readonly SettingDeclaration[];

/** What a caller may ask `env()` for. A free string would make a typo resolve to `undefined`. */
export type SettingName = (typeof SETTINGS)[number]['name'];

/** A declaration together with the name a person actually types into a shell or a file. */
export interface DocumentedSetting extends SettingDeclaration {
  /** The full variable name, prefix and all. */
  variable: string;
  /** Windows-only, because it is about a project inside a WSL distro. */
  windowsOnly: boolean;
  /** Whether the prefix applies at all — a `false` here is one of `PLAIN_SETTINGS`. */
  prefixed: boolean;
}

/**
 * Every variable the documentation has to describe, in the order the tables carry them.
 *
 * The legacy prefix, deliberately: it is still what every board on this machine is spelled with
 * and what `config.example.json` ships, and `docs/running.md` says in one sentence above the
 * table that each name can be written `VIBEMAXXING_*` instead. Twenty-odd rows repeating that is
 * twenty-odd places to correct on the day the old prefix is dropped.
 */
export function documentedSettings(): DocumentedSetting[] {
  return [
    ...SETTINGS.map((setting) => ({
      ...setting,
      variable: `${LEGACY_SETTING_PREFIX}${setting.name}`,
      windowsOnly: setting.name.endsWith('_WSL'),
      prefixed: true
    })),
    ...PLAIN_SETTINGS.map((setting) => ({
      ...setting,
      variable: setting.name,
      windowsOnly: false,
      prefixed: false
    }))
  ];
}

/**
 * How to spell a setting to somebody who has to go and set it.
 *
 * Every refusal that says "set X to enable this" builds its X here rather than writing it out.
 * Hand-spelled, they are a second list of variable names — one that no compiler and no check
 * reads, and that therefore goes stale exactly when it matters most, which is during a rename.
 * The new prefix, because that is what a message should be teaching; the old one keeps working
 * and is not something to send anybody towards.
 */
export function settingName(name: SettingName): string {
  return `${SETTING_PREFIX}${name}`;
}

/**
 * What this module has to say that only a logger can say properly.
 *
 * A sink rather than an import, because this module must not reach the logger: `utils/logger.ts`
 * reads `LOG_LEVEL` and `LOG_FILE_PATH` in its own body, so importing it here would evaluate it
 * before the layers below have been applied and pin the log level to the un-layered environment.
 * `core/env.ts` imports this module first and the logger second, and registers the sink — which
 * is exactly the ordering that makes the layers real. Anything said before then is held.
 */
export interface SettingNotice {
  level: 'warn' | 'info';
  message: string;
}

const heldNotices: SettingNotice[] = [];
let noticeSink: ((notice: SettingNotice) => void) | null = null;

export function onSettingNotice(write: (notice: SettingNotice) => void): void {
  noticeSink = write;
  for (const held of heldNotices.splice(0)) write(held);
}

function notice(level: SettingNotice['level'], message: string): void {
  if (noticeSink) noticeSink({ level, message });
  else heldNotices.push({ level, message });
}

const announcedLegacy = new Set<string>();

/**
 * Say that a name is the old spelling — once for that name, however often it is read.
 *
 * `EXCALIDRAW_WORKSPACES` alone is read from a dozen places in `server.ts`, and a line per read
 * is a line nobody finishes. `info` rather than `warn` for the same reason: the console
 * transport is warn and above, and today every board on this machine is legacy-spelled, so a
 * warning per variable would be a paragraph of stderr on every start. The `.env` notice below
 * *is* a warning, because there is exactly one of it.
 */
function noteLegacyName(name: string): void {
  if (announcedLegacy.has(name)) return;
  announcedLegacy.add(name);
  notice('info', `${LEGACY_SETTING_PREFIX}${name} is deprecated; rename it to `
    + `${SETTING_PREFIX}${name}. Both spellings are read for now.`);
}

/** The layers a setting can come from, lowest first. `undefined` is "this layer is not there". */
export interface SettingLayers {
  /** `<state-dir>/config.json`. */
  file?: SettingsMap | undefined;
  /** `<cwd>/.env`, deprecated. */
  envFile?: SettingsMap | undefined;
  /** What the process was started with. */
  environment?: NodeJS.ProcessEnv | undefined;
  /** What an explicit command-line flag said. */
  flag?: SettingsMap | undefined;
}

/**
 * One layer's answer for `name`, new spelling first.
 *
 * `undefined` and the empty string are different answers and both are kept: an *explicitly
 * empty* `LIBRARY` is how a board says it wants no shared shapes at all, so a check for
 * truthiness here would turn that into the default library.
 */
function fromLayer(
  layer: SettingsMap | NodeJS.ProcessEnv | undefined,
  name: string
): { value: string; legacy: boolean } | null {
  if (!layer) return null;
  const next = layer[`${SETTING_PREFIX}${name}`];
  if (next !== undefined) return { value: next, legacy: false };
  const legacy = layer[`${LEGACY_SETTING_PREFIX}${name}`];
  if (legacy !== undefined) return { value: legacy, legacy: true };
  return null;
}

/**
 * The precedence, stated once: flag beats environment beats `.env` beats `config.json`.
 *
 * Pure and exported so that the order can be asserted as four maps and an expected answer
 * rather than by starting four servers — which is worth having, but is not what
 * `check-settings-precedence.mjs` mostly does: the failure this guards against is a *read site*
 * resolving to the wrong layer at runtime while compiling perfectly, and only a real server can
 * be wrong about that.
 */
export function resolveSetting(name: string, layers: SettingLayers): string | undefined {
  return resolveSettingSource(name, layers)?.value;
}

function resolveSettingSource(
  name: string,
  layers: SettingLayers
): { value: string; legacy: boolean } | null {
  return fromLayer(layers.flag, name)
    ?? fromLayer(layers.environment, name)
    ?? fromLayer(layers.envFile, name)
    ?? fromLayer(layers.file, name)
    ?? null;
}

const overrides: SettingsMap = {};

/**
 * The flag layer: what an explicit command-line argument says a setting is.
 *
 * Nothing calls it yet — no flag maps to one of these, and inventing one would be a feature
 * rather than an ordering. It is the seam a flag attaches to, and the reason the resolver above
 * has four arguments instead of three.
 */
export function overrideSetting(name: SettingName, value: string): void {
  overrides[`${SETTING_PREFIX}${name}`] = value;
}

/**
 * **The** accessor. Every `EXCALIDRAW_*` read in `src/` is a call to this.
 *
 * Reading `process.env` directly was never wrong on its own; what it cost was that twenty-odd
 * variables had no list, two prefixes could not be read at once, and each site decided for
 * itself whether an empty string meant "off" or "unset". The two file layers are already in
 * `process.env` by the time this runs — `loadSettings()` folds them in at import, under
 * whatever the process was started with — so what is left to resolve here is the flag layer and
 * the two spellings.
 */
export function env(name: SettingName): string | undefined {
  const found = resolveSettingSource(name, { flag: overrides, environment: process.env });
  if (!found) return undefined;
  if (found.legacy) noteLegacyName(name);
  return found.value;
}

/**
 * The directory the platform keeps per-user state in — the *parent*, not the application's own
 * folder inside it.
 *
 * The `STATE_HOME` setting overrides it, and exists so a check can give a run a throwaway state
 * directory of its own. Without it there is no way to exercise the pidfile and the state files
 * except against the real one, which on this machine holds the board the maintainer is looking
 * at. Read from the environment only, never from `config.json`: the file would be naming the
 * directory it is in.
 */
function stateHome(): string {
  const override = env('STATE_HOME');
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

/** The `.env` layer: the `ENV_FILE` setting, or the file beside this process's working directory. */
export function envFilePath(): string {
  const named = env('ENV_FILE');
  return named && named.trim() ? named : path.join(process.cwd(), '.env');
}

/**
 * The deprecated layer, and it says so — once, naming the file it read.
 *
 * A `.env` is gitignored, has no tracked example, and sits wherever the caller's shell happened
 * to be; `config.json` in the state directory is where these values belong now. Warning rather
 * than dropping the layer is the whole point: an installation that has one migrates by being
 * told, not by coming up empty on a board that still answers `status: healthy`. Silence when
 * there is no file, and silence when there is one with nothing in it — a notice about a file
 * that changed nothing is a notice that trains people to skip the next one.
 */
function readEnvFile(): SettingsMap {
  const file = envFilePath();
  let values: SettingsMap;
  try {
    // `dotenv.parse` rather than `dotenv.config`, which writes straight into `process.env` and
    // would put the file above the real environment for anything it happened to reach first.
    // Same parser, and here the layering is decided in one place instead.
    values = dotenv.parse(fs.readFileSync(file));
  } catch {
    return {};
  }
  if (Object.keys(values).length > 0) {
    notice('warn', `Loaded configuration from ${file}. A .env in the working directory is `
      + `deprecated: move these values into ${settingsFilePath()}, which is found whatever `
      + 'directory the tool is started from.');
  }
  return values;
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

  if (env('NO_DOTENV') === '1') return;

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
