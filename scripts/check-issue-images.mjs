#!/usr/bin/env node
/**
 * Checks that reference images attached to an issue block reach the agent.
 *
 * An observation is text, and text is all the agent ever received. Attaching images means
 * three things have to hold at once: the block has to be able to name them, the bytes have
 * to exist on disk while the agent runs, and the prompt has to spell the paths the way the
 * agent's own environment does. None of that is visible from the outside — the files are
 * deleted when the run ends — so the assertion is made by the agent itself: the stub here
 * stats every path the prompt names, while it holds them.
 *
 * The case that is easy to lose is the first one. A block with nothing attached must send
 * the prompt it sends today, byte for byte, because a feature nobody used must not change
 * what every existing block does.
 *
 * Self-contained: it writes a stub agent and a stub `gh`, starts its own canvas server
 * against a throwaway workspace, and kills both. Nothing here talks to GitHub.
 * Run `./node_modules/.bin/tsc` first — this reads the compiled modules.
 *
 * Usage: node scripts/check-issue-images.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const ISSUE_URL = 'https://github.com/vitorengers/vibemaxxing/issues/46';

/** A real 1×1 PNG and a real 1×1 GIF: two files, two mime types, two byte counts. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64').length;
const GIF_BYTES = Buffer.from(GIF_BASE64, 'base64').length;

// ─── The throwaway project, the stubs and the server ──────────

const workDir = join(tmpdir(), 'issue-images-check');
rmSync(workDir, { recursive: true, force: true });
const projectDir = join(workDir, 'issue-images');
mkdirSync(projectDir, { recursive: true });

const agentStub = join(workDir, 'agent-stub.mjs');
const ghStub = join(workDir, 'gh-stub.mjs');
const registryPath = join(workDir, 'workspaces.json');
const agentLog = join(workDir, 'agent-log.jsonl');

/**
 * A stub agent that reports what it was given.
 *
 * It records the prompt verbatim and stats every path the prompt names, because the files
 * only exist while the run does — after it, the check can only prove they are gone. An
 * observation carrying FAIL_THIS_RUN makes it exit non-zero, which is how the cleanup on
 * the failure path gets a run to fail.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { appendFileSync, statSync } from 'node:fs';

let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  // Since #329 the prompt travels down whichever channel the backend declared, and this
  // command line carries no \`-p\`, so \`raw\` delivers it as the last argument.
  if (!input) input = process.argv[process.argv.length - 1] ?? '';
  const paths = [];
  const marker = input.indexOf('Reference images');
  if (marker !== -1) {
    for (const line of input.slice(marker).split('\\n')) {
      const match = /^- (.+)$/.exec(line.trim());
      if (match) paths.push(match[1]);
    }
  }

  const images = paths.map((path) => {
    try {
      return { path, bytes: statSync(path).size, error: null };
    } catch (error) {
      return { path, bytes: null, error: error.message };
    }
  });

  appendFileSync(${JSON.stringify(agentLog.replace(/\\/g, '/'))},
                 JSON.stringify({ prompt: input, images }) + '\\n', 'utf8');

  if (input.includes('FAIL_THIS_RUN')) {
    process.stderr.write('stub agent: asked to fail\\n');
    process.exit(1);
  }
  process.stdout.write('investigated, wrote the issue\\n');
  process.stdout.write('${ISSUE_URL}\\n');
});
`, 'utf8');

writeFileSync(ghStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('issue') && args.includes('view')) {
  process.stdout.write(JSON.stringify({
    number: 46,
    title: 'Attach N reference images to an issue block',
    body: 'Read live rather than stored on the block.',
    state: 'OPEN',
  }));
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'issue-images', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Issue Images Check',
  repo: 'vitorengers/vibemaxxing',
}), 'utf8');

const running = [];

function startCanvas(port) {
  const child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
      EXCALIDRAW_ISSUE_AGENT: `node "${agentStub.replace(/\\/g, '/')}"`,
    },
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

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=issue-images`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** What the stub agent recorded for the run that just finished. */
function lastRun() {
  if (!existsSync(agentLog)) return null;
  const lines = readFileSync(agentLog, 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

async function attach(dataURL, mimeType, id) {
  await call('/api/files', {
    method: 'POST',
    body: JSON.stringify({ files: [{ id, dataURL, mimeType }] }),
  });
  return id;
}

async function block(observation, images) {
  const created = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 400, height: 120,
      text: observation,
      customData: { kind: 'issue', ...(images ? { issueImages: images } : {}) },
    }),
  });
  return created.body?.element?.id;
}

/**
 * Wait for a path to disappear.
 *
 * The state on the element is written before the cleanup runs — the block is told the
 * issue exists as soon as it does — so "after the run" is a moment the element cannot
 * name precisely. A bounded wait asserts removal without asserting an ordering nobody
 * promised.
 */
async function gone(path, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

/** Run a block and wait for the state to settle. */
async function run(id) {
  const started = await call(`/api/issue-block/${id}`, { method: 'POST' });
  if (started.status !== 202) return { started, element: null };
  for (let attempt = 0; attempt < 80; attempt++) {
    await sleep(250);
    const element = (await call(`/api/elements/${id}`)).body?.element;
    if (element?.customData?.issueState !== 'running') return { started, element };
  }
  return { started, element: null };
}

try {
  const canvas = startCanvas(port);
  await waitForHealth(BASE, canvas.child, canvas.read);

  const { ISSUE_AGENT_PROMPT, issueTargetSection } =
    await importDist(join('core', 'issue-agent.js'), 'the issue agent');
  // This project names a `repo`, and since #335 a board that names one says so in the prompt.
  // Composed rather than hard-coded, because the subject here is the images: the baseline has
  // to be the same board with nothing attached.
  const targetSection = issueTargetSection({ repo: 'vitorengers/vibemaxxing', githubProject: null });

  console.log('1. a block with nothing attached sends the prompt it sends today');
  const plainText = 'The docs panel is slow to open on large boards';
  const plain = await run(await block(plainText, null));
  check('the run was accepted', plain.started.status === 202, `got ${plain.started.status}`);
  check('it reached created', plain.element?.customData?.issueState === 'created',
        JSON.stringify(plain.element?.customData));
  const plainPrompt = lastRun()?.prompt;
  check('the prompt is byte-identical to the one without this feature',
        plainPrompt === `${ISSUE_AGENT_PROMPT}\n\n---\n\nObservation:\n\n${plainText}${targetSection}`,
        JSON.stringify(plainPrompt?.slice(-200)));

  console.log('\n2. N attached images arrive as N readable files, named in the prompt');
  const pngId = await attach(`data:image/png;base64,${PNG_BASE64}`, 'image/png', 'file-png');
  const gifId = await attach(`data:image/gif;base64,${GIF_BASE64}`, 'image/gif', 'file-gif');
  const withImagesId = await block('Two screenshots of the same panel', [pngId, gifId]);
  const withImages = await run(withImagesId);
  check('the run was accepted', withImages.started.status === 202, `got ${withImages.started.status}`);
  check('it reached created', withImages.element?.customData?.issueState === 'created',
        JSON.stringify(withImages.element?.customData));

  const twoRun = lastRun();
  check('the prompt names two files', twoRun?.images?.length === 2,
        `named ${twoRun?.images?.length} — ${JSON.stringify(twoRun?.images)}`);
  check('both were readable while the agent ran',
        twoRun?.images?.length === 2 && twoRun.images.every((image) => image.error === null),
        JSON.stringify(twoRun?.images));
  check('with the bytes that were attached, not a placeholder',
        twoRun?.images?.[0]?.bytes === PNG_BYTES && twoRun?.images?.[1]?.bytes === GIF_BYTES,
        `${twoRun?.images?.[0]?.bytes}/${PNG_BYTES}, ${twoRun?.images?.[1]?.bytes}/${GIF_BYTES}`);
  check('the extension comes from the mime type',
        /\.png$/.test(twoRun?.images?.[0]?.path ?? '') && /\.gif$/.test(twoRun?.images?.[1]?.path ?? ''),
        JSON.stringify(twoRun?.images?.map((image) => image.path)));
  check('the paths are inside the project, spelled the way the agent sees it',
        twoRun?.images?.length === 2
          && twoRun.images.every((image) => image.path.startsWith(projectDir.replace(/\\/g, '/'))),
        JSON.stringify(twoRun?.images?.map((image) => image.path)));
  check('and the prompt says they are reference material, not issue content',
        /reference/i.test(twoRun?.prompt ?? '') && /Reference images/.test(twoRun?.prompt ?? ''));

  console.log('\n3. the files are gone once the run is over');
  const runDir = twoRun?.images?.[0]?.path ? dirname(twoRun.images[0].path) : null;
  check('the run directory was removed', Boolean(runDir) && await gone(runDir),
        runDir ?? 'no file was ever written to remove');
  check('and it left no empty parent behind',
        await gone(join(projectDir, '.excalidraw-issue-images')),
        join(projectDir, '.excalidraw-issue-images'));

  console.log('\n4. a fileId with no image behind it costs the run nothing');
  const partial = await run(await block('One screenshot and one dangling id', [pngId, 'file-vanished']));
  check('the run still succeeded', partial.element?.customData?.issueState === 'created',
        JSON.stringify(partial.element?.customData));
  const partialRun = lastRun();
  check('the prompt names only the image that existed', partialRun?.images?.length === 1,
        JSON.stringify(partialRun?.images));
  check('and that one was readable', partialRun?.images?.[0]?.error === null,
        JSON.stringify(partialRun?.images));

  console.log('\n5. a failed run cleans up too');
  const failed = await run(await block('FAIL_THIS_RUN — the agent dies holding the images', [pngId]));
  check('the run failed, as asked', failed.element?.customData?.issueState === 'failed',
        JSON.stringify(failed.element?.customData));
  const failedRun = lastRun();
  check('the images had been written for it', failedRun?.images?.[0]?.error === null,
        JSON.stringify(failedRun?.images));
  const failedDir = failedRun?.images?.[0]?.path ? dirname(failedRun.images[0].path) : null;
  check('and were removed on the way out', Boolean(failedDir) && await gone(failedDir),
        failedDir ?? 'no file was ever written to remove');
  check('leaving no empty parent behind',
        await gone(join(projectDir, '.excalidraw-issue-images')));

  console.log('\n6. the panel can read an attached image back');
  const file = await call(`/api/files/${pngId}`);
  check('200 for a file that exists', file.status === 200, `got ${file.status}`);
  check('with its dataURL', typeof file.body?.file?.dataURL === 'string'
        && file.body.file.dataURL.includes(PNG_BASE64), JSON.stringify(file.body).slice(0, 120));
  const missingFile = await call('/api/files/file-vanished');
  check('404 for one that does not', missingFile.status === 404, `got ${missingFile.status}`);

  console.log('\n7. attaching an image does not reopen a block that already has an issue');
  const doneId = await block('Already researched', [pngId]);
  await call(`/api/elements/${doneId}`, {
    method: 'PUT',
    body: JSON.stringify({
      customData: { kind: 'issue', issueImages: [pngId], issueState: 'created', issueUrl: ISSUE_URL },
    }),
  });
  const reopened = await call(`/api/issue-block/${doneId}`, { method: 'POST' });
  check('409, with the issue it already has', reopened.status === 409, `got ${reopened.status}`);
  check('and it returns that issue', reopened.body?.issueUrl === ISSUE_URL, reopened.body?.issueUrl);

  console.log('\n8. the panel resolves what a block has attached');
  const { resolvePanelTarget } = await importDist(join('core', 'panel-target.js'), 'the panel target resolver');
  const target = resolvePanelTarget([{
    id: 'block-1', type: 'rectangle', x: 0, y: 0, width: 400, height: 120,
    customData: { kind: 'issue', issueImages: ['file-png', 'file-gif'] },
  }], ['block-1']);
  check('the attached images reach the panel',
        JSON.stringify(target?.issue?.images) === JSON.stringify(['file-png', 'file-gif']),
        JSON.stringify(target?.issue?.images));
  const empty = resolvePanelTarget([{
    id: 'block-2', type: 'rectangle', x: 0, y: 0, width: 400, height: 120,
    customData: { kind: 'issue' },
  }], ['block-2']);
  check('a block with none reads as none, not as undefined',
        Array.isArray(empty?.issue?.images) && empty.issue.images.length === 0,
        JSON.stringify(empty?.issue?.images));
} finally {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
