#!/usr/bin/env node
/**
 * Checks that `install-skill` expands a leading `~` however the user spelled the separator.
 *
 * `expandHome` in src/cli/commands/install-skill.ts tested `input.startsWith(`~${path.sep}`)`.
 * That reads as a portability precaution and is the opposite of one: it makes the rule depend
 * on the host, so exactly one spelling works per platform. On Windows `path.sep` is `\`, so
 * `--dir ~/skills` — the spelling every doc example and every muscle memory produces — did not
 * match, fell through to `path.resolve`, and created a directory literally named `~` under the
 * current working directory with the skill inside it. On macOS and Linux the same line is
 * correct for `~/` and wrong for `~\`, so the defect hides on the two platforms where `~` is
 * used most and fires on the one where it is least expected.
 *
 * A `~` at the front of a path is a shell convention, not a filesystem one, and it is written
 * `~/` everywhere it is written down — including in this repository's own docs. So the fix is
 * not to swap one separator for the other but to stop asking the platform: `/^~[\\/]/` accepts
 * both, and `path.join` spells the result with the host's separator as it always did.
 *
 * Because the answer no longer depends on `process.platform`, this check does not simulate one.
 * It asserts both spellings on whatever host it runs on, which is the stronger statement and
 * the one that fails on any platform where the rule has become conditional again: before the
 * fix, `~/` was red here on Windows and `~\` red on POSIX, so the file is red on all three.
 *
 * `~foo` — the POSIX other-user form, and a legal relative filename — must be left alone, which
 * the anchored regex gives for free but nothing else asserts.
 *
 * Section 4 is the done-when as the user meets it: the real CLI, spawned with `HOME` and
 * `USERPROFILE` pointed at a throwaway home so nothing lands in the real one, asked to install
 * into `~/skills` from a working directory this check owns — and then that working directory is
 * read back for the stray `~` the defect created there.
 *
 * Offline and self-contained: a throwaway home, the built module and the built CLI. No server,
 * no browser, no network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-install-skill-home.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'vibemaxxing-canvas';

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

const workDir = join(tmpdir(), `install-skill-home-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const commandModule = await importDist(join('cli', 'commands', 'install-skill.js'), 'the install-skill command');

try {
  if (!commandModule) throw new Error('nothing to drive');

  // ─── 1. The seam the check needs ────────────────────────────

  console.log('1. expandHome is reachable');

  const { expandHome } = commandModule;
  check('expandHome is exported', typeof expandHome === 'function',
        'it was module-private, so the rule could only be asserted through a whole install');

  const home = homedir();

  // ─── 2. Both spellings expand, on this platform ─────────────

  console.log('\n2. a leading ~ expands whichever separator follows it');

  // Sections 2 and 3 need the seam; section 4 does not, and it is the one that shows the
  // defect as the user meets it — so a missing export must not take the rest of the file
  // down with it.
  if (typeof expandHome !== 'function') {
    console.log('  skip  no exported expandHome to drive — sections 2 and 3 cannot run');
  } else {
    for (const spelling of ['~/skills', '~\\skills']) {
      check(`${spelling} → the home directory's skills`, expandHome(spelling) === join(home, 'skills'),
            `${expandHome(spelling)} — expected ${join(home, 'skills')}`);
    }

    check('~/.claude/skills lands under the home directory',
          expandHome('~/.claude/skills') === join(home, '.claude', 'skills'),
          expandHome('~/.claude/skills'));
    check('~\\.claude\\skills does too',
          expandHome('~\\.claude\\skills').startsWith(home + sep),
          expandHome('~\\.claude\\skills'));
    check('nothing in the answer is still a literal ~',
          !expandHome('~/skills').includes('~') && !expandHome('~\\skills').includes('~'),
          'the old code returned the input untouched, and path.resolve then made a directory of it');

    // ─── 3. What must not be touched ──────────────────────────

    console.log('\n3. a ~ that is not a home reference is left where it is');

    check('~ on its own is still the home directory', expandHome('~') === home, expandHome('~'));
    for (const input of ['~foo', '~foo/bar', '~foo\\bar', 'skills', './skills', 'a~/b']) {
      check(`${input} is returned unchanged`, expandHome(input) === input, expandHome(input));
    }
  }

  // ─── 4. The CLI, as the user runs it ────────────────────────

  console.log('\n4. install-skill --dir ~/skills installs into the home directory, not into a folder named ~');

  const bin = join(repoRoot, 'dist', 'bin.js');
  if (!existsSync(bin)) {
    failures++;
    console.error('  FAIL  the CLI is built — dist/bin.js not found');
  } else {
    /** One run of the real CLI, in a home and a working directory nobody else is using. */
    function install(label, flag, spec) {
      const fakeHome = join(workDir, label, 'home');
      const cwd = join(workDir, label, 'cwd');
      mkdirSync(fakeHome, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      const run = spawnSync(process.execPath, [bin, 'install-skill', flag, spec], {
        cwd,
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
        encoding: 'utf8'
      });
      let json;
      try { json = JSON.parse(run.stdout); } catch { /* reported as a failed case below */ }
      return { fakeHome, cwd, run, json };
    }

    for (const [flag, spec] of [['--dir', '~/skills'], ['--dir', '~\\skills'], ['--target', '~/skills']]) {
      const label = `${flag.slice(2)}-${spec.includes('/') ? 'slash' : 'backslash'}`;
      console.log(`\n   ${flag} ${spec}`);
      const { fakeHome, cwd, run, json } = install(label, flag, spec);
      const expected = join(fakeHome, 'skills');
      check('the CLI exited 0', run.status === 0, `${run.status} — ${(run.stderr || '').trim()}`);
      check('it reports a root under the home directory', json?.root === expected,
            `${json?.root} — expected ${expected}`);
      check('the skill is really there',
            existsSync(join(expected, SKILL_NAME, 'SKILL.md')),
            `${join(expected, SKILL_NAME, 'SKILL.md')} does not exist`);
      const strays = existsSync(cwd) ? readdirSync(cwd) : [];
      check('the working directory gained nothing', strays.length === 0,
            `it holds ${strays.map((entry) => `"${entry}"`).join(', ')} — a literal ~ here is the defect`);
    }
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
