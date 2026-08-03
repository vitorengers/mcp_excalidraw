#!/usr/bin/env node
/**
 * Checks that a server configured with nothing at all still finds the two things this build
 * ships beside itself: the shared library and the tool's own documentation.
 *
 * Both used to be the install directory retyped by hand. `EXCALIDRAW_LIBRARY` and
 * `EXCALIDRAW_DOCS_DIR` were read as bare paths with no default, and the `.env` in this
 * repository pointed each at an absolute path inside this checkout — so the features worked for
 * whoever wrote that file and for nobody else. Neither absence says anything either:
 * `GET /api/library` answers `success: true` with an empty `libraryItems` and an empty `errors`,
 * because with no sources the reporting loop never runs, and nothing anywhere reports the
 * library missing until the `+` on the notes column finds no template to build a draft from.
 *
 * Three cases, and the third is not about the server at all:
 *
 * 1. **The library.** `docs/blocks.excalidrawlib` is the only place an issue block comes from —
 *    `customData.kind = "issue"` is not something any Excalidraw control sets — so the assertion
 *    is an item carrying one, not merely a non-empty array.
 * 2. **The documentation.** A key that exists in the tool's own `docs/` and is *not* one of the
 *    `TOOL_DOC_KEYS`, so what it proves is the `DOCS_DIR` default rather than the tool-key path
 *    that `check-tool-doc-keys.mjs` covers.
 * 3. **The packaging.** A `__dirname` default resolves to a path that exists in a git clone and
 *    not in an `npm i -g` or an `npx` install unless the `files` whitelist carries it — which is
 *    the worst of the three outcomes, because it works in development. `docs/*.md` does not
 *    match an `.excalidrawlib`, so the file is named in `files` on its own and this case is what
 *    keeps it there. `npm pack --dry-run --json` is npm's own answer about what it would put in.
 *
 * Self-contained and offline: it starts its own canvas on a port the kernel just handed out,
 * with every inherited `EXCALIDRAW_*` stripped by `spawn-canvas.mjs`, and kills it. No browser,
 * no registry round trip. `npm pack --dry-run` runs `prepack`, which this package does not
 * define; nothing is built here, so a missing `dist/` fails this the way it stops the runner.
 *
 * Usage: node scripts/check-shipped-defaults.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCanvas, repoRoot } from './lib/spawn-canvas.mjs';

/**
 * A document the tool ships that describes no block it draws.
 *
 * `running` is deliberately not in `TOOL_DOC_KEYS`: a key that is would resolve against the
 * tool's `docs/` through the other path entirely, and this case would pass with the default
 * still missing.
 */
const PLAIN_TOOL_DOC_KEY = 'running';

/** The file the `files` whitelist has to name, as `npm pack` reports it. */
const PACKAGED_LIBRARY = 'docs/blocks.excalidrawlib';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** `npm` is a `.cmd` shim on Windows, which node will not spawn without a shell. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
  console.error('dist/server.js is missing — build first: ./node_modules/.bin/tsc && ./node_modules/.bin/vite build');
  process.exit(1);
}

// Its own, so a throwaway server cannot write a pidfile or a resolved-port file into the
// operator's real state directory and point `status` and `stop` at a board that is gone.
const stateHome = mkdtempSync(join(tmpdir(), 'check-shipped-defaults-'));

const canvas = await openCanvas({
  env: { LOG_LEVEL: 'error', EXCALIDRAW_STATE_HOME: stateHome },
});

async function get(path) {
  const response = await fetch(`${canvas.base}${path}`);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

try {
  console.log(`canvas: ${canvas.base} — no EXCALIDRAW_LIBRARY, no EXCALIDRAW_DOCS_DIR`);

  console.log('\n1. the shared library is the one this build ships');
  const library = await get('/api/library');
  check('/api/library answers 200', library.status === 200, `got ${library.status}`);
  const items = library.body.libraryItems ?? [];
  check('it returns at least one item', items.length > 0,
        'an empty library is what an unset EXCALIDRAW_LIBRARY used to mean');
  check('one of its items carries customData.kind = "issue"',
        items.some((item) => (item?.elements ?? [])
          .some((element) => element?.customData?.kind === 'issue')),
        `${items.length} item(s), none of them an issue block — the + has nothing to drop`);
  check('and it reports no library error', (library.body.errors ?? []).length === 0,
        (library.body.errors ?? []).join('; '));

  console.log("\n2. the tool's own documentation resolves");
  const doc = await get(`/api/docs/${PLAIN_TOOL_DOC_KEY}`);
  check(`/api/docs/${PLAIN_TOOL_DOC_KEY} answers 200`, doc.status === 200,
        `got ${doc.status} ${doc.body.code ?? ''} — ${doc.body.error ?? ''}`.trim());
  check('with success: true', doc.body.success === true, JSON.stringify(doc.body).slice(0, 300));
  check('and markdown that is the shipped document',
        typeof doc.body.markdown === 'string' && doc.body.markdown.length > 0,
        `markdown was ${typeof doc.body.markdown}`);

  console.log('\n3. the packaged copy carries the library');
  // Under a shell the whole invocation goes as one string: node deprecates an `args` array with
  // `shell: true`, and the deprecation notice would land in the middle of this check's output.
  const useShell = process.platform === 'win32';
  const packed = useShell
    ? spawnSync(`${NPM} pack --dry-run --json`, { cwd: repoRoot, encoding: 'utf8', shell: true })
    : spawnSync(NPM, ['pack', '--dry-run', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  check('npm pack --dry-run --json succeeds', packed.status === 0,
        packed.error?.message ?? (packed.stderr ?? '').slice(-600));

  // npm writes notices to stderr, but a stray line on stdout would still break a bare parse.
  const stdout = packed.stdout ?? '';
  const start = stdout.indexOf('[');
  let manifest = null;
  try {
    manifest = start === -1 ? null : JSON.parse(stdout.slice(start));
  } catch (error) {
    check('its output is JSON', false, error.message);
  }
  const listed = (manifest?.[0]?.files ?? []).map((file) => file.path);
  check('it lists files at all', listed.length > 0, stdout.slice(0, 400));
  check(`it lists ${PACKAGED_LIBRARY}`, listed.includes(PACKAGED_LIBRARY),
        'the files whitelist leaves it out, so the default resolves in a clone and nowhere else');
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  failures++;
} finally {
  canvas.stop();
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(stateHome, { recursive: true, force: true, maxRetries: 5 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
