/**
 * Runs a coding agent inside a workspace to turn an observation into a GitHub issue.
 *
 * This spawns a process with full access to a repository, which is the most dangerous
 * thing this server does. Three guards apply, and none of them is optional:
 *
 *  - it only runs when EXCALIDRAW_ISSUE_AGENT is set, so it cannot be reached by
 *    default on a server that has no authentication;
 *  - it refuses to run unless the server is bound to loopback;
 *  - one run at a time per element, tracked by the caller, so a double click cannot
 *    open two issues.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';

/** Default instruction. Investigation first, evidence over guesswork, URL last. */
export const ISSUE_AGENT_PROMPT = `You will receive an observation about this project and turn it into a GitHub issue.

Do not write the issue immediately. Investigate this repository first:

1. Look for the root cause. The observation describes symptoms, not diagnoses — what is
   called a bug may be configuration, and what is called a feature may already exist.
   Cite evidence as file:line.
2. Check whether an open issue already covers it (\`gh issue list\`). If one does, comment
   there instead of duplicating, and say that is what you did.
3. Read the project's documentation before proposing a solution. If the answer depends on
   something the repository does not settle, research it — do not invent it.

Then write the issue with: context and the evidence you found, root cause (or the competing
hypotheses, when the investigation is not conclusive), proposed scope, a verifiable
definition of done, and the assumptions you had to make. If the observation is too ambiguous
for a good issue, write what you can and list the open questions — never fill a gap with a
guess presented as fact.

Write the issue in English — title and body. That is fixed: not the language of the
observation, and not the language of the repository you just read, whose documentation may
well be in something else. Every development artifact in this project is English. Quote the
observation verbatim when its exact wording is the evidence; translate everything else.

Create the issue with \`gh\` in this repository, add it to the configured project, and return
only the issue URL on a line of its own.`;

/**
 * PATH for the agent, with the GitHub CLI added when it is missing.
 *
 * The agent is told to use `gh`, but a server started before the CLI was installed
 * inherits a PATH without it — and a child process inherits that stale PATH in turn.
 * The failure reads as the agent being unable to create the issue, which points at
 * the wrong thing entirely.
 */
export function agentPath(): string {
  const current = process.env.PATH ?? '';
  if (/github cli/i.test(current)) return current;

  // Forward slashes: Windows accepts them, and they cannot be silently eaten as
  // escape sequences the way a lone backslash before a letter would be.
  const candidates = [
    'C:/Program Files/GitHub CLI',
    'C:/Program Files (x86)/GitHub CLI',
  ];
  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(path.join(candidate, 'gh.exe'));
    } catch {
      return false;
    }
  });

  return found ? `${current}${path.delimiter}${found}` : current;
}

/**
 * How long a run may take before it is killed.
 *
 * Twenty minutes because a real investigation reads source, checks existing issues
 * and drafts prose — the first genuine run overran ten minutes having already created
 * the issue. Override with EXCALIDRAW_ISSUE_AGENT_TIMEOUT (seconds).
 */
export const DEFAULT_TIMEOUT_MS = (() => {
  const configured = Number(process.env.EXCALIDRAW_ISSUE_AGENT_TIMEOUT);
  return Number.isFinite(configured) && configured > 0 ? configured * 1000 : 1_200_000;
})();

export interface IssueAgentResult {
  ok: boolean;
  issueUrl: string | null;
  output: string;
  error: string | null;
}

/**
 * The last GitHub URL of a given kind in the output.
 *
 * The last, not the first: an agent may well have listed existing issues or pull
 * requests on its way to creating the one it is reporting.
 */
export function extractGithubUrl(output: string, kind: 'issues' | 'pull'): string | null {
  const pattern = new RegExp(`https://github\\.com/[^\\s"'<>]+/${kind}/\\d+`, 'g');
  const matches = output.match(pattern);
  return matches?.length ? (matches[matches.length - 1] ?? null) : null;
}

/** Last non-empty line that looks like a GitHub issue URL. */
export function extractIssueUrl(output: string): string | null {
  return extractGithubUrl(output, 'issues');
}

/**
 * Build the command for a workspace.
 *
 * A WSL-backed project runs through wsl.exe with the project's inner path, because the
 * agent has to see the repository the way git and gh inside that distro do — a Windows
 * UNC path would give it a working directory those tools cannot act on.
 */
export function buildAgentCommand(
  workspace: Workspace,
  agentCommand: string
): { command: string; args: string[]; cwd: string | undefined } {
  if (workspace.environment.kind === 'wsl') {
    return {
      command: 'wsl.exe',
      args: [
        '-d', workspace.environment.distro,
        '--cd', workspace.innerPath,
        '--', 'bash', '-lc', agentCommand,
      ],
      // wsl.exe itself runs from wherever; --cd places the agent inside the project.
      cwd: undefined,
    };
  }

  const [command, ...args] = tokenizeCommand(agentCommand);
  return {
    command: command ?? agentCommand,
    args,
    cwd: workspace.path,
  };
}

/**
 * Split a command line into argv, keeping quoted runs together.
 *
 * Splitting on whitespace alone would tear apart a flag whose value contains spaces,
 * which is exactly the shape of a permission list: --allowedTools "Bash(gh:*) Read".
 * Quotes are consumed, not passed on — there is no shell here to strip them later.
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) tokens.push(current);

  return tokens;
}

export interface AgentRun {
  ok: boolean;
  /** The GitHub URL the run was asked to produce, or null when it produced none. */
  url: string | null;
  output: string;
  error: string | null;
}

export interface RunAgentOptions {
  agentCommand: string;
  /**
   * Ceiling on the run, or `null` for none.
   *
   * A ceiling suits bounded work — researching an issue is reading and drafting, and
   * twenty minutes was measured against a real run of it. Implementing is not bounded
   * that way, and killing a working agent partway through a change is worse than
   * letting it finish. `null` accepts the trade that comes with that: a wedged run has
   * to be recovered by hand, so something must offer that.
   */
  timeoutMs?: number | null;
  /** Which kind of URL counts as the answer. */
  expects: 'issues' | 'pull';
  /** Named in log lines and in the error a caller shows. */
  what: string;
}

/**
 * Run an agent inside a workspace and take one GitHub URL from what it printed.
 *
 * Shared rather than copied per feature, because the salvage below was earned: an agent
 * created its issue and then kept working past the timeout, and reporting that as a
 * failure would have invited a second run for work that had already succeeded.
 */
export async function runAgent(
  workspace: Workspace,
  prompt: string,
  options: RunAgentOptions
): Promise<AgentRun> {
  const { command, args, cwd } = buildAgentCommand(workspace, options.agentCommand);
  const noun = options.expects === 'pull' ? 'pull request URL' : 'issue URL';

  logger.info(`Running ${options.what} for workspace "${workspace.id}"`, { command, cwd });

  return new Promise<AgentRun>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: agentPath() },
      // No shell: the prompt arrives over stdin, so nothing has to survive quoting.
      // Passing multi-line text as an argument breaks on cmd.exe long before the
      // agent ever sees it.
      windowsHide: true,
    });

    child.stdin?.on('error', () => { /* the agent may exit before reading stdin */ });
    child.stdin?.end(prompt);

    let stdout = '';
    let stderr = '';
    let settled = false;

    // `undefined` means "use the default"; `null` and 0 mean "no ceiling at all".
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    const timeout = timeoutMs ? setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();

      // The agent may well have finished the visible work and then kept going.
      // Reporting a failure for work that succeeded is worse than reporting a slow
      // success, so salvage the URL from whatever it printed before the kill.
      const salvaged = extractGithubUrl(stdout, options.expects);
      resolve({
        ok: Boolean(salvaged),
        url: salvaged,
        output: stdout,
        error: salvaged ? null : `Agent timed out after ${timeoutMs / 1000}s without returning a ${noun}`,
      });
    }, timeoutMs) : null;

    const clearIfSet = () => { if (timeout) clearTimeout(timeout); };

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearIfSet();
      resolve({ ok: false, url: null, output: stdout, error: error.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearIfSet();
      const url = extractGithubUrl(stdout, options.expects);
      resolve({
        ok: code === 0 && Boolean(url),
        url,
        output: stdout,
        error: code === 0
          ? (url
              ? null
              : `Agent finished without returning a ${noun}. It said: ${stdout.trim().slice(-600) || '(nothing)'}`)
          : `Agent exited with code ${code}: ${stderr.slice(-500)}`,
      });
    });
  });
}

export async function runIssueAgent(
  workspace: Workspace,
  observation: string,
  options: { agentCommand: string; timeoutMs?: number }
): Promise<IssueAgentResult> {
  const prompt = `${ISSUE_AGENT_PROMPT}\n\n---\n\nObservation:\n\n${observation}`;
  const run = await runAgent(workspace, prompt, {
    agentCommand: options.agentCommand,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    expects: 'issues',
    what: 'issue agent',
  });
  return { ok: run.ok, issueUrl: run.url, output: run.output, error: run.error };
}
