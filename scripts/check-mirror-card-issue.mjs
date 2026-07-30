#!/usr/bin/env node
/**
 * Checks that a card in the project mirror is a working issue block.
 *
 * The mirror deletes the authored block once its issue has a card, so the card is the only
 * thing left to select — and a card that cannot show the issue or start an implementation
 * makes researching an issue from the board end by taking those away.
 *
 * The cases that matter are the ones where the element store cannot help: a mirror card is
 * kept out of the autosync on purpose and is redrawn from GitHub on every read, so it has
 * no id the server knows and nothing written onto it survives. Hence the state is addressed
 * by issue URL, and hence these cases: starting from a card with no element at all, and two
 * shapes for one issue never disagreeing.
 *
 * Self-contained: it writes a stub `gh` and a stub implement agent, starts its own canvas
 * server against a throwaway workspace, and kills both. Nothing here talks to GitHub.
 * Run `./node_modules/.bin/tsc` first — the offline half reads the compiled modules.
 *
 * Usage: node scripts/check-mirror-card-issue.mjs
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const ISSUE_URL = 'https://github.com/vitorengers/mcp_excalidraw/issues/46';
const OTHER_URL = 'https://github.com/vitorengers/mcp_excalidraw/issues/12';
const PR_URL = 'https://github.com/vitorengers/mcp_excalidraw/pull/99';

// ─── 1. The panel resolves a mirror card ──────────────────────
//
// Offline, because this is the part that decides a card has anything to show at all.

console.log('1. selecting a mirror card resolves to its issue');

const { resolvePanelTarget } = await importDist(join('core', 'panel-target.js'), 'the panel target resolver');
const { MIRROR_KIND } = await importDist(join('core', 'project-board-layout.js'), 'the mirror layout');

const card = {
  id: 'card-46', type: 'rectangle', x: 0, y: 0, width: 220, height: 60,
  customData: { kind: MIRROR_KIND, role: 'card', issueUrl: ISSUE_URL, itemId: 'PVTI_x' },
};
const cardLabel = {
  id: 'card-46-label', type: 'text', x: 10, y: 10, width: 200, height: 40,
  text: 'Attach N reference images', containerId: 'card-46',
  customData: { kind: MIRROR_KIND, role: 'card-label' },
};
const column = {
  id: 'section-todo', type: 'rectangle', x: -20, y: -20, width: 260, height: 400,
  customData: { kind: MIRROR_KIND, role: 'section', sectionOptionId: 'f75ad846' },
};

const onCard = resolvePanelTarget([column, card, cardLabel], ['card-46']);
check('a card resolves to something', Boolean(onCard), 'the card got no panel at all');
check('it is an issue', Boolean(onCard?.issue), 'the card resolved without an issue');
check('carrying the issue URL', onCard?.issue?.issueUrl === ISSUE_URL, onCard?.issue?.issueUrl);
check('and reported as created, so the panel reads it rather than offering to research it',
      onCard?.issue?.state === 'created', onCard?.issue?.state);

// Clicking a card means clicking its label, exactly as it does for an authored block.
const onLabel = resolvePanelTarget([column, card, cardLabel], ['card-46-label']);
check('clicking the label resolves to the same issue', onLabel?.issue?.issueUrl === ISSUE_URL,
      onLabel?.issue?.issueUrl);
check('and anchors on the card, not the label', onLabel?.anchorId === 'card-46', onLabel?.anchorId);

// The rest of the mirror is furniture. A column or the `+` must not open an issue panel.
check('a column is not an issue', !resolvePanelTarget([column, card, cardLabel], ['section-todo'])?.issue);

// ─── 2. Through the server, addressed by issue URL ────────────

const workDir = join(tmpdir(), 'mirror-card-check');
rmSync(workDir, { recursive: true, force: true });
const projectDir = join(workDir, 'mirror-card');
mkdirSync(projectDir, { recursive: true });

const ghStub = join(workDir, 'gh-stub.mjs');
const agentStub = join(workDir, 'agent-stub.mjs');
const registryPath = join(workDir, 'workspaces.json');

writeFileSync(ghStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('issue') && args.includes('view')) {
  const url = args.find((a) => a.startsWith('https://'));
  process.stdout.write(JSON.stringify({
    number: Number(url.split('/').pop()),
    title: 'Attach N reference images to an issue block',
    body: 'The body, read live rather than stored on the card.',
    state: 'OPEN',
  }));
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

// Prints a pull request URL, the way a real implement agent ends. The point of these cases
// is this server's bookkeeping, not an agent's work.
writeFileSync(agentStub, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  process.stdout.write('worked on it\\n');
  process.stdout.write('${PR_URL}\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'mirror-card', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Mirror Card Check',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const running = [];

function startCanvas(port, { withImplementAgent = true } = {}) {
  const env = {
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
  };
  // Nothing to delete in the other case: the child's environment starts with no
  // `EXCALIDRAW_*` in it at all, so "not granted" is "never named".
  if (withImplementAgent) env.EXCALIDRAW_IMPLEMENT_AGENT = `node "${agentStub.replace(/\\/g, '/')}" -p`;

  const child = spawnCanvas({
    env: env,
  }).child;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, child, read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the canvas server never answered on ${base}:\n${read()}`);
}

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=mirror-card`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Poll the URL-addressed state until it settles. */
async function settled(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(250);
    const read = await call(`/api/issue?url=${encodeURIComponent(url)}`);
    if (read.body?.implement?.state && read.body.implement.state !== 'running') return read.body.implement;
  }
  return null;
}

try {
  const canvas = startCanvas(port);
  await waitForHealth(BASE, canvas.child, canvas.read);

  console.log('\n2. the issue is read by URL, with no element involved');
  const detail = await call(`/api/issue?url=${encodeURIComponent(ISSUE_URL)}`);
  check('200 OK', detail.status === 200, `got ${detail.status} ${JSON.stringify(detail.body).slice(0, 200)}`);
  check('the issue came back', detail.body?.issue?.number === 46, JSON.stringify(detail.body?.issue));
  check('with its body, read live', /read live/.test(detail.body?.issue?.body ?? ''), detail.body?.issue?.body);
  check('and nothing was implemented yet', !detail.body?.implement?.state,
        JSON.stringify(detail.body?.implement));

  console.log('\n3. a URL that is not a GitHub issue is refused before gh runs');
  const bogus = await call(`/api/issue?url=${encodeURIComponent('https://example.com/whatever')}`);
  check('400, not a gh failure', bogus.status === 400, `got ${bogus.status}`);

  console.log('\n4. implementing is started by URL, from a card with no element');
  const started = await call('/api/implement', {
    method: 'POST', body: JSON.stringify({ url: ISSUE_URL }),
  });
  check('202 Accepted', started.status === 202, `got ${started.status} ${JSON.stringify(started.body)}`);
  check('reports running', started.body?.state === 'running', started.body?.state);

  console.log('\n5. one issue cannot become two pull requests, whichever shape asked');
  const again = await call('/api/implement', { method: 'POST', body: JSON.stringify({ url: ISSUE_URL }) });
  check('409 while in flight', again.status === 409, `got ${again.status}`);

  // The element route must be stopped by the same guard: an authored block and a card are
  // two shapes for one issue, and the issue is what is being implemented.
  const block = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
      customData: { kind: 'issue', issueState: 'created', issueUrl: ISSUE_URL },
    }),
  });
  const blockId = block.body?.element?.id;
  const viaElement = await call(`/api/issue-block/${blockId}/implement`, { method: 'POST' });
  check('the element route is refused too', viaElement.status === 409, `got ${viaElement.status}`);

  console.log('\n6. the result is readable by URL after the run');
  const done = await settled(ISSUE_URL);
  check('state became done', done?.state === 'done', JSON.stringify(done));
  check('the pull request URL was captured', done?.url === PR_URL, done?.url);

  console.log('\n7. the two shapes for one issue agree');
  const elementView = await call(`/api/elements/${blockId}`);
  check('the authored block shows the same pull request',
        elementView.body?.element?.customData?.implementUrl === PR_URL,
        JSON.stringify(elementView.body?.element?.customData));
  check('and the same state',
        elementView.body?.element?.customData?.implementState === 'done',
        elementView.body?.element?.customData?.implementState);

  console.log('\n8. a run already done is not run again');
  const third = await call('/api/implement', { method: 'POST', body: JSON.stringify({ url: ISSUE_URL }) });
  check('409 with the pull request it already has', third.status === 409, `got ${third.status}`);
  check('and returns it', third.body?.implementUrl === PR_URL, JSON.stringify(third.body));

  console.log('\n9. a lost run can be cleared by URL, and the issue tried again');
  const reset = await call('/api/implement', { method: 'DELETE', body: JSON.stringify({ url: ISSUE_URL }) });
  check('the reset is accepted', reset.status === 200, `got ${reset.status}`);
  const afterReset = await call(`/api/issue?url=${encodeURIComponent(ISSUE_URL)}`);
  check('the implementation state is gone', !afterReset.body?.implement?.state,
        JSON.stringify(afterReset.body?.implement));
  const cleared = await call(`/api/elements/${blockId}`);
  check('and the block that shared it was cleared with it',
        !cleared.body?.element?.customData?.implementState,
        JSON.stringify(cleared.body?.element?.customData));
  check('but the issue it came from survived', Boolean(cleared.body?.element?.customData?.issueUrl));

  const rerun = await call('/api/implement', { method: 'POST', body: JSON.stringify({ url: ISSUE_URL }) });
  check('it can be implemented again', rerun.status === 202, `got ${rerun.status}`);
  await settled(ISSUE_URL);

  console.log('\n10. an issue nobody touched has no state of its own');
  const untouched = await call(`/api/issue?url=${encodeURIComponent(OTHER_URL)}`);
  check('read fine', untouched.status === 200, `got ${untouched.status}`);
  check('with no implementation', !untouched.body?.implement?.state,
        'state leaked from another issue');

  console.log('\n11. the feature stays off unless its own variable is set');
  const offPort = await freePort();
  const offBase = `http://127.0.0.1:${offPort}`;
  const off = startCanvas(offPort, { withImplementAgent: false });
  await waitForHealth(offBase, off.child, off.read);
  const offRes = await fetch(`${offBase}/api/implement?workspace=mirror-card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: ISSUE_URL }),
  });
  const offBody = await offRes.json().catch(() => ({}));
  check('404 when EXCALIDRAW_IMPLEMENT_AGENT is unset', offRes.status === 404, `got ${offRes.status}`);
  check('and it says how to enable it', /EXCALIDRAW_IMPLEMENT_AGENT/.test(offBody.error ?? ''), offBody.error);
  check('reading the issue still works with implementing off',
        (await (await fetch(`${offBase}/api/issue?workspace=mirror-card&url=${encodeURIComponent(ISSUE_URL)}`)).json())
          ?.issue?.number === 46,
        'reading and implementing must not share an opt-in');
} finally {
  stopAll();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
