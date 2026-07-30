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
 * The `gh` invocation for one workspace. Overridable so a check script can answer without
 * a real GitHub account behind it.
 *
 * **Per workspace, because a command is a path and a path does not cross into a distro.**
 * `EXCALIDRAW_GH_COMMAND` is read on a machine where the CLI is not on `PATH`, so its value
 * is an absolute host path — and a WSL workspace runs its command line through `bash -lc`,
 * where `C:\Program Files\GitHub CLI\gh.exe` is not a file that can exist. Read once for the
 * whole server, that variable took the mirror off every distro-backed board the moment it
 * was set, and took the issue panel, a dragged card and both of a run's moves with it (#252).
 * `agentCommandFor` settles the same question for the agents; this is the half that was
 * missed.
 *
 * **The WSL half does not fall back to the host override**, which is where this parts company
 * with `agentCommandFor`. There the fallback is what keeps a bare `claude -p …` working in
 * both environments, and an unset command means the feature is off entirely — so falling back
 * is the difference between working and disabled. Here an unset override means "the CLI is on
 * `PATH`", which each environment answers for itself, and `gh` is the answer that is right in
 * both. Falling back to the host's path is not a weaker guess than `gh`; it is the defect, and
 * it can only ever produce `command not found`.
 *
 * Read at call time rather than at import, so a workspace resolves against the environment
 * the server is actually holding. Every check that stubs `gh` sets the variable before the
 * server starts, which is earlier either way.
 */
export function ghCommandFor(workspace: Workspace): string {
  if (workspace.environment.kind === 'wsl') {
    return process.env.EXCALIDRAW_GH_COMMAND_WSL?.trim() || 'gh';
  }
  return process.env.EXCALIDRAW_GH_COMMAND?.trim() || 'gh';
}

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
  /**
   * Text written to `gh`'s stdin, for a flag that reads one — `--body-file -`.
   *
   * This is the only way free text can reach `gh` from here. The command line is a string
   * that a WSL workspace runs through `bash -lc`, so a comment containing `$(echo hi)`
   * interpolated into it would be executed rather than posted; stdin is a byte stream with
   * no shell anywhere near it. Every attempt writes it again, which is what makes a retry
   * a repeat rather than an empty call.
   */
  stdin?: string;
}

/**
 * Run one `gh` command line and return its stdout.
 *
 * `commandLine` is appended to the workspace's `gh` and must already be shell-safe: a WSL
 * workspace runs it through `bash -lc`, so anything interpolated into it has to be
 * validated by the caller rather than escaped here. Every caller in this project
 * interpolates only ids matched against a pattern first.
 *
 * Text that cannot be validated that way — anything a person typed — goes in
 * `options.stdin` instead, paired with the flag that reads it.
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
  const { command, args, cwd } = buildAgentCommand(
    workspace,
    `${ghCommandFor(workspace)} ${commandLine}`
  );

  logger.info(`Running ${options.what} for workspace "${workspace.id}"`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: agentPath() },
      windowsHide: true,
    });

    if (options.stdin !== undefined) {
      // `gh` may exit before it reads any of this — a refused command, say — and an
      // EPIPE from that must not become the error the caller reports.
      child.stdin?.on('error', () => { /* nothing left to write to */ });
      child.stdin?.end(options.stdin);
    }

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
