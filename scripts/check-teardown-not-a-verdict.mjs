#!/usr/bin/env node
/**
 * A check that passed every assertion passes, whatever the filesystem does on the way out.
 *
 * `check-board-reads-guard.mjs` went red in a full serial run with **every one of its assertions
 * green** (#472). All five sections printed `ok`, and then the script died in its teardown:
 *
 *     ok    and so is the socket it could have opened
 *     Error: EPERM, Permission denied: …\Temp\check-board-reads-guard-1Rq9P0
 *         at rmSync (node:fs:1236:18)
 *
 * The check starts two canvas servers, and on Windows a killed process's handles on its state
 * directory are released asynchronously, so `rmSync` can arrive while the directory is still
 * locked. Run alone it passed three times out of three; under load it is a lost race.
 *
 * That is the worst shape a red run has. The failure output says nothing is wrong, so the next
 * person to see it reads the whole log to learn that, and exit code and verdict have come apart.
 * A teardown is housekeeping: `run-checks.mjs` already reaps the `check-*` directories left in
 * `os.tmpdir()`, so a directory that could not be removed costs one directory until the next run
 * and nothing else. It must not cost a verdict.
 *
 * Three sections:
 *
 *   1. **the control** — a fixture with the old shape, one green assertion and a bare `rmSync`
 *      in its `finally`, dies exactly as the report says when the directory cannot be removed.
 *      Without it, section 2 could be green because the hold never happened.
 *   2. **the real check**, run with the removal of its own working directory refused, still
 *      prints every `ok`, still reaches its last section, and still exits 0.
 *   3. **the sweep** — no other check that starts a canvas server can fail on its teardown
 *      either, so the tenth one written after this cannot quietly be the next one.
 *
 * **How the directory is held.** Not by taking a lock, which is a different answer on every
 * platform and no answer at all on Linux, but at the boundary that matters: a `module.register()`
 * resolve hook maps `node:fs` to a shim whose `rmSync` throws `EPERM` for that one directory and
 * forwards everything else. So the check under test runs its real sections against real servers,
 * and only the one call the report died in is answered the way Windows answered it. Retries do
 * not get past a hold that outlives them, which is why the contract asserted here is "cannot
 * change the verdict" rather than "usually succeeds".
 *
 * Self-contained: it builds its hooks and its fixture in a temp directory and runs
 * `dist/server.js` only by way of the check it drives. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-teardown-not-a-verdict.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canvasEnvironment } from './lib/spawn-canvas.mjs';
import { unguardedTeardowns } from './lib/teardown-scan.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = join(repoRoot, 'scripts');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const workDir = mkdtempSync(join(tmpdir(), 'check-teardown-not-a-verdict-'));

// ─── The hold, as a loader hook ───────────────────────────────

/**
 * `node:fs` with one call answered the way a locked directory answers it.
 *
 * `export *` carries every other export through unchanged, and the explicit `rmSync` below wins
 * over the star for that one name. The refusal is logged so the caller can prove the hold
 * happened at all, and so the directory that survived it can be removed for real afterwards.
 */
writeFileSync(join(workDir, 'held-fs.mjs'), `
// The real one under a name of its own: the export below shadows 'rmSync' for every importer,
// including this file, so the forwarding call cannot be spelled with the exported name.
import { appendFileSync, rmSync as realRmSync } from 'node:fs';

export * from 'node:fs';
export { default } from 'node:fs';

export function rmSync(path, options) {
  const target = String(path);
  if (process.env.HELD_DIRECTORY && target.includes(process.env.HELD_DIRECTORY)) {
    appendFileSync(process.env.HELD_LOG, target + '\\n');
    const error = new Error('EPERM, Permission denied: ' + target);
    error.errno = 1;
    error.code = 'EPERM';
    error.syscall = 'rm';
    error.path = target;
    throw error;
  }
  return realRmSync(path, options);
}
`.trimStart(), 'utf8');

writeFileSync(join(workDir, 'fs-hooks.mjs'), `
const shim = new URL('./held-fs.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // The shim's own 'node:fs' has to be the real one, or it would resolve to itself.
  if ((specifier === 'node:fs' || specifier === 'fs') && context.parentURL !== shim) {
    return { url: shim, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`.trimStart(), 'utf8');

/**
 * Run a script with the hook in place. `argv[1]` is the script's own path, the way Node would
 * have set it, so anything reading its own arguments sees what it always sees.
 */
writeFileSync(join(workDir, 'run-held.mjs'), `
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./fs-hooks.mjs', import.meta.url).href);

const target = process.argv[2];
process.argv.splice(1, 2, target);
await import(pathToFileURL(target).href);
`.trimStart(), 'utf8');

/** The reported shape, with nothing else in it: one green assertion, then a bare teardown. */
writeFileSync(join(workDir, 'old-shape.mjs'), `
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'check-teardown-control-'));

try {
  writeFileSync(join(workDir, 'state.json'), '{}', 'utf8');
  console.log('  ok    the one assertion this fixture has');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log('All cases passed');
`.trimStart(), 'utf8');

const runner = join(workDir, 'run-held.mjs');

/** Run `script` with removals of directories whose name contains `held` refused. */
function runHolding(script, held, logName) {
  const log = join(workDir, logName);
  writeFileSync(log, '', 'utf8');
  const result = spawnSync(process.execPath, [runner, script], {
    cwd: repoRoot,
    env: canvasEnvironment({ HELD_DIRECTORY: held, HELD_LOG: log }),
    encoding: 'utf8',
    timeout: 180000,
  });
  const refused = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, refused };
}

/** A directory the hold kept alive, removed for real now that nothing is watching it. */
function removeForReal(paths) {
  for (const path of new Set(paths)) {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* the next run's reaper collects it */ }
  }
}

try {
  // ─── 1. The control: the old shape dies on its teardown ───

  console.log('\n1. the reported shape — assertions green, then dead in the teardown');

  const control = runHolding(join(workDir, 'old-shape.mjs'), 'check-teardown-control-', 'control.log');
  check('the fixture\'s assertion passed', control.output.includes('ok    the one assertion'),
        control.output.slice(0, 200));
  check('and its removal was refused, which is the hold this check applies',
        control.refused.length === 1, JSON.stringify(control.refused));
  check('it never reached its own last line', !control.output.includes('All cases passed'),
        control.output.slice(0, 200));
  check('it died in rmSync', /EPERM[\s\S]*rmSync|rmSync[\s\S]*EPERM/.test(control.output),
        control.output.slice(-300));
  check('and the run is red with nothing wrong in it', control.status !== 0, `exit ${control.status}`);
  removeForReal(control.refused);

  // ─── 2. The check the report was written about ───

  console.log('\n2. and check-board-reads-guard.mjs, held the same way, is green all the way out');

  const guard = join(scriptsDir, 'check-board-reads-guard.mjs');
  check('dist/server.js is built, so the check below has a server to start',
        existsSync(join(repoRoot, 'dist', 'server.js')), 'run ./node_modules/.bin/tsc first');

  const held = runHolding(guard, 'check-board-reads-guard-', 'guard.log');
  check('its working directory could not be removed', held.refused.length >= 1,
        JSON.stringify(held.refused));
  check('every one of its assertions is green', !/^\s*FAIL\s/m.test(held.output),
        held.output.split('\n').filter((line) => /FAIL/.test(line)).join(' | ').slice(0, 300));
  check('it reached its last section and said so',
        held.output.includes('All cases passed'), held.output.slice(-400));
  check('and the run exits 0, because a teardown is not a verdict', held.status === 0,
        `exit ${held.status} — ${held.output.slice(-400)}`);
  removeForReal(held.refused);
} finally {
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* the same race this check is about; run-checks.mjs reaps it */ }
}

// ─── 3. The sweep ─────────────────────────────────────────────

console.log('\n3. and no other check that starts a canvas server can fail on its teardown');

const unguarded = unguardedTeardowns(scriptsDir);
check('every removal of a directory a server ran out of is inside a try/catch',
      unguarded.length === 0,
      unguarded.map(({ file, line }) => `${file}:${line}`).join(', '));

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: a check that could not tidy up still reports what it measured.');
