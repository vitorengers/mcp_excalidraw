/**
 * Where a founder action lives between the moment it is noticed and the moment it is done.
 *
 * First cut: one map, held in this module, the way `core/implement-state.ts` holds a run.
 *
 * Everything about the *record* is here — the register enforced at the write, the key that
 * makes four producers leave one card, the chat kept apart from the card text — and nothing
 * about surviving a restart is. That half is the next commit, and this one exists so the check
 * that asks for it is red for the reason it names rather than for a missing export.
 */
import path from 'path';
import { boardStateDir } from './board-state.js';
import { normalizeWorkspaceId } from './element-store.js';
import {
  FOUNDER_ACTION_KINDS,
  FounderActionEvidence,
  FounderActionFault,
  FounderActionFields,
  FounderActionKind,
  validateFounderAction,
} from './founder-action-text.js';

/**
 * Where a record is in its life.
 *
 * `resolved` is the blocker being gone — the probe that noticed it no longer notices it, or a
 * person said they had done it. `dismissed` is a person saying it is not worth doing. Neither
 * is deleted: a column that forgets what it asked for asks for it again next week.
 */
export type FounderActionState = 'open' | 'resolved' | 'dismissed';

/** Who settled it: this board's own re-probe, or the person the card was written for. */
export type FounderActionResolver = 'probe' | 'person';

/**
 * One turn of the conversation about a blocker.
 *
 * **Not register-validated, and that is deliberate.** The founder types what they like and the
 * agent answers in prose in a panel; only card *fields* go through `validateFounderAction`.
 * Conflating the two is the obvious mistake — it would refuse the founder's own sentence for
 * being 26 words long, and refuse the agent's answer for quoting the stderr that explains
 * everything.
 */
export interface FounderChatTurn {
  role: 'founder' | 'agent';
  /** Whatever was said, kept exactly as it was said. */
  text: string;
  /** When, ISO. Stamped here when the caller does not supply one. */
  at: string;
}

/** A founder action as it is stored. */
export interface FounderActionRecord {
  /** `<workspaceId>:<kind>[:<discriminator>]`, composed by `founderActionKey`. */
  key: string;
  kind: FounderActionKind;
  workspaceId: string;
  fields: FounderActionFields;
  /** What the machine saw. Empty rather than absent, so a reader never has to test for it. */
  evidence: FounderActionEvidence;
  state: FounderActionState;
  createdAt: string;
  /** The last time a producer noticed this blocker, which is what the dedupe moves. */
  lastSeenAt: string;
  resolvedAt?: string;
  resolvedBy?: FounderActionResolver;
  /** The GitHub project draft item this was published as, once #540 publishes one. */
  publishedItemId?: string;
  chat: FounderChatTurn[];
}

/** What a producer hands over when it notices a blocker. */
export interface FounderActionNotice {
  workspaceId: string;
  kind: FounderActionKind;
  /**
   * What makes two blockers of the same kind two blockers — an account, a repository.
   *
   * Left out for the ordinary case, which is that a kind happens to a board once: one signed
   * out `gh` is one card however many things trip over it.
   */
  discriminator?: string;
  fields: FounderActionFields;
  evidence?: FounderActionEvidence;
}

/** What came of a write: the record, or every rule it broke. */
export interface FounderActionWrite {
  ok: boolean;
  record: FounderActionRecord | null;
  faults: FounderActionFault[];
}

/** A turn as a caller offers it, before it is stamped. */
export interface FounderChatTurnInput {
  role: 'founder' | 'agent';
  text: string;
  at?: string;
}

/**
 * The key, composed here rather than typed by a producer.
 *
 * **The key is the dedupe, and the dedupe is the point.** One logged-out `gh` is discovered by
 * the twenty-second project poll, by the issue panel, by the queue's dependency reads and by
 * every implement start. Every suppression this product had before was per surface and
 * transient — a ref on one component, a thirty-second memo on another — and none of it was
 * something a *different* producer could reuse. This is: four producers that noticed the same
 * thing compose the same string without having heard of one another.
 */
export function founderActionKey(
  workspaceId: string,
  kind: FounderActionKind,
  discriminator?: string
): string {
  const id = normalizeWorkspaceId(workspaceId);
  const tail = discriminator?.trim();
  return tail ? `${id}:${kind}:${tail}` : `${id}:${kind}`;
}

/** The file one workspace's records are kept in, or nothing when there is nowhere to keep them. */
export function founderActionsFile(workspaceId: string): string | null {
  const directory = boardStateDir();
  if (!directory) return null;
  return path.join(directory, `${normalizeWorkspaceId(workspaceId)}.founder-actions.json`);
}

/** One map per workspace: two projects can be blocked by the same thing at the same time. */
const byWorkspace = new Map<string, Map<string, FounderActionRecord>>();

function forWorkspace(workspaceId: string): Map<string, FounderActionRecord> {
  const id = normalizeWorkspaceId(workspaceId);
  let records = byWorkspace.get(id);
  if (!records) {
    records = new Map<string, FounderActionRecord>();
    byWorkspace.set(id, records);
  }
  return records;
}

/** A kind outside the register has no founder-readable text to draw, so it is not a record. */
function kindFault(kind: FounderActionKind): FounderActionFault[] {
  if (FOUNDER_ACTION_KINDS.includes(kind)) return [];
  return [{
    field: 'kind',
    rule: 'known-kind',
    detail: `"${String(kind)}" is not one of ${FOUNDER_ACTION_KINDS.join(', ')}`,
  }];
}

/**
 * Notice a blocker.
 *
 * The register is enforced here, and this is the only door: a record whose fields
 * `validateFounderAction` refuses is not stored at all, and the fault list comes back instead
 * of the text going in. A producer that wants to say something has to say it in a field.
 *
 * An existing key moves `lastSeenAt` and nothing else. Not the fields, which is the case worth
 * stating: the first producer to notice a blocker wrote the card, and the fourth one noticing
 * it half a second later must not rewrite the card under a reader's cursor.
 */
export function recordFounderAction(notice: FounderActionNotice): FounderActionWrite {
  const faults = [...kindFault(notice.kind), ...validateFounderAction(notice.fields).faults];
  if (faults.length > 0) return { ok: false, record: null, faults };

  const id = normalizeWorkspaceId(notice.workspaceId);
  const key = founderActionKey(id, notice.kind, notice.discriminator);
  const now = new Date().toISOString();
  const records = forWorkspace(id);

  const existing = records.get(key);
  if (existing) {
    existing.lastSeenAt = now;
    return { ok: true, record: existing, faults: [] };
  }

  const record: FounderActionRecord = {
    key,
    kind: notice.kind,
    workspaceId: id,
    fields: notice.fields,
    evidence: notice.evidence ?? {},
    state: 'open',
    createdAt: now,
    lastSeenAt: now,
    chat: [],
  };
  records.set(key, record);
  return { ok: true, record, faults: [] };
}

/** One record by its key, or nothing. */
export function readFounderAction(workspaceId: string, key: string): FounderActionRecord | null {
  return forWorkspace(workspaceId).get(key) ?? null;
}

/** Everything this workspace has ever recorded, settled or not, oldest first. */
export function listFounderActions(workspaceId: string): FounderActionRecord[] {
  return [...forWorkspace(workspaceId).values()];
}

/** The ones still asking for something. */
export function openFounderActions(workspaceId: string): FounderActionRecord[] {
  return listFounderActions(workspaceId).filter((record) => record.state === 'open');
}

/**
 * Settle a record, and say who settled it.
 *
 * A record that is already settled is left exactly as it was settled: the first settlement is
 * the one that happened, and re-opening is #545's rule to write once it has real callers.
 */
export function resolveFounderAction(
  workspaceId: string,
  key: string,
  by: FounderActionResolver
): FounderActionRecord | null {
  const record = readFounderAction(workspaceId, key);
  if (!record) return null;
  if (record.state !== 'open') return record;

  record.state = 'resolved';
  record.resolvedAt = new Date().toISOString();
  record.resolvedBy = by;
  return record;
}

/** Put a record away without claiming the blocker is gone. Always a person's decision. */
export function dismissFounderAction(workspaceId: string, key: string): FounderActionRecord | null {
  const record = readFounderAction(workspaceId, key);
  if (!record) return null;
  if (record.state !== 'open') return record;

  record.state = 'dismissed';
  record.resolvedAt = new Date().toISOString();
  record.resolvedBy = 'person';
  return record;
}

/**
 * Add a turn to a record's conversation.
 *
 * Nothing here is measured against the register. See `FounderChatTurn`: the card is fields and
 * the chat is prose, and only one of them is drawn as a card.
 */
export function appendChatTurn(
  workspaceId: string,
  key: string,
  turn: FounderChatTurnInput
): FounderActionRecord | null {
  const record = readFounderAction(workspaceId, key);
  if (!record) return null;

  record.chat.push({ role: turn.role, text: turn.text, at: turn.at ?? new Date().toISOString() });
  return record;
}
