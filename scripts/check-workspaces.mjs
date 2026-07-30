#!/usr/bin/env node
/**
 * Checks for workspace path resolution and the registry loader.
 *
 * The interesting cases are all about a project having two names: from Windows a WSL
 * project is `\\wsl.localhost\<distro>\home\me\proj`, from inside WSL the same project
 * is `/home/me/proj`. Treating those as different workspaces would give one project two
 * boards, so most of this file is about proving they collapse.
 *
 * Runs the compiled modules directly — no server required.
 * Usage: node scripts/check-workspaces.mjs
 *
 * Tier: fast
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const { resolveWorkspacePath, isSameWorkspace, resolveInWorkspace } =
  await import('../dist/core/workspace-paths.js');
const { loadWorkspaces } = await import('../dist/core/workspaces.js');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  console.log('1. WSL UNC paths');
  const unc = resolveWorkspacePath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\engers\\proj');
  check('detected as wsl', unc.environment.kind === 'wsl');
  check('distro extracted', unc.environment.distro === 'Ubuntu-22.04', unc.environment.distro);
  check('inner path is posix', unc.innerPath === '/home/engers/proj', unc.innerPath);

  const legacy = resolveWorkspacePath('\\\\wsl$\\Ubuntu-22.04\\home\\engers\\proj');
  check('legacy \\\\wsl$ form recognised', legacy.environment.kind === 'wsl');
  check('both UNC spellings match', legacy.canonical === unc.canonical);

  console.log('\n2. the same project under both names is one workspace');
  check(
    'UNC and POSIX+distro collapse',
    isSameWorkspace('\\\\wsl.localhost\\Ubuntu-22.04\\home\\engers\\proj', '/home/engers/proj', 'Ubuntu-22.04')
  );
  check(
    'trailing separator is irrelevant',
    isSameWorkspace('\\\\wsl.localhost\\Ubuntu-22.04\\home\\engers\\proj\\', '/home/engers/proj', 'Ubuntu-22.04')
  );
  check(
    'different distros stay different',
    !isSameWorkspace('/home/engers/proj', '/home/engers/proj', 'Ubuntu-22.04') === false
      && resolveWorkspacePath('/home/engers/proj', 'Debian').canonical
         !== resolveWorkspacePath('/home/engers/proj', 'Ubuntu-22.04').canonical
  );

  console.log('\n3. native paths');
  const win = resolveWorkspacePath('C:/Users/me/Projects/Thing');
  check('detected as native', win.environment.kind === 'native');
  check(
    'case and separators normalised',
    isSameWorkspace('C:/Users/me/Projects/Thing', 'C:\\Users\\me\\Projects\\Thing')
  );
  check('a native path is not a wsl one', win.canonical !== unc.canonical);

  console.log('\n4. config paths cannot escape the workspace');
  check('normal relative path resolves', resolveInWorkspace(win, 'docs/decisions') !== null);
  check('parent traversal rejected', resolveInWorkspace(win, '../outside') === null);
  check('nested traversal rejected', resolveInWorkspace(win, 'docs/../../outside') === null);
  check('absolute path rejected', resolveInWorkspace(win, '/etc/passwd') === null);
  check('drive-absolute path rejected', resolveInWorkspace(win, 'D:/elsewhere') === null);

  console.log('\n5. registry loading');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-check-'));
  const projectA = path.join(tmp, 'alpha');
  const projectB = path.join(tmp, 'beta');
  await fs.mkdir(projectA); await fs.mkdir(projectB);
  await fs.writeFile(
    path.join(projectA, 'board.config.json'),
    JSON.stringify({ name: 'Alpha', docsDir: 'docs/decisions', repo: 'me/alpha' })
  );
  await fs.writeFile(path.join(projectB, 'board.config.json'), '{ this is not json');

  const registryPath = path.join(tmp, 'workspaces.json');
  await fs.writeFile(registryPath, JSON.stringify({
    workspaces: [
      { id: 'alpha', path: projectA },
      { id: 'beta', path: projectB },
      { id: 'ghost', path: path.join(tmp, 'does-not-exist') },
      { id: 'alpha-again', path: projectA },   // same project, second spelling
    ]
  }));

  const workspaces = await loadWorkspaces(registryPath);
  const byId = Object.fromEntries(workspaces.map((w) => [w.id, w]));

  check('duplicate project dropped', workspaces.length === 3, `got ${workspaces.length}`);
  check('valid workspace loaded', byId.alpha?.name === 'Alpha');
  check('repo read from config', byId.alpha?.repo === 'me/alpha');
  check('docsDir resolved', typeof byId.alpha?.docsDir === 'string');
  check('no error on the good one', byId.alpha?.error === null);

  check('malformed config still listed', Boolean(byId.beta), 'a broken project must not vanish');
  check('malformed config reports error', typeof byId.beta?.error === 'string');
  check('missing project reports error', typeof byId.ghost?.error === 'string');

  console.log('\n6. no registry means dormant, not broken');
  check('undefined registry -> empty list', (await loadWorkspaces(undefined)).length === 0);
  check('unreadable registry -> empty list', (await loadWorkspaces(path.join(tmp, 'nope.json'))).length === 0);

  await fs.rm(tmp, { recursive: true, force: true });

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

main().catch((err) => { console.error(`\nerror: ${err.stack ?? err.message}`); process.exit(1); });
