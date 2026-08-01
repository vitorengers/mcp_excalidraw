#!/usr/bin/env node
/**
 * Checks that the prompt goes down the channel the backend reads, not always down stdin.
 *
 * The private-child path wrote the whole prompt to stdin and closed it, unconditionally —
 * `child.stdin?.end(prompt)` — which is `claude -p`'s contract and nothing else's. That was not
 * a corner case: `runIssueAgent` and `runReviseAgent` pass no `host`, so every research run in
 * the product takes that path whatever backend it was configured with. The other half of the
 * mechanism already existed — `buildAgentCommand` appends the prompt to argv when one is passed,
 * and `AgentInvocation.prompt.via` says which it should be — and nothing between the two ever
 * asked.
 *
 * So the cases here are about one seam, from both ends:
 *
 *  1. **Each backend and mode declares the channel its CLI actually reads.** Not a preference:
 *     `claude -p` reads stdin and needs the end of file that closes it; `codex exec` takes the
 *     prompt as a positional argument, and piped stdin beside one is read as *context* rather
 *     than as the instruction, so a prompt sent there is an agent with no orders. `-` is what
 *     asks Codex for the other reading, and it is honoured where an operator pinned it.
 *  2. **The prompt arrives there and nowhere else.** A stub per backend reads back its own argv
 *     and its own stdin, so "delivered on argv" is asserted as *argv carries it and stdin is
 *     empty* rather than as an intention in a type.
 *  3. **stdin is closed either way.** A stdin-delivering backend has always needed the end of
 *     file; an argv-delivering one must not be handed an open pipe it will sit on. That is
 *     openai/codex#20919 — *"In a non-TTY child shell with inherited but unwritten stdio,
 *     read() on stdin blocks indefinitely because the writer side is open but no bytes ever
 *     arrive and no EOF is delivered"* — whose own workaround is `< /dev/null`, which is what
 *     closing an empty pipe is. So every stub here asserts it saw an end of file.
 *  4. **Claude Code's headless run is byte for byte what it was.** The whole point of moving the
 *     choice into the backend is that the backend that was right all along does not move.
 *
 * The facts about `codex exec` were confirmed against the CLI's own non-interactive
 * documentation rather than remembered: *"Pass a task prompt as a single argument"*, `codex
 * exec -` reads the whole prompt from stdin, and *"If stdin is piped and you also provide a
 * prompt argument, Codex treats the prompt as the instruction and the piped content as
 * additional context."*
 *
 * Self-contained and offline: one stub agent in a throwaway directory, `runAgent` in this
 * process, no canvas server, no browser, no GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-prompt-delivery.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const { runAgent, agentRunFor } = await importDist(join('core', 'issue-agent.js'), 'the agent runtime');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `agent-prompt-delivery-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const stub = join(workDir, 'agent-stub.mjs');
const slash = (value) => value.replace(/\\/g, '/');

const PULL_URL = 'https://github.com/vitorengers/vibemaxxing/pull/329';

/**
 * Stands in for every one of the three binaries, and reports how it was started.
 *
 * It takes no view about which channel is right — it writes down both, plus whether it ever
 * saw an end of file, because a prompt that arrived on stdin and a prompt that arrived as an
 * argument look identical once an agent has read either.
 *
 * The fallback timer is the third case's whole mechanism. Handed an open pipe nobody will ever
 * write to, a real CLI blocks in `read()` for ever; this one gives up after two seconds and
 * reports `ended: false`, which turns that hang into a case with a name on it rather than a
 * check that times out with nothing to say.
 */
writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

let stdin = '';
let ended = false;
let reported = false;

const fallback = setTimeout(report, 2000);

function report() {
  if (reported) return;
  reported = true;
  clearTimeout(fallback);
  writeFileSync(process.env.CAPTURE_TO, JSON.stringify({
    argv: process.argv.slice(2),
    stdin,
    ended,
  }), 'utf8');
  process.stdout.write(${JSON.stringify(PULL_URL)} + '\\n');
  // Rather than process.exit, which would race the write above on a pipe. With stdin let go
  // there is nothing left holding the loop open, so the process ends once stdout has drained.
  process.stdin.pause();
  process.stdin.destroy();
}

process.stdin.on('data', (chunk) => { stdin += chunk.toString(); });
process.stdin.on('end', () => { ended = true; report(); });
`, 'utf8');

const workspace = {
  id: 'prompt-delivery-check',
  name: 'Prompt Delivery Check',
  path: workDir,
  innerPath: slash(workDir),
  environment: { kind: 'native' },
  error: null,
};

/**
 * A prompt with everything in it that makes a prompt awkward to carry.
 *
 * Quotes, backticks, a dollar sign and newlines, because argv delivery on this board goes
 * through a shell on the far side of the WSL boundary and through none at all on the near
 * side, and a check whose prompt was one word would prove neither.
 */
const PROMPT = [
  'Research this observation and open one issue for it.',
  "It has a 'single quote', a \"double quote\", a `backtick` and a $variable in it.",
  'And it runs to several lines, the way the real one runs to several hundred words.',
].join('\n');

// ─── The contract, one row per backend and mode ───────────────

/**
 * What each backend and mode has to say about its prompt, and why.
 *
 * The expectations are written here rather than read back off the adapter, which is the
 * difference between a check and a mirror: an adapter that changed its mind about `codex exec`
 * would agree with itself and fail this.
 */
const CASES = [
  {
    label: 'claude-code, headless',
    backend: 'claude-code',
    // The stub stands in for the binary, so the operator's command line is the one that reaches
    // it. `codex` gets its `exec` written here for the same reason: node needs its script as
    // argv[1], and a subcommand the adapter unshifted would land in front of it.
    command: `node "${slash(stub)}"`,
    mode: 'headless',
    via: 'stdin',
    stdin: 'prompt',
    marker: null,
    why: 'a run that prints and exits reads its prompt from stdin and needs the end of file',
  },
  {
    label: 'claude-code, interactive',
    backend: 'claude-code',
    command: `node "${slash(stub)}"`,
    mode: 'interactive',
    via: 'argv',
    stdin: 'reader',
    marker: null,
    why: '`claude [options] [prompt]` takes one as its last argument and keeps stdin for the reader',
  },
  {
    label: 'codex-cli, headless',
    backend: 'codex-cli',
    command: `node "${slash(stub)}" exec`,
    mode: 'headless',
    via: 'argv',
    stdin: 'closed',
    marker: null,
    why: '`codex exec <prompt>` is the documented form, and piped stdin beside it is context',
  },
  {
    label: 'codex-cli, headless, with the dash form pinned',
    backend: 'codex-cli',
    command: `node "${slash(stub)}" exec -`,
    mode: 'headless',
    via: 'stdin',
    stdin: 'prompt',
    marker: '-',
    why: 'an operator who wrote `-` asked for the prompt to be read from stdin',
  },
  {
    label: 'codex-cli, interactive',
    backend: 'codex-cli',
    command: `node "${slash(stub)}" exec`,
    mode: 'interactive',
    via: 'argv',
    stdin: 'reader',
    marker: null,
    why: 'bare `codex` is the interface, and an interface needs stdin left alone',
  },
  {
    label: 'raw, with the print flag',
    backend: 'raw',
    command: `node "${slash(stub)}" -p`,
    mode: 'headless',
    via: 'stdin',
    stdin: 'prompt',
    marker: null,
    why: 'this is what every board configured today spawns, and it must not move',
  },
  {
    label: 'raw, without the print flag',
    backend: 'raw',
    command: `node "${slash(stub)}"`,
    mode: 'headless',
    via: 'argv',
    stdin: 'reader',
    marker: null,
    why: 'a command with no `-p` in it would draw an interface, so the prompt goes beside it',
  },
];

/** One case, run through the real `runAgent` and read back off the stub's own record. */
async function deliver(one, index) {
  const capture = join(workDir, `run-${index}.json`);
  rmSync(capture, { force: true });
  process.env.CAPTURE_TO = capture;

  const { adapter, invocation } = agentRunFor(
    { backend: one.backend, command: one.command }, 'issue', null, one.mode
  );
  const run = await runAgent(workspace, PROMPT, {
    adapter,
    invocation,
    expects: 'pull',
    what: `the ${one.label} stub`,
    timeoutMs: 30000,
  });
  const record = existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null;
  return { invocation, run, record };
}

const results = [];
for (const [index, one] of CASES.entries()) results.push([one, await deliver(one, index)]);

// ─── 1. What each backend says about its own prompt ───────────

console.log('\n1. every backend and mode declares the channel its CLI reads');

for (const [one, { invocation }] of results) {
  check(`${one.label}: ${one.via} — ${one.why}`,
        invocation.prompt.via === one.via, JSON.stringify(invocation.prompt));
  check(`${one.label}: and it says what becomes of stdin (${one.stdin})`,
        invocation.prompt.stdin === one.stdin, JSON.stringify(invocation.prompt));
  check(`${one.label}: with ${one.marker ? `\`${one.marker}\` in its argv` : 'no stdin marker'}`,
        (invocation.prompt.marker ?? null) === one.marker
        && (!one.marker || invocation.args.includes(one.marker)),
        JSON.stringify(invocation));
}

// ─── 2. Where the prompt actually went ────────────────────────

console.log('\n2. the prompt reaches the process on the channel that was declared, and on no other');

for (const [one, { run, record }] of results) {
  if (!record) {
    check(`${one.label}: the stub was reached at all`, false, JSON.stringify(run?.error));
    continue;
  }
  check(`${one.label}: the run settles with the URL the stub printed`,
        run.ok === true && run.url === PULL_URL,
        `${JSON.stringify(run.url)} ${JSON.stringify(run.error)}`);

  if (one.via === 'argv') {
    check(`${one.label}: the prompt is the last argument`,
          record.argv[record.argv.length - 1] === PROMPT,
          JSON.stringify(record.argv));
    check(`${one.label}: and nothing at all arrived on stdin`,
          record.stdin === '', JSON.stringify(record.stdin.slice(0, 60)));
  } else {
    check(`${one.label}: the prompt arrives on stdin, byte for byte`,
          record.stdin === PROMPT,
          `${JSON.stringify(record.stdin.slice(0, 60))} vs ${JSON.stringify(PROMPT.slice(0, 60))}`);
    check(`${one.label}: and no argument carries it`,
          !record.argv.includes(PROMPT), JSON.stringify(record.argv));
  }
}

// ─── 3. What becomes of stdin ─────────────────────────────────

console.log('\n3. stdin is closed either way, so nothing is left reading a pipe with no writer');

for (const [one, { record }] of results) {
  check(`${one.label}: the process saw an end of file`,
        record?.ended === true,
        record ? 'it gave up waiting after two seconds' : 'no record');
}

// ─── 4. The backend that was right all along ──────────────────

console.log('\n4. the claude-code headless path is what it was, byte for byte');

const [, claudeHeadless] = results[0];
// A run inside the argv rather than the whole of it: a named backend also writes a permission
// posture, after these — `check-agent-permissions.mjs` is where that is held. What this case is
// about is the four print flags still being there and the prompt still not being.
check('its argv carries the four flags this backend spells, and no prompt among them',
      (claudeHeadless.record?.argv ?? []).join(' ')
        .includes('--print --output-format stream-json --verbose')
      && !(claudeHeadless.record?.argv ?? []).includes(PROMPT),
      JSON.stringify(claudeHeadless.record?.argv));
check('and stdin carried the whole prompt and nothing else',
      claudeHeadless.record?.stdin === PROMPT,
      String(claudeHeadless.record?.stdin?.length));

rmSync(workDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
