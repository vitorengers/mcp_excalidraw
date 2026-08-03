/**
 * Where a founder action lives between the moment it is noticed and the moment it is done.
 *
 * ## Why this one is written down when a run is not
 *
 * `core/implement-state.ts` holds its runs in a plain map and the repository accepts that,
 * because a run cannot survive its server: what persists is the worktree, and the map is an
 * inference read back off git at startup. A founder block is the other shape. The credit is
 * still missing after a restart, the sign-in is still expired, and nothing on disk anywhere
 * says a person was asked. A record held only in memory would therefore re-file the same card
 * on every boot and lose every Done a person had already given it — the two failures that make
 * a column of human work unusable rather than merely thin.
 *
 * One JSON file per workspace, under `boardStateDir()`, written the way `flushBoards` writes a
 * board: into a temporary file, then renamed over the old one. A crash halfway through a plain
 * write would leave half a document, and half a document read at the next start loses every
 * record rather than the one being written.
 *
 * ## The key is the dedupe, and it is the point
 *
 * One logged-out `gh` is discovered by the twenty-second project poll, by the issue panel, by
 * the queue's dependency reads and by every implement start. The suppression that existed
 * before was per surface and transient — a ref on one component, a thirty-second memo on
 * another — and none of it was a key a *different* producer could reuse. `founderActionKey`
 * is: four producers that noticed the same thing compose the same string without having heard
 * of one another, and the second, third and fourth of them move `lastSeenAt` and nothing else.
 *
 * ## Two paths, and only one of them is measured
 *
 * `recordFounderAction` refuses anything `validateFounderAction` refuses and hands back the
 * fault list rather than storing bad text. That is the only door into the card, so the register
 * is enforced at the write and never by inspection.
 *
 * `appendChatTurn` is **not** register-validated, deliberately: the founder types what they
 * like and the agent's reply is prose in a panel rather than card text. A stack trace and the
 * last 300 characters of somebody's stderr belong in a turn and are stored exactly as they
 * arrived. Sending the chat through the validator is the obvious mistake — it would refuse the
 * founder's own sentence for being 26 words long.
 *
 * ## What this file deliberately does not decide
 *
 * Retention, and what happens when a settled blocker comes back: those are #545's, because
 * they need real callers before they can be written against what those callers do. The only
 * rule here for a settled key is that it is **left settled**.
 */
import path from 'path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import logger from '../utils/logger.js';
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
 * **Not register-validated, and that is deliberate.** See the note at the top of this file:
 * only card fields go through `validateFounderAction`.
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
  /** The GitHub project draft item this was published as. Written by `core/founder-publish.ts`. */
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

/** What is in the file: a named document rather than a bare list, so a reader can tell. */
interface FounderActionDocument {
  type: 'founder-actions';
  version: number;
  workspaceId: string;
  savedAt: string;
  actions: FounderActionRecord[];
}

const DOCUMENT_TYPE = 'founder-actions';
const DOCUMENT_VERSION = 1;

/**
 * How many times a rename is retried, and how long it waits between attempts.
 *
 * On Windows a rename over a file another process has open fails with `EPERM`, and this file is
 * one a board polls: the panel that draws the column reads it, and the producers write it. A
 * write that gave up there would lose the record it was landing, so the rename is retried for
 * a fraction of a second before the failure is believed. The alternative — writing in place —
 * is what the temporary file exists to avoid.
 *
 * Measured rather than guessed: with a second process reading this file in a loop with no
 * pause in it at all, which is harder than anything real does, eight attempts five milliseconds
 * apart still lost a write. Two hundred and forty milliseconds of trying is the width at which
 * that stopped happening, and it is spent only on the collision.
 */
const RENAME_ATTEMPTS = 30;
const RENAME_PAUSE_MS = 8;

/** One map per workspace: two projects can be blocked by the same thing at the same time. */
const byWorkspace = new Map<string, Map<string, FounderActionRecord>>();

/**
 * Which workspaces have been read off disk already.
 *
 * Separate from the map above, because "no records" and "not looked yet" are different
 * answers and an empty map is the first of them. Read once per workspace per process: this
 * board is the one writing the file, and a re-read on every call would make every list a
 * disk read on a twenty-second poll.
 */
const loaded = new Set<string>();

/** Said once, however many boards have nowhere to write. */
let warnedAboutDirectory = false;

/**
 * The key, composed here rather than typed by a producer.
 *
 * The workspace is normalised the same way the file name is, so a producer that spells its
 * board id in capitals and one that does not compose the same key rather than two.
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

/**
 * The file one workspace's records are kept in, or nothing when there is nowhere to keep them.
 *
 * Beside the saved boards, for the reason `board-state.ts` gives for putting them there: a
 * workspace id is unique within a registry and nowhere else, so following the registry is what
 * keeps every self-contained check in `scripts/` out of the real board's records without one
 * of them having to know this feature exists.
 */
export function founderActionsFile(workspaceId: string): string | null {
  const directory = boardStateDir();
  if (!directory) return null;
  return path.join(directory, `${normalizeWorkspaceId(workspaceId)}.founder-actions.json`);
}

/**
 * Nowhere to write, said once.
 *
 * `boardStateDir()` returns `string | null` and its own comment says null is reachable. A board
 * must still start: the store degrades to memory, every door goes on answering, and the one
 * thing that is lost — surviving a restart — is the thing the operator is told about.
 */
function warnAboutDirectory(): void {
  if (warnedAboutDirectory) return;
  warnedAboutDirectory = true;
  logger.warn('Founder actions have nowhere to be saved: this canvas resolved no board state '
    + 'directory. They will be remembered for as long as this process runs and no longer.');
}

/** A copy, so nothing a caller is handed is the store's own object. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Whether something read out of a file is a record rather than whatever else was in there. */
function usable(record: unknown): record is FounderActionRecord {
  const candidate = record as Partial<FounderActionRecord> | null;
  return Boolean(candidate) && typeof candidate?.key === 'string' && Boolean(candidate.key);
}

/**
 * The records in a workspace's file, or none.
 *
 * A truncated, empty or non-JSON file is **not** an error a caller has to handle: it reads as
 * no records, with a warning naming the file, and the next write replaces it. The alternative
 * is a board that will not start because something it never showed anybody is malformed.
 *
 * A record is not re-validated on the way in. The register is enforced at the write and a
 * record that was accepted once stays readable — re-reading it against today's rules would
 * empty somebody's column the day a limit was tightened.
 */
function loadWorkspace(id: string): Map<string, FounderActionRecord> {
  const records = new Map<string, FounderActionRecord>();

  const file = founderActionsFile(id);
  if (!file) {
    warnAboutDirectory();
    return records;
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (error) {
    // Nothing saved is the ordinary case: a board nobody was ever blocked on has no file.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`Founder actions for "${id}" at ${file} were not read: ${(error as Error).message}`);
    }
    return records;
  }

  try {
    const document = JSON.parse(raw) as Partial<FounderActionDocument>;
    if (!Array.isArray(document?.actions)) throw new Error('there is no list of records in it');
    for (const record of document.actions) {
      if (usable(record)) records.set(record.key, record);
    }
  } catch (error) {
    records.clear();
    logger.warn(`Founder actions for "${id}" at ${file} were not read: ${(error as Error).message}. `
      + 'Starting from none, and the next one recorded replaces the file.');
  }
  return records;
}

function forWorkspace(workspaceId: string): Map<string, FounderActionRecord> {
  const id = normalizeWorkspaceId(workspaceId);
  let records = byWorkspace.get(id);
  if (!records || !loaded.has(id)) {
    records = loadWorkspace(id);
    byWorkspace.set(id, records);
    loaded.add(id);
  }
  return records;
}

/**
 * The rename, retried for a moment before its failure is believed.
 *
 * See `RENAME_ATTEMPTS`. Synchronous throughout, because the whole write is: a producer that
 * has recorded a blocker and answered has to have it on disk, and there is no version of this
 * that awaits inside a `process.on('exit')` handler.
 */
function renameOver(from: string, to: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const busy = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!busy || attempt >= RENAME_ATTEMPTS) throw error;
      Atomics.wait(pause, 0, 0, RENAME_PAUSE_MS);
    }
  }
}

/**
 * Write one workspace's records out now, atomically.
 *
 * The only place in this module that touches the file, which is what makes the eight doors the
 * only way in: everything else changes the map and asks this to land it.
 */
function saveWorkspace(id: string, records: Map<string, FounderActionRecord>): void {
  const file = founderActionsFile(id);
  if (!file) {
    warnAboutDirectory();
    return;
  }

  const document: FounderActionDocument = {
    type: DOCUMENT_TYPE,
    version: DOCUMENT_VERSION,
    workspaceId: id,
    savedAt: new Date().toISOString(),
    actions: [...records.values()],
  };

  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, 'utf-8');
    renameOver(temporary, file);
  } catch (error) {
    logger.warn(`Founder actions for "${id}" were not saved to ${file}: ${(error as Error).message}`);
  }
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
 * it half a second later must not rewrite the card under a reader's cursor. Not the state
 * either — a settled key is left settled.
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
    saveWorkspace(id, records);
    return { ok: true, record: copy(existing), faults: [] };
  }

  const record: FounderActionRecord = {
    key,
    kind: notice.kind,
    workspaceId: id,
    fields: copy(notice.fields),
    evidence: copy(notice.evidence ?? {}),
    state: 'open',
    createdAt: now,
    lastSeenAt: now,
    chat: [],
  };
  records.set(key, record);
  saveWorkspace(id, records);
  return { ok: true, record: copy(record), faults: [] };
}

/** One record by its key, or nothing. A copy: the file is written only through these doors. */
export function readFounderAction(workspaceId: string, key: string): FounderActionRecord | null {
  const record = forWorkspace(workspaceId).get(key);
  return record ? copy(record) : null;
}

/** Everything this workspace has ever recorded, settled or not, oldest first. */
export function listFounderActions(workspaceId: string): FounderActionRecord[] {
  return [...forWorkspace(workspaceId).values()].map(copy);
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
  const id = normalizeWorkspaceId(workspaceId);
  const records = forWorkspace(id);
  const record = records.get(key);
  if (!record) return null;
  if (record.state !== 'open') return copy(record);

  record.state = 'resolved';
  record.resolvedAt = new Date().toISOString();
  record.resolvedBy = by;
  saveWorkspace(id, records);
  return copy(record);
}

/** Put a record away without claiming the blocker is gone. Always a person's decision. */
export function dismissFounderAction(workspaceId: string, key: string): FounderActionRecord | null {
  const id = normalizeWorkspaceId(workspaceId);
  const records = forWorkspace(id);
  const record = records.get(key);
  if (!record) return null;
  if (record.state !== 'open') return copy(record);

  record.state = 'dismissed';
  record.resolvedAt = new Date().toISOString();
  record.resolvedBy = 'person';
  saveWorkspace(id, records);
  return copy(record);
}

/**
 * Remember which draft item on the project this record was published as.
 *
 * A door of its own rather than a field a publisher could set on the record it was handed,
 * because the record a caller holds is a **copy** — writing through it would change nothing on
 * disk, and the next start would file the same card again. That is the failure this whole file
 * exists to prevent, so the id lands the same way every other change does.
 *
 * The first id wins. A record that already carries one is left exactly as it is: a second id
 * would mean two draft items exist for one blocker, and forgetting the first is what would make
 * the second one possible. `core/founder-publish.ts` reads this before it spawns anything.
 */
export function markFounderActionPublished(
  workspaceId: string,
  key: string,
  itemId: string
): FounderActionRecord | null {
  const id = normalizeWorkspaceId(workspaceId);
  const records = forWorkspace(id);
  const record = records.get(key);
  if (!record) return null;
  if (record.publishedItemId) return copy(record);

  record.publishedItemId = itemId;
  saveWorkspace(id, records);
  return copy(record);
}

/**
 * Replace a record's fields with a revision that has already been agreed.
 *
 * The one door that changes what a card *says* after it has been written, and it exists because
 * a chat turn can end in "I did it, what now?" — an answer that is worth nothing if the steps in
 * front of the reader still describe what they have already done.
 *
 * **The register is enforced here, exactly as it is at `recordFounderAction`.** That is the whole
 * of why this is a door and not a field a caller could set: a revision arrives from a coding
 * agent's output, which is the least trustworthy text this file will ever be offered, and a store
 * that took it on the caller's word would put the validator behind an `if` somebody can forget.
 * The fields are read as the merged whole they are, and a record that fails is not written at all.
 *
 * Nothing else moves. Not `kind`, which is what the verifier re-probes against; not `createdAt`,
 * `evidence` or `publishedItemId`, which are the machine's record of what happened; and not the
 * state, because a revision is a card saying something different rather than a card being done.
 */
export function reviseFounderAction(
  workspaceId: string,
  key: string,
  fields: FounderActionFields
): FounderActionWrite {
  const id = normalizeWorkspaceId(workspaceId);
  const records = forWorkspace(id);
  const record = records.get(key);
  if (!record) return { ok: false, record: null, faults: [] };

  const { faults } = validateFounderAction(fields);
  if (faults.length > 0) return { ok: false, record: copy(record), faults };

  record.fields = copy(fields);
  saveWorkspace(id, records);
  return { ok: true, record: copy(record), faults: [] };
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
  const id = normalizeWorkspaceId(workspaceId);
  const records = forWorkspace(id);
  const record = records.get(key);
  if (!record) return null;

  record.chat.push({ role: turn.role, text: turn.text, at: turn.at ?? new Date().toISOString() });
  saveWorkspace(id, records);
  return copy(record);
}
