/**
 * One chat turn about a founder action: the prompt, what the board will accept back, and the run.
 *
 * ## This file is a stopgap, and it says so at the top on purpose
 *
 * The HTTP surface this serves — `POST` and `GET /api/founder-actions/chat` — depends on two
 * issues of this milestone that were still open when it was written: position 13, which owns
 * `src/core/founder-chat.ts` (the prompt and the parser, pure), and position 15, which owns
 * `runFounderChatAgent` in `core/issue-agent.ts` (the headless run). Both were dispatched at the
 * same time as this one, so "depends on" did not mean "already on the default branch".
 *
 * The three bad answers were to ship the routes with no chat behind them, to write into either of
 * those two files and collide with whoever lands there first, and to invent a second, larger
 * design. What is here instead is the **smallest** thing the routes need, in a file neither of
 * those issues names, so that adopting theirs is deleting this one and changing the imports in
 * `src/server.ts`. Where their contracts are already written down in the issues, this follows
 * them to the letter — `founderChatPrompt`, `parseFounderChatAnswer(output, key)` answering
 * `{ reply, patch, refusal }` — so that the swap is a rename rather than a redesign.
 *
 * ## The register is defended here, not asked of the agent
 *
 * The agent answers a person in prose and may *propose* a revision; it never writes one. The
 * board applies it, and only after `validateFounderAction` has read the **merged whole**. That
 * distinction is the one a naive implementation gets wrong: every rule that spans fields — the
 * rendered-body ceiling, the step count, the numbering — is meaningless over a patch alone, so a
 * patch each of whose fields is legal can still produce a card the register forbids.
 *
 * A reply is returned in every refusal case. The founder asked a question and deserves the
 * answer; what the refusal costs them is the card changing, not the conversation.
 *
 * ## And the run cannot write anything on GitHub
 *
 * `withoutGhWrites` (position 12) takes the four writing `gh` verbs off the issue agent's own
 * grant, and it is a *report* rather than a guarantee: on a `raw` board, and on one whose
 * operator pinned their own `--allowedTools`, there is no grant of this board's to narrow. A run
 * that could not be narrowed is refused rather than started, because a chat that silently holds
 * repository write access is worse than no chat at all.
 */
import type { Workspace } from './workspaces.js';
import { agentRunFor, runAgent } from './issue-agent.js';
import { quotedLine, withoutGhWrites, type AgentCommandSpec } from './agent-adapter.js';
import {
  FounderActionFault,
  FounderActionFields,
  validateFounderAction,
} from './founder-action-text.js';
import type { FounderActionRecord } from './founder-store.js';

/**
 * The fields a chat may propose, which is every field of the card and nothing else.
 *
 * `kind`, `key`, `createdAt`, `evidence` and `publishedItemId` are deliberately absent, and a
 * block naming one is refused by name rather than ignored. A chat that could rewrite `kind` could
 * re-point a card at a different probe and make the verifier lie about it; `evidence` is the
 * machine's record of what it saw and is not the conversation's to edit.
 */
export const FOUNDER_PATCHABLE: readonly string[] = ['title', 'what', 'why', 'steps', 'confirm'];

/** What the board took from one answer. */
export interface FounderChatAnswer {
  /** What to show the person. Always something, whatever became of the patch. */
  reply: string;
  /** The merged fields to store, or null when there is nothing to change. */
  patch: FounderActionFields | null;
  /** Why the proposed revision was not applied, in words a panel can print. Null when it was. */
  refusal: string | null;
}

/** What one run came back with. `IssueAgentResult`'s shape, minus the URL it never produces. */
export interface FounderChatRunResult {
  ok: boolean;
  output: string;
  error: string | null;
}

/** The fence the board reads a proposed revision out of. */
const FENCE = '```';

/**
 * Every ```founder-action block in the output, innermost text only.
 *
 * Written as a scan rather than a single regular expression because the count matters: two blocks
 * is a refusal and not a first block, so this has to be able to *find* two.
 */
function blocksIn(output: string): string[] {
  const found: string[] = [];
  const pattern = /^[ \t]*```[ \t]*founder-action[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  for (const match of output.matchAll(pattern)) found.push(match[1] ?? '');
  return found;
}

/** The output with the blocks taken out, which is what a person is shown. */
function replyIn(output: string): string {
  const pattern = /^[ \t]*```[ \t]*founder-action[ \t]*\r?\n[\s\S]*?^[ \t]*```[ \t]*$/gm;
  return output.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim();
}

const faultLine = (fault: FounderActionFault): string =>
  `${fault.field} ${fault.rule} (${fault.detail})`;

/**
 * Read one answer, and say what the board will do with it.
 *
 * The identity check mirrors the one the recreate route already makes: it refuses to record a
 * rewrite unless the agent answered with the same issue it was given. Verify the answer before
 * believing it — an agent that named a different item is an agent that lost track of which card
 * it was talking about, and applying that would change a card nobody was looking at.
 */
export function parseFounderChatAnswer(
  output: string,
  key: string,
  current: FounderActionFields
): FounderChatAnswer {
  const text = typeof output === 'string' ? output : '';
  const reply = replyIn(text) || text.trim();
  const blocks = blocksIn(text);

  if (blocks.length === 0) return { reply, patch: null, refusal: null };
  if (blocks.length > 1) {
    return {
      reply,
      patch: null,
      refusal: `The answer carried ${blocks.length} revisions of this item and the board `
        + 'cannot tell which one was meant, so the item was left unchanged.',
    };
  }

  let proposed: { key?: unknown; fields?: unknown };
  try {
    proposed = JSON.parse(blocks[0] as string) as { key?: unknown; fields?: unknown };
  } catch (error) {
    return {
      reply,
      patch: null,
      refusal: `The revision the answer carried could not be read (${(error as Error).message}), `
        + 'so the item was left unchanged.',
    };
  }

  if (typeof proposed?.key !== 'string' || proposed.key !== key) {
    return {
      reply,
      patch: null,
      refusal: `The revision named "${String(proposed?.key ?? '')}" rather than this item, so it `
        + 'was not applied.',
    };
  }

  const fields = (proposed.fields ?? {}) as Record<string, unknown>;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { reply, patch: null, refusal: 'The revision carried no fields, so nothing changed.' };
  }

  const forbidden = Object.keys(fields).filter((name) => !FOUNDER_PATCHABLE.includes(name));
  if (forbidden.length > 0) {
    return {
      reply,
      patch: null,
      refusal: `The revision tried to change ${forbidden.join(', ')}, which a conversation may `
        + 'not change, so the item was left unchanged.',
    };
  }

  // The merged whole, never the patch alone: the ceilings that bite are the ones that span
  // fields, and a patch validated by itself passes every one of them.
  const merged = { ...current, ...(fields as Partial<FounderActionFields>) } as FounderActionFields;
  const validation = validateFounderAction(merged);
  if (!validation.ok) {
    return {
      reply,
      patch: null,
      refusal: 'The revision broke the rules a founder action is held to, so the item was left '
        + `unchanged: ${validation.faults.map(faultLine).join('; ')}`,
    };
  }

  return { reply, patch: merged, refusal: null };
}

/** One turn as the prompt spells it, oldest first. */
const transcriptOf = (record: FounderActionRecord): string =>
  (record.chat ?? [])
    .map((turn) => `${turn.role === 'founder' ? 'The founder' : 'You'}: ${turn.text}`)
    .join('\n\n') || '(nothing has been said about this item yet)';

/**
 * What the agent is asked, which is a question about a card and never a job on GitHub.
 *
 * The boundary is prose, exactly as the revise prompt's is — but unlike that one it is backed
 * mechanically at both ends: the invocation cannot reach a writing `gh` verb, and the board is
 * what applies any revision, through the validator.
 */
export function founderChatPrompt(record: FounderActionRecord, message: string): string {
  const fields = record.fields;
  const evidence = record.evidence ?? {};
  const evidenceLines = [
    evidence.command ? `- Command: ${evidence.command}` : '',
    evidence.said ? `- Said: ${evidence.said}` : '',
    evidence.source ? `- Source: ${evidence.source}` : '',
  ].filter(Boolean).join('\n') || '(nothing was recorded)';

  return `You are answering one question from the person this board was built for. They are
looking at a card that says something on their machine or their account needs a human, and they
have asked you about it. Answer them in plain words, in a few sentences, as you would answer
somebody with a payment card and ten minutes.

You may not edit anything on GitHub. Do not open an issue, do not comment on one, do not touch a
project. Nothing you are being asked for needs any of that, and the run you are in cannot reach
them.

If — and only if — what you have to say means the card itself should now say something different,
emit exactly one fenced block, after your answer, of this shape:

${FENCE}founder-action
{"key": "${record.key}", "fields": {"title": "...", "steps": ["...", "..."]}}
${FENCE}

Put in \`fields\` only the parts that change; the board merges them over what is there. The only
names it accepts are ${FOUNDER_PATCHABLE.join(', ')}. One block or none — two blocks are refused
rather than guessed between, and the board reads the merged result against its own rules before
it stores anything. If it refuses, your answer is still shown and the card simply does not change.

---

The founder action key: ${record.key}
Title: ${fields.title}

What: ${fields.what}

Why: ${fields.why}

Steps:
${fields.steps.map((step, at) => `${at + 1}. ${step}`).join('\n')}

Confirm: ${fields.confirm}

What the machine saw:
${evidenceLines}

---

The conversation so far:

${transcriptOf(record)}

---

The founder's message:

${message}`;
}

/**
 * Run one turn, headless, with the GitHub writes taken off the invocation.
 *
 * No `host`, exactly as `runIssueAgent` and `runReviseAgent` pass none: no terminal session is
 * opened and none of the eight session slots is consumed. One founder action per open tab would
 * exhaust a board, and the transcript in such a tab belongs to the program rather than to the
 * board.
 *
 * `ok` is read off the exit code rather than off `AgentRun.ok`, which folds in "and it printed a
 * GitHub URL" — the one thing a chat turn must never produce.
 */
export async function runFounderChatTurn(
  workspace: Workspace,
  record: FounderActionRecord,
  message: string,
  options: {
    agent: AgentCommandSpec;
    timeoutMs?: number;
    notFoundVariable?: string | null;
  }
): Promise<FounderChatRunResult> {
  const settings = workspace.agents?.issue ?? null;
  const { adapter, invocation } = agentRunFor(options.agent, 'issue', settings);

  const narrowing = withoutGhWrites(invocation.args);
  if (!narrowing.narrowed) {
    return {
      ok: false,
      output: '',
      error: 'A chat about a founder action is not enabled on this board, because the writes it '
        + `must not have could not be taken off the run: ${narrowing.reason}`,
    };
  }

  const narrowed = {
    ...invocation,
    args: narrowing.args,
    // Rebuilt from the narrowed argv, because a project inside a distro is handed the *line* and
    // not the argv: leaving the old one would run the wide grant on exactly the boards this
    // narrowing was written for.
    line: quotedLine(invocation.command, narrowing.args),
  };

  const run = await runAgent(workspace, founderChatPrompt(record, message), {
    adapter,
    invocation: narrowed,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // The answer is prose and never a URL. `expects` has no "nothing" arm, so the cheaper of the
    // two is named and the outcome is read off the exit code below rather than off `ok`.
    expects: 'issues',
    what: 'founder chat agent',
    notFoundVariable: options.notFoundVariable ?? null,
  });

  if (run.code === 0) return { ok: true, output: run.output, error: null };
  return {
    ok: false,
    output: run.output,
    error: run.error ?? 'The agent ended without answering.',
  };
}
