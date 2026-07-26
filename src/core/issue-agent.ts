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

Create the issue with \`gh\` in this repository, add it to the configured project, and return
only the issue URL on a line of its own.`;

export interface IssueAgentResult {
  ok: boolean;
  issueUrl: string | null;
  output: string;
  error: string | null;
}

/** Last non-empty line that looks like a GitHub issue URL. */
export function extractIssueUrl(output: string): string | null {
  const matches = output.match(/https:\/\/github\.com\/[^\s"'<>]+\/issues\/\d+/g);
  return matches?.length ? (matches[matches.length - 1] ?? null) : null;
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

  // Split on whitespace so the command can carry flags, as in "claude -p".
  const [command, ...args] = agentCommand.trim().split(/\s+/);
  return {
    command: command ?? agentCommand,
    args,
    cwd: workspace.path,
  };
}

export async function runIssueAgent(
  workspace: Workspace,
  observation: string,
  options: { agentCommand: string; timeoutMs?: number }
): Promise<IssueAgentResult> {
  const prompt = `${ISSUE_AGENT_PROMPT}\n\n---\n\nObservation:\n\n${observation}`;
  const { command, args, cwd } = buildAgentCommand(workspace, options.agentCommand);

  logger.info(`Running issue agent for workspace "${workspace.id}"`, { command, cwd });

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
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

    // An investigation legitimately takes minutes; without a ceiling a wedged agent
    // would hold the element in "running" forever with no way back.
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        ok: false,
        issueUrl: null,
        output: stdout,
        error: `Agent timed out after ${(options.timeoutMs ?? 600_000) / 1000}s`,
      });
    }, options.timeoutMs ?? 600_000);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, issueUrl: null, output: stdout, error: error.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const issueUrl = extractIssueUrl(stdout);
      resolve({
        ok: code === 0 && Boolean(issueUrl),
        issueUrl,
        output: stdout,
        error: code === 0
          ? (issueUrl ? null : 'Agent finished without returning an issue URL')
          : `Agent exited with code ${code}: ${stderr.slice(-500)}`,
      });
    });
  });
}
