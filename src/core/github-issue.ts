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
 * How many times to run `gh` before giving up, and how long to wait between tries.
 *
 * `gh` intermittently fails here with socket buffer exhaustion and succeeds on the next
 * attempt seconds later. Without a retry that fault reaches the panel as a hard error,
 * which reads as a broken block rather than as the blip it is.
 */
const ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one issue, retrying a failing `gh`.
 *
 * Every failure is retried rather than only the socket error: matching a localised OS
 * message is not something to depend on, and a genuinely missing issue costs two extra
 * fast failures. A malformed response is the exception — that is deterministic, so
 * retrying it would only delay the error.
 */
export async function fetchIssue(workspace: Workspace, issueUrl: string): Promise<IssueDetail> {
  let lastError: Error = new Error('gh was never run');

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await runGh(workspace, issueUrl);
    } catch (error) {
      if (error instanceof MalformedResponse) throw error;
      // Report the last failure, not the first: it describes what kept happening.
      lastError = error as Error;
      if (attempt < ATTEMPTS - 1) {
        logger.warn(`gh failed reading ${issueUrl} (attempt ${attempt + 1}/${ATTEMPTS}): ${lastError.message}`);
        await wait(BACKOFF_MS[attempt] ?? 1200);
      }
    }
  }

  throw lastError;
}

/** A response `gh` returned but we could not read — never worth retrying. */
class MalformedResponse extends Error {}

/**
 * One `gh` run. Rejects with a message fit to show in the panel — the caller has no
 * better context to add, and a raw `gh` stderr is more useful than "request failed".
 */
async function runGh(workspace: Workspace, issueUrl: string): Promise<IssueDetail> {
  if (!isIssueUrl(issueUrl)) {
    throw new MalformedResponse(`Not a GitHub issue URL: ${issueUrl}`);
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
        reject(new MalformedResponse(`Could not parse the gh response: ${(error as Error).message}`));
      }
    });
  });
}
