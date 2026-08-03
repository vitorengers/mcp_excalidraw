/**
 * Whether a founder action is still true, asked of what the board can see now.
 *
 * A card in the founder column says a person has to do something. The only honest way to
 * close one is to look again — and looking again has three answers, not two. The third is
 * the whole module: **a probe that cannot say never closes an action and never blames
 * anybody.** That rule is not invented here. `readPushAccess` is built on it already, in
 * `github-push.ts`: only a permission GitHub explicitly stated as non-pushing refuses
 * anything, and every failure to learn is `unknown` and lets the run start. This generalises
 * it to every kind, because the alternative is a column that fills with cards about a bad
 * network minute and a founder who stops reading it.
 *
 * Three of the ten can only ever answer `cannot-say`, and they say so rather than guessing.
 * Nothing this board runs can confirm that a rate limit has lifted, that a bill has been
 * paid or that a usage window has room — only the next call that goes through shows any of
 * them, and this module makes no calls at all.
 *
 * **Type-only imports, all the way down.** It names three probe results — a GitHub status, a
 * push permission and one environment's preflight answer — and every one of those modules
 * spawns a process. `frontend/tsconfig.json` sets `"types": []`, so a single value import
 * here would drag `child_process` into a graph the frontend compiles and fail the type check
 * in files nobody touched. Types are erased; code is not.
 *
 * `scripts/check-founder-blockers.mjs` holds all of it.
 */
import type { AgentEnvironmentHealth } from './agent-preflight.js';
import type { FounderActionKind } from './founder-action-text.js';
import type { GithubStatus } from './github-status.js';
import type { PushAccess } from './github-push.js';

/**
 * What looking again settled.
 *
 * `cannot-say` is not a failure of the probe: it is the answer a probe that could not learn
 * anything is required to give, and the one that leaves the card exactly as it was.
 */
export type FounderSettlement = 'satisfied' | 'still-blocked' | 'cannot-say';

export const FOUNDER_SETTLEMENTS: readonly FounderSettlement[] = [
  'satisfied',
  'still-blocked',
  'cannot-say',
];

/** What one look answered, and the sentence a person gets for it. */
export interface FounderVerdict {
  settled: FounderSettlement;
  /**
   * Why, in one line a reader can take at face value.
   *
   * Short and plain on purpose: this is shown beside a card in a column written for somebody
   * with a payment card and ten minutes, and a line beginning `gh` or `Error:` is the
   * machine talking. What the machine said belongs in the action's evidence.
   */
  why: string;
}

/**
 * Everything the verifier is allowed to look at.
 *
 * Each field is a probe result somebody else already took, and every one of them is
 * optional: a snapshot that was never filled in is a snapshot that cannot say, which is
 * exactly the answer this module is built to give.
 */
export interface FounderSnapshot {
  /** What `readGithubStatus` answered for the board this action belongs to. */
  github?: GithubStatus | null;
  /** What `readPushAccess` answered about the checkout a run would push from. */
  push?: PushAccess | null;
  /** The preflight answer for the one role and environment the action names. */
  agent?: AgentEnvironmentHealth | null;
}

/** The longest a reason may be. One line beside a card, not a paragraph inside it. */
export const FOUNDER_WHY_LIMIT = 160;

/** Something a reader would take for a command rather than for a sentence. */
const COMMAND_START = /^\s*(?:gh|node|npm|Error:)/i;

const verdict = (settled: FounderSettlement, why: string): FounderVerdict => ({ settled, why });

/**
 * The specific sentence when it can be read, and the general one when it cannot.
 *
 * A repository name, an account or a permission is a fact about one run and can be any
 * length at all, so a sentence built around one is offered rather than assumed. The general
 * sentence is always true — it simply says less.
 */
function say(specific: string, general: string): string {
  const trimmed = specific.trim();
  if (!trimmed || trimmed.length > FOUNDER_WHY_LIMIT) return general;
  if (trimmed.split(/\r?\n/).some((line) => COMMAND_START.test(line))) return general;
  return trimmed;
}

/** Whether the CLI answered at all. Nothing about a login can be read past a `no` here. */
const ghAnswered = (github: GithubStatus | null | undefined): boolean =>
  github?.resolved === 'found';

function verifyGhMissing(github: GithubStatus | null | undefined): FounderVerdict {
  if (github?.resolved === 'found') {
    return verdict('satisfied', 'The GitHub CLI answers on this machine now.');
  }
  if (github?.resolved === 'not found') {
    return verdict('still-blocked', 'The GitHub CLI is still not where the board looked for it.');
  }
  return verdict('cannot-say',
                 'The CLI neither answered nor reported itself missing, so nothing can say.');
}

function verifyGhLogin(github: GithubStatus | null | undefined): FounderVerdict {
  if (!ghAnswered(github)) {
    return verdict('cannot-say', 'Without a CLI that answers, nothing can say whether it is signed in.');
  }
  if (github?.authenticated) {
    return verdict('satisfied', say(`The CLI is signed in as ${github.login ?? ''}.`,
                                    'The CLI is signed in to an account again.'));
  }
  return verdict('still-blocked', 'The CLI is installed here and still signed in to no account.');
}

function verifyGhScope(github: GithubStatus | null | undefined): FounderVerdict {
  if (!ghAnswered(github) || !github?.authenticated) {
    return verdict('cannot-say',
                   'An account that is signed out has no permissions to read, so nothing can say.');
  }
  // An older CLI prints no scopes line at all, and reading its silence as "none of them"
  // would blame a founder for a version number.
  if (github.scopes.length === 0) {
    return verdict('cannot-say', 'This sign-in listed no permissions at all, so nothing can say.');
  }
  if (github.scopes.includes('project')) {
    return verdict('satisfied', 'The sign-in now carries permission to read your projects.');
  }
  return verdict('still-blocked', 'The sign-in still carries no permission to read your projects.');
}

function verifyGhCredential(github: GithubStatus | null | undefined): FounderVerdict {
  if (!ghAnswered(github)) {
    return verdict('cannot-say',
                   'Without a CLI that answers, nothing can say whether the sign-in is good.');
  }
  if (github?.authenticated) {
    return verdict('satisfied', 'The sign-in this board holds was accepted.');
  }
  return verdict('still-blocked', 'The sign-in this board holds is still being refused.');
}

function verifyPushDenied(push: PushAccess | null | undefined): FounderVerdict {
  if (!push) {
    return verdict('cannot-say', 'Nothing asked about pushing to the project, so this stays open.');
  }
  if (push.verdict === 'yes') {
    return verdict('satisfied', say(`This account can push to ${push.repo ?? ''} now.`,
                                    'This account can push to the project repository now.'));
  }
  if (push.verdict === 'no') {
    return verdict('still-blocked',
                   say(`This account still has ${push.permission ?? ''} access, which cannot push.`,
                       'This account still has access that cannot push a branch.'));
  }
  // The permissive rule, said once where it is most tempting to break: `unknown` is nobody
  // could say, and it may neither close this card nor hold it against anybody.
  return verdict('cannot-say', 'Nobody could be told whether this account may push, so this stays open.');
}

function verifyAgentMissing(agent: AgentEnvironmentHealth | null | undefined): FounderVerdict {
  if (agent?.resolved === 'found') {
    return verdict('satisfied', 'The coding agent answers where the board would run it.');
  }
  if (agent?.resolved === 'not found') {
    return verdict('still-blocked', 'The coding agent is still not where the board would run it.');
  }
  return verdict('cannot-say',
                 'The agent neither answered nor reported itself missing, so nothing can say.');
}

function verifyAgentNotGranted(agent: AgentEnvironmentHealth | null | undefined): FounderVerdict {
  if (agent?.resolved === 'found') {
    return verdict('satisfied', 'A command is granted for the coding agent, and it answers.');
  }
  if (agent?.resolved === 'unconfigured') {
    return verdict('still-blocked', 'No command has been granted for the coding agent yet.');
  }
  return verdict('cannot-say', 'A command may be granted and nothing could run it, so this stays open.');
}

/**
 * Look again at one founder action, and say what that settled.
 *
 * Never throws, and never invents: a kind this module does not know, and a snapshot with
 * nothing in it, both answer `cannot-say`. A verifier that threw would be a verifier a
 * caller has to guard, and the guard would be somebody's `catch` deciding what to do with a
 * card — which is this decision, taken somewhere it cannot be read.
 */
export function verifyAgainst(kind: FounderActionKind, snapshot: FounderSnapshot): FounderVerdict {
  const { github, push, agent } = snapshot ?? {};

  switch (kind) {
    case 'gh-missing': return verifyGhMissing(github);
    case 'gh-login': return verifyGhLogin(github);
    case 'gh-scope': return verifyGhScope(github);
    case 'gh-credential': return verifyGhCredential(github);
    case 'gh-rate-limit':
      return verdict('cannot-say',
                     'Only the next call that goes through shows the wait has lifted, and nothing '
                     + 'here makes one.');
    case 'gh-billing':
      return verdict('cannot-say',
                     'Nothing here can watch a bill being settled; only the next call that goes '
                     + 'through shows it.');
    case 'push-denied': return verifyPushDenied(push);
    case 'agent-missing': return verifyAgentMissing(agent);
    case 'agent-not-granted': return verifyAgentNotGranted(agent);
    case 'agent-usage-exhausted':
      return verdict('cannot-say',
                     'Only a run that is not refused shows the window has room, and nothing here '
                     + 'starts one.');
    default:
      return verdict('cannot-say', 'Nothing here knows that condition, so it cannot be settled.');
  }
}
