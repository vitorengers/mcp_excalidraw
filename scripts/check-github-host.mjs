#!/usr/bin/env node
/**
 * Checks that `github.com` is one decision this board states, rather than five it assumes.
 *
 * The host was compiled into five independent patterns — the issue URL guard, the URL taken
 * out of an agent's output, the project URL parser, the `origin` remote parser and the URL
 * rebuilt for an interrupted run — and none of them said so. What a GitHub Enterprise Server
 * user got was therefore not "this board reads github.com" but a series of statements that
 * their perfectly valid URL was malformed: `Not a GitHub issue URL: …` from the routes, and
 * `Agent finished without returning an issue URL` from a run that had just created one.
 *
 * #322 decided the honest version for a launch: **github.com is a requirement**, stated once
 * in `src/core/github-host.ts` and in the setup documentation, rather than a host resolved per
 * workspace. So the refusals name the host they require, and the five patterns are held to the
 * same answer for the same URL — which is the part prose cannot do on its own.
 *
 * The remote parser is here for more than symmetry. It matched `github.com` anywhere in the
 * remote's text, so `https://mygithub.com/acme/tools.git` parsed as `acme/tools` and an
 * interrupted run in that checkout was announced with a link to `github.com/acme/tools` — a
 * repository belonging to somebody else entirely, on a host the operator never named. Section
 * 5 runs that through real git repositories rather than through the pattern, because the
 * decision has to be the same whichever door it is reached by.
 *
 * Self-contained: throwaway git repositories, a stub `gh`, a stub agent, its own canvas server
 * on a free port. Nothing here talks to GitHub and nothing needs a browser. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-github-host.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
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
const slash = (value) => String(value).replace(/\\/g, '/');

const workDir = join(tmpdir(), `check-github-host-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// Set before the first import of anything compiled: the logger reads it once, at load, and
// the interrupted-run warning is only ever written through the logger.
const logPath = join(workDir, 'server.log');
process.env.LOG_FILE_PATH = logPath;

/**
 * A compiled module, or null when this build has not got it.
 *
 * Tolerant on purpose. Run against the old code, `core/github-host.js` does not exist at
 * all, and a hard exit there would report one missing file rather than the eleven refusals
 * and patterns that are the actual defect.
 */
async function loadDist(relative) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) return null;
  try {
    return await import(pathToFileURL(modulePath).href);
  } catch (error) {
    console.error(`  note  dist/${slash(relative)} would not load: ${error.message}`);
    return null;
  }
}

function required(module, name, what) {
  if (!module) {
    console.error(`  FAIL  ${what} — dist module missing; run tsc first`);
    process.exit(1);
  }
  return module[name];
}

const hostModule = await loadDist(join('core', 'github-host.js'));
const issueModule = await loadDist(join('core', 'github-issue.js'));
const agentModule = await loadDist(join('core', 'issue-agent.js'));
const boardModule = await loadDist(join('core', 'project-board.js'));
const recoveryModule = await loadDist(join('core', 'implement-recovery.js'));
const worktreeModule = await loadDist(join('core', 'implement-worktree.js'));

const isIssueUrl = required(issueModule, 'isIssueUrl', 'the issue URL guard');
const extractGithubUrl = required(agentModule, 'extractGithubUrl', 'the agent output reader');
const parseProjectUrl = required(boardModule, 'parseProjectUrl', 'the project URL parser');
const issueUrlFor = required(recoveryModule, 'issueUrlFor', 'the interrupted-run URL builder');
const runAgent = required(agentModule, 'runAgent', 'the agent runner');
const agentRunFor = required(agentModule, 'agentRunFor', 'the backend resolver');
const interruptedRuns = required(recoveryModule, 'interruptedRuns', 'interrupted-run detection');

// ─── 1. the host is named in one place ─────────────────────────

console.log('1. the host is stated once, where all five patterns can reach it');

check('there is a module that says which host this board reads',
      Boolean(hostModule), 'dist/core/github-host.js does not exist');
check('and it names github.com as a value, not as a spelling in five regexes',
      hostModule?.GITHUB_HOST === 'github.com', String(hostModule?.GITHUB_HOST));
check('the remote parser lives there, so a check can ask it directly',
      typeof hostModule?.repoFromRemoteUrl === 'function', typeof hostModule?.repoFromRemoteUrl);
check('and so does the refusal an issue URL on another host gets',
      typeof hostModule?.issueUrlRefusal === 'function', typeof hostModule?.issueUrlRefusal);

/**
 * The remote parser, or a stand-in that fails every case rather than throwing on the first.
 *
 * The stand-in is `owner/name`-shaped on purpose: a sentinel the URL builder would refuse
 * anyway would let "no interrupted-run URL is rebuilt" pass in a build that has no parser.
 */
const repoFromRemote = (remote) =>
  typeof hostModule?.repoFromRemoteUrl === 'function'
    ? hostModule.repoFromRemoteUrl(remote)
    : 'no-repoFromRemoteUrl/in-this-build';

// ─── 2. five patterns, one decision ────────────────────────────

console.log('\n2. the same URL gets the same answer from all five patterns');

/**
 * One host, in each of the five shapes the five patterns are asked about.
 *
 * `mygithub.com` is not a hypothetical: it is a real host whose name *contains* github.com,
 * and the remote parser matched exactly that.
 */
const HOSTS = [
  { what: 'a GitHub Enterprise Server host', host: 'github.acme-corp.com' },
  { what: 'GitLab', host: 'gitlab.com' },
  { what: 'a host whose name merely contains github.com', host: 'mygithub.com' },
  { what: 'a host that ends in github.com', host: 'evil-github.com' },
];

for (const { what, host } of HOSTS) {
  const issueUrl = `https://${host}/acme/tools/issues/7`;
  const projectUrl = `https://${host}/users/acme/projects/5`;
  const remote = `https://${host}/acme/tools.git`;

  check(`${what}: the issue URL guard refuses it`, isIssueUrl(issueUrl) === false, issueUrl);
  check(`${what}: nothing is extracted from an agent that printed it`,
        extractGithubUrl(`I opened ${issueUrl}\n`, 'issues') === null,
        String(extractGithubUrl(`I opened ${issueUrl}\n`, 'issues')));
  check(`${what}: the project URL parser refuses it`,
        parseProjectUrl(projectUrl) === null, JSON.stringify(parseProjectUrl(projectUrl)));
  check(`${what}: the origin remote parser refuses it`,
        repoFromRemote(remote) === null, JSON.stringify(repoFromRemote(remote)));
  check(`${what}: and no interrupted-run URL is rebuilt for it`,
        issueUrlFor(repoFromRemote(remote), 'issue-7') === null,
        String(issueUrlFor(repoFromRemote(remote), 'issue-7')));
}

// A GitLab remote in the shape git actually stores it, which is not a URL at all.
check('a GitLab ssh remote is refused too',
      repoFromRemote('git@gitlab.com:acme/tools.git') === null,
      JSON.stringify(repoFromRemote('git@gitlab.com:acme/tools.git')));

console.log('\n3. and github.com itself is still read, in every shape');

const OK_ISSUE = 'https://github.com/vitorengers/vibemaxxing/issues/322';

check('the issue URL guard takes a github.com issue', isIssueUrl(OK_ISSUE) === true);
check('an agent that printed one is read',
      extractGithubUrl(`Opened ${OK_ISSUE}\n`, 'issues') === OK_ISSUE,
      String(extractGithubUrl(`Opened ${OK_ISSUE}\n`, 'issues')));
check('a github.com project URL parses',
      parseProjectUrl('https://github.com/users/someone/projects/5')?.login === 'someone');

for (const remote of [
  'git@github.com:vitorengers/vibemaxxing.git',
  'https://github.com/vitorengers/vibemaxxing.git',
  'https://github.com/vitorengers/vibemaxxing',
  'ssh://git@github.com/vitorengers/vibemaxxing.git',
  'https://vitorengers@github.com/vitorengers/vibemaxxing.git',
]) {
  check(`the origin remote parser reads ${remote}`,
        repoFromRemote(remote) === 'vitorengers/vibemaxxing', JSON.stringify(repoFromRemote(remote)));
}

check('and an interrupted run in that checkout gets its issue URL back',
      issueUrlFor(repoFromRemote('git@github.com:vitorengers/vibemaxxing.git'), 'issue-322')
        === 'https://github.com/vitorengers/vibemaxxing/issues/322',
      String(issueUrlFor(repoFromRemote('git@github.com:vitorengers/vibemaxxing.git'), 'issue-322')));

// ─── 4. the refusals name the host ─────────────────────────────

console.log('\n4. the refusals name the host they require');

const refusal = typeof hostModule?.issueUrlRefusal === 'function'
  ? hostModule.issueUrlRefusal('https://github.acme-corp.com/acme/tools/issues/7')
  : '(no issueUrlRefusal in this build)';

check('an issue URL on another host is refused by naming github.com',
      /github\.com/.test(refusal) && /only/i.test(refusal), refusal);
check('and it quotes back the URL that was refused',
      refusal.includes('https://github.acme-corp.com/acme/tools/issues/7'), refusal);
check('rather than calling a valid enterprise URL malformed',
      !/not a github issue url/i.test(refusal) && !/malformed/i.test(refusal), refusal);

// ─── 5. the checkout whose origin is somewhere else ────────────

console.log('\n5. an interrupted run in a checkout that is not on github.com');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

/** A real project, with a real `origin`, holding a real worktree with work in it. */
function makeProject(name, origin) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'check@example.com']);
  git(dir, ['config', 'user.name', 'Check']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name }), 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);

  const run = join(`${dir}-worktrees`, 'issue-7');
  mkdirSync(`${dir}-worktrees`, { recursive: true });
  git(dir, ['worktree', 'add', '-b', 'issue-7', run, 'main']);
  writeFileSync(join(run, 'work.txt'), 'half a change\n', 'utf8');
  git(run, ['add', '.']);
  git(run, ['commit', '-m', 'issue-7 step 1']);
  return dir;
}

/** The workspace shape the recovery path reads. No `repo`: `origin` is the whole question. */
const workspaceAt = (dir, id) => ({
  id,
  path: dir,
  innerPath: slash(dir),
  environment: { kind: 'native' },
});

const logSince = (mark) => readFileSync(logPath, 'utf8').slice(mark);
const logMark = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0);

{
  const project = makeProject('gitlab-origin', 'git@gitlab.com:acme/tools.git');
  const mark = logMark();
  const runs = await interruptedRuns(workspaceAt(project, 'gitlab-origin'));
  const warning = logSince(mark);

  check('a checkout whose origin is GitLab reports no interrupted run',
        runs.length === 0, JSON.stringify(runs.map((run) => run.issueUrl)));
  check('and the warning says the remote is not a github.com one',
        /github\.com/.test(warning) && /origin/i.test(warning), warning.trim().slice(-400));
  check('naming the remote it found rather than a setting to add',
        /gitlab\.com/.test(warning), warning.trim().slice(-400));
  check('and it does not answer a GitLab remote with "repo" in board.config.json',
        !/board\.config\.json/.test(warning), warning.trim().slice(-400));
}

{
  // The trap this pattern actually held: a host whose *name* contains github.com parsed, and
  // the run was announced with a link to a stranger's repository on github.com.
  const project = makeProject('lookalike-origin', 'https://mygithub.com/acme/tools.git');
  const runs = await interruptedRuns(workspaceAt(project, 'lookalike-origin'));

  check('a checkout on a host merely named like github.com reports no run',
        runs.length === 0, JSON.stringify(runs.map((run) => run.issueUrl)));
  check('so nothing is ever linked to somebody else\'s repository on github.com',
        !runs.some((run) => run.issueUrl.startsWith('https://github.com/acme/tools/')),
        JSON.stringify(runs.map((run) => run.issueUrl)));
}

{
  const project = makeProject('no-origin', null);
  const mark = logMark();
  const runs = await interruptedRuns(workspaceAt(project, 'no-origin'));
  const warning = logSince(mark);

  check('a checkout with no origin at all still reports no run', runs.length === 0);
  check('and is still told the two ways to name its repository',
        /board\.config\.json/.test(warning) && /origin/i.test(warning), warning.trim().slice(-400));
}

{
  const project = makeProject('github-origin', 'git@github.com:vitorengers/vibemaxxing.git');
  const runs = await interruptedRuns(workspaceAt(project, 'github-origin'));

  check('and a github.com checkout still has its interrupted run found',
        runs.length === 1
          && runs[0]?.issueUrl === 'https://github.com/vitorengers/vibemaxxing/issues/7',
        JSON.stringify(runs.map((run) => run.issueUrl)));
}

// ─── 6. what an agent that opened an enterprise issue is told ──

console.log('\n6. an agent that reported a URL on another host');

const stubAgentPath = join(workDir, 'stub-agent.mjs');
writeFileSync(stubAgentPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write('Opened https://github.acme-corp.com/acme/tools/issues/7\\n');
  process.exit(0);
});
`, 'utf8');

{
  const project = makeProject('agent-run', 'git@github.com:vitorengers/vibemaxxing.git');
  const run = await runAgent(workspaceAt(project, 'agent-run'), 'do the thing', {
    // The passthrough backend, which is what a free-text command line has always been.
    ...agentRunFor({ backend: 'raw', command: `node "${slash(stubAgentPath)}"` }, 'issue', null),
    expects: 'issues',
    what: 'the issue run',
    timeoutMs: 60_000,
  });

  check('the run is not reported as a success', run.ok === false, JSON.stringify(run.error));
  check('and the failure names the host the URL had to be on',
        typeof run.error === 'string' && /github\.com/.test(run.error), String(run.error));
}

// ─── 7. and through the wire ───────────────────────────────────

console.log('\n7. and the routes a person actually meets it through');

const ghLogPath = join(workDir, 'gh-calls.log');
const stubGhPath = join(workDir, 'stub-gh.mjs');
const registryPath = join(workDir, 'workspaces.json');

writeFileSync(ghLogPath, '', 'utf8');
writeFileSync(stubGhPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 322, title: 'State github.com as required', body: '', state: 'OPEN', comments: [],
  }));
} else if (args[0] === 'issue' && args[1] === 'comment') {
  process.stdout.write('https://github.com/vitorengers/vibemaxxing/issues/322#issuecomment-1\\n');
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

const projectDir = join(workDir, 'wired');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
              JSON.stringify({ name: 'Wired', repo: 'vitorengers/vibemaxxing' }, null, 2), 'utf8');
writeFileSync(registryPath,
              JSON.stringify({ workspaces: [{ id: 'wired', path: slash(projectDir) }] }, null, 2), 'utf8');

const port = await freePort();
const server = spawnCanvas({
  port,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${slash(stubGhPath)}"`,
    STUB_GH_LOG: ghLogPath,
    // Only so the implement route gets past "implementing is disabled" and reaches the URL
    // guard. The refusal happens before anything is spawned, so this command never runs.
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${slash(stubAgentPath)}"`,
  },
});
const BASE = server.base;

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the canvas server exited early:\n${server.read()}`);
    }
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${server.read()}`);
}

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const ENTERPRISE = 'https://github.acme-corp.com/acme/tools/issues/7';
const named = (error) => typeof error === 'string' && /github\.com/.test(error)
  && !/^not a github issue url/i.test(error);

try {
  await waitForHealth();

  const read = await call(`/api/issue?workspace=wired&url=${encodeURIComponent(ENTERPRISE)}`);
  check('reading an enterprise issue is refused', read.status === 400,
        `${read.status} ${JSON.stringify(read.body)}`);
  check('by naming github.com as the requirement', named(read.body?.error),
        JSON.stringify(read.body));

  const commented = await call('/api/issue/comment', {
    method: 'POST',
    body: JSON.stringify({ url: ENTERPRISE, body: 'anything' }),
  });
  check('commenting on one is refused the same way', commented.status === 400,
        `${commented.status} ${JSON.stringify(commented.body)}`);
  check('in the same words', named(commented.body?.error), JSON.stringify(commented.body));

  const implemented = await call('/api/implement', {
    method: 'POST',
    body: JSON.stringify({ workspace: 'wired', url: ENTERPRISE }),
  });
  check('and implementing one is refused by naming the host too',
        implemented.status === 400 && named(implemented.body?.error),
        `${implemented.status} ${JSON.stringify(implemented.body)}`);

  const ok = await call(
    `/api/issue?workspace=wired&url=${encodeURIComponent('https://github.com/vitorengers/vibemaxxing/issues/322')}`
  );
  check('and a github.com issue is still read', ok.status === 200 && ok.body?.issue?.number === 322,
        `${ok.status} ${JSON.stringify(ok.body).slice(0, 300)}`);
} finally {
  server.stop();
}

// ─── 8. and it is written down where somebody sets the board up ─

console.log('\n8. the requirement is in the setup documentation');

const running = readFileSync(join(repoRoot, 'docs', 'running.md'), 'utf8');
check('docs/running.md says which host the board reads',
      /github\.com/.test(running) && /\bonly\b/i.test(running),
      'no sentence in docs/running.md states the host requirement');
check('and says it is a requirement rather than a default',
      /(requires?|only)[^.\n]{0,80}github\.com/i.test(running)
        || /github\.com[^.\n]{0,80}(required|only)/i.test(running),
      'the host is mentioned but not as a requirement');

// A live server holds handles that would keep this process up after the last case.
await sleep(200);
// Forgiven: on Windows a killed server's handles on its state directory are
// released asynchronously, and a run that reported failure because it could not
// delete a temporary directory would be wrong about the thing it measured (#472).
try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
