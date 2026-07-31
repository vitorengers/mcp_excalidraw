#!/usr/bin/env node
/**
 * Checks that `gh` is retried for a blip and never for a failure that cannot succeed.
 *
 * Two independent runners retried everything three times, 400 ms and 1200 ms apart:
 * `runGh` in `src/core/gh.ts`, and `fetchIssue`, which kept its own copy of the constants and
 * spawned `gh` itself. The policy was written for one real fault — this machine's socket
 * buffer exhaustion, which succeeds on the next try seconds later — and applied to every
 * other: a `gh` that is not installed, a login that has expired, a token without the
 * `project` scope and a repository that does not exist were each asked three times, 1.6
 * seconds apart, to give the same answer. `RunGhOptions.attempts` existed for exactly this
 * and no caller in `src/` ever passed it (#319).
 *
 * Worse than the delay: the one actionable sentence `gh` produces was the only thing the
 * canvas got. A default `gh auth login` does **not** ask for the `project` scope, so the
 * mirror on a fresh clone fails with GitHub's own wall of text and no mention of the one
 * command that fixes it — `gh auth refresh -s project`.
 *
 * Six sections. Every behavioural one fails against the build before the fix:
 *
 *  1. **The scope failure is spawned once**, and the error carries the remedy.
 *  2. **A socket blip is still spawned three times.** The classifier has to fall back to
 *     retrying whatever it does not recognise, never to refusing.
 *  3. **The other deterministic failures** — a missing CLI, a logged-out one, HTTP 401/403/404
 *     and `Could not resolve to a` — get one attempt each and name what to go and do.
 *  4. **The issue read shares the policy**, because it is the call site that had its own.
 *     Including the field downgrade an older `gh` triggers, which must stay one spawn.
 *  5. **`github-issue.ts` declares no retry constants of its own**, and no longer spawns.
 *  6. **Nothing in the tree still claims a default login carries the `project` scope.**
 *
 * Self-contained: no server, no browser, no GitHub account. A stub `gh` in a throwaway
 * directory prints whatever failure the case is about and counts its own invocations.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-gh-retry-policy.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── A stub gh that says one thing and counts itself ──────────

const workDir = mkdtempSync(join(tmpdir(), 'check-gh-retry-'));
const logPath = join(workDir, 'invocations.log');
const stubPath = join(workDir, 'stub-gh.mjs');

/**
 * What each failure looks like coming out of a real `gh`.
 *
 * Transcribed rather than invented. `missing required scopes`, `To request it, run:  gh auth
 * refresh -s`, `Could not resolve to a Repository with the name` and `not logged in to` are
 * literal strings in the gh 2.96.0 binary; the GraphQL one is GitHub's own answer to a project
 * query from a token without `read:project`, and is already what
 * `scripts/check-mirror-unreadable.mjs` stubs.
 */
const SAYS = {
  // Long on purpose: `runOnce` keeps the last 300 characters of stderr, so a classifier
  // reading the *message* rather than the whole output never sees the head of this one.
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
  // The blip the whole retry policy was written for.
  socket: 'error connecting to api.github.com: dial tcp 140.82.121.6:443: An operation on a '
    + 'socket could not be performed because the system lacked sufficient buffer space or '
    + 'because a queue was full.',
  unknownField: 'Unknown JSON field: "closedByPullRequestsReferences"\n'
    + 'Available fields: assignees, author, body, closed, comments, number, state, title, url',
};

const ISSUE_URL = 'https://github.com/vitorengers/vibemaxxing/issues/1';
const ISSUE_JSON = JSON.stringify({
  number: 1,
  title: 'An issue the stub answers with',
  body: 'A body.',
  state: 'OPEN',
  comments: [],
  stateReason: null,
});

writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';

const mode = process.env.STUB_GH_MODE ?? 'ok';
const argv = process.argv.slice(2).join(' ');
appendFileSync(process.env.STUB_GH_LOG, mode + '\\t' + argv + '\\n');

const SAYS = ${JSON.stringify(SAYS)};
const ISSUE_JSON = ${JSON.stringify(ISSUE_JSON)};

// The one mode that answers differently depending on what was asked: a \`gh\` too old to know
// the field refuses the first query and answers the second.
if (mode === 'downgrade') {
  if (argv.includes('closedByPullRequestsReferences')) {
    process.stderr.write(SAYS.unknownField + '\\n');
    process.exit(1);
  }
  process.stdout.write(ISSUE_JSON);
  process.exit(0);
}

if (mode === 'ok') {
  process.stdout.write(ISSUE_JSON);
  process.exit(0);
}

process.stderr.write(SAYS[mode] + '\\n');
process.exit(1);
`, 'utf8');

/**
 * Set before the modules load, the way every other check that stubs `gh` does. `ghCommandFor`
 * reads it per call, so the missing-CLI case below can move it and put it back.
 */
const STUB_COMMAND = `"${process.execPath.replace(/\\/g, '/')}" "${stubPath.replace(/\\/g, '/')}"`;
process.env.EXCALIDRAW_GH_COMMAND = STUB_COMMAND;
delete process.env.EXCALIDRAW_GH_COMMAND_WSL;
process.env.STUB_GH_LOG = logPath;
process.env.LOG_LEVEL = 'error';

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const gh = await importDist(join('core', 'gh.js'), 'the gh runner');
const { fetchIssue } = await importDist(join('core', 'github-issue.js'), 'the issue reader');

/**
 * Guarded rather than a bare `instanceof`: against the build before the fix there is no such
 * export, and a check that crashes on the first case cannot show what else is wrong.
 */
const isTerminal = (error) =>
  typeof gh.TerminalGhFailure === 'function' && error instanceof gh.TerminalGhFailure;

const workspace = {
  id: 'gh-retry',
  environment: { kind: 'native' },
  path: workDir,
  innerPath: workDir,
};

/** One call against the stub in one mode: how many times it ran, and what came back. */
async function attempt(mode, call) {
  writeFileSync(logPath, '', 'utf8');
  process.env.STUB_GH_MODE = mode;
  const started = Date.now();
  let message = '';
  let error = null;
  try {
    await call();
  } catch (thrown) {
    error = thrown;
    message = thrown?.message ?? String(thrown);
  }
  const spawns = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;
  return { spawns, message, error, elapsed: Date.now() - started };
}

const readBoard = () => gh.runGh(workspace, 'api graphql -f \'query=query{viewer{login}}\'', {
  what: 'the project board read',
});

// ─── 1. A deterministic failure is asked once ─────────────────

console.log('1. a token without the project scope is asked once, and says what to do');

const scope = await attempt('scope', readBoard);

check('the stub gh was spawned once, not three times', scope.spawns === 1,
      `spawned ${scope.spawns} time(s)`);
check('the caller is told to run gh auth refresh -s project',
      scope.message.includes('gh auth refresh -s project'), JSON.stringify(scope.message));
check("gh's own sentence survives alongside the remedy",
      /required scopes/i.test(scope.message), JSON.stringify(scope.message));
check('the failure is typed as one that cannot succeed',
      isTerminal(scope.error), `threw ${scope.error?.constructor?.name}`);
check('it gave up in well under the two backoffs', scope.elapsed < 1400, `${scope.elapsed}ms`);

// ─── 2. The blip the policy exists for is still retried ───────

console.log('\n2. the socket blip the retry was written for keeps all three attempts');

const socket = await attempt('socket', readBoard);

check('the stub gh was spawned three times', socket.spawns === 3, `spawned ${socket.spawns} time(s)`);
check("the failure reported is gh's own", /buffer space/i.test(socket.message),
      JSON.stringify(socket.message));
check('and it is not typed as terminal', !isTerminal(socket.error),
      `threw ${socket.error?.constructor?.name}`);
check('the two backoffs were waited out', socket.elapsed >= 1600, `${socket.elapsed}ms`);

// A failure nobody transcribed must fall back to retrying, never to refusing.
const strange = await attempt('unrecognised-failure-mode', async () => {
  // The stub has no such mode, so `SAYS[mode]` is undefined and it fails saying "undefined" —
  // which is exactly the point: text the classifier has never seen.
  await readBoard();
});
check('a failure the classifier does not recognise is retried', strange.spawns === 3,
      `spawned ${strange.spawns} time(s)`);

// ─── 3. The rest of the deterministic set ─────────────────────

console.log('\n3. every other failure that cannot succeed is asked once');

const DETERMINISTIC = [
  ['a logged-out gh', 'loggedOut', 'gh auth login'],
  ['a credential GitHub refuses', 'credentials', 'gh auth'],
  ['a token that may not do this', 'forbidden', ''],
  ['a repository that is not there', 'notFound', ''],
  ['a name GitHub cannot resolve', 'unresolvable', ''],
  ['a gh that checked the scopes itself', 'scopeCli', 'gh auth refresh -s project'],
];

for (const [name, mode, remedy] of DETERMINISTIC) {
  const result = await attempt(mode, readBoard);
  check(`${name}: spawned once`, result.spawns === 1, `spawned ${result.spawns} time(s)`);
  check(`${name}: the failure is typed as terminal`,
        isTerminal(result.error), `threw ${result.error?.constructor?.name}`);
  check(`${name}: it names something to go and do`,
        typeof result.error?.remedy === 'string' && result.error.remedy.length > 10,
        JSON.stringify(result.error?.remedy));
  if (remedy) {
    check(`${name}: the remedy is ${JSON.stringify(remedy)}`, result.message.includes(remedy),
          JSON.stringify(result.message));
  }
}

console.log('\n   and a gh that is not installed at all');
{
  process.env.EXCALIDRAW_GH_COMMAND = `"${join(workDir, 'no-such-gh').replace(/\\/g, '/')}"`;
  const missing = await attempt('ok', readBoard);
  process.env.EXCALIDRAW_GH_COMMAND = STUB_COMMAND;

  check('nothing was spawned', missing.spawns === 0, `spawned ${missing.spawns} time(s)`);
  check('it failed before either backoff', missing.elapsed < 1400, `${missing.elapsed}ms`);
  check('the failure is typed as terminal',
        isTerminal(missing.error), `threw ${missing.error?.constructor?.name}`);
  check('and it names the override that would fix it',
        /EXCALIDRAW_GH_COMMAND/.test(missing.message), JSON.stringify(missing.message));
}

// ─── 4. The issue read is the same policy ─────────────────────

console.log('\n4. the issue read answers to the same classifier');

const issueScope = await attempt('scope', () => fetchIssue(workspace, ISSUE_URL));
check('a scope failure spawns gh once', issueScope.spawns === 1,
      `spawned ${issueScope.spawns} time(s)`);
check('and carries the remedy to the panel',
      issueScope.message.includes('gh auth refresh -s project'), JSON.stringify(issueScope.message));

const issueSocket = await attempt('socket', () => fetchIssue(workspace, ISSUE_URL));
check('a socket blip still spawns gh three times', issueSocket.spawns === 3,
      `spawned ${issueSocket.spawns} time(s)`);

const issueOk = await attempt('ok', () => fetchIssue(workspace, ISSUE_URL));
check('a working gh is spawned once and the issue is read', issueOk.spawns === 1 && !issueOk.error,
      `${issueOk.spawns} spawn(s), ${issueOk.message}`);

// The downgrade an older `gh` triggers is deterministic too: one spawn to be refused, one to
// be answered. Three to be refused would be the duplicated policy coming back by another door.
const downgrade = await attempt('downgrade', () => fetchIssue(workspace, ISSUE_URL));
check('a gh too old for the closure field costs one refused spawn, not three',
      downgrade.spawns === 2, `spawned ${downgrade.spawns} time(s)`);
check('and the issue is still read', !downgrade.error, downgrade.message);

// ─── 5. One runner, one set of constants ──────────────────────

console.log('\n5. github-issue.ts has no retry policy of its own');

const issueSource = readFileSync(join(repoRoot, 'src', 'core', 'github-issue.ts'), 'utf8');

check('it declares no ATTEMPTS of its own', !/\bconst\s+ATTEMPTS\b/.test(issueSource));
check('it declares no BACKOFF_MS of its own', !/\bconst\s+BACKOFF_MS\b/.test(issueSource));
check('it no longer spawns gh itself', !/\bspawn\s*\(/.test(issueSource));
check('it goes through the shared runner', /runGh(Command)?\s*\(/.test(issueSource));

// ─── 6. The scope claim is gone from the tree ─────────────────

console.log('\n6. nothing still says a default gh login carries the project scope');

/** The claim itself. */
const CLAIM = /carries the [`"']?project[`"']? scope/i;

/**
 * Line breaks and comment continuations folded away before matching.
 *
 * All three sites wrapped the sentence mid-phrase — two of them across a ` * ` — so a scan
 * reading the file as it is laid out finds one of the three and reports the claim gone.
 */
const unwrapped = (text) => text.replace(/\r?\n[ \t]*\*?[ \t]*/g, ' ');

const documented = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (/\.(ts|tsx|md)$/.test(entry)) documented.push(full);
  }
};
walk(join(repoRoot, 'src'));
walk(join(repoRoot, 'docs'));
documented.push(join(repoRoot, 'README.md'), join(repoRoot, 'CLAUDE.md'));

// The development log is history: an entry describing what a merge said at the time is not a
// claim the tree is making now, and rewriting it would be rewriting the record.
const claiming = documented
  .filter((file) => existsSync(file) && !/development-log\.md$/.test(file))
  .filter((file) => CLAIM.test(unwrapped(readFileSync(file, 'utf8'))))
  .map((file) => file.slice(repoRoot.length + 1).replace(/\\/g, '/'));

check('no comment or document makes the claim', claiming.length === 0, claiming.join(', '));

const boardDoc = readFileSync(join(repoRoot, 'docs', 'project-board.md'), 'utf8');
check('docs/project-board.md names the command that grants it',
      boardDoc.includes('gh auth refresh -s project'));

rmSync(workDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
