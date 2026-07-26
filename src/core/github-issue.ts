/**
 * Reads a GitHub issue back through `gh`, so a finished block can show what it produced.
 *
 * Deliberately a read at selection time rather than a copy taken at creation time. An
 * issue body is kilobytes; stored on the element it would ride in every autosync payload
 * and every export, and would still be a snapshot — stale the moment anyone edits the
 * issue on GitHub. Only the title is kept on the element, because a card has to read
 * correctly with nothing selected and with no network.
 */
import { spawn } from 'child_process';
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
import { agentPath, buildAgentCommand } from './issue-agent.js';

/**
 * The `gh` invocation. Overridable for the same reason EXCALIDRAW_ISSUE_AGENT is: a
 * check script has to be able to answer without a real GitHub account behind it.
 */
export const GH_COMMAND = process.env.EXCALIDRAW_GH_COMMAND || 'gh';

/** How long a read may take. Far shorter than an agent run — this is one API call. */
const TIMEOUT_MS = 30_000;

/** Issue URLs come from our own extraction, but this is what gets handed to a shell-less spawn. */
const ISSUE_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/\d+$/;

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
}

export function isIssueUrl(url: string): boolean {
  return ISSUE_URL.test(url);
}

/**
 * Fetch one issue. Rejects with a message fit to show in the panel — the caller has no
 * better context to add, and a raw `gh` stderr is more useful than "request failed".
 */
export async function fetchIssue(workspace: Workspace, issueUrl: string): Promise<IssueDetail> {
  if (!isIssueUrl(issueUrl)) {
    throw new Error(`Not a GitHub issue URL: ${issueUrl}`);
  }

  const { command, args, cwd } = buildAgentCommand(
    workspace,
    `${GH_COMMAND} issue view ${issueUrl} --json number,title,body,state`
  );

  logger.info(`Reading ${issueUrl} for workspace "${workspace.id}"`);

  return new Promise<IssueDetail>((resolve, reject) => {
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
      reject(new Error(`Timed out reading the issue after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

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

      if (code !== 0) {
        reject(new Error(stderr.trim().slice(-300) || `gh exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as Partial<IssueDetail>;
        resolve({
          number: Number(parsed.number ?? 0),
          title: String(parsed.title ?? ''),
          body: String(parsed.body ?? ''),
          state: String(parsed.state ?? ''),
          url: issueUrl,
        });
      } catch (error) {
        reject(new Error(`Could not parse the gh response: ${(error as Error).message}`));
      }
    });
  });
}
