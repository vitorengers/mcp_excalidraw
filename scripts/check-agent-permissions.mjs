#!/usr/bin/env node
/**
 * Checks that the permission posture belongs to the adapter rather than to a paragraph.
 *
 * The security boundary this board rests on is that the issue agent reads and the implement
 * agent writes — `src/core/implement-agent.ts` says so in its first lines, and nothing enforced
 * it. It was a sentence telling an operator to type `--allowedTools "…"` into one variable and
 * `--dangerously-skip-permissions` into the other, and a grep of `src/` found those flag names
 * only inside comments. A board whose operator forgot the first one had an issue agent that
 * could push; a board whose operator forgot the second had an implementation that could not
 * commit. Neither is a state any code could report, because no code had an opinion.
 *
 * Both spellings are also Claude Code's, and Codex CLI has no textual equivalent of either: its
 * controls are `--sandbox read-only|workspace-write|danger-full-access`. So the posture is a
 * *per backend* fact, which is precisely what an adapter is for.
 *
 * The cases below are that claim, in the order the argument runs:
 *
 *  1. **an issue-role invocation carries its backend's read-only marker** and none of that
 *     backend's full-access markers — including when the operator wrote one themselves, which
 *     is the case that matters: `--yolo` typed to make a refused run work hands the *issue*
 *     agent the machine, from an API with no authentication in front of it;
 *  2. **an implement-role invocation carries the write marker**, and full access is reachable
 *     only through an explicit opt-in, never as a default;
 *  3. **the `raw` backend emits nothing at all**, which is what preserves every board that
 *     exists — all of them name their agent as a command line and expect it spawned byte for
 *     byte;
 *  4. **the documented defaults are the postures the adapter writes**, so the two cannot drift:
 *     `raw` is still the default backend, so for every board today the documented command line
 *     *is* the posture;
 *  5. **the composed implement prompt says issue and comment text is untrusted input**, because
 *     that prompt orders the agent to treat a comment as the later word and anybody can write a
 *     comment on a public repository;
 *  6. **a board configured with the flag says so at startup**, in a warning naming it.
 *
 * The markers are spelled out here rather than imported, deliberately: a check that took its
 * expectations from the module it is checking would pass whatever that module happened to
 * decide. What *is* imported is the pair of allowlists, and only to hold the documents to them.
 *
 * The Codex facts were read out of that CLI's own documentation rather than remembered, and one
 * of them is why this check asserts a *fail-closed* default rather than a working one:
 * `codex exec` is read-only by default and *"cannot edit files or run commands that require
 * network access"*, and network access exists only under `workspace-write`, as
 * `sandbox_workspace_write.network_access`. So `--sandbox read-only` is a posture in which the
 * issue agent cannot reach github.com — which is the Codex half of the trap
 * `docs/trap-allowed-tools.md` is about, and the document has to say so.
 *
 * Self-contained: a stub agent in a throwaway directory, the adapters in this process, and one
 * canvas server for the startup line. No browser, no GitHub. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-agent-permissions.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { repoRoot, startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A compiled module, or null when this build has not got it. */
async function loadDist(relative) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) return null;
  try {
    return await import(pathToFileURL(modulePath).href);
  } catch (error) {
    console.error(`  note  dist/${relative.replace(/\\/g, '/')} would not load: ${error.message}`);
    return null;
  }
}

const adapterModule = await loadDist(join('core', 'agent-adapter.js'));
const registry = await loadDist(join('core', 'agents', 'index.js'));
const implementModule = await loadDist(join('core', 'implement-agent.js'));

const workDir = join(tmpdir(), `agent-permissions-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const started = [];
const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');
const slash = (value) => value.replace(/\\/g, '/');

// ─── 0. is there anything to ask ──────────────────────────────

console.log('0. the board has a backend to ask about permissions');
check('there is an adapter registry', typeof registry?.adapterFor === 'function',
      'dist/core/agents/index.js does not export adapterFor');

if (typeof registry?.adapterFor !== 'function') {
  console.error('\n1 case(s) failed');
  process.exit(1);
}

const { adapterFor } = registry;

/** One invocation, as a line, for reading a flag out of. */
const spelled = (backend, role, command, extra = {}) => {
  const invocation = adapterFor(backend).invoke({ mode: 'headless', role, command, ...extra });
  return { invocation, argv: invocation.args, line: invocation.args.join(' ') };
};

/** The value of a flag in an argv, in either spelling. */
function valueOf(argv, name) {
  const at = argv.indexOf(name);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  const joined = argv.find((argument) => argument.startsWith(`${name}=`));
  return joined ? joined.slice(name.length + 1) : null;
}

/**
 * What each backend spells the three postures with.
 *
 * The read-only marker is a claim about a *list* for Claude Code and about a *mode* for Codex,
 * which is the whole reason this is a table rather than one regular expression: `--allowedTools`
 * carrying `Write` is not a read-only posture, and `--sandbox workspace-write` is not one
 * whatever else is on the line.
 */
const BACKENDS = {
  'claude-code': {
    bare: 'claude',
    /** A posture is read-only when a list is present and nothing in it writes. */
    readOnly: ({ argv }) => {
      const list = valueOf(argv, '--allowedTools') ?? valueOf(argv, '--allowed-tools');
      return Boolean(list) && !/(^|\s)(Write|Edit|NotebookEdit)(\s|$)/.test(list)
        && !/Bash\((?:git|gh)?:?\*?\)/.test(list);
    },
    /** And it writes when the list says the two tools that write, and names git and gh. */
    write: ({ argv }) => {
      const list = valueOf(argv, '--allowedTools') ?? valueOf(argv, '--allowed-tools');
      return Boolean(list) && /(^|\s)Write(\s|$)/.test(list) && /(^|\s)Edit(\s|$)/.test(list)
        && list.includes('Bash(git:*)') && list.includes('Bash(gh:*)');
    },
    fullAccess: ({ argv }) => argv.includes('--dangerously-skip-permissions'),
    /** What an operator might have written to make a refused run work. */
    operatorFullAccess: 'claude --dangerously-skip-permissions',
  },
  'codex-cli': {
    bare: 'codex',
    readOnly: ({ argv }) => valueOf(argv, '--sandbox') === 'read-only'
      || valueOf(argv, '-s') === 'read-only',
    write: ({ argv, line }) => (valueOf(argv, '--sandbox') === 'workspace-write'
      || valueOf(argv, '-s') === 'workspace-write')
      // Under that mode the network is off unless it is turned on, and an implement agent with
      // no network cannot reach github.com — the same silent failure one document along.
      && /sandbox_workspace_write\.network_access\s*=\s*true/.test(line),
    fullAccess: ({ argv }) => argv.includes('--yolo')
      || argv.includes('--dangerously-bypass-approvals-and-sandbox')
      || valueOf(argv, '--sandbox') === 'danger-full-access'
      || valueOf(argv, '-s') === 'danger-full-access',
    operatorFullAccess: 'codex exec --yolo',
  },
};

// ─── 1. the issue role cannot write, whatever was configured ──

console.log('\n1. an issue-role invocation is read-only, per backend');
for (const [backend, rules] of Object.entries(BACKENDS)) {
  const bare = spelled(backend, 'issue', rules.bare);
  check(`${backend}: an issue run carries its read-only marker`, rules.readOnly(bare),
        JSON.stringify(bare.argv));
  check(`${backend}: and none of its full-access markers`, !rules.fullAccess(bare),
        JSON.stringify(bare.argv));

  // The case the whole thing is for: the operator reached for the flag that makes a refused run
  // work, and reached for it on the *issue* variable.
  const granted = spelled(backend, 'issue', rules.operatorFullAccess);
  check(`${backend}: an operator's own full-access flag does not survive into an issue run`,
        !rules.fullAccess(granted), JSON.stringify(granted.argv));
  check(`${backend}: and the read-only posture is written in its place`,
        rules.readOnly(granted), JSON.stringify(granted.argv));

  // An operator who narrowed it themselves keeps their own narrowing: a board that pins its own
  // list by hand — this repository's own does — must not have it replaced.
  const own = backend === 'claude-code'
    ? spelled(backend, 'issue', 'claude --allowedTools "Read Grep"')
    : spelled(backend, 'issue', 'codex exec --sandbox read-only');
  check(`${backend}: an operator's own posture is not overwritten`,
        backend === 'claude-code'
          ? own.argv.filter((argument) => argument === '--allowedTools').length === 1
            && valueOf(own.argv, '--allowedTools') === 'Read Grep'
          : own.argv.filter((argument) => argument === '--sandbox').length === 1,
        JSON.stringify(own.argv));
}

// ─── 2. the implement role writes, and full access is opt-in ──

console.log('\n2. an implement-role invocation writes, and nothing more unless it is asked');
for (const [backend, rules] of Object.entries(BACKENDS)) {
  const bare = spelled(backend, 'implement', rules.bare);
  check(`${backend}: an implement run carries the write marker`, rules.write(bare),
        JSON.stringify(bare.argv));
  check(`${backend}: and full access is not the default`, !rules.fullAccess(bare),
        JSON.stringify(bare.argv));

  const opted = spelled(backend, 'implement', rules.bare, { fullAccess: true });
  check(`${backend}: the explicit opt-in reaches full access`, rules.fullAccess(opted),
        JSON.stringify(opted.argv));

  // And it is the *implement* opt-in: nothing an operator can say makes the issue agent one.
  const optedIssue = spelled(backend, 'issue', rules.bare, { fullAccess: true });
  check(`${backend}: the same opt-in does nothing for the issue role`,
        !rules.fullAccess(optedIssue), JSON.stringify(optedIssue.argv));
}

console.log('\n   and what the operator pinned is still on the end');
{
  const pinned = spelled('claude-code', 'implement', 'claude', { extraArgs: ['--add-dir', '/tmp/x'] });
  check('extraArgs are appended after the posture, so pinning something extra still works',
        pinned.argv.slice(-2).join(' ') === '--add-dir /tmp/x', JSON.stringify(pinned.argv));
}

// ─── 3. the raw backend emits nothing ─────────────────────────

console.log('\n3. the raw backend spawns the operator\'s own permission flags, unchanged');
{
  const OPERATOR = 'claude -p --output-format stream-json --verbose '
    + '--allowedTools "Bash(gh issue create:*) Read" --dangerously-skip-permissions';
  for (const role of ['issue', 'implement']) {
    const raw = adapterFor('raw').invoke({ mode: 'headless', role, command: OPERATOR });
    check(`a ${role} run through raw is the operator's line, character for character`,
          raw.line === OPERATOR, JSON.stringify(raw.line));
  }
  const plain = adapterFor('raw').invoke({ mode: 'headless', role: 'implement', command: 'claude -p' });
  check('and raw writes no posture of its own onto a line that has none',
        plain.line === 'claude -p', JSON.stringify(plain.line));
}

// ─── 4. the documented defaults are those postures ────────────

console.log('\n4. the documented commands carry what the adapter would write');

/** The `--allowedTools` argument of a documented variable line, as the spawn would read it. */
function documentedList(source, variable) {
  const line = source.split(/\r?\n/).find((entry) => entry.includes(`${variable}=`)
                                                  && entry.includes('--allowedTools'));
  if (!line) return null;
  const command = line.slice(line.indexOf('=') + 1).trim().replace(/^'|'$/g, '');
  const argv = adapterModule?.tokenizeCommand?.(command) ?? [];
  const at = argv.indexOf('--allowedTools');
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
}

const block = read('docs/issue-block.md');
const trap = read('docs/trap-allowed-tools.md');
const agentsDoc = read('docs/agents.md');
const running = read('docs/running.md');

const implementLines = [...block.matchAll(/^EXCALIDRAW_IMPLEMENT_AGENT='([^']+)'$/gm)]
  .map(([, command]) => command);
check('docs/issue-block.md ships an implement command', implementLines.length > 0);
for (const command of implementLines) {
  check('the documented implement command does not skip permissions',
        !command.includes('--dangerously-skip-permissions'), command);
  check('and it enumerates what the implement agent may do',
        command.includes('--allowedTools'), command);
}

const documentedImplement = documentedList(block, 'EXCALIDRAW_IMPLEMENT_AGENT');
const documentedIssue = documentedList(trap, 'EXCALIDRAW_ISSUE_AGENT');
const codeIssue = adapterModule?.CLAUDE_ISSUE_ALLOWED_TOOLS ?? null;
const codeImplement = adapterModule?.CLAUDE_IMPLEMENT_ALLOWED_TOOLS ?? null;

check('the adapter publishes the two lists it writes',
      typeof codeIssue === 'string' && typeof codeImplement === 'string',
      'agent-adapter.js exports neither CLAUDE_ISSUE_ALLOWED_TOOLS nor CLAUDE_IMPLEMENT_ALLOWED_TOOLS');
check('the issue list an operator is shown is the one the adapter writes',
      Boolean(documentedIssue) && documentedIssue === codeIssue,
      `${JSON.stringify(documentedIssue)} vs ${JSON.stringify(codeIssue)}`);
check('and so is the implement list', Boolean(documentedImplement) && documentedImplement === codeImplement,
      `${JSON.stringify(documentedImplement)} vs ${JSON.stringify(codeImplement)}`);

console.log('\n   and the trap document names both backends\' spelling of it');
check('docs/trap-allowed-tools.md names Claude Code\'s spelling', trap.includes('--allowedTools'));
check('and Codex CLI\'s read-only sandbox', /--sandbox\s+read-only|`read-only`/.test(trap),
      'the Codex half of the same trap: codex exec is read-only, so gh cannot reach github.com');
check('and says that its network is off in that mode',
      /network/i.test(trap) && /sandbox_workspace_write\.network_access/.test(trap),
      'a reader who fixes the refusal by widening the sandbox has to be told what widens with it');
check('and names the full-access flag a reader would otherwise reach for',
      /--yolo|--dangerously-bypass-approvals-and-sandbox/.test(trap));

console.log('\n   and the variable table says what the shipped default grants');
const implementRow = running.split(/\r?\n/)
  .find((line) => line.startsWith('| `EXCALIDRAW_IMPLEMENT_AGENT`'));
check('docs/running.md has a row for the implement agent', Boolean(implementRow));
check('and it says what that command is allowed to do',
      Boolean(implementRow) && /allowedTools|write|grant/i.test(implementRow), implementRow ?? '');
check('and the opt-in that takes the guard off is a documented variable of its own',
      /IMPLEMENT_FULL_ACCESS/.test(running) && /IMPLEMENT_FULL_ACCESS/.test(agentsDoc),
      'a posture a user can forget to type is the one that got documented as a trap');

// ─── 5. the prompt says what the issue text is ────────────────

console.log('\n5. the implement prompt says issue and comment text is input, not orders');
{
  const UNTRUSTED = /not instructions to be obeyed|untrusted input/i;
  const prompt = implementModule?.IMPLEMENT_AGENT_PROMPT ?? '';
  check('IMPLEMENT_AGENT_PROMPT says so', UNTRUSTED.test(prompt),
        'the prompt orders the agent to treat a comment as the later word, and anybody can write one');
  check('and it says it about the issue and its comments',
        /issue (?:text )?and (?:its )?comment/i.test(prompt), 'the sentence names what it is about');

  // Composed through the real path rather than read off the constant alone: the sentence has to
  // survive into what the agent is actually handed.
  const stub = join(workDir, 'prompt-stub.mjs');
  const record = join(workDir, 'prompt.json');
  writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ prompt }), 'utf8');
  process.stdout.write('https://github.com/vitorengers/vibemaxxing/pull/327\\n');
  process.exit(0);
});
`, 'utf8');

  if (typeof implementModule?.runImplementAgent === 'function') {
    await implementModule.runImplementAgent(
      { id: 'permissions-check', environment: { kind: 'native' }, path: workDir, innerPath: slash(workDir) },
      'https://github.com/vitorengers/vibemaxxing/issues/327',
      {
        agent: { backend: 'raw', command: `node "${slash(stub)}" -p` },
        timeoutMs: 60_000,
      }
    );
    let composed = '';
    try { composed = JSON.parse(readFileSync(record, 'utf8')).prompt; } catch { /* never ran */ }
    check('and the composed prompt the agent receives carries it', UNTRUSTED.test(composed),
          `${composed.length} characters received`);
  } else {
    check('and the composed prompt the agent receives carries it', false,
          'runImplementAgent is not exported');
  }
}

// ─── 6. a board that skips permissions says so out loud ───────

console.log('\n6. a board configured with the flag warns at startup');
{
  const port = await freePort();
  const logFile = join(workDir, 'board.log');
  const server = startCanvas({
    port,
    env: {
      EXCALIDRAW_IMPLEMENT_AGENT: `"${process.execPath}" -p --dangerously-skip-permissions`,
      LOG_FILE_PATH: logFile,
    },
  });
  started.push(server.child);

  const said = () => {
    let file = '';
    try { file = readFileSync(logFile, 'utf8'); } catch { /* never written */ }
    return `${server.read()}\n${file}`;
  };

  let seen = false;
  for (let attempt = 0; attempt < 200 && !seen; attempt++) {
    seen = said().includes('--dangerously-skip-permissions');
    if (!seen) await sleep(100);
  }
  check('starting it wrote a line naming the flag', seen, said().slice(-800));
  if (seen) {
    const line = said().split(/\r?\n/).find((entry) => entry.includes('--dangerously-skip-permissions')) ?? '';
    check('the line names the role it was configured for', /implement/i.test(line), line);
    check('and it is a warning, so a console that only shows warnings shows it',
          /\[warn\]/i.test(line) || server.read().includes('--dangerously-skip-permissions'), line);
  }
}

for (const child of started) { try { child.kill(); } catch { /* already gone */ } }
await sleep(300);
rmSync(workDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
