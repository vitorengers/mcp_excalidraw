#!/usr/bin/env node
/**
 * Checks that a model and an effort are spelled by the backend that will run them.
 *
 * `applyAgentSettings` used to append `--model <v> --effort <v>` to whatever the operator wrote,
 * from three call sites, and `AGENT_EFFORTS` was one global list documented as *"Effort levels
 * the agent CLI accepts, as `claude --help` states them"*. Both halves are Claude Code's, and a
 * board that named a second backend got them anyway: `codex exec … --effort high` exits on an
 * unknown argument before doing any work, because Codex spells reasoning effort as a config
 * override, `-c model_reasoning_effort="high"`.
 *
 * The flag half is settled — a backend builds its own argv since the adapter landed — so what is
 * asserted here is the pair, together, because they are one defect and they fail apart:
 *
 *  1. **A configured effort reaches each backend in that backend's own spelling.** Claude Code's
 *     `--effort`, Codex's `-c model_reasoning_effort=`, and the passthrough's appended flag —
 *     and, the case the crash was, no `--effort` anywhere in a Codex invocation.
 *  2. **An effort the selected backend does not accept is refused on the write path, by name.**
 *     One global list can only ever be one backend's, so the refusal has to come from the
 *     backend this project's agent actually runs under, and has to say which one that was:
 *     `minimal` is a level Codex takes and Claude Code does not, and a message that names
 *     neither leaves the operator with no way to tell a typo from a backend mismatch.
 *  3. **The load path answers to the same list.** It is lenient by design — a bad field must not
 *     empty the whole strip — so what is asserted is which value *survives*: `minimal` reaches
 *     the run under `codex-cli` and is dropped under `claude-code`.
 *  4. **A project that configures neither model nor effort produces the argv it produces today.**
 *     Every board that exists configures neither, so this is the contract the other three are
 *     not allowed to move.
 *
 * The effort lists are not remembered. Claude Code's is `claude --help` on this machine —
 * *"--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)"* —
 * and Codex's is `ReasoningEffort::from_str` in `codex-rs/protocol/src/openai_models.rs`, which
 * names `none, minimal, low, medium, high, xhigh, max, ultra`. That last one corrects the issue
 * this check was written for, which had Codex refusing `xhigh` and `max`: it takes both. What it
 * does not take is being handed a flag it has no name for.
 *
 * Self-contained and offline: a throwaway registry of three projects read in this process, the
 * adapters called directly, no canvas server, no browser, no GitHub. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-agent-model-effort.mjs
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

const registryModule = await loadDist(join('core', 'agents', 'index.js'));
const workspacesModule = await loadDist(join('core', 'workspaces.js'));

if (!registryModule?.adapterFor || !workspacesModule?.validateWorkspaceConfigPatch) {
  console.error('  FAIL  the backend registry and the workspace loader both build');
  process.exit(1);
}

const { adapterFor, agentEfforts } = registryModule;
const { loadWorkspaces, validateWorkspaceConfigPatch } = workspacesModule;

const slash = (value) => String(value).replace(/\\/g, '/');

/** One invocation's argv as a line, for a failure that has to show what was spelled. */
const argvOf = (invocation) => invocation.args.join(' ');

// ─── 1. each backend spells the same two settings its own way ──
//
// The same `{ model, effort }` handed to all three, because that is what the board hands them:
// values out of a project's config, never flags. What comes back has to be three different argvs.

console.log('1. a configured model and effort reach each backend in that backend\'s own spelling');

const TUNED = { mode: 'headless', role: 'implement', model: 'a-model', effort: 'high' };

const claude = adapterFor('claude-code').invoke({ ...TUNED, command: 'claude' });
check('claude-code writes --model and --effort',
      claude.args.includes('--model') && claude.args[claude.args.indexOf('--model') + 1] === 'a-model'
      && claude.args.includes('--effort') && claude.args[claude.args.indexOf('--effort') + 1] === 'high',
      argvOf(claude));

const codex = adapterFor('codex-cli').invoke({ ...TUNED, command: 'codex' });
check('codex-cli writes --model and a config override for the effort',
      codex.args.includes('--model') && codex.args[codex.args.indexOf('--model') + 1] === 'a-model'
      && codex.args.includes('-c') && codex.args.includes('model_reasoning_effort=high'),
      argvOf(codex));
// The crash this item is named for: `codex exec --effort high` exits on an unknown argument
// before it has done anything, and nothing downstream ever sees why.
check('and no --effort anywhere in a codex-cli run',
      !codex.args.includes('--effort') && !codex.line.includes('--effort'),
      argvOf(codex));

const raw = adapterFor('raw').invoke({ ...TUNED, command: 'agent -p' });
check('raw appends both to the operator\'s own line',
      raw.line === 'agent -p --model a-model --effort high', raw.line);

// ─── 2. the levels are the backend's own, not one global list ──

console.log('\n2. each backend names the effort levels it accepts');

check('a backend can be asked what efforts it takes', typeof agentEfforts === 'function',
      'core/agents/index.js exports no agentEfforts');

const efforts = (backend) => (typeof agentEfforts === 'function' ? [...agentEfforts(backend)] : []);

// `claude --help`: "--effort <level>  Effort level for the current session (low, medium, high,
// xhigh, max)".
check('claude-code takes the five levels claude --help states',
      efforts('claude-code').join(',') === 'low,medium,high,xhigh,max',
      efforts('claude-code').join(','));
// `ReasoningEffort::from_str`, codex-rs/protocol/src/openai_models.rs.
check('codex-cli takes minimal, which Claude Code does not',
      efforts('codex-cli').includes('minimal') && !efforts('claude-code').includes('minimal'),
      efforts('codex-cli').join(','));
check('and none and ultra, which Claude Code does not',
      efforts('codex-cli').includes('none') && efforts('codex-cli').includes('ultra')
      && !efforts('claude-code').includes('ultra'),
      efforts('codex-cli').join(','));
// The passthrough spells `--effort` because the command lines it is given are, in practice,
// Claude Code's — so it has to accept exactly what Claude Code accepts and nothing more.
check('raw accepts exactly what claude-code accepts',
      efforts('raw').join(',') === efforts('claude-code').join(','),
      efforts('raw').join(','));

// ─── 3. the write path refuses against the selected backend ────

console.log('\n3. an effort the selected backend does not take is refused, with the backend named');

const backends = (backend) => ({ issue: backend, implement: backend });
const refusal = (backend, effort, kind = 'issue') => {
  const outcome = validateWorkspaceConfigPatch(
    { agents: { [kind]: { effort } } },
    backends(backend)
  );
  return outcome.ok ? null : outcome.error;
};

const minimalUnderClaude = refusal('claude-code', 'minimal');
check('minimal is refused under claude-code', Boolean(minimalUnderClaude), 'it was accepted');
check('and the refusal names claude-code',
      Boolean(minimalUnderClaude?.includes('claude-code')), minimalUnderClaude ?? '(accepted)');
check('and lists what claude-code does take',
      Boolean(minimalUnderClaude?.includes('xhigh')), minimalUnderClaude ?? '(accepted)');

check('minimal is accepted under codex-cli, which takes it',
      refusal('codex-cli', 'minimal') === null, refusal('codex-cli', 'minimal') ?? '');
check('and ultra with it', refusal('codex-cli', 'ultra') === null,
      refusal('codex-cli', 'ultra') ?? '');

const ultraUnderRaw = refusal('raw', 'ultra');
check('ultra is refused under raw, which spells Claude Code\'s flag',
      Boolean(ultraUnderRaw), 'it was accepted');
check('and that refusal names raw', Boolean(ultraUnderRaw?.includes('raw')),
      ultraUnderRaw ?? '(accepted)');

// The message has to separate a typo from a backend mismatch, so a level no backend has must
// still be refused everywhere — and each backend must say so as itself.
for (const backend of ['claude-code', 'codex-cli', 'raw']) {
  const nonsense = refusal(backend, 'ludicrous');
  check(`a level no backend has is refused under ${backend}, naming it`,
        Boolean(nonsense?.includes(backend)), nonsense ?? '(accepted)');
}

// The implement agent may run under a different backend from the issue agent — the two are
// separate grants — so the refusal has to be per kind rather than per project.
const mixed = validateWorkspaceConfigPatch(
  { agents: { issue: { effort: 'minimal' }, implement: { effort: 'max' } } },
  { issue: 'codex-cli', implement: 'claude-code' }
);
check('a level each kind\'s own backend takes is accepted together', mixed.ok === true,
      mixed.ok ? '' : mixed.error);
const mixedRefused = validateWorkspaceConfigPatch(
  { agents: { implement: { effort: 'minimal' } } },
  { issue: 'codex-cli', implement: 'claude-code' }
);
check('and the implement agent is judged by its own backend, not the issue agent\'s',
      mixedRefused.ok === false && String(mixedRefused.error).includes('claude-code'),
      mixedRefused.ok ? '(accepted)' : mixedRefused.error);

// Every board that exists names no backend, so the call with no backends at all is the one that
// must not move: the board default is `raw`, and `raw` is Claude Code's list.
const byDefault = validateWorkspaceConfigPatch({ agents: { issue: { effort: 'max' } } });
check('a call that names no backend still accepts what a board accepts today',
      byDefault.ok === true, byDefault.ok ? '' : byDefault.error);
const nonsenseByDefault = validateWorkspaceConfigPatch({ agents: { issue: { effort: 'ludicrous' } } });
check('and still refuses what it refuses today', nonsenseByDefault.ok === false,
      '(accepted)');

// ─── the throwaway registry, for the load path ─────────────────

const workDir = join(tmpdir(), `agent-model-effort-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

function makeProject(id, config) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}

const minimalDir = makeProject('minimal-effort', {
  name: 'Minimal effort',
  agents: { issue: { model: 'a-model', effort: 'minimal' }, implement: { effort: 'minimal' } },
});
const plainDir = makeProject('plain', { name: 'Plain' });

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'minimal-effort', path: slash(minimalDir) },
    { id: 'plain', path: slash(plainDir) },
  ],
}, null, 2), 'utf8');

// ─── 4. the load path reads the same list ──────────────────────

console.log('\n4. the load path drops an effort the selected backend does not take, and keeps one it does');

const loadedAs = async (backend) => {
  const workspaces = await loadWorkspaces(registryPath, backends(backend));
  return workspaces.find((workspace) => workspace.id === 'minimal-effort');
};

const underCodex = await loadedAs('codex-cli');
check('minimal survives the load under codex-cli', underCodex?.agents?.issue?.effort === 'minimal',
      String(underCodex?.agents?.issue?.effort));
check('and the model beside it is untouched', underCodex?.agents?.issue?.model === 'a-model',
      String(underCodex?.agents?.issue?.model));

const underClaude = await loadedAs('claude-code');
check('and is dropped under claude-code, which has no such level',
      underClaude?.agents?.issue?.effort === null, String(underClaude?.agents?.issue?.effort));
check('without taking the model with it', underClaude?.agents?.issue?.model === 'a-model',
      String(underClaude?.agents?.issue?.model));

// ─── 5. a project that configures neither is unmoved ───────────

console.log('\n5. a project that configures neither a model nor an effort spawns what it spawns today');

const untuned = await loadWorkspaces(registryPath);
const plain = untuned.find((workspace) => workspace.id === 'plain');
check('a project that says nothing resolves to no model and no effort',
      plain?.agents?.issue?.effort === null && plain?.agents?.issue?.model === null
      && plain?.agents?.implement?.effort === null && plain?.agents?.implement?.model === null,
      JSON.stringify(plain?.agents ?? null));

const UNTUNED = { mode: 'headless', role: 'implement', model: null, effort: null };
const bare = adapterFor('raw').invoke({ ...UNTUNED, command: 'agent -p --output-format stream-json' });
check('raw spawns the operator\'s line byte for byte',
      bare.line === 'agent -p --output-format stream-json', bare.line);
check('claude-code writes no --model and no --effort',
      !bare.args.includes('--model')
      && !adapterFor('claude-code').invoke({ ...UNTUNED, command: 'claude' }).args.includes('--effort')
      && !adapterFor('claude-code').invoke({ ...UNTUNED, command: 'claude' }).args.includes('--model'),
      argvOf(adapterFor('claude-code').invoke({ ...UNTUNED, command: 'claude' })));
const bareCodex = adapterFor('codex-cli').invoke({ ...UNTUNED, command: 'codex' });
// Stated as the override it is about rather than as "no `-c` at all", which was the same claim
// while the effort was the only thing that reached for that flag. Since #327 the codex-cli
// permission posture spells its sandbox's network access with a `-c` too — that one is
// `check-agent-permissions.mjs`'s subject, and it is written whatever the project configures.
check('and codex-cli writes no reasoning-effort override',
      !bareCodex.args.some((argument) => argument.includes('model_reasoning_effort')),
      argvOf(bareCodex));

// ─── 6. the appending helper is gone ───────────────────────────

console.log('\n6. nothing appends Claude Code\'s flags to somebody else\'s command line');

const issueAgentSource = readFileSync(join(repoRoot, 'src', 'core', 'issue-agent.ts'), 'utf8');
check('applyAgentSettings no longer exists in src/core/issue-agent.ts',
      !/\bfunction\s+applyAgentSettings\b/.test(issueAgentSource),
      'it is still declared there');
const agentModule = await loadDist(join('core', 'issue-agent.js'));
check('and is exported by nothing', typeof agentModule?.applyAgentSettings !== 'function',
      'dist/core/issue-agent.js still exports it');

// ─── done ─────────────────────────────────────────────────────

rmSync(workDir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nAll cases passed.');
