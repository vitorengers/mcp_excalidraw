#!/usr/bin/env node
/**
 * Checks that a board with no `gh` and no GitHub project is still the whole tool minus GitHub.
 *
 * The graceful degradation is real and was entirely untested. `projectWorkspace` refuses a
 * board with no `githubProject` with a sentence naming the setting, `moveIssueToColumn` returns
 * null before spawning anything, and the canvas, the documentation cards and the terminal touch
 * `gh` nowhere at all. None of that was held by anything: `check-gh-command-environment.mjs`
 * only asserts *which binary is named*, so "this tool is useful without GitHub" was true by
 * accident and could regress on any change without a check going red.
 *
 * The other two degradations already have their own checks and are not repeated here —
 * `check-github-host.mjs` section 5 holds the non-GitHub `origin`, and
 * `check-worktree-git-missing.mjs` section 2 holds the directory that is no git repository.
 * `docs/without-github.md` is the document all four hang off.
 *
 * Six sections, in the order a reader loses things:
 *
 * 1. **The board comes up**, and says out loud that `gh` is not there rather than discovering
 *    it at the first click.
 * 2. **The element store** — create, read, update, delete — which is the canvas itself.
 * 3. **`GET /api/docs/:key`**, for a document the project owns and for one the tool ships.
 * 4. **The terminal routes**, which start a real child process and are the reason a board with
 *    no GitHub is still worth opening.
 * 5. **`GET /api/project-board`**, which has to answer a readable 404 — not a hang, not a 500 —
 *    and must not spawn `gh` to find out there is no project to read.
 * 6. **`GET /api/github-status`**, the one route whose whole job is to say *why* GitHub is
 *    silent. Without it the four failures are one blank corner of canvas.
 *
 * **The `gh` stub exits 127 and says `command not found` on stderr**, which is what a shell
 * says about a binary that is not installed. Both halves matter: `interpretVersion` treats a
 * native spawn that *started* as proof the CLI is there, so a stub that exited 127 in silence
 * would be reported as an installed `gh` that dislikes `--version` — a different complaint,
 * pointing the reader the wrong way. It also records every call it is given, which is how
 * section 5 asserts a refusal that cost no process rather than assuming it.
 *
 * Self-contained: a throwaway project, a throwaway registry, its own canvas server on a free
 * port, and no browser. Nothing here reaches GitHub — there is nothing to reach it with.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-github-absent.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request, decoded, with the status kept whatever the body turned out to be. */
async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `check-github-absent-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const WORKSPACE = 'no-github';
const projectDir = join(workDir, 'project');
const projectDocs = join(projectDir, 'docs');
mkdirSync(projectDocs, { recursive: true });

/**
 * A project with everything except the two GitHub fields.
 *
 * No `githubProject`, which is what registration writes for every board it creates, and no
 * `repo`, which it only writes when a GitHub `origin` said so. This is a fresh clone before
 * anybody has configured anything, spelled out.
 */
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'A board with no GitHub', docsDir: 'docs' }, null, 2), 'utf8');

const PROJECT_DOC = '# A document this project owns\n\nAnd `gh` was never asked about it.\n';
writeFileSync(join(projectDocs, 'house-rules.md'), PROJECT_DOC, 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}, null, 2), 'utf8');

/** Every `gh` this server runs, one line per call, so section 5 can count them. */
const ghLog = join(workDir, 'gh-calls.log');
const ghStub = join(workDir, 'gh-missing.mjs');
writeFileSync(ghStub, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(ghLog.replace(/\\/g, '/'))}, process.argv.slice(2).join(' ') + '\\n', 'utf8');
// What a shell says about a binary it could not find, on the stream it says it on.
process.stderr.write('gh: command not found\\n');
process.exit(127);
`, 'utf8');

/** A shell that is not a shell: it echoes what it is told, on any platform. */
const stubShell = join(workDir, 'stub-shell.mjs');
writeFileSync(stubShell, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => process.stdout.write('echo: ' + chunk));
`, 'utf8');

const quoted = (file) => `node "${file.replace(/\\/g, '/')}"`;
const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '')
  .split('\n').map((line) => line.trim()).filter(Boolean);

const canvas = await openCanvas({
  env: {
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_STATE_HOME: join(workDir, 'state'),
    EXCALIDRAW_GH_COMMAND: quoted(ghStub),
    // Granted here rather than inherited. This check runs on the machine the board runs on,
    // where the terminal is switched on in the shell environment — and section 4 asserting a
    // feature the throwaway instance was never granted would pass for the wrong reason on one
    // machine and fail everywhere else. `spawn-canvas` strips the inherited value; this puts a
    // stub back.
    EXCALIDRAW_TERMINAL: quoted(stubShell),
    // The pipe, so the stub can read what it is sent whatever `@lydell/node-pty` shipped for
    // this platform.
    EXCALIDRAW_TERMINAL_PTY: '0',
    LOG_LEVEL: 'error',
  },
});

const base = canvas.base;
const ws = `?workspace=${WORKSPACE}`;

try {
  // ─── 1. It comes up, and says gh is missing ────────────────
  console.log('1. the board comes up with no gh and no project');

  const health = await call(base, '/health');
  check('/health answers', health.status === 200 && health.body?.status === 'healthy',
        `${health.status} ${JSON.stringify(health.body)}`);
  check('the project is registered', health.body?.workspaces === 'configured',
        JSON.stringify(health.body?.workspaces));

  // The preflight is asynchronous and `probing` is its honest answer until it lands, so this
  // waits for a verdict rather than reading whichever one the race handed over.
  let gh = health.body?.gh ?? null;
  for (let attempt = 0; attempt < 100 && gh?.resolved === 'probing'; attempt++) {
    await sleep(100);
    gh = (await call(base, '/health')).body?.gh ?? null;
  }
  check('/health reports gh as not found rather than probing forever',
        gh?.resolved === 'not found', JSON.stringify(gh));
  check('and carries no version for a binary that is not there', gh?.version === null,
        JSON.stringify(gh));

  // ─── 2. The canvas itself ──────────────────────────────────
  console.log('\n2. the element store is a store, with or without GitHub');

  const created = await call(base, `/api/elements${ws}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 10, y: 20, width: 100, height: 50 }),
  });
  check('an element is created', created.status === 200 && created.body?.success === true,
        `${created.status} ${JSON.stringify(created.body)}`);

  const id = created.body?.element?.id ?? '';
  check('and comes back with an id', Boolean(id), JSON.stringify(created.body?.element));

  const listed = await call(base, `/api/elements${ws}`);
  check('it is in the listing', listed.status === 200
        && (listed.body?.elements ?? []).some((element) => element.id === id),
        `${listed.status} count=${listed.body?.count}`);

  const fetched = await call(base, `/api/elements/${id}${ws}`);
  check('and readable by id', fetched.status === 200 && fetched.body?.element?.width === 100,
        `${fetched.status} ${JSON.stringify(fetched.body)}`);

  const updated = await call(base, `/api/elements/${id}${ws}`, {
    method: 'PUT',
    body: JSON.stringify({ width: 220 }),
  });
  check('and writable', updated.status === 200 && updated.body?.element?.width === 220,
        `${updated.status} ${JSON.stringify(updated.body)}`);

  const removed = await call(base, `/api/elements/${id}${ws}`, { method: 'DELETE' });
  check('and deletable', removed.status === 200 && removed.body?.success === true,
        `${removed.status} ${JSON.stringify(removed.body)}`);

  // ─── 3. The documentation cards ────────────────────────────
  console.log('\n3. GET /api/docs/:key answers, for both kinds of key');

  const own = await call(base, `/api/docs/house-rules${ws}`);
  check('a document the project owns is served from the project',
        own.status === 200 && own.body?.markdown === PROJECT_DOC,
        `${own.status} ${JSON.stringify(own.body?.error ?? own.body?.markdown?.slice(0, 60))}`);

  // A block this server draws on every board, whose document belongs to the tool rather than
  // to the project — the card is on the canvas either way, so it has to resolve either way.
  const shipped = await call(base, `/api/docs/terminal${ws}`);
  const shippedBytes = readFileSync(join(repoRoot, 'docs', 'terminal.md'), 'utf8');
  check('a document the tool ships is served from the tool',
        shipped.status === 200 && shipped.body?.markdown === shippedBytes,
        `${shipped.status} ${JSON.stringify(shipped.body?.error ?? '')}`);

  const missing = await call(base, `/api/docs/nothing-here${ws}`);
  check('and a key with no document behind it is still a plain 404',
        missing.status === 404 && missing.body?.code === 'no-doc',
        `${missing.status} ${JSON.stringify(missing.body)}`);

  // ─── 4. The terminal ───────────────────────────────────────
  console.log('\n4. the terminal routes run a shell, and never mention GitHub');

  const opened = await call(base, `/api/terminal${ws}`, { method: 'POST' });
  check('a session opens', opened.status === 202, `${opened.status} ${JSON.stringify(opened.body)}`);

  const sessionId = opened.body?.session?.id ?? '';
  check('and reports a pid it really started', Number.isInteger(opened.body?.session?.pid),
        JSON.stringify(opened.body?.session));

  const sessions = await call(base, `/api/terminal${ws}`);
  check('the listing has it', sessions.status === 200
        && (sessions.body?.sessions ?? []).some((session) => session.id === sessionId),
        `${sessions.status} ${JSON.stringify(sessions.body)}`);

  const typed = await call(base, `/api/terminal/input${ws}`, {
    method: 'POST',
    body: JSON.stringify({ id: sessionId, data: 'hello\n' }),
  });
  check('input is accepted', typed.status === 202, `${typed.status} ${JSON.stringify(typed.body)}`);

  // The stub echoes, so the transcript is the proof a child ran rather than a route answering
  // politely about a process that never started.
  let transcript = '';
  for (let attempt = 0; attempt < 40 && !transcript.includes('echo: hello'); attempt++) {
    await sleep(100);
    const again = await call(base, `/api/terminal${ws}`);
    transcript = (again.body?.sessions ?? []).map((session) => session.scrollback ?? '').join('');
  }
  check('and the shell answered', transcript.includes('echo: hello'),
        JSON.stringify(transcript.slice(0, 200)));

  const closed = await call(base, `/api/terminal${ws}`, {
    method: 'DELETE',
    body: JSON.stringify({ id: sessionId }),
  });
  check('the session closes', closed.status === 200, `${closed.status} ${JSON.stringify(closed.body)}`);

  // ─── 5. The mirror refuses, readably and cheaply ───────────
  console.log('\n5. GET /api/project-board says why, rather than hanging or failing');

  const before = ghCalls().length;
  const started = Date.now();
  const board = await call(base, `/api/project-board${ws}`);
  const took = Date.now() - started;

  check('it answers 404 rather than 500', board.status === 404,
        `${board.status} ${JSON.stringify(board.body)}`);
  check('and does not hang', took < 5000, `${took}ms`);
  check('the reason is machine-readable', board.body?.reason === 'no-project',
        JSON.stringify(board.body));
  check('and the sentence names the setting to write',
        typeof board.body?.error === 'string' && board.body.error.includes('githubProject'),
        JSON.stringify(board.body?.error));

  // The refusal is decided from the workspace, before anything is spawned. A `gh` running here
  // would be this board asking a CLI it has already been told is missing about a project it has
  // already been told does not exist.
  check('and no gh was run to find that out', ghCalls().length === before,
        ghCalls().slice(before).join(' | '));

  // ─── 6. The route that ends the silence ────────────────────
  console.log('\n6. GET /api/github-status says which of the four things is wrong');

  const status = await call(base, `/api/github-status${ws}`);
  check('it answers', status.status === 200 && status.body?.success === true,
        `${status.status} ${JSON.stringify(status.body)}`);
  check('about this board', status.body?.workspace === WORKSPACE, JSON.stringify(status.body?.workspace));
  check('and says the CLI is not installed', status.body?.gh?.installed === false,
        JSON.stringify(status.body?.gh));
  check('so it claims no login and no scopes',
        status.body?.gh?.login === null && (status.body?.gh?.scopes ?? []).length === 0,
        JSON.stringify(status.body?.gh));
  check('and quotes what gh itself said',
        typeof status.body?.gh?.error === 'string' && /command not found/i.test(status.body.gh.error),
        JSON.stringify(status.body?.gh?.error));
} finally {
  canvas.stop();
  // The stub shell is a child of the server and dies with it; give it the moment to.
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
