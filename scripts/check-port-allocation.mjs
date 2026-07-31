#!/usr/bin/env node
/**
 * Checks that no `scripts/check-*.mjs` invents its own port number.
 *
 * Ninety-six of them used to compute the port they listen on from a base number plus the
 * process id, taken modulo the width of a band. That is not an allocation — it is a guess inside
 * a band, and nothing coordinated the bands. `check-agent-stream-render-browser.mjs` took
 * 35700-35899 for its server and 36100-36299 for Chrome, which is exactly
 * `check-terminal-paper-browser.mjs`'s server range, whose own CDP range 36500-36699 sits inside
 * `check-board-subsections-browser.mjs`'s server range of 36400-36699, with
 * `check-board-sharpness-browser.mjs` at 36100-36279 in the same band. Two dozen more took a
 * second server or a CDP port by adding a small number to the first one, with no probe at all.
 * Two checks running at once could collide, and the failure read as a bug in the feature rather
 * than in the arithmetic.
 *
 * The band was never the fix, because a band is only correct while nothing else is running.
 * `scripts/lib/free-port.mjs` asks the kernel, which is the only thing that actually knows.
 *
 * The scan below deliberately builds its own pattern out of pieces, so that this file does not
 * contain the expression it is banning and does not have to exempt itself — a scanner with an
 * exemption for itself is one edit away from being the only file that may do the wrong thing.
 *
 * Self-contained: it reads the check scripts and binds a few loopback sockets. No server, no
 * browser, no network.
 *
 * Usage: node scripts/check-port-allocation.mjs
 *
 * Tier: fast
 */

import { createServer } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort, freePorts } from './lib/free-port.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const checkFiles = readdirSync(scriptsDir)
  .filter((name) => /^check-.*\.mjs$/.test(name))
  .sort();

const sources = new Map(
  checkFiles.map((name) => [name, readFileSync(join(scriptsDir, name), 'utf8')]),
);

function scan(pattern) {
  const hits = [];
  for (const [name, source] of sources) {
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(pattern).test(lines[i])) hits.push(`${name}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  return hits;
}

// ─── Nobody derives a port from the process id ────────────────

console.log('\nPort numbers nobody allocated');

// Assembled rather than written out, so this file is not itself a hit.
const PID_MODULO = ['process', '\\.', 'pid', '\\s*%'].join('');
const pidPorts = scan(PID_MODULO);
check('no check computes a port from process.pid', pidPorts.length === 0,
  pidPorts.length ? `${pidPorts.length} site(s):\n      ${pidPorts.slice(0, 12).join('\n      ')}` : '');

// The sibling shape: a second server, or a CDP port, taken as `<the first one> + n`. It is free
// only by assumption, and the assumption is the same one the bands made.
const DERIVED = ['\\b\\w*(?:PORT|Port|port)\\s*\\+\\s*\\d+'].join('');
const derivedPorts = scan(DERIVED);
check('no check takes a second port by adding to the first', derivedPorts.length === 0,
  derivedPorts.length ? `${derivedPorts.length} site(s):\n      ${derivedPorts.slice(0, 12).join('\n      ')}` : '');

// ─── Every check that listens asks for its port ───────────────

console.log('\nWhere the ports come from instead');

const spawnsSomething = (source) =>
  /spawn\(process\.execPath/.test(source) || /startCanvas\(/.test(source)
  || /openCanvas\(/.test(source) || /\.listen\(/.test(source);

/**
 * A spawn is not automatically a listener. `check-bin-identity.mjs` starts `dist/bin.js` in MCP
 * stdio mode and speaks JSON-RPC down a pipe: no socket, no port, nothing to allocate — and
 * asking it to import `free-port.mjs` would be a helper it never calls, which is worse than the
 * rule catching nothing.
 *
 * What separates the two is whether the source names a port at all. A check that reaches a
 * server it spawned has to say where — a `PORT`, a loopback address, the canvas-URL variable —
 * so a file that says none of them is not inventing a port number whatever it spawns.
 *
 * That variable's name is assembled rather than written out, the way `PID_MODULO` above is:
 * `check-no-external-server.mjs` reads a check that spells it out as one choosing its own
 * target from the environment, and this file only describes the shape of one.
 */
const URL_VARIABLE = ['EXPRESS', 'SERVER', 'URL'].join('_');
const NAMES_A_PORT =
  new RegExp(`\\bports?\\b|127\\.0\\.0\\.1|localhost|\\[::1\\]|${URL_VARIABLE}`, 'i');
const listensOnAPort = (source) => spawnsSomething(source) && NAMES_A_PORT.test(source);

check('a stdio spawn that names no port is not counted as a listener',
  !listensOnAPort('const child = spawn(process.execPath, [join(root, "dist", "bin.js")]);'));
check('a spawn that hands a port over is',
  listensOnAPort('const child = spawn(process.execPath, [server], { env: { PORT: String(port) } });'));

const listeners = [...sources].filter(([, source]) => listensOnAPort(source));
const withoutHelper = listeners
  .filter(([, source]) => !/from '\.\/lib\/free-port\.mjs'/.test(source)
    && !/from '\.\/lib\/spawn-canvas\.mjs'/.test(source))
  .map(([name]) => name);
check('every check that opens a listening socket goes through scripts/lib',
  withoutHelper.length === 0,
  withoutHelper.length ? `${withoutHelper.length}: ${withoutHelper.slice(0, 12).join(', ')}` : '');

const spawnDirect = [...sources]
  .filter(([, source]) => /spawn\(\s*process\.execPath\s*,\s*\[[^\]]*(?:server\.js|serverPath|SERVER_PATH)/.test(source))
  .map(([name]) => name);
check('no check spawns dist/server.js itself', spawnDirect.length === 0,
  spawnDirect.length ? `${spawnDirect.length}: ${spawnDirect.slice(0, 12).join(', ')}` : '');

// ─── The probe itself ─────────────────────────────────────────

console.log('\nfreePort and freePorts');

const one = await freePort();
check('freePort returns a port in range', Number.isInteger(one) && one > 1024 && one < 65536, String(one));

const four = await freePorts(4);
check('freePorts(4) returns four ports', four.length === 4, JSON.stringify(four));
check('all four are different', new Set(four).size === 4, JSON.stringify(four));

const bound = [];
let bindError = '';
try {
  for (const port of four) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => { bound.push(server); resolve(); });
    });
  }
} catch (error) {
  bindError = String(error && error.message ? error.message : error);
}
check('all four are unbound — two servers started at once get ports of their own',
  bound.length === 4, bindError || `${bound.length} of 4 bound`);
await Promise.all(bound.map((server) => new Promise((resolve) => server.close(resolve))));

let rejected = false;
try { await freePorts(0); } catch { rejected = true; }
check('freePorts(0) is refused rather than silently returning nothing', rejected);

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
