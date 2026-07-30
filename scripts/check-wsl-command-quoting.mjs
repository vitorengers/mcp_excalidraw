#!/usr/bin/env node
/**
 * Checks that a WSL workspace's command reaches its process the way it was written.
 *
 * `wsl.exe <command>` runs that command **through the distro's default shell**. So a
 * command spawned as `wsl.exe -d <distro> --cd <path> -- bash -lc "<command>"` is parsed
 * by a shell twice: once by the default shell wsl.exe puts in front of it, and once by the
 * `bash -lc` that was asked for. Quoting survives that, which is what made this hard to
 * see — the argument count is right and every argument looks intact — but the outer shell
 * has already expanded every `$name` inside the quotes, single quotes included, because by
 * the time the inner shell sees the string the variable is gone rather than quoted.
 *
 * It broke one feature outright: the project board read sends a *parameterised* GraphQL
 * query, so its `$login`, `$number` and `$field` were replaced with nothing and GitHub
 * answered `Expected VAR_SIGN, actual: COLON (":") at [1, 7]` on every poll. A WSL
 * workspace could therefore never draw its mirror. Nothing about that was specific to the
 * query: every `gh` call and every agent run in a WSL workspace goes through
 * `buildAgentCommand`, and a `$` anywhere in any of them was being eaten the same way.
 *
 * `--exec` runs the binary directly with no shell in front of it, which is the fix and is
 * what case 1 is about.
 *
 * Two cases, and the second one matters as much as the first:
 *
 * 1. **A WSL command keeps its `$`.** Behavioural, and it needs a real `wsl.exe`, so it is
 *    skipped where there is none — a Linux CI box, say. It is the case this check exists
 *    for, so a skip says so loudly rather than passing quietly.
 * 2. **A native workspace is untouched, byte for byte.** No shell is involved there at all;
 *    the command is tokenised and spawned directly. A fix aimed at WSL must not reach it.
 *
 * Case 3 is the structural half of case 1, asserted everywhere including where wsl.exe is
 * missing: the invocation must not hand the command to a shell before `bash` gets it. A
 * check whose only real assertion skips on the machine that runs CI is a check that stops
 * being run.
 *
 * Self-contained: no server, no GitHub, no temporary files. The command under test is
 * `printf`, which every distro has, and the `$name` it is asked to print is the whole
 * point — the string is written the way `readProjectBoard` writes its query, single-quoted
 * with variables inside it.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-wsl-command-quoting.mjs
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

const { buildAgentCommand } = await importDist(join('core', 'issue-agent.js'), 'the command builder');

/**
 * The string under test, written the way `readProjectBoard` writes its query: one line,
 * single-quoted, with variables inside it. `$farol_not_a_variable` is chosen so that an
 * environment that happens to define it cannot make a broken build pass.
 */
const QUOTED = "'q($farol_not_a_variable: String!) { x }'";
const EXPECTED = 'q($farol_not_a_variable: String!) { x }';

/**
 * The distro to test against, asked for rather than hardcoded: this check has to run on
 * whichever machine it is run on. `wsl.exe -l -q` answers in UTF-16LE on Windows.
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

console.log('1. a WSL command reaches its process with its variables intact');
if (!distro) {
  skip('a single-quoted $name survives the hop into WSL', 'no usable wsl.exe on this machine');
} else {
  const workspace = {
    id: 'quoting-check',
    environment: { kind: 'wsl', distro },
    innerPath: '/',
    path: '/',
  };
  const { command, args } = buildAgentCommand(workspace, `printf '%s' ${QUOTED}`);
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const received = (result.stdout ?? '').trim();

  check('a single-quoted $name survives the hop into WSL',
        received === EXPECTED,
        `expected ${JSON.stringify(EXPECTED)}, received ${JSON.stringify(received)}`);
}

console.log('\n2. a native workspace is spawned exactly as it was before');
{
  const workspace = {
    id: 'quoting-check-native',
    environment: { kind: 'native' },
    innerPath: '/tmp/project',
    path: '/tmp/project',
  };
  const built = buildAgentCommand(workspace, `printf '%s' ${QUOTED}`);

  check('no shell is introduced', built.command === 'printf',
        `command was ${JSON.stringify(built.command)}`);
  check('the argument arrives whole, with its quotes already removed',
        built.args.length === 2 && built.args[1] === EXPECTED,
        `args were ${JSON.stringify(built.args)}`);
  check('it still runs in the project directory', built.cwd === '/tmp/project');
}

console.log('\n3. nothing parses a WSL command before bash does');
{
  const workspace = {
    id: 'quoting-check-shape',
    environment: { kind: 'wsl', distro: 'Some-Distro' },
    innerPath: '/home/me/project',
    path: '/home/me/project',
  };
  const { command, args } = buildAgentCommand(workspace, 'printf hi');

  check('wsl.exe is what is spawned', command === 'wsl.exe');
  check('the command is exec-ed rather than handed to the default shell',
        args.includes('--exec') && !args.includes('--'),
        `args were ${JSON.stringify(args)}`);
  check('bash is still the shell that parses it',
        args.slice(-3, -1).join(' ') === 'bash -lc',
        `args were ${JSON.stringify(args)}`);
  check('the command itself is one argument, unchanged',
        args[args.length - 1] === 'printf hi');
  check('the workspace directory is still where it runs',
        args.includes('--cd') && args[args.indexOf('--cd') + 1] === '/home/me/project');
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log(skipped ? `\nall cases passed (${skipped} skipped)` : '\nall cases passed');
