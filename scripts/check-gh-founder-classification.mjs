#!/usr/bin/env node
/**
 * Checks that a rate limit and a billing refusal are told apart from a wrong URL.
 *
 * `classifyGhFailure` walked a table ordered most-specific-first, and the last row before the
 * fallback matched `\bHTTP 40[34]\b`. GitHub's secondary rate limiting arrives as an HTTP 403,
 * so a founder who had hit one was answered with `REMEDY.target` — "Check the owner, repository
 * or project number in the URL" — about a URL that was perfectly correct. A whole-tree grep for
 * 402, 429, `rate limit`, `billing`, `quota` or `payment` found nothing anywhere in `src/`
 * (#534).
 *
 * Two classes sit ahead of the `target` row now:
 *
 *  - **wait**, deliberately *not* terminal. The class exists so a producer can tell a
 *    founder-blocking condition from a bad network minute, not to stop retrying — `runGh` must
 *    still spend all three attempts on one, because a rate limit really can clear.
 *  - **billing**, which *is* terminal, and whose remedy names the account's billing page
 *    instead of the URL. No wait clears an unpaid account.
 *
 * Both statuses are GitHub's own: "Both primary and secondary rate limits return either `403`
 * or `429` responses", and "if the `retry-after` response header is present, you should not
 * retry your request until after that many seconds has elapsed" —
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 *
 * Seven sections:
 *
 *  1. **A secondary rate limit is the wait class**, and is not answered with `REMEDY.target`.
 *  2. **An HTTP 429 is the same class**, and the retry-after seconds are named when GitHub
 *     supplied them.
 *  3. **402, payment required and quota exceeded are the billing class**, terminal, naming
 *     what to top up. Including the one that arrives as a 403 and would otherwise be `target`.
 *  4. **The five existing classes are untouched** — install, scope, credential, login, target,
 *     row by row over the same samples the existing checks use. Reordering a most-specific-first
 *     table is what risks shadowing, and this is the proof it shadowed nothing.
 *  5. **A rate-limited call is still retried by `runGh`**, three spawns and both backoffs.
 *  6. **`TerminalGhFailure` carries `said` and `remedy` as separate fields** for both new
 *     classes, so a producer can use the remedy without the stderr.
 *  7. **`REMEDY` is exported**, and every assertion above is written against the exported
 *     object rather than restating a sentence. Two copies of one remedy is how two authors of
 *     it start to drift.
 *
 * Self-contained: no server, no browser, no GitHub account. Section 5 spawns a stub `gh` in a
 * throwaway directory that counts its own invocations; the rest is the classifier alone.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-gh-founder-classification.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── What each failure looks like coming out of a real gh ─────

/**
 * Transcribed rather than invented.
 *
 * `GitHub API rate limit exceeded. Please wait a minute and try again.`, `retry-after` and the
 * `gh: %s (HTTP %d)` shape every other sample here wears are literal strings in the gh 2.96.0
 * binary on this machine. The 403 and 429 statuses and the retry-after header are GitHub's,
 * from the REST rate-limit documentation linked in the banner; `quota_exceeded` with an HTTP
 * 402 is what a GitHub account over its monthly quota answers.
 *
 * The five existing samples below are copied from `scripts/check-gh-retry-policy.mjs` on
 * purpose: a regression row is only worth something if it is the same string the class was
 * already known to match.
 */
const SAYS = {
  // ── the wait class ──
  secondary: 'gh: You have exceeded a secondary rate limit and have been temporarily blocked '
    + 'from content creation. Please retry your request again later. (HTTP 403)',
  primary: 'gh: API rate limit exceeded for user ID 4211203. If you reach out to GitHub Support '
    + 'for help, please include the request ID C4E2:1F30A:9B21C4:1204FF3. (HTTP 403)',
  abuse: 'gh: You have triggered an abuse detection mechanism. Please wait a few minutes before '
    + 'you try again. (HTTP 403)',
  tooMany: 'gh: API rate limit exceeded (HTTP 429)\nretry-after: 60',
  tooManyBare: 'gh: Too Many Requests (HTTP 429)',
  ghsOwn: 'GitHub API rate limit exceeded. Please wait a minute and try again.',

  // ── the billing class ──
  paymentRequired: 'gh: Payment Required (HTTP 402)',
  quota: 'gh: quota_exceeded: You have exceeded your monthly quota (HTTP 402)',
  // The one that matters most: a billing refusal wearing the same 403 as a wrong URL.
  billing403: 'gh: Billing for this account is not configured. Add a payment method to '
    + 'continue. (HTTP 403)',

  // ── the five that were already classified, unchanged ──
  scope: "gh: Your token has not been granted the required scopes to execute this query. "
    + "The 'id' field requires one of the following scopes: ['read:project'], but your token "
    + "has only been granted the: ['admin:public_key', 'gist', 'read:org', 'repo', 'workflow'] "
    + "scopes. Please modify your token's scopes at: https://github.com/settings/tokens.",
  scopeCli: 'error: your authentication token is missing required scopes [read:project]\n'
    + 'To request it, run:  gh auth refresh -s read:project',
  loggedOut: 'To get started with GitHub CLI, please run:  gh auth login\n'
    + 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API '
    + 'authentication token.',
  credentials: 'gh: Bad credentials (HTTP 401)',
  forbidden: 'gh: Resource not accessible by personal access token (HTTP 403)',
  notFound: 'gh: Not Found (HTTP 404)',
  unresolvable: "Could not resolve to a Repository with the name 'vitorengers/nothing-here'.",
  notInstalledInDistro: 'bash: line 1: gh: command not found',
  spawnFailure: "spawn C:\\Program Files\\GitHub CLI\\gh.exe ENOENT",
  unknownField: 'Unknown JSON field: "closedByPullRequestsReferences"\n'
    + 'Available fields: assignees, author, body, closed, comments, number, state, title, url',

  // The blip the whole retry policy was written for, and the control for section 5.
  socket: 'error connecting to api.github.com: dial tcp 140.82.121.6:443: An operation on a '
    + 'socket could not be performed because the system lacked sufficient buffer space or '
    + 'because a queue was full.',
};

// ─── The module under check ──────────────────────────────────

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

process.env.LOG_LEVEL = 'error';

const gh = await importDist(join('core', 'gh.js'), 'the gh runner');

/**
 * Read once and guarded. Against the build before the fix there is no such export, and a check
 * that crashes on the first row cannot show what else is wrong — section 7 is where its absence
 * is reported, and every row that names a remedy reports it a second time by comparing against
 * `undefined`.
 */
const REMEDY = gh.REMEDY ?? {};

const classify = (said) => gh.classifyGhFailure(said);

// ─── 1. A secondary rate limit is not a wrong URL ─────────────

console.log('1. a rate limit is told apart from a URL nobody can resolve');

for (const [name, key] of [
  ['a secondary rate limit', 'secondary'],
  ['the hourly rate limit', 'primary'],
  ['the older abuse-detection wording', 'abuse'],
  ["gh's own rate-limit sentence", 'ghsOwn'],
]) {
  const answer = classify(SAYS[key]);
  check(`${name}: the remedy is the wait one`, answer.remedy.startsWith(REMEDY.wait ?? '\u0000'),
        JSON.stringify(answer.remedy));
  check(`${name}: and not the one about checking the URL`, answer.remedy !== REMEDY.target,
        JSON.stringify(answer.remedy));
  check(`${name}: it is not terminal, so the retry still happens`, answer.terminal === false,
        `terminal ${answer.terminal}`);
}

check('the wait remedy says to wait and roughly how long',
      typeof REMEDY.wait === 'string' && /\bwait\b/i.test(REMEDY.wait)
        && /minute|hour/i.test(REMEDY.wait),
      JSON.stringify(REMEDY.wait));

// ─── 2. HTTP 429, and the seconds GitHub asked for ────────────

console.log('\n2. an HTTP 429 is the same class, and a retry-after is passed on');

const tooMany = classify(SAYS.tooMany);
check('an HTTP 429 with a retry-after classifies as the wait class',
      tooMany.remedy.startsWith(REMEDY.wait ?? '\u0000'), JSON.stringify(tooMany.remedy));
check('and it is not terminal either', tooMany.terminal === false, `terminal ${tooMany.terminal}`);
check('the 60 seconds GitHub asked for are named in the remedy',
      /\b60\b/.test(tooMany.remedy) && /second/i.test(tooMany.remedy),
      JSON.stringify(tooMany.remedy));

const bare = classify(SAYS.tooManyBare);
check('a 429 with no retry-after still classifies as the wait class',
      bare.remedy.startsWith(REMEDY.wait ?? '\u0000'), JSON.stringify(bare.remedy));
check('and invents no number when GitHub supplied none',
      bare.remedy === REMEDY.wait, JSON.stringify(bare.remedy));

// ─── 3. Payment is not permission ─────────────────────────────

console.log('\n3. a billing refusal names the billing page, not the URL');

for (const [name, key] of [
  ['an HTTP 402', 'paymentRequired'],
  ['a quota that is spent', 'quota'],
  ['billing refused behind a 403', 'billing403'],
]) {
  const answer = classify(SAYS[key]);
  check(`${name}: the remedy is the billing one`, answer.remedy === REMEDY.billing,
        JSON.stringify(answer.remedy));
  check(`${name}: it is terminal — no wait clears an unpaid account`, answer.terminal === true,
        `terminal ${answer.terminal}`);
  check(`${name}: and it is not the one about checking the URL`, answer.remedy !== REMEDY.target,
        JSON.stringify(answer.remedy));
}

check('the billing remedy names what to top up',
      typeof REMEDY.billing === 'string' && /billing/i.test(REMEDY.billing)
        && REMEDY.billing.length > 20,
      JSON.stringify(REMEDY.billing));

// ─── 4. The classes that were already there ───────────────────

console.log('\n4. the existing classes classify exactly as they did');

/** Every sample the existing checks use, with the class it has always answered. */
const REGRESSION = [
  ['a gh that is not on the PATH', 'spawnFailure', 'install'],
  ['a gh missing inside a distro', 'notInstalledInDistro', 'install'],
  ["GitHub's scope refusal", 'scope', 'scope'],
  ['a gh that checked the scopes itself', 'scopeCli', 'scope'],
  ['a credential GitHub refuses', 'credentials', 'credential'],
  ['a logged-out gh', 'loggedOut', 'login'],
  ['a token that may not do this', 'forbidden', 'target'],
  ['a repository that is not there', 'notFound', 'target'],
  ['a name GitHub cannot resolve', 'unresolvable', 'target'],
  // Not one of the five, and included anyway: it sits below the reordered rows too.
  ['a field this gh does not know', 'unknownField', 'none'],
];

for (const [name, key, expected] of REGRESSION) {
  const answer = classify(SAYS[key]);
  check(`${name}: still terminal`, answer.terminal === true, `terminal ${answer.terminal}`);
  check(`${name}: still REMEDY.${expected}`, answer.remedy === REMEDY[expected],
        `${JSON.stringify(answer.remedy)} rather than ${JSON.stringify(REMEDY[expected])}`);
}

// The fallthrough is the rule that keeps the whole table honest and is unchanged.
const strange = classify('a failure nobody has ever transcribed');
check('a failure the classifier does not recognise is still not terminal',
      strange.terminal === false, `terminal ${strange.terminal}`);
check('and still names nothing', strange.remedy === '', JSON.stringify(strange.remedy));

// ─── 5. A rate-limited call is still retried ──────────────────

console.log('\n5. runGh still spends all three attempts on a rate limit');

const workDir = mkdtempSync(join(tmpdir(), 'check-gh-founder-'));
const logPath = join(workDir, 'invocations.log');
const stubPath = join(workDir, 'stub-gh.mjs');

writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.STUB_GH_LOG, process.env.STUB_GH_MODE + '\\n');
const SAYS = ${JSON.stringify(SAYS)};
process.stderr.write(SAYS[process.env.STUB_GH_MODE] + '\\n');
process.exit(1);
`, 'utf8');

process.env.EXCALIDRAW_GH_COMMAND =
  `"${process.execPath.replace(/\\/g, '/')}" "${stubPath.replace(/\\/g, '/')}"`;
delete process.env.EXCALIDRAW_GH_COMMAND_WSL;
process.env.STUB_GH_LOG = logPath;

const workspace = {
  id: 'gh-founder',
  environment: { kind: 'native' },
  path: workDir,
  innerPath: workDir,
};

async function attempt(mode) {
  writeFileSync(logPath, '', 'utf8');
  process.env.STUB_GH_MODE = mode;
  const started = Date.now();
  let error = null;
  try {
    await gh.runGh(workspace, "api graphql -f 'query=query{viewer{login}}'", {
      what: 'the project board read',
    });
  } catch (thrown) {
    error = thrown;
  }
  const spawns = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;
  return { spawns, error, message: error?.message ?? '', elapsed: Date.now() - started };
}

const isTerminal = (error) =>
  typeof gh.TerminalGhFailure === 'function' && error instanceof gh.TerminalGhFailure;

const limited = await attempt('secondary');
check('a rate-limited call is spawned three times, like the blip', limited.spawns === 3,
      `spawned ${limited.spawns} time(s)`);
check('and both backoffs were waited out', limited.elapsed >= 1600, `${limited.elapsed}ms`);
check('and it was never typed as a failure that cannot succeed', !isTerminal(limited.error),
      `threw ${limited.error?.constructor?.name}`);

const blip = await attempt('socket');
check('the socket blip the policy exists for is untouched', blip.spawns === 3,
      `spawned ${blip.spawns} time(s)`);

const unpaid = await attempt('billing403');
check('a billing refusal is asked once, not three times', unpaid.spawns === 1,
      `spawned ${unpaid.spawns} time(s)`);
check('and it is typed as a failure that cannot succeed', isTerminal(unpaid.error),
      `threw ${unpaid.error?.constructor?.name}`);
check('and the billing sentence reaches the caller through the message',
      typeof REMEDY.billing === 'string' && unpaid.message.includes(REMEDY.billing),
      JSON.stringify(unpaid.message));

rmSync(workDir, { recursive: true, force: true });

// ─── 6. said and remedy stay separate fields ──────────────────

console.log('\n6. TerminalGhFailure still carries said and remedy apart from each other');

for (const [name, key] of [['the wait class', 'secondary'], ['the billing class', 'billing403']]) {
  const said = SAYS[key];
  const { remedy } = classify(said);
  let carried = null;
  try {
    carried = new gh.TerminalGhFailure(said, remedy);
  } catch { /* no such export against the old build; the rows below say so */ }
  check(`${name}: said is what gh said, with nothing of ours on the end`,
        carried?.said === said, JSON.stringify(carried?.said));
  check(`${name}: remedy is the sentence on its own`, carried?.remedy === remedy,
        JSON.stringify(carried?.remedy));
  check(`${name}: and the message carries both, because the message is what travels`,
        typeof carried?.message === 'string' && carried.message.includes(said)
          && carried.message.includes(remedy), JSON.stringify(carried?.message));
}

// ─── 7. The remedies are one object, exported ─────────────────

console.log('\n7. REMEDY is exported, so nothing has to restate a sentence');

check('src/core/gh.ts exports REMEDY', gh.REMEDY !== undefined && typeof gh.REMEDY === 'object',
      `typeof ${typeof gh.REMEDY}`);
check('it names the wait class', typeof gh.REMEDY?.wait === 'string' && gh.REMEDY.wait.length > 20);
check('it names the billing class',
      typeof gh.REMEDY?.billing === 'string' && gh.REMEDY.billing.length > 20);
// A bare non-empty string rather than a length: `REMEDY.login` is the whole of `Run "gh auth
// login".` and there is nothing else worth saying about it.
check('and it still names the five that were already there',
      ['install', 'login', 'scope', 'credential', 'target']
        .every((key) => typeof gh.REMEDY?.[key] === 'string' && gh.REMEDY[key].length > 0),
      JSON.stringify(gh.REMEDY));

/**
 * The check must not hold a second copy of any remedy. Restating one is how the producer and
 * the classifier start to drift, which is the whole reason for the export.
 */
const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const restated = Object.entries(gh.REMEDY ?? {})
  .filter(([, sentence]) => typeof sentence === 'string' && sentence.length > 20)
  .filter(([, sentence]) => ownSource.includes(sentence.slice(0, 40)))
  .map(([key]) => key);
check('and this check restates none of them', restated.length === 0, restated.join(', '));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
