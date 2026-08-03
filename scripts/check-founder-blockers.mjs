#!/usr/bin/env node
/**
 * Checks that the human blockers this product already detects are named, and that a probe
 * which cannot say produces nothing.
 *
 * Ten conditions were detected and merely refused, each already carrying finished remedy
 * text: a missing `gh`, a logged-out one, a token without the `project` scope, a refused
 * credential, a rate limit, a billing refusal, an account that cannot push, a missing agent
 * CLI, an agent nothing was granted for, and a spent usage window. This is the boundary
 * where each becomes a named condition with a stable key, and the boundary is the whole
 * risk: on one side there is a founder with a payment card, and on the other there is a
 * tool's stderr.
 *
 * Seven sections:
 *
 *  1. **every kind is reached, keyed and composable.** All ten of the register's kinds have
 *     a producer, a key that is the same on two calls, and a record `validateFounderAction`
 *     accepts — asserted over what `founderActionFor` produced, never over a record written
 *     by hand here. The holes a run fills in — the repository, the permission, the binary,
 *     the environment, the variable — are asserted present in the produced text.
 *  2. **`said` does not cross.** A distinctive sentinel is planted in a `TerminalGhFailure`'s
 *     stderr, where its `message` is the stderr and the remedy glued together. The sentinel
 *     has to appear in `evidence` and in no founder field, and the fixture carries an
 *     `Error:` prefix, an HTTP status and a path into this tree, so an implementation that
 *     passes `error.message` into `why` fails the register's machine-noise rules as well.
 *  3. **a probe that cannot say produces nothing.** `readPushAccess` is deliberately
 *     permissive, and the whole column depends on that generalising: `unknown` yields null,
 *     an environment the preflight could not probe yields null, and a limits reading older
 *     than `STALE_AFTER_SECONDS` yields null. Without this the column fills with cards about
 *     a bad network minute.
 *  4. **one fact is one key.** `gh` missing is detected twice and independently — once by
 *     the failure classifier and once by the preflight — and a snapshot carrying both has to
 *     produce one card rather than two.
 *  5. **the verifier settles all ten**, across satisfied, still-blocked and cannot-say
 *     snapshots. `push.verdict: 'unknown'` is cannot-say and is never either of the others,
 *     and every `why` is short enough to read and starts no line with a command.
 *  6. **the verifier imports only types**, and the frontend's own configuration can compile
 *     a file that names it. It names three probe results whose modules spawn processes; a
 *     value import would drag `child_process` into a graph the frontend compiles and fail
 *     checks in files nobody touched. The grep says what the file spells and the probe says
 *     what comes of it.
 *  7. **the full-access posture warning is not a blocker.** It is human-only and actionable
 *     and never blocks a run. Admit advice and the column fills with advice.
 *
 * Offline and self-contained: it imports the built modules, reads two tracked files, and
 * starts nothing. Run `./node_modules/.bin/tsc` first.
 *
 * Tier: fast
 *
 * Usage: node scripts/check-founder-blockers.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const built = (module) => pathToFileURL(join(repoRoot, 'dist', 'core', `${module}.js`)).href;

/**
 * A built module, or a failure that names it rather than a stack.
 *
 * The modules under test do not exist when this file is written, which is the point of
 * writing it first — and an unhandled `ERR_MODULE_NOT_FOUND` reports that as a crash rather
 * than as a red case.
 */
async function load(module) {
  try {
    return await import(built(module));
  } catch (error) {
    failures++;
    console.error(`  FAIL  dist/core/${module}.js can be imported — ${(error?.message ?? error)}`);
    return {};
  }
}

const blockers = await load('founder-blockers');
const verify = await load('founder-verify');
const register = await load('founder-action-text');
const gh = await load('gh');
const adapter = await load('agent-adapter');

const {
  blockerForGhFailure, blockerForGithubStatus, blockerForPushAccess, blockerForAgentPreflight,
  blockerForAgentUsage, founderActionFor, dedupeBlockers,
} = blockers;
const { verifyAgainst } = verify;
const { FOUNDER_ACTION_KINDS, FOUNDER_ACTION_CORPUS, validateFounderAction } = register;
const { TerminalGhFailure, REMEDY, classifyGhFailure } = gh;
const { fullAccessFlag } = adapter;

const EXPORTS = [
  ['founder-blockers', blockers, ['blockerForGhFailure', 'blockerForGithubStatus',
    'blockerForPushAccess', 'blockerForAgentPreflight', 'blockerForAgentUsage',
    'founderActionFor', 'dedupeBlockers']],
  ['founder-verify', verify, ['verifyAgainst']],
];

console.log('0. the two modules exist and export the vocabulary');

for (const [name, module, wanted] of EXPORTS) {
  for (const symbol of wanted) {
    check(`${name} exports ${symbol}`, typeof module[symbol] === 'function',
          `it is ${typeof module[symbol]}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  console.error('(nothing below can run against exports that are not there)');
  process.exit(1);
}

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');
const BLOCKERS_SOURCE = read('src/core/founder-blockers.ts');
const VERIFY_SOURCE = read('src/core/founder-verify.ts');

/**
 * The source with its comments taken out.
 *
 * A rule about what the code reads has to be asked of the code. These modules are required
 * to *explain* the boundary they hold — why `.message` is not read, why a posture warning is
 * not a blocker — and a rule that searched the prose would be a rule that punishes the
 * explanation.
 */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const BLOCKERS_CODE = withoutComments(BLOCKERS_SOURCE);

/** A failing `gh` as `runGh` hands one over: the tail, and the remedy in its own field. */
const terminal = (said) => new TerminalGhFailure(said, classifyGhFailure(said).remedy);

/** A limits reading, with only the fields a blocker may read spelled out. */
const reading = (over = {}) => ({
  label: 'Windows',
  environment: { kind: 'native' },
  account: 'founder@example.invalid',
  fiveHour: { usedPercent: 100, resetsAt: 1785500000 },
  sevenDay: null,
  observedAt: 1785499000,
  ageSeconds: 30,
  stale: false,
  ...over,
});

/** One preflight answer, for one role in one environment. */
const preflight = (over = {}) => ({
  role: 'implement',
  environment: 'native',
  variable: 'VIBEMAXXING_IMPLEMENT_AGENT',
  binary: 'claude',
  resolved: 'not found',
  ...over,
});

/** What `readGithubStatus` answers, with nothing invented beside it. */
const status = (over = {}) => ({
  resolved: 'found',
  version: '2.62.0',
  installed: true,
  authenticated: true,
  login: 'octo-founder',
  scopes: ['repo', 'read:org', 'project'],
  error: null,
  ...over,
});

/** Every founder-facing field of a record, as one piece of text. Evidence is not in it. */
const founderText = (fields) =>
  [fields?.title, fields?.what, fields?.why, fields?.confirm, ...(fields?.steps ?? [])].join('\n');

// ─── 1. Every kind reached, keyed, and composable ─────────────

console.log('\n1. every kind of the register has a producer, a stable key and a record');

/**
 * `[kind, what produces it, the run's own facts the produced record has to carry]`.
 *
 * The facts are the holes: a record that came back byte-identical to the corpus entry for a
 * blocker that knew the repository is a record that dropped what this run knew.
 */
const PRODUCERS = [
  ['gh-missing', () => blockerForGhFailure(terminal('gh: command not found')), []],
  ['gh-login',
   () => blockerForGhFailure(terminal('To get started with GitHub CLI, please run: gh auth login')),
   []],
  ['gh-scope',
   () => blockerForGhFailure(terminal('your token has not been granted the required scopes')),
   []],
  ['gh-credential', () => blockerForGhFailure(terminal('HTTP 401: Bad credentials')), []],
  // Not terminal, so `runGh` never wraps it: a producer that kept what gh said hands that
  // over, and the classification is the product's own rather than a second copy of it.
  ['gh-rate-limit',
   () => blockerForGhFailure({ said: 'HTTP 403: API rate limit exceeded for user ID 1' }),
   []],
  ['gh-billing',
   () => blockerForGhFailure(terminal('HTTP 402: Payment Required - billing must be settled')),
   []],
  ['push-denied',
   () => blockerForPushAccess({
     verdict: 'no', repo: 'octo-founder/pantry', permission: 'READ', why: '',
   }),
   ['octo-founder/pantry', 'READ']],
  ['agent-missing', () => blockerForAgentPreflight(preflight()), ['claude']],
  ['agent-not-granted',
   () => blockerForAgentPreflight(preflight({ resolved: 'unconfigured', binary: null })),
   ['VIBEMAXXING_IMPLEMENT_AGENT']],
  ['agent-usage-exhausted', () => blockerForAgentUsage(reading()), ['Windows']],
];

check('the register still has ten kinds', FOUNDER_ACTION_KINDS?.length === 10,
      `${FOUNDER_ACTION_KINDS?.length} kind(s)`);
check('and every one of them has a producer here',
      FOUNDER_ACTION_KINDS.every((kind) => PRODUCERS.some(([named]) => named === kind)),
      FOUNDER_ACTION_KINDS.filter((kind) => !PRODUCERS.some(([named]) => named === kind)).join(', '));

const keys = new Map();

for (const [kind, produce, facts] of PRODUCERS) {
  const blocker = produce();
  check(`a blocker for "${kind}" is produced`, blocker?.kind === kind,
        blocker ? `it answered "${blocker.kind}"` : 'it answered null');
  if (!blocker) continue;

  check(`the "${kind}" key is a non-empty string`,
        typeof blocker.key === 'string' && blocker.key.trim().length > 0,
        JSON.stringify(blocker.key));
  check(`and the same input keys the same way twice`, produce()?.key === blocker.key,
        `${produce()?.key} then ${blocker.key}`);
  keys.set(kind, blocker.key);

  const fields = founderActionFor(blocker);
  const { ok, faults } = validateFounderAction(fields);
  check(`the "${kind}" record breaks no rule of the register`, ok,
        faults?.map((fault) => `${fault.field}/${fault.rule}: ${fault.detail}`).join('; '));

  const said = founderText(fields);
  for (const fact of facts) {
    check(`the "${kind}" record carries what this run knew: ${fact}`, said.includes(fact),
          'the hole was never filled — the reader gets the corpus entry and none of their own facts');
  }
  if (facts.length === 0) {
    check(`the "${kind}" record is the corpus entry, which has no hole to fill`,
          said === founderText(FOUNDER_ACTION_CORPUS[kind]),
          'nothing about this blocker is specific to one run, so nothing may be invented into it');
  }
}

check('no two kinds share a key', new Set(keys.values()).size === keys.size,
      [...keys].map(([kind, key]) => `${kind}=${key}`).join(', '));

// ─── 2. What gh said reaches the evidence and nothing else ────

console.log('\n2. a tool\'s own output reaches the evidence and no founder field');

const SENTINEL = 'WOMBAT-4417-SENTINEL';
/**
 * A stderr tail with everything a founder field may not carry: a distinctive word to follow,
 * a tool's `Error:` prefix, an HTTP status, and a path into this tree.
 */
const NOISY = `Error: ${SENTINEL}: HTTP 403: your token has not been granted the required `
  + 'scopes. Classified in src/core/gh.ts and re-thrown.';

const noisy = terminal(NOISY);
check('the fixture is what a caller reading .message would get',
      noisy.message.includes(SENTINEL) && noisy.message.includes(noisy.remedy),
      'the glue in TerminalGhFailure is what this section exists to catch');

const noisyBlocker = blockerForGhFailure(noisy);
check('it is classified as a missing scope', noisyBlocker?.kind === 'gh-scope',
      noisyBlocker ? noisyBlocker.kind : 'null');

if (noisyBlocker) {
  const fields = founderActionFor(noisyBlocker);
  const { ok, faults } = validateFounderAction(fields);
  check('the record it produces breaks no rule', ok,
        faults?.map((fault) => `${fault.field}/${fault.rule}: ${fault.detail}`).join('; '));
  check('the sentinel is in no founder field', !founderText(fields).includes(SENTINEL),
        'what gh said was pasted into text written for a person');
  check('and it is in the evidence, where it belongs',
        String(noisyBlocker.evidence?.said ?? '').includes(SENTINEL),
        JSON.stringify(noisyBlocker.evidence));
  check('the evidence names where the failure was classified',
        String(noisyBlocker.evidence?.source ?? '').startsWith('src/'),
        JSON.stringify(noisyBlocker.evidence?.source));
}

// A bare Error carries the tail in `message` and nothing else. Reading it is the one way the
// stderr could reach a card, so nothing is produced from it at all.
check('a bare Error, whose only field is the glued message, produces nothing',
      blockerForGhFailure(new Error(NOISY)) === null,
      'the message is the stderr and the remedy glued together, and this boundary does not read it');
check('and the module never reads .message', !/\.message\b/.test(BLOCKERS_CODE),
      'said and remedy are separate fields precisely so a producer does not have to');

// ─── 3. A probe that cannot say produces nothing ──────────────

console.log('\n3. a probe that could not say refuses nobody');

const PUSH = [
  ['a verdict of no is a blocker', { verdict: 'no', repo: 'octo-founder/pantry', permission: 'READ', why: '' }, true],
  ['a verdict of yes is not', { verdict: 'yes', repo: 'octo-founder/pantry', permission: 'ADMIN', why: '' }, false],
  ['gh could not be asked at all', { verdict: 'unknown', repo: null, permission: null, why: 'gh could not answer' }, false],
  ['the origin is not on github.com', { verdict: 'unknown', repo: null, permission: null, why: 'this project has no origin on github.com' }, false],
  ['GitHub named no permission', { verdict: 'unknown', repo: 'octo-founder/pantry', permission: null, why: 'gh reported no viewerPermission for it' }, false],
];

for (const [name, access, wanted] of PUSH) {
  const blocker = blockerForPushAccess(access);
  check(`push access: ${name}`, Boolean(blocker) === wanted,
        blocker ? `it produced ${blocker.key}` : 'it produced null');
}

const PREFLIGHT = [
  ['not found', 'agent-missing'],
  ['unconfigured', 'agent-not-granted'],
  ['found', null],
  ['probing', null],
  ['unknown', null],
  ['not probed', null],
  ['unsupported', null],
];

for (const [resolved, wanted] of PREFLIGHT) {
  const blocker = blockerForAgentPreflight(preflight({ resolved }));
  check(`a "${resolved}" agent environment produces ${wanted ?? 'nothing'}`,
        (blocker?.kind ?? null) === wanted, `it produced ${blocker?.kind ?? 'null'}`);
}

check('a missing agent is keyed per role and environment',
      blockerForAgentPreflight(preflight()).key
        !== blockerForAgentPreflight(preflight({ environment: 'wsl' })).key
      && blockerForAgentPreflight(preflight()).key
        !== blockerForAgentPreflight(preflight({ role: 'issue' })).key,
      'one machine may be missing the implement agent and have the issue one');

const USAGE = [
  ['a window at 100% is a blocker', reading(), true],
  ['a window with room is not', reading({ fiveHour: { usedPercent: 99, resetsAt: null } }), false],
  ['a seven-day window counts too',
   reading({ fiveHour: null, sevenDay: { usedPercent: 100, resetsAt: null } }), true],
  ['a reading older than STALE_AFTER_SECONDS says nothing about now',
   reading({ stale: true, ageSeconds: 900 }), false],
  ['nor does one whose age says so even if the flag does not',
   reading({ stale: false, ageSeconds: 4000 }), false],
  ['an environment nobody has run a session in produces nothing',
   reading({ fiveHour: null, sevenDay: null, observedAt: null, ageSeconds: null }), false],
  ['and a reading with windows but no moment produces nothing',
   reading({ observedAt: null, ageSeconds: null }), false],
];

for (const [name, entry, wanted] of USAGE) {
  const blocker = blockerForAgentUsage(entry);
  check(`usage: ${name}`, Boolean(blocker) === wanted,
        blocker ? `it produced ${blocker.key}` : 'it produced null');
}

const STATUS = [
  ['a CLI that answers and is signed in with the scope', status(), null],
  ['a CLI that is not there', status({ resolved: 'not found', installed: false, authenticated: false, login: null, scopes: [], error: 'gh: command not found' }), 'gh-missing'],
  ['a CLI that neither answered nor reported itself missing',
   status({ resolved: 'unknown', installed: false, authenticated: false, login: null, scopes: [] }), null],
  ['a probe that has not landed yet', status({ resolved: 'probing', installed: false, authenticated: false, login: null, scopes: [] }), null],
  ['a CLI signed in to nothing', status({ authenticated: false, login: null, scopes: [], error: 'You are not logged into any GitHub hosts' }), 'gh-login'],
  ['a sign-in without the project scope', status({ scopes: ['repo', 'read:org'] }), 'gh-scope'],
  ['a sign-in that listed no scopes at all', status({ scopes: [] }), null],
];

for (const [name, entry, wanted] of STATUS) {
  const blocker = blockerForGithubStatus(entry);
  check(`github status: ${name} produces ${wanted ?? 'nothing'}`,
        (blocker?.kind ?? null) === wanted, `it produced ${blocker?.kind ?? 'null'}`);
}

// ─── 4. One missing gh is one card ───────────────────────────

console.log('\n4. one fact detected twice is one key');

const fromFailure = blockerForGhFailure(terminal('gh: command not found'));
const fromStatus = blockerForGithubStatus(status({
  resolved: 'not found', installed: false, authenticated: false, login: null, scopes: [],
  error: 'gh: command not found',
}));

check('both detectors reach the same kind',
      fromFailure?.kind === 'gh-missing' && fromStatus?.kind === 'gh-missing',
      `${fromFailure?.kind} and ${fromStatus?.kind}`);
check('and key it identically', fromFailure?.key === fromStatus?.key,
      `${fromFailure?.key} then ${fromStatus?.key}`);

const deduped = dedupeBlockers([fromFailure, null, fromStatus]);
check('a snapshot carrying both produces one blocker', deduped.length === 1,
      deduped.map((blocker) => blocker.key).join(', '));
check('and it keeps the evidence of the one it kept',
      Boolean(deduped[0]?.evidence), JSON.stringify(deduped[0]?.evidence));
check('two different facts stay two',
      dedupeBlockers([fromFailure, blockerForPushAccess({
        verdict: 'no', repo: 'octo-founder/pantry', permission: 'READ', why: '',
      })]).length === 2);

// ─── 5. The verifier ─────────────────────────────────────────

console.log('\n5. the verifier settles every kind, and blames nobody it cannot');

const SIGNED_OUT = status({ authenticated: false, login: null, scopes: [] });
const ABSENT = status({
  resolved: 'not found', installed: false, authenticated: false, login: null, scopes: [],
});
const CANNOT = status({
  resolved: 'unknown', installed: false, authenticated: false, login: null, scopes: [],
});

const pushed = (verdict, permission) =>
  ({ push: { verdict, repo: 'octo-founder/pantry', permission, why: '' } });
const agent = (resolved) => ({ agent: { backend: 'claude', resolved, version: null } });

/** `[kind, what the board can see now, what that settles]`. */
const VERDICTS = [
  ['gh-missing', { github: status() }, 'satisfied'],
  ['gh-missing', { github: ABSENT }, 'still-blocked'],
  ['gh-missing', { github: CANNOT }, 'cannot-say'],
  ['gh-missing', {}, 'cannot-say'],

  ['gh-login', { github: status() }, 'satisfied'],
  ['gh-login', { github: SIGNED_OUT }, 'still-blocked'],
  ['gh-login', { github: ABSENT }, 'cannot-say'],

  ['gh-scope', { github: status() }, 'satisfied'],
  ['gh-scope', { github: status({ scopes: ['repo', 'read:org'] }) }, 'still-blocked'],
  ['gh-scope', { github: status({ scopes: [] }) }, 'cannot-say'],
  ['gh-scope', { github: SIGNED_OUT }, 'cannot-say'],

  ['gh-credential', { github: status() }, 'satisfied'],
  ['gh-credential', { github: SIGNED_OUT }, 'still-blocked'],
  ['gh-credential', { github: CANNOT }, 'cannot-say'],

  // Nothing can confirm a wait has lifted or a bill has been paid except the next call that
  // succeeds, and this module makes none.
  ['gh-rate-limit', { github: status() }, 'cannot-say'],
  ['gh-rate-limit', { github: ABSENT }, 'cannot-say'],
  ['gh-rate-limit', {}, 'cannot-say'],
  ['gh-billing', { github: status() }, 'cannot-say'],
  ['gh-billing', { github: ABSENT }, 'cannot-say'],
  ['gh-billing', {}, 'cannot-say'],

  ['push-denied', pushed('yes', 'ADMIN'), 'satisfied'],
  ['push-denied', pushed('no', 'READ'), 'still-blocked'],
  ['push-denied', pushed('unknown', null), 'cannot-say'],
  ['push-denied', {}, 'cannot-say'],

  ['agent-missing', agent('found'), 'satisfied'],
  ['agent-missing', agent('not found'), 'still-blocked'],
  ['agent-missing', agent('unknown'), 'cannot-say'],
  ['agent-missing', {}, 'cannot-say'],

  ['agent-not-granted', agent('found'), 'satisfied'],
  ['agent-not-granted', agent('unconfigured'), 'still-blocked'],
  ['agent-not-granted', agent('not probed'), 'cannot-say'],
  ['agent-not-granted', {}, 'cannot-say'],

  ['agent-usage-exhausted', agent('found'), 'cannot-say'],
  ['agent-usage-exhausted', {}, 'cannot-say'],
];

const settlements = new Map();

for (const [kind, snapshot, wanted] of VERDICTS) {
  const verdict = verifyAgainst(kind, snapshot);
  check(`${kind}: ${JSON.stringify(snapshot).slice(0, 70)} settles ${wanted}`,
        verdict?.settled === wanted, `it settled ${verdict?.settled} — ${verdict?.why}`);
  settlements.set(kind, new Set([...(settlements.get(kind) ?? []), verdict?.settled]));
}

check('every kind of the register is settled by the verifier',
      FOUNDER_ACTION_KINDS.every((kind) => settlements.has(kind)),
      FOUNDER_ACTION_KINDS.filter((kind) => !settlements.has(kind)).join(', '));

/** The three kinds nothing here can confirm, and the reason is the same for all three. */
const NEVER_SETTLED = ['gh-rate-limit', 'gh-billing', 'agent-usage-exhausted'];
for (const kind of NEVER_SETTLED) {
  check(`"${kind}" is honest about never being able to say`,
        [...(settlements.get(kind) ?? [])].every((settled) => settled === 'cannot-say'),
        [...(settlements.get(kind) ?? [])].join(', '));
}
for (const kind of FOUNDER_ACTION_KINDS.filter((named) => !NEVER_SETTLED.includes(named))) {
  const seen = settlements.get(kind) ?? new Set();
  check(`"${kind}" can reach all three answers`, seen.size === 3, [...seen].join(', '));
}

// An unknown push verdict is the rule the whole module generalises from: it may never close
// an action and may never blame anybody.
for (const permission of [null, 'READ', 'ADMIN']) {
  const verdict = verifyAgainst('push-denied', pushed('unknown', permission));
  check(`an unknown push verdict with ${permission ?? 'no'} permission is only ever cannot-say`,
        verdict?.settled === 'cannot-say', `it settled ${verdict?.settled}`);
}

console.log('\n   and every reason is one a person can read');

/** A `why` may not start a line with something a reader would mistake for a command. */
const COMMAND_START = /^\s*(gh|node|npm|Error:)/i;
const WHY_LIMIT = 160;

for (const [kind, snapshot] of VERDICTS) {
  const { why } = verifyAgainst(kind, snapshot) ?? {};
  const lines = String(why ?? '').split(/\r?\n/);
  check(`the reason for ${kind} is written, and inside ${WHY_LIMIT} characters`,
        typeof why === 'string' && why.trim().length > 0 && why.length <= WHY_LIMIT,
        `${String(why).length} characters: ${String(why).slice(0, 60)}`);
  check(`and starts no line with a command`, !lines.some((line) => COMMAND_START.test(line)),
        lines.find((line) => COMMAND_START.test(line)));
}

check('a kind nothing here knows is cannot-say rather than a throw',
      verifyAgainst('something-else-entirely', {})?.settled === 'cannot-say',
      JSON.stringify(verifyAgainst('something-else-entirely', {})));

// ─── 6. The verifier imports only types ──────────────────────

console.log('\n6. the verifier names three probe results and imports none of their code');

const importLines = VERIFY_SOURCE.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line));
check('it imports something', importLines.length > 0, 'a module naming nothing proves nothing');
const valueImports = importLines.filter((line) => !/^\s*import\s+type\b/.test(line));
check('and every one of them is an import of types alone', valueImports.length === 0,
      valueImports.join(' | '));
check('nothing here requires anything either', !/\brequire\s*\(/.test(VERIFY_SOURCE));
for (const named of ['GithubStatus', 'PushAccess']) {
  check(`it names ${named}`, new RegExp(`\\b${named}\\b`).test(VERIFY_SOURCE));
}

/**
 * And the graph is compiled rather than read.
 *
 * A grep over the import lines says what the file spells; it cannot say what the frontend's
 * own configuration makes of the modules behind them. The probe is a project that `extends`
 * `frontend/tsconfig.json` rather than restating its flags — the pattern
 * `check-frontend-types.mjs` uses, and for its reason: a probe with hand-written options
 * would keep passing after somebody loosened the file that actually runs. It lives under
 * `node_modules` so the walk up finds the real one.
 */
const scratch = mkdtempSync(join(repoRoot, 'node_modules', '.founder-verify-'));
try {
  writeFileSync(join(scratch, 'probe.ts'),
                "import { verifyAgainst } from '../../src/core/founder-verify.js'\n"
                + "export const settled = verifyAgainst('gh-missing', {}).settled\n", 'utf8');
  writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({
    extends: join(repoRoot, 'frontend', 'tsconfig.json').replace(/\\/g, '/'),
    include: [],
    files: ['./probe.ts'],
  }, null, 2), 'utf8');

  const run = spawnSync(process.execPath,
                        [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
                         '--noEmit', '-p', scratch],
                        { cwd: repoRoot, encoding: 'utf8' });
  const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  check('the frontend\'s own configuration can compile a file that names it',
        run.status === 0 && said === '',
        said.split('\n').slice(0, 10).join('\n        ') || `exit ${run.status}`);
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a Windows lock */ }
}

// ─── 7. Advice is not a blocker ──────────────────────────────

console.log('\n7. the full-access posture warning produces no blocker');

const FULL_ACCESS = 'claude --dangerously-skip-permissions -p';
check('the flag is one this board recognises', Boolean(fullAccessFlag?.(FULL_ACCESS)),
      'the fixture has to be a posture this product really warns about');
check('an agent that runs is no blocker, whatever its command line grants',
      blockerForAgentPreflight(preflight({ resolved: 'found', binary: 'claude' })) === null);
check('and the register has no kind for a posture at all',
      !FOUNDER_ACTION_KINDS.some((kind) => /posture|permission|access/.test(kind)),
      FOUNDER_ACTION_KINDS.join(', '));
check('the module says why it is not one', /posture/i.test(BLOCKERS_SOURCE),
      'admit advice and the column fills with advice, so the boundary is commented');

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
