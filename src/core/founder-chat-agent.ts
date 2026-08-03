/**
 * One chat turn about a founder action, run as a headless agent with the GitHub writes gone.
 *
 * ## What this is, and what it is not
 *
 * Three pieces already exist and none of them spawns anything: `founder-chat.ts` composes the
 * prompt and reads the answer back (#544), `withoutGhWrites` in `agent-adapter.ts` takes the
 * four filing commands off an invocation (#543), and `runAgent` in `issue-agent.ts` is how
 * every other run on this board is started. This is the seam that joins them, and nothing
 * else: no route, no store, no decision about what to do with a patch.
 *
 * It is deliberately small because **position 15 (#546) is the issue that owns this run** and
 * had not landed when the panel that needs it was written. The whole of it is behind one
 * injectable parameter — `spawn`, defaulting to `runAgent` — so that adopting #546's runner is
 * changing one call rather than unpicking a route, and so that a check can drive a turn without
 * a real agent on the machine.
 *
 * ## The narrowing is a refusal, not a warning
 *
 * `withoutGhWrites` reports `narrowed: false` on a board it cannot narrow — a `raw` backend,
 * or one whose operator pinned their own `--allowedTools`. #543 states outright what a caller
 * that gets `false` must do: refuse. A chat is a conversation about a payment or a sign-in, and
 * an agent that can still run `gh issue create` in the middle of one would be filing on somebody's
 * repository from a text box that says nothing about GitHub at all. So a board that cannot be
 * narrowed has no chat, and `GET /api/founder-actions` says so in `capabilities` rather than
 * letting the reader find out by pressing send.
 *
 * ## What comes back
 *
 * The agent's own words, and never a URL. `runAgent` folds "exited zero" and "printed a URL"
 * into `ok`, which is the right question for the two runs that must produce an issue and the
 * wrong one here — there is no URL to produce, so the exit code is read directly.
 */
import {
  AgentCommandSpec,
  AgentInvocation,
  withoutGhWrites,
} from './agent-adapter.js';
import {
  AgentRun,
  agentRunFor,
  lastThingSaid,
  runAgent,
} from './issue-agent.js';
import type { Workspace } from './workspaces.js';
import type { FounderActionEvidence } from './founder-action-text.js';
import {
  FounderChatAnswer,
  FounderChatItem,
  FounderChatMessage,
  founderChatPrompt,
  parseFounderChatAnswer,
} from './founder-chat.js';

/**
 * How much of the agent's answer is kept.
 *
 * `lastThingSaid` exists to put the tail of a run in a one-line error and defaults to 600
 * characters for that. A chat reply is the thing the reader came for, and a revision arrives
 * inside it as a fenced block, so it is read at a width that cannot cut one in half.
 */
const REPLY_LIMIT = 20000;

/** The narrowed invocation, or the sentence that says why there is none. */
export interface FounderChatInvocation {
  invocation: AgentInvocation | null;
  /** Why a chat cannot run on this board, or null when it can. */
  refusal: string | null;
}

/**
 * The invocation one chat turn would be spawned with, with the GitHub writes taken off it.
 *
 * Exported on its own so the list route can answer whether this board has a chat at all
 * without spawning anything: **controls are driven by `capabilities`, never by probing a POST**,
 * and a POST probe against a route that exists would perform the write it was probing for.
 *
 * The issue role's settings, for the reason `runReviseAgent` uses them: this is the read-only
 * agent answering a question with a document in front of it, which is the same shape of work,
 * and a project that said how its issue agent runs said it about this too.
 */
export function founderChatInvocation(
  workspace: Workspace,
  agent: AgentCommandSpec
): FounderChatInvocation {
  const settings = workspace.agents?.issue ?? null;
  const base = agentRunFor(agent, 'issue', settings);
  const narrowing = withoutGhWrites(base.invocation.args);
  if (!narrowing.narrowed) {
    return {
      invocation: null,
      refusal: 'A chat about a founder action may not be started on this board: '
        + `${narrowing.reason ?? 'the GitHub writes could not be taken off the run'}.`,
    };
  }
  return { invocation: { ...base.invocation, args: narrowing.args }, refusal: null };
}

export interface FounderChatRunOptions {
  agent: AgentCommandSpec;
  /** Named when the command turns out not to exist where it was run. See `RunAgentOptions`. */
  notFoundVariable?: string | null;
  /**
   * What actually starts the process. `runAgent` unless a caller says otherwise.
   *
   * The seam #546 replaces, and the seam a check drives: a chat turn is the one run on this
   * board with no GitHub URL to look for, so the thing that spawns it is the thing most likely
   * to be rewritten once that issue lands.
   */
  spawn?: typeof runAgent;
}

/** What one turn produced: the answer to hand the founder, or why there was none. */
export interface FounderChatRunResult {
  ok: boolean;
  /** Present whenever the agent said anything at all, refusal or not. */
  answer: FounderChatAnswer | null;
  error: string | null;
}

/**
 * Run one turn and read the answer back.
 *
 * Never throws: a route that has already written the founder's own words into the store has to
 * finish deciding what to say about the run, and a caller's `catch` deciding that would be this
 * decision taken somewhere nobody can read it.
 */
export async function runFounderChatTurn(
  workspace: Workspace,
  item: FounderChatItem,
  evidence: FounderActionEvidence | null,
  transcript: readonly FounderChatMessage[],
  message: string,
  options: FounderChatRunOptions
): Promise<FounderChatRunResult> {
  const { invocation, refusal } = founderChatInvocation(workspace, options.agent);
  if (!invocation) return { ok: false, answer: null, error: refusal };

  const settings = workspace.agents?.issue ?? null;
  const adapter = agentRunFor(options.agent, 'issue', settings).adapter;
  const prompt = founderChatPrompt(item, evidence, transcript, message);

  const spawn = options.spawn ?? runAgent;
  let run: AgentRun;
  try {
    run = await spawn(workspace, prompt, {
      adapter,
      invocation,
      // `expects` is the kind of URL a run has to produce, and this one produces none. It is
      // still a required field, so it is given the harmless value and the exit code below is
      // what the outcome is read from.
      expects: 'issues',
      what: 'founder chat agent',
      timeoutMs: settings?.timeoutMs ?? null,
      notFoundVariable: options.notFoundVariable ?? null,
    });
  } catch (error) {
    return { ok: false, answer: null, error: (error as Error).message };
  }

  if (run.code !== 0) {
    return { ok: false, answer: null, error: run.error ?? 'The agent did not finish.' };
  }
  return { ok: true, answer: parseFounderChatAnswer(lastThingSaid(run.output, REPLY_LIMIT), item), error: null };
}
