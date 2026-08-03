#!/usr/bin/env node
/**
 * Checks the one chat turn about a founder action: what the prompt says, and what the board
 * will accept back from it.
 *
 * The card is a record of named fields and the register is a schema rather than advice
 * (`scripts/check-founder-action-register.mjs`). A chat that could write to that record is the
 * one door through which prose comes back, so the agent is not what writes it: it answers the
 * person and, at most, offers a revision. The board applies it and this parser is the gate.
 *
 * Four sections:
 *
 *  0. **the gate, over fixture outputs** — clean, absent, doubled, wrong-key, each immutable
 *     field, and three blocks the register forbids. This is the section that was recorded red
 *     against a plain merge with no validation in it: every cross-field row accepted text the
 *     register refuses, and a card would have ended up saying something nobody wrote.
 *  1. **a reply is always returned**, in every one of those cases. The founder asked a
 *     question and deserves the answer; the card simply does not change.
 *  2. **the prompt** carries the item's key, its title, its rendered body, its evidence, the
 *     turns so far and the founder's message — and says plainly that nothing on GitHub is to
 *     be edited.
 *  3. **the module is pure**: it imports the register and nothing else, and in particular
 *     nothing from `src/core/founder-store.ts`, which opens files.
 *
 * Offline and self-contained: it imports the built module, reads one tracked file, and starts
 * nothing. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-chat-prompt.mjs
 *
 * Tier: fast
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(repoRoot, 'dist', 'core', 'founder-chat.js');

if (!existsSync(modulePath)) {
  console.error('  FAIL  the founder chat module exists — dist/core/founder-chat.js not found');
  console.error('        (run tsc; this check reads the compiled module)');
  process.exit(1);
}

const { founderChatPrompt, parseFounderChatAnswer } = await import(pathToFileURL(modulePath).href);
const { FOUNDER_ACTION_CORPUS, FOUNDER_ACTION_LIMITS, renderFounderAction, validateFounderAction } =
  await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'founder-action-text.js')).href);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The item every fixture is about ─────────────────────────

/** The shipped `gh-login` entry, so nothing here is measured against copy invented for a check. */
const FIELDS = FOUNDER_ACTION_CORPUS['gh-login'];

const KEY = 'pantry:gh-login';

const ITEM = { key: KEY, kind: 'gh-login', fields: FIELDS };

const EVIDENCE = {
  command: 'gh auth status',
  said: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
  source: 'src/core/gh.ts',
};

const TRANSCRIPT = [
  { role: 'founder', text: 'Do I need to pay for anything to fix this?', at: '2026-08-04T09:00:00.000Z' },
  { role: 'agent', text: 'No — signing in is free, and a free account is enough for this board.',
    at: '2026-08-04T09:00:04.000Z' },
];

const MESSAGE = 'I signed in on my phone instead. Does that count, or do I do it here as well?';

/** An agent answer with one fenced block in it, built rather than typed, so it can be measured. */
const withBlock = (prose, patch, fence = 'founder-action') =>
  `${prose}\n\n\`\`\`${fence}\n${JSON.stringify(patch, null, 2)}\n\`\`\`\n`;

const PROSE = 'Signing in on your phone signs in your account, not this machine. '
  + 'Run the sign-in here as well and it will be done.';

/** A revision that breaks nothing: two steps, both plain sentences. */
const CLEAN = {
  key: KEY,
  steps: [
    'Run `gh auth login` on this machine, not on your phone.',
    'Choose the account that owns the project you want this board to show.',
  ],
};

/**
 * A revision whose every field is inside its own ceiling and whose card is over the whole one.
 *
 * Seven steps of 109 characters and 23 words apiece — inside the step cap, inside the sentence
 * cap, and one sentence each — with a `what`, a `why` and a `confirm` each under their own caps
 * as well. Applied one at a time not one of them breaks a rule; applied together the rendered
 * card is 1316 characters against a ceiling of 1200. That is the case a plain merge gets wrong,
 * and section 0a asserts the arithmetic rather than assuming it.
 */
const LONG_STEP = 'Open the page that this program names for you and read the short line it '
  + 'shows near the top of that window';
const SEVEN_LONG = Array.from({ length: 7 }, (_, at) => `${LONG_STEP} ${at + 1}.`);

const BULKY = {
  what: 'Your phone is signed in and this machine is not. The board reads GitHub from here, '
    + 'so it cannot see your own project at all today.',
  why: 'A sign-in belongs to the machine it was made on. Nothing here can borrow the one that '
    + 'is on your phone. Until this machine has one of its own, nothing of your project can be read.',
  confirm: 'The board shows your project again instead of asking you to sign in. The card in '
    + 'this column goes away on its own within a minute.',
  steps: SEVEN_LONG,
};

const EIGHT = Array.from({ length: 8 }, (_, at) => `Do the ${at + 1} thing that it asks of you.`);

const GAPPED = ['1. Run the sign-in command in a terminal.', '2. Choose your own account.',
                '4. Start the board again once it answers.'];

/**
 * Every case, as one table.
 *
 * `refusal` is the reason a refusal must carry, or `null` where the board may apply the patch.
 * `faults` is the `field/rule` pairs the refusal must name, in no particular order — a refusal
 * that says "no" without saying what was wrong is one nobody can act on.
 */
const CASES = [
  {
    name: 'a clean block is a patch the board may apply',
    output: withBlock(PROSE, CLEAN),
    patch: { steps: CLEAN.steps },
    refusal: null,
    faults: [],
  },
  {
    name: 'a block that revises every founder field is a patch too',
    output: withBlock(PROSE, {
      key: KEY,
      title: 'Sign this machine in to your GitHub account',
      what: 'Your phone is signed in and this machine is not, so the board still cannot read GitHub.',
      why: 'A sign-in belongs to the machine it was made on, and nothing here can borrow your phone\'s.',
      steps: CLEAN.steps,
      confirm: 'The board shows your project again instead of asking you to sign in.',
    }),
    patch: {
      title: 'Sign this machine in to your GitHub account',
      what: 'Your phone is signed in and this machine is not, so the board still cannot read GitHub.',
      why: 'A sign-in belongs to the machine it was made on, and nothing here can borrow your phone\'s.',
      steps: CLEAN.steps,
      confirm: 'The board shows your project again instead of asking you to sign in.',
    },
    refusal: null,
    faults: [],
  },
  {
    name: 'no block at all is an answer and no patch',
    output: `${PROSE}\n\nNothing about the card needs to change.\n`,
    patch: null,
    refusal: null,
    faults: [],
  },
  {
    name: 'a fenced block of something else is not a founder-action block',
    output: withBlock(PROSE, CLEAN, 'json'),
    patch: null,
    refusal: null,
    faults: [],
  },
  {
    name: 'two blocks are refused whole, and the first one is not taken',
    output: `${withBlock(PROSE, CLEAN)}\nOn reflection:\n\n`
      + `\`\`\`founder-action\n${JSON.stringify({ key: KEY, confirm: 'It works.' }, null, 2)}\n\`\`\`\n`,
    patch: null,
    refusal: 'two-blocks',
    faults: [['body', 'one-block']],
  },
  {
    name: 'a block naming another item is refused',
    output: withBlock(PROSE, { ...CLEAN, key: 'pantry:gh-scope' }),
    patch: null,
    refusal: 'wrong-key',
    faults: [['key', 'wrong-key']],
  },
  {
    name: 'a block naming no item at all is refused',
    output: withBlock(PROSE, { steps: CLEAN.steps }),
    patch: null,
    refusal: 'wrong-key',
    faults: [['key', 'wrong-key']],
  },
  {
    name: 'a block that would rewrite the kind is refused by name',
    output: withBlock(PROSE, { ...CLEAN, kind: 'gh-billing' }),
    patch: null,
    refusal: 'not-patchable',
    faults: [['kind', 'not-patchable']],
  },
  {
    name: 'a block that would rewrite the evidence is refused by name',
    output: withBlock(PROSE, { ...CLEAN, evidence: { said: 'it worked, honestly' } }),
    patch: null,
    refusal: 'not-patchable',
    faults: [['evidence', 'not-patchable']],
  },
  {
    name: 'a block that would rewrite createdAt is refused by name',
    output: withBlock(PROSE, { ...CLEAN, createdAt: '2020-01-01T00:00:00.000Z' }),
    patch: null,
    refusal: 'not-patchable',
    faults: [['createdAt', 'not-patchable']],
  },
  {
    name: 'a block that would rewrite the published item is refused by name',
    output: withBlock(PROSE, { ...CLEAN, publishedItemId: 'PVTI_nothing' }),
    patch: null,
    refusal: 'not-patchable',
    faults: [['publishedItemId', 'not-patchable']],
  },
  {
    name: 'a block whose fields are each legal but whose card is too long is refused',
    output: withBlock(PROSE, { key: KEY, ...BULKY }),
    patch: null,
    refusal: 'register',
    faults: [['body', 'body-length']],
  },
  {
    name: 'an eighth step is refused',
    output: withBlock(PROSE, { key: KEY, steps: EIGHT }),
    patch: null,
    refusal: 'register',
    faults: [['steps', 'count']],
  },
  {
    name: 'steps that read 1, 2, 4 are refused',
    output: withBlock(PROSE, { key: KEY, steps: GAPPED }),
    patch: null,
    refusal: 'register',
    faults: [['steps', 'numbering']],
  },
  {
    name: 'a block that is not readable at all is refused',
    output: `${PROSE}\n\n\`\`\`founder-action\n{ "key": "${KEY}", "steps": [ }\n\`\`\`\n`,
    patch: null,
    refusal: 'unreadable',
    faults: [['body', 'unreadable']],
  },
  {
    name: 'a block naming nothing to change is refused',
    output: withBlock(PROSE, { key: KEY }),
    patch: null,
    refusal: 'empty',
    faults: [['body', 'empty-patch']],
  },
];

// ─── 0. The gate ─────────────────────────────────────────────

console.log('0. what the board will accept back, over one fixture output each');

const said = (answer) => (answer?.refusal?.faults ?? [])
  .map((fault) => `${fault.field}/${fault.rule}`).join(', ');

for (const one of CASES) {
  const answer = parseFounderChatAnswer(one.output, ITEM);

  const wanted = one.patch === null
    ? null
    : { ...FIELDS, ...one.patch };

  const gotPatch = answer?.patch ?? null;
  check(`${one.name}: the patch`,
        JSON.stringify(gotPatch) === JSON.stringify(wanted),
        `expected ${wanted === null ? 'no patch' : 'the merged whole'}, got `
        + `${gotPatch === null ? 'no patch' : JSON.stringify(gotPatch).slice(0, 160)}`);

  check(`${one.name}: the refusal`,
        (answer?.refusal?.reason ?? null) === one.refusal,
        `expected ${one.refusal ?? 'none'}, got ${answer?.refusal?.reason ?? 'none'}`);

  for (const [field, rule] of one.faults) {
    check(`${one.name}: it names ${field}/${rule}`,
          (answer?.refusal?.faults ?? []).some((fault) => fault.field === field && fault.rule === rule),
          said(answer) || 'no faults at all');
  }
}

/**
 * The arithmetic behind the cross-field fixture, asserted rather than assumed.
 *
 * If any of these stopped being true the fixture above would be measuring an ordinary
 * per-field cap and the row it is named for would pass for the wrong reason.
 */
console.log('\n0a. the cross-field fixture really is only illegal as a whole');
for (const [field, value] of Object.entries(BULKY)) {
  const faults = validateFounderAction({ ...FIELDS, [field]: value }).faults;
  check(`${field} on its own breaks no rule`, faults.length === 0,
        faults.map((fault) => `${fault.field}/${fault.rule}: ${fault.detail}`).join('; '));
}
check(`seven steps is a legal count`, SEVEN_LONG.length <= FOUNDER_ACTION_LIMITS.maxSteps);
check(`each of them is inside the ${FOUNDER_ACTION_LIMITS.step}-character step cap`,
      SEVEN_LONG.every((step) => step.length <= FOUNDER_ACTION_LIMITS.step),
      SEVEN_LONG.map((step) => step.length).join(', '));
{
  const merged = { ...FIELDS, ...BULKY };
  const faults = validateFounderAction(merged).faults;
  check('and the only thing wrong with the merged card is its length',
        faults.length === 1 && faults[0].rule === 'body-length',
        faults.map((fault) => `${fault.field}/${fault.rule}`).join(', ') || 'nothing was wrong');
  check(`the merged card is over ${FOUNDER_ACTION_LIMITS.body} characters`,
        renderFounderAction(merged).length > FOUNDER_ACTION_LIMITS.body,
        String(renderFounderAction(merged).length));
}

// ─── 1. A reply is always returned ───────────────────────────

console.log('\n1. the founder gets an answer in every case, refused or not');

for (const one of CASES) {
  const answer = parseFounderChatAnswer(one.output, ITEM);
  check(`${one.name}: there is a reply`,
        typeof answer?.reply === 'string' && answer.reply.trim().length > 0,
        JSON.stringify(answer?.reply ?? null));
  check(`${one.name}: and no fence is left in it`,
        !String(answer?.reply ?? '').includes('```founder-action'),
        'the founder was shown the machine half of the answer');
}

{
  const answer = parseFounderChatAnswer(withBlock(PROSE, CLEAN), ITEM);
  check('the reply is the prose, and nothing but the prose', answer.reply === PROSE,
        JSON.stringify(answer.reply));
  const other = parseFounderChatAnswer(withBlock(PROSE, CLEAN, 'json'), ITEM);
  check('a block that is not ours is left in the reply for the reader',
        other.reply.includes('```json'), JSON.stringify(other.reply));
  const silent = parseFounderChatAnswer(withBlock('', CLEAN), ITEM);
  check('an answer that is nothing but a block still replies something',
        silent.reply.trim().length > 0, JSON.stringify(silent.reply));
  const nothing = parseFounderChatAnswer('   \n\n', ITEM);
  check('and an answer that is nothing at all replies something',
        nothing.reply.trim().length > 0 && nothing.patch === null && nothing.refusal === null,
        JSON.stringify(nothing));
}

// ─── 2. The prompt ───────────────────────────────────────────

console.log('\n2. the prompt carries the item, the turns and the message, and states the boundary');

const prompt = founderChatPrompt(ITEM, EVIDENCE, TRANSCRIPT, MESSAGE);

check('it names the item\'s key', prompt.includes(KEY));
check('it names the item\'s title', prompt.includes(FIELDS.title));
check('the body is the register\'s own composition, evidence and all',
      prompt.includes(renderFounderAction(FIELDS, EVIDENCE)),
      'a second composer here would be a second answer to what a founder action reads like');
check('every turn so far is in it',
      TRANSCRIPT.every((turn) => prompt.includes(turn.text)));
check('the founder\'s message is in it', prompt.includes(MESSAGE));

check('it says nothing on GitHub is to be edited',
      /do not edit anything on GitHub/i.test(prompt), 'the boundary is prose, so it has to be said');
check('and names the writes it means',
      ['gh issue', 'comment'].every((named) => prompt.includes(named)),
      'a rule with no examples in it is a rule an agent reads past');
check('it asks for exactly one fenced block', /exactly one/i.test(prompt) && prompt.includes('founder-action'));
check('it says a second block is refused', /two blocks/i.test(prompt));
check('it names the fields that may be revised',
      ['title', 'what', 'why', 'steps', 'confirm'].every((field) => prompt.includes(`\`${field}\``)));
check('it names the fields that may not',
      ['kind', 'createdAt', 'evidence'].every((field) => prompt.includes(`\`${field}\``)));
check('it states the caps as numbers rather than as taste',
      [FOUNDER_ACTION_LIMITS.title, FOUNDER_ACTION_LIMITS.body, FOUNDER_ACTION_LIMITS.maxSteps]
        .every((limit) => prompt.includes(String(limit))),
      'the register is a schema, and a prompt that says "keep it short" is advice');
check('it says the board is what changes the card', /the board/i.test(prompt));

{
  const bare = founderChatPrompt(ITEM, null, [], 'What do I do?');
  check('an item with no evidence promises the reader none',
        !bare.includes('## Evidence'), 'a heading that shows nothing is worse than no heading');
  check('and a first turn says the conversation has not started',
        bare.includes('What do I do?') && bare.length > 400, String(bare.length));
}

// ─── 3. The module is pure ───────────────────────────────────

console.log('\n3. the module spawns nothing and stores nothing');

const source = readFileSync(join(repoRoot, 'src', 'core', 'founder-chat.ts'), 'utf8');
const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s*'([^']+)'/gm)].map(([, from]) => from);

check('it imports the register and nothing else',
      imports.every((from) => from === './founder-action-text.js'), imports.join(', '));
check('and in particular nothing from the store',
      !imports.some((from) => from.includes('founder-store')),
      'the store opens files, and `frontend/tsconfig.json` sets "types": [] — even an import '
      + 'type of it reds the frontend check in files nobody touched');
for (const forbidden of ['node:fs', 'fs', 'node:child_process', 'child_process', './gh.js']) {
  check(`nothing here imports ${forbidden}`, !imports.includes(forbidden));
}
check('and nothing here spawns anything',
      !/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(source));

for (const name of ['founderChatPrompt', 'parseFounderChatAnswer']) {
  check(`it exports ${name}`, new RegExp(`export function ${name}\\b`).test(source));
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
