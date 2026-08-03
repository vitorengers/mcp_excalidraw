/**
 * One chat turn about a founder action: the prompt that is sent, and what comes back.
 *
 * The operator wants to ask "which plan should I buy?", "is the free tier enough?", "I did it,
 * what now?" — and to have the answer be able to change the card. The card is a record of named
 * fields and the register is the schema (`founder-action-text.ts`), so the agent cannot be what
 * writes it: it answers the person and, at most, *offers* a revision. The board applies the
 * revision, and `parseFounderChatAnswer` is the gate in front of it.
 *
 * **Pure, and deliberately so**, for the reason `founder-action-text.ts` gives: the panel that
 * carries this chat runs in the browser and `frontend/tsconfig.json` sets `"types": []`. Nothing
 * here spawns, stores or asks GitHub anything, and it imports nothing from `founder-store.ts` —
 * that module opens files, so even an `import type` of it would resolve a Node graph the
 * frontend compiles.
 */
import {
  FOUNDER_ACTION_LIMITS,
  FounderActionEvidence,
  FounderActionFault,
  FounderActionFields,
  renderFounderAction,
  validateFounderAction,
} from './founder-action-text.js';

/** The item a turn is about, as much of it as the prompt and the gate need. */
export interface FounderChatItem {
  /** `founderActionKey`'s composition. The identity a block has to answer with. */
  key: string;
  /** The kind, named in the prompt so the agent knows which blocker it is talking about. */
  kind: string;
  /** The card as it stands, which is what a patch is merged onto. */
  fields: FounderActionFields;
}

/** One turn already said. Structurally a `FounderChatTurn`, declared here rather than imported. */
export interface FounderChatMessage {
  role: 'founder' | 'agent';
  text: string;
  at?: string;
}

/** Why the board will not apply what came back. */
export type FounderChatRefusalReason =
  | 'two-blocks' | 'wrong-key' | 'not-patchable' | 'unreadable' | 'register' | 'empty';

/** A refusal, with every fault named by field and rule. */
export interface FounderChatRefusal {
  reason: FounderChatRefusalReason;
  /** One line, for a log and for the panel. */
  said: string;
  faults: FounderActionFault[];
}

/** What one turn produced. */
export interface FounderChatAnswer {
  /** What the founder reads. Always something. */
  reply: string;
  /** The complete revised card, already measured against the register, or nothing. */
  patch: FounderActionFields | null;
  /** Why nothing may be applied, or nothing. */
  refusal: FounderChatRefusal | null;
}

/** The fence an offered revision arrives in. */
export const FOUNDER_CHAT_FENCE = 'founder-action';

/** The founder fields a chat may revise. */
export const FOUNDER_CHAT_PATCHABLE: readonly string[] = ['title', 'what', 'why', 'steps', 'confirm'];

const FENCED = new RegExp(`^[ \\t]*\`\`\`${FOUNDER_CHAT_FENCE}[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*\`\`\`[ \\t]*$`, 'gm');

const transcriptOf = (turns: readonly FounderChatMessage[]): string => {
  if (!Array.isArray(turns) || turns.length === 0) return 'Nothing yet — this is the first thing said.';
  return turns.map((turn) => `${turn.role === 'founder' ? 'Founder' : 'You'}: ${turn.text}`).join('\n\n');
};

/** The instruction for one chat turn about one founder action. */
export function founderChatPrompt(
  item: FounderChatItem,
  evidence: FounderActionEvidence | null | undefined,
  transcript: readonly FounderChatMessage[],
  message: string,
): string {
  const limits = FOUNDER_ACTION_LIMITS;
  return `You are answering a founder about one item on their board: a thing only a person can do.

The item, as this board holds it. Its key is \`${item.key}\` and its kind is \`${item.kind}\`.

${renderFounderAction(item.fields, evidence ?? undefined)}

The conversation so far:

${transcriptOf(transcript)}

The founder now says:

${message}

Answer the person in plain words. Short sentences, no jargon, and nothing about this
repository or about how the board works inside.

**Do not edit anything on GitHub.** Do not run \`gh issue create\`, \`gh issue edit\` or any
other write, do not comment anywhere, and do not touch a project item. You are answering a
question. The board is the only thing that changes the card.

If the item itself should now say something different, end your answer with **exactly one**
fenced block, like this:

\`\`\`${FOUNDER_CHAT_FENCE}
{ "key": "${item.key}", "steps": ["…", "…"] }
\`\`\`

- name only the fields you are changing, out of \`title\`, \`what\`, \`why\`, \`steps\` and
  \`confirm\`. Everything you leave out stays as it is;
- \`key\` names this item, spelled exactly as above. A block naming anything else is refused;
- \`kind\`, \`createdAt\`, \`evidence\` and the published item are not yours to change, and a
  block naming one of them is refused whole;
- **two blocks are refused**, and the first one is not taken: nothing here can tell which one
  you meant;
- the board merges your fields into the item and measures the whole card. \`title\` is at most
  ${limits.title} characters on one line and does not end in a full stop, \`what\` at most
  ${limits.what}, \`why\` at most ${limits.why}, \`confirm\` at most ${limits.confirm}; there are
  ${limits.minSteps} to ${limits.maxSteps} steps, each one sentence of at most ${limits.step}
  characters; no sentence runs past ${limits.sentenceWords} words; and the whole card is at most
  ${limits.body} characters. A revision that breaks one of those is refused and the founder still
  gets your answer.

If nothing about the item should change, write no block at all. That is the ordinary answer.`;
}

/** What the reader is told when the agent wrote a revision and nothing to read with it. */
const SILENT_WITH_BLOCK = 'The agent answered with a revision and nothing to read.';

/** And when it wrote nothing at all. Still a turn, so still a line. */
const SILENT = 'The agent answered with nothing at all.';

/** Every field the chat may not touch, whatever it puts in it. `key` is the identity, below. */
export const FOUNDER_CHAT_IMMUTABLE: readonly string[] =
  ['kind', 'createdAt', 'evidence', 'publishedItemId'];

const refuse = (
  reason: FounderChatRefusalReason,
  said: string,
  faults: FounderActionFault[],
): FounderChatRefusal => ({ reason, said, faults });

/** The prose, with the machine half taken out of it — a founder reads this, not the JSON. */
function replyIn(text: string, blocks: number): string {
  const prose = text.replace(FENCED, '').replace(/\n{3,}/g, '\n\n').trim();
  if (prose) return prose;
  return blocks > 0 ? SILENT_WITH_BLOCK : SILENT;
}

/**
 * The fields a block named, as founder fields, and every value that is not one.
 *
 * Written out rather than spread wholesale, because a spread is how a key nobody vetted reaches
 * a record: only the five names below can survive this, and everything else has already been
 * refused by the caller.
 */
function pickFields(
  block: Record<string, unknown>,
): { picked: Partial<FounderActionFields>; faults: FounderActionFault[] } {
  const picked: Partial<FounderActionFields> = {};
  const faults: FounderActionFault[] = [];

  for (const field of ['title', 'what', 'why', 'confirm'] as const) {
    if (!(field in block)) continue;
    const value = block[field];
    if (typeof value !== 'string') {
      faults.push({ field, rule: 'shape', detail: `a line of text was expected, and ${typeof value} arrived` });
      continue;
    }
    picked[field] = value;
  }

  if ('steps' in block) {
    const value = block.steps;
    if (!Array.isArray(value) || value.some((step) => typeof step !== 'string')) {
      faults.push({ field: 'steps', rule: 'shape', detail: 'a list of steps, each one a line of text, was expected' });
    } else {
      picked.steps = [...(value as string[])];
    }
  }

  return { picked, faults };
}

/**
 * Read what came back, and decide whether the board may apply any of it.
 *
 * The reply is always returned — the founder asked a question and deserves the answer, and a
 * refusal means the card does not change rather than that the turn failed.
 *
 * Everything else is a gate, in the order a wrong answer is cheapest to catch:
 *
 *  - **two blocks are refused whole, and the first one is not taken.** Guessing which one the
 *    agent meant is how a card ends up saying something nobody wrote;
 *  - **a block has to answer with the key it was given.** The same identity check the recreate
 *    route makes on the URL a rewrite came back with: verify the answer before believing it;
 *  - **`kind`, `createdAt`, `evidence` and the published item are not patchable**, and neither
 *    is any other name. A chat that could rewrite `kind` could re-point a card at a different
 *    probe and make a verification lie, and the evidence is the machine's record of what it saw
 *    rather than the conversation's to edit;
 *  - **the patch is measured as the merged whole, never as the patch alone.** Every rule that
 *    spans fields — the body ceiling, the step count, consecutive numbering — is only meaningful
 *    over the complete record, and a patch whose own contents are each legal can still produce a
 *    card that cannot be drawn.
 */
export function parseFounderChatAnswer(output: string, item: FounderChatItem): FounderChatAnswer {
  const text = typeof output === 'string' ? output : '';
  const blocks = [...text.matchAll(FENCED)].map((found) => found[1] ?? '');
  const reply = replyIn(text, blocks.length);
  const nothing = (refusal: FounderChatRefusal): FounderChatAnswer => ({ reply, patch: null, refusal });

  if (blocks.length === 0) return { reply, patch: null, refusal: null };

  if (blocks.length > 1) {
    return nothing(refuse('two-blocks',
      `The agent offered ${blocks.length} revisions of this item, so none of them was applied.`,
      [{ field: 'body', rule: 'one-block',
         detail: `${blocks.length} \`${FOUNDER_CHAT_FENCE}\` blocks came back and nothing can tell `
           + 'which one was meant' }]));
  }

  let block: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(blocks[0] ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the block is not a set of named fields');
    }
    block = parsed as Record<string, unknown>;
  } catch (error) {
    return nothing(refuse('unreadable',
      'The agent offered a revision that could not be read, so the item was left as it is.',
      [{ field: 'body', rule: 'unreadable', detail: (error as Error).message }]));
  }

  const named = typeof block.key === 'string' ? block.key.trim() : '';
  if (named !== item.key) {
    return nothing(refuse('wrong-key',
      'The agent revised a different item from the one it was asked about, so nothing was applied.',
      [{ field: 'key', rule: 'wrong-key',
         detail: named
           ? `the block names "${named}" and this item is "${item.key}"`
           : `the block names no item at all, and this one is "${item.key}"` }]));
  }

  const forbidden = Object.keys(block)
    .filter((field) => field !== 'key' && !FOUNDER_CHAT_PATCHABLE.includes(field))
    .map((field): FounderActionFault => ({
      field,
      rule: 'not-patchable',
      detail: FOUNDER_CHAT_IMMUTABLE.includes(field)
        ? `"${field}" is the machine's record of this item and is not the conversation's to change`
        : `"${field}" is not one of ${FOUNDER_CHAT_PATCHABLE.join(', ')}`,
    }));
  if (forbidden.length > 0) {
    return nothing(refuse('not-patchable',
      `The agent's revision named ${forbidden.map((fault) => fault.field).join(', ')}, which a `
      + 'chat may not change, so nothing was applied.',
      forbidden));
  }

  const { picked, faults: shape } = pickFields(block);
  if (shape.length === 0 && Object.keys(picked).length === 0) {
    return nothing(refuse('empty',
      'The agent offered a revision that changed nothing, so the item was left as it is.',
      [{ field: 'body', rule: 'empty-patch',
         detail: `the block named none of ${FOUNDER_CHAT_PATCHABLE.join(', ')}` }]));
  }

  // The merged whole, and never the patch alone: two fields that are each inside their own
  // ceiling can still render a card over the body ceiling, and the record is what a reader gets.
  const merged: FounderActionFields = { ...item.fields, ...picked };
  const faults = [...shape, ...validateFounderAction(merged).faults];
  if (faults.length > 0) {
    return nothing(refuse('register',
      `The agent's revision would have broken ${faults.length} rule(s) of this column, so the `
      + 'item was left as it is.',
      faults));
  }

  return { reply, patch: merged, refusal: null };
}
