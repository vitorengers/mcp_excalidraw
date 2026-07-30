#!/usr/bin/env node
/**
 * Checks which command an agent run uses, when the workspace lives in WSL.
 *
 * `EXCALIDRAW_ISSUE_AGENT` and `EXCALIDRAW_IMPLEMENT_AGENT` were one global command for
 * every workspace, and `buildAgentCommand` decided only *where* to run it. A command is not
 * portable across that boundary: `C:/Users/x/.local/bin/claude.exe` cannot resolve inside a
 * distro, and `/home/x/.local/bin/claude` cannot resolve outside one. A WSL workspace
 * therefore answered `Agent exited with code 127: bash: line 1: C:/…/claude.exe: No such
 * file or directory` on every run, and could never open an issue.
 *
 * `EXCALIDRAW_ISSUE_AGENT_WSL` and `EXCALIDRAW_IMPLEMENT_AGENT_WSL` are what the operator
 * grants for that environment. A config file still cannot supply a command — that property
 * is argued at `workspaces.ts:30-34` and nothing here touches it.
 *
 * Four sections:
 *
 * 1. **Which command a workspace resolves to.** The whole of the fix, and pure, so it runs
 *    everywhere. The fallback is a case in its own right: a global command written without
 *    an absolute path resolves in both environments and must keep working.
 * 2. **The two agents stay independent.** The reason there are two variables rather than one
 *    is that enabling research must not enable repository writes; a `_WSL` pair that crossed
 *    over would undo that quietly.
 * 3. **A command that is not there says so in words the reader can act on.** `bash: line 1:
 *    …: No such file or directory` names a file the reader can see in Explorer, which points
 *    at the wrong machine entirely.
 * 4. **A real run, in a real distro.** Behavioural, needs `wsl.exe`, and skipped loudly where
 *    there is none — the structural cases above are what hold the line on a CI box.
 *
 * Self-contained: no server, no GitHub, no temporary files.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-wsl-agent-command.mjs
 *
 * Tier: wsl
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let skipped = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function skip(name, why) {
  skipped++;
  console.log(`  skip  ${name} — ${why}`);
}

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const agentModule = await importDist(join('core', 'issue-agent.js'), 'the command builder');
const { agentCommandFor, commandNotFoundHint, runAgent } = agentModule;

/**
 * Resolve through whatever the build exports, or record the seam as missing.
 *
 * Deliberately not an early exit. Against the code this was written for there is no
 * resolver at all, and a check that stopped at the first missing export would report one
 * failure where the behavioural case below — a real distro answering with a Windows path —
 * is the one that shows what the reader actually sees.
 */
const resolve = typeof agentCommandFor === 'function'
  ? agentCommandFor
  : () => '<no resolver: issue-agent exports no agentCommandFor>';

const NATIVE = { id: 'native-check', environment: { kind: 'native' }, innerPath: '/p', path: '/p' };
const WSL = { id: 'wsl-check', environment: { kind: 'wsl', distro: 'Some-Distro' }, innerPath: '/p', path: '/p' };

console.log('1. which command a workspace resolves to');
{
  check('a workspace can be asked which command is its own',
        typeof agentCommandFor === 'function',
        'without this seam every workspace runs the one global command, whatever environment it is in');

  const both = { native: 'win-claude -p', wsl: 'linux-claude -p' };

  check('a WSL workspace takes the WSL command',
        resolve(WSL, both) === 'linux-claude -p',
        `resolved ${JSON.stringify(resolve(WSL, both))}`);

  check('a native workspace takes the native command, with a WSL one set',
        resolve(NATIVE, both) === 'win-claude -p',
        `resolved ${JSON.stringify(resolve(NATIVE, both))}`);

  // The fallback, and it is deliberate: `claude -p …` with no absolute path resolves in
  // both environments, and refusing it to fix the absolute-path case would break a setup
  // that works today.
  check('a WSL workspace falls back to the global command when no WSL one is set',
        resolve(WSL, { native: 'claude -p', wsl: null }) === 'claude -p',
        `resolved ${JSON.stringify(resolve(WSL, { native: 'claude -p', wsl: null }))}`);

  check('a native workspace does not fall back to the WSL command',
        resolve(NATIVE, { native: null, wsl: 'linux-claude -p' }) === null,
        'a command granted for the distro must not run on the host');

  check('neither set means no command at all',
        resolve(WSL, { native: null, wsl: null }) === null);

  check('an empty string is not a command',
        resolve(WSL, { native: 'claude -p', wsl: '   ' }) === 'claude -p',
        'a blank variable is how an operator turns something off, not how they set it');
}

console.log('\n2. the two agents stay independent');
{
  // Whatever reads these must read them per agent. One pair leaking into the other would
  // mean enabling research enables repository writes, which is the whole reason the two
  // existing variables are separate.
  const issue = { native: null, wsl: 'linux-claude -p --allowedTools "Bash(gh:*)"' };
  const implement = { native: null, wsl: null };

  check('a WSL board with only an issue command cannot implement',
        resolve(WSL, implement) === null);
  check('and can still research',
        resolve(WSL, issue) === issue.wsl);
}

console.log('\n3. a command that is not there says which environment it was not there in');
{
  if (typeof commandNotFoundHint !== 'function') {
    check('issue-agent exports commandNotFoundHint', false,
          'exit 127 from a distro reports a Windows path and nothing about the distro');
  } else {
    const hint = commandNotFoundHint(WSL, 'C:/Users/x/.local/bin/claude.exe -p', 'EXCALIDRAW_ISSUE_AGENT_WSL');

    check('it names the distro the command was not found in',
          typeof hint === 'string' && hint.includes('Some-Distro'),
          `hint was ${JSON.stringify(hint)}`);
    check('it names the variable that overrides it',
          typeof hint === 'string' && hint.includes('EXCALIDRAW_ISSUE_AGENT_WSL'),
          `hint was ${JSON.stringify(hint)}`);
    check('it says the command is missing inside the distro, not on the host',
          typeof hint === 'string' && /inside/i.test(hint),
          `hint was ${JSON.stringify(hint)}`);
    check('a native workspace gets no such hint',
          commandNotFoundHint(NATIVE, 'claude -p', 'EXCALIDRAW_ISSUE_AGENT_WSL') === null,
          'there is no distro to name');
  }
}

console.log('\n4. a real run in a real distro reports it');
{
  const distro = (() => {
    const result = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' });
    if (result.error || result.status !== 0 || !result.stdout) return null;
    const raw = result.stdout;
    const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8');
    return text.split(/\r?\n/).map((line) => line.replace(/\0/g, '').trim()).filter(Boolean)[0] || null;
  })();

  if (!distro) {
    skip('a Windows path run inside a distro is reported as missing there',
         'no usable wsl.exe on this machine');
  } else if (typeof runAgent !== 'function') {
    check('issue-agent exports runAgent', false);
  } else {
    const workspace = {
      id: 'wsl-run-check',
      environment: { kind: 'wsl', distro },
      innerPath: '/',
      path: '/',
      agents: { issue: { model: null, effort: null, timeoutMs: null } },
    };
    // A path that cannot exist in either environment, so nothing installed can make this pass.
    const run = await runAgent(workspace, 'ignored', {
      agentCommand: 'C:/farol-not-a-real-binary/claude.exe -p',
      expects: 'issues',
      what: 'the WSL agent command check',
      timeoutMs: 30_000,
      notFoundVariable: 'EXCALIDRAW_ISSUE_AGENT_WSL',
    });

    check('the run fails', run.ok === false);
    check('the error names the distro', typeof run.error === 'string' && run.error.includes(distro),
          `error was ${JSON.stringify(run.error)}`);
    check('the error names the variable to set',
          typeof run.error === 'string' && run.error.includes('EXCALIDRAW_ISSUE_AGENT_WSL'),
          `error was ${JSON.stringify(run.error)}`);
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log(skipped ? `\nall cases passed (${skipped} skipped)` : '\nall cases passed');
