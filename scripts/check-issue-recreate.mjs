#!/usr/bin/env node
/**
 * Checks that an issue the board already opened can be researched again, in place.
 *
 * Until now a created issue could only be *appended* to. **Add observations** posts a GitHub
 * comment (#53), and a comment cannot correct a body: the implement agent is told to read
 * both and to treat the comment as the later word, which asks it to reconcile two texts that
 * contradict each other when what the reader wanted was one text that is right. So when the
 * first investigation went the wrong way — wrong root cause, wrong file cited, a scope that
 * misses the point — the wrong body survived and the next reader of it was an unattended
 * coding agent.
 *
 * **Recreate with observations** is the way back, and it rewrites the issue rather than
 * replacing it: the same number, the same project card, the same comments. That is only safe
 * while nothing has been built against it, which is what the Todo gate is for — rewriting a
 * body under a live implement agent would change the specification behind its back.
 *
 * The cases below are the ones the shape of the plumbing decides:
 *
 *  - the run reaches the agent with the issue and the observations, and the agent is told to
 *    edit in place;
 *  - the observations are posted to the issue as a comment first, so the body never changes
 *    with nothing on the issue explaining why — and they reach `gh` on **stdin**, never in
 *    argv, for the reason `check-issue-comment.mjs` exists: a WSL workspace runs the command
 *    line through `bash -lc`, and `$(echo hi)` in a command line is executed rather than
 *    posted;
 *  - every refusal fires, and each says which one it is;
 *  - the issue number is unchanged, and the memo is dropped so the next read is the new body;
 *  - the "one observation, one issue" guard on the block routes is untouched.
 *
 * What it cannot check is the button. `check-issue-recreate-browser.mjs` is that half — this
 * project has shipped three UI defects that compiled perfectly.
 *
 * Self-contained: it writes a stub `gh` and a stub agent, starts its own canvas servers
 * against throwaway workspaces and kills them. Nothing here talks to GitHub and nothing runs
 * a real coding agent. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-issue-recreate.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const serverPath = join(repoRoot, 'dist', 'server.js');
if (!existsSync(serverPath)) {
  console.error('  FAIL  the compiled server exists — dist/server.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

// ─── Fixtures ─────────────────────────────────────────────────

const REPO = 'vitorengers/mcp_excalidraw';
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

/**
 * One issue per case, so no two cases can be confused for one another.
 *
 * `column` is where the project's card for it sits; `null` means the project has never heard
 * of the issue at all, which is a different refusal from "in the wrong column".
 */
const ISSUES = {
  101: { column: TODO, state: 'OPEN', title: 'A first investigation that went the wrong way' },
  102: { column: DONE, state: 'OPEN', title: 'An issue somebody already shipped' },
  103: { column: null, state: 'OPEN', title: 'An issue that is not on the project' },
  104: { column: TODO, state: 'CLOSED', title: 'An issue nobody is going to do' },
  105: { column: TODO, state: 'OPEN', title: 'An issue an agent is already implementing' },
  106: { column: TODO, state: 'OPEN', title: 'An issue whose recreate is still going' },
  107: { column: TODO, state: 'OPEN', title: 'An issue on a board with no project' },
  108: { column: TODO, state: 'OPEN', title: 'An issue whose recreate fails' },
  109: { column: TODO, state: 'OPEN', title: 'An issue whose agent answers about another' },
  110: { column: DOING, state: 'OPEN', title: 'An issue in the column a run moved it to' },
};

const boardPayload = () => ({
  data: {
    owner: {
      projectV2: {
        id: 'PVT_kwHOBVSHIs4BefUS',
        title: 'mcp_excalidraw',
        url: 'https://github.com/users/vitorengers/projects/5',
        field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
        items: {
          pageInfo: { hasNextPage: false },
          nodes: Object.entries(ISSUES)
            .filter(([, issue]) => issue.column)
            .map(([number, issue]) => ({
              id: `PVTI_${number}`,
              fieldValueByName: { optionId: issue.column.id, name: issue.column.name },
              content: {
                __typename: 'Issue',
                number: Number(number),
                title: issue.title,
                url: issueUrl(number),
                createdAt: '2026-07-20T10:00:00Z',
                state: issue.state,
                repository: { nameWithOwner: REPO },
              },
            })),
        },
      },
    },
  },
});

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `check-issue-recreate-${process.pid}`);
const ghStub = join(workDir, 'stub-gh.mjs');
const agentStub = join(workDir, 'stub-agent.mjs');
const implementStub = join(workDir, 'stub-implement.mjs');
const boardPath = join(workDir, 'board.json');
const storePath = join(workDir, 'issues.json');
const ghLogPath = join(workDir, 'gh-calls.jsonl');
const promptDir = join(workDir, 'prompts');
const holdFlag = join(workDir, 'hold');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(promptDir, { recursive: true });

/**
 * The issues, as a file the stubs share.
 *
 * The stub agent rewrites a body here the way a real one would rewrite it on GitHub, and the
 * stub `gh issue view` reads it back — which is what makes "the next read is the new body" a
 * fact this check can observe rather than an assumption about the memo.
 */
writeFileSync(storePath, JSON.stringify(
  Object.fromEntries(Object.entries(ISSUES).map(([number, issue]) => [number, {
    number: Number(number),
    title: issue.title,
    body: `The first investigation of ${number}, which went the wrong way.`,
    state: issue.state,
    comments: [],
  }]))
), 'utf8');

writeFileSync(boardPath, JSON.stringify(boardPayload()), 'utf8');
writeFileSync(ghLogPath, '', 'utf8');

/**
 * A `gh` that records both halves of every call.
 *
 * `args` is what a shell would have seen and `stdin` is what it would never have touched, so
 * a body that leaked onto a command line is visible here rather than only on GitHub.
 */
writeFileSync(ghStub, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const store = () => JSON.parse(readFileSync(process.env.STUB_GH_ISSUES, 'utf8'));
const save = (all) => writeFileSync(process.env.STUB_GH_ISSUES, JSON.stringify(all), 'utf8');
const record = (stdin) => appendFileSync(process.env.STUB_GH_LOG, JSON.stringify({ args, stdin }) + '\\n');
const numberOf = () => {
  const url = args.find((argument) => argument.startsWith('https://')) ?? '';
  return /\\/(\\d+)$/.exec(url)?.[1] ?? '';
};

if (args[0] === 'issue' && args[1] === 'comment') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    record(input);
    const all = store();
    const issue = all[numberOf()];
    if (!issue) { process.stderr.write('stub gh: no such issue\\n'); process.exit(1); }
    issue.comments.push({
      author: { login: 'vitorengers' },
      body: input,
      createdAt: '2026-07-28T12:00:00Z',
      url: 'https://github.com/${REPO}/issues/' + issue.number + '#issuecomment-' + (issue.comments.length + 1),
    });
    save(all);
    process.stdout.write('commented\\n');
  });
} else if (args[0] === 'issue' && args[1] === 'view') {
  record(null);
  const issue = store()[numberOf()];
  if (!issue) { process.stderr.write('stub gh: no such issue\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    comments: issue.comments,
    stateReason: null,
    closedByPullRequestsReferences: [],
  }));
} else if (args.includes('graphql')) {
  record(null);
  process.stdout.write(readFileSync(process.env.STUB_GH_BOARD, 'utf8'));
} else if (args.includes('item-edit')) {
  record(null);
  process.stdout.write('{}\\n');
} else {
  record(null);
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

/**
 * An "agent" that does to the issue store what a real one would do to GitHub.
 *
 * It writes the whole prompt it was given to a file, so the cases below can ask what the
 * agent was actually told rather than what the route meant to tell it. The issue it works on
 * is the one named in the prompt: the same command stands in for every case on one server.
 *
 *  - 106 hangs until a flag file appears, which is how "already in flight" is observed;
 *  - 108 prints nothing, which is a run that rewrote nothing;
 *  - 109 answers with a different issue, which must not be read as success.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const number = /issues\\/(\\d+)/.exec(input)?.[1] ?? '';
  writeFileSync(join(process.env.STUB_AGENT_PROMPTS, number + '.txt'), input, 'utf8');

  if (number === '106') {
    while (!existsSync(process.env.STUB_AGENT_HOLD)) await sleep(100);
  }
  if (number === '108') {
    process.stdout.write('I could not work out what this issue is about.\\n');
    return;
  }

  const observations = input.split('New observations:')[1] ?? '';
  const all = JSON.parse(readFileSync(process.env.STUB_GH_ISSUES, 'utf8'));
  const issue = all[number];
  if (issue) {
    // What a real agent does with \`gh issue edit --body-file -\`: same number, new body.
    issue.body = 'Rewritten after: ' + observations.trim();
    writeFileSync(process.env.STUB_GH_ISSUES, JSON.stringify(all), 'utf8');
  }

  process.stdout.write('done\\n');
  process.stdout.write('https://github.com/${REPO}/issues/'
    + (number === '109' ? '999' : number) + '\\n');
});
`, 'utf8');

/** Stands in for the implement agent, and answers at once with a pull request. */
writeFileSync(implementStub, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('https://github.com/${REPO}/pull/900\\n');
});
`, 'utf8');

/** Two boards: one mirroring the project, one with no project at all. */
const WORKSPACES = [
  { id: 'mirrored', config: { githubProject: 'https://github.com/users/vitorengers/projects/5' } },
  { id: 'projectless', config: {} },
];

for (const workspace of WORKSPACES) {
  const dir = join(workDir, workspace.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({
    name: workspace.id, repo: REPO, ...workspace.config,
  }), 'utf8');
  workspace.path = dir.replace(/\\/g, '/');
}

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: WORKSPACES.map((workspace) => ({ id: workspace.id, path: workspace.path })),
}), 'utf8');

// ─── The servers ──────────────────────────────────────────────

const port = await freePort();
const remotePort = await freePort();
const barePort = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const REMOTE = `http://127.0.0.1:${remotePort}`;
const BARE = `http://127.0.0.1:${barePort}`;

const running = [];

function startCanvas(thisPort, host, { agent = true } = {}) {
  const env = {
    PORT: String(thisPort),
    HOST: host,
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${implementStub.replace(/\\/g, '/')}" -p`,
    STUB_GH_ISSUES: storePath,
    STUB_GH_BOARD: boardPath,
    STUB_GH_LOG: ghLogPath,
    STUB_AGENT_PROMPTS: promptDir,
    STUB_AGENT_HOLD: holdFlag,
  };
  // Nothing to delete in the other case: the child's environment starts with no
  // `EXCALIDRAW_*` in it at all, so "not granted" is "never named".
  if (agent) env.EXCALIDRAW_ISSUE_AGENT = `node "${agentStub.replace(/\\/g, '/')}"`;

  const child = spawnCanvas({
    env,
  }).child;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, started) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (started.child.exitCode !== null) {
      throw new Error(`the canvas server exited early:\n${started.read()}`);
    }
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${started.read()}`);
}

async function call(path, options = {}, { base = BASE, workspace = 'mirrored' } = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${base}${path}${glue}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const recreate = (number, observations, options = {}) => call('/api/issue/recreate', {
  method: 'POST',
  body: JSON.stringify({ url: options.url ?? issueUrl(number), observations }),
}, options);

const recordFor = async (number, options = {}) =>
  (await call(`/api/issue/recreate?url=${encodeURIComponent(issueUrl(number))}`, {}, options))
    .body?.recreate ?? null;

/** Wait for a recreate to leave `running`, so a later assertion is not racing it. */
async function settle(number, options = {}) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const record = await recordFor(number, options);
    if (record && record.state !== 'running') return record;
    await sleep(100);
  }
  return await recordFor(number, options);
}

const ghCalls = () =>
  readFileSync(ghLogPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const commentCalls = () => ghCalls().filter((entry) => entry.args[1] === 'comment');
const editCalls = () => ghCalls().filter((entry) => entry.args[1] === 'edit');
const promptFor = (number) => {
  const path = join(promptDir, `${number}.txt`);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const storedIssue = (number) => JSON.parse(readFileSync(storePath, 'utf8'))[String(number)];

/**
 * Everything a shell would have mangled, in one set of observations.
 *
 * `$(echo hi)` is the one that decides it: reaching a `bash -lc` it becomes `hi`, and what
 * the agent is told to re-investigate is not what the reader wrote.
 */
const NASTY = [
  'The root cause is in another file entirely.',
  '',
  'Verbatim, please — "double" and \'single\' quotes, `backticks`,',
  '$(echo hi) and $HOME and ${PATH}, a semicolon; a pipe | and an & ampersand,',
  'a > redirect and a < one, and a trailing backslash \\',
].join('\n');

try {
  const local = startCanvas(port, '127.0.0.1');
  await waitForHealth(BASE, local);

  console.log('1. an open issue in Todo can be researched again');
  // Read first, so the memo holds the old body when the run lands. Without that, case 6
  // would pass on a memo that was simply empty.
  const before = await call(`/api/issue?url=${encodeURIComponent(issueUrl(101))}`);
  check('the issue reads before the run', before.status === 200, JSON.stringify(before.body).slice(0, 200));
  check('with the body the first investigation left',
        /went the wrong way/.test(before.body?.issue?.body ?? ''), before.body?.issue?.body);

  const started = await recreate(101, NASTY);
  check('202, because the run outlives the request', started.status === 202,
        `got ${started.status}: ${JSON.stringify(started.body).slice(0, 300)}`);
  check('and it says a run is under way', started.body?.state === 'running', JSON.stringify(started.body));
  const first = await settle(101);
  check('the run lands as done', first?.state === 'done', JSON.stringify(first));

  console.log('\n2. the agent is told which issue, and what is new about it');
  const prompt = promptFor(101);
  check('the agent was given the issue URL', prompt.includes(issueUrl(101)), prompt.slice(0, 200));
  check('and the observations, byte for byte', prompt.includes(NASTY),
        'the observations did not reach the agent unchanged');
  check('a substitution a shell would have run is still text', prompt.includes('$(echo hi)'),
        'the observations were expanded somewhere between the route and the agent');

  console.log('\n3. the instruction is to rewrite in place, not to open a second issue');
  const { ISSUE_REVISE_PROMPT } = await import(
    pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-agent.js')).href
  );
  check('there is a revise prompt of its own', typeof ISSUE_REVISE_PROMPT === 'string' && ISSUE_REVISE_PROMPT.length > 0);
  const revise = ISSUE_REVISE_PROMPT ?? '';
  check('it names gh issue edit', /gh issue edit/.test(revise), revise.slice(0, 200));
  check('with the body on stdin, never on a command line', /--body-file -/.test(revise),
        'a body interpolated into a command line is executed by a WSL bash -lc');
  check('it forbids creating a new issue', /gh issue create/.test(revise),
        'nothing tells the agent not to open a second issue for the same observation');
  check('it says the issue number does not change', /number/i.test(revise), revise.slice(-400));
  check('it reads the comments as well as the body', /--comments/.test(revise), revise.slice(0, 400));
  check('and it keeps the English rule', /English/.test(revise), revise.slice(0, 400));

  console.log('\n4. the observations are posted to the issue, on stdin and never in argv');
  const comment = commentCalls().find((entry) => (entry.args[2] ?? '').endsWith('/101'));
  check('a comment was posted for the run', Boolean(comment), JSON.stringify(commentCalls().map((c) => c.args)));
  check('argv is the command and nothing else',
        JSON.stringify(comment?.args ?? []) ===
          JSON.stringify(['issue', 'comment', issueUrl(101), '--body-file', '-']),
        JSON.stringify(comment?.args));
  check('the observations arrived on stdin, byte for byte', (comment?.stdin ?? '').includes(NASTY),
        JSON.stringify(comment?.stdin));
  check('and no fragment of them is in argv',
        !(comment?.args ?? []).some((argument) => /echo hi|backticks|quotes/.test(argument)),
        JSON.stringify(comment?.args));
  check('the server never runs gh issue edit itself — that is the agent\'s to do',
        editCalls().length === 0, JSON.stringify(editCalls().map((entry) => entry.args)));

  console.log('\n5. the issue is the same issue afterwards');
  const rewritten = storedIssue(101);
  check('same number', rewritten?.number === 101, JSON.stringify(rewritten).slice(0, 200));
  check('new body', /Rewritten after/.test(rewritten?.body ?? ''), rewritten?.body);
  check('and its comments are intact', (rewritten?.comments ?? []).length >= 1,
        JSON.stringify(rewritten?.comments ?? []).slice(0, 200));

  console.log('\n6. selecting the card straight afterwards shows the new body');
  const after = await call(`/api/issue?url=${encodeURIComponent(issueUrl(101))}`);
  check('the read is served the rewritten body, with no memo window to wait out',
        /Rewritten after/.test(after.body?.issue?.body ?? ''), after.body?.issue?.body);

  console.log('\n7. an issue that is not in Todo is refused, and told why');
  const shipped = await recreate(102, 'This one is already done.');
  check('409 for a card in another column', shipped.status === 409,
        `got ${shipped.status}: ${JSON.stringify(shipped.body).slice(0, 300)}`);
  check('and the refusal names the column it is in and the one it should be in',
        /Done/.test(shipped.body?.error ?? '') && /Todo/.test(shipped.body?.error ?? ''),
        shipped.body?.error);

  const inProgress = await recreate(110, 'Someone is on this.');
  check('409 for a card in the column a run moves it to', inProgress.status === 409,
        `got ${inProgress.status}: ${JSON.stringify(inProgress.body).slice(0, 200)}`);

  const offBoard = await recreate(103, 'This one was never added to the project.');
  check('409 for an issue the project has never heard of', offBoard.status === 409,
        `got ${offBoard.status}: ${JSON.stringify(offBoard.body).slice(0, 200)}`);
  check('and it says so rather than blaming the column',
        /not on this project/i.test(offBoard.body?.error ?? ''), offBoard.body?.error);

  console.log('\n8. a closed issue is refused');
  const closed = await recreate(104, 'Reopening this line of thought.');
  check('409', closed.status === 409, `got ${closed.status}: ${JSON.stringify(closed.body).slice(0, 200)}`);
  check('and it says the issue is closed', /closed/i.test(closed.body?.error ?? ''), closed.body?.error);

  console.log('\n9. an issue with an implementation against it is refused');
  const implemented = await call('/api/implement', {
    method: 'POST', body: JSON.stringify({ url: issueUrl(105) }),
  });
  check('the stub implementation started', implemented.status === 202, `got ${implemented.status}`);
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = (await call(`/api/implement?url=${encodeURIComponent(issueUrl(105))}`)).body?.implement;
    if (record?.state && record.state !== 'running') break;
    await sleep(100);
  }
  const built = await recreate(105, 'Too late, but here it is.');
  check('409', built.status === 409, `got ${built.status}: ${JSON.stringify(built.body).slice(0, 300)}`);
  check('and it names the run standing in the way',
        /implementation/i.test(built.body?.error ?? ''), built.body?.error);

  console.log('\n10. a second recreate for the same issue is refused while the first runs');
  rmSync(holdFlag, { force: true });
  const held = await recreate(106, 'The first run, which hangs.');
  check('the first one starts', held.status === 202, `got ${held.status}`);
  await (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (promptFor(106)) return;
      await sleep(100);
    }
  })();
  const second = await recreate(106, 'The second one, arriving while the first runs.');
  check('409 for the second', second.status === 409,
        `got ${second.status}: ${JSON.stringify(second.body).slice(0, 200)}`);
  check('and it says one is already in flight',
        /in flight|already/i.test(second.body?.error ?? ''), second.body?.error);
  writeFileSync(holdFlag, '', 'utf8');
  const releasedRecord = await settle(106);
  check('the first one finishes once it is let go', releasedRecord?.state === 'done',
        JSON.stringify(releasedRecord));
  const third = await recreate(106, 'And a third, once the first has landed.');
  check('and a later one is accepted', third.status === 202,
        `got ${third.status}: ${JSON.stringify(third.body).slice(0, 200)}`);
  await settle(106);

  console.log('\n11. nothing to work from is refused before any process is spawned');
  const spawnedBefore = ghCalls().length;
  const empty = await recreate(101, '');
  check('400 for no observations', empty.status === 400, `got ${empty.status}`);
  const blank = await recreate(101, '   \n\t ');
  check('400 for whitespace only', blank.status === 400, `got ${blank.status}`);
  const notAnIssue = await recreate(0, 'something', { url: `https://github.com/${REPO}` });
  check('400 for a URL that is not an issue', notAnIssue.status === 400, `got ${notAnIssue.status}`);
  check('and none of them spawned a gh', ghCalls().length === spawnedBefore,
        `${ghCalls().length - spawnedBefore} extra call(s)`);

  console.log('\n12. a board with no project has no column to gate on, and is served anyway');
  const dormantBefore = ghCalls().filter((entry) => entry.args.includes('graphql')).length;
  const dormant = await recreate(107, 'A board with no project still gets to fix its issues.',
                                 { workspace: 'projectless' });
  check('202', dormant.status === 202, `got ${dormant.status}: ${JSON.stringify(dormant.body).slice(0, 300)}`);
  const dormantRecord = await settle(107, { workspace: 'projectless' });
  check('and the run lands', dormantRecord?.state === 'done', JSON.stringify(dormantRecord));
  check('with no project read: a dormant board stays as dormant as it was',
        ghCalls().filter((entry) => entry.args.includes('graphql')).length === dormantBefore,
        'the Todo gate read a project this board does not have');

  console.log('\n13. a run that rewrites nothing is a failure, and says so');
  const barren = await recreate(108, 'This one the agent cannot work out.');
  check('202 — the refusals are the guards, not the outcome', barren.status === 202, `got ${barren.status}`);
  const barrenRecord = await settle(108);
  check('the record ends failed', barrenRecord?.state === 'failed', JSON.stringify(barrenRecord));
  check('and carries something to read', Boolean(barrenRecord?.error), JSON.stringify(barrenRecord));

  console.log('\n14. an agent that answers about a different issue is not believed');
  // A run is read as successful from the URL it prints, the way researching is. Printing
  // some other issue's URL is how a revise that opened a second issue would look, and it
  // must not be recorded as this issue having been rewritten.
  const stray = await recreate(109, 'The agent will answer about issue 999.');
  check('202', stray.status === 202, `got ${stray.status}`);
  const strayRecord = await settle(109);
  check('the record ends failed', strayRecord?.state === 'failed', JSON.stringify(strayRecord));
  check('and the error names the issue it was supposed to rewrite',
        (strayRecord?.error ?? '').includes(issueUrl(109)), JSON.stringify(strayRecord));

  console.log('\n15. the "one observation, one issue" guard on a block is untouched');
  const block = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 400, height: 120,
      customData: {
        kind: 'issue', issueState: 'created', issueUrl: issueUrl(101), issueTitle: 'An issue',
        observation: 'the original observation',
      },
    }),
  });
  const blockId = block.body?.element?.id;
  check('a created block exists to try it on', Boolean(blockId), JSON.stringify(block.body).slice(0, 200));

  const rerun = await call(`/api/issue-block/${blockId}`, {
    method: 'POST', body: JSON.stringify({ observation: 'try to research it again' }),
  });
  check('POST still refuses a block that already has an issue', rerun.status === 409,
        `got ${rerun.status}: ${JSON.stringify(rerun.body).slice(0, 200)}`);

  const reset = await call(`/api/issue-block/${blockId}`, { method: 'DELETE' });
  check('DELETE still answers', reset.status === 200, `got ${reset.status}`);
  const afterReset = (await call(`/api/elements/${blockId}`)).body?.element?.customData ?? {};
  check('and puts the block back to created rather than making it runnable again',
        afterReset.issueState === 'created' && afterReset.issueUrl === issueUrl(101),
        JSON.stringify(afterReset));

  console.log('\n16. it spawns an agent, so it refuses off loopback and without one configured');
  const remote = startCanvas(remotePort, '0.0.0.0');
  await waitForHealth(REMOTE, remote);
  const off = await recreate(101, 'from the network', { base: REMOTE });
  check('403 Forbidden off loopback', off.status === 403,
        `got ${off.status}: ${JSON.stringify(off.body).slice(0, 200)}`);
  check('and it says loopback', /loopback/i.test(off.body?.error ?? ''), off.body?.error);

  const bare = startCanvas(barePort, '127.0.0.1', { agent: false });
  await waitForHealth(BARE, bare);
  const disabled = await recreate(101, 'with no agent configured', { base: BARE });
  check('404 with EXCALIDRAW_ISSUE_AGENT unset', disabled.status === 404,
        `got ${disabled.status}: ${JSON.stringify(disabled.body).slice(0, 200)}`);
  check('and it names the variable that would enable it',
        /EXCALIDRAW_ISSUE_AGENT/.test(disabled.body?.error ?? ''), disabled.body?.error);

  console.log('\n17. the panel can tell which shapes to offer it on, without reading a header');
  const layout = await import(
    pathToFileURL(join(repoRoot, 'dist', 'core', 'project-board-layout.js')).href
  );
  const board = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'project-board.js')).href);
  const panel = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'panel-target.js')).href);
  const appearance = await import(
    pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-appearance.js')).href
  );

  const laid = layout.layoutMirror(
    { ...board.toBoard(boardPayload()), todoColumn: 'todo' },
    { x: 0, y: 0 }
  );
  const cardFor = (number) => laid.elements.find((element) => element.id === `pb-c-PVTI_${number}`);
  check('a card in Todo is marked as such', cardFor(101)?.customData?.inTodo === true,
        JSON.stringify(cardFor(101)?.customData));
  check('matched without regard to case, like every other column lookup here',
        cardFor(106)?.customData?.inTodo === true, JSON.stringify(cardFor(106)?.customData));
  check('a card in another column is not', !cardFor(102)?.customData?.inTodo,
        JSON.stringify(cardFor(102)?.customData));

  const target = panel.resolvePanelTarget(laid.elements, [`pb-c-PVTI_101`]);
  check('and the mark reaches the panel target', target?.issue?.recreatable === true,
        JSON.stringify(target?.issue));
  const elsewhere = panel.resolvePanelTarget(laid.elements, [`pb-c-PVTI_102`]);
  check('while a card elsewhere resolves to a target that offers nothing',
        elsewhere?.issue?.recreatable === false, JSON.stringify(elsewhere?.issue));

  check('an open issue in Todo with no run offers the control',
        appearance.offersRecreate({ githubState: 'OPEN', implementState: null, recreatable: true }));
  check('a closed one does not',
        !appearance.offersRecreate({ githubState: 'CLOSED', implementState: null, recreatable: true }));
  check('one with a run against it does not',
        !appearance.offersRecreate({ githubState: 'OPEN', implementState: 'done', recreatable: true })
        && !appearance.offersRecreate({ githubState: 'OPEN', implementState: 'running', recreatable: true })
        && !appearance.offersRecreate({ githubState: 'OPEN', implementState: 'interrupted', recreatable: true }));
  check('and one outside Todo does not',
        !appearance.offersRecreate({ githubState: 'OPEN', implementState: null, recreatable: false }));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
