#!/usr/bin/env node
/**
 * Checks that a founder blocker is noticed once, remembered, and closed again when it clears.
 *
 * Positions 1, 6, 7 and 8 of this milestone built the register, the store, the verifier and the
 * blocker table, and nothing anywhere wrote to any of them: `openFounderActions` answered an
 * empty list on every board, for ever. This is the wiring, and it is the first time a `gh` that
 * cannot log in leaves anything behind at all.
 *
 * The cases are the four ways a blocker reaches the store, and the several ways it must not:
 *
 *  - **One reporter, at one rethrow.** `runGh` gives up on a `TerminalGhFailure` without a
 *    second attempt, and that is by definition a failure no retry can fix — "a human must act".
 *    So a reporter is installed once, beside the startup preflights, and invoked there. It reads
 *    `said` and `remedy`, which are fields of their own; a reporter reading `.message` would get
 *    the two glued together and put a tool's stderr on a founder's card. A reporter that throws
 *    must not be able to break the `gh` call it was told about, and a failure that is *not*
 *    terminal must produce nothing and still be retried the same three times.
 *  - **A refusal that leaves a record.** The 403 for an account that cannot push and the 404 for
 *    an environment that was never granted a command each file one, before answering exactly
 *    what they answered before. The 400 for an unusable workspace does not: that is a board
 *    problem, and admitting it is how a column written for a person fills with advice.
 *  - **One card, however many surfaces.** Three surfaces hitting one logged-out `gh` inside a
 *    minute leave one record with a moved `lastSeenAt`, and ten consecutive refusals leave one.
 *  - **The board closes what it can.** A founder who runs `gh auth login` in a terminal must not
 *    keep a stale card for ever, so every producer pass reads the open records back through
 *    `verifyAgainst` and settles the ones answering `satisfied`, recording `resolvedBy: 'probe'`.
 *  - **Publication is opt-in, and it is unset here.** No `gh` write of any kind is spawned —
 *    asserted across the whole argv log rather than at one call, which is the assertion that
 *    catches a publisher wired in at the wrong end.
 *  - **The queue points at the card.** A pass whose cards were all refused names the founder
 *    action rather than repeating what `gh` said.
 *
 * Section 1 has no server in it: it drives `runGh` from the compiled module directly, because a
 * reporter that throws is not reachable through any route — nothing in `src/` installs one that
 * does, and a check that could not exercise the guard would be describing it rather than holding
 * it.
 *
 * Self-contained, in the style of `check-implement-no-push.mjs`: throwaway git projects with
 * origins it invents, a stub `gh` whose sign-in state is a control file re-read on every call, a
 * stub implement agent that parks until released, and its own canvas servers on ports the kernel
 * just handed out. Nothing here talks to GitHub and nothing runs a real coding agent. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-producers.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

/**
 * A string that could only have come out of this check's stub `gh`.
 *
 * It is on the *first* line of what the stub prints, which is the line `readGithubStatus` keeps
 * and the line a card's evidence would carry — so "it appears in the evidence only" is a claim
 * about text that really did reach the producer, rather than about text that was thrown away
 * before anybody could have put it in the wrong field.
 */
const SENTINEL = 'STUB-GH-8F3A';

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `founder-producers-${process.pid}`);
const ghStub = join(workDir, 'gh.mjs');
const agentStub = join(workDir, 'agent.mjs');
const registryPath = join(workDir, 'registry.json');
const soloRegistryPath = join(workDir, 'solo-registry.json');
const ghLogPath = join(workDir, 'gh-calls.log');
const soloGhLogPath = join(workDir, 'solo-gh-calls.log');
/** Section 1's own log, so the servers' calls cannot be counted as its retries. */
const directGhLogPath = join(workDir, 'direct-gh-calls.log');
/** `out` or `in`. Re-read by the stub on every call, so section 5 can flip it under a server. */
const authPath = join(workDir, 'auth.txt');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
writeFileSync(authPath, 'out', 'utf8');
writeFileSync(ghLogPath, '', 'utf8');
writeFileSync(soloGhLogPath, '', 'utf8');
writeFileSync(directGhLogPath, '', 'utf8');

// ─── The project the mirror reads ─────────────────────────────

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

const READ_ONLY = 'someone/read-only';
const WRITABLE = 'someone/writable';

const day = (n) => `2026-07-${String(n).padStart(2, '0')}T10:00:00Z`;

function item(id, { repo, number, option, createdAt, state = 'OPEN' }) {
  return {
    id,
    fieldValueByName: { optionId: option.id, name: option.name },
    content: {
      __typename: 'Issue',
      number,
      title: `Issue ${number}`,
      url: `https://github.com/${repo}/issues/${number}`,
      createdAt,
      state,
      repository: { nameWithOwner: repo },
    },
  };
}

const project = (number, nodes) => ({
  data: {
    owner: {
      projectV2: {
        id: `PVT_project${number}`,
        title: `project ${number}`,
        url: `https://github.com/users/someone/projects/${number}`,
        field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
        items: { pageInfo: { hasNextPage: false }, nodes },
      },
    },
  },
});

writeFileSync(join(workDir, 'project-5.json'),
              JSON.stringify(project(5, [
                item('PVTI_501', { repo: WRITABLE, number: 501, option: DONE, createdAt: day(1) }),
              ])), 'utf8');
writeFileSync(join(workDir, 'project-6.json'),
              JSON.stringify(project(6, [
                item('PVTI_601', { repo: READ_ONLY, number: 601, option: TODO, createdAt: day(1) }),
                item('PVTI_602', { repo: READ_ONLY, number: 602, option: TODO, createdAt: day(2) }),
              ])), 'utf8');

/**
 * A `gh` that is signed out until a file says otherwise, and logs every call it is given.
 *
 * The sign-in state governs `auth status`, the project read and the issue read — the three
 * surfaces section 2 counts — and never `repo view`, which answers a permission either way.
 * That keeps "how many cards did one logged-out CLI leave" and "what does a refused push
 * leave" two questions rather than one tangled one.
 */
writeFileSync(ghStub, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');

const signedIn = () => {
  try { return readFileSync(${JSON.stringify(authPath)}, 'utf8').trim() === 'in'; }
  catch { return false; }
};

/** What a signed-out CLI says, with this check's sentinel on the line that survives. */
function refuseSignedOut() {
  process.stderr.write(${JSON.stringify(SENTINEL)} + ': gh: please run gh auth login to use this tool\\n');
  process.stderr.write('and then try again\\n');
  process.exit(1);
}

if (args[0] === '--version') {
  process.stdout.write('gh version 2.62.0 (2026-01-01)\\n');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  if (!signedIn()) refuseSignedOut();
  process.stdout.write('github.com\\n  Logged in to github.com account someone (keyring)\\n'
    + '  Token scopes: gist, project, read:org, repo\\n');
  process.exit(0);
}

if (args[0] === 'repo' && args[1] === 'view') {
  const repo = args[2] ?? '';
  const permission = repo === ${JSON.stringify(READ_ONLY)} ? 'READ' : 'WRITE';
  process.stdout.write(JSON.stringify({ viewerPermission: permission }) + '\\n');
  process.exit(0);
}

if (args.includes('graphql')) {
  if (!signedIn()) refuseSignedOut();
  const number = (args.join(' ').match(/number=(\\d+)/) ?? [])[1] ?? '5';
  process.stdout.write(readFileSync(join(workDir, 'project-' + number + '.json'), 'utf8'));
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  if (!signedIn()) refuseSignedOut();
  const number = (String(args[2] ?? '').match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  process.stdout.write(JSON.stringify({
    number: Number(number),
    title: 'Issue ' + number,
    body: 'Nothing declared.',
    state: 'OPEN',
    url: String(args[2] ?? ''),
    comments: [],
  }) + '\\n');
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write('{}\\n');
  process.exit(0);
}

// A failure nothing in \`classifyGhFailure\` recognises, which is deliberately not terminal.
if (args[0] === 'blip') {
  process.stderr.write('dial tcp: lookup api.github.com: no such host\\n');
  process.exit(1);
}

// Everything else — the card moves among them — answers emptily rather than failing, so a
// move this check does not assert cannot become a founder action it did not mean to file.
process.stdout.write('{}\\n');
`, 'utf8');

/** Stands in for the implement agent: it records that it started, and parks until released. */
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'run-' + number + '.json'), JSON.stringify({ cwd: process.cwd() }), 'utf8');
  for (let attempt = 0; attempt < 900; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('done\\n');
  process.stdout.write('https://github.com/someone/writable/pull/' + number + '\\n');
});
`, 'utf8');

/**
 * One board per answer this check needs, each a real git repository with an `origin` of its
 * own: the push probe reads the remote rather than the configured `repo`.
 */
const BOARDS = [
  // The mirror the three surfaces of section 2 are read through.
  { id: 'mirror', repo: WRITABLE, project: 5, origin: `https://github.com/${WRITABLE}.git` },
  // An account that may not push, which is the 403 and the queue's refusal.
  { id: 'readonly', repo: READ_ONLY, project: 6, origin: `https://github.com/${READ_ONLY}.git` },
  // An origin nowhere near github.com, so the push probe never asks and answers `unknown`.
  { id: 'unsure', repo: WRITABLE, origin: 'https://gitlab.com/someone/elsewhere.git' },
  // A board with no project at all, which is the fresh clone this column exists for.
  { id: 'noproject', origin: 'https://gitlab.com/someone/nothing.git' },
];

function makeProject(board) {
  const dir = join(workDir, board.id);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'check@example.com']);
  git(dir, ['config', 'user.name', 'Check']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  const config = { name: board.id };
  if (board.repo) config.repo = board.repo;
  if (board.project) config.githubProject = `https://github.com/users/someone/projects/${board.project}`;
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config), 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${board.id}\n`, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  git(dir, ['remote', 'add', 'origin', board.origin]);
  return dir.replace(/\\/g, '/');
}

for (const board of BOARDS) board.path = makeProject(board);

/** A registered path with no config in it at all, which is the 400 that must file nothing. */
const brokenDir = join(workDir, 'broken');
mkdirSync(brokenDir, { recursive: true });

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    ...BOARDS.map((board) => ({ id: board.id, path: board.path })),
    { id: 'broken', path: brokenDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

/** The solo board of section 4: a native project on a server that granted only the distro one. */
const soloPath = makeProject({ id: 'solo', repo: WRITABLE, origin: `https://github.com/${WRITABLE}.git` });
writeFileSync(soloRegistryPath, JSON.stringify({
  workspaces: [{ id: 'solo', path: soloPath }],
}), 'utf8');

// ─── Reading what the producers wrote ─────────────────────────

/** Where `founderActionsFile` puts one workspace's records, derived the way the server does. */
function founderFile(registry, workspaceId) {
  const stateDir = join(dirname(registry), `${basename(registry, extname(registry))}-state`);
  return join(stateDir, `${workspaceId}.founder-actions.json`);
}

function actionsOf(registry, workspaceId) {
  try {
    const document = JSON.parse(readFileSync(founderFile(registry, workspaceId), 'utf8'));
    return Array.isArray(document?.actions) ? document.actions : [];
  } catch {
    return [];
  }
}

const ofKind = (registry, workspaceId, kind) =>
  actionsOf(registry, workspaceId).filter((action) => action.kind === kind);

/** Every field a person reads on a card, flattened, with the evidence deliberately left out. */
function founderText(action) {
  const fields = action?.fields ?? {};
  return [fields.title, fields.what, fields.why, fields.confirm, ...(fields.steps ?? [])]
    .filter((value) => typeof value === 'string')
    .join('\n');
}

function argvLog(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(predicate, what, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(150);
  }
  console.error(`  FAIL  timed out waiting for ${what}`);
  failures++;
  return false;
}

// ─── The servers ──────────────────────────────────────────────

const serverPath = join(repoRoot, 'dist', 'server.js');
if (!existsSync(serverPath)) {
  console.error('  FAIL  dist/server.js exists — run tsc first');
  process.exit(1);
}

/** Short enough that a case does not wait out a real interval to see a producer pass. */
const PASS_MS = 1200;
const QUEUE_MS = 500;

const ghCommand = `node "${ghStub.replace(/\\/g, '/')}"`;
const agentCommand = `node "${agentStub.replace(/\\/g, '/')}" -p`;

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

const server = spawnCanvas({
  port,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: ghCommand,
    EXCALIDRAW_IMPLEMENT_AGENT: agentCommand,
    EXCALIDRAW_IMPLEMENT_CONCURRENCY: '8',
    EXCALIDRAW_IMPLEMENT_QUEUE_MS: String(QUEUE_MS),
    EXCALIDRAW_FOUNDER_PASS_MS: String(PASS_MS),
    // The status and push answers both sit behind this memo, and section 5 changes one of them
    // while the server is up. Off, so a pass asks rather than remembering.
    EXCALIDRAW_GH_STATUS_MEMO_MS: '0',
    EXCALIDRAW_ISSUE_MEMO_MS: '0',
    STUB_GH_LOG: ghLogPath,
  },
});

const soloPort = await freePort();
const SOLO = `http://127.0.0.1:${soloPort}`;

/**
 * A second board that granted a command for the distro and none for this machine.
 *
 * That is the only way a native project reaches `beginImplement`'s 404: with nothing granted
 * anywhere the route refuses one layer earlier, at `implementingRefused`, and the founder
 * action this section is about would never be reached on any platform.
 */
const soloServer = spawnCanvas({
  port: soloPort,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: soloRegistryPath,
    EXCALIDRAW_GH_COMMAND: ghCommand,
    EXCALIDRAW_IMPLEMENT_AGENT: undefined,
    EXCALIDRAW_IMPLEMENT_AGENT_WSL: agentCommand,
    EXCALIDRAW_FOUNDER_PASS_MS: String(PASS_MS),
    EXCALIDRAW_GH_STATUS_MEMO_MS: '0',
    STUB_GH_LOG: soloGhLogPath,
  },
});

async function waitForHealth(base, spawned) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawned.child.exitCode !== null) {
      throw new Error(`the canvas server exited early:\n${spawned.read()}`);
    }
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${spawned.read()}`);
}

async function callOn(base, workspace, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${base}${path}${glue}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const call = (workspace, path, options) => callOn(BASE, workspace, path, options);

const issue = (repo, n) => `https://github.com/${repo}/issues/${n}`;
const start = (workspace, url) =>
  call(workspace, '/api/implement', { method: 'POST', body: JSON.stringify({ url }) });
const release = (n) => writeFileSync(join(workDir, `release-${n}`), '', 'utf8');
const agentStarted = (n) => existsSync(join(workDir, `run-${n}.json`));

const STARTED = [301, 601, 602];

try {
  // ─── 1 ──────────────────────────────────────────────────────
  console.log('1. the reporter runGh invokes, and what it may not be able to break');

  process.env.EXCALIDRAW_NO_DOTENV = '1';
  process.env.EXCALIDRAW_GH_COMMAND = ghCommand;
  process.env.LOG_LEVEL = 'error';
  process.env.STUB_GH_LOG = directGhLogPath;
  const gh = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'gh.js')).href);

  check('gh.ts exports a reporter to install', typeof gh.setTerminalGhReporter === 'function',
        `exports: ${Object.keys(gh).join(', ')}`);

  if (typeof gh.setTerminalGhReporter === 'function') {
    const workspace = {
      id: 'mirror',
      name: 'mirror',
      path: join(workDir, 'mirror'),
      innerPath: join(workDir, 'mirror'),
      environment: { kind: 'native' },
    };

    const seen = [];
    gh.setTerminalGhReporter((where, failure) => {
      seen.push({ workspace: where?.id ?? null, said: failure?.said, remedy: failure?.remedy });
    });

    let thrown = null;
    try {
      await gh.runGh(workspace, 'issue view https://github.com/someone/read-only/issues/1',
                     { what: 'a terminal failure' });
    } catch (error) { thrown = error; }

    check('a terminal failure still rejects with the failure itself',
          thrown?.name === 'TerminalGhFailure', String(thrown));
    check('and the reporter was told once', seen.length === 1, JSON.stringify(seen));
    check('with `said` as its own field, carrying what gh printed',
          String(seen[0]?.said ?? '').includes(SENTINEL), JSON.stringify(seen[0]));
    check('and `remedy` as its own field, which is not part of `said`',
          Boolean(seen[0]?.remedy) && !String(seen[0]?.said ?? '').includes(seen[0].remedy),
          JSON.stringify(seen[0]));
    check('and the workspace it happened in', seen[0]?.workspace === 'mirror', JSON.stringify(seen[0]));

    gh.setTerminalGhReporter(() => { throw new Error('a reporter that blew up'); });
    let second = null;
    try {
      await gh.runGh(workspace, 'issue view https://github.com/someone/read-only/issues/2',
                     { what: 'a reporter that throws' });
    } catch (error) { second = error; }
    check('a reporter that throws cannot change what the gh call rejects with',
          second?.name === 'TerminalGhFailure', String(second));

    // A failure nothing in `classifyGhFailure` recognises is deliberately non-terminal, and a
    // non-terminal failure is not a founder blocker: it is a bad minute, and it is retried.
    const blips = [];
    gh.setTerminalGhReporter(() => { blips.push('reported'); });
    const before = argvLog(directGhLogPath).length;
    let blip = null;
    try {
      await gh.runGh(workspace, 'blip', { what: 'a blip', timeoutMs: 4000 });
    } catch (error) { blip = error; }
    const attempts = argvLog(directGhLogPath).length - before;
    check('a non-terminal failure tells the reporter nothing', blips.length === 0,
          JSON.stringify(blips));
    check('and is still retried three times', attempts === 3,
          `${attempts} attempt(s), and it ended ${String(blip)}`);

    gh.setTerminalGhReporter(null);
  }

  await waitForHealth(BASE, server);
  await waitForHealth(SOLO, soloServer);

  // ─── 2 ──────────────────────────────────────────────────────
  console.log('\n2. a logged-out gh is one card, however many surfaces trip over it');

  const mirrored = await call('mirror', '/api/project-board');
  check('the project read failed, which is the first surface', mirrored.status >= 400,
        `got ${mirrored.status}`);
  const read = await call('mirror', `/api/issue?url=${encodeURIComponent(issue(WRITABLE, 9))}`);
  check('the issue read failed, which is the second', read.status >= 400, `got ${read.status}`);

  // Both surfaces above and at least one producer pass, which is the third: the record has to
  // exist *and* have been seen again, or "one card however many surfaces" is unmeasured.
  await waitFor(() => {
    const found = ofKind(registryPath, 'mirror', 'gh-login')[0];
    return Boolean(found) && found.lastSeenAt > found.createdAt;
  }, 'three surfaces to notice one logged-out gh');

  const logins = ofKind(registryPath, 'mirror', 'gh-login');
  check('exactly one record, not one per surface', logins.length === 1,
        JSON.stringify(actionsOf(registryPath, 'mirror').map((a) => a.kind)));
  const login = logins[0] ?? {};
  check('and it is open', login.state === 'open', JSON.stringify(login));
  check('and a later sighting moved lastSeenAt rather than writing a second card',
        typeof login.lastSeenAt === 'string' && login.lastSeenAt > login.createdAt,
        `${login.createdAt} → ${login.lastSeenAt}`);
  check('no founder field carries what the tool printed',
        !founderText(login).includes(SENTINEL), founderText(login));
  check('and the evidence does', String(login.evidence?.said ?? '').includes(SENTINEL),
        JSON.stringify(login.evidence));

  // ─── 3 ──────────────────────────────────────────────────────
  console.log('\n3. a refused start leaves a record, and only where a person can act');

  // A number that is on no project column, so section 7's queue still has both of its own cards
  // to be refused for: a card this section has already recorded a run against is skipped.
  const refused = await start('readonly', issue(READ_ONLY, 999));
  check('the account that may not push is still refused 403', refused.status === 403,
        `got ${refused.status} ${JSON.stringify(refused.body)}`);
  const sentence = String(refused.body?.error ?? '');
  check('with the sentence it always answered', /\bfork/i.test(sentence)
        && sentence.includes(READ_ONLY) && /\bREAD\b/.test(sentence), sentence);
  check('and the body carries nothing else',
        Object.keys(refused.body).sort().join(',') === 'error,success',
        JSON.stringify(refused.body));

  await waitFor(() => ofKind(registryPath, 'readonly', 'push-denied').length > 0,
                'the refused push to leave a founder action');
  const denied = ofKind(registryPath, 'readonly', 'push-denied')[0] ?? {};
  check('the record names the repository', founderText(denied).includes(READ_ONLY),
        founderText(denied));
  check('and the permission it was told', /\bREAD\b/.test(founderText(denied)), founderText(denied));
  check('and its key carries the repository, so two repositories are two cards',
        String(denied.key ?? '').endsWith(`:${READ_ONLY}`), String(denied.key));

  for (let attempt = 0; attempt < 10; attempt++) await start('readonly', issue(READ_ONLY, 999));
  check('ten more refusals leave one record, not ten',
        ofKind(registryPath, 'readonly', 'push-denied').length === 1,
        JSON.stringify(ofKind(registryPath, 'readonly', 'push-denied').map((a) => a.key)));

  const unsure = await start('unsure', issue(WRITABLE, 301));
  check('a push nobody could answer for still starts the run', unsure.status === 202,
        `got ${unsure.status} ${JSON.stringify(unsure.body)}`);
  await waitFor(() => agentStarted(301), 'the run on an origin nobody asked about to start');
  check('and it produced no push card', ofKind(registryPath, 'unsure', 'push-denied').length === 0,
        JSON.stringify(actionsOf(registryPath, 'unsure').map((a) => a.kind)));

  const broken = await start('broken', issue(WRITABLE, 701));
  check('an unusable workspace is still refused 400', broken.status === 400,
        `got ${broken.status} ${JSON.stringify(broken.body)}`);
  check('and a board problem is not a founder action', actionsOf(registryPath, 'broken').length === 0,
        JSON.stringify(actionsOf(registryPath, 'broken')));

  // ─── 4 ──────────────────────────────────────────────────────
  console.log('\n4. a start refused for want of a granted command');

  const ungranted = await callOn(SOLO, 'solo', '/api/implement', {
    method: 'POST',
    body: JSON.stringify({ url: issue(WRITABLE, 801) }),
  });
  check('it is still refused 404', ungranted.status === 404,
        `got ${ungranted.status} ${JSON.stringify(ungranted.body)}`);
  await waitFor(() => ofKind(soloRegistryPath, 'solo', 'agent-not-granted').length > 0,
                'the ungranted agent to leave a founder action');
  const granted = ofKind(soloRegistryPath, 'solo', 'agent-not-granted')[0] ?? {};
  check('the record names this machine', founderText(granted).includes('this machine'),
        founderText(granted));
  check('and the variable that would grant one, spelled as the board spells it',
        founderText(granted).includes('VIBEMAXXING_IMPLEMENT_AGENT'), founderText(granted));

  // ─── 5 ──────────────────────────────────────────────────────
  console.log('\n5. the board closes what it can, with nobody clicking anything');

  writeFileSync(authPath, 'in', 'utf8');
  await waitFor(() => (ofKind(registryPath, 'mirror', 'gh-login')[0] ?? {}).state === 'resolved',
                'the signed-in gh to close the card a probe opened');
  const closed = ofKind(registryPath, 'mirror', 'gh-login')[0] ?? {};
  check('the record says a probe closed it', closed.resolvedBy === 'probe', JSON.stringify(closed));
  check('and it says when', typeof closed.resolvedAt === 'string', JSON.stringify(closed));
  check('the push card is untouched by a sign-in, because nothing asked about pushing',
        (ofKind(registryPath, 'readonly', 'push-denied')[0] ?? {}).state === 'open',
        JSON.stringify(ofKind(registryPath, 'readonly', 'push-denied')));

  // ─── 6 ──────────────────────────────────────────────────────
  console.log('\n6. a board with no project still lands a card, and publishes nothing');

  await waitFor(() => actionsOf(registryPath, 'noproject').length > 0,
                'a board with no project to record its own blocker');
  check('a workspace with no githubProject still has a founder action',
        actionsOf(registryPath, 'noproject').length > 0,
        JSON.stringify(actionsOf(registryPath, 'noproject')));

  const everyCall = [...argvLog(ghLogPath), ...argvLog(soloGhLogPath)].map((args) => args.join(' '));
  check('nothing anywhere created a draft item',
        everyCall.every((line) => !line.includes('item-create')),
        everyCall.filter((line) => line.includes('item-create')).join(' | '));
  check('nor an issue', everyCall.every((line) => !/\bissue create\b/.test(line)),
        everyCall.filter((line) => /\bissue create\b/.test(line)).join(' | '));
  check('nor added one to a project', everyCall.every((line) => !line.includes('item-add')),
        everyCall.filter((line) => line.includes('item-add')).join(' | '));
  const cardTitle = (ofKind(registryPath, 'readonly', 'push-denied')[0] ?? {}).fields?.title ?? '';
  check('and no card text was ever handed to gh',
        Boolean(cardTitle) && everyCall.every((line) => !line.includes(cardTitle)),
        `looked for "${cardTitle}"`);

  // ─── 7 ──────────────────────────────────────────────────────
  console.log('\n7. the queue points at the card rather than repeating what gh said');

  await call('readonly', '/api/implement/queue', {
    method: 'POST', body: JSON.stringify({ enabled: true }),
  });
  let pass = null;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    pass = (await call('readonly', '/api/implement')).body?.queue?.lastPass ?? null;
    if (pass?.reason === 'refused') break;
    await sleep(150);
  }
  check('a pass whose every card was refused still says so', pass?.reason === 'refused',
        JSON.stringify(pass));
  const title = (ofKind(registryPath, 'readonly', 'push-denied')[0] ?? {}).fields?.title ?? '';
  check('and its detail names the founder action',
        Boolean(title) && String(pass?.detail ?? '').includes(title),
        `looked for "${title}" in ${JSON.stringify(pass?.detail)}`);
  await call('readonly', '/api/implement/queue', {
    method: 'POST', body: JSON.stringify({ enabled: false }),
  });
} finally {
  for (const n of STARTED) {
    try { release(n); } catch { /* the world may already be gone */ }
  }
  await sleep(600);
  for (const spawned of [server, soloServer]) {
    if (spawned.child.exitCode === null) spawned.child.kill('SIGKILL');
  }
  await sleep(200);
  for (const board of [...BOARDS.map((one) => one.id), 'solo']) {
    const dir = join(workDir, board);
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  // Forgiven: on Windows a killed server's handles are released asynchronously, and a run that
  // reported failure because it could not delete a temporary directory would be wrong about the
  // thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
