#!/usr/bin/env node
/**
 * Checks that the configuration this repository ships names nobody, and that a project
 * learns which repository it is in from the repository itself.
 *
 * The tracked `board.config.json` used to carry two fields that are not properties of this
 * *tool* at all — the maintainer's `repo` and the URL of the maintainer's own GitHub project
 * board. `loadWorkspace` reads both verbatim, `readProjectBoard` runs `gh` against the second
 * and `toBoard` decides which cards are draggable from the first, so a stranger who cloned the
 * release and registered the clone as a board — the path the README's own fork section leads
 * to — got a board pointed at somebody else's project.
 *
 * Three rules, and each one is a different half of that:
 *
 *   1. The board configuration this repository tracks declares a board and where its
 *      documents are, and nothing about GitHub. It cannot be deleted — `check-board-docs.mjs`
 *      and `check-board-map.mjs` both read `board` and `docsDir` out of it — so the rule is
 *      about what it may *contain*, not about whether it exists.
 *   2. No tracked file points a reader at the project board belonging to whoever owns this
 *      repository. The owner comes from `FORK_REPO` in `scripts/lib/repo-identity.mjs`, the
 *      tree's one record of which repository it is, rather than being written here again, so a
 *      fork that renames itself is held to its own name and not to this one. A fixture naming
 *      an invented account is exactly what a fixture should be and passes.
 *   3. Registration answers the question instead of the repository shipping an answer:
 *      a project whose `origin` is a GitHub remote gets a `repo` written from that remote,
 *      a project with no remote gets no `repo` key at all, and neither gets a
 *      `githubProject` — a project board is per-person, and there is nothing to derive it
 *      from.
 *
 * And a fourth rule, which is the one that keeps this repository's own board working after
 * the other three: an untracked `board.config.local.json` beside the tracked file overrides
 * it, and a setting saved from the settings dialog is written back to whichever of the two
 * it was read from. Getting that wrong is what would make an edit appear not to save.
 *
 * `package.json` is deliberately out of scope: naming the repository a package is published
 * from is what a package manifest is for, and `check-fork-identity.mjs` already holds it.
 *
 * Self-contained: throwaway registry, throwaway git repositories, its own canvas server on a
 * free port. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-shipped-config-neutral.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoIdentity } from './lib/repo-identity.mjs';
import { openCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const slash = (value) => String(value).replace(/\\/g, '/');

/**
 * A user-project URL, assembled rather than written.
 *
 * Rule 2 scans every tracked file for one of these, and this file is tracked: a literal here
 * would be a check that fails on its own source. Built from parts, the string exists at run
 * time and never in the bytes on disk.
 */
const projectUrl = (owner, number) =>
  ['https:/', 'github.com', 'users', owner, 'projects', String(number)].join('/');

// ─── 1. the tracked board configuration ───────────────────────

console.log('1. the board configuration this repository tracks names no GitHub anything');

const shipped = JSON.parse(readFileSync(join(repoRoot, 'board.config.json'), 'utf8'));

check('it still names a board', typeof shipped.board === 'string' && shipped.board.trim(),
      'check-board-docs.mjs and check-board-map.mjs both read this');
check('it still names a docsDir', typeof shipped.docsDir === 'string' && shipped.docsDir.trim(),
      'check-board-docs.mjs reads this');
check('it carries no "repo"', !('repo' in shipped),
      `repo = ${JSON.stringify(shipped.repo)} — a clone of this tree would be that repository`);
check('it carries no "githubProject"', !('githubProject' in shipped),
      `githubProject = ${JSON.stringify(shipped.githubProject)} — a clone would mirror that board`);

const mentions = Object.entries(shipped)
  .filter(([, value]) => typeof value === 'string' && /github\.com/i.test(value));
check('no value in it names github.com at all', mentions.length === 0,
      mentions.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', '));

// ─── 2. every tracked file ────────────────────────────────────

console.log("\n2. no tracked file points at this repository owner's project board");

const { owner, repo } = repoIdentity();
check('the tree records who owns this repository', Boolean(owner), `FORK_REPO = ${repo}`);

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
check('git listed the tracked files', tracked.status === 0,
      (tracked.stderr || tracked.error?.message || '').trim());

if (owner && tracked.status === 0) {
  // Assembled for the same reason `projectUrl` is: the pattern below is a regular expression
  // in this file's bytes, and the URL it looks for is not.
  const pattern = new RegExp(`github\\.com/users/${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/projects/`, 'i');
  const offenders = [];
  for (const path of tracked.stdout.split('\0').filter(Boolean)) {
    const full = join(repoRoot, path);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    if (pattern.test(text)) offenders.push(path);
  }
  check(`no tracked file names a project board owned by "${owner}"`, offenders.length === 0,
        `${offenders.length}: ${offenders.slice(0, 8).join(', ')}${offenders.length > 8 ? ' …' : ''}`);
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `check-shipped-config-neutral-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${result.stderr || result.error?.message}`);
  }
  return result.stdout.trim();
}

/** A directory, optionally a git repository, optionally with an `origin`. */
function makeProject(id, { repository = false, origin = null, config = null, local = null } = {}) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  if (repository) {
    git(dir, ['init', '-b', 'main']);
    if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  }
  if (config) writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config, null, 2), 'utf8');
  if (local) writeFileSync(join(dir, 'board.config.local.json'), JSON.stringify(local, null, 2), 'utf8');
  return dir;
}

const withOriginDir = makeProject('with-origin', {
  repository: true, origin: 'git@github.com:someone/their-tool.git',
});
const noRemoteDir = makeProject('no-remote', { repository: true });
const notARepoDir = makeProject('not-a-repo');

/** This repository's own arrangement after the change: a shared file plus a local overlay. */
const SHARED = { name: 'Overlaid', docsDir: 'docs', board: 'docs/board.excalidraw' };
const LOCAL = { repo: 'someone/their-tool', githubProject: projectUrl('someone', 5) };
const overlaidDir = makeProject('overlaid', { config: SHARED, local: LOCAL });
/** No overlay: the ordinary project, where the settings dialog writes what it always did. */
const plainDir = makeProject('plain', { config: { name: 'Plain', docsDir: 'docs' } });

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'overlaid', path: slash(overlaidDir) },
    { id: 'plain', path: slash(plainDir) },
  ],
}, null, 2), 'utf8');

const canvas = await openCanvas({
  env: {
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_STATE_HOME: join(workDir, 'state'),
    LOG_LEVEL: 'error',
  },
});

const readJson = (dir, name) => {
  const path = join(dir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};

async function register(dir, id) {
  const response = await fetch(`${canvas.base}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: slash(dir), id }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

try {
  // ─── 3. registration answers it ─────────────────────────────

  console.log('\n3. registration writes the repository the project is actually in');

  const added = await register(withOriginDir, 'with-origin');
  check('a project with a GitHub origin registers', added.status === 201,
        `${added.status} ${JSON.stringify(added.body?.error ?? '')}`);
  const written = readJson(withOriginDir, 'board.config.json');
  check('and its new config names that repository', written?.repo === 'someone/their-tool',
        `repo = ${JSON.stringify(written?.repo ?? null)}`);
  check('and names no project board', !('githubProject' in (written ?? {})),
        `githubProject = ${JSON.stringify(written?.githubProject ?? null)}`);
  check('and the loaded workspace reports both',
        added.body?.workspace?.repo === 'someone/their-tool'
        && added.body?.workspace?.githubProject === null,
        JSON.stringify({ repo: added.body?.workspace?.repo, githubProject: added.body?.workspace?.githubProject }));

  const bare = await register(noRemoteDir, 'no-remote');
  const bareConfig = readJson(noRemoteDir, 'board.config.json');
  check('a repository with no origin registers', bare.status === 201,
        `${bare.status} ${JSON.stringify(bare.body?.error ?? '')}`);
  check('and gets no "repo" key at all', bareConfig && !('repo' in bareConfig),
        `config = ${JSON.stringify(bareConfig)}`);

  const loose = await register(notARepoDir, 'not-a-repo');
  const looseConfig = readJson(notARepoDir, 'board.config.json');
  check('a directory that is no repository registers', loose.status === 201,
        `${loose.status} ${JSON.stringify(loose.body?.error ?? '')}`);
  check('and gets no "repo" key either', looseConfig && !('repo' in looseConfig),
        `config = ${JSON.stringify(looseConfig)}`);

  // ─── 4. the local overlay ───────────────────────────────────

  console.log('\n4. an untracked overlay carries what the shared file may not');

  const listed = await (await fetch(`${canvas.base}/api/workspaces`)).json();
  const overlaid = (listed.workspaces ?? []).find((workspace) => workspace.id === 'overlaid');
  check('the overlaid project loaded', Boolean(overlaid), JSON.stringify(listed).slice(0, 200));
  check('its repo comes from the overlay', overlaid?.repo === 'someone/their-tool',
        `repo = ${JSON.stringify(overlaid?.repo ?? null)}`);
  check('its githubProject comes from the overlay', overlaid?.githubProject === LOCAL.githubProject,
        `githubProject = ${JSON.stringify(overlaid?.githubProject ?? null)}`);
  check('and the shared file still decides the rest', overlaid?.name === 'Overlaid',
        `name = ${JSON.stringify(overlaid?.name ?? null)}`);

  const shownRaw = await (await fetch(`${canvas.base}/api/workspaces/overlaid/config`)).json();
  const shown = shownRaw?.config ?? {};
  check('the settings dialog is shown the settings in force',
        shown.repo === LOCAL.repo && shown.githubProject === LOCAL.githubProject
        && shown.board === SHARED.board,
        JSON.stringify(shown));

  // Saved the way the dialog saves: every field at once, changed or not. That is what makes
  // "which file does this land in" a question with a wrong answer.
  const moved = projectUrl('someone-else', 9);
  const saved = await fetch(`${canvas.base}/api/workspaces/overlaid/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { ...SHARED, ...LOCAL, githubProject: moved, name: 'Renamed' } }),
  });
  const savedBody = await saved.json().catch(() => ({}));
  check('the settings save', saved.ok && savedBody?.success === true,
        JSON.stringify(savedBody?.error ?? savedBody).slice(0, 200));
  check('and the board reports what was saved', savedBody?.workspace?.githubProject === moved,
        `githubProject = ${JSON.stringify(savedBody?.workspace?.githubProject ?? null)}`);

  const localAfter = readJson(overlaidDir, 'board.config.local.json');
  const sharedAfter = readJson(overlaidDir, 'board.config.json');
  check('the overlay took the setting it already owned', localAfter?.githubProject === moved,
        `overlay = ${JSON.stringify(localAfter)}`);
  check('the shared file took the setting it already owned', sharedAfter?.name === 'Renamed',
        `shared = ${JSON.stringify(sharedAfter)}`);
  check('and the shared file did not gain the overlay\'s',
        !('githubProject' in (sharedAfter ?? {})) && !('repo' in (sharedAfter ?? {})),
        `shared = ${JSON.stringify(sharedAfter)}`);

  const plainSave = await fetch(`${canvas.base}/api/workspaces/plain/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { repo: 'someone/plain-thing' } }),
  });
  await plainSave.json().catch(() => ({}));
  check('a project with no overlay still writes its own board.config.json',
        readJson(plainDir, 'board.config.json')?.repo === 'someone/plain-thing',
        JSON.stringify(readJson(plainDir, 'board.config.json')));
  check('and no overlay was invented for it',
        readJson(plainDir, 'board.config.local.json') === null);
} finally {
  canvas.stop();
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
