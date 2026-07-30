#!/usr/bin/env node
/**
 * Checks that a project can say **how** its agents work, and that saying it grants nothing.
 *
 * A project could already retune how *well* its agents run — `model`, `effort`,
 * `timeoutSeconds` — and nothing about how they work. The prompt withholds the workflow on
 * purpose, because writing one repository's conventions into it would make the feature wrong
 * for every other board; what it says instead is "read your own project memory", which is a
 * pointer a fresh worktree may find nothing behind. `agents.<kind>.workflow` names a slug, the
 * text at `agent-workflows/<slug>.md` is read out of the project, and it is injected into the
 * prompt as its last section.
 *
 * The cases are the feature and, in equal measure, the two boundaries around it:
 *
 *  - A project that selects **no** workflow sends the prompt it sent before this existed,
 *    byte for byte. That is the same rule `worktreeSection` and `imageReferenceSection`
 *    already keep, and it is asserted against the composed baseline rather than eyeballed.
 *  - A project that selects one changes **the prompt and only the prompt**: argv is identical
 *    to the argv of a project that selects nothing. That is the mechanical form of "a workflow
 *    is not a capability" — nothing from the file reaches a command line, so it cannot widen
 *    what the operator granted.
 *  - A name that does not resolve **refuses the run before the spawn**, naming the file it
 *    looked for. Deliberately unlike the rest of the config, where a field pointing outside
 *    its project is ignored and the workspace still loads: a workflow silently not applied is
 *    a run that looks normal and does the wrong thing.
 *  - A slug is a slug. `/`, `..`, a drive letter and anything else outside
 *    `[a-z0-9][a-z0-9-]*` are refused, on the way into the config and again on the way into a
 *    run — a null out of `resolveInWorkspace` counts as unresolved, not as unset.
 *
 * In process and self-contained: throwaway projects, a stub agent that writes down the prompt
 * and the argv it was handed, no server and nothing that talks to GitHub. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-workflow.mjs
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

const { runImplementAgent, IMPLEMENT_AGENT_PROMPT } =
  await importDist(join('core', 'implement-agent.js'), 'the implement agent');
const { runIssueAgent, ISSUE_AGENT_PROMPT, workflowSection } =
  await importDist(join('core', 'issue-agent.js'), 'the issue agent');
const { loadWorkspaces, loadAgentWorkflow, validateWorkspaceConfigPatch, AGENT_WORKFLOW_DIR } =
  await importDist(join('core', 'workspaces.js'), 'the workspace registry');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `agent-workflow-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const slash = (value) => String(value).replace(/\\/g, '/');

/**
 * What one project wrote down about how its agents work.
 *
 * Deliberately a pipeline the base prompt does not describe — the base prompt tells the agent
 * to decide for itself and to keep the pull request to itself — so a prompt carrying this text
 * cannot be mistaken for a prompt that merely happens to mention sub-agents.
 */
const WORKFLOW_TEXT = `# Plan, then build

1. Plan the change with a sub-agent on the planning model, and do not write code until it
   answers.
2. Have a second sub-agent review that plan adversarially before any of it is implemented.
3. Implement it, then have a third review the implementation against the plan.
`;

function makeProject(id, config, workflows = {}) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config, null, 2), 'utf8');
  for (const [slug, text] of Object.entries(workflows)) {
    mkdirSync(join(dir, 'agent-workflows'), { recursive: true });
    writeFileSync(join(dir, 'agent-workflows', `${slug}.md`), text, 'utf8');
  }
  return dir;
}

const repo = 'vitorengers/mcp_excalidraw';

/** Selects nothing at all — the byte-for-byte case. */
makeProject('plain', { name: 'Plain', repo });
/** Selects a workflow on both agents, and nothing else. */
makeProject('workflowed', {
  name: 'Workflowed',
  repo,
  agents: {
    issue: { workflow: 'plan-then-build' },
    implement: { workflow: 'plan-then-build' },
  },
}, { 'plan-then-build': WORKFLOW_TEXT });
/** Names a workflow the project never committed. */
makeProject('missing', {
  name: 'Missing',
  repo,
  agents: { implement: { workflow: 'not-here' } },
});
/** Hand-edited to reach outside its own project. */
makeProject('escaping', {
  name: 'Escaping',
  repo,
  agents: { implement: { workflow: '../evil' } },
});

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: ['plain', 'workflowed', 'missing', 'escaping'].map((id) => ({
    id, path: slash(join(workDir, id)),
  })),
}, null, 2), 'utf8');

/** Writes down the two things every case here turns on, then ends the way a real run ends. */
const stub = join(workDir, 'agent-stub.mjs');
writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  writeFileSync(process.env.CAPTURE_TO, input, 'utf8');
  writeFileSync(process.env.CAPTURE_TO + '.argv.json',
    JSON.stringify(process.argv.slice(2)), 'utf8');
  process.stdout.write(process.env.CAPTURE_URL + '\\n');
});
`, 'utf8');

const captured = join(workDir, 'prompt.txt');
process.env.CAPTURE_TO = captured;

const AGENT_COMMAND = `node "${slash(stub)}" --output-format stream-json`;
/** What the stub must see on its command line whatever a project selected. */
const BASE_ARGV = ['--output-format', 'stream-json'];

const ISSUE_URL = 'https://github.com/vitorengers/mcp_excalidraw/issues/193';
const PULL_URL = 'https://github.com/vitorengers/mcp_excalidraw/pull/194';
const OBSERVATION = 'the board cannot say how its agents work';

const workspaces = await loadWorkspaces(registryPath);
const workspaceOf = (id) => {
  const found = workspaces.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`"${id}" did not load out of the throwaway registry`);
  return found;
};

function clearCapture() {
  rmSync(captured, { force: true });
  rmSync(`${captured}.argv.json`, { force: true });
}

const promptSeen = () => readFileSync(captured, 'utf8');
const argvSeen = () => JSON.parse(readFileSync(`${captured}.argv.json`, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function implementRun(id) {
  clearCapture();
  process.env.CAPTURE_URL = PULL_URL;
  return runImplementAgent(workspaceOf(id), ISSUE_URL, {
    agentCommand: AGENT_COMMAND,
    timeoutMs: 60_000,
  });
}

async function issueRun(id) {
  clearCapture();
  process.env.CAPTURE_URL = ISSUE_URL;
  return runIssueAgent(workspaceOf(id), OBSERVATION, {
    agentCommand: AGENT_COMMAND,
    timeoutMs: 60_000,
  });
}

/** The prompt each agent sends when nothing at all has been selected. */
const IMPLEMENT_BASELINE =
  `${IMPLEMENT_AGENT_PROMPT}\n\n---\n\nThe issue to implement:\n\n${ISSUE_URL}`;
const ISSUE_BASELINE =
  `${ISSUE_AGENT_PROMPT}\n\n---\n\nObservation:\n\n${OBSERVATION}`;

/**
 * Where the missing project's file would have been, as the error has to name it.
 *
 * The whole path, not the tail: "there is no agent-workflows/not-here.md" is a sentence
 * somebody has to go and resolve for themselves against a board running several projects.
 */
const missingFile = `${slash(join(workDir, 'missing'))}/${AGENT_WORKFLOW_DIR}/not-here.md`;

try {
  console.log('1. the config carries the slug through to the settings the run reads');
  check('the loader reads agents.implement.workflow',
        workspaceOf('workflowed').agents?.implement?.workflow === 'plan-then-build',
        JSON.stringify(workspaceOf('workflowed').agents));
  check('and agents.issue.workflow separately',
        workspaceOf('workflowed').agents?.issue?.workflow === 'plan-then-build',
        JSON.stringify(workspaceOf('workflowed').agents));
  check('a project that selects none has null',
        workspaceOf('plain').agents?.implement?.workflow === null
          && workspaceOf('plain').agents?.issue?.workflow === null,
        JSON.stringify(workspaceOf('plain').agents));
  check('and an unusable one is kept rather than dropped, so the run can refuse it',
        workspaceOf('escaping').agents?.implement?.workflow === '../evil',
        JSON.stringify(workspaceOf('escaping').agents));
  check('a project with an unusable workflow still loads',
        workspaceOf('escaping').error === null, workspaceOf('escaping').error);

  console.log('\n2. selecting nothing sends the prompt this sent before the feature existed');
  const plainImplement = await implementRun('plain');
  check('the implementation ran', plainImplement.ok, plainImplement.error);
  check('the implement prompt is the baseline, byte for byte',
        promptSeen() === IMPLEMENT_BASELINE,
        `${promptSeen().length} bytes against ${IMPLEMENT_BASELINE.length}`);
  const plainImplementArgv = argvSeen();
  check('and its argv is untouched', same(plainImplementArgv, BASE_ARGV),
        JSON.stringify(plainImplementArgv));

  const plainIssue = await issueRun('plain');
  check('the issue run ran', plainIssue.ok, plainIssue.error);
  check('the issue prompt is the baseline, byte for byte',
        promptSeen() === ISSUE_BASELINE,
        `${promptSeen().length} bytes against ${ISSUE_BASELINE.length}`);
  const plainIssueArgv = argvSeen();
  check('and its argv is untouched', same(plainIssueArgv, BASE_ARGV), JSON.stringify(plainIssueArgv));

  console.log('\n3. an empty selection adds nothing at all');
  check('no workflow is the empty string',
        workflowSection(null) === '' && workflowSection(undefined) === ''
          && workflowSection('') === '' && workflowSection('   ') === '',
        'a feature nobody selected must not change what every board already does');

  console.log('\n4. selecting one changes the prompt, and only the prompt');
  const withImplement = await implementRun('workflowed');
  check('the implementation ran', withImplement.ok, withImplement.error);
  const implementPrompt = promptSeen();
  check('the prompt still starts with everything it said before',
        implementPrompt.startsWith(IMPLEMENT_BASELINE),
        'the workflow must be added to the prompt, not substituted for it');
  check('the project\'s own text is in it, verbatim',
        implementPrompt.includes(WORKFLOW_TEXT.trim()),
        'a pointer would degrade to a suggestion; the text is what authorizes');
  check('and it is the last word, after the worktree and resume sections',
        implementPrompt.trimEnd().endsWith(WORKFLOW_TEXT.trim()),
        implementPrompt.slice(-160));
  const withImplementArgv = argvSeen();
  check('the command line is identical to the one a project with no workflow spawns',
        same(withImplementArgv, plainImplementArgv),
        `${JSON.stringify(withImplementArgv)} against ${JSON.stringify(plainImplementArgv)}`);
  check('and nothing from the file reached it',
        !withImplementArgv.some((argument) => /plan|sub-agent|workflow/i.test(argument)),
        JSON.stringify(withImplementArgv));

  const withIssue = await issueRun('workflowed');
  check('the issue run carries its own workflow too', withIssue.ok && promptSeen().includes(WORKFLOW_TEXT.trim()),
        withIssue.error ?? promptSeen().slice(-200));
  check('on top of its own baseline', promptSeen().startsWith(ISSUE_BASELINE));
  check('with the same argv as a project with no workflow', same(argvSeen(), plainIssueArgv),
        JSON.stringify(argvSeen()));

  console.log('\n5. the section authorizes the workflow rather than merely quoting it');
  const section = workflowSection(WORKFLOW_TEXT);
  check('it tells the agent to follow it', /follow it|is authoritative|do what it says/i.test(section),
        section.slice(0, 200));
  check('and says it grants nothing',
        /(grants?|widen|gives?) (you )?(no|nothing|not)/i.test(section)
          || /cannot widen|does not grant|grants no/i.test(section),
        'a project may retune what the operator granted; it may never grant it');

  console.log('\n6. a name that does not resolve refuses the run before the spawn');
  const refused = await implementRun('missing');
  check('the run failed', refused.ok === false, JSON.stringify(refused));
  check('and nothing was spawned', !existsSync(captured),
        'the agent was started and then the workflow was found to be missing');
  check('the refusal names the whole path it looked for, project and all',
        (refused.error ?? '').includes(missingFile), refused.error);
  check('and the setting that selected it',
        /agents\.implement\.workflow/.test(refused.error ?? ''), refused.error);

  console.log('\n7. a slug is a slug, and an escape is refused rather than ignored');
  const escaped = await implementRun('escaping');
  check('a workflow reaching outside the project fails the run', escaped.ok === false,
        JSON.stringify(escaped));
  check('without spawning anything', !existsSync(captured), 'the escape was honoured far enough to run');

  const plain = workspaceOf('plain');
  const settingsWith = (workflow) => ({ model: null, effort: null, timeoutMs: null, workflow });
  for (const bad of ['../evil', '/etc/passwd', 'C:\\evil', 'sub/dir', 'Upper', '-leading', 'has space', 'dot.md']) {
    const outcome = await loadAgentWorkflow(plain, 'implement', settingsWith(bad));
    check(`"${bad}" is refused`, outcome.ok === false, JSON.stringify(outcome));
  }
  const goodShape = await loadAgentWorkflow(plain, 'implement', settingsWith('fable-plan-opus-build'));
  check('a well-formed slug gets as far as looking for its file',
        goodShape.ok === false && /fable-plan-opus-build\.md/.test(goodShape.error),
        JSON.stringify(goodShape));
  const none = await loadAgentWorkflow(plain, 'implement', settingsWith(null));
  check('and selecting none is not an error', none.ok === true && none.text === null,
        JSON.stringify(none));

  console.log('\n8. the config surface accepts the field and refuses what is not one');
  const accepted = validateWorkspaceConfigPatch({
    agents: { implement: { workflow: 'fable-plan-opus-build' }, issue: { workflow: 'research-deeply' } },
  });
  check('a slug on both agents is accepted', accepted.ok === true, JSON.stringify(accepted));
  check('clearing it is accepted',
        validateWorkspaceConfigPatch({ agents: { implement: { workflow: null } } }).ok === true);
  const wrongType = validateWorkspaceConfigPatch({ agents: { implement: { workflow: 42 } } });
  check('a workflow that is not text is refused', wrongType.ok === false, JSON.stringify(wrongType));
  check('by name', /agents\.implement\.workflow/.test(wrongType.error ?? ''), wrongType.error);
  for (const bad of ['../evil', 'agent-workflows/x.md', 'Upper Case', 'C:\\evil']) {
    const outcome = validateWorkspaceConfigPatch({ agents: { implement: { workflow: bad } } });
    check(`"${bad}" is refused on the way in`, outcome.ok === false, JSON.stringify(outcome));
  }
  const unknown = validateWorkspaceConfigPatch({ agents: { implement: { workflows: 'x' } } });
  check('a field it has never heard of is still refused by name', unknown.ok === false,
        JSON.stringify(unknown));
  check('and the refusal now lists workflow among the ones it knows',
        /workflow/.test(unknown.error ?? ''), unknown.error);
  const command = validateWorkspaceConfigPatch({ agents: { implement: { command: 'node evil.mjs' } } });
  check('and a command is still not a thing a project may configure', command.ok === false,
        JSON.stringify(command));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
