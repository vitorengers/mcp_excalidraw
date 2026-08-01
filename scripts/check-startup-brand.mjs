#!/usr/bin/env node
/**
 * Checks that the line a start writes names this product, and still says where the board is.
 *
 * `src/server.ts` opened every run with `POC server running on http://<host>:<port>` — the last
 * `POC` anywhere under `src/` or `frontend/`, three years after the proof of concept it was named
 * for shipped. #296 (PR #393) renamed the two strings a *reader* meets on the page, the browser
 * tab and the bar, and deliberately left this one: it is a log line rather than something on the
 * canvas, and that issue scoped itself to the latter. `check-brand-strings-browser.mjs` is where
 * the rendered half is held; this is the half nothing renders.
 *
 * Two things, and the second is why this is not a grep:
 *
 *   1. **no tracked source still says it.** Every file `git ls-files` reports under `src/` and
 *      `frontend/`, read and matched against `/\bPOC\b/`. A rule written over the tracked set
 *      rather than over one file is what makes the word gone rather than moved: the string is
 *      cheap to reintroduce in a new module, and a check pinned to `server.ts` would not notice.
 *   2. **and the running board still says where it is.** A rename is one edit away from dropping
 *      the host and the port with it, and those two are the only things in that line nobody can
 *      work out from anywhere else — a board on a port the kernel handed out is a board whose
 *      address is in this line or nowhere. So the server is *started*, and the line is read back
 *      off its log with the port this check chose in it.
 *
 * **The line is `info`, so it is not on the console** and cannot be read off the child's stderr:
 * the logger's Console transport is `warn`-and-above whatever `LOG_LEVEL` says (`src/utils/
 * logger.ts`), and only the File transport takes `info`. `LOG_FILE_PATH` is therefore set to a
 * throwaway file, which is the only way to read this line at all — and the last case asserts the
 * level has not moved, because a startup line promoted to `warn` would be a paragraph of stderr
 * under every check in this directory.
 *
 * The product's name is taken from `package.json`'s description, the way `core/version.ts`
 * derives `productName()` — the file that owns the name, rather than a literal here that would
 * have to be found by hand at the next rename. `check-brand-strings-browser.mjs` holds the
 * rendered title to `board.config.json` for the same reason.
 *
 * Self-contained: one throwaway server on a port the kernel just handed out, its own log file
 * under the system temporary directory, killed and deleted at the end. Run `npm run build`
 * first — it starts `dist/server.js`.
 *
 * Usage: node scripts/check-startup-brand.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The word this item is about, in the one form it was ever written. */
const STALE = /\bPOC\b/;

/**
 * The product's name, from the file that owns it.
 *
 * `core/version.ts` reads the leading segment of `package.json`'s description — "VibeMaxxing — an
 * Excalidraw workbench for AI coding agents" — and this re-derives it rather than importing it,
 * so a `productName()` that started answering something else is a failure here and not an
 * agreement by construction.
 */
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const PRODUCT = String(pkg.description ?? '').split(/[—–:]|\s-\s/)[0].trim();

// ─── 1. The word is gone from the sources ─────────────────────

console.log('1. no tracked source under src/ or frontend/ still says POC');

check('the product has a name in package.json to look for', PRODUCT.length > 0,
      JSON.stringify(pkg.description ?? null));

const tracked = execFileSync('git', ['ls-files', '-z', 'src', 'frontend'],
                             { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean);
check('there are tracked sources to read', tracked.length > 0,
      'git ls-files reported nothing — this is not a checkout of the repository');

const offenders = [];
for (const relative of tracked) {
  const absolute = join(repoRoot, relative);
  if (!existsSync(absolute)) continue;      // tracked but deleted in the working tree
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (STALE.test(line)) offenders.push(`${relative}:${index + 1}  ${line.trim().slice(0, 120)}`);
  });
}
check(`none of the ${tracked.length} tracked files matches ${STALE}`, offenders.length === 0,
      `\n        ${offenders.join('\n        ')}`);

// ─── 2. And a real start says the product, the host and the port ──

const workDir = mkdtempSync(join(tmpdir(), 'check-startup-brand-'));
const logPath = join(workDir, 'board.log');
const port = await freePort();

const server = startCanvas({
  port,
  env: {
    // The whole reason this check starts a server rather than reading a string out of the
    // source: the line is written here and nowhere a reader could otherwise reach it.
    LOG_FILE_PATH: logPath,
    LOG_LEVEL: 'info',
  },
});

let exit = null;
server.child.on('exit', (code, signal) => { exit = { code, signal }; });

const logText = () => {
  try { return readFileSync(logPath, 'utf8'); } catch { return ''; }
};

try {
  console.log('\n2. a start writes the address it came up on, under the product\'s name');

  // The address rather than any particular wording, because "still carries the host and port" is
  // the half of this that a rename must not cost, and a finder written on the wording would go
  // looking for the sentence the rename just replaced.
  const ADDRESS = `http://127.0.0.1:${port}`;
  let text = '';
  for (let attempt = 0; attempt < 300 && !exit; attempt++) {
    text = logText();
    if (text.includes(ADDRESS)) break;
    await sleep(100);
  }

  check('the server is still running', !exit,
        exit ? `it exited ${JSON.stringify(exit)}:\n${server.read()}` : '');
  const startupLine = text.split(/\r?\n/).find((line) => line.includes(ADDRESS)) ?? null;
  check(`the start logged a line carrying ${ADDRESS}`, Boolean(startupLine),
        `nothing in ${logPath} after 30s:\n${text || '(the log file is empty)'}\n${server.read()}`);

  if (startupLine) {
    console.log(`      (${JSON.stringify(startupLine)})`);
    check(`it names the product — ${JSON.stringify(PRODUCT)}`, startupLine.includes(PRODUCT),
          JSON.stringify(startupLine));
    check(`and it does not match ${STALE}`, !STALE.test(startupLine), JSON.stringify(startupLine));
  }

  check(`nothing else the start wrote matches ${STALE} either`, !STALE.test(text),
        JSON.stringify(text.split(/\r?\n/).filter((line) => STALE.test(line))));

  // The line beside it, which is the pattern the renamed one had to keep: same sentence, same
  // address, `ws://`. A rename that took the port out of one of them would leave the other.
  check(`the websocket line still carries ws://127.0.0.1:${port}`,
        text.includes(`ws://127.0.0.1:${port}`),
        JSON.stringify(text.split(/\r?\n/).filter((line) => /ws:\/\//.test(line))));

  // And where it is not: `info` reaches the file only. A line promoted to `warn` would pass every
  // case above and print itself under all ~230 checks in this directory.
  check('the line stayed off the console, where an info line does not go',
        !server.read().includes(ADDRESS),
        JSON.stringify(server.read().slice(0, 400)));
} finally {
  server.stop();
  await sleep(300);
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    console.warn(`  note  ${workDir} is still there — ${error.code ?? error.message}`);
  }
}

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('all cases passed');
