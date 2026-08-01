#!/usr/bin/env node
/**
 * Checks that the PATH every child of the board is handed is repaired on macOS and Linux too.
 *
 * `agentPath()` is the single PATH repair every child of this server receives — the issue
 * agent, the implement agent, both `gh` runners and every terminal session go through
 * `agentEnv()`, which is `{...process.env, PATH: agentPath()}`. It was written for one
 * machine: its guard was `/github cli/i` against the incoming PATH, which can only ever match
 * a Windows Program Files directory name, and its candidate list was two hard-coded
 * `C:/Program Files…` directories probed for `gh.exe`. On macOS and Linux the guard never
 * matched, the probe found nothing, and the function returned the inherited PATH unchanged.
 *
 * That is invisible from a shell, where a brew- or apt-installed `gh` is already on PATH, and
 * it is the whole failure from a launcher: a server started from Finder, from a `.desktop`
 * entry or from a LaunchAgent inherits launchd's minimal PATH, where `/opt/homebrew/bin`,
 * `/usr/local/bin` and `~/.local/bin` are all absent — so both `gh` and the agent binary are
 * missing, and `docs/trap-gh-path.md` describes a trap the code only fixes on one platform.
 *
 * So the cases here drive the function itself rather than a run. That is deliberate and it is
 * the only thing that can be done from here: `commandNotFoundHint()` returns null for a native
 * workspace, so the symptom in the UI is the shell's own `command not found` and says nothing
 * about PATH. The seams the function takes — the platform to answer for, the PATH to repair,
 * where `~` is, and a root the candidate directories are looked for under — are what let a
 * check on any one platform assert all three, with directories it planted itself.
 *
 * Two translations are worth stating, because they are the only places this differs from the
 * machine it is describing. The done-when's `PATH=/usr/bin:/bin:/usr/sbin:/sbin` is written
 * here with the *host's* delimiter and with the planted root in front of each entry: the
 * separator a PATH is spelled with is the host's in production too, since nothing stubs the
 * platform there, and it is the candidate list and the executable naming that the platform
 * decides. And `~` is a POSIX home this check invents rather than the one this machine has,
 * so the case reads the same on all three.
 *
 * Offline and self-contained: it plants directories under a throwaway root, imports the built
 * module and calls it. No server, no browser, no network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-path.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * A module from `dist`, or nothing.
 *
 * Nothing rather than an exit: a check that dies on its first import shows one line about
 * its own harness instead of the defect.
 */
async function importDist(relative, what) {
  const full = join(repoRoot, 'dist', relative);
  if (!existsSync(full)) {
    failures++;
    console.error(`  FAIL  ${what} is built — dist/${relative.replace(/\\/g, '/')} not found`);
    return null;
  }
  return import(pathToFileURL(full).href);
}

// ─── The throwaway machine ────────────────────────────────────

const workDir = join(tmpdir(), `agent-path-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** The POSIX home this check invents, so no case depends on where the host keeps its own. */
const HOME = '/home/checker';

/** A candidate directory as it lands under a planted root, drive letter and all. */
function under(root, candidate) {
  return join(root, candidate.replace(/^[A-Za-z]:/, ''));
}

/** A root nobody else is using, with directories and stub executables planted in it. */
function plant(name, directories, executables = []) {
  const root = join(workDir, name);
  for (const directory of directories) mkdirSync(under(root, directory), { recursive: true });
  for (const file of executables) {
    const full = under(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '#!/bin/sh\nexit 0\n', 'utf8');
  }
  return root;
}

/** The launchd minimum, as this check's root spells it. */
const MINIMAL = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const minimalPath = (root) => MINIMAL.map((directory) => under(root, directory)).join(delimiter);

const entriesOf = (value) => value.split(delimiter).filter(Boolean);
const countOf = (value, entry) => entriesOf(value).filter((one) => one === entry).length;

/**
 * A variable's value as an environment object actually holds it.
 *
 * `process.env` on Windows is a case-insensitive proxy over the process's environment block, so
 * `process.env.SystemRoot` answers whichever spelling the block stored — `SYSTEMROOT` from Git
 * Bash, `SystemRoot` from PowerShell. `agentEnv()` returns a plain object built by spreading
 * that proxy, and a spread copies every key under its *stored* spelling into an object that has
 * no such lookup. A comparison written for one shell therefore reads `undefined` in the other,
 * which is the whole of what this used to fail on: the expectation was spelled for POSIX, and
 * the variable was in the object all along.
 *
 * The match is the host's own rule rather than a blanket loosening. On win32 the environment
 * block ignores case and the child sees the variable whatever spelling it was stored under; on
 * Linux and macOS it does not, so there the key is compared exactly and a `systemroot` that is
 * not `SystemRoot` is still a dropped variable.
 */
function valueOf(env, name) {
  if (process.platform !== 'win32') return env[name];
  const key = Object.keys(env).find((one) => one.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * A PATH short enough to read in a failure.
 *
 * The interesting entries are the planted ones at the end, and against the defect this file
 * is about the answer is the whole of this machine's own PATH — forty directories nobody
 * needs to see four times over.
 */
function brief(value) {
  const entries = entriesOf(String(value ?? '')).map((entry) => entry.replace(workDir, '…'));
  return entries.length > 8
    ? `${entries.slice(0, 3).join(delimiter)}${delimiter}…${entries.length - 6} more…${delimiter}${entries.slice(-3).join(delimiter)}`
    : entries.join(delimiter);
}

const agentModule = await importDist(join('core', 'issue-agent.js'), 'the issue agent');

try {
  if (!agentModule) throw new Error('nothing to drive');
  const { agentPath, agentEnv } = agentModule;

  check('agentPath is exported', typeof agentPath === 'function');
  check('agentEnv is exported', typeof agentEnv === 'function');
  if (typeof agentPath !== 'function' || typeof agentEnv !== 'function') throw new Error('nothing to drive');

  // ─── 1. The POSIX branch repairs a stripped PATH ────────────

  console.log('1. a launchd-minimum PATH gains every candidate directory that exists');

  // Everything the conventional list names except the Linux homebrew prefix, which is left
  // out on purpose: a directory that does not exist may not be added.
  const posixRoot = plant('posix', [...MINIMAL, '/opt/homebrew/bin', '/usr/local/bin', `${HOME}/.local/bin`],
                          ['/opt/homebrew/bin/gh', `${HOME}/.local/bin/claude`]);

  for (const platform of ['darwin', 'linux']) {
    const incoming = minimalPath(posixRoot);
    const repaired = agentPath({ platform, path: incoming, home: HOME, root: posixRoot });
    console.log(`\n   ${platform}`);
    check('the PATH changed at all', repaired !== incoming,
          `${brief(repaired)} — on this platform the function used to return the inherited PATH untouched`);
    for (const candidate of ['/opt/homebrew/bin', '/usr/local/bin', `${HOME}/.local/bin`]) {
      check(`${candidate} is on it`, entriesOf(repaired).includes(under(posixRoot, candidate)),
            brief(repaired));
    }
    check('the homebrew-on-Linux prefix is not, because it does not exist',
          !repaired.includes('linuxbrew'), brief(repaired));
    check('what was already there is still there, once',
          MINIMAL.every((directory) => countOf(repaired, under(posixRoot, directory)) === 1), brief(repaired));
    check('and the inherited PATH still leads', repaired.startsWith(incoming), brief(repaired));
  }

  // ─── 2. It adds nothing twice, and nothing missing ──────────

  console.log('\n2. it never adds a directory that is present, and never one that is absent');

  // No `gh` anywhere on this one, so the early return cannot be what makes the second call
  // stable: the appending itself has to be idempotent.
  const bareRoot = plant('bare', [...MINIMAL, '/opt/homebrew/bin', '/usr/local/bin']);
  const once = agentPath({ platform: 'linux', path: minimalPath(bareRoot), home: HOME, root: bareRoot });
  const twice = agentPath({ platform: 'linux', path: once, home: HOME, root: bareRoot });
  check('a repaired PATH repairs to itself', twice === once,
        `${brief(once)}\n        → ${brief(twice)}`);
  check('every entry appears exactly once',
        entriesOf(once).length === new Set(entriesOf(once)).size, brief(once));

  const emptyRoot = plant('empty', MINIMAL);
  const nothingToAdd = minimalPath(emptyRoot);
  const stillNothing = agentPath({ platform: 'darwin', path: nothingToAdd, home: HOME, root: emptyRoot });
  check('a machine with none of the candidates gets its PATH back unchanged',
        stillNothing === nothingToAdd, brief(stillNothing));

  const alreadyRoot = plant('already', [...MINIMAL, '/opt/homebrew/bin', '/usr/local/bin']);
  const alreadyPath = [minimalPath(alreadyRoot), under(alreadyRoot, '/opt/homebrew/bin'),
                       under(alreadyRoot, '/usr/local/bin')].join(delimiter);
  const stillAlready = agentPath({ platform: 'linux', path: alreadyPath, home: HOME, root: alreadyRoot });
  check('a PATH that already lists them all is returned unchanged',
        stillAlready === alreadyPath, brief(stillAlready));

  // ─── 3. Windows is what it was ──────────────────────────────

  console.log('\n3. the Windows branch answers exactly as it did');

  const windowsRoot = plant('windows', ['C:/Windows/System32'], ['C:/Program Files/GitHub CLI/gh.exe']);
  const withCli = [under(windowsRoot, 'C:/Windows/System32'),
                   under(windowsRoot, 'C:/Program Files/GitHub CLI')].join(delimiter);
  const untouched = agentPath({ platform: 'win32', path: withCli, home: HOME, root: windowsRoot });
  check('a PATH already holding the GitHub CLI directory is returned unchanged',
        untouched === withCli, brief(untouched));

  const withoutCli = under(windowsRoot, 'C:/Windows/System32');
  const repairedWindows = agentPath({ platform: 'win32', path: withoutCli, home: HOME, root: windowsRoot });
  check('and one without it gains the directory holding gh.exe',
        entriesOf(repairedWindows).includes(under(windowsRoot, 'C:/Program Files/GitHub CLI')),
        brief(repairedWindows));
  check('one directory, and the POSIX candidates are not consulted on win32',
        entriesOf(repairedWindows).length === entriesOf(withoutCli).length + 1,
        brief(repairedWindows));

  // ─── 4. The one every child actually gets ───────────────────

  console.log('\n4. agentEnv carries the repair, on POSIX as on Windows');

  const env = agentEnv({ platform: 'linux', path: minimalPath(posixRoot), home: HOME, root: posixRoot });
  check('the PATH it hands a child is not the one the server inherited',
        env.PATH !== process.env.PATH && env.PATH !== minimalPath(posixRoot), brief(env.PATH));
  check('and it holds the planted directory', entriesOf(env.PATH ?? '').includes(under(posixRoot, '/opt/homebrew/bin')),
        brief(env.PATH));
  // Named, then filtered by what this process actually has: a variable the host never set
  // would compare `undefined` to `undefined` and pass whatever `agentEnv()` did with it.
  // `SystemRoot` exists only on Windows and `HOME` only where something POSIX-shaped put it
  // there, so a fixed pair is half vacuous on either platform. The list is long enough that
  // every host this runs on keeps at least one, and the count is asserted rather than assumed.
  const witnesses = ['SystemRoot', 'HOME', 'PATHEXT', 'USER', 'LANG']
    .filter((name) => valueOf(process.env, name) !== undefined);
  const dropped = witnesses.filter((name) => valueOf(env, name) !== valueOf(process.env, name));
  check('the rest of the environment is still the process\'s',
        witnesses.length > 0 && dropped.length === 0,
        witnesses.length === 0
          ? 'this check found none of its own process\'s variables to look for'
          : `agentEnv corrects keys, it does not filter the environment — ${dropped.join(', ')} did not survive it`);

  // Called the way every caller in `src/` calls it: with nothing at all.
  const live = agentPath();
  check('agentPath() with no arguments still answers for this machine',
        typeof live === 'string' && live.includes(process.env.PATH?.split(delimiter)[0] ?? ''),
        brief(live));
} catch (error) {
  if (String(error?.message) !== 'nothing to drive') {
    failures++;
    console.error(`  FAIL  the check itself threw — ${error?.stack ?? error}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

console.log('');
if (failures) { console.error(`${failures} case(s) failed`); process.exit(1); }
console.log('all cases passed');
