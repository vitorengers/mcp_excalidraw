#!/usr/bin/env node
/**
 * Checks that the two documents describing the loopback guard name the routes the code guards.
 *
 * `docs/rest-api.md` marks a route *loopback only* and `docs/SECURITY.md` says which routes a
 * board bound off loopback still answers. Both were written by hand against the code as it was,
 * and both had drifted: `SECURITY.md` said such a board "publishes nothing and takes nothing"
 * while five routes still answered 200 there, and `rest-api.md` opened its issue-block section
 * with "every route here is loopback only" over a table two of whose rows are not.
 *
 * A count is the one claim in a document a check can settle mechanically — `check-docs-counts.mjs`
 * is the precedent, and it already holds *that every route is named*. What it cannot see is
 * whether the sentence beside the name is true. This is that half.
 *
 * Three rules, all derived from `src/server.ts` rather than from a list kept here:
 *
 *  1. **every route is classified**, and the classification is checked against a real server
 *     rather than believed. A regex agreeing with a regex is not evidence about a guard.
 *  2. **`rest-api.md` marks a route *loopback only* exactly when the code guards it** — in its
 *     own row, or in the preamble of the section it sits under, which is how that document
 *     already says it for the terminal and the browser round-trips.
 *  3. **`SECURITY.md`'s list of what such a board still answers is exactly that set.** The list
 *     is short by design, so it is the one written out route by route; the refused set is the
 *     complement and `rest-api.md` is where it is catalogued.
 *
 * The four guard shapes are the four `src/server.ts` has: the `offLoopback` funnel, the two
 * feature helpers that answer 404-if-disabled before 403-if-remote (`terminalRefused`,
 * `implementingRefused`), and the inline test the GitHub routes were written with. A fifth shape
 * added tomorrow makes its routes read as *open* here, and section 2 is what turns that into a
 * failure rather than a quiet reclassification: every route this file calls open is asked, on a
 * server bound where the guard means it.
 *
 * Self-contained: it builds a throwaway registry and one project in a temp directory, starts one
 * server on a port the kernel just handed out and kills it. No browser. Run
 * `./node_modules/.bin/tsc` first.
 *
 * The off-loopback server is bound to `127.0.0.2` for the reason `check-board-writes-guard.mjs`
 * gives: the guard's question is `LOOPBACK_ADDRESSES.includes(HOST)` over a list that is
 * `127.0.0.1` and `::1` exactly, so `127.0.0.2` is off loopback to the code under test while
 * never leaving this machine. Where a platform will not bind a loopback alias, the first real
 * interface is the fallback and the check says so on stdout.
 *
 * Usage: node scripts/check-guarded-routes-documented.mjs
 *
 * Tier: fast
 */

import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePorts } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const startupTimeoutMs = 15000;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The classifier, as a function over source text ───────────

/**
 * The four ways a route in `src/server.ts` refuses a caller that is not on loopback.
 *
 * Matched as *calls* rather than as bare names, for the reason `check-workspaces-guard.mjs`
 * gives: matching `offLoopback` alone counts the declaration of the funnel as a use of it.
 */
const GUARD_SHAPES = [
  /offLoopback\(res,\s*['"]/,
  /terminalRefused\(res\)/,
  /implementingRefused\(res\)/,
  /!LOOPBACK_ADDRESSES\.includes\(HOST\)/,
];

/**
 * Every `app.<method>('<path>', …)` in a source file, with the body each one runs to.
 *
 * A route's body is everything up to the next declaration, which is what the two guard checks
 * already read `src/server.ts` with.
 */
function routesOf(source) {
  const declarations = [...source.matchAll(/^app\.(get|post|put|delete|patch)\((['"])([^'"]+)\2/gm)];
  return declarations.map((declaration, index) => {
    const from = declaration.index;
    const to = index + 1 < declarations.length ? declarations[index + 1].index : source.length;
    const body = source.slice(from, to);
    return {
      name: `${declaration[1].toUpperCase()} ${declaration[3]}`,
      guarded: GUARD_SHAPES.some((shape) => shape.test(body)),
    };
  });
}

console.log('0. the classifier reads a guard where there is one, and none where there is not');

const SYNTHETIC = `
app.get('/api/funnelled', (req: Request, res: Response) => {
  if (offLoopback(res, 'The board is read')) return;
  res.json({});
});
app.post('/api/terminal', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;
});
app.post('/api/implement', (req: Request, res: Response) => {
  if (implementingRefused(res)) return;
});
app.get('/api/inline', (req: Request, res: Response) => {
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({ success: false, error: 'nope' });
  }
});
app.get('/api/open', (req: Request, res: Response) => {
  res.json({});
});
app.get('/api/soft', (req: Request, res: Response) => {
  const offered = CONFIGURED && (LOOPBACK_ADDRESSES.includes(HOST) || HOST === 'localhost');
  res.json({ offered });
});
`;

const synthetic = new Map(routesOf(SYNTHETIC).map((route) => [route.name, route.guarded]));
check('the offLoopback funnel is a guard', synthetic.get('GET /api/funnelled') === true);
check('terminalRefused is a guard', synthetic.get('POST /api/terminal') === true);
check('implementingRefused is a guard', synthetic.get('POST /api/implement') === true);
check('the inline test the GitHub routes use is a guard', synthetic.get('GET /api/inline') === true);
check('a route with none of them is open', synthetic.get('GET /api/open') === false);
check('and answering *less* off loopback is not the same as refusing there',
      synthetic.get('GET /api/soft') === false,
      'GET /api/implement drops the queue off loopback and still answers — that is open');

// ─── 1. Every route in the server, classified ─────────────────

console.log('\n1. every route in src/server.ts is classified, and the open ones are few');

const serverSource = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');
const routes = routesOf(serverSource);
check(`src/server.ts declares routes (${routes.length} found)`, routes.length > 0);

const guardedRoutes = routes.filter((route) => route.guarded).map((route) => route.name);
const openRoutes = routes.filter((route) => !route.guarded).map((route) => route.name);
console.log(`  note  ${guardedRoutes.length} guarded, ${openRoutes.length} answered off loopback`);
console.log(`        ${openRoutes.join(', ')}`);

/**
 * How each open route is asked, off loopback, in section 2.
 *
 * Every route this file calls open has to be here: a classification nothing asks is a guess, and
 * the whole of `rest-api.md`'s markings and `SECURITY.md`'s short list rest on it. A route added
 * with a guard shape this file does not know fails here rather than silently becoming "open".
 */
const ISSUE_URL = 'https://github.com/vitorengers/vibemaxxing/issues/1';
const PROBES = new Map([
  ['GET /', { path: '/' }],
  ['GET /health', { path: '/health' }],
  ['GET /api/sync/status', { path: '/api/sync/status' }],
  ['GET /api/issue-block/:id/run', { path: '/api/issue-block/guarded-routes-block/run' }],
  ['GET /api/issue/recreate', { path: `/api/issue/recreate?url=${encodeURIComponent(ISSUE_URL)}` }],
  ['GET /api/implement', { path: '/api/implement' }],
  ['DELETE /api/implement', { path: '/api/implement', method: 'DELETE', body: { url: ISSUE_URL } }],
  ['DELETE /api/issue-block/:id/implement',
    { path: '/api/issue-block/guarded-routes-block/implement', method: 'DELETE' }],
]);

/** One route per guard shape, so section 2 is evidence about the guarded half as well. */
const GUARDED_PROBES = new Map([
  ['GET /api/elements', { path: '/api/elements' }],
  ['GET /api/github-status', { path: '/api/github-status' }],
  ['GET /api/terminal', { path: '/api/terminal' }],
  ['POST /api/implement', { path: '/api/implement', method: 'POST', body: { url: ISSUE_URL } }],
]);

const unprobed = openRoutes.filter((name) => !PROBES.has(name));
check('every route this check calls open is one section 2 asks', unprobed.length === 0,
      `${unprobed.join(', ')} — add it to PROBES, or it is a guard shape this file cannot see`);

// ─── 2. And a real server answers the way it says ─────────────

console.log('\n2. a board bound off loopback answers exactly that way');

/** Whether this machine will let a server sit on `host`. */
function canBind(host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

/** An address the guard calls "not loopback" and this machine will bind. */
async function offLoopbackHost() {
  if (await canBind('127.0.0.2')) return '127.0.0.2';
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && (await canBind(entry.address))) {
        console.log(`  note  127.0.0.2 is not bindable here; using the interface ${entry.address}`);
        return entry.address;
      }
    }
  }
  throw new Error('No non-loopback address on this machine could be bound.');
}

async function waitForHealth(base, child) {
  const start = Date.now();
  while (Date.now() - start < startupTimeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Canvas server exited early (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for the canvas server on ${base}.`);
}

const workdir = mkdtempSync(join(tmpdir(), 'check-guarded-routes-'));
const projectPath = join(workdir, 'guarded');
mkdirSync(projectPath, { recursive: true });
writeFileSync(join(projectPath, 'board.config.json'), JSON.stringify({
  name: 'guarded',
  board: 'board.excalidraw',
  repo: 'vitorengers/vibemaxxing',
  // A project to mirror, so the GitHub routes are refused by the guard rather than by 404.
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');
writeFileSync(join(projectPath, 'board.excalidraw'), JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'check-guarded-routes-documented',
  elements: [{
    id: 'guarded-routes-block', type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
    customData: { kind: 'issue', issueUrl: ISSUE_URL },
  }],
  files: {},
}, null, 1), 'utf8');

const registryPath = join(workdir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'guarded', path: projectPath }],
}), 'utf8');

let server;

try {
  const offHost = await offLoopbackHost();
  const [port] = await freePorts(1);
  server = startCanvas({
    port,
    cwd: workdir,
    env: {
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_LIBRARY: '',
      LOG_LEVEL: 'error',
      HOST: offHost,
      // Both features on, so their routes are refused on the bind rather than 404'd as disabled:
      // a 404 from a switch that is off says nothing about the guard.
      EXCALIDRAW_TERMINAL: '1',
      EXCALIDRAW_IMPLEMENT_AGENT: 'node -e "process.exit(0)"',
    },
  });
  const base = `http://${offHost}:${port}`;
  await waitForHealth(base, server.child);

  const ask = async ({ path, method = 'GET', body }) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-workspace-id': 'guarded',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: (await response.text()).slice(0, 160) };
  };

  for (const [name, probe] of GUARDED_PROBES) {
    const answer = await ask(probe);
    check(`${name} is refused there, as this file classified it`, answer.status === 403,
          `got ${answer.status} — ${answer.text}`);
  }

  for (const name of openRoutes) {
    // Skipped rather than crashed on: section 1 has already failed for anything missing here,
    // and a destructuring error would replace that message with a worse one.
    const probe = PROBES.get(name);
    if (!probe) continue;
    const answer = await ask(probe);
    check(`${name} answers there, as this file classified it`, answer.status !== 403,
          `got ${answer.status} — ${answer.text}`);
  }
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (server) server.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Guarded, because a teardown is not a verdict (#472).
  try { rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* the directory outlives the run and costs nothing else */ }
}

// ─── 3. What rest-api.md says beside each route ───────────────

console.log('\n3. docs/rest-api.md marks a route loopback only exactly when the code guards it');

const restApi = readFileSync(join(repoRoot, 'docs', 'rest-api.md'), 'utf8');

const SAYS_GUARDED = /loopback only/i;

/**
 * Every `## heading` of a document, with the lines under it.
 *
 * The unit is the section because that is the unit `rest-api.md` already says this in: the
 * terminal table is preceded by "loopback only, and capped per board", and every row under it
 * inherits that rather than repeating it.
 */
function sections(text) {
  const out = [];
  let current = { heading: '(preamble)', lines: [] };
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      out.push(current);
      current = { heading: line.replace(/^#+\s*/, '').trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  out.push(current);
  return out;
}

/** The `| `METHOD /path` | …` rows of a document, each with its section's prose. */
function documentedRoutes(text) {
  const found = new Map();
  for (const section of sections(text)) {
    const prose = section.lines.filter((line) => !line.startsWith('|')).join('\n');
    const sectionSaysGuarded = SAYS_GUARDED.test(prose);
    for (const line of section.lines) {
      const row = /^\|\s*`(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`\s*\|/.exec(line);
      if (!row) continue;
      const name = `${row[1]} ${row[2]}`;
      found.set(name, {
        marked: sectionSaysGuarded || SAYS_GUARDED.test(line),
        where: sectionSaysGuarded && !SAYS_GUARDED.test(line) ? `the "${section.heading}" preamble` : 'its row',
      });
    }
  }
  return found;
}

const documented = documentedRoutes(restApi);
check(`docs/rest-api.md tabulates routes (${documented.size} found)`, documented.size > 0);

const missing = routes.filter((route) => !documented.has(route.name)).map((route) => route.name);
check('every route in src/server.ts has a row there', missing.length === 0, missing.join(', '));

const unmarked = guardedRoutes
  .filter((name) => documented.has(name) && !documented.get(name).marked);
check('every guarded route is marked loopback only', unmarked.length === 0,
      `${unmarked.join(', ')} — the code refuses these off loopback and the table does not say so`);

const overmarked = openRoutes
  .filter((name) => documented.has(name) && documented.get(name).marked)
  .map((name) => `${name} (via ${documented.get(name).where})`);
check('and no route is marked that the code answers there', overmarked.length === 0,
      `${overmarked.join(', ')} — these answer 200 off loopback; the table claims they do not`);

// ─── 4. And SECURITY.md's short list is that same set ─────────

console.log('\n4. docs/SECURITY.md names exactly the routes such a board still answers');

const security = readFileSync(join(repoRoot, 'docs', 'SECURITY.md'), 'utf8');

/**
 * The passage `SECURITY.md` writes that list in, fenced by a comment rather than found by its
 * wording. The wording is prose and will be rewritten; the set it names is derived and must not
 * drift while it is.
 */
const MARKER = /<!--\s*routes: answered-off-loopback\s*-->([\s\S]*?)<!--\s*\/routes: answered-off-loopback\s*-->/;
const passage = MARKER.exec(security);
check('SECURITY.md carries the marked list', Boolean(passage),
      'expected <!-- routes: answered-off-loopback --> … <!-- /routes: answered-off-loopback -->');

if (passage) {
  const named = new Set(
    [...passage[1].matchAll(/`(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`/g)]
      .map((span) => `${span[1]} ${span[2]}`)
  );
  const absent = openRoutes.filter((name) => !named.has(name));
  const extra = [...named].filter((name) => !openRoutes.includes(name));
  check('it names every route the code answers off loopback', absent.length === 0,
        `${absent.join(', ')} — a board bound there answers these and the document does not say so`);
  check('and names no route the code refuses there', extra.length === 0, extra.join(', '));
}

/**
 * The claim that made the drift matter rather than merely exist.
 *
 * "It publishes nothing and takes nothing" is the sentence a reader decides on, and it was false
 * in both halves: `GET /api/implement` publishes each run's pull request, its error and the
 * absolute path of the worktree it left on this machine, and `DELETE /api/implement` accepts a
 * reset of that record from the network.
 */
// Over the whole file with its newlines flattened, because the sentence wraps and a reader does
// not care where: matching line by line is how a claim survives a check by being reflowed.
const flattened = security.replace(/\s+/g, ' ');
check('and does not claim such a board is inert while any route answers there',
      openRoutes.length === 0 || !/publishes nothing and takes nothing/i.test(flattened),
      'SECURITY.md still says a board bound off loopback publishes nothing and takes nothing');

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: the documents name the routes the code guards.');
