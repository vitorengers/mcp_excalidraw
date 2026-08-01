#!/usr/bin/env node
/**
 * Checks that the issue agent is told which repository and which project it is working on.
 *
 * The research prompt says "Create the issue with `gh` in this repository, add it to the
 * configured project" and was given neither. Which repository `gh` picks is then left to git
 * remote resolution, where an `upstream` remote wins over `origin` — this repository's own
 * trap document records the consequence: `gh issue list` in this checkout lists the *upstream*
 * project's issues, not this fork's (docs/trap-gh-path.md). The second half is quieter: with
 * no project named, the agent cannot add the issue to one, no card ever appears, and the
 * observation block that started the run sits in My Notes forever looking half-finished.
 *
 * So the workspace's `repo` and `githubProject` go into the prompt, as a fact about the run in
 * the way the implement agent's worktree paragraph already is — not as workflow, which stays
 * out of the base prompt on purpose.
 *
 * The cases are the feature and the two boundaries around it:
 *
 *  - A project that names both gets both strings, in the research prompt and in the revise
 *    prompt, through the real composition path rather than out of a constant.
 *  - A project that names **neither** sends the prompt it sent before this existed, byte for
 *    byte — the same rule `workflowSection` and `worktreeSection` already keep. Each half is
 *    independent: naming only one adds only that one.
 *  - It changes **the prompt and only the prompt**. argv is identical to the argv of a project
 *    that names nothing, and no observation and no configured value reaches a command line.
 *    The prompt still arrives on the child's stdin.
 *
 * **This is a lint over instructions, not a test of behaviour.** No check here can show that an
 * agent obeys `--repo`; what it can do is fail when the strings are dropped or reworded into
 * something that no longer names them.
 *
 * In process and self-contained: throwaway projects, a stub agent that writes down the prompt
 * and the argv it was handed, no server and nothing that talks to GitHub. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-issue-agent-target.mjs
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

const {
  runIssueAgent, runReviseAgent, ISSUE_AGENT_PROMPT, ISSUE_REVISE_PROMPT, issueTargetSection,
} = await importDist(join('core', 'issue-agent.js'), 'the issue agent');
const { loadWorkspaces } = await importDist(join('core', 'workspaces.js'), 'the workspace registry');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `issue-agent-target-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const slash = (value) => String(value).replace(/\\/g, '/');

const REPO = 'vitorengers/vibemaxxing';
/**
 * Somebody else's board, deliberately.
 *
 * `check-shipped-config-neutral.mjs` fails any tracked file that names a project owned by this
 * repository's own owner — a fixture is indistinguishable from a shipped default to whoever
 * clones the release — so the URL under test is one nobody here can reach.
 */
const PROJECT = 'https://github.com/users/a-stranger/projects/7';

function makeProject(id, config) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}

/** Names neither — the byte-for-byte case. */
makeProject('plain', { name: 'Plain' });
/** Names both, which is what a board configured for its own account looks like. */
makeProject('both', { name: 'Both', repo: REPO, githubProject: PROJECT });
/** A checkout with a remote and no project board: registration writes exactly this. */
makeProject('repoonly', { name: 'Repo Only', repo: REPO });
/** A project board and no readable remote — the other half, on its own. */
makeProject('projectonly', { name: 'Project Only', githubProject: PROJECT });

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: ['plain', 'both', 'repoonly', 'projectonly'].map((id) => ({
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
/** What the stub must see on its command line whatever a project configured. */
const BASE_ARGV = ['--output-format', 'stream-json'];

const ISSUE_URL = 'https://github.com/vitorengers/vibemaxxing/issues/335';
const OBSERVATION = 'gh files the issue on whichever repository a remote resolves to';
const OBSERVATIONS = 'the card never appeared on the project, so the note stayed on the board';

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

async function researchRun(id) {
  clearCapture();
  process.env.CAPTURE_URL = ISSUE_URL;
  return runIssueAgent(workspaceOf(id), OBSERVATION, {
    agentCommand: AGENT_COMMAND,
    timeoutMs: 60_000,
  });
}

async function reviseRun(id) {
  clearCapture();
  process.env.CAPTURE_URL = ISSUE_URL;
  return runReviseAgent(workspaceOf(id), ISSUE_URL, OBSERVATIONS, {
    agentCommand: AGENT_COMMAND,
    timeoutMs: 60_000,
  });
}

/** The prompt each run sends when the board names nothing at all. */
const RESEARCH_BASELINE =
  `${ISSUE_AGENT_PROMPT}\n\n---\n\nObservation:\n\n${OBSERVATION}`;
const REVISE_BASELINE =
  `${ISSUE_REVISE_PROMPT}\n\n---\n\nThe issue to rewrite: ${ISSUE_URL}`
  + `\n\n---\n\nNew observations:\n\n${OBSERVATIONS}`;

try {
  console.log('1. the loader carries both fields through to the run');
  check('a project that names a repository has it', workspaceOf('both').repo === REPO,
        JSON.stringify(workspaceOf('both').repo));
  check('and its project', workspaceOf('both').githubProject === PROJECT,
        JSON.stringify(workspaceOf('both').githubProject));
  check('a project that names neither has null for both',
        workspaceOf('plain').repo === null && workspaceOf('plain').githubProject === null,
        JSON.stringify([workspaceOf('plain').repo, workspaceOf('plain').githubProject]));

  console.log('\n2. naming nothing adds nothing at all');
  // Guarded rather than called outright: against a build that has no such export this has to
  // report a failing case, not crash the run before the cases below have said anything.
  const section = typeof issueTargetSection === 'function' ? issueTargetSection : () => undefined;
  check('the issue agent exports the section', typeof issueTargetSection === 'function',
        'issueTargetSection is what composes the repository and the project into the prompt');
  check('neither field is the empty string',
        section({ repo: null, githubProject: null }) === ''
          && section({ repo: undefined, githubProject: undefined }) === ''
          && section({ repo: '', githubProject: '' }) === ''
          && section({ repo: '  ', githubProject: '  ' }) === '',
        'a board that configured neither must send what every board already sent');

  const plainResearch = await researchRun('plain');
  check('the research run ran', plainResearch.ok, plainResearch.error);
  check('and its prompt is the baseline, byte for byte',
        promptSeen() === RESEARCH_BASELINE,
        `${promptSeen().length} bytes against ${RESEARCH_BASELINE.length}`);
  const plainArgv = argvSeen();
  check('with its argv untouched', same(plainArgv, BASE_ARGV), JSON.stringify(plainArgv));

  const plainRevise = await reviseRun('plain');
  check('the revise run ran', plainRevise.ok, plainRevise.error);
  check('and its prompt is the baseline too, byte for byte',
        promptSeen() === REVISE_BASELINE,
        `${promptSeen().length} bytes against ${REVISE_BASELINE.length}`);

  console.log('\n3. a board that names both says both, in the research prompt');
  const bothResearch = await researchRun('both');
  check('the run ran', bothResearch.ok, bothResearch.error);
  const researchPrompt = promptSeen();
  check('the repository is named', researchPrompt.includes(REPO), researchPrompt.slice(-400));
  check('as the --repo the agent is told to pass, so an upstream remote cannot win',
        researchPrompt.includes(`--repo ${REPO}`),
        'gh resolves the repository from the remotes otherwise — docs/trap-gh-path.md');
  check('the project is named', researchPrompt.includes(PROJECT), researchPrompt.slice(-400));
  check('and it is added to what the prompt already said, not substituted for it',
        researchPrompt.startsWith(RESEARCH_BASELINE),
        'the observation and the base instruction must both survive');

  console.log('\n4. and in the revise prompt, which reads the same issue with gh');
  const bothRevise = await reviseRun('both');
  check('the run ran', bothRevise.ok, bothRevise.error);
  const revisePrompt = promptSeen();
  check('the repository is named', revisePrompt.includes(`--repo ${REPO}`),
        revisePrompt.slice(-400));
  check('the project is named', revisePrompt.includes(PROJECT), revisePrompt.slice(-400));
  check('on top of its own baseline', revisePrompt.startsWith(REVISE_BASELINE),
        `${revisePrompt.length} bytes, baseline ${REVISE_BASELINE.length}`);

  console.log('\n5. each half stands alone');
  const repoOnly = await researchRun('repoonly');
  check('the run ran', repoOnly.ok, repoOnly.error);
  const repoOnlyPrompt = promptSeen();
  check('a board with a repository and no project names the repository',
        repoOnlyPrompt.includes(`--repo ${REPO}`), repoOnlyPrompt.slice(-400));
  check('and invents no project for it',
        !repoOnlyPrompt.includes(PROJECT) && !/\bgithub\.com\/users\//.test(repoOnlyPrompt),
        repoOnlyPrompt.slice(-400));

  const projectOnly = await researchRun('projectonly');
  check('the run ran', projectOnly.ok, projectOnly.error);
  const projectOnlyPrompt = promptSeen();
  check('a board with a project and no repository names the project',
        projectOnlyPrompt.includes(PROJECT), projectOnlyPrompt.slice(-400));
  check('and tells it to pass no --repo it does not have',
        !projectOnlyPrompt.includes('--repo'), projectOnlyPrompt.slice(-400));

  console.log('\n6. the prompt and only the prompt');
  const bothArgv = (await researchRun('both'), argvSeen());
  check('the command line is identical to the one a board naming nothing spawns',
        same(bothArgv, plainArgv), `${JSON.stringify(bothArgv)} against ${JSON.stringify(plainArgv)}`);
  check('nothing configured reached it',
        !bothArgv.some((argument) => /vibemaxxing|projects\/5|--repo/.test(argument)),
        JSON.stringify(bothArgv));
  check('and neither did the observation',
        !bothArgv.some((argument) => argument.includes(OBSERVATION)),
        JSON.stringify(bothArgv));
  check('the prompt reached the agent on stdin, which is where it was read from',
        promptSeen().includes(OBSERVATION) && promptSeen().includes(REPO),
        'the stub only ever writes down what it read off stdin');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
