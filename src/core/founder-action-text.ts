/**
 * The register of founder actions: what one *is*, rather than what one should sound like.
 *
 * Everything else in this repository is written for an engineer. A founder action is the other
 * reader — somebody with a payment card and ten minutes, who is being told the one thing only
 * they can do. Advice cannot hold that line. An agent that has read `docs/project-board.md`
 * will write an engineering issue whatever a prompt asks it for, because that is the register
 * every example in front of it is written in.
 *
 * So the text is not prose that a producer writes. It is a record of named fields, and
 * `renderFounderAction` is the only way to turn one into Markdown. A producer that wants to say
 * something has to say it in a field, and every field is measured.
 *
 * **Evidence is exempt from every rule, and that is what lets the rules stay tight.** The last
 * 300 characters of what a tool printed has a legitimate home, so nobody is tempted to smuggle
 * it into `why`. The split already exists one layer down: `TerminalGhFailure` in `gh.ts` keeps
 * `said` and `remedy` in separate fields, and the only reason a stack trace ever reaches the
 * canvas is that its constructor glues the two into `message`.
 *
 * **Pure, and deliberately so.** The panel that draws these runs in the browser, and
 * `frontend/tsconfig.json` sets `"types": []` — so a single `node:fs` import here would fail the
 * frontend type check in files nobody touched. Nothing in this module reads a file, spawns a
 * process, or asks GitHub anything. The register is enforced at the write, never by inspection.
 */

/**
 * Every human blocker this product already detects. Closed, because an open set is a set
 * nobody has written the copy for — a kind that is not here has no entry in the corpus and
 * therefore no founder-readable text to draw.
 */
export type FounderActionKind =
  | 'gh-missing'
  | 'gh-login'
  | 'gh-scope'
  | 'gh-credential'
  | 'gh-rate-limit'
  | 'gh-billing'
  | 'push-denied'
  | 'agent-missing'
  | 'agent-not-granted'
  | 'agent-usage-exhausted';

/** The kinds in the order the register lists them. */
export const FOUNDER_ACTION_KINDS: readonly FounderActionKind[] = [
  'gh-missing',
  'gh-login',
  'gh-scope',
  'gh-credential',
  'gh-rate-limit',
  'gh-billing',
  'push-denied',
  'agent-missing',
  'agent-not-granted',
  'agent-usage-exhausted',
];

/**
 * What a founder action says, in named fields.
 *
 * The four questions a person with ten minutes has, in the order they have them: what is the
 * matter, why it is theirs rather than the board's, what to do, and how they will know it
 * worked. Nothing else is a field, because a field nobody named is where prose comes back.
 */
export interface FounderActionFields {
  /** One line, the blocker as a person would say it. */
  title: string;
  /** What is the matter, in one or two sentences. */
  what: string;
  /** Why no machine here can do it instead. */
  why: string;
  /** The things to go and do, in order. Numbering is the composer's job. */
  steps: string[];
  /** What they will see when it has worked. */
  confirm: string;
}

/**
 * What the machine saw, kept apart from what the person reads.
 *
 * Exempt from every rule below. Jargon, a 300-character tail, an HTTP status, a path into
 * `src/` — all of it belongs here and none of it belongs in a founder field.
 */
export interface FounderActionEvidence {
  /** The command that failed, as it was run. */
  command?: string;
  /** What that command said, verbatim. */
  said?: string;
  /** Where in this tree the failure was classified. */
  source?: string;
}

/** One broken rule, naming the field it broke it in. */
export interface FounderActionFault {
  /** A key of `FounderActionFields`, or `body` for a rule about the rendered whole. */
  field: string;
  /** The rule's name, which is what a check reports and what a producer searches for. */
  rule: string;
  /** What was wrong, with the measurement that says so. */
  detail: string;
}

/** Whether a record may be rendered, and everything that stops it if not. */
export interface FounderActionValidation {
  ok: boolean;
  faults: FounderActionFault[];
}

/**
 * Every limit, in one place, so a rule is a number a person can argue with.
 *
 * The per-field caps are individually generous and the body cap is what actually bites: seven
 * steps of 120 characters each is 840 characters of steps alone, so a record that spends its
 * whole allowance in every field cannot be rendered at all. That is the intended pressure.
 */
export const FOUNDER_ACTION_LIMITS = {
  title: 60,
  what: 140,
  why: 240,
  confirm: 160,
  /** One step. */
  step: 120,
  /** Fewer than two is not a procedure; more than seven is a document. */
  minSteps: 2,
  maxSteps: 7,
  /** The rendered record, `## Evidence` excluded. */
  body: 1200,
  /** Words in one sentence. */
  sentenceWords: 25,
  /** Characters on one line, URLs and backticked spans not counted. */
  line: 200,
} as const;

/**
 * Words this product's own copy does not use, and a founder should not have to look up.
 *
 * **The list is short because it has to exclude every word a shipped remedy already uses.**
 * `REMEDY.scope` in `gh.ts` says "scope"; `pushRefusal` in `github-push.ts` says "repo";
 * `REMEDY.install` says "CLI". A list carrying any of those would reject the best copy this
 * product has, and the check holding it would be deleted within the month. What is left is
 * the set nothing user-facing writes today.
 *
 * Two escapes, because a word that is explained is not jargon:
 *
 *  1. a gloss where the word stands — a parenthesis or a dash clause opening right after it,
 *     or a parenthesis closing right before it;
 *  2. backticks, which mean a literal thing to type rather than a word to understand.
 */
export const FOUNDER_ACTION_JARGON: readonly string[] = [
  'OAuth', 'PAT', 'worktree', 'single-select', 'stderr', 'loopback',
];

/** A leading ordinal a producer transcribed along with the step. */
const ORDINAL = /^\s*(?:step\s+)?(\d+)\s*[.):\-–—]\s+/i;

/** Backticked spans and URLs, which the long-line, machine-noise and jargon rules skip. */
const SPANS = /`[^`]*`|https?:\/\/\S+/g;

/** A path into this tree, which is a fact about the machine rather than about the blocker. */
const OUR_PATH = /(^|[\s(<"'])(?:src|scripts)\/[\w./-]+/;

/** A tool's own error prefix, at the head of a line. */
const ERROR_PREFIX = /(^|\n)[ \t]*\w*Error:/;

/** An HTTP status, which is a number no founder has an opinion about. */
const HTTP_STATUS = /\bHTTP\s\d{3}\b/;

const isText = (value: unknown): value is string => typeof value === 'string';

/** A field as a string, whatever a producer handed over. */
const text = (value: unknown): string => (isText(value) ? value : '');

/** The field with backticked spans and URLs taken out, so a rule cannot read them. */
const withoutSpans = (value: string): string => value.replace(SPANS, ' ');

/** A step as the reader sees it: any ordinal the producer typed belongs to the composer. */
const bare = (step: unknown): string => text(step).replace(ORDINAL, '').trim();

/** The steps as an array, whatever a producer handed over. */
const stepsOf = (fields: FounderActionFields): string[] =>
  Array.isArray(fields?.steps) ? fields.steps.map((step) => text(step)) : [];

/**
 * A field cut into sentences.
 *
 * A full stop that is not followed by a space is inside a number or an address rather than at
 * the end of anything, which is why the split needs the whitespace.
 */
const sentencesOf = (value: string): string[] =>
  value.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);

const wordsIn = (sentence: string): number => sentence.split(/\s+/).filter(Boolean).length;

/**
 * Whether the word is explained where it stands.
 *
 * Deliberately local rather than "somewhere in the same sentence": a sentence that explains
 * itself two clauses later has already lost the reader at the word. `pushRefusal` passes this
 * because its sentence keeps going at the word — "stranded in a worktree — so it is refused
 * before anything is created" — which is what a gloss is.
 */
function glossed(sentence: string, at: number, word: string): boolean {
  const after = sentence.slice(at + word.length);
  if (/^[\s,]{0,3}[(–—]|^[\s]{0,3}--\s/.test(after)) return true;
  return /[)][\s,]{0,3}$/.test(sentence.slice(0, at));
}

/** Every jargon word in the field that nothing explains and no backticks excuse. */
function unexplainedJargon(value: string): string[] {
  const found: string[] = [];
  for (const sentence of sentencesOf(withoutSpans(value))) {
    for (const word of FOUNDER_ACTION_JARGON) {
      const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      for (const hit of sentence.matchAll(pattern)) {
        if (typeof hit.index === 'number' && !glossed(sentence, hit.index, hit[0])) found.push(word);
      }
    }
  }
  return found;
}

/**
 * Render one founder action.
 *
 * Four headings, always in this order, and `## Evidence` last and only when there is any.
 * The order is the order the reader's questions arrive in, and a composer that could be asked
 * for another order would be a composer producers argue with.
 */
export function renderFounderAction(
  fields: FounderActionFields,
  evidence?: FounderActionEvidence,
): string {
  const steps = stepsOf(fields).map((step, at) => `${at + 1}. ${bare(step)}`);
  const lines: string[] = [
    `# ${text(fields?.title).trim()}`,
    '',
    '## What',
    '',
    text(fields?.what).trim(),
    '',
    '## Why',
    '',
    text(fields?.why).trim(),
    '',
    '## Steps',
    '',
    ...steps,
    '',
    '## Confirm',
    '',
    text(fields?.confirm).trim(),
  ];

  // Only what was supplied, in one order. An evidence object whose every field is empty is no
  // evidence: the heading would promise the reader something and then show them nothing.
  const rows: string[] = [];
  const command = text(evidence?.command).trim();
  const said = text(evidence?.said).trim();
  const source = text(evidence?.source).trim();
  if (command) rows.push(`- Command: \`${command}\``);
  if (said) rows.push(`- Said: ${said}`);
  if (source) rows.push(`- Source: ${source}`);
  if (rows.length > 0) lines.push('', '## Evidence', '', ...rows);

  return lines.join('\n');
}

/**
 * Read a record against every rule, and say which field broke which one.
 *
 * Countable, one rule at a time, and each fault names a field — because "this does not sound
 * like a founder action" is advice, and advice is what this module exists instead of.
 */
export function validateFounderAction(fields: FounderActionFields): FounderActionValidation {
  const faults: FounderActionFault[] = [];
  const fault = (field: string, rule: string, detail: string) => faults.push({ field, rule, detail });

  const title = text(fields?.title);
  const what = text(fields?.what);
  const why = text(fields?.why);
  const confirm = text(fields?.confirm);
  const steps = stepsOf(fields);

  // ── every field non-empty ──
  const singles: ReadonlyArray<[string, string, number]> = [
    ['title', title, FOUNDER_ACTION_LIMITS.title],
    ['what', what, FOUNDER_ACTION_LIMITS.what],
    ['why', why, FOUNDER_ACTION_LIMITS.why],
    ['confirm', confirm, FOUNDER_ACTION_LIMITS.confirm],
  ];
  for (const [field, value, limit] of singles) {
    if (!value.trim()) fault(field, 'non-empty', 'nothing was written in it');
    if (value.length > limit) fault(field, 'length', `${value.length} characters, the cap is ${limit}`);
  }
  if (steps.length === 0 || steps.some((step) => !bare(step))) {
    fault('steps', 'non-empty', 'a step with nothing in it is not a step');
  }

  // ── the title is a title ──
  if (/\r|\n/.test(title)) fault('title', 'one-line', 'a title is one line');
  if (/\.$/.test(title.trim())) fault('title', 'no-trailing-full-stop', 'a title is not a sentence');

  // ── the steps are a procedure ──
  if (steps.length > 0
      && (steps.length < FOUNDER_ACTION_LIMITS.minSteps || steps.length > FOUNDER_ACTION_LIMITS.maxSteps)) {
    fault('steps', 'count', `${steps.length} step(s), the range is `
      + `${FOUNDER_ACTION_LIMITS.minSteps} to ${FOUNDER_ACTION_LIMITS.maxSteps}`);
  }
  for (const step of steps) {
    const one = bare(step);
    if (one.length > FOUNDER_ACTION_LIMITS.step) {
      fault('steps', 'length',
            `${one.length} characters, the cap is ${FOUNDER_ACTION_LIMITS.step}: ${one.slice(0, 40)}…`);
    }
    if (one && sentencesOf(withoutSpans(one)).length > 1) {
      fault('steps', 'one-sentence', `two things in one step: ${one.slice(0, 60)}…`);
    }
  }

  // A producer that transcribed a numbered list has to have transcribed all of it. The composer
  // strips the ordinal either way, so a gap here is a step that was dropped on the way in.
  const ordinals = steps.map((step) => step.match(ORDINAL)?.[1]);
  const numbered = ordinals.filter((found) => found !== undefined);
  if (numbered.length > 0) {
    const consecutive = numbered.length === steps.length
      && ordinals.every((found, at) => Number(found) === at + 1);
    if (!consecutive) {
      fault('steps', 'numbering',
            `the steps read ${ordinals.map((found) => found ?? '—').join(', ')} rather than `
            + `${steps.map((_, at) => at + 1).join(', ')}`);
    }
  }

  // ── what nothing founder-facing may carry ──
  const founderFields: ReadonlyArray<[string, string]> = [
    ['title', title], ['what', what], ['why', why], ['confirm', confirm],
    ...steps.map((step, at): [string, string] => [`steps[${at}]`, bare(step)]),
  ];
  for (const [field, value] of founderFields) {
    const plain = withoutSpans(value);
    if (HTTP_STATUS.test(plain)) fault(field, 'machine-noise', 'an HTTP status is not a fact for a reader');
    if (ERROR_PREFIX.test(plain)) fault(field, 'machine-noise', 'a tool\'s "Error:" prefix belongs in the evidence');
    if (OUR_PATH.test(plain)) fault(field, 'machine-noise', 'a path into this tree belongs in the evidence');
    for (const line of plain.split(/\r?\n/)) {
      if (line.length > FOUNDER_ACTION_LIMITS.line) {
        fault(field, 'machine-noise',
              `a run of ${line.length} characters on one line, the cap is ${FOUNDER_ACTION_LIMITS.line}`);
      }
    }
    for (const sentence of sentencesOf(value)) {
      const words = wordsIn(sentence);
      if (words > FOUNDER_ACTION_LIMITS.sentenceWords) {
        fault(field, 'sentence-words',
              `${words} words in one sentence, the cap is ${FOUNDER_ACTION_LIMITS.sentenceWords}`);
      }
    }
    const jargon = unexplainedJargon(value);
    if (jargon.length > 0) {
      fault(field, 'jargon', `${[...new Set(jargon)].join(', ')} — gloss it, or put the literal in backticks`);
    }
  }

  // ── and the whole of it, as the reader gets it ──
  const body = renderFounderAction(fields);
  if (body.length > FOUNDER_ACTION_LIMITS.body) {
    fault('body', 'body-length',
          `${body.length} rendered characters before the evidence, the cap is ${FOUNDER_ACTION_LIMITS.body}`);
  }

  return { ok: faults.length === 0, faults };
}

/**
 * One worked entry per kind, and the reason the rules above are believable.
 *
 * Every one of these passes `validateFounderAction`, which is the ballast the check runs: a set
 * of rules nobody has written ten passing records against is a set of rules that will be
 * loosened the first time somebody real tries to use them. None of them names an account, a
 * repository or a machine — those are facts about one run, and a run puts them in the evidence.
 */
export const FOUNDER_ACTION_CORPUS: Record<FounderActionKind, FounderActionFields> = {
  'gh-missing': {
    title: 'The GitHub CLI is not installed on this machine',
    what: 'This board reaches GitHub through the GitHub CLI, and no such program is installed here yet.',
    why: 'Until it is installed the board cannot read your project, file an issue or start a run.',
    steps: [
      'Install the GitHub CLI from https://cli.github.com for this operating system.',
      'Open a new terminal and run `gh --version` to see that it answers.',
      'Start the board again so it picks up the program you just installed.',
    ],
    confirm: 'The board stops saying GitHub is out of reach, and your project cards fill in.',
  },
  'gh-login': {
    title: 'Sign the GitHub CLI in to your account',
    what: 'The GitHub CLI is on this machine, but it is not signed in to any account yet.',
    why: 'Signed out, the board can show you nothing from GitHub and can start no run at all.',
    steps: [
      'Run `gh auth login` in a terminal and answer the questions it asks.',
      'Choose the account that owns the project you want this board to show.',
    ],
    confirm: 'The board shows your project again instead of asking you to sign in.',
  },
  'gh-scope': {
    title: 'Let the GitHub CLI read your projects',
    what: 'The sign-in is good, but it was never given permission to read GitHub projects.',
    why: 'A normal sign-in does not ask for that permission, so the project column stays empty.',
    steps: [
      'Run `gh auth refresh -s project` in a terminal.',
      'Approve the request on the page it opens in your browser.',
    ],
    confirm: 'The project column fills in with the cards you see on GitHub.',
  },
  'gh-credential': {
    title: 'GitHub refused this sign-in, so make a new one',
    what: 'GitHub turned down the sign-in this board is holding, so it is no longer any good.',
    why: 'A refused sign-in is usually one that was revoked or has run out, and nothing answers.',
    steps: [
      'Run `gh auth status` to see which account this board is using.',
      'Run `gh auth login` and sign in again as that account.',
    ],
    confirm: 'The board reads your project again without asking you to sign in.',
  },
  'gh-rate-limit': {
    title: 'GitHub is asking this board to wait a while',
    what: 'GitHub has answered this account more times than it allows for the moment.',
    why: 'The wait clears on its own and nothing is broken, but until it does nothing new arrives.',
    steps: [
      'Leave the board for an hour and let the wait clear on its own.',
      'Run `gh api rate_limit` if you would like to see when it lifts.',
      'Sign in as an account of your own if a shared one is doing this every day.',
    ],
    confirm: 'The project cards load again without a wait.',
  },
  'gh-billing': {
    title: 'GitHub is refusing work until billing is settled',
    what: 'GitHub says this account owes a payment, and it is refusing the work the board asks for.',
    why: 'Nothing here can settle a bill, and every run is refused until the account is in good standing.',
    steps: [
      'Open https://github.com/settings/billing and read what it says is owed.',
      'Add a payment method there, or fix the one already on the account.',
      'Raise the spending limit on that page if it says the limit is what stopped you.',
    ],
    confirm: 'The billing page shows nothing owed, and a run starts instead of being refused.',
  },
  'push-denied': {
    title: 'This account may not push to the project repository',
    what: 'The account this board is signed in as may read the repository, but it may not write to it.',
    why: 'A run has to push a branch and open a pull request, so it would fail with the work stranded.',
    steps: [
      'Fork the repository on GitHub so that you have a copy you own.',
      'Point this project at your copy with `git remote set-url origin <your fork>`.',
      'Run `gh auth status` to check which account the board is using.',
    ],
    confirm: 'A run starts and pushes its branch instead of being refused before it begins.',
  },
  'agent-missing': {
    title: 'The coding agent is not installed on this machine',
    what: 'This board hands the work to a coding agent, and no such program is installed here.',
    why: 'Without one a card can be filed on GitHub, but nothing can be built and no run can start.',
    steps: [
      'Install a coding agent this board supports, and sign in to it.',
      'Run it once in a terminal to see that it answers you.',
      'Point this board at it in the project settings dialog.',
    ],
    confirm: 'A run starts, and the agent begins writing in a block of its own.',
  },
  'agent-not-granted': {
    title: 'The coding agent has not been allowed to work yet',
    what: 'The agent is installed, but it has not been allowed to change anything on this machine.',
    why: 'An agent that was never allowed reads the issue, refuses the first edit, and exits as a success.',
    steps: [
      'Run the agent once by hand in a terminal and accept what it asks you for.',
      'Sign in to the agent with the account that carries your plan.',
      'Start a run again from the board.',
    ],
    confirm: 'The agent writes files and opens a pull request instead of stopping early.',
  },
  'agent-usage-exhausted': {
    title: 'The coding agent has spent its plan for now',
    what: 'The agent says this account has used what its plan allows for the window it is in.',
    why: 'Nothing here can add more, and every run is refused at once until the window comes round.',
    steps: [
      'Read the usage figure in the board header to see when the window resets.',
      'Wait for that time, or raise the plan on the agent account page.',
      'Start the run again once that figure has room in it.',
    ],
    confirm: 'The usage figure has room again, and a run begins instead of refusing.',
  },
};
