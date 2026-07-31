#!/usr/bin/env node
/**
 * Checks that both agents are told to settle off-repository facts by reading the source.
 *
 * The two halves of this failed in opposite ways. The issue agent's prompt has ordered
 * research since it was written — "if the answer depends on something the repository does
 * not settle, research it" — while its configured `--allowedTools` list omitted the web
 * tools, so `-p` refused them silently and the run still exited 0. The implement agent has
 * the opposite shape: nothing denies it anything, and nothing asked it to research either,
 * so an assumption about a library's API or a tool's flag went in unchecked and compiled.
 *
 * Only one of those two halves is in this repository. The allowlist lives in whatever
 * starts the board, outside the tree, and a check here cannot reach it — the string in
 * `docs/issue-block.md` is documentation of a value set elsewhere. What is in the tree is
 * the prompts, so that is what this guards.
 *
 * **A lint over instructions, not a test of behaviour** — it cannot show that an agent
 * looks anything up. What it catches is the guidance being dropped or reworded into
 * something that no longer asks for it, which for prose is the regression that happens.
 * It captures each prompt as the agent receives it, over stdin, through the real
 * composition path, so a change that builds the prompt differently is covered too.
 *
 * Usage: node scripts/check-agent-research.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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

const { runIssueAgent } = await importDist(join('core', 'issue-agent.js'), 'the issue agent');
const { runImplementAgent } = await importDist(join('core', 'implement-agent.js'), 'the implement agent');

const workDir = join(tmpdir(), 'agent-research-check');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const stub = join(workDir, 'agent-stub.mjs');
const captured = join(workDir, 'prompt.txt');

writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  writeFileSync(process.env.CAPTURE_TO, input, 'utf8');
  process.stdout.write('https://github.com/vitorengers/vibemaxxing/issues/1\\n');
});
`, 'utf8');

const workspace = {
  id: 'research-check',
  name: 'Research Check',
  path: workDir,
  innerPath: workDir.replace(/\\/g, '/'),
  environment: { kind: 'native' },
  error: null,
};

process.env.CAPTURE_TO = captured;
const agentCommand = `node "${stub.replace(/\\/g, '/')}"`;

async function capture(run) {
  rmSync(captured, { force: true });
  await run();
  return readFileSync(captured, 'utf8');
}

/**
 * The same three things asked of both prompts, each failing on its own.
 *
 * They are separate because one of them alone is not the instruction. "Research it" with
 * no notion of which facts need it is advice; naming the facts without saying to go and
 * read their source is a warning; and both of those without refusing the guess leave an
 * agent free to decide it already knows. Each pattern is narrow on purpose — the words
 * both prompts already used for unrelated reasons ("verify", "check ... against the
 * code", "read the output", "rather than") must not satisfy any of them.
 */
function assertResearchRules(label, prompt) {
  console.log(`\n${label}`);

  check('a fact the repository does not settle is named',
        /(outside|beyond)[^.]{0,40}repositor/i.test(prompt)
        || /off-?repositor/i.test(prompt)
        || /repositor\w*[^.]{0,40}(does not|cannot|will not) settle/i.test(prompt)
        // Both orders of the same sentence, and `[^.]` keeps each within one sentence so
        // an unrelated "not" earlier in the prompt cannot reach a later "repository".
        || /(not|isn't|is not)[^.]{0,60}(in|settled by)[^.]{0,20}(this |the )?repositor/i.test(prompt),
        'without naming the kind of fact, "research it" applies to nothing in particular');

  check('reading its source is what settles it',
        /(read|check|verify|confirm|consult|look)[^.]{0,90}(documentation|the docs|its source|their source|the source|the page)/is.test(prompt)
        || /research it/i.test(prompt),
        'an agent told a fact is external, and not told to go and read it, still guesses');

  check('inventing the answer is refused',
        /(do not|don't|never)[^.]{0,40}(invent|guess|assum)/i.test(prompt)
        || /(rather than|instead of)[^.]{0,30}(invent|guess|assum|remember)/i.test(prompt),
        'a remembered API and an invented flag both compile');
}

try {
  const issuePrompt = await capture(() =>
    runIssueAgent(workspace, 'An observation.', { agentCommand, timeoutMs: 60_000 }));
  const implementPrompt = await capture(() =>
    runImplementAgent(workspace, 'https://github.com/vitorengers/vibemaxxing/issues/77',
                      { agentCommand, timeoutMs: 60_000 }));

  console.log('1. both prompts reached their agent');
  check('the issue prompt was captured', issuePrompt.includes('Observation'));
  check('the implement prompt was captured', implementPrompt.includes('/issues/77'));

  assertResearchRules('2. the issue agent', issuePrompt);
  assertResearchRules('3. the implement agent', implementPrompt);

  // The implement half is the one that was missing, and the reason it was missing is that
  // the rationale for it had only ever been written down for the issue agent. A prompt
  // that mentions research once, in passing, is not the same as one an agent reads as
  // permission to spend a tool call on it.
  console.log('\n4. the implement agent knows the source is reachable');
  check('looking it up is offered, not merely wished for',
        /web|online|documentation|--help/i.test(implementPrompt),
        'nothing tells the agent there is anywhere to go');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
