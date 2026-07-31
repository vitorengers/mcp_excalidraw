#!/usr/bin/env node
/**
 * Checks what the implement agent is actually told about landing its change.
 *
 * Worktrees made parallel implementations routine, and parallel implementations made the
 * default branch move under a run: four agents cut from one base, three merge, and the
 * fourth opens a pull request that will not merge. The agent has the permissions and the
 * tools to fix that itself — the question this guards is whether it is told to, and
 * whether the instruction not to widen the scope reads as forbidding it.
 *
 * **This is a lint over instructions, not a test of behaviour.** It cannot show that an
 * agent obeys the prompt; no check here can. What it can do is fail when the guidance is
 * dropped or reworded into something that no longer says it, which is the regression worth
 * catching — the prompt is prose, and prose erodes silently.
 *
 * What makes it more than a string search on a constant: it captures the prompt as the
 * agent receives it, over stdin, through the real composition path — so a change that
 * builds the prompt differently is covered too.
 *
 * Usage: node scripts/check-implement-prompt.mjs
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

const { runImplementAgent, worktreeSection } =
  await importDist(join('core', 'implement-agent.js'), 'the implement agent');

const workDir = join(tmpdir(), 'implement-prompt-check');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const stub = join(workDir, 'agent-stub.mjs');
const captured = join(workDir, 'prompt.txt');

// Writes down the prompt it was handed, then ends the way a real run ends.
writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  writeFileSync(process.env.CAPTURE_TO, input, 'utf8');
  process.stdout.write('https://github.com/vitorengers/vibemaxxing/pull/1\\n');
});
`, 'utf8');

const workspace = {
  id: 'prompt-check',
  name: 'Prompt Check',
  path: workDir,
  innerPath: workDir.replace(/\\/g, '/'),
  environment: { kind: 'native' },
  error: null,
};

process.env.CAPTURE_TO = captured;

async function promptFor(worktree) {
  rmSync(captured, { force: true });
  await runImplementAgent(workspace, 'https://github.com/vitorengers/vibemaxxing/issues/54', {
    agentCommand: `node "${stub.replace(/\\/g, '/')}"`,
    timeoutMs: 60_000,
    worktree,
  });
  return readFileSync(captured, 'utf8');
}

try {
  console.log('1. the prompt reaches the agent at all');
  const plain = await promptFor(null);
  check('captured over stdin', plain.length > 0, 'the stub received nothing');
  check('it names the issue', plain.includes('/issues/54'));

  // Each of these is a distinct thing that has to survive a rewrite, so each fails on its
  // own rather than as one "mentions conflicts" assertion that a single word would satisfy.
  console.log('\n2. it says the base can move while the run is working');
  // Narrow on purpose. "default branch" and "while you work" both already appear in the
  // prompt for unrelated reasons — the first in "branch off the default branch", the second
  // in "nobody can answer a question while you work" — so either alone passes on a prompt
  // that says nothing about time. What has to be there is the branch *having moved*.
  check('the base changing during the run is named',
        /(default branch|base|main).{0,90}(may have moved|has moved|moved|advanced)/is.test(plain)
        || /(moved|merged|landed).{0,80}(while you were working|since you started)/is.test(plain),
        'nothing tells the agent its base is not frozen');

  console.log('\n3. it says to bring the branch up to date, and when');
  check('before opening the pull request',
        /(update|rebase|bring).{0,80}(before|prior to).{0,40}(open|pull request)/is.test(plain)
        || /(before|prior to).{0,40}(open|pull request).{0,80}(update|rebase|bring)/is.test(plain),
        'no instruction to update before opening');
  check('and again before merging',
        /(again )?before you merge|before merging/i.test(plain),
        'a branch updated only at open time conflicts by merge time');

  console.log('\n4. it says to find out why the other change landed');
  check('reading the other change is asked for',
        /why .{0,60}(landed|changed|merged)|gh pr view|git log/i.test(plain),
        'resolving without reading the other side is guessing');

  console.log('\n5. resolution is reconciliation, not picking a winner');
  // Order-independent on purpose: the concept has to be there, the sentence shape does not.
  check('discarding one side is refused',
        /(one side|wholesale|either direction).{0,90}(is not|never|not resolution)/is.test(plain)
        || /(is not|never).{0,90}(one side|wholesale|picking a side)/is.test(plain),
        'the cheapest wrong resolution is taking one side whole');

  console.log('\n6. it may stop rather than force a wrong merge');
  check('there is a way to stop and say so',
        /cannot reconcile|genuinely cannot|leave the pull request open/i.test(plain),
        'without this the only options are a wrong merge or a silent one');

  console.log('\n7. the scope rule cannot be read as forbidding this');
  // The two sentences that an agent following orders literally would obey instead.
  const scopeLine = /Do not touch anything the issue does not cover[^.]*\./i.exec(plain)?.[0] ?? '';
  check('the scope sentence is qualified', /except|unless|other than/i.test(scopeLine),
        `unqualified: ${scopeLine || '(sentence not found)'}`);

  console.log('\n8. the worktree case says it too, and the no-worktree case is untouched');
  check('no worktree adds nothing', worktreeSection(null) === '' && worktreeSection(undefined) === '',
        'a workspace that is not a git repository must get the prompt it always got');
  // A real directory: the agent is started with this as its working directory, so a path
  // that does not exist fails the spawn rather than the assertion.
  const treeDir = join(workDir, 'wt');
  mkdirSync(treeDir, { recursive: true });
  const withTree = await promptFor({
    path: treeDir,
    innerPath: treeDir.replace(/\\/g, '/'),
    branch: 'issue-54',
  });
  check('the worktree section is there', /issue-54/.test(withTree));
  check('and the landing guidance survives beside it',
        /before you merge|before merging/i.test(withTree),
        'the two sections must not replace one another');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
