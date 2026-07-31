/**
 * Which of the two things a bare, argument-less invocation meant.
 *
 * One file is installed under several names and is also the MCP server, so the name it was
 * invoked under has to decide — and `process.argv[1]` is the only place that name can be read.
 */
export type EntryMode = 'launch' | 'mcp';

/** Extensions a shim wears on Windows, plus the entry point's own. */
const SHIM_EXTENSION = /\.(cmd|bat|ps1|exe|js|mjs|cjs)$/i;

/**
 * The bare command name behind a path: no directory, no shim extension, lower case.
 *
 * Both separators, rather than `path.basename` — which only ever knows the one the host uses, so
 * a Windows path handed to a POSIX process comes back whole. Nothing in production sends a path
 * across platforms, but `scripts/check-launch-command.mjs` asserts the Windows shapes wherever it
 * runs, and a function that answers differently on Linux is one whose Windows behaviour is only
 * ever checked on Windows. The cost is a POSIX file name with a literal backslash in it, which is
 * not a command anybody installs.
 *
 * Lower case because Windows is case-insensitive about command names and PowerShell will complete
 * one in any case at all, so a name that differs only in case is the same command.
 */
export function invokedName(argv1: string | undefined): string {
  const raw = String(argv1 ?? '').replace(/[\\/]+$/, '');
  if (!raw) return '';
  const leaf = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  return leaf.replace(SHIM_EXTENSION, '').toLowerCase();
}

export interface EntryModeInput {
  /** `process.argv[1]` — the path the operating system was given, before any symlink is resolved. */
  argv1: string | undefined;
  /** Where the entry point really lives, so its own name can be recognised. */
  entryFile: string;
  /** The command names package.json installs. */
  launchNames: readonly string[];
  /** Whether stdin is a terminal. */
  stdinIsTty: boolean;
}

/**
 * What zero arguments mean.
 *
 * **Two conditions, and both have to hold for a launch: the name has to be one this package
 * installs, and there has to be a person on the other end of stdin.**
 *
 * The name alone is not enough, and that is the whole of the care in this function. Every MCP
 * client configuration this project documents is `npx -y @vitorengers/vibemaxxing` with no
 * arguments — npx resolves that to a symlink named after the command, so `argv[1]` carries the
 * product's own name in exactly the case where a launch would be wrong. Branching on the name by
 * itself would hand every Claude Desktop, Cursor, Codex and OpenCode user a process that prints
 * one line and exits where a JSON-RPC server used to be. So stdin decides: the transport's own
 * channel is always a pipe from a client and always a terminal for a person. Stdin rather than
 * stdout, because stdout is what a person redirects — `vibemaxxing > log.txt` is still somebody
 * typing, and it is only the browser that stays shut for it (core/open-browser.ts).
 *
 * The name is what can still take the launch away, and there are two shapes it arrives in:
 *
 *  - **a POSIX symlink**, which is how npm installs a bin: `argv[1]` is the symlink's own path,
 *    so the name survives.
 *  - **the entry file itself**, which is `node dist/bin.js` and *also every Windows shim*.
 *    `cmd-shim` writes `"%_prog%" "%dp0%\..\<pkg>\dist\bin.js" %*`, so the name is gone before
 *    Node starts and no care with basenames gets it back. That shape is treated as ours, because
 *    on Windows it is the only shape an installed command ever has.
 *
 * Anything else is the stdio server whatever is on stdin — including the two commands upstream's
 * package installs, which this one dropped at the rename and which an already-published client
 * configuration may still name. Deriving that from "not one of ours" rather than from a list is
 * deliberate: nothing here has to be told a name in order to keep working.
 *
 * A script that wants the board without a terminal says `launch`, and one that wants the
 * transport without arguing about any of this says `mcp`.
 */
export function entryMode({ argv1, entryFile, launchNames, stdinIsTty }: EntryModeInput): EntryMode {
  const name = invokedName(argv1);
  if (!name) return 'mcp';
  const ours = launchNames.some(candidate => candidate.toLowerCase() === name)
    || name === invokedName(entryFile);
  return ours && stdinIsTty ? 'launch' : 'mcp';
}
