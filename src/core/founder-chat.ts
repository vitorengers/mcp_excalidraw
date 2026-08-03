/**
 * What a founder chat turn *says* to the agent, before anything is spawned.
 *
 * The founder types "which plan should I buy?", "is the free tier enough?", "I did it, what
 * now?" at a card that names a blocker only a person can clear, and one agent run answers it.
 * This module composes the prompt for that run and does nothing else: it spawns nothing, reads
 * no file, asks GitHub nothing, and imports nothing from `founder-store.ts` — the transcript
 * arrives as a shape rather than as that module's record, so a browser could compose the same
 * text if it ever had to.
 *
 * **The boundary in the last paragraph is prose, and it is not the enforcement.** It says the
 * agent may not file or edit anything on GitHub because an agent told nothing at all will
 * cheerfully open a tracking issue for a question about a payment card. What actually holds the
 * line is the narrowed allow-list `runFounderChatAgent` gives the invocation, and a board whose
 * posture cannot be narrowed refuses the turn rather than running it. Saying it twice is
 * deliberate: the prose stops the agent from *trying*, and the argv stops it from *succeeding*.
 *
 * **What is deliberately not here yet is the answer half.** `parseFounderChatAnswer` — the
 * fenced `founder-action` block, the identity check on the key, and the merged-whole validation
 * that decides whether the card may change — belongs to the issue that owns this file's other
 * half, and until it exists this prompt asks for prose and asks for no block. A prompt that
 * invited a patch nobody parses would be an instruction with nothing behind it.
 */
import type { FounderActionEvidence, FounderActionFields } from './founder-action-text.js';

/**
 * The item under discussion: its key, and what the card says.
 *
 * The key travels beside the fields rather than inside them because it is not one — it is
 * `founderActionKey`'s composition, the thing four producers agree on without having heard of
 * one another, and the prompt has to name it so that an answer about *this* card can be told
 * from an answer about another one.
 */
export interface FounderChatItem {
  key: string;
  fields: FounderActionFields;
}

/**
 * One turn of the conversation so far, as this module needs it.
 *
 * Structural rather than `FounderChatTurn` imported from the store: the store is a file on
 * disk and this module is pure. Two shapes that match are cheaper than the import that would
 * make this module unusable anywhere the store cannot be read.
 */
export interface FounderChatMessage {
  role: 'founder' | 'agent';
  text: string;
  at?: string;
}

/** What each side is called in the transcript the agent reads. */
const SPEAKER: Record<FounderChatMessage['role'], string> = {
  founder: 'Founder',
  agent: 'You',
};

/**
 * The instructions, which are the same for every turn and every card.
 *
 * Written for the reader the card is written for — somebody with a payment card and ten
 * minutes — because an agent that has read this repository's own documentation will otherwise
 * answer in the register every example in front of it is written in.
 */
const FOUNDER_CHAT_PROMPT = `You are answering one question from the person this board is
blocked on. They are not an engineer on this project. They have a card in front of them naming
something only a human being can do — a payment, a sign-in, a permission — and they have asked
you about it.

Answer them, in plain words, in a few sentences. Say the thing to do rather than the thing to
know. Where the answer depends on something you cannot see, say what you would need and how
they could tell you, rather than guessing.

You may read: this repository, the web, and what the card says below. You may not file, edit,
comment on or close anything on GitHub, and you may not change this card. That is not a
formality about tone — the run you are in has had those commands taken off it, so an attempt
would be refused rather than obeyed, and an answer that promised one would be a promise nobody
can keep. If what they are asking for needs an issue opened, say so and let a person decide.`;

/** One card field, or nothing at all when it is empty — an empty heading reads as a mistake. */
function paragraph(heading: string, text: string): string {
  return text.trim() ? `\n\n${heading}\n${text.trim()}` : '';
}

/** What the machine saw, which is exempt from every rule the founder's own text is held to. */
function evidenceSection(evidence: FounderActionEvidence | null | undefined): string {
  const rows = [
    evidence?.command ? `Command: ${evidence.command}` : '',
    evidence?.said ? `It said: ${evidence.said}` : '',
    evidence?.source ? `Classified in: ${evidence.source}` : '',
  ].filter(Boolean);
  return rows.length ? `\n\nWhat this board saw, in its own words:\n${rows.join('\n')}` : '';
}

/** The conversation so far, oldest first, or a note that there is none. */
function transcriptSection(transcript: readonly FounderChatMessage[]): string {
  if (!transcript.length) return '\n\nThis is the first thing they have asked about this card.';
  const said = transcript
    .filter((turn) => turn.text.trim())
    .map((turn) => `${SPEAKER[turn.role] ?? turn.role}: ${turn.text.trim()}`)
    .join('\n\n');
  return said ? `\n\nWhat has been said about it so far, oldest first:\n\n${said}` : '';
}

/**
 * The whole prompt for one turn.
 *
 * The founder's own message goes last, after everything that is context for it, for the reason
 * `runIssueAgent` puts the images last: the thing being answered should be the final thing said,
 * not a line somewhere in the middle of a page of background.
 */
export function founderChatPrompt(
  item: FounderChatItem,
  evidence: FounderActionEvidence | null | undefined,
  transcript: readonly FounderChatMessage[],
  message: string
): string {
  const { key, fields } = item;
  const steps = fields.steps.length
    ? `\n\nWhat it asks them to do:\n${fields.steps.map((step, at) => `${at + 1}. ${step}`).join('\n')}`
    : '';

  return `${FOUNDER_CHAT_PROMPT}

---

The card they are asking about is ${key}.

Title: ${fields.title}`
    + paragraph('What is the matter:', fields.what)
    + paragraph('Why no machine here can do it instead:', fields.why)
    + steps
    + paragraph('How they will know it worked:', fields.confirm)
    + evidenceSection(evidence)
    + transcriptSection(transcript)
    + `\n\n---\n\nWhat they have just asked:\n\n${message.trim()}`;
}
