#!/usr/bin/env node
/**
 * Checks that a project can say what language its issues are written in.
 *
 * The prompt fixed English, and it was right to: issue #20 came out entirely in Portuguese
 * from an observation written in English, because step 3 sends the agent to read the
 * project's own documentation and it took the language from its surroundings. Fixing it in
 * the prompt is what stopped that, and none of this may undo it — an agent still may not pick
 * the language up from whatever it just read.
 *
 * What changes is *who* decides. English was hard-coded, and this board opens issues in more
 * than one repository: a project whose own `CLAUDE.md` requires Portuguese got every card
 * this tool opened for it written against its own rule. So the language is a project setting
 * beside `name` and `docsDir`, defaulting to English, and the prompt is as fixed as it ever
 * was — it just says what the project said.
 *
 * Three things have to hold, and the third is the one that a green type-check would miss:
 *
 *   1. `board.config.json` can carry `language`, the loader surfaces it, and the write path
 *      refuses a value that is not text — `validateWorkspaceConfigPatch` refuses any field it
 *      has never heard of, so an unknown one is not "ignored", it is a 400;
 *   2. the prompts name it — and with nothing configured are **byte for byte** what they were,
 *      which is what keeps a board that never sets it exactly where it was;
 *   3. the real composition path passes it. A `Workspace.language` nothing reads is the same
 *      bug with a field added.
 *
 * Usage: node scripts/check-workspace-language.mjs
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

const { loadWorkspaces, validateWorkspaceConfigPatch } =
  await importDist(join('core', 'workspaces.js'), 'the workspace loader');
const agent = await importDist(join('core', 'issue-agent.js'), 'the issue agent');
const { ISSUE_AGENT_PROMPT, ISSUE_REVISE_PROMPT, runIssueAgent, runReviseAgent } = agent;

const workDir = join(tmpdir(), 'workspace-language-check');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// ─── 1. the setting ────────────────────────────────────────────

console.log('1. a project may name the language its issues are written in');

const projects = {
  plain: { name: 'Plain' },
  portuguese: { name: 'Farol', language: 'Portuguese' },
  blank: { name: 'Blank', language: '   ' },
};
const registry = { workspaces: [] };
for (const [id, config] of Object.entries(projects)) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config), 'utf8');
  registry.workspaces.push({ id, path: dir.replace(/\\/g, '/') });
}
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

const loaded = await loadWorkspaces(registryPath);
const byId = Object.fromEntries(loaded.map((workspace) => [workspace.id, workspace]));

check('a project that names one has it', byId.portuguese?.language === 'Portuguese',
      JSON.stringify(byId.portuguese?.language));
check('a project that does not is null rather than a guess', byId.plain?.language === null,
      JSON.stringify(byId.plain?.language));
check('and whitespace is not a language', byId.blank?.language === null,
      JSON.stringify(byId.blank?.language));
check('naming one is not an error on the workspace', byId.portuguese?.error === null,
      String(byId.portuguese?.error));

console.log('\n2. the write path knows the field');
check('a language may be written', validateWorkspaceConfigPatch({ language: 'Portuguese' }).ok);
check('and cleared', validateWorkspaceConfigPatch({ language: null }).ok);
check('but not set to something that is not text',
      validateWorkspaceConfigPatch({ language: 5 }).ok === false,
      JSON.stringify(validateWorkspaceConfigPatch({ language: 5 })));
check('and the refusal for an unknown field still names the known ones', (() => {
  const refused = validateWorkspaceConfigPatch({ langauge: 'Portuguese' });
  return refused.ok === false && /language/.test(refused.error);
})(), JSON.stringify(validateWorkspaceConfigPatch({ langauge: 'x' })));

// ─── 3. the prompts ────────────────────────────────────────────

console.log('\n3. the prompt says what the project said, and English when it said nothing');
check('the exported research prompt is still the English one', /\bEnglish\b/.test(ISSUE_AGENT_PROMPT));
check('and so is the exported revise prompt', /\bEnglish\b/.test(ISSUE_REVISE_PROMPT));

// ─── 4. through the real composition path ──────────────────────

const stub = join(workDir, 'agent-stub.mjs');
const captured = join(workDir, 'prompt.txt');
writeFileSync(stub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  // Since #329 the prompt travels down whichever channel the backend declared, and this
  // command line carries no \`-p\`, so \`raw\` delivers it as the last argument.
  if (!input) input = process.argv[process.argv.length - 1] ?? '';
  writeFileSync(process.env.CAPTURE_TO, input, 'utf8');
  process.stdout.write('https://github.com/vitorengers/farol/issues/6\\n');
});
`, 'utf8');
process.env.CAPTURE_TO = captured;

const workspaceFor = (language) => ({
  id: 'language-check',
  name: 'Language Check',
  path: workDir,
  innerPath: workDir.replace(/\\/g, '/'),
  environment: { kind: 'native' },
  language,
  error: null,
});

const agentCommand = `node "${stub.replace(/\\/g, '/')}"`;
// The board holds a backend beside every command; `raw` is the passthrough one, which is
// what a free-text command line has always been and what every board configured today is.
const agentSpec = { backend: 'raw', command: agentCommand };

async function researchPrompt(language) {
  rmSync(captured, { force: true });
  await runIssueAgent(workspaceFor(language), 'A note written on the board.', {
    agent: agentSpec, timeoutMs: 60_000,
  });
  return readFileSync(captured, 'utf8');
}

async function revisePrompt(language) {
  rmSync(captured, { force: true });
  await runReviseAgent(workspaceFor(language),
    'https://github.com/vitorengers/farol/issues/6', 'More notes.', {
      agent: agentSpec, timeoutMs: 60_000,
    });
  return readFileSync(captured, 'utf8');
}

console.log('\n4. and it reaches the agent, over stdin, through the path a run uses');
const englishResearch = await researchPrompt(null);
check('a project that named nothing still gets English',
      /Write the issue in English/.test(englishResearch),
      englishResearch.slice(0, 200));
check('and the prompt it gets is the one it got before this existed',
      englishResearch.startsWith(ISSUE_AGENT_PROMPT),
      'the default composition changed, so every board that sets nothing changed with it');

const portugueseResearch = await researchPrompt('Portuguese');
check('a project that named Portuguese is told Portuguese',
      /Write the issue in Portuguese/.test(portugueseResearch),
      portugueseResearch.slice(0, 1200));
check('and is not also told English',
      !/Write the issue in English/.test(portugueseResearch));
// `\s+` rather than a space throughout: the prompt is wrapped prose, so any of these
// phrases may have a newline in the middle of it, and a rewrap is not a regression.
check('the rule itself survives: the language is fixed, not taken from what was read',
      /not\s+the\s+language\s+of\s+the\s+observation/.test(portugueseResearch)
      && /not\s+the\s+language\s+of\s+the\s+repository/.test(portugueseResearch),
      'this is #20, and a per-project language must not reopen it');
check('and the observation is still quoted rather than translated where it is the evidence',
      /Quote\s+the\s+observation\s+verbatim/.test(portugueseResearch));

const englishRevise = await revisePrompt(null);
check('rewriting an issue defaults to English too', /Write it in English/.test(englishRevise));
const portugueseRevise = await revisePrompt('Portuguese');
check('and follows the project when it named one', /Write it in Portuguese/.test(portugueseRevise),
      portugueseRevise.slice(0, 1200));
check('with the same rule kept',
      /not\s+the\s+language\s+of\s+the\s+observations/.test(portugueseRevise));

rmSync(workDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
