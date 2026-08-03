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

/**
 * Read what came back.
 *
 * A plain merge, for the moment: whatever the block names is put over the item's fields and
 * handed back. Nothing here counts the blocks, checks the key, or measures the result.
 */
export function parseFounderChatAnswer(output: string, item: FounderChatItem): FounderChatAnswer {
  const text = typeof output === 'string' ? output : '';
  const blocks = [...text.matchAll(FENCED)].map((found) => found[1]);
  const reply = text.replace(FENCED, '').replace(/\n{3,}/g, '\n\n').trim()
    || 'The agent answered with nothing to read.';

  if (blocks.length === 0) return { reply, patch: null, refusal: null };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(blocks[0] ?? '') as Record<string, unknown>;
  } catch {
    return { reply, patch: null, refusal: null };
  }

  const { key, ...rest } = parsed;
  void key;
  return { reply, patch: { ...item.fields, ...rest } as FounderActionFields, refusal: null };
}
