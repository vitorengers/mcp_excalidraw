#!/usr/bin/env node
/**
 * Checks that a founder action is a record of named fields rather than a piece of advice.
 *
 * Every artifact in this repository is written for an engineer, and an agent that has read
 * `docs/project-board.md` will write an engineering issue whatever a prompt asks it for. The
 * register removes the opportunity: the text is named fields, one composer renders them, and
 * a rule is a number rather than a tone of voice. This is the file that holds the rules to
 * being rules.
 *
 * Five sections, in the order that makes the later ones mean anything:
 *
 *  0. **every rule, shown what it must catch and what it must not.** A rule that has never
 *     been shown a passing input is a rule one false positive away from being deleted, and a
 *     rule that has never been shown a failing one is a rule that may not work at all. Each
 *     fixture is the same valid record with a single field replaced, and the count of faults
 *     it must produce is stated inline — the house pattern from `check-board-public.mjs`.
 *  1. **the ten corpus entries as ballast**, because a set of rules nobody has written ten
 *     passing records against is a set of rules that gets loosened the first time somebody
 *     real tries to use them. And, to the jargon rule alone, the three sentences this product
 *     already ships to a reader: `REMEDY.scope`, `REMEDY.install` and `pushRefusal`. A jargon
 *     list that rejects the best copy the product has is a list that will be deleted, so it
 *     is held to accepting it.
 *  2. **the composer**: four headings in one order, `## Evidence` last, and no `## Evidence`
 *     at all when there is no evidence.
 *  3. **the module is pure.** It is compiled by the frontend type check through the panel, and
 *     `frontend/tsconfig.json` sets `"types": []` — one `node:fs` import here fails checks in
 *     files nobody touched.
 *  4. **the register document renders from the composer**, byte for byte. An example somebody
 *     hand-edited is an example that teaches a shape the code does not produce.
 *
 * Offline and self-contained: it imports the built module, reads two tracked files, and starts
 * nothing. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-action-register.mjs
 *
 * Tier: fast
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const built = (module) => pathToFileURL(join(repoRoot, 'dist', 'core', `${module}.js`)).href;

const {
  FOUNDER_ACTION_CORPUS, FOUNDER_ACTION_KINDS, renderFounderAction, validateFounderAction,
} = await import(built('founder-action-text'));

// The two shipped remedies are reached through the exported classifier rather than copied, so
// this cannot go on passing against a sentence the product stopped saying a year ago.
const { classifyGhFailure } = await import(built('gh'));
const { pushRefusal } = await import(built('github-push'));

const REGISTER = 'src/core/founder-action-text.ts';
const DOCUMENT = 'docs/founder-actions.md';

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

// ─── 0. Every rule, over a must-catch and a must-not-catch ────

console.log('0. every rule catches what it is for and nothing beside it');

/** A record that breaks nothing, so a fixture is exactly one field away from valid. */
const BASE = {
  title: 'Sign the tool in to your account',
  what: 'The program is on this machine, but it is not signed in to any account yet.',
  why: 'Signed out, the board can show you nothing at all and can start no run.',
  steps: [
    'Run the sign-in command in a terminal and answer the questions it asks.',
    'Choose the account that owns the project you would like this board to show.',
  ],
  confirm: 'The board shows your project again instead of asking you to sign in.',
};

/** A legal sentence — 95 characters, 21 words — for the fixtures that need bulk. */
const LONG = 'Open the page that it names for you and read the short line it shows at the top of that window.';
/** A second one, so a fixture can be long without repeating itself. */
const THEN = 'Then read the short line that it shows you at the top of that window before going on.';
/** One sentence over the step cap: 129 characters and 23 words, so only `length` may fire. */
const LONG_STEP =
  'Open whichever page this application names for you and then read the short explanation it shows near the very top of that window.';
/** 204 characters with nothing to break the line, for the rule about one long run. */
const RUN = `${LONG} ${LONG} It is quick.`;
/** An address, which the long-line and machine-noise rules do not count and the caps do. */
const ADDRESS = 'https://example.invalid/a-page-about-signing-in-to-an-account-of-your-own';

const fixture = (over) => ({ ...BASE, ...over });

/**
 * `[what it is called, the rule under test, how many faults it must produce, the record]`.
 *
 * The count is the count of *all* faults as well as of that rule's, because every fixture is
 * `BASE` with one field replaced: a fixture that trips a second rule is a fixture measuring
 * something other than what it says.
 */
const FIXTURES = [
  ['a record that breaks nothing breaks nothing', 'non-empty', 0, fixture({})],

  ['an empty title is caught', 'non-empty', 1, fixture({ title: '   ' })],
  ['a step with nothing in it is caught', 'non-empty', 1,
   fixture({ steps: ['', 'Choose the account that owns the project.'] })],

  ['a title over 60 characters is caught', 'length', 1,
   fixture({ title: 'Sign the tool in to the GitHub account that owns this project today' })],
  ['a title of exactly 60 is not', 'length', 0,
   fixture({ title: 'Sign the tool in to the account that owns this project today' })],
  ['a what over 140 characters is caught', 'length', 1,
   fixture({ what: `${LONG} It is not signed in to any account at all, and has never been signed in.` })],
  // 267 characters, of which an address is 73 — over the cap, and not one long line, because
  // the cap counts what a producer wrote and the line rule counts what a reader has to read.
  ['a why over 240 characters is caught', 'length', 1,
   fixture({ why: `${LONG} See ${ADDRESS} for it. ${THEN}` })],
  ['a confirm over 160 characters is caught', 'length', 1,
   fixture({ confirm: `${LONG} You will see your own project on the board again, exactly as it was before.` })],
  ['a step over 120 characters is caught', 'length', 1,
   fixture({ steps: [LONG_STEP, 'Choose the account that owns the project.'] })],

  ['a title on two lines is caught', 'one-line', 1,
   fixture({ title: 'Sign the tool in\nto your account' })],
  ['a title that ends in a full stop is caught', 'no-trailing-full-stop', 1,
   fixture({ title: 'Sign the tool in to your account.' })],
  ['a title that ends in a question mark is not', 'no-trailing-full-stop', 0,
   fixture({ title: 'Is the tool signed in to your account?' })],

  ['one step is not a procedure', 'count', 1, fixture({ steps: ['Run the sign-in command.'] })],
  ['eight steps are a document', 'count', 1,
   fixture({ steps: Array.from({ length: 8 }, (_, at) => `Do the ${at + 1} thing it asks of you.`) })],
  ['seven steps are still a procedure', 'count', 0,
   fixture({ steps: Array.from({ length: 7 }, (_, at) => `Do the ${at + 1} thing it asks of you.`) })],

  ['two sentences in one step are caught', 'one-sentence', 1,
   fixture({ steps: ['Open a terminal. Then run the sign-in command.', 'Choose your account.'] })],
  ['a full stop inside an address is not two sentences', 'one-sentence', 0,
   fixture({ steps: ['Open https://example.invalid/sign.in and follow it.', 'Choose your account.'] })],

  ['steps numbered 1 then 3 are caught', 'numbering', 1,
   fixture({ steps: ['1. Open a terminal.', '3. Choose your account.'] })],
  ['steps where only one carries a number are caught', 'numbering', 1,
   fixture({ steps: ['1. Open a terminal.', 'Choose your account.'] })],
  ['steps numbered 1 then 2 are not', 'numbering', 0,
   fixture({ steps: ['1. Open a terminal.', '2. Choose your account.'] })],
  ['steps carrying no numbers at all are not', 'numbering', 0, fixture({})],

  ['a record whose fields are each legal but together too long is caught', 'body-length', 1,
   fixture({
     what: `${LONG} It has never been signed in.`,
     why: `${LONG} ${THEN}`,
     confirm: `${LONG} You will see your project.`,
     steps: Array.from({ length: 7 }, (_, at) => `${LONG.slice(0, 90)} ${at + 1} of them.`),
   })],

  ['a sentence of 26 words is caught', 'sentence-words', 1,
   fixture({ why: 'Signed out the board can show you nothing at all and can start no run '
     + 'of any kind for you today or on any single day.' })],
  ['a sentence of 25 words is not', 'sentence-words', 0,
   fixture({ why: 'Signed out the board can show you nothing at all and can start no run '
     + 'of any kind for you today or on any day.' })],

  ['an HTTP status is caught', 'machine-noise', 1,
   fixture({ what: 'GitHub answered HTTP 403 when the board asked it about your project.' })],
  ['the same status inside backticks is not', 'machine-noise', 0,
   fixture({ what: 'GitHub refused the question, and the log line says `HTTP 403` beside it.' })],
  ['an "Error:" prefix is caught', 'machine-noise', 1,
   fixture({ what: 'Error: the board could not reach GitHub as the account it is holding.' })],
  ['a path into this tree is caught', 'machine-noise', 1,
   fixture({ what: 'The board decided this in src/core/gh.ts and stopped before it asked.' })],
  ['a line over 200 characters is caught', 'machine-noise', 1, fixture({ why: RUN })],
  ['a line only an address makes long is not', 'machine-noise', 0,
   fixture({ why: `${LONG} See ${ADDRESS} for it.` })],

  ['an unexplained jargon word is caught', 'jargon', 1,
   fixture({ why: 'The run would leave its commits in a worktree and no one would find them.' })],
  ['the same word glossed where it stands is not', 'jargon', 0,
   fixture({ why: 'The run leaves its work in a worktree — a spare copy of the project — and stops.' })],
  ['the same word in backticks is not', 'jargon', 0,
   fixture({ why: 'The board keeps the line that came after `stderr`, and it is in the evidence.' })],
];

for (const [name, rule, expected, fields] of FIXTURES) {
  const { faults, ok } = validateFounderAction(fields);
  const mine = faults.filter((fault) => fault.rule === rule);
  const said = faults.map((fault) => `${fault.field}/${fault.rule}: ${fault.detail}`).join('; ');
  check(`the ${rule} rule: ${name}`,
        mine.length === expected && faults.length === expected && ok === (faults.length === 0),
        `${mine.length} ${rule} fault(s) and ${faults.length} in all, expected ${expected} of each`
        + `${said ? ` — ${said}` : ''}`);
}

// ─── 1. Ten worked records, and the copy already shipped ──────

console.log('\n1. the register accepts every worked entry, and the copy this product ships');

check('the corpus works every kind', FOUNDER_ACTION_KINDS.length === 10
      && FOUNDER_ACTION_KINDS.every((kind) => FOUNDER_ACTION_CORPUS[kind]),
      `${FOUNDER_ACTION_KINDS.length} kind(s), ${Object.keys(FOUNDER_ACTION_CORPUS).length} entries`);

for (const kind of FOUNDER_ACTION_KINDS) {
  const { ok, faults } = validateFounderAction(FOUNDER_ACTION_CORPUS[kind] ?? {});
  check(`the "${kind}" entry breaks no rule`, ok,
        faults.map((fault) => `${fault.field}/${fault.rule}: ${fault.detail}`).join('; '));
}

/**
 * The jargon rule alone, over a sentence written for a reader by somebody who was there.
 *
 * The field is only a carrier: these sentences are longer than a `why` may be and were never
 * written to this schema, so every other rule is deliberately not asked about them.
 */
const jargonFaultsIn = (sentence) => validateFounderAction({ ...BASE, why: sentence })
  .faults.filter((fault) => fault.rule === 'jargon');

const SHIPPED = [
  ['REMEDY.scope', classifyGhFailure('X-Accepted-OAuth-Scopes: missing required scope').remedy],
  ['REMEDY.install', classifyGhFailure('spawn gh ENOENT').remedy],
  ['pushRefusal', pushRefusal({ verdict: 'no', repo: 'octo-founder/example', permission: 'READ', why: '' })],
];

for (const [name, sentence] of SHIPPED) {
  check(`the jargon rule leaves ${name} alone`,
        Boolean(sentence) && jargonFaultsIn(sentence).length === 0,
        sentence
          ? jargonFaultsIn(sentence).map((fault) => fault.detail).join('; ')
          : 'the classifier answered with no remedy at all, so nothing was tested');
}

// ─── 2. The composer ─────────────────────────────────────────

console.log('\n2. one composer, four headings in one order, and the evidence last');

const EXAMPLE = FOUNDER_ACTION_CORPUS['gh-scope'];
const plain = renderFounderAction(EXAMPLE);
const headingsIn = (markdown) => markdown.split('\n').filter((line) => line.startsWith('## '));

check('the four headings are there, in one order',
      headingsIn(plain).join(' ') === '## What ## Why ## Steps ## Confirm', headingsIn(plain).join(' '));
check('the title is the first line, as a heading',
      plain.split('\n')[0] === `# ${EXAMPLE.title}`, plain.split('\n')[0]);
check('with no evidence there is no Evidence heading at all',
      !plain.includes('## Evidence'), 'the heading promises the reader something and shows nothing');
check('an evidence object with nothing in it is no evidence',
      !renderFounderAction(EXAMPLE, { command: '', said: '  ' }).includes('## Evidence'));

const withEvidence = renderFounderAction(EXAMPLE, {
  command: 'gh project item-list 5 --owner octo-founder',
  said: 'HTTP 403: your token has not been granted the required scopes',
  source: 'src/core/gh.ts',
});
check('with evidence the Evidence heading is last',
      headingsIn(withEvidence).join(' ') === '## What ## Why ## Steps ## Confirm ## Evidence',
      headingsIn(withEvidence).join(' '));
check('and the body before it is the body without it',
      withEvidence.startsWith(`${plain}\n\n## Evidence\n`), 'the evidence rewrote the founder half');
check('every part of the evidence supplied is in it',
      ['gh project item-list', 'not been granted', 'src/core/gh.ts']
        .every((part) => withEvidence.includes(part)));
check('and only the parts supplied',
      !renderFounderAction(EXAMPLE, { said: 'nothing worked' }).includes('- Command:'));

const numbered = renderFounderAction({ ...EXAMPLE, steps: ['Open it.', 'Read it.', 'Close it.'] });
check('the composer numbers the steps 1 to N',
      numbered.includes('\n1. Open it.\n2. Read it.\n3. Close it.\n'),
      numbered.split('## Steps')[1]?.split('## Confirm')[0]?.trim());
check('a step that arrived with its own number is not numbered twice',
      renderFounderAction({ ...EXAMPLE, steps: ['1. Open it.', '2. Read it.'] })
        .includes('\n1. Open it.\n2. Read it.\n'),
      'the ordinal belongs to the composer, so it is taken off the way in');

// ─── 3. The module is pure ───────────────────────────────────

console.log('\n3. the register imports nothing that reads a disk or starts a program');

const source = read(REGISTER);
const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s*'([^']+)'/gm)].map(([, from]) => from);
check('it imports nothing at all', imports.length === 0, imports.join(', '));
for (const forbidden of ['node:fs', 'node:child_process', 'child_process', 'node:process', 'fs']) {
  check(`nothing here imports ${forbidden}`, !imports.includes(forbidden));
}
check('and nothing here spawns anything',
      !/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(source));

for (const name of ['FounderActionKind', 'FounderActionFields', 'FounderActionEvidence',
                    'renderFounderAction', 'validateFounderAction', 'FOUNDER_ACTION_CORPUS']) {
  check(`it exports ${name}`,
        new RegExp(`export (?:type |interface |function |const )${name}\\b`).test(source));
}

// ─── 4. The document is the composer's output ────────────────

console.log(`\n4. every example in ${DOCUMENT} is what the composer produces`);

const document = read(DOCUMENT);

/** The fenced Markdown block under the heading that names a kind. */
function exampleFor(kind) {
  const heading = document.indexOf(`### \`${kind}\``);
  if (heading < 0) return null;
  const opened = document.indexOf('```markdown\n', heading);
  if (opened < 0) return null;
  const start = opened + '```markdown\n'.length;
  const closed = document.indexOf('\n```', start);
  return closed < 0 ? null : document.slice(start, closed);
}

/**
 * The evidence the worked example shows, which the document must show with it.
 *
 * An invented account, because a tracked file naming this owner's own board is what
 * `check-shipped-config-neutral.mjs` exists to refuse.
 */
const WORKED_EVIDENCE = {
  command: 'gh api repos/octo-founder/pantry/collaborators/octo-founder/permission',
  said: 'HTTP 403: Resource not accessible by personal access token',
  source: 'src/core/github-push.ts',
};

for (const kind of FOUNDER_ACTION_KINDS) {
  const shown = exampleFor(kind);
  const expected = kind === 'push-denied'
    ? renderFounderAction(FOUNDER_ACTION_CORPUS[kind], WORKED_EVIDENCE)
    : renderFounderAction(FOUNDER_ACTION_CORPUS[kind]);
  check(`the "${kind}" example is byte-identical to the composer's output`, shown === expected,
        shown === null
          ? 'no fenced markdown example under that heading'
          : `the document has ${shown.length} characters and the composer produces ${expected.length}`);
}

check('the worked example names an account nobody owns',
      document.includes('octo-founder') && !/vitorengers/i.test(document),
      'a document naming a real account is a document a fresh clone reads as instructions');

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
