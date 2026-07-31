import { spawn } from 'child_process';
import logger from '../utils/logger.js';
import { tokenizeCommand } from './issue-agent.js';

/**
 * Handing a URL to whatever the machine has registered for it.
 *
 * Nothing in this tree opened a browser before: the board came up and the user was told, in
 * prose on stderr, to go and open it. That is one step too many for the first command somebody
 * types, and it is the step where a new user decides the tool does not work.
 *
 * **Every failure here degrades to the printed URL.** The opener is a platform command that may
 * not exist — `xdg-open` is absent on minimal Linux images and inside WSL without `wslu` — and a
 * launch that failed because the browser could not be started would be a worse outcome than the
 * one it replaced. So the spawn is detached, its output is discarded, and its errors are logged
 * and swallowed. The URL is on stdout either way.
 */

export interface Opener {
  command: string;
  args: string[];
}

/**
 * The command this platform opens a URL with, or the one the operator named instead.
 *
 * `VIBEMAXXING_OPEN_COMMAND` is a whole command line, tokenized the way an agent command is, with
 * the URL appended as its last argument. It exists for the machine whose platform opener is
 * missing — `wslview`, or a browser named outright — and it is the seam
 * `scripts/check-launch-command.mjs` uses to watch this happen without a browser.
 *
 * **The empty string in the Windows form is not a typo.** `start` reads its first quoted argument
 * as the title of the window it is opening, so `cmd /c start "http://…"` opens a console window
 * titled with the URL and no browser at all. The empty title is what makes the URL be the URL.
 */
export function openerFor(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Opener {
  const override = env.VIBEMAXXING_OPEN_COMMAND?.trim();
  if (override) {
    const [command, ...args] = tokenizeCommand(override);
    if (command) return { command, args: [...args, url] };
  }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Why the browser must be left alone, or null when it may be opened.
 *
 * Two suppressions, and both are about who is on the other end. An agent, a CI job or a script
 * reading the URL out of stdout has no display to open anything on, and a browser window arriving
 * in the middle of an automated run is a surprise nobody asked for; `--no-open` (which sets the
 * variable, so there is one code path) is the same statement made explicitly.
 *
 * `VIBEMAXXING_NO_OPEN=0` reads as "not suppressed", so a variable can be turned off in a shell
 * that already exports it without having to be unset.
 */
export function openSuppression(env: NodeJS.ProcessEnv, stdoutIsTty: boolean): string | null {
  const flag = env.VIBEMAXXING_NO_OPEN?.trim();
  if (flag && flag !== '0' && flag.toLowerCase() !== 'false') return 'VIBEMAXXING_NO_OPEN is set';
  if (!stdoutIsTty) return 'stdout is not a terminal';
  return null;
}

/**
 * Open `url` in the machine's browser, unless something says not to.
 *
 * Returns whether an attempt was made, which is all a caller can honestly know: the opener is
 * detached and its own success is not reported back to anybody.
 */
export function openBrowser(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTty: boolean = Boolean(process.stdout.isTTY)
): boolean {
  const suppressed = openSuppression(env, stdoutIsTty);
  if (suppressed) {
    logger.info(`Not opening a browser at ${url}: ${suppressed}`);
    return false;
  }

  const { command, args } = openerFor(url, process.platform, env);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // ENOENT for a platform opener that is not installed arrives here rather than as a throw,
    // and an unhandled 'error' event would take the launch down with it.
    child.once('error', error => {
      logger.warn(`Could not open a browser at ${url}: ${(error as Error).message}`);
    });
    child.unref();
    return true;
  } catch (error) {
    logger.warn(`Could not open a browser at ${url}: ${(error as Error).message}`);
    return false;
  }
}
