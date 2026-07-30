#!/usr/bin/env node
/**
 * Checks that no check needs a server somebody else started.
 *
 * Eight of them did, and none of them said so in a way a machine could read. Each parsed
 * `--url`, then an environment variable, then fell back to a port `docs/trap-port-3000.md`
 * says can never work on the machine they were written on — so `node
 * scripts/check-docs-endpoint.mjs`, typed the obvious way, could only fail at connect. The
 * convention that made them pass lived in prose: a second, empty canvas started by hand on
 * another port, with a docs directory, an issue agent stub and a `gh` stub set up on it, and
 * a workspace id that was one machine's. Nothing in the repository started that server,
 * nothing named those stubs, and a check that cannot be run is a check nobody runs.
 *
 * So the rule is now the one the rest of the suite already keeps, and this is where it is
 * enforced: with no arguments a check builds its own world and starts its own canvas on a
 * port the kernel just handed out. `--url` survives as an explicit override, because pointing
 * a check at a board you are looking at is a real debugging move — but it is never the
 * default, and the environment gets no vote at all.
 *
 * Two halves, because either alone would pass for the wrong reason. The scan cannot tell a
 * check that starts a server from one that quietly found something to talk to; the runs
 * cannot tell a check that started its own from one that reached a board this machine
 * happens to be running. So the runs happen with a decoy holding both retired ports and the
 * CLI's own canvas-URL variable pointing at a third, all three answering 500 to everything.
 *
 * Every string this scans for is assembled from pieces below rather than written out, so
 * that this file is not itself a hit for the scan it performs and needs no exemption for
 * itself — the same reason `check-port-allocation.mjs` builds its patterns, and it is worth
 * the awkwardness: a scanner that may do what it bans is one edit from being the only file
 * that does. `docs/development-log.md` is exempt for
 * the reason it is exempt from every other rule: it records what was true then, and
 * rewriting history to keep a check green is the wrong direction.
 *
 * Self-contained: it reads tracked files, binds a few loopback sockets and runs the eight
 * checks as child processes. Each of those starts and kills its own canvas, so run
 * `./node_modules/.bin/tsc` first — they read `dist/`.
 *
 * Usage: node scripts/check-no-external-server.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');
const docsDir = join(repoRoot, 'docs');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The eight, by name.
 *
 * A list rather than "every check that mentions `--url`", because what is being asserted is
 * that these eight in particular now run unattended — a check that grows the flag later is
 * held by the scan below either way.
 */
const CONVERTED = [
  'check-collapsible-image.mjs',
  'check-docs-endpoint.mjs',
  'check-implement-block.mjs',
  'check-issue-block.mjs',
  'check-issue-detail.mjs',
  'check-link-customdata.mjs',
  'check-sync-reconcile.mjs',
  'check-workspace-isolation.mjs',
];

/** Assembled, so this file does not contain the strings it is banning. See the banner. */
const DEFAULT_PORT = ['30', '00'].join('');
const RETIRED_PORT = ['38', '38'].join('');
const DEFAULT_TARGET = ['127.0.0.1', DEFAULT_PORT].join(':');
/** One machine's workspace id, hardcoded in two of the eight. */
const OPERATOR_WORKSPACE = ['board', 'tool'].join('-');
/** The CLI's canvas-URL variable, which is the CLI's to read and no check's. */
const URL_VARIABLE = ['EXPRESS', 'SERVER', 'URL'].join('_');

const checkFiles = readdirSync(scriptsDir).filter((name) => /^check-.*\.mjs$/.test(name)).sort();
const checkSources = new Map(
  checkFiles.map((name) => [name, readFileSync(join(scriptsDir, name), 'utf8')]),
);

/**
 * The same file with its comments blanked out, borrowed from `check-tiers.mjs` and borrowed
 * for its reason too: a banner that *explains* one machine's workspace id is history, and
 * `check-shallow-clone.mjs` has to be able to say what `export-board.mjs` used to default to.
 * What may not survive is a check that still *runs* against it.
 *
 * Only the workspace rule reads this. A `Usage:` line naming a target that no longer exists is
 * not history, it is an instruction that fails, so those two are scanned whole.
 */
function code(source) {
  let out = '';
  let mode = 'code';
  for (let i = 0; i < source.length; i++) {
    const here = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (here === '/' && next === '*') { mode = 'block'; i++; continue; }
      if (here === '/' && next === '/') { mode = 'line'; i++; continue; }
      out += here;
    } else if (mode === 'block') {
      if (here === '*' && next === '/') { mode = 'code'; i++; }
      else if (here === '\n') out += here;
    } else if (here === '\n') { mode = 'code'; out += here; }
  }
  return out;
}

const checkCode = new Map([...checkSources].map(([name, source]) => [name, code(source)]));

/** `file:line` for every line of `sources` matching `needle`. */
function hits(sources, needle) {
  const found = [];
  for (const [name, source] of sources) {
    source.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(needle)) found.push(`${name}:${index + 1}`);
    });
  }
  return found;
}

// ─── 1. Nothing implicit decides what a check talks to ────────

console.log(`1. no check falls back to ${DEFAULT_TARGET}`);

check(`the eight are all here (${CONVERTED.length} named)`,
      CONVERTED.every((name) => checkSources.has(name)),
      CONVERTED.filter((name) => !checkSources.has(name)).join(', '));

const defaulted = hits(checkSources, DEFAULT_TARGET);
check('no check carries the unusable default', defaulted.length === 0, defaulted.join(', '));

const fromEnvironment = hits(checkSources, URL_VARIABLE);
check(`and none reads its target out of ${URL_VARIABLE}`, fromEnvironment.length === 0,
      `${fromEnvironment.join(', ')} — a variable exported months ago must not choose the server a check asserts`);

const operator = hits(checkCode, OPERATOR_WORKSPACE);
check('no check hardcodes the maintainer\'s workspace id', operator.length === 0,
      `${operator.join(', ')} — a check registers its own workspace and uses that id`);

console.log(`\n2. the ${RETIRED_PORT} convention is gone from the prose too`);

// Everything the issue's own `grep -rn` would have read: the two documents that carried the
// convention, and every script — `scripts/lib/` included, because that is where the helper
// the eight now share explains itself.
const prose = new Map([
  ['CLAUDE.md', readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')],
  ...readdirSync(docsDir)
    .filter((name) => name.endsWith('.md') && name !== 'development-log.md')
    .map((name) => [`docs/${name}`, readFileSync(join(docsDir, name), 'utf8')]),
  ...readdirSync(scriptsDir, { recursive: true })
    .map((name) => String(name).replace(/\\/g, '/'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => [`scripts/${name}`, readFileSync(join(scriptsDir, name), 'utf8')]),
]);

const retired = hits(prose, RETIRED_PORT);
check(`nothing tells a reader to start a server on ${RETIRED_PORT}`, retired.length === 0,
      retired.join(', '));

// ─── 2. And they run, with nothing to lean on ─────────────────

console.log('\n3. every one of the eight runs with no arguments');

/** Answers everything with a 500, so a check that talked to it fails loudly rather than oddly. */
function decoy(port) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"success":false,"error":"decoy: this is not a canvas"}');
    });
    server.on('error', (error) => resolve({ port, held: false, error, close: () => {} }));
    server.listen(port, '127.0.0.1', () => {
      resolve({ port, held: true, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** Whether anything answers an HTTP request there at all. */
async function answers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

const decoys = [];
for (const port of [DEFAULT_PORT, RETIRED_PORT]) {
  const held = await decoy(Number(port));
  decoys.push(held);
  if (held.held) {
    check(`nothing but a decoy is on ${port}`, true);
  } else {
    // A bind that failed is only a problem if something is answering there: on the machine
    // this was written for, port 3000 cannot be bound at all, which is the trap itself.
    check(`nothing is listening on ${port}`, !(await answers(port)),
          `${held.error?.code ?? held.error} — and something answered, so these runs could not `
          + 'tell a converted check from one talking to a server it did not start');
  }
}

const hijack = await decoy(await freePort());
decoys.push(hijack);

function run(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(scriptsDir, name)], {
      cwd: repoRoot,
      // The one thing added: a target that is not a canvas. A check that still reads the
      // environment finds it and fails; a converted one never looks.
      env: { ...process.env, [URL_VARIABLE]: `http://127.0.0.1:${hijack.port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 240_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, code, output });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ name, code: null, output: `${output}\n${error.message}` });
    });
  });
}

try {
  // Concurrently: each one asks the kernel for its own port, so eight at once collide with
  // nothing, and serially this section would be most of a minute of waiting on health checks.
  const results = await Promise.all(CONVERTED.map((name) => run(name)));
  for (const result of results) {
    check(`${result.name} exits 0 with no server started for it`, result.code === 0,
          `exit ${result.code}\n${result.output.split(/\r?\n/).slice(-14).join('\n')}`);
  }
} finally {
  await Promise.all(decoys.filter((held) => held.held).map((held) => held.close()));
  // The decoys are unref'd only by being closed; give the sockets a moment to go.
  await sleep(50);
}

console.log('');
if (failures) { console.error(`${failures} case(s) failed`); process.exit(1); }
console.log('all cases passed');
