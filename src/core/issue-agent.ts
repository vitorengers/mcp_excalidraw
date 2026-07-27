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
import { AgentUsage, streamsUsage, UsageMeter } from './agent-usage.js';
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
 * How long a run may take before it is killed: by default, as long as it takes.
 *
 * It was twenty minutes, on the premise that researching an issue is bounded work. That
 * premise went: the investigation now also reads reference images, existing issues and the
 * project's documentation, and a real run was killed at 1200s having already created its
 * issue. The salvage below could not rescue it either — see the note there. Set
 * EXCALIDRAW_ISSUE_AGENT_TIMEOUT (seconds) to put a ceiling back.
 *
 * The trade is the same one implementing already makes, and is handled the same way: with
 * no ceiling a wedged run holds the block in `running`, so the block offers a reset.
 */
export const DEFAULT_TIMEOUT_MS: number | null = (() => {
  const configured = Number(process.env.EXCALIDRAW_ISSUE_AGENT_TIMEOUT);
  return Number.isFinite(configured) && configured > 0 ? configured * 1000 : null;
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
 * A directory named twice: once for this process, once for the agent's own environment.
 *
 * They differ for a WSL-backed project, where this process reads through a UNC share and
 * the agent sees a POSIX path. Handing the wrong one to a tool inside the distro gives it
 * a working directory it cannot act on.
 */
export interface AgentDirectory {
  /** Path usable by this process. */
  path: string;
  /** The same directory as the workspace's own environment names it. */
  innerPath: string;
}

/**
 * Build the command for a workspace.
 *
 * A WSL-backed project runs through wsl.exe with the project's inner path, because the
 * agent has to see the repository the way git and gh inside that distro do — a Windows
 * UNC path would give it a working directory those tools cannot act on.
 *
 * `directory` overrides where the agent starts, and is how an implementation is put in a
 * worktree of its own rather than in the one directory every run used to share. Omitted,
 * the agent starts in the project itself, which is what reading a repository wants.
 */
export function buildAgentCommand(
  workspace: Workspace,
  agentCommand: string,
  directory?: AgentDirectory | null
): { command: string; args: string[]; cwd: string | undefined } {
  if (workspace.environment.kind === 'wsl') {
    return {
      command: 'wsl.exe',
      args: [
        '-d', workspace.environment.distro,
        '--cd', directory?.innerPath ?? workspace.innerPath,
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
    cwd: directory?.path ?? workspace.path,
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
   * Ceiling on the run, or `null` for none — which is now what both agents default to.
   *
   * Researching kept twenty minutes for a while, on the premise that it was bounded work.
   * It is not: killing an agent that has already created its issue reports a failure for
   * work that succeeded, and killing one partway through a change leaves a branch nobody
   * asked for. `null` accepts the trade that comes with it: a wedged run has to be
   * recovered by hand, so something must offer that.
   */
  timeoutMs?: number | null;
  /** Which kind of URL counts as the answer. */
  expects: 'issues' | 'pull';
  /** Named in log lines and in the error a caller shows. */
  what: string;
  /** Where to start the agent, when that is not the project directory itself. */
  directory?: AgentDirectory | null;
  /**
   * The run's token totals so far, whenever they change.
   *
   * Called only when the configured command already asks its agent for a machine-readable
   * stream. A command that does not — today's default — never reaches this, and the spawn
   * path below is byte for byte what it was: the same "nothing at all" half that
   * `worktreeSection` and `imageReferenceSection` are careful about.
   */
  onUsage?: (usage: AgentUsage) => void;
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
  const { command, args, cwd } = buildAgentCommand(workspace, options.agentCommand, options.directory);
  // The article travels with the noun. A fixed one reads as "a issue URL".
  const noun = options.expects === 'pull' ? 'a pull request URL' : 'an issue URL';

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

    // Reads the totals out of the stream the agent is already writing. Null unless the
    // caller asked *and* the command streams, which is what keeps this off by default.
    const meter = options.onUsage && streamsUsage(options.agentCommand)
      ? new UsageMeter(options.onUsage)
      : null;

    // `undefined` means "use the default"; `null` and 0 mean "no ceiling at all".
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    const timeout = timeoutMs ? setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();

      // The agent may well have finished the visible work and then kept going.
      // Reporting a failure for work that succeeded is worse than reporting a slow
      // success, so salvage the URL from whatever it printed before the kill.
      //
      // Kept, but it is not a guarantee, and it was once documented as one: a plain
      // `claude -p` writes nothing until it exits, so at the kill `stdout` is empty and
      // there is nothing here to find. It rescues a run only when the command streams —
      // `--output-format stream-json` — which is why this is no longer the answer to a
      // ceiling that fires. Not firing at all is.
      meter?.flush();
      const salvaged = extractGithubUrl(stdout, options.expects);
      resolve({
        ok: Boolean(salvaged),
        url: salvaged,
        output: stdout,
        error: salvaged ? null : `Agent timed out after ${timeoutMs / 1000}s without returning ${noun}`,
      });
    }, timeoutMs) : null;

    const clearIfSet = () => { if (timeout) clearTimeout(timeout); };

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      meter?.take(text);
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearIfSet();
      meter?.flush();
      resolve({ ok: false, url: null, output: stdout, error: error.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearIfSet();
      meter?.flush();
      const url = extractGithubUrl(stdout, options.expects);
      resolve({
        ok: code === 0 && Boolean(url),
        url,
        output: stdout,
        error: code === 0
          ? (url
              ? null
              : `Agent finished without returning ${noun}. It said: ${stdout.trim().slice(-600) || '(nothing)'}`)
          : `Agent exited with code ${code}: ${stderr.slice(-500)}`,
      });
    });
  });
}

/**
 * The section that names the reference images, or nothing at all.
 *
 * Nothing at all is the important half: a block with no images attached must send the
 * prompt it sent before this existed, byte for byte, because a feature nobody used must
 * not change what every block already does.
 *
 * The instruction says what the images are *for*, because the obvious reading is wrong.
 * They cannot become part of the issue — `gh issue create` uploads nothing, and the
 * upload endpoint GitHub's own web client uses is not public API — so an agent that tries
 * to attach them wastes the run. They are material for the investigation, and anything
 * from them the issue depends on has to be written out in words.
 */
export function imageReferenceSection(paths: readonly string[]): string {
  if (!paths.length) return '';

  const list = paths.map((imagePath) => `- ${imagePath}`).join('\n');
  return `\n\n---\n\nReference images (${paths.length}), attached to this observation and already on disk:

${list}

Read each one before you write the issue. They are reference material for the
investigation, not content for the issue: they cannot be uploaded to GitHub, so describe
in words whatever the issue depends on. They are deleted when this run ends, so nothing
you write may point at these paths.`;
}

export async function runIssueAgent(
  workspace: Workspace,
  observation: string,
  options: { agentCommand: string; timeoutMs?: number; imagePaths?: readonly string[] }
): Promise<IssueAgentResult> {
  const prompt = `${ISSUE_AGENT_PROMPT}\n\n---\n\nObservation:\n\n${observation}`
    + imageReferenceSection(options.imagePaths ?? []);
  const run = await runAgent(workspace, prompt, {
    agentCommand: options.agentCommand,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    expects: 'issues',
    what: 'issue agent',
  });
  return { ok: run.ok, issueUrl: run.url, output: run.output, error: run.error };
}
