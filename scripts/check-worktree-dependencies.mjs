#!/usr/bin/env node
/**
 * Checks that a worktree's dependencies are its own to destroy.
 *
 * A worktree isolates the working tree. It did not isolate `node_modules`: that was shared
 * as a single junction, so four supposedly independent checkouts pointed at one directory,
 * and anything an agent ran that cleared its own dependencies reached through and emptied
 * the project's. It happened twice in one afternoon. The symptom arrives later and looks
 * unrelated — the next build fails with `Cannot find package 'winston'`, in a checkout
 * nobody touched.
 *
 * So the case here is the destructive one, done the way a tool that descends does it:
 * clear the *contents* of the worktree's `node_modules`, then look at the project's. Hard
 * links pass this; a junction does not.
 *
 * Usage: node scripts/check-worktree-dependencies.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const distPath = join(repoRoot, 'dist', 'core', 'implement-worktree.js');
if (!existsSync(distPath)) {
  console.error('  FAIL  the worktree module exists — run tsc first');
  process.exit(1);
}
const { ensureWorktree, releaseWorktree } = await import(pathToFileURL(distPath).href);

const workDir = join(tmpdir(), 'worktree-deps-check');
rmSync(workDir, { recursive: true, force: true });
const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });

function git(args, cwd = projectDir) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository with one commit, which is all `worktree add` needs.
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'check@example.com']);
git(['config', 'user.name', 'Check']);
writeFileSync(join(projectDir, 'package.json'), '{"name":"deps-check"}', 'utf8');
git(['add', '.']);
git(['commit', '-qm', 'first']);

// Dependencies with a nested directory, because the failure was a recursive delete.
const deps = join(projectDir, 'node_modules');
mkdirSync(join(deps, 'winston', 'lib'), { recursive: true });
writeFileSync(join(deps, 'winston', 'package.json'), '{"name":"winston"}', 'utf8');
writeFileSync(join(deps, 'winston', 'lib', 'winston.js'), 'module.exports = 1;', 'utf8');
mkdirSync(join(deps, '.bin'), { recursive: true });
writeFileSync(join(deps, '.bin', 'tsc'), '#!/bin/sh\n', 'utf8');

const workspace = {
  id: 'deps-check',
  name: 'Deps Check',
  path: projectDir,
  innerPath: projectDir.replace(/\\/g, '/'),
  environment: { kind: 'native' },
  error: null,
};

const ISSUE = 'https://github.com/vitorengers/mcp_excalidraw/issues/999';

try {
  console.log('1. the worktree gets the dependencies it needs to verify anything');
  const worktree = await ensureWorktree(workspace, ISSUE);
  check('a worktree was made', Boolean(worktree), 'ensureWorktree returned nothing');

  const mirrored = join(worktree.path, 'node_modules');
  check('node_modules is there', existsSync(mirrored));
  check('with the nested package', existsSync(join(mirrored, 'winston', 'lib', 'winston.js')));
  check('and the .bin the build needs', existsSync(join(mirrored, '.bin', 'tsc')));

  console.log('\n2. it is a directory of its own, not a door into the project one');
  check('not a link', !lstatSync(mirrored).isSymbolicLink(),
        'a junction makes every checkout share one mutable directory');

  // Same bytes, separate entries: that is what makes this cheap enough to do per run.
  const original = statSync(join(deps, 'winston', 'lib', 'winston.js'));
  const linked = statSync(join(mirrored, 'winston', 'lib', 'winston.js'));
  check('sharing the file rather than copying it', original.ino === linked.ino && original.ino !== 0,
        `ino ${original.ino} vs ${linked.ino}`);

  console.log('\n3. clearing the worktree\'s dependencies leaves the project\'s alone');
  // The destructive shape, done the way a tool that descends does it — `npm ci` clearing
  // its own node_modules, an `rm -rf` in the wrong checkout.
  for (const entry of readdirSync(mirrored)) {
    rmSync(join(mirrored, entry), { recursive: true, force: true });
  }
  check('the worktree copy is empty', readdirSync(mirrored).length === 0);
  check('the project still has its dependencies', existsSync(join(deps, 'winston', 'lib', 'winston.js')),
        'THIS is the regression: the project was emptied through the worktree');
  check('and they are still readable',
        readFileSync(join(deps, 'winston', 'lib', 'winston.js'), 'utf8').includes('module.exports'));
  check('including the .bin', existsSync(join(deps, '.bin', 'tsc')));

  console.log('\n4. the worktree is still removable afterwards');
  rmSync(mirrored, { recursive: true, force: true });
  const released = await releaseWorktree(workspace, worktree);
  check('it was released', released.removed, `kept at ${released.path}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
