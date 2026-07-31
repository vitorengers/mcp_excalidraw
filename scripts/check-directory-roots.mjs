#!/usr/bin/env node
/**
 * Checks where the project picker opens, and that the board says which platform it is on.
 *
 * `listRoots()` answered the drive letters on Windows and a single entry, `/`, on everything
 * else. This is the first screen of the product: on a mac, adding a first project started at
 * the filesystem root and the reader clicked past `System`, `Volumes`, `private` and `cores`
 * before reaching `Users`; on Linux, past `proc`, `sys` and `dev`. Nothing was broken — `/` is
 * navigable — which is exactly why nothing caught it.
 *
 * So the cases are about the two ends of the same screen:
 *
 *   - **the roots a POSIX board offers**: the home directory first, because that is where a
 *     project is, with `/` still in the same listing so nothing is now unreachable, and
 *     `/Volumes` on darwin when it exists — the one place a mac keeps everything that is not
 *     the boot disk;
 *   - **Windows is untouched**: still exactly the accessible drive letters, in the shape they
 *     always had, because a picker that started at `C:/` would have no way to reach `D:/`;
 *   - **`parent` is untouched too**: an ordinary directory still walks up to its own dirname,
 *     which is the half of the listing this change must not move;
 *   - **`GET /health` reports the platform**, which is how the frontend picks a placeholder
 *     that is a path for the machine the reader is standing on rather than always a `C:` one.
 *     `scripts/check-directory-picker-placeholder-browser.mjs` is the half of that on screen.
 *
 * **How another platform is asserted, and what that is worth.** `listRoots` takes the
 * platform, the home directory and where a mac mounts its volumes as defaulted options that
 * nothing in `src/` passes — the convention #283 and #286 established, and for the same
 * reason: one machine has to be able to assert the answer for all three, and a board that
 * could be *told* its own platform by the environment would be a board that can lie about
 * itself. Section 6 goes further and starts a real `dist/server.js` from a launcher that
 * rewrites `process.platform` before importing it; Node's own modules have already chosen by
 * then, so what that simulates is exactly the decision under test and not a whole mac. The
 * one case that needs the host to *be* Windows — drives that are really there — says so and
 * stands down elsewhere rather than asserting something weaker under the same name.
 *
 * Self-contained: throwaway directories and launchers under the temporary directory, its own
 * canvas servers on ports the kernel just handed out, all killed at the end. No browser.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-directory-roots.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `directory-roots-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** Stands in for `/Users/me`, and for `/Volumes`, on a machine that has neither. */
const fakeHome = join(workDir, 'home');
const fakeVolumes = join(workDir, 'volumes');
const projectDir = join(fakeHome, 'projects', 'thing');
for (const dir of [fakeHome, fakeVolumes, projectDir]) mkdirSync(dir, { recursive: true });
const missingVolumes = join(workDir, 'no-such-volumes');

writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({ name: 'thing' }, null, 2), 'utf8');

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'thing', path: slash(projectDir) }],
}, null, 2), 'utf8');

const running = [];

/**
 * A canvas that believes it is running on `platform`.
 *
 * The rewrite happens here and nowhere inside the product. `HOME`, `USERPROFILE`,
 * `LOCALAPPDATA` and `XDG_STATE_HOME` point into the throwaway directory because the log path
 * and the pidfile are chosen from the platform too — and because the home directory is the
 * answer under test, so it has to be one this file put there.
 */
function launcher(platform) {
  const server = join(repoRoot, 'dist', 'server.js');
  const file = join(workDir, `canvas-as-${platform}.mjs`);
  writeFileSync(file,
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });\n`
    // `dist/server.js` only listens when it is the entry point (`isMainModule`), and imported
    // from here it is not. Handing it its own path is what makes this a launcher.
    + `process.argv[1] = ${JSON.stringify(server)};\n`
    + `await import(${JSON.stringify(pathToFileURL(server).href)});\n`,
    'utf8');
  return file;
}

async function startBoard({ platform = null, home = null } = {}) {
  const port = await freePort();
  const server = startCanvas({
    port,
    ...(platform ? { script: launcher(platform) } : {}),
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, `board-${platform ?? 'host'}.log`),
      EXCALIDRAW_WORKSPACES: registryPath,
      ...(home ? { HOME: home, USERPROFILE: home, LOCALAPPDATA: home, XDG_STATE_HOME: home } : {}),
    },
  });
  running.push(server.child);

  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the ${platform ?? 'host'} canvas exited early:\n${server.read()}`);
    }
    try {
      if ((await fetch(`${server.base}/health`)).ok) return server;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the ${platform ?? 'host'} canvas never answered on ${server.base}:\n${server.read()}`);
}

const get = async (base, path) => {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const pathsOf = (listing) => (listing?.entries ?? []).map((entry) => entry.path);

/** The home every simulated board below is told it has, spelled the way a listing spells it. */
const home = slash(fakeHome);

/**
 * The cases that ask the module directly, in a scope of their own.
 *
 * A missing seam fails four sections at once, and the sections after it — the ones that ask a
 * running board — are the evidence that says whether the route agrees. Aborting the file on the
 * import would report the first failure and hide the rest of the picture.
 */
async function moduleCases() {
  // ─── 1 ────────────────────────────────────────────────────────
  console.log('1. a POSIX board opens where projects are, and `/` is still in the same listing');

  const module = join(repoRoot, 'dist', 'core', 'directory-browse.js');
  if (!existsSync(module)) {
    check('dist/core/directory-browse.js exists', false, 'run ./node_modules/.bin/tsc first');
    return null;
  }
  const { listRoots, listDirectories } = await import(pathToFileURL(module).href);

  if (typeof listRoots !== 'function') {
    check('directory-browse exports listRoots', false,
          'without a seam taking the platform, one machine cannot assert what the other two do — '
          + 'and the platform must never come from the environment');
    return null;
  }

  for (const platform of ['darwin', 'linux']) {
    const roots = await listRoots({ platform, home, volumes: missingVolumes });
    const paths = pathsOf(roots);
    check(`on ${platform} the first entry is the home directory`, paths[0] === home,
          JSON.stringify(paths));
    check(`and \`/\` is still reachable from the same listing on ${platform}`, paths.includes('/'),
          JSON.stringify(paths));
    check(`the roots listing is still the roots listing on ${platform}`,
          roots.path === '' && roots.parent === null,
          JSON.stringify({ path: roots.path, parent: roots.parent }));
    check(`every root says what it is on ${platform}`,
          (roots.entries ?? []).every((entry) => typeof entry.name === 'string' && entry.name.length > 0),
          JSON.stringify(roots.entries));
  }

  // A home that *is* the root has nothing to put first, and must not be listed twice.
  const rootIsHome = pathsOf(await listRoots({ platform: 'linux', home: '/', volumes: missingVolumes }));
  check('a home of `/` is one entry rather than two',
        rootIsHome.filter((path) => path === '/').length === 1, JSON.stringify(rootIsHome));

  // ─── 2 ────────────────────────────────────────────────────────
  console.log('\n2. on darwin the volumes are offered, when there are volumes to offer');

  const withVolumes = pathsOf(await listRoots({ platform: 'darwin', home, volumes: fakeVolumes }));
  check('/Volumes is in the listing when the directory exists', withVolumes.includes(slash(fakeVolumes)),
        JSON.stringify(withVolumes));
  check('and the home directory is still first', withVolumes[0] === home, JSON.stringify(withVolumes));

  const withoutVolumes = pathsOf(await listRoots({ platform: 'darwin', home, volumes: missingVolumes }));
  check('nothing is invented when it does not', !withoutVolumes.includes(slash(missingVolumes)),
        JSON.stringify(withoutVolumes));

  const linuxVolumes = pathsOf(await listRoots({ platform: 'linux', home, volumes: fakeVolumes }));
  check('and it is a mac convention rather than a POSIX one',
        !linuxVolumes.includes(slash(fakeVolumes)), JSON.stringify(linuxVolumes));

  // ─── 3 ────────────────────────────────────────────────────────
  console.log('\n3. Windows still opens on the drive letters, in the shape it always had');

  const windows = await listRoots({ platform: 'win32', home, volumes: fakeVolumes });
  check('the roots listing is still the roots listing', windows.path === '' && windows.parent === null,
        JSON.stringify({ path: windows.path, parent: windows.parent }));
  check('no home directory is prepended there', !pathsOf(windows).includes(home),
        JSON.stringify(pathsOf(windows)));
  check('and no `/`, which is not a place on Windows', !pathsOf(windows).includes('/'),
        JSON.stringify(pathsOf(windows)));

  if (process.platform === 'win32') {
    const entries = windows.entries ?? [];
    check('every entry is a drive letter',
          entries.length > 0 && entries.every((entry) => /^[A-Z]:$/.test(entry.name) && /^[A-Z]:\/$/.test(entry.path)),
          JSON.stringify(entries));
    check('including the one this check is running from', pathsOf(windows).includes('C:/'),
          JSON.stringify(pathsOf(windows)));
  } else {
    skip('every entry is a drive letter',
         `this is ${process.platform}, where no drive letter is an accessible directory`);
  }

  // ─── 4 ────────────────────────────────────────────────────────
  console.log('\n4. walking up from an ordinary directory is unchanged');

  const listed = await listDirectories(slash(projectDir));
  check('the directory listed is the one asked for', listed.path === slash(projectDir),
        JSON.stringify(listed.path));
  check('and up goes to its own parent', listed.parent === slash(join(fakeHome, 'projects')),
        JSON.stringify(listed.parent));

  const inHome = await listDirectories(home);
  check('a directory below it lists its subdirectories',
        (inHome.entries ?? []).some((entry) => entry.name === 'projects'),
        JSON.stringify(inHome.entries));

  return listRoots;
}

try {
  let listRoots = null;
  try {
    listRoots = await moduleCases();
  } catch (error) {
    failures++;
    console.error(`\n  FAIL  ${error.message}`);
  }

  // ─── 5 ────────────────────────────────────────────────────────
  console.log('\n5. the running board answers the same, and says which platform it is on');

  const host = await startBoard();
  const health = await get(host.base, '/health');
  check('/health reports the platform', health.body?.platform === process.platform,
        `got ${JSON.stringify(health.body?.platform)} on ${process.platform}`);
  check('and it still says what it always said',
        health.body?.status === 'healthy' && health.body?.service === 'mcp-excalidraw-canvas'
          && typeof health.body?.pid === 'number',
        JSON.stringify(health.body));

  const served = await get(host.base, '/api/fs/directories');
  if (listRoots) {
    const expected = pathsOf(await listRoots());
    check('GET /api/fs/directories serves the roots this platform has',
          served.status === 200 && JSON.stringify(pathsOf(served.body)) === JSON.stringify(expected),
          `${JSON.stringify(pathsOf(served.body))} — expected ${JSON.stringify(expected)}`);
  } else {
    check('GET /api/fs/directories serves the roots this platform has', false,
          'there is no listRoots to compare the route against');
  }

  // ─── 6 ────────────────────────────────────────────────────────
  console.log('\n6. a board that believes it is on a mac starts a reader in their own home');

  const mac = await startBoard({ platform: 'darwin', home: fakeHome });
  const macHealth = await get(mac.base, '/health');
  check('/health says darwin', macHealth.body?.platform === 'darwin',
        JSON.stringify(macHealth.body?.platform));

  const macRoots = await get(mac.base, '/api/fs/directories');
  check('and the picker opens on the home directory it has',
        pathsOf(macRoots.body)[0] === home, JSON.stringify(pathsOf(macRoots.body)));
  check('with `/` still one click away in the same listing',
        pathsOf(macRoots.body).includes('/'), JSON.stringify(pathsOf(macRoots.body)));

  const linux = await startBoard({ platform: 'linux', home: fakeHome });
  const linuxRoots = await get(linux.base, '/api/fs/directories');
  check('a Linux board does the same', pathsOf(linuxRoots.body)[0] === home,
        JSON.stringify(pathsOf(linuxRoots.body)));
  check('and reports linux', (await get(linux.base, '/health')).body?.platform === 'linux');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(200);
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log(skipped ? `\nall cases passed (${skipped} skipped)` : '\nall cases passed');
