#!/usr/bin/env node
/**
 * Checks that an npm-installed copy finds its own library and its own fonts.
 *
 * Everything this repository runs, it runs out of a source checkout, where two paths happen to
 * resolve for reasons that have nothing to do with either of them:
 *
 * 1. **The shared library.** `docs/blocks.excalidrawlib` is the only place an issue block comes
 *    from — `customData.kind = "issue"` is not something any Excalidraw control sets — and
 *    `docs/shared-library.md` says every board without a library of its own depends on this one
 *    file. The `files` whitelist shipped `docs/*.md`, and an `.excalidrawlib` is not an `.md`, so
 *    an installed copy had no such file; nothing defaulted `EXCALIDRAW_LIBRARY` either, so the
 *    route offered no shared source at all. The `+` on the notes column then finds no template
 *    and answers a toast, which `docs/project-board.md` records happening once already on a
 *    machine that merely had the variable unset.
 * 2. **The canvas fonts.** The mount was `path.join(__dirname, '../node_modules/@excalidraw/…')`.
 *    In a checkout `__dirname` is `<repo>/dist` and the directory is one level up; in an
 *    installed copy it points inside the package's own — empty — `node_modules`, while npm has
 *    hoisted `@excalidraw/excalidraw` to the consumer root. `frontend/index.html` says what that
 *    costs: `window.EXCALIDRAW_ASSET_PATH = '/assets/'` exists so the faces come from this
 *    server, with `https://esm.sh` kept only as the second `src()` of each one.
 *
 * Both are the same defect wearing two hats — an asset resolved by where the source tree happens
 * to sit — so one check decides both: an installed copy either resolves its own runtime assets
 * or it does not.
 *
 * How the installed copy is built:
 *
 *   - `npm pack` produces a real tarball from the real `files` whitelist, and `tar` lists and
 *     extracts it. The manifest `npm pack --json` prints is npm's own opinion about what it put
 *     in; the archive is the thing that reaches a consumer;
 *   - the tarball is unpacked to `<consumer>/node_modules/@vitorengers/vibemaxxing`, and every
 *     top-level entry of *this* repository's `node_modules` is linked into
 *     `<consumer>/node_modules` beside it. That is the hoisted layout npm produces, and it is
 *     materialised rather than fetched because a check that needs the registry is a check that
 *     fails on a train. What the case turns on is where `@excalidraw/excalidraw` sits relative
 *     to the package, and a link puts it exactly where npm would;
 *   - the package's own `node_modules` is asserted absent, so a mount that answers cannot have
 *     come from the old relative path;
 *   - a second consumer is built with the `@excalidraw` link left out. That is the fourth case:
 *     nothing to resolve, one warning, and a server that still comes up.
 *
 * `EXCALIDRAW_STATE_HOME` is the one variable set on purpose, against the definition of done's
 * "no `EXCALIDRAW_*`": the pidfile and the resolved-port file live under it, and a throwaway
 * server writing those into the operator's real state directory would point `status` and `stop`
 * at a board that no longer exists. Neither of the two things under test reads it.
 *
 * Offline and self-contained apart from `npm` and `tar`, both of which ship with the toolchain
 * this repository already requires. No registry round trip, no browser. `npm pack` runs
 * `prepack`, not `prepublishOnly` — nothing is built here, so a missing `dist/` fails this the
 * same way it stops the runner, rather than being quietly made.
 *
 * Usage: node scripts/check-package-install.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort } from './lib/free-port.mjs';
import { repoRoot, startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `npm` is a `.cmd` shim on Windows, which node will not spawn without a shell. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const useShell = process.platform === 'win32';
const quoted = (argument) => (useShell && /\s/.test(argument) ? `"${argument}"` : argument);

function run(command, args, cwd, extra = {}) {
  // Under a shell the whole invocation goes as one string: node deprecates an `args` array with
  // `shell: true` — it concatenates rather than escapes — and the deprecation notice on stderr
  // would otherwise land in the middle of this check's own output.
  const result = useShell
    ? spawnSync([command, ...args.map(quoted)].join(' '), { cwd, encoding: 'utf8', shell: true, ...extra })
    : spawnSync(command, args, { cwd, encoding: 'utf8', ...extra });
  return {
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error ? String(result.error.message) : '',
  };
}

/** The three files the definition of done names, as they appear inside the archive. */
const REQUIRED_IN_TARBALL = [
  'package/docs/blocks.excalidrawlib',
  'package/dist/server.js',
  'package/dist/frontend/index.html',
];

/** A face the canvas actually asks for. Content-hashed, so it is read rather than written out. */
const FONT_FAMILY = 'Excalifont';
const fontsRoot = join(repoRoot, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts');

const workDir = mkdtempSync(join(tmpdir(), 'check-package-install-'));
const running = [];

try {
  if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
    console.error('dist/server.js is missing — build first: ./node_modules/.bin/tsc && ./node_modules/.bin/vite build');
    process.exit(1);
  }

  // ─── 0. A tarball with the runtime assets in it ────────────────
  console.log('0. npm pack');

  const packed = run(NPM, ['pack', '--pack-destination', workDir], repoRoot);
  check('npm pack succeeds', packed.status === 0, packed.error || packed.out.slice(-800));

  const tarballs = existsSync(workDir)
    ? readdirSync(workDir).filter((name) => name.endsWith('.tgz'))
    : [];
  check('it wrote one tarball', tarballs.length === 1, tarballs.join(', ') || 'none');
  if (tarballs.length !== 1) {
    console.error('\nwithout a tarball there is no installed copy to ask anything of');
    process.exit(1);
  }
  const tarball = tarballs[0];

  const listed = run('tar', ['-tzf', tarball], workDir);
  check('tar reads the archive', listed.status === 0, listed.error || listed.out.slice(-400));
  const entries = new Set(listed.out.split(/\r?\n/).map((line) => line.trim().replace(/\/$/, '')));
  for (const path of REQUIRED_IN_TARBALL) {
    check(`the tarball carries ${path.replace(/^package\//, '')}`, entries.has(path),
          'the files whitelist leaves it out of every installed copy');
  }

  // ─── 1. An installed copy, laid out the way npm lays one out ───
  console.log('\n1. the tarball installed into an empty project');

  const unpacked = join(workDir, 'unpacked');
  mkdirSync(unpacked, { recursive: true });
  const extracted = run('tar', ['-xzf', join('..', tarball)], unpacked);
  check('tar extracts the archive', extracted.status === 0 && existsSync(join(unpacked, 'package', 'package.json')),
        extracted.error || extracted.out.slice(-400));
  if (!existsSync(join(unpacked, 'package', 'package.json'))) {
    console.error('\nnothing was unpacked, so there is no server to start');
    process.exit(1);
  }

  const sourceModules = join(repoRoot, 'node_modules');
  const hoisted = readdirSync(sourceModules).filter((name) => !name.startsWith('.'));

  /**
   * A consumer project holding the packed copy plus a hoisted dependency tree.
   *
   * `without` names a top-level entry to leave out, which is how the unresolvable case is built:
   * a real installation missing one package, rather than a stub pretending to be one.
   */
  function install(name, { without = null } = {}) {
    const consumer = join(workDir, name);
    const modules = join(consumer, 'node_modules');
    mkdirSync(join(modules, '@vitorengers'), { recursive: true });
    writeFileSync(join(consumer, 'package.json'),
                  JSON.stringify({ name, version: '1.0.0', private: true }, null, 2), 'utf8');
    const installed = join(modules, '@vitorengers', 'vibemaxxing');
    cpSync(join(unpacked, 'package'), installed, { recursive: true });
    for (const entry of hoisted) {
      if (entry === without) continue;
      symlinkSync(join(sourceModules, entry), join(modules, entry), 'junction');
    }
    return { consumer, installed, modules };
  }

  const full = install('consumer');

  check('the package brought no node_modules of its own',
        !existsSync(join(full.installed, 'node_modules')),
        'the old relative path could resolve for the wrong reason');
  check('@excalidraw/excalidraw is hoisted to the consumer root',
        existsSync(join(full.modules, '@excalidraw', 'excalidraw', 'package.json')),
        'without it, the fonts case is not being asked');

  const family = existsSync(join(fontsRoot, FONT_FAMILY))
    ? readdirSync(join(fontsRoot, FONT_FAMILY)).filter((file) => file.endsWith('.woff2'))
    : [];
  check(`the Excalidraw package ships a ${FONT_FAMILY} face`, family.length > 0, fontsRoot);
  const fontPath = `/assets/fonts/${FONT_FAMILY}/${family[0]}`;

  /** One packaged server, health-checked, with everything it said kept for the report. */
  async function startPackaged(where) {
    const server = startCanvas({
      port: await freePort(),
      cwd: where.consumer,
      script: join(where.installed, 'dist', 'server.js'),
      env: { EXCALIDRAW_STATE_HOME: join(workDir, `state-${running.length}`) },
    });
    running.push(server);
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.child.exitCode !== null) return { ...server, up: false };
      try {
        if ((await fetch(`${server.base}/health`)).ok) return { ...server, up: true };
      } catch { /* not up yet */ }
      await sleep(100);
    }
    return { ...server, up: false };
  }

  // ─── 2. It resolves its own library and its own fonts ──────────
  console.log('\n2. the installed copy with no EXCALIDRAW_LIBRARY set');

  const server = await startPackaged(full);
  check('the packaged server answers /health', server.up, server.read().slice(-1200));

  let library = null;
  if (server.up) {
    const response = await fetch(`${server.base}/api/library`);
    check('/api/library answers 200', response.status === 200, `status ${response.status}`);
    library = await response.json().catch(() => null);
  }
  const items = library?.libraryItems ?? [];
  check('the shared library reaches an installed copy', items.length > 0,
        JSON.stringify(library ?? {}).slice(0, 400));
  check('one of its items is an issue block',
        items.some((item) => (item?.elements ?? [])
          .some((element) => element?.customData?.kind === 'issue')),
        `${items.length} item(s), none with customData.kind = "issue" — the + has nothing to drop`);
  check('and it reports no library error', (library?.errors ?? []).length === 0,
        (library?.errors ?? []).join('; '));

  let fontResponse = null;
  if (server.up) fontResponse = await fetch(`${server.base}${fontPath}`);
  check(`${fontPath} answers 200`, fontResponse?.status === 200,
        `status ${fontResponse?.status ?? 'no answer'} — the canvas falls back to esm.sh`);
  const bytes = fontResponse?.status === 200
    ? new Uint8Array(await fontResponse.arrayBuffer())
    : new Uint8Array();
  check('and it is the woff2 itself rather than a page about it',
        bytes.length > 1000 && String.fromCharCode(...bytes.slice(0, 4)) === 'wOF2',
        `${bytes.length} byte(s)`);

  // ─── 3. And says so, once, when there is nothing to resolve ────
  console.log('\n3. the same copy where @excalidraw/excalidraw cannot be resolved');

  const bare = install('consumer-no-excalidraw', { without: '@excalidraw' });
  const bareServer = await startPackaged(bare);
  check('the server starts anyway', bareServer.up, bareServer.read().slice(-1200));

  const warnings = bareServer.read().split(/\r?\n/)
    .filter((line) => /assets\/fonts/.test(line) && /warn/i.test(line));
  check('it logs exactly one warning about the fonts', warnings.length === 1,
        warnings.length === 0
          ? `nothing was said:\n${bareServer.read().slice(-1200)}`
          : `${warnings.length}:\n${warnings.join('\n')}`);

  const bareFont = bareServer.up ? await fetch(`${bareServer.base}${fontPath}`) : null;
  check(`${fontPath} answers 404 there`, bareFont?.status === 404,
        `status ${bareFont?.status ?? 'no answer'} — a mount over a directory that is not there`);
} finally {
  for (const server of running) server.stop();
  // The links are junctions into this repository's own node_modules. `rmSync` does not follow
  // them, but leaving the removal to a later run would be a bad thing to be wrong about, so it
  // is given room to retry rather than forced.
  await sleep(300);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
