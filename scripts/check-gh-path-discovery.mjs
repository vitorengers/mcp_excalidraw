#!/usr/bin/env node
/**
 * Checks that `gh` is found on macOS and Linux the way it is already found on Windows.
 *
 * Every `gh` this server spawns runs with `env: { ...process.env, PATH: agentPath() }` —
 * `src/core/gh.ts` for the project board, and `src/core/github-issue.ts` for the issue read,
 * two independent spawns that must keep sharing one answer. `agentPath()` appended the two
 * Windows GitHub CLI directories and returned the inherited PATH untouched everywhere else.
 * That is correct as long as the server is started from a shell, where a brew- or
 * apt-installed `gh` is already on PATH. It stops being correct the moment the release ships
 * a double-clickable launcher: a process started from Finder or from a desktop entry inherits
 * a minimal PATH holding neither `/opt/homebrew/bin` nor `/usr/local/bin`, and every `gh` call
 * fails with ENOENT — a blank mirror, on the platform's primary launch path.
 *
 * So this plants a `gh` in each conventional location in turn, hands the function a PATH that
 * cannot resolve one, and asserts the PATH it gets back *does* — resolved with the same lookup
 * the terminal uses, rather than by looking for a substring, because what the caller needs is
 * a runnable binary and not a directory name that reads well.
 *
 * A check written on Windows cannot exercise the real case, which is why every directory here
 * is planted under a throwaway root and the platform is stated rather than inherited. The
 * complementary file is `scripts/check-agent-path.mjs`: that one asserts the shape of the
 * repair, this one asserts that the repair finds the binary it exists for.
 *
 * Offline and self-contained: no server, no browser, no network, and no `gh` of this
 * machine's is consulted. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-gh-path-discovery.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative, what) {
  const full = join(repoRoot, 'dist', relative);
  if (!existsSync(full)) {
    failures++;
    console.error(`  FAIL  ${what} is built — dist/${relative.replace(/\\/g, '/')} not found`);
    return null;
  }
  return import(pathToFileURL(full).href);
}

const workDir = join(tmpdir(), `gh-path-discovery-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** The POSIX home this check invents, so no case depends on where the host keeps its own. */
const HOME = '/home/checker';

/** The launchd minimum: four directories that exist and hold nothing anyone needs. */
const MINIMAL = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

const under = (root, candidate) => join(root, candidate.replace(/^[A-Za-z]:/, ''));

function plant(name, directories, executables) {
  const root = join(workDir, name);
  for (const directory of directories) mkdirSync(under(root, directory), { recursive: true });
  for (const file of executables) {
    const full = under(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '#!/bin/sh\nexit 0\n', 'utf8');
  }
  return root;
}

const agentModule = await importDist(join('core', 'issue-agent.js'), 'the issue agent');

try {
  if (!agentModule) throw new Error('nothing to drive');
  const { agentPath, resolveExecutable } = agentModule;

  check('agentPath is exported', typeof agentPath === 'function');
  check('the executable lookup is shared rather than copied',
        typeof resolveExecutable === 'function',
        'issue-agent must export the same lookup terminal-session uses, so the guard and the '
        + 'terminal cannot disagree about what "on PATH" means');
  if (typeof agentPath !== 'function' || typeof resolveExecutable !== 'function') {
    throw new Error('nothing to drive');
  }

  // ─── 1. A planted gh is found, wherever it conventionally lives ───

  console.log('1. a gh the inherited PATH cannot reach is reachable afterwards');

  /**
   * The conventional homes, and the platform each one is a home on. `/usr/bin` is here
   * because a stripped PATH is not guaranteed to hold even that.
   */
  const LOCATIONS = [
    { platform: 'darwin', directory: '/opt/homebrew/bin', what: 'Homebrew on Apple silicon' },
    { platform: 'darwin', directory: '/usr/local/bin', what: 'Homebrew on Intel macOS' },
    { platform: 'darwin', directory: `${HOME}/.local/bin`, what: 'a per-user install' },
    { platform: 'linux', directory: '/home/linuxbrew/.linuxbrew/bin', what: 'Homebrew on Linux' },
    { platform: 'linux', directory: '/usr/local/bin', what: 'the usual /usr/local install' },
    { platform: 'linux', directory: `${HOME}/.local/bin`, what: 'a per-user install' },
  ];

  LOCATIONS.forEach(({ platform, directory, what }, index) => {
    const root = plant(`gh-${index}`, MINIMAL, [`${directory}/gh`]);
    const incoming = MINIMAL.map((one) => under(root, one)).join(delimiter);

    check(`the inherited PATH really cannot resolve gh (${platform}, ${what})`,
          resolveExecutable('gh', incoming, platform) === 'gh', 'the case would prove nothing otherwise');

    const repaired = agentPath({ platform, path: incoming, home: HOME, root });
    const resolved = resolveExecutable('gh', repaired, platform);
    check(`${directory} is found (${platform}, ${what})`,
          resolved === under(root, `${directory}/gh`),
          `resolved to ${JSON.stringify(resolved)} on ${repaired}`);
  });

  // ─── 2. And nothing is touched when there was nothing to fix ───

  console.log('\n2. a PATH that already resolves gh is returned unchanged, on every platform');

  for (const platform of ['darwin', 'linux', 'win32']) {
    const executable = platform === 'win32' ? 'gh.exe' : 'gh';
    const root = plant(`already-${platform}`, MINIMAL, [`/usr/local/bin/${executable}`]);
    const incoming = [...MINIMAL, '/usr/local/bin'].map((one) => under(root, one)).join(delimiter);
    check(`${platform} leaves it alone`,
          agentPath({ platform, path: incoming, home: HOME, root }) === incoming,
          agentPath({ platform, path: incoming, home: HOME, root }));
  }

  // ─── 3. Both gh runners still ask the same function ─────────

  console.log('\n3. the two gh spawns share the one answer');

  for (const file of ['src/core/gh.ts', 'src/core/github-issue.ts']) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    check(`${file} spawns with the repaired PATH`, /PATH:\s*agentPath\(\)/.test(source),
          'a second spawn building its own environment is how the two drift apart');
  }
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
