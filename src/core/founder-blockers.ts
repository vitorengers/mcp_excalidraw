/**
 * The human blockers this product already detects, named.
 *
 * Ten conditions were being detected and then merely refused. A missing `gh`, a logged-out
 * one, a token without the `project` scope, a credential GitHub turned down, a rate limit, a
 * billing refusal, an account that may not push, a coding agent that is not installed, one
 * nothing was ever granted for, and a usage window that has been spent. Every one of them
 * already carried finished remedy text somewhere — `REMEDY` in `gh.ts`, `pushRefusal` in
 * `github-push.ts`, the preflight lines — and every one of them ended as a sentence
 * somewhere a founder does not look.
 *
 * This module turns each into a named condition with a stable key, and composes the founder
 * action for it out of `FOUNDER_ACTION_CORPUS`. It is **pure**: it spawns nothing, stores
 * nothing and files nothing. What it is handed is what somebody else's probe already
 * answered.
 *
 * **`said` never crosses into a founder field.** `TerminalGhFailure` glues the stderr tail
 * and the remedy into `message` on purpose, so that a `catch` reading `.message` still
 * carries the remedy — which is exactly why raw stderr reaches the canvas today. So nothing
 * here reads `.message` at all: `said` and `remedy` are separate fields on that error and
 * are read separately. `said` goes to the evidence, where the register exempts it from every
 * rule; `remedy` picks the kind, whose steps are already written for a reader.
 *
 * **A probe that cannot say produces nothing.** `readPushAccess` is deliberately permissive —
 * only a permission GitHub explicitly stated as non-pushing refuses a run, and every failure
 * to learn is `unknown`. That rule generalises here: `verdict: 'unknown'` yields null, an
 * environment the preflight could not probe yields null, and a limits reading older than
 * `STALE_AFTER_SECONDS` yields null. Without it the column fills with cards about a bad
 * network minute, and a column like that is one a founder stops reading.
 *
 * **The full-access posture warning is not a blocker.** `postureLines` in
 * `agent-preflight.ts` warns that a command line grants every permission there is. It is
 * human-only and actionable and it never blocks a run — the board works perfectly with it —
 * so it has no kind here and produces nothing. Admit advice and the column fills with
 * advice, which is the one thing that would make the founder column worth ignoring.
 *
 * **Not type-only, unlike `founder-verify.ts`.** This half names `REMEDY` and
 * `classifyGhFailure` as values, because the alternative is a second copy of sentences that
 * have already drifted once (#534). That makes it a server-side module; the frontend reads
 * `founder-action-text.ts` and `founder-verify.ts`, which import nothing that spawns.
 *
 * `scripts/check-founder-blockers.mjs` holds all of it.
 */
import { STALE_AFTER_SECONDS } from './agent-limits.js';
import { classifyGhFailure, REMEDY } from './gh.js';
import {
  FOUNDER_ACTION_CORPUS,
  FounderActionEvidence,
  FounderActionFields,
  FounderActionKind,
  validateFounderAction,
} from './founder-action-text.js';
import type { AgentEnvironmentKind, AgentResolution } from './agent-preflight.js';
import type { AgentLimitsReading, AgentRole } from './agent-adapter.js';
import type { GithubStatus } from './github-status.js';
import type { PushAccess } from './github-push.js';

/**
 * The facts about one run that a corpus entry has a place for.
 *
 * The corpus names no account, repository or machine, deliberately: those are facts about a
 * run and a register entry is not. These are how they get in — five named holes, filled from
 * what the probe answered, and nothing else.
 */
export type FounderHole = 'repository' | 'permission' | 'binary' | 'environment' | 'variable';

/** One condition, as a producer hands it on. */
export interface FounderBlocker {
  kind: FounderActionKind;
  /**
   * What makes two sightings the same sighting.
   *
   * Stable across calls and across detectors: one missing `gh` is one key whether the
   * failure classifier or the preflight noticed it. The agent kinds carry the role and the
   * environment, because a board really can have the implement agent missing in a distro and
   * the issue agent answering on the host.
   */
  key: string;
  /**
   * The half of the key that is not the kind, or absent where the kind is the whole of it.
   *
   * The same thing `founderActionKey` in `founder-store.ts` calls a discriminator, and it is
   * held separately for that reason: the store composes its own key with the workspace in
   * front, so a producer that has to split this one back apart is a producer that will split
   * it wrong. `key` is what those two compose to without a board in front of it.
   */
  discriminator?: string;
  /** What this run knew, for the holes above. Absent where the condition has none. */
  named: Partial<Record<FounderHole, string>>;
  /** What the machine saw. Exempt from every register rule, and the only home for stderr. */
  evidence: FounderActionEvidence;
}

/**
 * One role in one environment, as `preflightAgents` answered for it.
 *
 * The same four things `preflightLines` already holds when it writes its warning — the role,
 * where it looked, the setting that would grant a command there, and argv[0] of the command
 * it probed. `binary` is argv[0] and never the command line: an operator's permission flags
 * are not a fact a founder needs and not one this module will carry.
 */
export interface AgentPreflightEntry {
  role: AgentRole;
  environment: AgentEnvironmentKind;
  /** `EXCALIDRAW_IMPLEMENT_AGENT` and friends, spelled as the board spells them. */
  variable: string;
  /** The binary the preflight probed, or null where nothing was granted to probe. */
  binary: string | null;
  resolved: AgentResolution;
}

/**
 * When a usage window counts as spent.
 *
 * A hundred per cent, and nothing softer. A founder action filed at ninety is a card about
 * something that has not happened yet, and the reader cannot act on it: there is nothing to
 * buy and nothing to wait for until the window is actually refusing runs.
 */
export const AGENT_USAGE_SATURATED_PERCENT = 100;

/** As much of what a tool said as `runGh` itself keeps. */
const EVIDENCE_TAIL = 300;

/** How each environment reads in a sentence written for a person. */
const ENVIRONMENT_NAMED: Record<AgentEnvironmentKind, string> = {
  native: 'this machine',
  wsl: 'the WSL distro',
};

/**
 * The remedy each kind answers, in the order the classifier ranks them.
 *
 * Keyed on the sentence rather than on a pattern of our own: `classifyGhFailure` is the
 * policy, `REMEDY` is what it hands back, and a second table of regular expressions here
 * would be the same failure read two ways. `startsWith` because a rate limit appends the
 * seconds GitHub asked for.
 *
 * `REMEDY.target` and `REMEDY.none` are deliberately absent. A URL nobody can resolve is a
 * question about what was typed rather than a blocker only a founder can clear, and there is
 * no register entry for it.
 */
const KIND_BY_REMEDY: ReadonlyArray<readonly [string, FounderActionKind]> = [
  [REMEDY.install, 'gh-missing'],
  [REMEDY.login, 'gh-login'],
  [REMEDY.scope, 'gh-scope'],
  [REMEDY.credential, 'gh-credential'],
  [REMEDY.billing, 'gh-billing'],
  [REMEDY.wait, 'gh-rate-limit'],
];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const tail = (said: string): string => said.slice(-EVIDENCE_TAIL);

function kindForRemedy(remedy: string): FounderActionKind | null {
  const sentence = remedy.trim();
  if (!sentence) return null;
  for (const [remedied, kind] of KIND_BY_REMEDY) {
    if (remedied && sentence.startsWith(remedied)) return kind;
  }
  return null;
}

const blocker = (
  kind: FounderActionKind,
  discriminator: string | undefined,
  named: Partial<Record<FounderHole, string>>,
  evidence: FounderActionEvidence,
): FounderBlocker => {
  const tail = discriminator?.trim();
  const found: FounderBlocker = { kind, key: tail ? `${kind}:${tail}` : kind, named, evidence };
  if (tail) found.discriminator = tail;
  return found;
};

/** Only what was actually said. An evidence field of `''` promises a reader something. */
function evidenceOf(said: string, source: string, command?: string): FounderActionEvidence {
  const evidence: FounderActionEvidence = { source };
  if (said.trim()) evidence.said = tail(said.trim());
  if (command?.trim()) evidence.command = command.trim();
  return evidence;
}

/**
 * The condition behind one failing `gh`, or null.
 *
 * What `runGh` throws is either a `TerminalGhFailure`, which carries `said` and `remedy` in
 * fields of its own, or a plain `Error` for a failure a retry might have cleared — a rate
 * limit is the one that matters, because it is a founder blocker that is deliberately not
 * terminal. So a caller that kept what `gh` said may hand over `{ said }` alone and the
 * classification is taken here, through the product's own classifier.
 *
 * A bare `Error` yields null, and that is the rule rather than an omission: its only field
 * is the glued message, and reading that is how stderr reaches a card.
 */
export function blockerForGhFailure(error: unknown): FounderBlocker | null {
  const failure = (error ?? {}) as { said?: unknown; remedy?: unknown };
  const said = text(failure.said);
  if (!said.trim()) return null;

  const remedy = text(failure.remedy).trim() || classifyGhFailure(said).remedy;
  const kind = kindForRemedy(remedy);
  if (!kind) return null;

  return blocker(kind, undefined, {}, evidenceOf(said, 'src/core/gh.ts'));
}

/**
 * The condition behind what the GitHub preflight found, or null.
 *
 * The same three facts `githubPreflightLine` already reports on, read in its order: a CLI
 * that is not there, one that is signed in to nothing, and a sign-in without the permission
 * the project mirror needs. `unknown` and `probing` are a preflight that could not say, and
 * a sign-in that listed no scopes at all is an older CLI rather than an account with none.
 */
export function blockerForGithubStatus(
  github: GithubStatus | null | undefined,
): FounderBlocker | null {
  if (!github) return null;
  const source = 'src/core/github-status.ts';
  const said = text(github.error);

  if (github.resolved === 'not found') {
    return blocker('gh-missing', undefined, {}, evidenceOf(said, source));
  }
  if (github.resolved !== 'found') return null;
  if (!github.authenticated) {
    return blocker('gh-login', undefined, {}, evidenceOf(said, source));
  }
  if (github.scopes.length > 0 && !github.scopes.includes('project')) {
    return blocker('gh-scope', undefined, {},
                   evidenceOf(`token scopes: ${github.scopes.join(', ')}`, source));
  }
  return null;
}

/**
 * The condition behind a push permission, or null.
 *
 * Only `no` — the verdict GitHub stated — is a blocker. `unknown` is the probe saying it
 * could not learn anything, and it lets a run start today; turning it into a founder card
 * would be refusing the same reader through a different door.
 */
export function blockerForPushAccess(
  access: PushAccess | null | undefined,
): FounderBlocker | null {
  if (access?.verdict !== 'no') return null;

  const repository = text(access.repo).trim();
  const permission = text(access.permission).trim();
  return blocker(
    'push-denied',
    repository ? repository.toLowerCase() : undefined,
    { repository, permission },
    evidenceOf(
      permission ? `viewerPermission: ${permission}` : '',
      'src/core/github-push.ts',
      repository ? `gh repo view ${repository} --json viewerPermission` : undefined,
    ),
  );
}

/**
 * The condition behind one role's preflight in one environment, or null.
 *
 * Two of the seven resolutions are blockers: a binary that is not there, and a board that
 * was never granted a command for this role at all. `found` is nothing to say; `probing`,
 * `unknown`, `not probed` and `unsupported` are a probe that could not run or had nowhere to
 * run — and a machine with no distro is not a machine with a missing agent.
 */
export function blockerForAgentPreflight(
  entry: AgentPreflightEntry | null | undefined,
): FounderBlocker | null {
  if (!entry) return null;

  const environment = ENVIRONMENT_NAMED[entry.environment] ?? ENVIRONMENT_NAMED.native;
  const binary = text(entry.binary).trim();
  const variable = text(entry.variable).trim();
  const named = { binary, environment, variable };
  const where = `${entry.role}:${entry.environment}`;
  const source = 'src/core/agent-preflight.ts';

  if (entry.resolved === 'not found') {
    return blocker('agent-missing', where, named,
                   evidenceOf('', source, binary ? `${binary} --version` : undefined));
  }
  if (entry.resolved === 'unconfigured') {
    return blocker('agent-not-granted', where, named,
                   evidenceOf(variable ? `${variable} names no command` : '', source));
  }
  return null;
}

/**
 * The condition behind one environment's usage reading, or null.
 *
 * Three ways of producing nothing, and each is a reading that cannot say rather than one
 * that says there is room. A reading older than `STALE_AFTER_SECONDS` is a machine nobody
 * has been working on, not a quota that is still spent; a reading with no moment at all
 * cannot be aged; and an environment nobody has run a session in has answered nothing.
 */
export function blockerForAgentUsage(
  reading: AgentLimitsReading | null | undefined,
): FounderBlocker | null {
  if (!reading || reading.stale || reading.observedAt === null) return null;
  if (reading.ageSeconds === null || reading.ageSeconds > STALE_AFTER_SECONDS) return null;

  const windows = [
    ['five-hour', reading.fiveHour],
    ['seven-day', reading.sevenDay],
  ] as const;
  const spent = windows.filter(
    ([, window]) => (window?.usedPercent ?? 0) >= AGENT_USAGE_SATURATED_PERCENT,
  );
  if (spent.length === 0) return null;

  const environment = reading.environment.kind === 'wsl'
    ? `wsl:${reading.environment.distro.toLowerCase()}`
    : 'native';
  const said = spent
    .map(([name, window]) => `the ${name} window is at ${window?.usedPercent ?? 0}%`)
    .join(', ');

  return blocker(
    'agent-usage-exhausted',
    environment,
    { environment: text(reading.label).trim() || 'this machine' },
    evidenceOf(`${said}, read ${reading.ageSeconds}s ago`, 'src/core/agent-limits.ts'),
  );
}

/** A record's text fields, which is every field that is not the list of steps. */
type FounderTextField = 'title' | 'what' | 'why' | 'confirm';

/** One hole, and where in a corpus entry it goes. */
interface FounderEdit {
  hole: FounderHole;
  fill: (fields: FounderActionFields, value: string) => FounderActionFields | null;
}

const copy = (fields: FounderActionFields): FounderActionFields =>
  ({ ...fields, steps: [...fields.steps] });

/** Put the run's fact where a generic phrase stands, in one text field. */
function inField(
  field: FounderTextField,
  phrase: string,
  written: (value: string) => string,
): FounderEdit['fill'] {
  return (fields, value) => {
    if (!fields[field].includes(phrase)) return null;
    const next = copy(fields);
    next[field] = fields[field].replace(phrase, written(value));
    return next;
  };
}

/** The same, in one step. */
function inStep(
  at: number,
  phrase: string,
  written: (value: string) => string,
): FounderEdit['fill'] {
  return (fields, value) => {
    const step = fields.steps[at];
    if (step === undefined || !step.includes(phrase)) return null;
    const next = copy(fields);
    next.steps[at] = step.replace(phrase, written(value));
    return next;
  };
}

/** A step the corpus has no place for, because only a run knows the name in it. */
function asStep(written: (value: string) => string): FounderEdit['fill'] {
  return (fields, value) => {
    const next = copy(fields);
    next.steps.push(written(value));
    return next;
  };
}

/**
 * Where each kind's facts go, and nowhere else.
 *
 * The six `gh` kinds have no edits, and that is the honest answer rather than an omission:
 * nothing about a missing CLI or a rate limit is specific to one run, the corpus already
 * names the literal commands, and inventing a machine into the text would be adding
 * something no probe said.
 *
 * A variable and a binary are put in backticks, which is what the register means by them:
 * a literal thing to type rather than a word to understand.
 */
const EDITS: Partial<Record<FounderActionKind, readonly FounderEdit[]>> = {
  'push-denied': [
    { hole: 'repository', fill: inField('title', 'the project repository', (repo) => repo) },
    { hole: 'repository', fill: inStep(0, 'the repository', (repo) => repo) },
    {
      hole: 'permission',
      fill: inField('what', 'may read the repository, but it may not write to it',
                    (permission) => `has ${permission} access to the repository, which cannot `
                      + 'push a branch'),
    },
  ],
  'agent-missing': [
    { hole: 'environment', fill: inField('title', 'this machine', (where) => where) },
    { hole: 'binary', fill: inStep(1, 'Run it once', (binary) => `Run \`${binary}\` once`) },
    {
      hole: 'variable',
      fill: asStep((variable) => `Set \`${variable}\` to where it lives, and start the board again.`),
    },
  ],
  'agent-not-granted': [
    { hole: 'environment', fill: inField('what', 'this machine', (where) => where) },
    {
      hole: 'variable',
      fill: asStep((variable) =>
        `Set \`${variable}\` to the command that starts it, and start the board again.`),
    },
  ],
  'agent-usage-exhausted': [
    {
      hole: 'environment',
      fill: inStep(0, 'the usage figure', (where) => `the usage figure for ${where}`),
    },
  ],
};

/**
 * The founder action for one blocker: the corpus entry, with this run's facts in it.
 *
 * **An edit that would break a rule is not made.** A repository name can be any length, a
 * binary can be an absolute path, and either could push a field past its cap or a sentence
 * past its word count. So each edit is applied and then read by `validateFounderAction`, and
 * kept only if the record still passes — which is why what comes back is always renderable.
 * The reader of a board with a very long repository name gets the general sentence rather
 * than a card that cannot be drawn.
 */
export function founderActionFor(target: FounderBlocker): FounderActionFields {
  const base = FOUNDER_ACTION_CORPUS[target.kind];
  if (!base) return { title: '', what: '', why: '', steps: [], confirm: '' };

  let fields = copy(base);
  for (const edit of EDITS[target.kind] ?? []) {
    const value = text(target.named?.[edit.hole]).trim();
    if (!value) continue;
    const filled = edit.fill(fields, value);
    if (filled && validateFounderAction(filled).ok) fields = filled;
  }
  return fields;
}

/**
 * One condition per key, in the order they were noticed.
 *
 * `gh` being absent is detected twice and independently — `classifyGhFailure` reads it off a
 * failure and `interpretVersion` reads it off the preflight — and a snapshot carrying both
 * has to be one card. The first sighting is the one kept: it is the one whose evidence
 * belongs to whatever was actually being attempted.
 */
export function dedupeBlockers(
  found: ReadonlyArray<FounderBlocker | null | undefined>,
): FounderBlocker[] {
  const byKey = new Map<string, FounderBlocker>();
  for (const one of found) {
    if (one && !byKey.has(one.key)) byKey.set(one.key, one);
  }
  return [...byKey.values()];
}
