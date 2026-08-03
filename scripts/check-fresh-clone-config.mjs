#!/usr/bin/env node
/**
 * Checks what somebody else's clone of this repository becomes when it is registered as a
 * board.
 *
 * That is the whole of the defect, and it is not visible from inside this checkout: the tool
 * ships a `docs/` tree and a `docs/board.excalidraw`, the README's fork section leads a reader
 * to register their clone as a project, and the tracked `board.config.json` used to name the
 * maintainer's `repo` and the maintainer's GitHub project board. `ensureWorkspaceConfig`
 * returns early when a config already exists, so nothing on that path ever asked whose
 * repository it was — the stranger got a board that mirrors an account they have no access to
 * and marks every card on it undraggable.
 *
 * So this reproduces the whole path rather than reading the file: every tracked file is copied
 * into a throwaway directory — a clone with no `.git`, which is what a downloaded release is —
 * that directory is registered against a throwaway registry through the same
 * `POST /api/workspaces` the `+` calls, and the workspace that comes back is asked what it
 * points at.
 *
 * `check-shipped-config-neutral.mjs` is the other side of this: it holds the tracked file, and
 * the derivation that fills `repo` in for a project that *is* a git repository. This one asks
 * only what a fresh copy loads as.
 *
 * Self-contained: throwaway copy, throwaway registry, its own canvas server on a free port.
 * Nothing here talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-fresh-clone-config.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const slash = (value) => String(value).replace(/\\/g, '/');

// ─── The copy ─────────────────────────────────────────────────

const workDir = join(tmpdir(), `check-fresh-clone-config-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const cloneDir = join(workDir, 'someones-clone');
mkdirSync(cloneDir, { recursive: true });

console.log('1. the tracked tree copies into a directory of its own');

const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
check('git listed the tracked files', listed.status === 0,
      (listed.stderr || listed.error?.message || '').trim());

const files = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
for (const path of files) {
  const from = join(repoRoot, path);
  if (!existsSync(from)) continue;
  const to = join(cloneDir, path);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
check('the copy has a board configuration', existsSync(join(cloneDir, 'board.config.json')));
check('the copy is not a git repository', !existsSync(join(cloneDir, '.git')),
      'a downloaded release has no history, and neither does this');

// ─── Registered ───────────────────────────────────────────────

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({ workspaces: [] }, null, 2), 'utf8');

const canvas = await openCanvas({
  env: {
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_STATE_HOME: join(workDir, 'state'),
    LOG_LEVEL: 'error',
  },
});

try {
  console.log('\n2. registered as a project, it points at nobody');

  const response = await fetch(`${canvas.base}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: slash(cloneDir), id: 'someones-clone' }),
  });
  const body = await response.json().catch(() => ({}));
  check('it registers', response.status === 201,
        `${response.status} ${JSON.stringify(body?.error ?? '')}`);

  const workspace = body?.workspace ?? {};
  check('the workspace carries no githubProject', workspace.githubProject === null,
        `githubProject = ${JSON.stringify(workspace.githubProject ?? null)}`);
  check('and no repository belonging to anyone else', workspace.repo === null,
        `repo = ${JSON.stringify(workspace.repo ?? null)} — nothing here could have derived that`);
  check('and it loaded without an error', workspace.error === null,
        JSON.stringify(workspace.error));

  console.log('\n3. and it is still a usable board');
  // The point of leaving the file tracked rather than deleting it: a copy of this tree is a
  // board somebody can open, with its documents attached. Only the two GitHub fields left.
  check('the board file resolved', typeof workspace.boardFile === 'string' && workspace.boardFile,
        `boardFile = ${JSON.stringify(workspace.boardFile ?? null)}`);
  check('the docs directory resolved', typeof workspace.docsDir === 'string' && workspace.docsDir,
        `docsDir = ${JSON.stringify(workspace.docsDir ?? null)}`);

  console.log('\n4. and registering it wrote nothing into the copy');
  // `ensureWorkspaceConfig` only writes a config for a project that has none. A copy of this
  // tree has one, so the file it arrived with is the file it keeps.
  const before = readFileSync(join(repoRoot, 'board.config.json'), 'utf8');
  const after = readFileSync(join(cloneDir, 'board.config.json'), 'utf8');
  check('its board.config.json is byte for byte the tracked one', before === after,
        `${after.length} bytes against ${before.length}`);
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
