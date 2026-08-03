#!/usr/bin/env node
/**
 * Checks the four routes the founder column is read and answered through.
 *
 * Positions 1 to 12 of this milestone built the register, the store, the verifier, the blocker
 * table, the producers and the publisher, and none of it was reachable from a browser: the
 * records were written to a file that nothing served. These are the doors — list, resolve, and
 * the two halves of a chat turn — and the cases below are the four decisions they embody that
 * are easy to get wrong in a way nothing else would notice:
 *
 *  - **The list answers a board with no project, and spawns nothing.** A founder action store
 *    does not need a `githubProject`, and answering 404 there would empty the column on exactly
 *    the fresh clone it exists for. It is also the one route that must keep answering while
 *    GitHub is the thing that is broken, so it reads a local file and never shells out — proved
 *    from an argv log rather than from the absence of a `try`.
 *  - **Done re-probes rather than reading through the memo.** A founder who has just run
 *    `gh auth login` and presses Done would otherwise be told they are still blocked for up to
 *    the whole memo window, and would press again. The memo here is deliberately three hundred
 *    seconds wide, so a route that read through it could not pass this section by luck.
 *  - **Resolving nudges the queue.** Nothing about a fix is event-driven, so without the nudge a
 *    founder who has just been given push access waits out a whole queue interval. The interval
 *    in this check is five minutes, which makes the pass that starts the run attributable to the
 *    resolve and to nothing else.
 *  - **The founder's words are stored before anything is spawned.** The recreate route's
 *    precedent: a run that dies has still left what somebody typed where they put it. Asserted
 *    by killing the stub agent mid-run and reading the store back, which is the only way to tell
 *    "written first" from "written at the end of a run that happened to succeed".
 *
 * And the register is defended at the door rather than trusted to the agent: an answer carrying
 * a patch the register refuses leaves the item exactly as it was and still returns the reply,
 * because the founder asked a question and deserves the answer.
 *
 * Self-contained, in the style of `check-founder-producers.mjs`: throwaway git projects with
 * origins it invents, a stub `gh` whose sign-in and permission answers are control files re-read
 * on every call, a stub issue agent whose behaviour is a control file, a stub implement agent
 * that parks until released, and its own canvas servers on ports the kernel just handed out.
 * Nothing here talks to GitHub and nothing runs a real coding agent. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Three servers, because three of the cases are about how a server was *started*: one ordinary
 * board, one bound off loopback so the refusal is the bind's, and one whose `gh` is signed out
 * behind a long memo. A fourth is started at the end on the first server's own registry, which is
 * how "the transcript survives a restart and the run state does not" is asked.
 *
 * Usage: node scripts/check-founder-routes.mjs
 *
 * Tier: fast
 */

import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `founder-routes-${process.pid}`);
const ghStub = join(workDir, 'gh.mjs');
const chatStub = join(workDir, 'chat-agent.mjs');
const agentStub = join(workDir, 'implement-agent.mjs');
const registryPath = join(workDir, 'registry.json');
const outRegistryPath = join(workDir, 'out-registry.json');
const ghLogPath = join(workDir, 'gh-calls.log');
const outGhLogPath = join(workDir, 'out-gh-calls.log');
/** Every chat agent this check ever spawns, one line each. Counting them is a case. */
const chatLogPath = join(workDir, 'chat-runs.log');
/** Where the implement agent stub says it was started, so a worktree is a fact and not a hope. */
const implementLogPath = join(workDir, 'implement-runs.log');
/** `park` | `plain` | `bad-patch` | `good-patch`. Re-read by the stub on every run. */
const chatModePath = join(workDir, 'chat-mode.txt');
/** Where the parked chat agent writes its own pid, so this check can kill it mid-run. */
const chatPidPath = join(workDir, 'chat-pid.txt');
/**
 * `out` or `in`, one file per server, named to each through `STUB_GH_AUTH`.
 *
 * Two rather than one because the sign-in is a *different* fact on the two boards: the main
 * server needs a `gh` that answers so its project reads and its publication work, and the second
 * server needs one that is signed out until section 4 flips it. One shared file would have made
 * every card on the main board a card about the second board's control file.
 */
const authPath = join(workDir, 'auth.txt');
const outAuthPath = join(workDir, 'out-auth.txt');
/** `READ` or `WRITE`, the permission `gh repo view` reports for the read-only repository. */
const permissionPath = join(workDir, 'permission.txt');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
writeFileSync(authPath, 'in', 'utf8');
writeFileSync(outAuthPath, 'out', 'utf8');
writeFileSync(permissionPath, 'READ', 'utf8');
writeFileSync(chatModePath, 'plain', 'utf8');
for (const path of [ghLogPath, outGhLogPath, chatLogPath, implementLogPath]) {
  writeFileSync(path, '', 'utf8');
}

// ─── The project the mirror reads ─────────────────────────────

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };
const FOUNDER = { id: 'a1b2c3d4', name: 'Founder Actions' };

const READ_ONLY = 'someone/read-only';
const WRITABLE = 'someone/writable';
/** A repository whose every read is refused over payment, which is a kind nothing can re-probe. */
const UNPAID = 'someone/unpaid';

function item(id, { repo, number, option }) {
  return {
    id,
    fieldValueByName: { optionId: option.id, name: option.name },
    content: {
      __typename: 'Issue',
      number,
      title: `Issue ${number}`,
      url: `https://github.com/${repo}/issues/${number}`,
      createdAt: '2026-07-01T10:00:00Z',
      state: 'OPEN',
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
        field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE, FOUNDER] },
        items: { pageInfo: { hasNextPage: false }, nodes },
      },
    },
  },
});

writeFileSync(join(workDir, 'project-5.json'), JSON.stringify(project(5, [])), 'utf8');
writeFileSync(join(workDir, 'project-6.json'),
              JSON.stringify(project(6, [
                item('PVTI_601', { repo: READ_ONLY, number: 601, option: TODO }),
              ])), 'utf8');

/**
 * A `gh` that answers whatever two control files say, and logs every call it is given.
 *
 * The permission file is what section 6 flips: a founder action about an account that cannot
 * push is cleared by the account being able to push, and nothing else about the board changes.
 * The billing refusal is keyed on the repository rather than on a control file, because a kind
 * nothing can ever re-probe has to stay unre-probeable for the whole run.
 */
writeFileSync(ghStub, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');

const signedIn = () => {
  try { return readFileSync(process.env.STUB_GH_AUTH, 'utf8').trim() === 'in'; }
  catch { return false; }
};
const permission = () => {
  try { return readFileSync(${JSON.stringify(permissionPath)}, 'utf8').trim() || 'READ'; }
  catch { return 'READ'; }
};

function refuseSignedOut() {
  process.stderr.write('gh: To use GitHub CLI in a GitHub Actions workflow, run gh auth login\\n');
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
  const answer = repo === ${JSON.stringify(READ_ONLY)} ? permission() : 'WRITE';
  process.stdout.write(JSON.stringify({ viewerPermission: answer }) + '\\n');
  process.exit(0);
}

if (args.includes('graphql')) {
  if (!signedIn()) refuseSignedOut();
  const number = (args.join(' ').match(/number=(\\d+)/) ?? [])[1] ?? '5';
  process.stdout.write(readFileSync(join(workDir, 'project-' + number + '.json'), 'utf8'));
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  const url = String(args[2] ?? '');
  // Payment rather than permission, which \`classifyGhFailure\` calls terminal and
  // \`blockerForGhFailure\` turns into a \`gh-billing\` card — a kind nothing here can re-probe.
  if (url.includes(${JSON.stringify(UNPAID)})) {
    process.stderr.write('HTTP 402: Payment Required — this account\\'s billing needs attention\\n');
    process.exit(1);
  }
  if (!signedIn()) refuseSignedOut();
  const number = (url.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  process.stdout.write(JSON.stringify({
    number: Number(number),
    title: 'Issue ' + number,
    body: 'Nothing declared.',
    state: 'OPEN',
    url,
    comments: [],
  }) + '\\n');
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'item-create') {
  process.stdout.write(JSON.stringify({ id: 'PVTI_draft1', type: 'Draft' }) + '\\n');
  process.exit(0);
}

process.stdout.write('{}\\n');
`, 'utf8');

/**
 * The chat agent, whose whole behaviour is one control file.
 *
 * It records every start, writes its own pid where the check can reach it, and keeps the prompt
 * it was given so that "the prompt reached the agent" is a fact rather than an assumption.
 */
writeFileSync(chatStub, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const mode = (() => {
  try { return readFileSync(${JSON.stringify(chatModePath)}, 'utf8').trim(); }
  catch { return 'plain'; }
})();

/** Composed rather than typed: this whole file is written out of a template literal. */
const FENCE = String.fromCharCode(96).repeat(3);
const block = (payload) => '\\n' + FENCE + 'founder-action\\n' + JSON.stringify(payload)
  + '\\n' + FENCE + '\\n';

let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  appendFileSync(${JSON.stringify(chatLogPath)},
                 JSON.stringify({ mode, argv: process.argv.slice(2), prompt: input }) + '\\n');

  if (mode === 'park') {
    writeFileSync(${JSON.stringify(chatPidPath)}, String(process.pid), 'utf8');
    for (let attempt = 0; attempt < 1800; attempt++) {
      if (existsSync(join(workDir, 'release-chat'))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    process.stdout.write('The parked answer, at last.\\n');
    process.exit(0);
  }

  // The key as \`founderChatPrompt\` spells it — "Its key is \`<key>\`". Read out of the prompt
  // rather than written in here, so that a stub answering with a key nobody gave it would be
  // refused by the parser's identity check instead of quietly applied.
  const key = (input.match(/key is \`([^\`]+)\`/) ?? [])[1] ?? 'unknown';

  if (mode === 'plain') {
    process.stdout.write('The free tier is enough for what you are doing today.\\n');
    process.exit(0);
  }

  // Eight steps, which \`validateFounderAction\` refuses on \`steps\`/\`count\`. Every field is
  // within its own ceiling, so a parser merging without re-validating the whole would take it.
  if (mode === 'bad-patch') {
    process.stdout.write('Here is the answer, and I have rewritten the steps.\\n');
    process.stdout.write(block({
      key,
      title: 'Eight steps is a document',
      steps: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'],
    }));
    process.exit(0);
  }

  if (mode === 'good-patch') {
    process.stdout.write('Done. I have shortened the steps for you.\\n');
    process.stdout.write(block({
      key,
      title: 'Top the account up',
      steps: ['Open the billing page', 'Add a card', 'Try the same thing again'],
    }));
    process.exit(0);
  }

  process.stdout.write('nothing to say\\n');
});
`, 'utf8');

/** Stands in for the implement agent: it records where it was started, and parks. */
writeFileSync(agentStub, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  appendFileSync(${JSON.stringify(implementLogPath)},
                 JSON.stringify({ issue: number, cwd: process.cwd() }) + '\\n');
  for (let attempt = 0; attempt < 1800; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('https://github.com/someone/read-only/pull/' + number + '\\n');
});
`, 'utf8');

/** One board per answer this check needs, each a real repository with an `origin` of its own. */
const BOARDS = [
  // The board whose card is a kind nothing can ever re-probe.
  { id: 'mirror', repo: WRITABLE, project: 5, origin: `https://github.com/${WRITABLE}.git` },
  // The account that may not push, which is the queue's refusal and the publisher's one card.
  { id: 'readonly', repo: READ_ONLY, project: 6, origin: `https://github.com/${READ_ONLY}.git` },
  // No project at all: the fresh clone the column exists for.
  { id: 'noproject', origin: 'https://gitlab.com/someone/nothing.git' },
  // A second board with no project, so the person-resolve case has a card of its own.
  { id: 'person', origin: 'https://gitlab.com/someone/person.git' },
];

function makeProject(board, dir) {
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

for (const board of BOARDS) board.path = makeProject(board, join(workDir, board.id));

writeFileSync(registryPath, JSON.stringify({
  workspaces: BOARDS.map((board) => ({ id: board.id, path: board.path })),
}), 'utf8');

/** The signed-out server's own board, on a registry of its own so its state dir is its own. */
const outPath = makeProject({ id: 'out', repo: WRITABLE, project: 5 }, join(workDir, 'out'));
writeFileSync(outRegistryPath, JSON.stringify({
  workspaces: [{ id: 'out', path: outPath }],
}), 'utf8');

// ─── Reading what the store holds ─────────────────────────────

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

function linesOf(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Wait for something to become true, and fail the run if it never does.
 *
 * `await predicate()` rather than `predicate()`, because half the things this check waits for are
 * read back over HTTP: a promise is truthy, so an asynchronous predicate under a synchronous test
 * would report success on its first tick and every case below it would assert against a state
 * nothing had reached yet.
 */
async function waitFor(predicate, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  console.error(`  FAIL  timed out waiting for ${what}`);
  failures++;
  return false;
}

// ─── The servers ──────────────────────────────────────────────

if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
  console.error('  FAIL  dist/server.js exists — run tsc first');
  process.exit(1);
}

const ghCommand = `node "${ghStub.replace(/\\/g, '/')}"`;
const chatCommand = `node "${chatStub.replace(/\\/g, '/')}"`;
const implementCommand = `node "${agentStub.replace(/\\/g, '/')}"`;

/**
 * Long enough that nothing in this check can be attributed to a timer.
 *
 * The memo especially: section 4 asserts that Done re-probes rather than reading through it, and
 * a window that could have expired on its own would make that section evidence about the clock.
 */
const MEMO_MS = 300_000;
const QUEUE_MS = 300_000;
/** Off entirely on the main server: every card here is filed by a request this check made. */
const PASS_MS = 0;

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

const server = spawnCanvas({
  port,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: ghCommand,
    EXCALIDRAW_AGENT_BACKEND: 'claude-code',
    EXCALIDRAW_ISSUE_AGENT: chatCommand,
    EXCALIDRAW_IMPLEMENT_AGENT: implementCommand,
    EXCALIDRAW_IMPLEMENT_CONCURRENCY: '4',
    EXCALIDRAW_IMPLEMENT_QUEUE_MS: String(QUEUE_MS),
    EXCALIDRAW_FOUNDER_PASS_MS: String(PASS_MS),
    EXCALIDRAW_GH_STATUS_MEMO_MS: String(MEMO_MS),
    EXCALIDRAW_ISSUE_MEMO_MS: '0',
    STUB_GH_LOG: ghLogPath,
    STUB_GH_AUTH: authPath,
  },
});

const outPort = await freePort();
const OUT = `http://127.0.0.1:${outPort}`;

/** The signed-out board, whose `gh` answers from `auth.txt` and whose memo never expires here. */
const outServer = spawnCanvas({
  port: outPort,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: outRegistryPath,
    EXCALIDRAW_GH_COMMAND: ghCommand,
    EXCALIDRAW_FOUNDER_PASS_MS: '600',
    EXCALIDRAW_GH_STATUS_MEMO_MS: String(MEMO_MS),
    EXCALIDRAW_ISSUE_MEMO_MS: '0',
    STUB_GH_LOG: outGhLogPath,
    STUB_GH_AUTH: outAuthPath,
  },
});

/** Whether this machine will let a server sit on `host`. */
function canBind(host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

/** An address the bind guard calls "not loopback" and this machine will bind. */
async function offLoopbackHost() {
  if (await canBind('127.0.0.2')) return '127.0.0.2';
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && (await canBind(entry.address))) {
        console.log(`  note  127.0.0.2 is not bindable here; using the interface ${entry.address}`);
        return entry.address;
      }
    }
  }
  throw new Error('No non-loopback address on this machine could be bound.');
}

const offHost = await offLoopbackHost();
const offPort = await freePort();
const OFF = `http://${offHost}:${offPort}`;

const offServer = spawnCanvas({
  port: offPort,
  env: {
    LOG_LEVEL: 'error',
    HOST: offHost,
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: ghCommand,
    EXCALIDRAW_FOUNDER_PASS_MS: '0',
    STUB_GH_LOG: ghLogPath,
    STUB_GH_AUTH: authPath,
  },
});

async function waitForHealth(base, spawned) {
  for (let attempt = 0; attempt < 200; attempt++) {
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

async function callOn(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const call = (path, options) => callOn(BASE, path, options);
const post = (base, path, payload) =>
  callOn(base, path, { method: 'POST', body: JSON.stringify(payload) });

const issue = (repo, n) => `https://github.com/${repo}/issues/${n}`;
const readIssue = (workspace, url) =>
  call(`/api/issue?workspace=${workspace}&url=${encodeURIComponent(url)}`);

const list = (workspace) => call(`/api/founder-actions?workspace=${workspace}`);
const resolve = (workspace, key, how) =>
  post(BASE, '/api/founder-actions/resolve', { workspace, key, how });
const chat = (workspace, key, message) =>
  post(BASE, '/api/founder-actions/chat', { workspace, key, message });
const chatState = (workspace, key) =>
  call(`/api/founder-actions/chat?workspace=${workspace}&key=${encodeURIComponent(key)}`);

const STARTED = [601];

let restarted = null;

try {
  await waitForHealth(BASE, server);
  await waitForHealth(OUT, outServer);
  await waitForHealth(OFF, offServer);

  // ─── 1 ──────────────────────────────────────────────────────
  console.log('1. a board bound off loopback refuses all four, and an unknown board is a 404');

  const REFUSED = [
    ['GET /api/founder-actions', { path: '/api/founder-actions?workspace=mirror' }],
    ['POST /api/founder-actions/resolve', {
      path: '/api/founder-actions/resolve',
      method: 'POST',
      body: { workspace: 'mirror', key: 'mirror:gh-billing', how: 'person' },
    }],
    ['POST /api/founder-actions/chat', {
      path: '/api/founder-actions/chat',
      method: 'POST',
      body: { workspace: 'mirror', key: 'mirror:gh-billing', message: 'hello' },
    }],
    ['GET /api/founder-actions/chat', {
      path: '/api/founder-actions/chat?workspace=mirror&key=mirror%3Agh-billing',
    }],
  ];
  for (const [name, probe] of REFUSED) {
    const answer = await callOn(OFF, probe.path, {
      method: probe.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
    });
    check(`${name} is refused 403 there`, answer.status === 403,
          `got ${answer.status} ${JSON.stringify(answer.body)}`);
  }

  const unknownList = await list('nobody-registered-this');
  check('the list answers 404 for a workspace nobody registered', unknownList.status === 404,
        `got ${unknownList.status} ${JSON.stringify(unknownList.body)}`);
  check('and says which refusal it is', unknownList.body?.reason === 'no-workspace',
        JSON.stringify(unknownList.body));

  const unknownResolve = await resolve('nobody-registered-this', 'x:gh-login', 'person');
  check('resolve answers 404 for a workspace nobody registered', unknownResolve.status === 404,
        `got ${unknownResolve.status} ${JSON.stringify(unknownResolve.body)}`);
  const unknownKey = await resolve('mirror', 'mirror:nothing-was-ever-filed', 'person');
  check('and 404 for a key nothing filed', unknownKey.status === 404,
        `got ${unknownKey.status} ${JSON.stringify(unknownKey.body)}`);

  const unknownChat = await chat('nobody-registered-this', 'x:gh-login', 'hello');
  check('the chat answers 404 for a workspace nobody registered', unknownChat.status === 404,
        `got ${unknownChat.status} ${JSON.stringify(unknownChat.body)}`);
  const unknownChatKey = await chat('mirror', 'mirror:nothing-was-ever-filed', 'hello');
  check('and 404 for a key nothing filed', unknownChatKey.status === 404,
        `got ${unknownChatKey.status} ${JSON.stringify(unknownChatKey.body)}`);
  const unknownChatRead = await chatState('nobody-registered-this', 'x:gh-login');
  check('and so does the poll it is read through', unknownChatRead.status === 404,
        `got ${unknownChatRead.status} ${JSON.stringify(unknownChatRead.body)}`);

  // ─── 2 ──────────────────────────────────────────────────────
  console.log('\n2. a board with no project is answered, and answering it spawns no gh');

  // The card, filed by a read that was refused over payment: `gh-billing` is one of the three
  // kinds `verifyAgainst` can only ever answer `cannot-say` for.
  const refusedRead = await readIssue('noproject', issue(UNPAID, 11));
  check('the issue read was refused', refusedRead.status >= 400, `got ${refusedRead.status}`);
  await waitFor(() => ofKind(registryPath, 'noproject', 'gh-billing').length > 0,
                'the refused read to leave a founder action on a board with no project');

  const before = linesOf(ghLogPath).length;
  const nowhere = await list('noproject');
  check('a board with no githubProject answers 200', nowhere.status === 200,
        `got ${nowhere.status} ${JSON.stringify(nowhere.body)}`);
  check('with its open actions in it', (nowhere.body?.actions ?? []).length > 0,
        JSON.stringify(nowhere.body?.actions));
  check('and the founder column it resolved',
        nowhere.body?.columnName === 'Founder Actions', JSON.stringify(nowhere.body?.columnName));
  check('and a capabilities object the panel can drive its controls from',
        nowhere.body?.capabilities && typeof nowhere.body.capabilities === 'object'
        && typeof nowhere.body.capabilities.chat === 'boolean',
        JSON.stringify(nowhere.body?.capabilities));
  check('and it spawned no gh at all', linesOf(ghLogPath).length === before,
        JSON.stringify(linesOf(ghLogPath).slice(before)));

  // ─── 3 ──────────────────────────────────────────────────────
  console.log('\n3. a record that was published is not also drawn as a canvas-owned card');

  const refusedStart = await post(BASE, '/api/implement', { workspace: 'readonly', url: issue(READ_ONLY, 601) });
  check('the account that may not push is refused 403', refusedStart.status === 403,
        `got ${refusedStart.status} ${JSON.stringify(refusedStart.body)}`);
  await waitFor(() => ofKind(registryPath, 'readonly', 'push-denied')
    .some((action) => Boolean(action.publishedItemId)), 'the push card to be published');

  const readonly = await list('readonly');
  check('the published record is in the actions the route answers with',
        (readonly.body?.actions ?? []).some((action) => action.kind === 'push-denied'),
        JSON.stringify((readonly.body?.actions ?? []).map((one) => one.key)));
  check('and it is not in the set the canvas owns',
        (readonly.body?.canvas ?? []).every((action) => !action.publishedItemId),
        JSON.stringify((readonly.body?.canvas ?? []).map((one) => [one.key, one.publishedItemId])));
  const unpublished = await list('noproject');
  check('while a record nobody published is', (unpublished.body?.canvas ?? []).length > 0,
        JSON.stringify(unpublished.body?.canvas));

  // ─── 4 ──────────────────────────────────────────────────────
  console.log('\n4. Done re-probes, rather than reading a memo that says what it said before');

  await waitFor(() => ofKind(outRegistryPath, 'out', 'gh-login').length > 0,
                'a signed-out gh to leave a card on the second server');
  const loginKey = ofKind(outRegistryPath, 'out', 'gh-login')[0]?.key;

  const stillOut = await post(OUT, '/api/founder-actions/resolve',
                              { workspace: 'out', key: loginKey, how: 'probe' });
  check('a probe that still says blocked answers 409', stillOut.status === 409,
        `got ${stillOut.status} ${JSON.stringify(stillOut.body)}`);
  check('carrying the probe\'s own sentence rather than a status line',
        /signed in to no account/i.test(String(stillOut.body?.error ?? '')),
        JSON.stringify(stillOut.body));
  check('and the action is still open',
        (ofKind(outRegistryPath, 'out', 'gh-login')[0] ?? {}).state === 'open',
        JSON.stringify(ofKind(outRegistryPath, 'out', 'gh-login')[0]));

  // The memo is five minutes wide and was refreshed a moment ago by the probe above, so a route
  // that read through it would answer 409 here for the rest of this run.
  writeFileSync(outAuthPath, 'in', 'utf8');
  const signedIn = await post(OUT, '/api/founder-actions/resolve',
                              { workspace: 'out', key: loginKey, how: 'probe' });
  check('flipping the sign-in and pressing again is verified at once', signedIn.status === 200,
        `got ${signedIn.status} ${JSON.stringify(signedIn.body)}`);
  check('and the record says a probe closed it',
        (ofKind(outRegistryPath, 'out', 'gh-login')[0] ?? {}).resolvedBy === 'probe',
        JSON.stringify(ofKind(outRegistryPath, 'out', 'gh-login')[0]));

  // ─── 5 ──────────────────────────────────────────────────────
  console.log('\n5. a person may settle anything, and what nothing can check is taken on trust');

  const personRead = await readIssue('person', issue(UNPAID, 12));
  check('the read on the person board was refused', personRead.status >= 400, `got ${personRead.status}`);
  await waitFor(() => ofKind(registryPath, 'person', 'gh-billing').length > 0,
                'a card on the person board');
  const personKey = ofKind(registryPath, 'person', 'gh-billing')[0]?.key;

  const byPerson = await resolve('person', personKey, 'person');
  check('how: person resolves it', byPerson.status === 200,
        `got ${byPerson.status} ${JSON.stringify(byPerson.body)}`);
  const personRecord = ofKind(registryPath, 'person', 'gh-billing')[0] ?? {};
  check('and the record says a person did', personRecord.resolvedBy === 'person',
        JSON.stringify(personRecord));
  check('and that it is settled', personRecord.state === 'resolved', JSON.stringify(personRecord));

  const trustRead = await readIssue('mirror', issue(UNPAID, 13));
  check('the read on the mirror board was refused', trustRead.status >= 400, `got ${trustRead.status}`);
  await waitFor(() => ofKind(registryPath, 'mirror', 'gh-billing').length > 0, 'a card to take on trust');
  const trustKey = ofKind(registryPath, 'mirror', 'gh-billing')[0]?.key;

  const onTrust = await resolve('mirror', trustKey, 'probe');
  check('a kind nothing can check resolves on the first press', onTrust.status === 200,
        `got ${onTrust.status} ${JSON.stringify(onTrust.body)}`);
  check('and the answer says it was taken on trust', onTrust.body?.onTrust === true,
        JSON.stringify(onTrust.body));
  check('with the reason nothing could check it', /can watch a bill|only the next call/i
    .test(String(onTrust.body?.why ?? '')), JSON.stringify(onTrust.body?.why));
  check('and the record says a person settled it, not a probe',
        (ofKind(registryPath, 'mirror', 'gh-billing')[0] ?? {}).resolvedBy === 'person',
        JSON.stringify(ofKind(registryPath, 'mirror', 'gh-billing')[0]));

  // ─── 6 ──────────────────────────────────────────────────────
  console.log('\n6. resolving a push refusal starts the run the queue was refused, at once');

  await post(BASE, '/api/implement/queue', { workspace: 'readonly', enabled: true });
  let pass = null;
  const refusedBy = Date.now() + 15_000;
  while (Date.now() < refusedBy) {
    pass = (await call('/api/implement?workspace=readonly')).body?.queue?.lastPass ?? null;
    if (pass?.reason === 'refused') break;
    await sleep(150);
  }
  check('the queue is refused while the account cannot push', pass?.reason === 'refused',
        JSON.stringify(pass));
  check('and nothing was started', linesOf(implementLogPath).length === 0,
        JSON.stringify(linesOf(implementLogPath)));

  writeFileSync(permissionPath, 'WRITE', 'utf8');
  const pushKey = ofKind(registryPath, 'readonly', 'push-denied')[0]?.key;
  const pushed = await resolve('readonly', pushKey, 'probe');
  check('the push card is verified once the permission is really there', pushed.status === 200,
        `got ${pushed.status} ${JSON.stringify(pushed.body)}`);

  // The queue interval here is five minutes, so a pass inside the next few seconds can only be
  // the one the resolve asked for.
  await waitFor(() => linesOf(implementLogPath).length > 0,
                'the previously refused run to start without waiting out the queue interval');
  const started = linesOf(implementLogPath)[0] ?? {};
  check('the run that starts is the one that was refused', String(started.issue) === '601',
        JSON.stringify(started));
  check('and it was started in a worktree of its own',
        typeof started.cwd === 'string' && /worktree|issue-601/i.test(started.cwd),
        JSON.stringify(started.cwd));

  let after = null;
  const startedBy = Date.now() + 15_000;
  while (Date.now() < startedBy) {
    after = (await call('/api/implement?workspace=readonly')).body?.queue?.lastPass ?? null;
    if (after?.reason === 'started') break;
    await sleep(150);
  }
  check('and the pass that did it is recorded as having started something',
        after?.reason === 'started', JSON.stringify(after));
  await post(BASE, '/api/implement/queue', { workspace: 'readonly', enabled: false });

  // ─── 7 ──────────────────────────────────────────────────────
  console.log('\n7. what the founder typed is in the store before there is a process at all');

  const chatKey = ofKind(registryPath, 'noproject', 'gh-billing')[0]?.key;
  writeFileSync(chatModePath, 'park', 'utf8');
  const parked = await chat('noproject', chatKey, 'Is the free tier enough for this?');
  check('the chat is accepted', parked.status === 202,
        `got ${parked.status} ${JSON.stringify(parked.body)}`);
  await waitFor(() => existsSync(chatPidPath), 'the chat agent to be running');

  const second = await chat('noproject', chatKey, 'And what about next month?');
  check('a second message while one is in flight is refused 409', second.status === 409,
        `got ${second.status} ${JSON.stringify(second.body)}`);
  await sleep(500);
  check('and it spawned no second agent', linesOf(chatLogPath).length === 1,
        JSON.stringify(linesOf(chatLogPath).map((one) => one.mode)));

  const prompt = String(linesOf(chatLogPath)[0]?.prompt ?? '');
  check('the prompt the agent was given names the item', prompt.includes(chatKey), prompt.slice(0, 200));
  check('and carries what the founder typed',
        prompt.includes('Is the free tier enough for this?'), prompt.slice(-300));

  // Killed rather than released: a run that died has still left the words where they were put.
  try {
    process.kill(Number(readFileSync(chatPidPath, 'utf8').trim()), 'SIGKILL');
  } catch { /* nothing was spawned, or it has gone on its own — the cases below say which */ }
  await waitFor(() => (ofKind(registryPath, 'noproject', 'gh-billing')[0]?.chat ?? [])
    .some((turn) => turn.role === 'founder'), 'the founder turn to be in the store');
  const killedTurns = ofKind(registryPath, 'noproject', 'gh-billing')[0]?.chat ?? [];
  check('the founder\'s words survived a run that died', killedTurns.length >= 1
        && killedTurns[0].role === 'founder'
        && killedTurns[0].text === 'Is the free tier enough for this?', JSON.stringify(killedTurns));
  check('and no reply was invented for it',
        !killedTurns.some((turn) => turn.role === 'agent' && turn.text.includes('parked')),
        JSON.stringify(killedTurns));

  // ─── 8 ──────────────────────────────────────────────────────
  console.log('\n8. the register is defended at the door, and the reply arrives either way');

  await waitFor(async () => {
    const state = await chatState('noproject', chatKey);
    return state.body?.run?.state && state.body.run.state !== 'running';
  }, 'the killed run to settle');

  const fieldsBefore = JSON.stringify(ofKind(registryPath, 'noproject', 'gh-billing')[0]?.fields);
  writeFileSync(chatModePath, 'bad-patch', 'utf8');
  const refusedPatch = await chat('noproject', chatKey, 'Rewrite the steps for me.');
  check('the chat is accepted again once nothing is in flight', refusedPatch.status === 202,
        `got ${refusedPatch.status} ${JSON.stringify(refusedPatch.body)}`);
  await waitFor(async () => {
    const state = await chatState('noproject', chatKey);
    return state.body?.run?.state === 'done' || state.body?.run?.state === 'failed';
  }, 'the refused-patch run to settle');

  const refusedState = await chatState('noproject', chatKey);
  check('the reply is still delivered', /rewritten the steps/i.test(String(refusedState.body?.run?.reply ?? '')),
        JSON.stringify(refusedState.body?.run));
  check('and the refusal names the rule that was broken',
        /steps/.test(String(refusedState.body?.run?.refusal ?? ''))
        && /count/.test(String(refusedState.body?.run?.refusal ?? '')),
        JSON.stringify(refusedState.body?.run?.refusal));
  check('and the item is exactly as it was',
        JSON.stringify(ofKind(registryPath, 'noproject', 'gh-billing')[0]?.fields) === fieldsBefore,
        JSON.stringify(ofKind(registryPath, 'noproject', 'gh-billing')[0]?.fields));

  writeFileSync(chatModePath, 'good-patch', 'utf8');
  const goodPatch = await chat('noproject', chatKey, 'Please shorten them.');
  check('a third message is accepted', goodPatch.status === 202,
        `got ${goodPatch.status} ${JSON.stringify(goodPatch.body)}`);
  await waitFor(() => (ofKind(registryPath, 'noproject', 'gh-billing')[0]?.fields?.title ?? '')
    === 'Top the account up', 'the clean patch to reach the store');
  const revised = ofKind(registryPath, 'noproject', 'gh-billing')[0] ?? {};
  check('a clean patch updates the item', revised.fields?.title === 'Top the account up',
        JSON.stringify(revised.fields));
  check('and the steps with it', (revised.fields?.steps ?? []).length === 3,
        JSON.stringify(revised.fields?.steps));
  check('and everything else about the record is untouched',
        revised.kind === 'gh-billing' && revised.key === chatKey && revised.state === 'open',
        JSON.stringify({ kind: revised.kind, key: revised.key, state: revised.state }));

  // ─── 9 ──────────────────────────────────────────────────────
  console.log('\n9. the transcript survives a restart; the run state does not');

  const beforeRestart = await chatState('noproject', chatKey);
  const turns = (beforeRestart.body?.chat ?? []).length;
  check('the conversation is read back from the store', turns >= 4,
        JSON.stringify(beforeRestart.body?.chat?.map((turn) => turn.role)));
  check('and the run it just finished is still in memory',
        Boolean(beforeRestart.body?.run), JSON.stringify(beforeRestart.body?.run));

  server.child.kill('SIGKILL');
  await sleep(600);
  const restartPort = await freePort();
  restarted = spawnCanvas({
    port: restartPort,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: ghCommand,
      EXCALIDRAW_AGENT_BACKEND: 'claude-code',
      EXCALIDRAW_ISSUE_AGENT: chatCommand,
      EXCALIDRAW_FOUNDER_PASS_MS: '0',
      EXCALIDRAW_GH_STATUS_MEMO_MS: String(MEMO_MS),
      STUB_GH_LOG: ghLogPath,
      STUB_GH_AUTH: authPath,
    },
  });
  const RESTART = `http://127.0.0.1:${restartPort}`;
  await waitForHealth(RESTART, restarted);

  const afterRestart = await callOn(
    RESTART, `/api/founder-actions/chat?workspace=noproject&key=${encodeURIComponent(chatKey)}`
  );
  check('the whole transcript is still there', (afterRestart.body?.chat ?? []).length === turns,
        JSON.stringify((afterRestart.body?.chat ?? []).map((turn) => turn.role)));
  check('and the run state is not', afterRestart.body?.run === null,
        JSON.stringify(afterRestart.body?.run));

  // ─── 10 ─────────────────────────────────────────────────────
  console.log('\n10. the documents name the four routes, and the counts are the code\'s');

  const restApi = readFileSync(join(repoRoot, 'docs', 'rest-api.md'), 'utf8');
  for (const route of [
    'GET /api/founder-actions',
    'POST /api/founder-actions/resolve',
    'POST /api/founder-actions/chat',
    'GET /api/founder-actions/chat',
  ]) {
    check(`docs/rest-api.md names \`${route}\` verbatim`, restApi.includes(`\`${route}\``));
  }

  const counts = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-docs-counts.mjs')],
                           { cwd: repoRoot, encoding: 'utf8' });
  check('node scripts/check-docs-counts.mjs exits 0', counts.status === 0,
        `${counts.stdout ?? ''}${counts.stderr ?? ''}`.slice(-600));
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  try { writeFileSync(join(workDir, 'release-chat'), '', 'utf8'); } catch { /* gone */ }
  for (const n of STARTED) {
    try { writeFileSync(join(workDir, `release-${n}`), '', 'utf8'); } catch { /* gone */ }
  }
  await sleep(800);
  for (const spawned of [server, outServer, offServer, restarted]) {
    if (spawned && spawned.child.exitCode === null) spawned.child.kill('SIGKILL');
  }
  await sleep(300);
  for (const board of [...BOARDS.map((one) => one.id), 'out']) {
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
