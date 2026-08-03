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
 *  2. **`rest-api.md` marks each route the way the code guards it** — *loopback only* for the
 *     bind, *loopback **caller** only* for the caller, nothing for a route that is neither. In
 *     its own row, or in the preamble of the section it sits under, which is how that document
 *     already says it for the terminal and the browser round-trips.
 *  3. **`SECURITY.md`'s list of what a caller on the network still reaches is exactly the third
 *     of those.** The list is short by design, so it is the one written out route by route; the
 *     refused set is the complement and `rest-api.md` is where it is catalogued.
 *
 * There are two guards and they answer different questions. **The bind** — the two feature
 * helpers that answer 404-if-disabled before 403-if-remote (`terminalRefused`,
 * `implementingRefused`) and the inline test the GitHub routes were written with — refuses
 * everybody on an interface-bound board, the operator's own browser included. **The caller** —
 * `notTheHost`, which #503 added for the pairing routes, and since #501 `offLoopback`, which is
 * the funnel in front of everything else — refuses a socket that did not come from this machine,
 * wherever the server is bound. Marking one as the other would tell a reader the wrong thing
 * about precisely the configuration this milestone exists to make usable.
 *
 * The set moved when #501 landed rather than the rule: `offLoopback` was written here as a bind
 * shape because that is what it asked, and it asks the other question now, so the two lists and
 * every mark in `rest-api.md` that rests on them moved with it.
 *
 * A third shape added tomorrow makes its routes read as *open* here, and section 2 is what turns
 * that into a failure rather than a quiet reclassification: every route this file calls open or
 * caller-guarded is asked, on a server bound where the guard means it.
 *
 * Self-contained: it builds a throwaway registry and one project in a temp directory, starts one
 * server on a port the kernel just handed out and kills it. No browser. Run
 * `./node_modules/.bin/tsc` first.
 *
 * The off-loopback server is bound to `127.0.0.2`, and since #501 that address does two jobs at
 * once rather than one. The bind shapes ask `LOOPBACK_ADDRESSES.includes(HOST)` over a list that
 * is `127.0.0.1` and `::1` exactly, so a server there is off loopback to them; a *caller*
 * reaching it is inside `127.0.0.0/8` and is therefore on this machine, which is exactly the
 * board this section wants — one where the two guards give different answers, without anything
 * leaving the machine. The half this cannot ask is a genuinely remote socket being refused, and
 * it says below whose job that is. Where a platform will not bind a loopback alias, the first
 * real interface is the fallback and the check says so on stdout.
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
const BIND_SHAPES = [
  /terminalRefused\(res\)/,
  /implementingRefused\(res\)/,
  /!LOOPBACK_ADDRESSES\.includes\(HOST\)/,
];

/**
 * The other question, added by #503: not where the server opened, but who is calling.
 *
 * `notTheHost` refuses a caller whose socket did not come from this machine, and it is a
 * different answer from the bind guard rather than a synonym for it — a board bound to an
 * interface refuses a bind-guarded route to *everybody*, its own operator included, and answers a
 * caller-guarded one to the operator while still refusing the network. The two pairing routes it
 * sits on are the first of these; #501 is where the rest of the funnel becomes one.
 */
const CALLER_SHAPES = [
  /notTheHost\(req, res,\s*['"]/,
  // #501 moved this one. `offLoopback` was the largest bind shape here — the funnel in front of
  // the board's contents, the registry, the picker and the restart route — and it now reads
  // `res.req.socket.remoteAddress` like `notTheHost` does. Everything it fronts therefore
  // answers the operator on an interface-bound board and refuses the network, which is a
  // different sentence from the one those rows used to carry and is why `rest-api.md` marks
  // them the other way now.
  /offLoopback\(res,\s*['"]/,
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
    const guard = BIND_SHAPES.some((shape) => shape.test(body)) ? 'bind'
      : CALLER_SHAPES.some((shape) => shape.test(body)) ? 'caller'
      : 'open';
    return { name: `${declaration[1].toUpperCase()} ${declaration[3]}`, guard };
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
app.get('/api/pair/pending', (req: Request, res: Response) => {
  if (notTheHost(req, res, 'Pending pairing requests are read')) return;
  res.json({});
});
`;

const synthetic = new Map(routesOf(SYNTHETIC).map((route) => [route.name, route.guard]));
check('the offLoopback funnel is a caller guard since #501',
      synthetic.get('GET /api/funnelled') === 'caller');
check('terminalRefused is a bind guard', synthetic.get('POST /api/terminal') === 'bind');
check('implementingRefused is a bind guard', synthetic.get('POST /api/implement') === 'bind');
check('the inline test the GitHub routes use is a bind guard',
      synthetic.get('GET /api/inline') === 'bind');
check('notTheHost is a caller guard, which is a different answer',
      synthetic.get('GET /api/pair/pending') === 'caller');
check('a route with none of them is open', synthetic.get('GET /api/open') === 'open');
check('and answering *less* off loopback is not the same as refusing there',
      synthetic.get('GET /api/soft') === 'open',
      'GET /api/implement drops the queue off loopback and still answers — that is open');

// ─── 1. Every route in the server, classified ─────────────────

console.log('\n1. every route in src/server.ts is classified, and the reachable ones are few');

const serverSource = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');
const routes = routesOf(serverSource);
check(`src/server.ts declares routes (${routes.length} found)`, routes.length > 0);

const named = (kind) => routes.filter((route) => route.guard === kind).map((route) => route.name);
const bindGuarded = named('bind');
const callerGuarded = named('caller');
const openRoutes = named('open');
console.log(`  note  guarded on the bind: ${bindGuarded.length}`);
console.log(`  note  guarded on the caller: ${callerGuarded.join(', ') || 'none'}`);
console.log(`  note  reachable from the network: ${openRoutes.join(', ')}`);

/**
 * How each route section 2 asks about is asked, off loopback.
 *
 * Every route this file calls open or caller-guarded has to be here: a classification nothing
 * asks is a guess, and the whole of `rest-api.md`'s markings and `SECURITY.md`'s short list rest
 * on it. A route added with a guard shape this file does not know fails here rather than
 * silently becoming "open".
 */
const ISSUE_URL = 'https://github.com/vitorengers/vibemaxxing/issues/1';
const PROBES = new Map([
  ['GET /', { path: '/' }],
  // Caller-guarded since #501, and asked here rather than among the refused: on the
  // interface-bound server below, reached from this machine, the whole funnel answers.
  ['GET /api/elements', { path: '/api/elements' }],
  ['GET /health', { path: '/health' }],
  ['GET /api/sync/status', { path: '/api/sync/status' }],
  ['GET /api/issue-block/:id/run', { path: '/api/issue-block/guarded-routes-block/run' }],
  ['GET /api/issue/recreate', { path: `/api/issue/recreate?url=${encodeURIComponent(ISSUE_URL)}` }],
  ['GET /api/implement', { path: '/api/implement' }],
  ['DELETE /api/implement', { path: '/api/implement', method: 'DELETE', body: { url: ISSUE_URL } }],
  ['DELETE /api/issue-block/:id/implement',
    { path: '/api/issue-block/guarded-routes-block/implement', method: 'DELETE' }],
  ['POST /api/pair/request',
    { path: '/api/pair/request', method: 'POST', body: { name: 'the-check' } }],
  ['GET /api/pair/status', { path: '/api/pair/status?requestId=nobody-issued-this' }],
  ['GET /api/pair/pending', { path: '/api/pair/pending' }],
  ['POST /api/pair/approve',
    { path: '/api/pair/approve', method: 'POST', body: { requestId: 'none', code: '000000' } }],
]);

/**
 * One route per bind-guard shape, so section 2 is evidence about the refused half as well.
 *
 * `GET /api/elements` used to be here and is not any more: since #501 the funnel it sits behind
 * asks the caller, so on the interface-bound server below — reached from this machine — it
 * answers. It moved to `CALLER_SHAPE_PROBES`, where that is the assertion.
 */
const GUARDED_PROBES = new Map([
  ['GET /api/github-status', { path: '/api/github-status' }],
  ['GET /api/terminal', { path: '/api/terminal' }],
  ['POST /api/implement', { path: '/api/implement', method: 'POST', body: { url: ISSUE_URL } }],
]);

/**
 * One caller-guarded route per shape, asked beside the open ones.
 *
 * Every **open** route is asked individually below, because that list is the one `SECURITY.md`
 * publishes and a guard shape this file cannot see would land a route in it silently. The
 * caller-guarded set is asked by shape instead: #501 made it the whole `offLoopback` funnel —
 * some thirty routes that answer for exactly one reason — and thirty probes would be thirty
 * spellings of one fact, each needing a body and a fixture. What the trap needs is that a route
 * with a shape nobody here knows reads as *open* and is then asked, which is unchanged.
 */
const CALLER_SHAPE_PROBES = ['GET /api/elements', 'GET /api/pair/pending'];

const answering = [...openRoutes, ...CALLER_SHAPE_PROBES];
const unprobed = openRoutes.filter((name) => !PROBES.has(name));
check('every route this check calls open is one section 2 asks',
      unprobed.length === 0,
      `${unprobed.join(', ')} — add it to PROBES, or it is a guard shape this file cannot see`);
const unrepresented = CALLER_SHAPE_PROBES
  .filter((name) => !callerGuarded.includes(name) || !PROBES.has(name));
check('and one route per caller-guard shape is asked beside them',
      unrepresented.length === 0,
      `${unrepresented.join(', ')} — no longer caller-guarded, or missing from PROBES`);

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
  //
  // Owned by nobody in particular, and that is the point rather than taste:
  // `check-shipped-config-neutral.mjs` reads every *tracked* file for a project board owned by
  // whoever owns this repository, and this fixture named them — so `main` went red on a rule
  // about shipping somebody's board, over a URL nothing ever fetches (#511's own note that a
  // new check's fixtures are tracked files). Any well-formed project URL does the job here.
  githubProject: 'https://github.com/users/someone/projects/5',
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

  for (const name of answering) {
    // Skipped rather than crashed on: section 1 has already failed for anything missing here,
    // and a destructuring error would replace that message with a worse one.
    const probe = PROBES.get(name);
    if (!probe) continue;
    const answer = await ask(probe);
    check(`${name} answers there, as this file classified it`, answer.status !== 403,
          `got ${answer.status} — ${answer.text}`);
  }

  // The caller-guarded pair answering above is the whole of what distinguishes them from the
  // bind-guarded ones here: this caller is on the machine, and the bind is not. That they refuse
  // a caller who is *not* needs a socket from somewhere else, which
  // `scripts/check-pairing-handshake.mjs` opens rather than this one opening a second.
  console.log(`  note  the caller guard's other half — a genuinely remote socket refused — is`);
  console.log('        scripts/check-pairing-handshake.mjs, not this file');
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

console.log('\n3. docs/rest-api.md marks each route the way the code guards it');

const restApi = readFileSync(join(repoRoot, 'docs', 'rest-api.md'), 'utf8');

/**
 * The two marks, and why they are two.
 *
 * *loopback only* is about the **bind** and is the older of them. *loopback **caller** only* is
 * what #503 wrote for the pairing routes and is about the **caller** — a board bound to an
 * interface refuses the first to its own operator and serves the second to them. A document that
 * spelled both the same way would be telling a reader the wrong thing about exactly the
 * configuration this milestone exists to make usable, so the marks are distinguished here and
 * neither is allowed to stand in for the other.
 */
const SAYS_BIND = /loopback only/i;
const SAYS_CALLER = /\bcaller\b[^|]*\bonly\b/i;

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

/**
 * What each `| `METHOD /path` | …` row of a document is marked as.
 *
 * A row inherits its section's preamble, which is how that document already says it for the
 * terminal and the browser round-trips — a whole table sharing one answer says it once. The
 * caller mark is read off the row only: it is the narrower claim, and a preamble has never made
 * it.
 */
function documentedRoutes(text) {
  const found = new Map();
  for (const section of sections(text)) {
    const prose = section.lines.filter((line) => !line.startsWith('|')).join('\n');
    const proseSaysBind = SAYS_BIND.test(prose);
    for (const line of section.lines) {
      const row = /^\|\s*`(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`\s*\|/.exec(line);
      if (!row) continue;
      const rowSaysCaller = SAYS_CALLER.test(line);
      // The caller mark wins over the bind mark on the same row: "loopback **caller** only"
      // contains neither of the other's words contiguously, but a row could be written to carry
      // both, and the narrower claim is the one it is making.
      const mark = rowSaysCaller ? 'caller'
        : (SAYS_BIND.test(line) || proseSaysBind) ? 'bind'
        : 'open';
      found.set(`${row[1]} ${row[2]}`, {
        mark,
        where: mark === 'bind' && !SAYS_BIND.test(line)
          ? `the "${section.heading}" preamble` : 'its row',
      });
    }
  }
  return found;
}

const documented = documentedRoutes(restApi);
check(`docs/rest-api.md tabulates routes (${documented.size} found)`, documented.size > 0);

const missing = routes.filter((route) => !documented.has(route.name)).map((route) => route.name);
check('every route in src/server.ts has a row there', missing.length === 0, missing.join(', '));

const mismatched = routes
  .filter((route) => documented.has(route.name))
  .filter((route) => documented.get(route.name).mark !== route.guard)
  .map((route) => `${route.name} — the code says ${route.guard}, `
    + `${documented.get(route.name).where} says ${documented.get(route.name).mark}`);
check('every route is marked the way the code guards it, or left unmarked because it is not',
      mismatched.length === 0, `\n        ${mismatched.join('\n        ')}`);

// ─── 4. And SECURITY.md's short list is that same set ─────────

console.log('\n4. docs/SECURITY.md names exactly the routes a caller on the network still reaches');

const security = readFileSync(join(repoRoot, 'docs', 'SECURITY.md'), 'utf8');

/**
 * The passage `SECURITY.md` writes that list in, fenced by a comment rather than found by its
 * wording. The wording is prose and will be rewritten; the set it names is derived and must not
 * drift while it is.
 *
 * The set is the **open** routes and not the caller-guarded ones, because the question a reader
 * of that section is asking is what somebody else can reach — and a caller-guarded route answers
 * the operator on an interface-bound board and refuses everybody else.
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
  check('it names every route a caller on the network reaches', absent.length === 0,
        `${absent.join(', ')} — such a caller reaches these and the document does not say so`);
  check('and names none it does not', extra.length === 0,
        `${extra.join(', ')} — refused on the bind, or on the caller, so not in this list`);
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
