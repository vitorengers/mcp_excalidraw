#!/usr/bin/env node
/**
 * Checks that a board can name its agent instead of composing four command lines by hand.
 *
 * Configuring an agent meant writing `EXCALIDRAW_ISSUE_AGENT`, `EXCALIDRAW_ISSUE_AGENT_WSL`,
 * `EXCALIDRAW_IMPLEMENT_AGENT` and `EXCALIDRAW_IMPLEMENT_AGENT_WSL`, each carrying a binary
 * path, a model, an effort, permission flags and stream flags — and nothing discovered the
 * binary, so a first run came up healthy, drew every block, offered every button and did
 * nothing when one was pressed. The adapters have known how to write those flags since #326 and
 * #327; what was missing was a way to *say which adapter*, and a binary for it to run.
 *
 * Four claims, and they fail apart:
 *
 *  1. **A backend name alone is a runnable invocation, in both environments.** The adapter
 *     supplies the binary, the print flags and the permission posture; the distro half keeps a
 *     bare binary name, because a path resolved on the host is exactly what cannot resolve
 *     inside a distro.
 *  2. **Discovery is `resolveExecutable`.** A `claude` or a `codex` on PATH needs no path
 *     written anywhere. A binary that is not there falls back to the bare name, so the failure
 *     is the spawn's own rather than an invented one.
 *  3. **A project may pick among the backends the operator enabled, and no others.** Choosing
 *     which binary runs is granting, and `src/core/workspaces.ts` holds that a project retunes
 *     what the operator granted and never grants it. A name outside the enabled set is refused
 *     with that name in the message, the way an unknown agent field already is.
 *  4. **The legacy four variables spawn byte for byte what they spawn today.** Every board that
 *     exists is configured that way, and so are twenty check scripts: `raw` is a backend, not a
 *     bypass, and a board that names no backend must be unmoved by all of the above.
 *
 * Sections 1–5 are offline and drive the compiled modules in this process. Section 6 starts one
 * real `dist/server.js` with a backend name and nothing else, because the two lines that read
 * the variable are in `src/server.ts` and a module test cannot see them: the defect this item
 * describes is precisely a board that answers `status: healthy` with no agent behind it.
 *
 * No browser, no GitHub, no agent is ever run. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-backend-selection.mjs
 *
 * Tier: fast
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const slash = (value) => String(value).replace(/\\/g, '/');

/** A compiled module, or null when this build has not got it. */
async function loadDist(relative) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) return null;
  try {
    return await import(pathToFileURL(modulePath).href);
  } catch (error) {
    console.error(`  note  dist/${slash(relative)} would not load: ${error.message}`);
    return null;
  }
}

const backendModule = await loadDist(join('core', 'agent-backend.js'));
const agentModule = await loadDist(join('core', 'issue-agent.js'));
const workspacesModule = await loadDist(join('core', 'workspaces.js'));

/** Every export this check drives, named so that a missing one fails as itself. */
function required(module, name, what) {
  const value = module?.[name];
  check(`${name} is exported — ${what}`, typeof value === 'function' || (value && typeof value === 'object'),
        module ? 'the module built without it' : 'the module did not build');
  return typeof value === 'function' || (value && typeof value === 'object') ? value : null;
}

console.log('0. the pieces a board needs in order to name a backend');

const agentGrants = required(backendModule, 'agentGrants', 'the operator\'s grants, per environment');
const agentSpecFor = required(backendModule, 'agentSpecFor', 'the spec one run is spawned from');
const enabledAgentBackends = required(backendModule, 'enabledAgentBackends', 'what a project may pick among');
const BACKEND_BINARIES = required(backendModule, 'BACKEND_BINARIES', 'the binary each backend runs');
const agentGrantsFromEnv = required(agentModule, 'agentGrantsFromEnv', 'the environment, read once');
const agentCommandsOf = required(agentModule, 'agentCommandsOf', 'the board\'s own command per environment');
const agentRunFor = required(agentModule, 'agentRunFor', 'the backend resolver');
const buildAgentCommand = required(agentModule, 'buildAgentCommand', 'the argv a spawn uses');
const validateWorkspaceConfigPatch = required(workspacesModule, 'validateWorkspaceConfigPatch',
                                              'the write path a project is refused on');
const loadWorkspaces = required(workspacesModule, 'loadWorkspaces', 'the read path');

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}

const workDir = join(tmpdir(), `agent-backend-selection-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** A workspace as the run paths read one — only the fields those paths touch. */
function workspaceIn(kind, agents = {}) {
  const none = { model: null, effort: null, timeoutMs: null, workflow: null, backend: null };
  return {
    id: kind === 'wsl' ? 'in-a-distro' : 'on-this-machine',
    name: kind,
    path: kind === 'wsl' ? '\\\\wsl$\\Ubuntu\\home\\x\\p' : join(workDir, 'p'),
    innerPath: kind === 'wsl' ? '/home/x/p' : slash(join(workDir, 'p')),
    environment: kind === 'wsl' ? { kind: 'wsl', distro: 'Ubuntu' } : { kind: 'native' },
    agents: {
      issue: { ...none, ...(agents.issue ?? {}) },
      implement: { ...none, ...(agents.implement ?? {}) },
    },
  };
}

const NATIVE = workspaceIn('native');
const IN_A_DISTRO = workspaceIn('wsl');

/** The `bash -lc` line a distro run is handed, which is the last argument of `wsl.exe`. */
const distroLine = (invocation) => {
  const built = buildAgentCommand(IN_A_DISTRO, invocation);
  return built.args[built.args.length - 1] ?? '';
};

// ─── 1. a backend name alone is a runnable invocation ─────────
//
// No command line anywhere: the whole input is the word `claude-code`, and what has to come
// back is a binary, the flags that make the run print and exit, and a posture per role.

console.log('\n1. a backend name, with no command line anywhere, runs both agents');

const named = agentGrants({ backends: ['claude-code'], resolve: (binary) => `/opt/bin/${binary}` });

check('a named backend grants a command on this machine', named.native.length === 1,
      JSON.stringify(named.native));
check('and it is the backend that was named',
      named.native[0]?.backend === 'claude-code', String(named.native[0]?.backend));
check('whose binary the backend supplied, resolved on this machine',
      named.native[0]?.command === '/opt/bin/claude', String(named.native[0]?.command));

check('the same name grants a command inside a distro too', named.wsl.length === 1,
      JSON.stringify(named.wsl));
// The whole reason the pair exists: a host path is `No such file or directory` in a distro,
// so the distro half is the bare name its own shell will look up.
check('spelled bare, because a host path cannot resolve there',
      named.wsl[0]?.command === 'claude', String(named.wsl[0]?.command));

const issueRun = agentRunFor(named.native[0], 'issue', null);
const implementRun = agentRunFor(named.native[0], 'implement', null);

check('the issue run is spawned as the binary the backend named',
      issueRun.invocation.command === '/opt/bin/claude', String(issueRun.invocation.command));
check('it prints an answer and exits',
      issueRun.invocation.args.includes('--print'), issueRun.invocation.args.join(' '));
check('and speaks while it works, so the block can show a transcript',
      issueRun.adapter.streams(issueRun.invocation), issueRun.invocation.args.join(' '));
check('its prompt goes on stdin, which is what closes it',
      issueRun.invocation.prompt.via === 'stdin', JSON.stringify(issueRun.invocation.prompt));
check('the issue agent is granted a read-only posture nobody typed',
      issueRun.invocation.args.includes('--allowedTools')
      && issueRun.invocation.args.some((argument) => /Bash\(gh issue create/.test(argument)),
      issueRun.invocation.args.join(' '));
check('and it is not the implement agent\'s grant',
      !issueRun.invocation.args.some((argument) => /(^|\s)Write(\s|$)/.test(argument)),
      issueRun.invocation.args.join(' '));
check('the implement agent gets the grant that lets it write',
      implementRun.invocation.args.some((argument) => /(^|\s)Write(\s|$)/.test(argument)),
      implementRun.invocation.args.join(' '));

const codex = agentGrants({ backends: ['codex-cli'] });
const codexRun = agentRunFor(codex.native[0], 'implement', null);
check('a board that names codex-cli gets codex, with no path written anywhere',
      codex.native[0]?.command === 'codex', String(codex.native[0]?.command));
check('and its non-interactive subcommand rather than Claude Code\'s flag',
      codexRun.invocation.args[0] === 'exec' && !codexRun.invocation.args.includes('--print'),
      codexRun.invocation.args.join(' '));
check('with the sandbox that lets it reach gh',
      codexRun.invocation.args.includes('--sandbox')
      && codexRun.invocation.args.includes('workspace-write'),
      codexRun.invocation.args.join(' '));
check('and the marker that says the prompt is on stdin',
      codexRun.invocation.prompt.marker === '-'
      && codexRun.invocation.args[codexRun.invocation.args.length - 1] === '-',
      codexRun.invocation.args.join(' '));

const distro = distroLine(agentRunFor(named.wsl[0], 'implement', null).invocation);
check('a distro run is handed the bare binary and none of this machine\'s paths',
      distro.includes("'claude'") && !distro.includes('/opt/bin'), distro);

check('every backend that is not the passthrough names a binary',
      BACKEND_BINARIES['claude-code'] === 'claude' && BACKEND_BINARIES['codex-cli'] === 'codex'
      && !BACKEND_BINARIES.raw,
      JSON.stringify(BACKEND_BINARIES));

// ─── 2. discovery is resolveExecutable, not a written path ────

console.log('\n2. claude on PATH is found without a path being written anywhere');

const binDir = join(workDir, 'bin');
mkdirSync(binDir, { recursive: true });

/** A file that exists and is a file, which is the whole of what a PATH lookup asks. */
function plant(name) {
  const target = join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(target, process.platform === 'win32' ? '@echo 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n', 'utf8');
  try { chmodSync(target, 0o755); } catch { /* Windows has no mode to set */ }
  return target;
}

const plantedClaude = plant('claude');

const savedEnv = { ...process.env };
function withEnvironment(values, body) {
  for (const key of Object.keys(process.env)) {
    if (/^(?:VIBEMAXXING|EXCALIDRAW)_/.test(key)) delete process.env[key];
  }
  process.env.EXCALIDRAW_NO_DOTENV = '1';
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return body(); } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}

const found = withEnvironment(
  { EXCALIDRAW_AGENT_BACKEND: 'claude-code', PATH: binDir, Path: binDir },
  () => ({ issue: agentGrantsFromEnv('issue'), implement: agentGrantsFromEnv('implement') })
);

// Compared case-insensitively: on Windows the extension comes from `PATHEXT`, which spells it
// `.CMD`, and the file this planted is `claude.cmd`. Same file, two spellings of one name.
const same = (a, b) => slash(a ?? '').toLowerCase() === slash(b ?? '').toLowerCase();

check('the binary on PATH is the command the run is spawned with',
      same(found.issue.native[0]?.command, plantedClaude),
      String(found.issue.native[0]?.command));
check('one backend name configures the issue agent', found.issue.native.length === 1,
      JSON.stringify(found.issue.native));
check('and the implement agent with it, from the same word',
      found.implement.native.length === 1 && found.implement.native[0]?.backend === 'claude-code',
      JSON.stringify(found.implement.native));
check('the distro half stays bare however the host resolved it',
      found.issue.wsl[0]?.command === 'claude' && found.implement.wsl[0]?.command === 'claude',
      JSON.stringify([found.issue.wsl[0]?.command, found.implement.wsl[0]?.command]));

const unfound = withEnvironment(
  { EXCALIDRAW_AGENT_BACKEND: 'codex-cli', PATH: join(workDir, 'empty'), Path: join(workDir, 'empty') },
  () => agentGrantsFromEnv('implement')
);
// Falling back to the bare name is deliberate: the spawn's own "not found" names the binary,
// and an invented absolute path would name a file that was never there.
check('a binary that is not on PATH falls back to the bare name',
      unfound.native[0]?.command === 'codex', String(unfound.native[0]?.command));

const nothing = withEnvironment({ PATH: binDir, Path: binDir }, () => agentGrantsFromEnv('issue'));
check('a board that names neither a backend nor a command grants nothing',
      nothing.native.length === 0 && nothing.wsl.length === 0, JSON.stringify(nothing));

const perDistro = withEnvironment(
  { EXCALIDRAW_AGENT_BACKEND: 'claude-code', EXCALIDRAW_AGENT_BACKEND_WSL: 'codex-cli' },
  () => agentGrantsFromEnv('issue')
);
check('a distro that runs a different agent says so in one variable',
      perDistro.native[0]?.backend === 'claude-code' && perDistro.wsl[0]?.backend === 'codex-cli',
      JSON.stringify([perDistro.native[0]?.backend, perDistro.wsl[0]?.backend]));

// ─── 3. a project picks among what the operator enabled ───────

console.log('\n3. a project may name a backend the operator enabled, and no other');

const bothEnabled = ['claude-code', 'codex-cli'];
const onlyClaude = ['claude-code'];
const underClaude = { issue: 'claude-code', implement: 'claude-code' };

const refusedBackend = validateWorkspaceConfigPatch(
  { agents: { issue: { backend: 'codex-cli' } } }, underClaude, onlyClaude
);
check('a backend the operator did not enable is refused', refusedBackend.ok === false,
      '(accepted)');
check('and the refusal names the backend that was asked for',
      String(refusedBackend.error ?? '').includes('codex-cli'), String(refusedBackend.error));
check('and says which one the operator did enable',
      String(refusedBackend.error ?? '').includes('claude-code'), String(refusedBackend.error));

const allowedBackend = validateWorkspaceConfigPatch(
  { agents: { issue: { backend: 'codex-cli' } } }, underClaude, bothEnabled
);
check('one the operator did enable is accepted', allowedBackend.ok === true,
      allowedBackend.ok ? '' : String(allowedBackend.error));

const nonsenseBackend = validateWorkspaceConfigPatch(
  { agents: { implement: { backend: 'agent-9000' } } }, underClaude, bothEnabled
);
check('a name no backend has is refused, naming it',
      nonsenseBackend.ok === false && String(nonsenseBackend.error ?? '').includes('agent-9000'),
      nonsenseBackend.ok ? '(accepted)' : String(nonsenseBackend.error));

const wrongType = validateWorkspaceConfigPatch(
  { agents: { issue: { backend: 7 } } }, underClaude, bothEnabled
);
check('a backend that is not text at all is refused', wrongType.ok === false, '(accepted)');

const clearBackend = validateWorkspaceConfigPatch(
  { agents: { issue: { backend: null } } }, underClaude, bothEnabled
);
check('and null clears it back to the board\'s own', clearBackend.ok === true,
      clearBackend.ok ? '' : String(clearBackend.error));

// A command is the thing a project may never supply, and that has not moved: a `backend` key
// is a choice among what was granted, which is not the same door.
const command = validateWorkspaceConfigPatch(
  { agents: { implement: { command: 'node evil.mjs' } } }, underClaude, bothEnabled
);
check('a project still cannot supply a command of its own',
      command.ok === false && String(command.error ?? '').includes('command'),
      command.ok ? '(accepted)' : String(command.error));

// The effort is the backend's own vocabulary, so the level has to be judged against the
// backend the project just picked rather than against the board's.
const pickedEffort = validateWorkspaceConfigPatch(
  { agents: { issue: { backend: 'codex-cli', effort: 'minimal' } } }, underClaude, bothEnabled
);
check('an effort is judged against the backend the project picked', pickedEffort.ok === true,
      pickedEffort.ok ? '' : String(pickedEffort.error));
const pickedRefusal = validateWorkspaceConfigPatch(
  { agents: { issue: { backend: 'claude-code', effort: 'minimal' } } },
  { issue: 'codex-cli', implement: 'codex-cli' }, bothEnabled
);
check('and refused by it, not by the board\'s own',
      pickedRefusal.ok === false && String(pickedRefusal.error ?? '').includes('claude-code'),
      pickedRefusal.ok ? '(accepted)' : String(pickedRefusal.error));

// The read path is lenient by design — one bad field must not empty the tab strip — so what is
// asserted is which value survives the load.
function makeProject(id, config) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}

const pickerDir = makeProject('picker', {
  name: 'Picker',
  agents: { issue: { backend: 'codex-cli' }, implement: {} },
});
const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'picker', path: slash(pickerDir) }],
}, null, 2), 'utf8');

const loadedWith = async (choices) => {
  const workspaces = await loadWorkspaces(registryPath, underClaude, choices);
  return workspaces.find((workspace) => workspace.id === 'picker');
};

const kept = await loadedWith(bothEnabled);
check('a picked backend the operator enabled survives the load',
      kept?.agents?.issue?.backend === 'codex-cli', String(kept?.agents?.issue?.backend));
const dropped = await loadedWith(onlyClaude);
check('and one the operator did not is dropped rather than run',
      dropped?.agents?.issue?.backend === null, String(dropped?.agents?.issue?.backend));
check('a project that picks nothing runs the board\'s own',
      kept?.agents?.implement?.backend === null, String(kept?.agents?.implement?.backend));

const twoGranted = agentGrants({ backends: ['claude-code', 'codex-cli'] });
check('the operator\'s first name is what a project that picks nothing runs',
      agentSpecFor('native', twoGranted, null)?.backend === 'claude-code',
      JSON.stringify(agentSpecFor('native', twoGranted, null)));
check('and a project that picked the second one runs that',
      agentSpecFor('native', twoGranted, 'codex-cli')?.command === 'codex',
      JSON.stringify(agentSpecFor('native', twoGranted, 'codex-cli')));

const enabledHere = withEnvironment(
  { EXCALIDRAW_AGENT_BACKEND: 'claude-code,codex-cli' }, () => enabledAgentBackends('native')
);
check('the operator enables a set, in one variable',
      [...enabledHere].join(',') === 'claude-code,codex-cli', [...enabledHere].join(','));
const enabledLegacy = withEnvironment(
  { EXCALIDRAW_ISSUE_AGENT: 'claude -p' }, () => enabledAgentBackends('native')
);
check('a board configured the old way has enabled the passthrough and nothing else',
      [...enabledLegacy].join(',') === 'raw', [...enabledLegacy].join(','));

// ─── 4. the legacy four spawn byte for byte ───────────────────

console.log('\n4. a board configured with the four command variables is unmoved');

const LEGACY = 'node "C:/stub/agent.mjs" -p --output-format stream-json --verbose';
const LEGACY_WSL = 'source ~/.nvm/nvm.sh && claude -p --output-format stream-json';

const legacy = withEnvironment({
  EXCALIDRAW_ISSUE_AGENT: LEGACY,
  EXCALIDRAW_ISSUE_AGENT_WSL: LEGACY_WSL,
}, () => agentGrantsFromEnv('issue'));

check('a command line with no backend named is the passthrough',
      legacy.native[0]?.backend === 'raw' && legacy.wsl[0]?.backend === 'raw',
      JSON.stringify([legacy.native[0]?.backend, legacy.wsl[0]?.backend]));
check('and it is kept exactly as it was written', legacy.native[0]?.command === LEGACY,
      String(legacy.native[0]?.command));
check('the distro half too, shell operators and all', legacy.wsl[0]?.command === LEGACY_WSL,
      String(legacy.wsl[0]?.command));

const legacyRun = agentRunFor(legacy.native[0], 'implement', null);
check('the run is the operator\'s own line, byte for byte',
      legacyRun.invocation.line === LEGACY, legacyRun.invocation.line);
check('with nothing appended to it by the posture', legacyRun.invocation.line === LEGACY,
      legacyRun.invocation.line);
check('a distro run is the operator\'s line, unquoted and unparsed',
      distroLine(agentRunFor(legacy.wsl[0], 'implement', null).invocation) === LEGACY_WSL,
      distroLine(agentRunFor(legacy.wsl[0], 'implement', null).invocation));

const legacyCommands = agentCommandsOf(legacy);
check('the board still holds one command per environment',
      legacyCommands.native?.command === LEGACY && legacyCommands.wsl?.command === LEGACY_WSL,
      JSON.stringify(legacyCommands));

const nativeOnly = withEnvironment(
  { EXCALIDRAW_IMPLEMENT_AGENT: LEGACY }, () => agentGrantsFromEnv('implement')
);
check('a board with no _WSL command has none, and falls back the one way it always did',
      nativeOnly.wsl.length === 0
      && agentSpecFor('wsl', nativeOnly, null)?.command === LEGACY,
      JSON.stringify(nativeOnly.wsl));

// A backend named *and* a command written is the override the pair is for: the operator's
// binary, the backend's flags.
const overridden = withEnvironment({
  EXCALIDRAW_AGENT_BACKEND: 'claude-code',
  // Quoted, because a path with a space in it is quoted everywhere else this repository spells
  // one: `tokenizeCommand` keeps a quoted run together and splits on whitespace otherwise.
  EXCALIDRAW_IMPLEMENT_AGENT: '"C:/Program Files/claude/claude.exe" --add-dir C:/scratch',
}, () => agentGrantsFromEnv('implement'));
const overriddenRun = agentRunFor(overridden.native[0], 'implement', null);
check('a command written beside a backend name is where the binary comes from',
      overriddenRun.invocation.command === 'C:/Program Files/claude/claude.exe',
      String(overriddenRun.invocation.command));
check('and the operator\'s own arguments survive the backend writing its flags',
      overriddenRun.invocation.args.includes('--add-dir')
      && overriddenRun.invocation.args.includes('--print'),
      overriddenRun.invocation.args.join(' '));

// ─── 5. anything pinned on top reaches the argv ───────────────

console.log('\n5. an extra argument the operator pinned is on every run');

const pinned = withEnvironment({
  EXCALIDRAW_AGENT_BACKEND: 'claude-code',
  EXCALIDRAW_AGENT_ARGS: '--add-dir "C:/two words"',
}, () => agentGrantsFromEnv('implement'));
const pinnedRun = agentRunFor(pinned.native[0], 'implement', null);
check('a pinned argument is the last word on the line',
      pinnedRun.invocation.args.slice(-2).join('|') === '--add-dir|C:/two words',
      pinnedRun.invocation.args.join(' | '));

const smuggled = withEnvironment({
  EXCALIDRAW_AGENT_BACKEND: 'claude-code',
  EXCALIDRAW_AGENT_ARGS: '--dangerously-skip-permissions',
}, () => agentGrantsFromEnv('issue'));
check('and a full-access flag pinned there never reaches the research agent',
      !agentRunFor(smuggled.native[0], 'issue', null).invocation.args
        .includes('--dangerously-skip-permissions'),
      agentRunFor(smuggled.native[0], 'issue', null).invocation.args.join(' '));
const smuggledCodex = withEnvironment({
  EXCALIDRAW_AGENT_BACKEND: 'codex-cli',
  EXCALIDRAW_AGENT_ARGS: '--yolo',
}, () => agentGrantsFromEnv('issue'));
check('whichever backend spells it',
      !agentRunFor(smuggledCodex.native[0], 'issue', null).invocation.args.includes('--yolo'),
      agentRunFor(smuggledCodex.native[0], 'issue', null).invocation.args.join(' '));

// ─── 6. the board itself reads the variable ───────────────────

console.log('\n6. a board started with a backend name and nothing else has both agents');

const started = [];

async function healthOf(port, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return null;
}

async function canvasWith(extraEnv) {
  const port = await freePort();
  const server = startCanvas({ port, env: extraEnv });
  started.push(server);
  return healthOf(port);
}

try {
  const health = await canvasWith({ EXCALIDRAW_AGENT_BACKEND: 'claude-code' });
  check('the board answers /health', health !== null, 'it never came up');
  check('the issue agent is configured, from the backend name alone',
        health?.agents?.issue?.configured === true, JSON.stringify(health?.agents?.issue));
  check('and the implement agent with it',
        health?.agents?.implement?.configured === true, JSON.stringify(health?.agents?.implement));
  check('and the board says which agent it is running',
        health?.agents?.issue?.environments?.native?.backend === 'claude',
        JSON.stringify(health?.agents?.issue?.environments?.native));

  const bare = await canvasWith({});
  check('a board that names nothing still has no agent at all',
        bare?.agents?.issue?.configured === false && bare?.agents?.implement?.configured === false,
        JSON.stringify(bare?.agents));
} finally {
  for (const server of started) server.stop();
  // Let the kills land before this process starts tearing itself down: a `child.kill()` whose
  // pipes are still being drained at exit aborts libuv on Windows, and an abort is a nonzero
  // exit for a run in which every case passed.
  await sleep(250);
}

// ─── done ─────────────────────────────────────────────────────

// Best effort: Windows holds a handle on a directory a process has just left, and a check that
// failed its cleanup would be reporting on the file system rather than on the board.
try { rmSync(workDir, { recursive: true, force: true }); } catch { /* it is a temp directory */ }

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
