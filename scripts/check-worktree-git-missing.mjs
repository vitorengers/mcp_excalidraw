#!/usr/bin/env node
/**
 * Checks what happens when the git that makes a worktree cannot be started at all.
 *
 * `implement-worktree.ts` runs every git call through one private `exec()`, and that call was
 * the single child of this server that never got `agentEnv()` — no `env` at all, so worktree
 * git saw whatever PATH the server process happened to inherit while the agents and the
 * terminal saw the repaired one. A board launched from Finder, from a `.desktop` entry or
 * from a LaunchAgent gets a PATH with no Homebrew prefix in it, so on such a machine `git`
 * is simply not there.
 *
 * What that did next is the reason this exists. A spawn that never starts resolves
 * `{ ok: false }`, which is the same shape as git having run and refused, and the one caller
 * that reads it reads `!ok` as **"this workspace is not a git repository"** — warns, returns
 * null, and lets the run proceed in the project checkout with no isolation. That is precisely
 * the state the module's own header says it exists to prevent, and it cost this project two
 * issues cutting branches in one tree. `worktreesHoldingWork` reads the same result the same
 * way and answers `[]`, so interrupted-run recovery reports nothing to recover.
 *
 * Four sections:
 *
 * 1. **A real repository, and no git to look at it with.** The refusal has to name git and
 *    must not claim the workspace is not a repository. Refusal rather than a null, because
 *    running an implement agent unisolated in the project checkout is worse than not running.
 * 2. **A workspace that really is not a repository.** Unchanged: null, and the warning it
 *    always logged. This is the case a guard that fired too eagerly would break.
 * 3. **`worktreesHoldingWork`.** The same distinction, and the working path still works.
 * 4. **The environment git is handed.** Asserted through a stub `git` that records what it
 *    was given: the PATH is `agentPath()`'s answer, and `CLAUDE_CODE_CHILD_SESSION` — which
 *    `agentEnv()` strips from every child — does not reach it.
 *
 * PATH is manipulated in this process rather than in a child, deliberately: `exec()` reads
 * `process.env` at the moment it spawns, both before this change (by inheritance) and after
 * (through `agentEnv()`), so this process's own PATH is the one the module is given either
 * way. It is restored after every section.
 *
 * Self-contained: builds a throwaway repository, runs no server and reaches no network.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-worktree-git-missing.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const { ensureWorktree, worktreesHoldingWork } =
  await importDist(join('core', 'implement-worktree.js'), 'the worktree maker');
const { agentPath } = await importDist(join('core', 'issue-agent.js'), 'the agent environment');
const logging = await importDist(join('utils', 'logger.js'), 'the logger');
const logger = logging.default;

const root = join(tmpdir(), 'worktree-git-missing-check');
rmSync(root, { recursive: true, force: true, maxRetries: 3 });
mkdirSync(root, { recursive: true });

const REAL_PATH = process.env.PATH ?? '';

/** Every directory on this machine's PATH that has no runnable git in it. */
function pathWithoutGit() {
  const names = ['git', 'git.exe', 'git.cmd', 'git.bat', 'git.com'];
  return REAL_PATH
    .split(delimiter)
    .filter(Boolean)
    .filter((directory) => !names.some((name) => {
      try { return existsSync(join(directory, name)); } catch { return false; }
    }))
    .join(delimiter);
}

/**
 * A directory holding a file called `gh`, put on the PATH of the sections that remove git.
 *
 * `agentPath()` repairs a PATH that cannot resolve `gh` by appending the directories the
 * platform keeps its tools in — `/usr/bin` among them, which is where a Linux machine keeps
 * git as well. Without this, removing git from the PATH on POSIX would hand it straight back
 * and the section would assert nothing. `resolveExecutable` asks only that the file exist,
 * so an empty one is enough, and it is never run.
 */
const ghOnly = join(root, 'gh-only');
mkdirSync(ghOnly, { recursive: true });
writeFileSync(join(ghOnly, 'gh'), '', 'utf8');

function realGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function makeRepository(at) {
  mkdirSync(at, { recursive: true });
  realGit(at, ['init', '--quiet', '--initial-branch', 'main']);
  realGit(at, ['config', 'user.email', 'check@example.invalid']);
  realGit(at, ['config', 'user.name', 'Git Missing Check']);
  realGit(at, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(at, 'README.md'), '# throwaway\n', 'utf8');
  realGit(at, ['add', '-A']);
  realGit(at, ['commit', '--quiet', '-m', 'first']);
  return at;
}

function workspaceAt(id, at) {
  return {
    id,
    name: id,
    path: at,
    innerPath: at.replace(/\\/g, '/'),
    environment: { kind: 'native' },
    error: null,
  };
}

const ISSUE = (n) => `https://github.com/vitorengers/mcp_excalidraw/issues/${n}`;

/** Whatever the call answered — its value, or the message it threw. */
async function attempt(run) {
  try {
    return { value: await run(), error: null };
  } catch (error) {
    return { value: null, error: String(error?.message ?? error) };
  }
}

/** Every `logger.warn` a section produced, so the wording that survives can be asserted. */
const warnings = [];
const realWarn = logger.warn.bind(logger);
logger.warn = (...args) => { warnings.push(String(args[0])); return realWarn(...args); };

const naming = (message) => typeof message === 'string' && /\bgit\b/i.test(message);
const blamesTheWorkspace = (message) => typeof message === 'string' && /is not a git repository/i.test(message);

try {
  console.log('1. a real repository, and no git to look at it with');
  {
    const project = makeRepository(join(root, 'has-git'));
    const workspace = workspaceAt('git-missing-check', project);

    process.env.PATH = [ghOnly, pathWithoutGit()].filter(Boolean).join(delimiter);
    const { value, error } = await attempt(() => ensureWorktree(workspace, ISSUE(920)));
    process.env.PATH = REAL_PATH;

    check('the run is refused rather than quietly unisolated', error !== null,
          `ensureWorktree answered ${JSON.stringify(value)}; running an agent in the project `
          + 'checkout is the failure this module exists to prevent');
    check('the refusal names git', naming(error), `error was ${JSON.stringify(error)}`);
    check('it does not claim the workspace is not a repository', !blamesTheWorkspace(error),
          `error was ${JSON.stringify(error)} — the repository is real; git is what is missing`);
    check('it says what to do about it', typeof error === 'string' && /PATH|install/i.test(error),
          `error was ${JSON.stringify(error)}`);
    check('no worktree was left behind', !existsSync(join(root, 'has-git-worktrees', 'issue-920')));
    check('and nothing was logged blaming the workspace',
          !warnings.some(blamesTheWorkspace),
          `warnings were ${JSON.stringify(warnings)}`);
  }

  console.log('\n2. a workspace that really is not a repository');
  {
    warnings.length = 0;
    const plain = join(root, 'not-a-repository');
    mkdirSync(plain, { recursive: true });
    const workspace = workspaceAt('plain-check', plain);

    const { value, error } = await attempt(() => ensureWorktree(workspace, ISSUE(921)));

    check('it still answers null rather than throwing', error === null && value === null,
          `error was ${JSON.stringify(error)}, value was ${JSON.stringify(value)}`);
    check('and still logs that the workspace is not a git repository',
          warnings.some(blamesTheWorkspace),
          `warnings were ${JSON.stringify(warnings)}`);
  }

  console.log('\n3. worktreesHoldingWork tells the two apart');
  {
    const project = makeRepository(join(root, 'holding'));
    const workspace = workspaceAt('holding-check', project);

    // A checkout with work in it, made the way the server makes them.
    const made = await attempt(() => ensureWorktree(workspace, ISSUE(922)));
    if (made.value) writeFileSync(join(made.value.path, 'in-progress.txt'), 'unfinished\n', 'utf8');
    check('a worktree could be made to hold work', made.value !== null,
          `error was ${JSON.stringify(made.error)}`);

    const reported = await attempt(() => worktreesHoldingWork(workspace));
    check('it is reported while git works', reported.value?.length === 1,
          `answered ${JSON.stringify(reported.value ?? reported.error)}`);

    process.env.PATH = [ghOnly, pathWithoutGit()].filter(Boolean).join(delimiter);
    const blind = await attempt(() => worktreesHoldingWork(workspace));
    process.env.PATH = REAL_PATH;

    check('with no git it does not answer "nothing to recover"',
          !Array.isArray(blind.value) || blind.value.length > 0,
          'work that cannot be looked for is not work that is not there');
    check('it says git could not be started', naming(blind.error),
          `answered ${JSON.stringify(blind.value ?? blind.error)}`);
    check('and does not claim the workspace is not a repository', !blamesTheWorkspace(blind.error),
          `error was ${JSON.stringify(blind.error)}`);

    const plain = join(root, 'not-a-repository');
    const stillEmpty = await attempt(() => worktreesHoldingWork(workspaceAt('plain-held', plain)));
    check('a real non-repository is still an empty list', stillEmpty.value?.length === 0,
          `answered ${JSON.stringify(stillEmpty.value ?? stillEmpty.error)}`);
  }

  console.log('\n4. the environment git is handed');
  {
    // A stub `git`: this machine's node under another name, which runs the file named after
    // its first argument. `exec()` asks for `rev-parse` first, so that is the file, and it
    // writes down the environment it was started with.
    const stub = join(root, 'stub');
    mkdirSync(stub, { recursive: true });
    copyFileSync(process.execPath, join(stub, process.platform === 'win32' ? 'git.exe' : 'git'));

    const project = join(root, 'recorded');
    mkdirSync(project, { recursive: true });
    const record = join(root, 'given-to-git.json');
    // Extensionless, so it is read as CommonJS whatever the directory above it says.
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
    writeFileSync(join(project, 'rev-parse'), [
      "const fs = require('fs');",
      'fs.writeFileSync(process.env.WORKTREE_GIT_RECORD, JSON.stringify(process.env), "utf8");',
      '// Not a repository, as far as the caller is concerned: this stub exists to be asked,',
      '// not to answer. The section asserts on what it was given, not on what it said.',
      'process.exit(1);',
    ].join('\n'), 'utf8');

    process.env.WORKTREE_GIT_RECORD = record;
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    // The stub alone, so `gh` cannot be resolved and `agentPath()` has its repair to make.
    // Its directory comes first, so anything the repair appends cannot shadow the stub.
    process.env.PATH = stub;
    const repaired = agentPath();
    await attempt(() => ensureWorktree(workspaceAt('recorded-check', project), ISSUE(923)));
    process.env.PATH = REAL_PATH;
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    delete process.env.WORKTREE_GIT_RECORD;

    const given = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
    check('git ran and recorded what it was given', given !== null,
          'the stub was never started, so nothing here can be asserted');
    check('it was handed the PATH agentPath() repairs, not this process\'s own',
          given?.PATH === repaired,
          `git saw ${JSON.stringify(given?.PATH)}, agentPath() answers ${JSON.stringify(repaired)}`);
    // Unconditional in `agentEnv()` and in nothing else, so it is the one variable whose
    // absence proves the environment git got came from there.
    check('and the session marker agentEnv() strips did not reach it',
          given !== null && !Object.keys(given).some((key) => key.toUpperCase() === 'CLAUDE_CODE_CHILD_SESSION'),
          'git was given this process\'s raw environment rather than the agents\' one');
  }
} finally {
  process.env.PATH = REAL_PATH;
  logger.warn = realWarn;
  for (const project of ['has-git', 'holding']) {
    const at = join(root, project);
    if (existsSync(at)) spawnSync('git', ['worktree', 'prune'], { cwd: at, encoding: 'utf8' });
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
