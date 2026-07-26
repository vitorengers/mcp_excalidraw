/**
 * Running `gh` inside a workspace.
 *
 * The GitHub CLI is this server's only client for GitHub, and that is a decision rather
 * than an omission: it is already required by the issue agent, already carries the
 * `project` scope from the user's own login, and the two traps around it — a PATH without
 * the CLI on it, and a WSL project whose paths only make sense inside the distro — are
 * already solved in `issue-agent.ts`. A second HTTP client would have to pay for both
 * again, plus a token to store.
 */
import { spawn } from 'child_process';
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
import { agentPath, buildAgentCommand } from './issue-agent.js';

/**
 * The `gh` invocation. Overridable so a check script can answer without a real GitHub
 * account behind it.
 */
export const GH_COMMAND = process.env.EXCALIDRAW_GH_COMMAND || 'gh';

/**
 * How many times to run `gh` before giving up, and how long to wait between tries.
 *
 * `gh` intermittently fails here with socket buffer exhaustion and succeeds on the next
 * attempt seconds later. Without a retry that fault reaches the canvas as a hard error,
 * which reads as a broken feature rather than as the blip it is.
 */
const ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RunGhOptions {
  /** Ceiling on one attempt. These are single API calls, not agent runs. */
  timeoutMs?: number;
  /** Named in log lines and in the error a caller shows. */
  what: string;
  /** Set to 1 for a call whose failure is deterministic and not worth repeating. */
  attempts?: number;
}

/**
 * Run one `gh` command line and return its stdout.
 *
 * `commandLine` is appended to `GH_COMMAND` and must already be shell-safe: a WSL
 * workspace runs it through `bash -lc`, so anything interpolated into it has to be
 * validated by the caller rather than escaped here. Every caller in this project
 * interpolates only ids matched against a pattern first.
 */
export async function runGh(
  workspace: Workspace,
  commandLine: string,
  options: RunGhOptions
): Promise<string> {
  const attempts = options.attempts ?? ATTEMPTS;
  let lastError: Error = new Error('gh was never run');

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await runOnce(workspace, commandLine, options);
    } catch (error) {
      // Report the last failure, not the first: it describes what kept happening.
      lastError = error as Error;
      if (attempt < attempts - 1) {
        logger.warn(`gh failed running ${options.what} (attempt ${attempt + 1}/${attempts}): ${lastError.message}`);
        await wait(BACKOFF_MS[attempt] ?? 1200);
      }
    }
  }

  throw lastError;
}

function runOnce(workspace: Workspace, commandLine: string, options: RunGhOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { command, args, cwd } = buildAgentCommand(workspace, `${GH_COMMAND} ${commandLine}`);

  logger.info(`Running ${options.what} for workspace "${workspace.id}"`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: agentPath() },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out running ${options.what} after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // A raw `gh` stderr is more useful in the canvas than "request failed"; the caller
      // has no better context to add.
      if (code !== 0) reject(new Error(stderr.trim().slice(-300) || `gh exited with code ${code}`));
      else resolve(stdout);
    });
  });
}
