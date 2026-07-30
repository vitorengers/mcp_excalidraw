#!/usr/bin/env node
/**
 * Checks that a workspace path folds case only where the filesystem does.
 *
 * The canonical form of a path is a project's identity: `loadWorkspaces` dedupes the registry
 * on it and `addWorkspace` refuses a duplicate on it. `resolveWorkspacePath` lower-cased the
 * native form unconditionally, so on Linux `/home/me/Board` and `/home/me/board` — two real,
 * different directories — were one workspace. Registering the second answered a 409 saying
 * "Two spellings of one path are one project", which is simply false there, and a registry
 * that already held both dropped one with a `Duplicate workspace ignored` warning, its tab
 * disappearing with no visible cause. `samePath` in `implement-worktree` folded the same way,
 * and it is what matches the paths git prints in `worktree list --porcelain` against the paths
 * that module builds.
 *
 * So the rule under test is one line long and has three sides:
 *
 *  1. **win32 still folds.** Two spellings of one Windows path are one project, as before.
 *  2. **everything else does not.** Linux, and macOS with it: the default APFS volume is
 *     case-insensitive so folding is usually harmless there, but a case-sensitive one behaves
 *     exactly like Linux, and which of the two a path sits on is not knowable from the path
 *     string. A rule keyed on the filesystem is not one this can implement, so only the
 *     platform that is always case-insensitive folds.
 *  3. **`wsl:` canonical forms are untouched, on every platform.** WSL is reachable only from
 *     Windows, so its distro name and inner path stay folded whatever `process.platform` says
 *     — a deliberate exception, not an oversight.
 *
 * The platform is the input, so it cannot be the machine's: each case is evaluated in a child
 * `node` whose `process.platform` has been redefined, once per platform, against the compiled
 * modules. Nothing here depends on the host's own platform — the expressions are chosen so
 * that `path.resolve` on either implementation gives the same verdict.
 *
 * What it deliberately does not do is create `board/` and `Board/` side by side and hand them
 * to `loadWorkspaces`: a Windows filesystem cannot hold both, so that test could only ever run
 * on half the platforms it is about. The canonical string *is* what the registry dedupes on
 * (src/core/workspaces.ts) and refuses on (`addWorkspace`), so it is the surface asserted here.
 *
 * Offline and self-contained; no server, no browser. Reads the compiled modules, so run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-workspace-path-case.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pathsModule = join(repoRoot, 'dist', 'core', 'workspace-paths.js');
const worktreeModule = join(repoRoot, 'dist', 'core', 'implement-worktree.js');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * One case, evaluated on every platform.
 *
 * `win32` and `posix` are what the expression must come out as there; `posix` covers linux and
 * darwin both, which is the decision this change makes about macOS.
 */
const CASES = [
  // 1. native paths
  {
    section: 'native paths',
    name: 'a Windows pair differing only in case',
    expr: "isSameWorkspace('C:/Users/me/Board', 'c:/users/me/board')",
    win32: true,
    posix: false,
  },
  {
    section: 'native paths',
    name: 'a POSIX pair differing only in case',
    expr: "isSameWorkspace('/home/me/Board', '/home/me/board')",
    win32: true,
    posix: false,
  },
  {
    section: 'native paths',
    name: 'the canonical form keeps the case it was given',
    expr: "resolveWorkspacePath('/home/me/Board').canonical.includes('Board')",
    win32: false,
    posix: true,
  },
  {
    section: 'native paths',
    name: 'one path is still itself',
    expr: "isSameWorkspace('/home/me/board', '/home/me/board')",
    win32: true,
    posix: true,
  },
  {
    section: 'native paths',
    name: 'separators are still normalised',
    expr: "isSameWorkspace('C:/Users/me/Projects/Thing', 'C:\\\\Users\\\\me\\\\Projects\\\\Thing')",
    win32: true,
    posix: true,
  },
  {
    section: 'native paths',
    name: 'a trailing separator is still irrelevant',
    expr: "isSameWorkspace('/home/me/board/', '/home/me/board')",
    win32: true,
    posix: true,
  },
  {
    section: 'native paths',
    name: 'two different paths stay different',
    expr: "isSameWorkspace('/home/me/one', '/home/me/two')",
    win32: false,
    posix: false,
  },

  // 2. the wsl canonical form, which folds everywhere
  {
    section: 'wsl paths are unaffected',
    name: 'distro and inner path are folded',
    expr: "resolveWorkspacePath('/home/me/Proj', 'Ubuntu-22.04').canonical",
    win32: 'wsl:ubuntu-22.04:/home/me/proj',
    posix: 'wsl:ubuntu-22.04:/home/me/proj',
  },
  {
    section: 'wsl paths are unaffected',
    name: 'an already-lowercase path resolves to the same key',
    expr: "resolveWorkspacePath('/home/me/proj', 'ubuntu-22.04').canonical",
    win32: 'wsl:ubuntu-22.04:/home/me/proj',
    posix: 'wsl:ubuntu-22.04:/home/me/proj',
  },
  {
    section: 'wsl paths are unaffected',
    name: 'the UNC spelling still collapses onto the inner one',
    expr: "isSameWorkspace('\\\\\\\\wsl.localhost\\\\Ubuntu-22.04\\\\home\\\\me\\\\Proj', '/home/me/proj', 'Ubuntu-22.04')",
    win32: true,
    posix: true,
  },
  {
    section: 'wsl paths are unaffected',
    name: 'a wsl workspace is not the native path that spells it',
    expr: "resolveWorkspacePath('/home/me/proj', 'Ubuntu-22.04').canonical !== resolveWorkspacePath('/home/me/proj').canonical",
    win32: true,
    posix: true,
  },

  // 3. the worktree matcher, which compares git's spelling against ours
  {
    section: 'samePath in implement-worktree',
    name: 'Issue-5 is not issue-5',
    expr: "samePath('/home/me/proj-worktrees/Issue-5', '/home/me/proj-worktrees/issue-5')",
    win32: true,
    posix: false,
  },
  {
    section: 'samePath in implement-worktree',
    name: 'a checkout still matches its own path',
    expr: "samePath('/home/me/proj-worktrees/issue-5', '/home/me/proj-worktrees/issue-5')",
    win32: true,
    posix: true,
  },
  {
    section: 'samePath in implement-worktree',
    name: 'separators and a trailing one are still ignored',
    expr: "samePath('C:\\\\me\\\\proj\\\\', 'C:/me/proj')",
    win32: true,
    posix: true,
  },
];

/**
 * The child: it redefines its own platform, then evaluates each expression against the
 * compiled modules and reports what came out.
 *
 * Every case is caught individually, so a missing export shows up as the one case that needed
 * it going red rather than as a crash with no verdict on the others.
 */
const PROBE = `Object.defineProperty(process, 'platform', { value: process.argv[2] });
const { resolveWorkspacePath, isSameWorkspace } = await import(process.argv[3]);
const { samePath } = await import(process.argv[4]);
const results = {};
for (const [name, expr] of JSON.parse(process.argv[5])) {
  try {
    results[name] = { value: eval(expr) };
  } catch (error) {
    results[name] = { error: String((error && error.message) || error) };
  }
}
process.stdout.write(JSON.stringify({ platform: process.platform, results }));
`;

function evaluateOn(probePath, platform) {
  const run = spawnSync(
    process.execPath,
    [
      probePath,
      platform,
      pathToFileURL(pathsModule).href,
      pathToFileURL(worktreeModule).href,
      JSON.stringify(CASES.map((one) => [one.name, one.expr])),
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    return { failed: `${run.error?.message ?? ''}${run.stderr ?? ''}`.trim() || `exit ${run.status}` };
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    return { failed: `unparseable output: ${run.stdout.slice(0, 200)}` };
  }
}

function main() {
  for (const module of [pathsModule, worktreeModule]) {
    if (!existsSync(module)) {
      console.error(`Missing ${module} — run ./node_modules/.bin/tsc first.`);
      process.exit(1);
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ws-case-'));
  const probePath = join(tmp, 'probe.mjs');
  writeFileSync(probePath, PROBE);

  try {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const expects = platform === 'win32' ? 'win32' : 'posix';
      console.log(`\nprocess.platform === '${platform}'`);
      const answered = evaluateOn(probePath, platform);
      if (answered.failed) {
        check(`probe runs on ${platform}`, false, answered.failed);
        continue;
      }
      check('the child reports the platform it was given', answered.platform === platform, answered.platform);

      let section = '';
      for (const one of CASES) {
        if (one.section !== section) {
          section = one.section;
          console.log(`  — ${section}`);
        }
        const got = answered.results[one.name];
        const want = one[expects];
        if (got?.error) {
          check(one.name, false, got.error);
          continue;
        }
        check(
          one.name,
          JSON.stringify(got?.value) === JSON.stringify(want),
          `expected ${JSON.stringify(want)}, got ${JSON.stringify(got?.value)}`,
        );
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
