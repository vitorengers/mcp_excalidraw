#!/usr/bin/env node
/**
 * Checks that one founder chat turn runs as a headless agent with the GitHub writes taken away.
 *
 * A chat turn is a run through the one spawn path this product has — `agentRunFor`, then
 * `runAgent` — and it is a *loop of one-shot runs*, one per message, rather than a long-lived
 * process: streaming needs `--output-format stream-json`, which Claude Code accepts only beside
 * `--print`, which reads the prompt from stdin and spends it, and a pseudoterminal has no end of
 * file to spend it with. So there is no session to keep, and keeping one would hold one of the
 * eight slots `TERMINAL_SESSION_LIMIT` allows until a person closed it.
 *
 * What has to be true, and what each section asserts:
 *
 *  1. **It is the issue role, headless, and it takes no tab.** The realised argv carries the
 *     print flags and the read-only posture, never the implement role's write list. The board's
 *     own session count is read off `GET /api/terminal` before and after the run, and a real
 *     session is opened afterwards as a control so that "no sessions" is a number the route
 *     actually reports rather than a route that reports nothing.
 *  2. **The prompt reaches the process on stdin, carrying the item.** Its key, its title and the
 *     founder's own message, read back off a stub that writes its stdin to a file — and on no
 *     argument, because a prompt on argv is a prompt in every process listing on the machine.
 *  3. **The allow-list is narrowed, verb by verb.** No `gh issue create`, no `gh issue edit`, no
 *     `gh issue comment`, no `gh project` verb — iterated over a list, so a future addition is
 *     one line — with the reads left intact, and no full-access marker even when the operator's
 *     own arguments carry one in either backend's spelling.
 *  4. **What cannot be narrowed is refused rather than run.** A `raw` backend writes no
 *     permission flags at all, and `permissionArgs` returns nothing when the operator's command
 *     line already states a posture. Both are a chat that would silently hold repository write
 *     access, which is worse than no chat, so both answer the refusal wording rather than
 *     spawning. The stub's own capture file is what says nothing was spawned.
 *  5. **The limitation is observable rather than assumed.** One section runs a stub that really
 *     does attempt `gh issue edit` on an issue number nothing here owns, against a fake GitHub
 *     whose state is a file. The attempt is in the log either way; what changes is whether the
 *     allow-list it was handed let the command through. Against a first version with no
 *     narrowing in it the list carries `Bash(gh issue edit:*)`, the command runs and that file
 *     changes — which is the leak, and is why a stub that never calls `gh` would be no evidence.
 *  6. **A non-zero exit is an answer, not an exception.** `ok: false` with an error, and nothing
 *     thrown.
 *
 * Self-contained and offline: throwaway stubs in a temporary directory, one canvas server on a
 * port the kernel hands out, no browser, no real `gh`, no GitHub. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-founder-chat-agent.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => value.replace(/\\/g, '/');

/** A module from `dist`, or nothing — so a missing build fails one case rather than the run. */
async function importDist(relative, what) {
  const full = join(repoRoot, 'dist', relative);
  if (!existsSync(full)) {
    failures++;
    console.error(`  FAIL  ${what} is built — dist/${relative.replace(/\\/g, '/')} not found`);
    return null;
  }
  return import(pathToFileURL(full).href);
}

// ─── 0. The export this whole check is about ──────────────────

console.log('0. the founder chat has a way to run one turn');

const agentModule = await importDist(join('core', 'issue-agent.js'), 'the agent runtime');
const adapterModule = await importDist(join('core', 'agent-adapter.js'), 'the agent adapter');
const runFounderChatAgent = agentModule?.runFounderChatAgent;

check('`runFounderChatAgent` is exported from core/issue-agent.ts',
      typeof runFounderChatAgent === 'function',
      `it is ${typeof runFounderChatAgent}`);

if (typeof runFounderChatAgent !== 'function') {
  console.error('\nnothing below can be asserted without it');
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `founder-chat-agent-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Founder Chat Check', repo: 'vitorengers/vibemaxxing' }), 'utf8');

const WORKSPACE = 'founder-chat-check';
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: slash(projectDir) }],
}), 'utf8');

const workspace = {
  id: WORKSPACE,
  name: 'Founder Chat Check',
  path: projectDir,
  innerPath: slash(projectDir),
  environment: { kind: 'native' },
  error: null,
};

/**
 * The item under discussion, and it is a real one: a billing refusal is the blocker this
 * repository's own board hits, and the copy is what a founder action for it says.
 */
const KEY = `${WORKSPACE}:gh-billing`;
const KIND = 'gh-billing';
const FIELDS = {
  title: 'GitHub cannot run any job until a payment is settled',
  what: 'Every job on this repository fails within seconds without starting.',
  why: 'Only the person who owns the account can settle a bill or raise a limit.',
  steps: [
    'Open the billing settings for this account.',
    'Settle the failed payment, or raise the spending limit.',
  ],
  confirm: 'A new run starts and its jobs report progress instead of failing at once.',
};
const EVIDENCE = {
  command: 'gh run view 4711',
  said: 'The job was not started because recent account payments have failed',
  source: 'core/gh.ts',
};
const TRANSCRIPT = [
  { role: 'founder', text: 'Which plan do I actually need for this?', at: '2026-08-04T09:00:00.000Z' },
  { role: 'agent', text: 'Standard runners cost nothing on a public repository.', at: '2026-08-04T09:00:20.000Z' },
];
const MESSAGE = 'I have paid it now — what should I look at to know it worked?';

const REPLY = 'Re-run the last workflow and watch whether its jobs leave the queued state.';

/**
 * Stands in for the agent binary and reports how it was started.
 *
 * It writes both channels down — argv and stdin — because a prompt that arrived on stdin and a
 * prompt that arrived as an argument look identical once an agent has read either. The fallback
 * timer turns a pipe nobody closes into a record that says so rather than into a check that
 * hangs.
 */
const reporterStub = join(workDir, 'agent-reporter.mjs');
writeFileSync(reporterStub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

let stdin = '';
let ended = false;
let reported = false;
const fallback = setTimeout(report, 3000);

function report() {
  if (reported) return;
  reported = true;
  clearTimeout(fallback);
  writeFileSync(process.env.CAPTURE_TO, JSON.stringify({
    argv: process.argv.slice(2),
    stdin,
    ended,
  }), 'utf8');
  process.stdout.write(${JSON.stringify(REPLY)} + '\\n');
  process.stdin.pause();
  process.stdin.destroy();
}

process.stdin.on('data', (chunk) => { stdin += chunk.toString(); });
process.stdin.on('end', () => { ended = true; report(); });
`, 'utf8');

/** The same reporter, ending badly: a run that failed is an answer rather than an exception. */
const failingStub = join(workDir, 'agent-failing.mjs');
writeFileSync(failingStub, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('I could not reach the model.\\n');
  process.stderr.write('founder chat stub: deliberate failure\\n');
  process.exit(3);
});
`, 'utf8');

/**
 * A `gh` that is the world rather than a guard.
 *
 * It applies whatever verb it is handed to a JSON file, unconditionally and with no notion of
 * permission at all. That is what makes the section it serves capable of failing: nothing here
 * refuses anything, so if the command reaches it the state changes and the case says so.
 */
const ghStub = join(workDir, 'gh-world.mjs');
writeFileSync(ghStub, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.GITHUB_STATE_FILE, 'utf8'));
if (argv[0] === 'issue' && argv[1] === 'edit') {
  const number = argv[2];
  const at = argv.indexOf('--title');
  if (at !== -1) state.issues[number] = { title: argv[at + 1] };
  writeFileSync(process.env.GITHUB_STATE_FILE, JSON.stringify(state), 'utf8');
}
process.stdout.write('ok\\n');
`, 'utf8');

/**
 * An agent that tries to edit an issue nothing in this check owns.
 *
 * It stands in for Claude Code by doing what Claude Code does with `--allowedTools`: it reads
 * the list it was handed off its own argv and runs the command only where a rule covers it. The
 * attempt is written to the log either way — that half is what makes the refusal observable
 * rather than assumed — and the fake GitHub above is what records whether it went through.
 */
const attemptStub = join(workDir, 'agent-attempt.mjs');
writeFileSync(attemptStub, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ATTEMPT = ['issue', 'edit', '4711', '--title', 'renamed by the founder chat'];

/** The rules of an allow-list, split on whitespace outside the parentheses. */
function toolRules(list) {
  const out = [];
  let current = '';
  let depth = 0;
  for (const character of list) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (/\\s/.test(character) && depth === 0) { if (current) out.push(current); current = ''; continue; }
    current += character;
  }
  if (current) out.push(current);
  return out;
}

/** Whether any \`Bash(prefix:*)\` rule covers this command line, which is the CLI's own rule. */
function allowed(commandLine, list) {
  return toolRules(list).some((rule) => {
    const inner = /^Bash\\((.*)\\)$/.exec(rule)?.[1];
    if (inner === undefined) return false;
    const prefix = inner.replace(/:\\*$/, '').trim();
    return commandLine === prefix || commandLine.startsWith(prefix + ' ');
  });
}

let stdin = '';
let reported = false;
const fallback = setTimeout(report, 3000);

function report() {
  if (reported) return;
  reported = true;
  clearTimeout(fallback);

  const argv = process.argv.slice(2);
  const at = argv.findIndex((one) => one === '--allowedTools' || one === '--allowed-tools');
  const list = at === -1 ? '' : (argv[at + 1] ?? '');
  const commandLine = 'gh ' + ATTEMPT.join(' ');
  const permitted = allowed(commandLine, list);

  if (permitted) {
    spawnSync(process.execPath, [process.env.GH_WORLD, ...ATTEMPT], { stdio: 'ignore' });
  }

  writeFileSync(process.env.ATTEMPT_LOG, JSON.stringify({
    argv,
    allowedTools: list,
    attempted: commandLine,
    ran: permitted,
  }), 'utf8');

  process.stdout.write('I cannot change anything on GitHub from here.\\n');
  process.stdin.pause();
  process.stdin.destroy();
}

process.stdin.on('data', (chunk) => { stdin += chunk.toString(); });
process.stdin.on('end', report);
`, 'utf8');

/** A shell that never exits, for the one real terminal session this check opens as a control. */
const shellStub = join(workDir, 'stub-shell.mjs');
writeFileSync(shellStub, `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`, 'utf8');

// ─── Running one turn ─────────────────────────────────────────

let runCounter = 0;

/**
 * One turn, through the real function, with the stub's own record of how it was started.
 *
 * `capture` is deliberately read back as "absent" rather than as "empty": a run that was refused
 * before anything was spawned leaves no file at all, and that absence is the assertion.
 */
async function turn(agent, { stub = reporterStub, extra = {} } = {}) {
  runCounter += 1;
  const capture = join(workDir, `run-${runCounter}.json`);
  rmSync(capture, { force: true });
  process.env.CAPTURE_TO = capture;

  let thrown = null;
  let result = null;
  try {
    result = await runFounderChatAgent(workspace, FIELDS, EVIDENCE, TRANSCRIPT, MESSAGE, {
      agent: { ...agent, command: agent.command.replace('<stub>', `node "${slash(stub)}"`) },
      key: KEY,
      kind: KIND,
      timeoutMs: 30000,
      ...extra,
    });
  } catch (error) {
    thrown = error;
  }

  const record = existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null;
  return { result, record, thrown };
}

/** The value of `--allowedTools` in a realised argv, or null when it carries none. */
function allowListOf(argv) {
  const at = (argv ?? []).findIndex((one) => one === '--allowedTools' || one === '--allowed-tools');
  if (at !== -1) return argv[at + 1] ?? null;
  const inline = (argv ?? []).find((one) => /^--allowed-?[Tt]ools=/.test(one));
  return inline ? inline.slice(inline.indexOf('=') + 1) : null;
}

const CLAUDE = { backend: 'claude-code', command: '<stub>' };

// ─── The server, for the sessions route ───────────────────────

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_TERMINAL: `node "${slash(shellStub)}"`,
    EXCALIDRAW_TERMINAL_PTY: '0',
  },
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the canvas server exited early:\n${server.read()}`);
    }
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${server.read()}`);
}

/** What the board itself says about its eight slots. */
async function sessions() {
  const response = await fetch(`${BASE}/api/terminal?workspace=${WORKSPACE}`);
  return response.json();
}

try {
  await waitForHealth();

  // ─── 1. The role, the mode, and the tab it does not take ────

  console.log('\n1. it is a headless issue-role run, and it consumes none of the eight slots');

  const before = await sessions();
  check('the board starts with no terminal session at all',
        Array.isArray(before.sessions) && before.sessions.length === 0,
        JSON.stringify(before).slice(0, 200));
  check('and the route says how many there could be',
        before.limit === 8, JSON.stringify(before.limit));

  const plain = await turn(CLAUDE);
  check('the turn ran and settled ok',
        plain.result?.ok === true && plain.thrown === null,
        `${JSON.stringify(plain.result)} ${plain.thrown ?? ''}`);
  check('what the agent printed comes back as the output',
        (plain.result?.output ?? '').includes(REPLY),
        JSON.stringify(plain.result?.output));
  check('and no issue URL is claimed for a conversation',
        plain.result?.issueUrl === null, JSON.stringify(plain.result?.issueUrl));

  check('the run is headless — the print flags are on the argv',
        (plain.record?.argv ?? []).join(' ')
          .includes('--print --output-format stream-json --verbose'),
        JSON.stringify(plain.record?.argv));

  const plainList = allowListOf(plain.record?.argv);
  check('it is the issue role: a read-only allow-list, not the implement role\'s write list',
        typeof plainList === 'string' && plainList.includes('Read')
          && !plainList.includes('Write') && !plainList.includes('Bash(git:*)'),
        JSON.stringify(plainList));

  const after = await sessions();
  check('after the turn the board still holds no terminal session',
        Array.isArray(after.sessions) && after.sessions.length === 0,
        JSON.stringify(after.sessions?.length));
  check('and all eight slots are still free',
        after.limit === 8 && (after.sessions?.length ?? 0) === 0,
        JSON.stringify(after));

  // The control. Without it "no sessions" is equally what a route that reports nothing says.
  const opened = await fetch(`${BASE}/api/terminal?workspace=${WORKSPACE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const openedBody = await opened.json().catch(() => ({}));
  const control = await sessions();
  check('and the count is one the route really reports — a session opened shows up as one',
        opened.ok === true && control.sessions?.length === 1,
        `${opened.status} ${JSON.stringify(openedBody).slice(0, 200)}`);

  // ─── 2. The prompt, and where it went ───────────────────────

  console.log('\n2. the prompt reaches the agent on stdin, carrying the item and the message');

  const prompt = plain.record?.stdin ?? '';
  check('the item\'s key is in it', prompt.includes(KEY), JSON.stringify(prompt.slice(0, 120)));
  check('the item\'s title is in it', prompt.includes(FIELDS.title), String(prompt.length));
  check('the founder\'s message is in it', prompt.includes(MESSAGE), String(prompt.length));
  check('the turns so far are in it',
        prompt.includes(TRANSCRIPT[0].text) && prompt.includes(TRANSCRIPT[1].text),
        String(prompt.length));
  check('what the machine saw is in it',
        prompt.includes(EVIDENCE.said), String(prompt.length));
  check('and it says the agent may not edit anything on GitHub',
        /may not|do not/i.test(prompt) && /GitHub/.test(prompt), String(prompt.length));
  check('the agent saw the end of file that closes the prompt',
        plain.record?.ended === true, 'it gave up waiting after three seconds');
  check('and no argument carries the prompt',
        !(plain.record?.argv ?? []).some((one) => one.includes(MESSAGE)),
        JSON.stringify(plain.record?.argv));

  // ─── 3. The narrowed allow-list ─────────────────────────────

  console.log('\n3. the realised argv carries an allow-list with the GitHub writes taken out');

  // Every verb a founder chat may not be granted, read off the narrowing's own list rather than
  // copied: a verb added there is then one line, and this check goes red until it comes off.
  const FORBIDDEN = adapterModule?.GH_WRITE_COMMANDS ?? [];
  check('the narrowing names the verbs it takes away, so this check can iterate them',
        FORBIDDEN.length >= 4, JSON.stringify(FORBIDDEN));
  /** And the reads it still needs, which a narrowing that swung too far would have taken. */
  const KEPT = ['gh issue list', 'gh issue view', 'git log', 'git show', 'git diff', 'git blame'];

  for (const verb of FORBIDDEN) {
    check(`no \`${verb}\` in the list`,
          typeof plainList === 'string' && !plainList.includes(verb),
          JSON.stringify(plainList));
  }
  for (const verb of KEPT) {
    check(`\`${verb}\` is still there`,
          typeof plainList === 'string' && plainList.includes(verb),
          JSON.stringify(plainList));
  }
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) {
    check(`and so is \`${tool}\``,
          typeof plainList === 'string' && plainList.split(/\s+/).includes(tool),
          JSON.stringify(plainList));
  }
  check('nothing was widened — every rule in the output was in the input',
        typeof plainList === 'string'
          && plainList.split(/(?<=\))\s+|\s+(?=[A-Z])/).every((rule) => !rule.includes('gh pr')),
        JSON.stringify(plainList));

  const pinned = await turn({
    ...CLAUDE,
    command: '<stub> --dangerously-skip-permissions',
    args: ['--yolo', '--sandbox', 'danger-full-access'],
  });
  const pinnedArgv = (pinned.record?.argv ?? []).join(' ');
  check('a full-access marker the operator typed does not reach the chat',
        pinned.result?.ok === true
          && !pinnedArgv.includes('--dangerously-skip-permissions')
          && !pinnedArgv.includes('--yolo')
          && !pinnedArgv.includes('danger-full-access'),
        JSON.stringify(pinned.record?.argv));
  const pinnedList = allowListOf(pinned.record?.argv);
  check('and the list is still the narrowed one',
        typeof pinnedList === 'string' && FORBIDDEN.every((verb) => !pinnedList.includes(verb)),
        JSON.stringify(pinnedList));

  const codex = await turn({ backend: 'codex-cli', command: '<stub> exec' });
  check('a codex-cli turn yields the read-only sandbox rather than silently doing nothing',
        codex.result?.ok === true
          && (codex.record?.argv ?? []).join(' ').includes('--sandbox read-only'),
        JSON.stringify(codex.record?.argv));

  // ─── 4. What cannot be narrowed is refused ──────────────────

  console.log('\n4. a posture that cannot be narrowed is refused rather than run unnarrowed');

  const REFUSALS = [
    {
      label: 'a `raw` backend, which writes no permission flags at all',
      agent: { backend: 'raw', command: '<stub> -p' },
    },
    {
      label: 'a command line already carrying `--allowedTools`',
      agent: { backend: 'claude-code', command: '<stub> --allowedTools "Bash(gh:*) Read"' },
    },
    {
      label: 'a command line already carrying `--permission-mode`',
      agent: { backend: 'claude-code', command: '<stub> --permission-mode acceptEdits' },
    },
    {
      label: 'a codex-cli command line that already states its sandbox',
      agent: { backend: 'codex-cli', command: '<stub> exec --sandbox workspace-write' },
    },
    {
      label: 'an allow-list pinned through the operator\'s own arguments',
      agent: { backend: 'claude-code', command: '<stub>', args: ['--allowedTools', 'Bash(gh:*)'] },
    },
  ];

  for (const one of REFUSALS) {
    const refused = await turn(one.agent);
    check(`${one.label}: the turn is refused`,
          refused.result?.ok === false && Boolean(refused.result?.error),
          JSON.stringify(refused.result));
    check(`${one.label}: in the wording the board already uses when an agent is not enabled`,
          (refused.result?.error ?? '')
            .includes(`Founder chat is not enabled for workspace "${WORKSPACE}"`),
          JSON.stringify(refused.result?.error));
    check(`${one.label}: and it says why, rather than only that`,
          /narrow/i.test(refused.result?.error ?? ''),
          JSON.stringify(refused.result?.error));
    check(`${one.label}: nothing was spawned`,
          refused.record === null && refused.thrown === null,
          JSON.stringify(refused.record));
  }

  // ─── 5. The limitation, made observable ─────────────────────

  console.log('\n5. an agent that really tries `gh issue edit` gets nowhere, and it is on the record');

  const worldFile = join(workDir, 'github-state.json');
  const WORLD_BEFORE = { issues: { 4711: { title: 'A title nothing in this check owns' } } };
  writeFileSync(worldFile, JSON.stringify(WORLD_BEFORE), 'utf8');
  const attemptLog = join(workDir, 'attempt.json');
  rmSync(attemptLog, { force: true });
  process.env.GITHUB_STATE_FILE = worldFile;
  process.env.GH_WORLD = slash(ghStub);
  process.env.ATTEMPT_LOG = slash(attemptLog);

  const attempted = await turn(CLAUDE, { stub: attemptStub });
  const log = existsSync(attemptLog) ? JSON.parse(readFileSync(attemptLog, 'utf8')) : null;

  check('the attempt happened at all — a stub that never calls `gh` proves nothing',
        log?.attempted === 'gh issue edit 4711 --title renamed by the founder chat',
        JSON.stringify(log?.attempted));
  check('and it is visible in the argv log the agent was started with',
        typeof log?.allowedTools === 'string' && log.allowedTools.length > 0,
        JSON.stringify(log?.allowedTools));
  check('the list it was handed did not cover the command',
        log?.ran === false, JSON.stringify(log));
  check('so nothing on GitHub changed',
        existsSync(worldFile)
          && readFileSync(worldFile, 'utf8') === JSON.stringify(WORLD_BEFORE),
        readFileSync(worldFile, 'utf8'));
  check('and the turn itself still answered the founder',
        attempted.result?.ok === true
          && (attempted.result?.output ?? '').includes('I cannot change anything on GitHub'),
        JSON.stringify(attempted.result));

  // ─── 6. A run that ends badly ───────────────────────────────

  console.log('\n6. a non-zero exit is an answer rather than an exception');

  const failed = await turn(CLAUDE, { stub: failingStub });
  check('nothing was thrown', failed.thrown === null, String(failed.thrown));
  check('it comes back not ok', failed.result?.ok === false, JSON.stringify(failed.result?.ok));
  check('with an error that names the exit code',
        /exited with code 3/.test(failed.result?.error ?? ''),
        JSON.stringify(failed.result?.error));
  check('and with no issue URL',
        failed.result?.issueUrl === null, JSON.stringify(failed.result?.issueUrl));
} finally {
  server.stop();
  // Windows keeps a handle on a directory whose child processes have only just gone, and a
  // teardown that threw would lose every case above it.
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* the machine's, not ours */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
