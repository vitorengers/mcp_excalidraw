#!/usr/bin/env node
/**
 * Checks what both agents are told about doing the work through helpers.
 *
 * Both prompts end on the same contract: the last line you print is the URL. The server
 * reads exactly that — `extractGithubUrl` over the parent's stdout — so the contract holds
 * only while the parent is the one that finishes.
 *
 * A real run broke it. Asked for orchestration, the issue agent delegated to a background
 * sub-agent; the sub-agent created the issue, the parent sat waiting and printed no URL,
 * and the block stayed `running` forever beside a card for an issue that already existed.
 *
 * Two rules come out of that, and the second matters more than the first. Reporting cannot
 * be delegated, because only the parent's stdout is read. And **creating** cannot be
 * delegated either: the server's guard is one run per block, not one `gh issue create` per
 * run, so three helpers that each create leave three issues for one observation and nothing
 * anywhere notices.
 *
 * **A lint over instructions, not a test of behaviour** — it cannot show an agent obeys.
 * What it catches is the guidance being dropped or reworded away, which for prose is the
 * regression that actually happens. It captures each prompt as the agent receives it, over
 * stdin, through the real composition path.
 *
 * Usage: node scripts/check-agent-delegation.mjs
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

const workDir = join(tmpdir(), 'agent-delegation-check');
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
  id: 'delegation-check',
  name: 'Delegation Check',
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
 * The same three rules for both prompts. Written once because a rule that held for one
 * agent and not the other is exactly how this came back the second time.
 */
function assertDelegationRules(label, prompt, artifact) {
  console.log(`\n${label}`);

  check('helpers are acknowledged at all',
        /sub-?agent|helper|delegat/i.test(prompt),
        'a prompt silent on helpers is a prompt an orchestrating agent reads as permission');

  // Must be said *about delegation*. Both prompts already end on "return only the URL",
  // which matches any loose pattern here while saying nothing about a helper — so this
  // asks for either the non-transfer itself or the mechanism behind it, and neither phrase
  // appears in a prompt that has not been told about helpers.
  check('the obligation to report does not transfer',
        /(do|does) not transfer|cannot be delegated|stays? yours/i.test(prompt)
        || /only what [^.]{0,24}you[^.]{0,24} print is read/i.test(prompt),
        'the server reads the parent\'s stdout and nothing else');

  check(`${artifact} is created by the parent alone`,
        /(never|not|do not)[^.]{0,140}(helper|sub-?agent)[^.]{0,60}(create|open)/is.test(prompt)
        || /(helper|sub-?agent)s?[^.]{0,140}(do not|never|must not)[^.]{0,40}(create|open)/is.test(prompt),
        'one run must not become two artifacts because two helpers each made one');

  check('a helper reports back instead',
        /(report|hand|return)[^.]{0,80}back to you|bring[^.]{0,40}back/is.test(prompt),
        'saying what a helper may not do without saying what it may leaves the rule unusable');

  check('the URL is printed by the parent, last, whoever did the work',
        /(whoever|whatever|even if|no matter who)[^.]{0,160}(print|report|url)/is.test(prompt),
        'the contract has to be restated for the delegated case or it reads as the simple case only');
}

try {
  const issuePrompt = await capture(() =>
    runIssueAgent(workspace, 'An observation.', { agentCommand, timeoutMs: 60_000 }));
  const implementPrompt = await capture(() =>
    runImplementAgent(workspace, 'https://github.com/vitorengers/vibemaxxing/issues/54',
                      { agentCommand, timeoutMs: 60_000 }));

  console.log('1. both prompts reached their agent');
  check('the issue prompt was captured', issuePrompt.includes('observation') || issuePrompt.length > 0);
  check('the implement prompt was captured', implementPrompt.includes('/issues/54'));

  assertDelegationRules('2. the issue agent', issuePrompt, 'the issue');
  assertDelegationRules('3. the implement agent', implementPrompt, 'the pull request');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
