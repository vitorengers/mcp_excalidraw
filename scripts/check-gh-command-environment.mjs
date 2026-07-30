#!/usr/bin/env node
/**
 * Checks that `gh` is resolved for the environment the workspace lives in.
 *
 * A command is a path, and a path does not cross the WSL boundary. `agentCommandFor`
 * already knows that — it is why `EXCALIDRAW_ISSUE_AGENT_WSL` and
 * `EXCALIDRAW_IMPLEMENT_AGENT_WSL` exist — but `gh` was read once for the whole server:
 *
 *     export const GH_COMMAND = process.env.EXCALIDRAW_GH_COMMAND || 'gh';
 *
 * On a machine whose environment names the host binary, every `gh` call in a WSL workspace
 * therefore asked `bash -lc` to run `C:\Program Files\GitHub CLI\gh.exe`, and got
 * `command not found`. The board looked like a project mirror that had simply stopped
 * coming back (#252). Nothing was wrong with either install: the distro has `gh` on `PATH`,
 * and the host binary is exactly where the variable says it is.
 *
 * Five cases. The first two are behavioural and are the ones that fail on the old build:
 *
 * 1. **The project board read runs** in a WSL workspace with the host override set.
 * 2. **The issue read runs** there too. It is a second, independent call site
 *    (`github-issue.ts` built its own command line from the same constant), so a fix
 *    applied in one place and not the other passes case 1 and fails here. The issue is a
 *    repository that does not exist, so `gh` answers rather than GitHub; what is asserted
 *    is only that the failure is never the host path.
 *
 * Both need a real `wsl.exe` and skip loudly without one. Cases 3 to 5 are the resolution
 * rules and are asserted everywhere, because a check whose only real assertion skips on
 * some machines is a check that stops being run.
 *
 * Self-contained: no server, no temporary files, no GitHub account. `gh --version` and a
 * read of a repository nobody owns are the two commands it runs.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-gh-command-environment.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The host path the reported failure carried. Set before the modules load: the two
 * variables are read at import, which is what every other check that stubs `gh` relies on.
 */
const HOST_GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
process.env.EXCALIDRAW_GH_COMMAND = `"${HOST_GH}"`;
delete process.env.EXCALIDRAW_GH_COMMAND_WSL;

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

const gh = await importDist(join('core', 'gh.js'), 'the gh runner');
const { fetchIssue } = await importDist(join('core', 'github-issue.js'), 'the issue reader');

/**
 * The distro to run in, asked for rather than hardcoded: this check has to run on whichever
 * machine it is run on. `wsl.exe -l -q` answers in UTF-16LE on Windows.
 */
function defaultDistro() {
  const result = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  const raw = result.stdout;
  const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8');
  const first = text.split(/\r?\n/).map((line) => line.replace(/\0/g, '').trim()).filter(Boolean)[0];
  return first || null;
}

const distro = defaultDistro();

const wslWorkspace = (id) => ({
  id,
  environment: { kind: 'wsl', distro: distro ?? 'Some-Distro' },
  innerPath: '/',
  path: '/',
});

const nativeWorkspace = (id) => ({
  id,
  environment: { kind: 'native' },
  innerPath: '/tmp/project',
  path: '/tmp/project',
});

/** What the defect looks like from the outside, whichever call site produced it. */
const namesTheHostPath = (message) => /gh\.exe/i.test(message) || /Program Files/i.test(message);

console.log('1. the project board read runs inside a WSL workspace');
if (!distro) {
  skip('a gh call in a WSL workspace does not look for the host binary',
       'no usable wsl.exe on this machine');
} else {
  let failure = '';
  try {
    // `--version` rather than the real query: no network, no account, and a distro that has
    // `gh` at all answers it. What is under test is which binary bash was asked to run.
    await gh.runGh(wslWorkspace('gh-env-board'), '--version', {
      what: 'the project board read', attempts: 1, timeoutMs: 30_000,
    });
  } catch (error) {
    failure = error.message;
  }

  check('bash is not asked to run the host binary', !namesTheHostPath(failure),
        `gh failed with ${JSON.stringify(failure)}`);
  if (/command not found/i.test(failure) && !namesTheHostPath(failure)) {
    skip('the read succeeds', `the distro "${distro}" has no gh on PATH`);
  } else {
    check('the read succeeds', failure === '', failure);
  }
}

console.log('\n2. the issue read is resolved the same way');
if (!distro) {
  skip('the issue reader does not look for the host binary either',
       'no usable wsl.exe on this machine');
} else {
  let failure = '';
  try {
    // A repository nobody owns: `gh` itself answers, so this never depends on an issue
    // staying where it was. Any failure is fine except the one this check is about.
    await fetchIssue(
      wslWorkspace('gh-env-issue'),
      'https://github.com/vitorengers/not-a-real-repository/issues/1'
    );
  } catch (error) {
    failure = error.message;
  }

  check('bash is not asked to run the host binary', !namesTheHostPath(failure),
        `the issue read failed with ${JSON.stringify(failure)}`);
}

console.log('\n3. a WSL workspace never reads the host override');
{
  check('it falls back to the bare gh',
        gh.ghCommandFor(wslWorkspace('gh-env-fallback')) === 'gh',
        `resolved to ${JSON.stringify(gh.ghCommandFor(wslWorkspace('gh-env-fallback')))}`);
}

console.log('\n4. a native workspace still gets the override, byte for byte');
{
  check('the operator\'s value is what runs',
        gh.ghCommandFor(nativeWorkspace('gh-env-native')) === `"${HOST_GH}"`,
        `resolved to ${JSON.stringify(gh.ghCommandFor(nativeWorkspace('gh-env-native')))}`);
}

console.log('\n5. the WSL override is what a WSL workspace uses when there is one');
{
  process.env.EXCALIDRAW_GH_COMMAND_WSL = '/home/me/.local/bin/gh';
  const resolved = gh.ghCommandFor(wslWorkspace('gh-env-wsl-override'));
  delete process.env.EXCALIDRAW_GH_COMMAND_WSL;

  check('the distro\'s own path is what runs there', resolved === '/home/me/.local/bin/gh',
        `resolved to ${JSON.stringify(resolved)}`);
  check('and it does not reach a native workspace',
        gh.ghCommandFor(nativeWorkspace('gh-env-native-2')) === `"${HOST_GH}"`,
        'a command granted for the distro says nothing about what may run on the host');
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log(skipped ? `\nall cases passed (${skipped} skipped)` : '\nall cases passed');
