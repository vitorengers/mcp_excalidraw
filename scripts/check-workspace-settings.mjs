#!/usr/bin/env node
/**
 * Checks that a project's own agent settings reach the process the board spawns.
 *
 * Before this, every agent setting was process-global and read once at module load:
 * `EXCALIDRAW_ISSUE_AGENT` and `EXCALIDRAW_IMPLEMENT_AGENT` were constants handed to
 * `runAgent` verbatim, and the two timeouts were module constants beside them. One board
 * therefore ran every project's agents at the identical model and effort, changeable only
 * by editing a file outside this repository and restarting it.
 *
 * The stub agent here reports its own argv and the prompt it was handed, so the cases can be
 * about the command line and the turn rather than about the agent. Three of them are the
 * feature; the other two are the boundaries it must not cross.
 *
 *  - A project that configures a model and an effort spawns with them.
 *  - A project that configures **nothing** spawns a command line identical, byte for
 *    byte, to the one it spawned before any of this existed — and sends the same prompt,
 *    byte for byte, which is the half that used to be taken on trust: the stub buffered
 *    stdin and then threw it away. That is the same rule `worktreeSection`,
 *    `imageReferenceSection` and `workflowSection` each keep: a feature nobody used must
 *    not change what every board already does.
 *  - A project may retune what the operator granted; it may never grant it. Agents are
 *    off unless the environment says otherwise, so a `board.config.json` inside any
 *    registered project must not be able to start one from nothing — otherwise editing a
 *    JSON file would spawn an unattended agent on a board where nobody allowed it.
 *  - Both timeouts resolve per run, workspace first and environment second.
 *  - The config surface writes that file back without discarding what it does not
 *    understand, and refuses a value of the wrong type on the way in rather than leaving
 *    a config that makes every tab disappear.
 *
 * Self-contained: throwaway registry and projects, a stub agent, its own canvas servers
 * on free ports. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-workspace-settings.mjs
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

/** The two base prompts, so "unchanged" can be an equality rather than a description. */
const { IMPLEMENT_AGENT_PROMPT } =
  await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'implement-agent.js')).href);
const { ISSUE_AGENT_PROMPT } =
  await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-agent.js')).href);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `workspace-settings-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

function makeProject(id, config) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}

/** Configures nothing at all — the byte-for-byte case. */
const plainDir = makeProject('plain', { name: 'Plain', repo: 'vitorengers/mcp_excalidraw' });
/** Retunes both agents. */
const tunedDir = makeProject('tuned', {
  name: 'Tuned',
  repo: 'vitorengers/mcp_excalidraw',
  agents: {
    issue: { model: 'claude-fable-5', effort: 'high' },
    implement: { model: 'claude-opus-5', effort: 'max' },
  },
});
/** Puts a ceiling back that the environment set much higher. */
const impatientDir = makeProject('impatient', {
  name: 'Impatient',
  repo: 'vitorengers/mcp_excalidraw',
  agents: {
    issue: { timeoutSeconds: 2 },
    implement: { timeoutSeconds: 2 },
  },
});
/** Edited through the config surface, and carries a key the loader never reads. */
const editableDir = makeProject('editable', {
  name: 'Editable',
  repo: 'vitorengers/mcp_excalidraw',
  note: 'hand-written, and it stays that way',
});

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'plain', path: slash(plainDir) },
    { id: 'tuned', path: slash(tunedDir) },
    { id: 'impatient', path: slash(impatientDir) },
    { id: 'editable', path: slash(editableDir) },
  ],
}, null, 2), 'utf8');

/**
 * Stands in for both agents, and reports the two facts these cases turn on: the argv and the
 * prompt it was handed. `hold-<id>` makes it wait to be released, which is how a ceiling gets
 * something to fire on.
 */
const agentStub = join(workDir, 'agent.mjs');
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const kind = process.argv.includes('--as-issue') ? 'issue' : 'implement';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const workspace = (input.match(/WORKSPACE:([a-z]+)/) ?? input.match(/\\/ws-([a-z]+)\\//) ?? [])[1] ?? 'unknown';
  writeFileSync(join(workDir, 'prompt-' + kind + '-' + workspace + '.txt'), input, 'utf8');
  // Written last, because every waiter here polls for the argv file: with the prompt written
  // first, a case that reads both cannot find one of them half-written.
  writeFileSync(join(workDir, 'argv-' + kind + '-' + workspace + '.json'),
    JSON.stringify({ argv: process.argv.slice(2) }), 'utf8');

  for (let attempt = 0; attempt < 1800; attempt++) {
    if (!existsSync(join(workDir, 'hold-' + workspace))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const number = kind === 'issue' ? '901' : '902';
  process.stdout.write('https://github.com/vitorengers/mcp_excalidraw/'
    + (kind === 'issue' ? 'issues/' : 'pull/') + number + '\\n');
});
`, 'utf8');

const stub = slash(agentStub);
const ISSUE_COMMAND = `node "${stub}" --as-issue --output-format stream-json`;
// `-p` on the implement half because the stub reads its prompt from stdin, and since #174
// that is what a command has to say for the server to hand it one: a command without it is
// given a terminal and its prompt as an argument instead.
const IMPLEMENT_COMMAND = `node "${stub}" -p --output-format stream-json`;
/** What the stub must see when the project configures nothing at all. */
const PLAIN_ISSUE_ARGV = ['--as-issue', '--output-format', 'stream-json'];
const PLAIN_IMPLEMENT_ARGV = ['-p', '--output-format', 'stream-json'];

const running = [];

function startCanvas(port, { host = '127.0.0.1', implement = true, issue = true } = {}) {
  const env = {
    PORT: String(port),
    HOST: host,
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    // Deliberately generous: the ceilings under test are the per-project ones, and they
    // have to win over these rather than merely coexist.
    EXCALIDRAW_ISSUE_AGENT_TIMEOUT: '900',
    EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT: '900',
  };
  // Left unset rather than deleted: the environment starts with no `EXCALIDRAW_*` in it at
  // all, so "not granted" is simply "never named". Deleting was what the operator's `.env`
  // used to undo, handing this server a real agent for the case that asserts it has none.
  if (issue) env.EXCALIDRAW_ISSUE_AGENT = ISSUE_COMMAND;
  if (implement) env.EXCALIDRAW_IMPLEMENT_AGENT = IMPLEMENT_COMMAND;

  const child = spawnCanvas({
    env,
  }).child;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, child, read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${read()}`);
}

const port = await freePort();
const ungrantedPort = await freePort();
const openPort = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const UNGRANTED_BASE = `http://127.0.0.1:${ungrantedPort}`;
const OPEN_BASE = `http://127.0.0.1:${openPort}`;

async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const api = (base, workspace, path, options) => {
  const glue = path.includes('?') ? '&' : '?';
  return call(base, `${path}${glue}workspace=${workspace}`, options);
};

/**
 * The issue URL a run is asked about, with the workspace id smuggled into the repo name.
 *
 * The stub reads the id back out of the prompt, which is the only channel it has: a
 * command line is exactly what is under test here, so it cannot be told through one.
 * `isIssueUrl` accepts nothing exotic in a repository name, hence `ws-<id>` rather than
 * anything more legible.
 */
const issueUrl = (workspace) => `https://github.com/vitorengers/ws-${workspace}/issues/901`;

const hold = (workspace) => writeFileSync(join(workDir, `hold-${workspace}`), '', 'utf8');
const release = (workspace) => rmSync(join(workDir, `hold-${workspace}`), { force: true });
const argvFile = (kind, workspace) => join(workDir, `argv-${kind}-${workspace}.json`);
const argvOf = (kind, workspace) => JSON.parse(readFileSync(argvFile(kind, workspace), 'utf8')).argv;
const promptOf = (kind, workspace) =>
  readFileSync(join(workDir, `prompt-${kind}-${workspace}.txt`), 'utf8');

/**
 * The prompt each agent sends for a project that has configured nothing.
 *
 * None of the throwaway projects is a git repository, so no worktree section is added; none
 * attaches an image, resumes, or selects a workflow. What is left is the base prompt and the
 * thing the run was asked about, which is what every run sent before any of this existed.
 */
const observationFor = (workspace) => `WORKSPACE:${workspace} please look at this`;
const plainImplementPrompt = (workspace) =>
  `${IMPLEMENT_AGENT_PROMPT}\n\n---\n\nThe issue to implement:\n\n${issueUrl(workspace)}`;
const plainIssuePrompt = (workspace) =>
  `${ISSUE_AGENT_PROMPT}\n\n---\n\nObservation:\n\n${observationFor(workspace)}`;

async function waitFor(predicate, what, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return true;
    await sleep(100);
  }
  failures++;
  console.error(`  FAIL  timed out waiting for ${what}`);
  return false;
}

/** Start an implementation and wait for the stub to say how it was invoked. */
async function spawnImplement(base, workspace) {
  hold(workspace);
  const started = await api(base, workspace, '/api/implement', {
    method: 'POST', body: JSON.stringify({ url: issueUrl(workspace) }),
  });
  await waitFor(() => existsSync(argvFile('implement', workspace)),
                `the implement agent for "${workspace}" to report its argv`);
  return started;
}

/** Start an issue run on a block of its own and wait for the same. */
async function spawnIssue(base, workspace) {
  hold(workspace);
  const created = await api(base, workspace, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 40, y: 40, width: 200, height: 100,
      customData: { kind: 'issue', issueState: 'draft' },
    }),
  });
  const id = created.body?.element?.id;
  if (!id) throw new Error(`could not create an issue block: ${JSON.stringify(created.body)}`);
  await api(base, workspace, `/api/issue-block/${id}`, {
    method: 'POST', body: JSON.stringify({ observation: observationFor(workspace) }),
  });
  await waitFor(() => existsSync(argvFile('issue', workspace)),
                `the issue agent for "${workspace}" to report its argv`);
  return id;
}

async function implementRecord(base, workspace) {
  const response = await api(base, workspace,
    `/api/implement?url=${encodeURIComponent(issueUrl(workspace))}`);
  return response.body?.implement ?? null;
}

async function settledImplement(base, workspace, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const record = await implementRecord(base, workspace);
    if (record?.state && record.state !== 'running') return record;
    await sleep(150);
  }
  return null;
}

async function settledIssue(base, workspace, id, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await api(base, workspace, `/api/elements/${id}`);
    const custom = response.body?.element?.customData ?? {};
    if (custom.issueState && custom.issueState !== 'running') return custom;
    await sleep(150);
  }
  return null;
}

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  const server = startCanvas(port);
  await waitForHealth(BASE, server.child, server.read);

  console.log('1. a project that configures nothing spawns what it always spawned');
  await spawnImplement(BASE, 'plain');
  const plainImplement = argvOf('implement', 'plain');
  check('the implement command line is unchanged', same(plainImplement, PLAIN_IMPLEMENT_ARGV),
        `${JSON.stringify(plainImplement)} — expected ${JSON.stringify(PLAIN_IMPLEMENT_ARGV)}`);
  await spawnIssue(BASE, 'plain');
  const plainIssue = argvOf('issue', 'plain');
  check('and so is the issue one', same(plainIssue, PLAIN_ISSUE_ARGV),
        `${JSON.stringify(plainIssue)} — expected ${JSON.stringify(PLAIN_ISSUE_ARGV)}`);

  // Asserted rather than assumed. Every section a project can add to a prompt is written to
  // return the empty string when it was not selected, and until this compared the whole turn
  // against the composed baseline, nothing here would have failed if one of them stopped.
  const plainImplementPromptSeen = promptOf('implement', 'plain');
  check('the implement prompt is unchanged, byte for byte',
        plainImplementPromptSeen === plainImplementPrompt('plain'),
        `${plainImplementPromptSeen.length} bytes against ${plainImplementPrompt('plain').length}`);
  const plainIssuePromptSeen = promptOf('issue', 'plain');
  check('and so is the issue one',
        plainIssuePromptSeen === plainIssuePrompt('plain'),
        `${plainIssuePromptSeen.length} bytes against ${plainIssuePrompt('plain').length}`);
  release('plain');

  console.log('\n2. a project that configures a model and an effort spawns with them');
  await spawnImplement(BASE, 'tuned');
  const tunedImplement = argvOf('implement', 'tuned');
  check('the implement run carries the project\'s model',
        same(tunedImplement.slice(0, PLAIN_IMPLEMENT_ARGV.length), PLAIN_IMPLEMENT_ARGV)
          && tunedImplement.includes('--model')
          && tunedImplement[tunedImplement.indexOf('--model') + 1] === 'claude-opus-5',
        JSON.stringify(tunedImplement));
  check('and its effort', tunedImplement[tunedImplement.indexOf('--effort') + 1] === 'max',
        JSON.stringify(tunedImplement));
  check('after the operator\'s own flags, so the last one wins',
        tunedImplement.indexOf('--model') > tunedImplement.indexOf('--output-format'),
        JSON.stringify(tunedImplement));
  await spawnIssue(BASE, 'tuned');
  const tunedIssue = argvOf('issue', 'tuned');
  check('the issue run is tuned separately',
        tunedIssue[tunedIssue.indexOf('--model') + 1] === 'claude-fable-5'
          && tunedIssue[tunedIssue.indexOf('--effort') + 1] === 'high',
        JSON.stringify(tunedIssue));
  // The other direction of the same boundary: a model and an effort are how *well* the agent
  // runs, so they belong on the command line and nowhere near what it is told.
  check('and neither prompt learned about any of it',
        promptOf('implement', 'tuned') === plainImplementPrompt('tuned')
          && promptOf('issue', 'tuned') === plainIssuePrompt('tuned'),
        'a run that reads its own tuning would send two different prompts on two boards');
  release('tuned');

  console.log('\n3. a project may retune what the operator granted; it may never grant it');
  const ungranted = startCanvas(ungrantedPort, { implement: false, issue: false });
  await waitForHealth(UNGRANTED_BASE, ungranted.child, ungranted.read);
  const refusedImplement = await api(UNGRANTED_BASE, 'tuned', '/api/implement', {
    method: 'POST', body: JSON.stringify({ url: issueUrl('tuned') }),
  });
  check('implementing stays disabled', refusedImplement.status === 404,
        `got ${refusedImplement.status} ${JSON.stringify(refusedImplement.body)}`);
  check('and says which variable would enable it',
        /EXCALIDRAW_IMPLEMENT_AGENT/.test(refusedImplement.body?.error ?? ''), refusedImplement.body?.error);
  const configWithCommand = await call(UNGRANTED_BASE, '/api/workspaces/tuned/config', {
    method: 'PUT',
    body: JSON.stringify({ config: { agents: { implement: { command: 'node evil.mjs' } } } }),
  });
  check('and a command is not a thing a project may configure at all',
        configWithCommand.status === 400,
        `got ${configWithCommand.status} ${JSON.stringify(configWithCommand.body)}`);

  console.log('\n4. both ceilings resolve per project, workspace first and environment second');
  hold('impatient');
  const impatientIssueId = await spawnIssue(BASE, 'impatient');
  const issueOutcome = await settledIssue(BASE, 'impatient', impatientIssueId);
  check('the issue run was stopped by the project\'s ceiling, not the environment\'s',
        /after 2s/.test(issueOutcome?.issueError ?? ''), JSON.stringify(issueOutcome?.issueError));
  await spawnImplement(BASE, 'impatient');
  const implementOutcome = await settledImplement(BASE, 'impatient');
  check('and so was the implementation', /after 2s/.test(implementOutcome?.error ?? ''),
        JSON.stringify(implementOutcome?.error));
  release('impatient');

  console.log('\n5. the config surface writes the file back without damaging it');
  const saved = await call(BASE, '/api/workspaces/editable/config', {
    method: 'PUT',
    body: JSON.stringify({
      config: {
        name: 'Renamed From The Board',
        githubProject: 'https://github.com/users/vitorengers/projects/5',
        agents: { implement: { model: 'claude-sonnet-5', effort: 'low', timeoutSeconds: 30 } },
      },
    }),
  });
  check('the save is accepted', saved.status === 200, `got ${saved.status} ${JSON.stringify(saved.body)}`);
  const written = JSON.parse(readFileSync(join(editableDir, 'board.config.json'), 'utf8'));
  check('the new name is on disk', written.name === 'Renamed From The Board', JSON.stringify(written));
  check('the agent settings are too',
        written.agents?.implement?.model === 'claude-sonnet-5'
          && written.agents.implement.effort === 'low'
          && written.agents.implement.timeoutSeconds === 30,
        JSON.stringify(written.agents));
  check('a field it was not asked about is left alone', written.repo === 'vitorengers/mcp_excalidraw',
        JSON.stringify(written));
  check('and a key the loader never reads survives the round trip',
        written.note === 'hand-written, and it stays that way', JSON.stringify(written));

  const relisted = await call(BASE, '/api/workspaces');
  const editable = (relisted.body?.workspaces ?? []).find((workspace) => workspace.id === 'editable');
  check('and the change is listed without a restart', editable?.name === 'Renamed From The Board',
        JSON.stringify(editable));

  console.log('\n6. and refuses a value of the wrong type rather than breaking every tab');
  const wrongType = await call(BASE, '/api/workspaces/editable/config', {
    method: 'PUT', body: JSON.stringify({ config: { name: 42 } }),
  });
  check('400 for a name that is not a string', wrongType.status === 400,
        `got ${wrongType.status} ${JSON.stringify(wrongType.body)}`);
  const wrongEffort = await call(BASE, '/api/workspaces/editable/config', {
    method: 'PUT', body: JSON.stringify({ config: { agents: { issue: { effort: 'ludicrous' } } } }),
  });
  check('400 for an effort the CLI does not have', wrongEffort.status === 400,
        `got ${wrongEffort.status} ${JSON.stringify(wrongEffort.body)}`);
  check('and the refusal lists the ones it does',
        /max/.test(wrongEffort.body?.error ?? ''), wrongEffort.body?.error);
  const stillThere = JSON.parse(readFileSync(join(editableDir, 'board.config.json'), 'utf8'));
  check('neither refusal touched the file', stillThere.name === 'Renamed From The Board',
        JSON.stringify(stillThere));
  const unknownWorkspace = await call(BASE, '/api/workspaces/not-registered/config', {
    method: 'PUT', body: JSON.stringify({ config: { name: 'x' } }),
  });
  check('404 for a workspace that is not registered', unknownWorkspace.status === 404,
        `got ${unknownWorkspace.status}`);

  console.log('\n7. and only while the board is bound to loopback');
  const open = startCanvas(openPort, { host: '0.0.0.0' });
  await waitForHealth(OPEN_BASE, open.child, open.read);
  const refusedSave = await call(OPEN_BASE, '/api/workspaces/editable/config', {
    method: 'PUT', body: JSON.stringify({ config: { name: 'From The Network' } }),
  });
  check('403 for the save', refusedSave.status === 403,
        `got ${refusedSave.status} ${JSON.stringify(refusedSave.body)}`);
  check('and the refusal names loopback', /loopback/i.test(refusedSave.body?.error ?? ''),
        refusedSave.body?.error);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const workspace of ['plain', 'tuned', 'impatient', 'editable']) {
    try { release(workspace); } catch { /* the world may already be gone */ }
  }
  await sleep(400);
  stopAll();
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
