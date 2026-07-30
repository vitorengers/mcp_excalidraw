#!/usr/bin/env node
/**
 * Checks that observations can be added to an issue the board already opened.
 *
 * The issue agent is told to end with the open questions it could not answer, and the
 * implement agent is told to decide them alone because nobody can answer mid-run. Between
 * those two runs there was no way to say anything: the panel's only action was
 * **Implement / Fix**, and the only place to answer a question was github.com in another
 * window.
 *
 * The case this exists for is the one the shape of the plumbing decides. A comment is free
 * text — newlines, quotes, backticks, `$(echo hi)` — and `runGh` appends its argument to a
 * command line that a WSL workspace runs through `bash -lc`. So the body must reach `gh`
 * on **stdin** and appear nowhere in argv, and that is what case 2 pins down: a stub `gh`
 * records both, and the check compares them byte for byte.
 *
 * Self-contained: it builds a throwaway git repository, writes a stub `gh` and a stub
 * implement agent, starts its own canvas servers and kills them. Nothing here talks to
 * GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * What it cannot check is the rendering. Case 10 pins the structure of the action row in
 * the source, but two buttons that share a row at 720px is a thing to look at in a
 * browser — this project has shipped three UI defects that compiled perfectly.
 *
 * Usage: node scripts/check-issue-comment.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The action row's own source, from `<div className="element-docs__actions">` to the
 * `</div>` that closes it.
 *
 * Case 10 is about which button comes first on screen, and the panel's own prose names
 * both — the hint an interrupted run shows says "Implement / Fix starts the issue again"
 * hundreds of lines above the row. A position compared over the whole file therefore
 * compares a button against a sentence about a button, which is how this case went red
 * with the row in exactly the order it means to assert. Reading the row itself is the
 * only substring where a label is a label.
 */
function actionRow(source) {
  const start = source.indexOf('<div className="element-docs__actions">');
  if (start < 0) return '';
  // Depth over `<div`/`</div>`; JSX here never self-closes a div, and a nested one would
  // otherwise end the row early.
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(source); match; match = tag.exec(source)) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return source.slice(start, match.index + match[0].length);
  }
  return '';
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim() };
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `issue-comment-${process.pid}`);
const ghStub = join(workDir, 'gh.mjs');
const agentStub = join(workDir, 'agent.mjs');
const registryPath = join(workDir, 'registry.json');
const logPath = join(workDir, 'gh-calls.jsonl');
const commentsPath = join(workDir, 'comments.json');
const failFlag = join(workDir, 'fail-comment');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
git(projectDir, ['init', '-b', 'main']);
git(projectDir, ['config', 'user.email', 'check@example.com']);
git(projectDir, ['config', 'user.name', 'Check']);
git(projectDir, ['config', 'commit.gpgsign', 'false']);
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Comment Check', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');
writeFileSync(join(projectDir, 'README.md'), '# comment check\n', 'utf8');
git(projectDir, ['add', '.']);
git(projectDir, ['commit', '-m', 'initial']);

/**
 * A `gh` that records what it was given.
 *
 * Both halves matter: `args` is what a shell would have seen, `stdin` is what it would
 * never have touched. It reads stdin only for a call that says `--body-file -`, because
 * for every other call nothing ends that pipe.
 */
writeFileSync(ghStub, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.STUB_GH_LOG;
const store = process.env.STUB_GH_COMMENTS;
const failFlag = process.env.STUB_GH_FAIL_FLAG;
const record = (stdin) => appendFileSync(log, JSON.stringify({ args, stdin }) + '\\n');
const comments = () => JSON.parse(readFileSync(store, 'utf8'));

if (args[0] === 'issue' && args[1] === 'comment') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    record(input);
    if (existsSync(failFlag)) {
      process.stderr.write('gh: could not add comment to issue\\n');
      process.exit(1);
    }
    const all = comments();
    all.push({
      author: { login: 'vitorengers' },
      body: input,
      createdAt: '2026-07-27T12:00:00Z',
      url: 'https://github.com/vitorengers/mcp_excalidraw/issues/7#issuecomment-' + (all.length + 1),
    });
    writeFileSync(store, JSON.stringify(all), 'utf8');
    process.stdout.write(all[all.length - 1].url + '\\n');
  });
} else if (args[0] === 'issue' && args[1] === 'view') {
  record(null);
  process.stdout.write(JSON.stringify({
    number: 7,
    title: 'An issue with questions left open',
    body: 'The body of the issue.',
    state: 'OPEN',
    comments: comments(),
  }));
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

/** Stands in for the implement agent, and answers at once with a pull request. */
writeFileSync(agentStub, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  process.stdout.write('https://github.com/vitorengers/mcp_excalidraw/pull/7\\n');
});
`, 'utf8');

writeFileSync(commentsPath, '[]', 'utf8');
writeFileSync(logPath, '', 'utf8');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'comments', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

const running = [];

function startCanvas(port, host) {
  const child = spawnCanvas({
    port,
    env: {
      HOST: host,
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
      STUB_GH_LOG: logPath,
      STUB_GH_COMMENTS: commentsPath,
      STUB_GH_FAIL_FLAG: failFlag,
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
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${read()}`);
}

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

const port = await freePort();
const remotePort = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const REMOTE_BASE = `http://127.0.0.1:${remotePort}`;

async function call(path, options = {}, base = BASE) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${base}${path}${glue}workspace=comments`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const ghCalls = () =>
  readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const commentCalls = () => ghCalls().filter((entry) => entry.args[1] === 'comment');

const ISSUE = 'https://github.com/vitorengers/mcp_excalidraw/issues/7';

const postComment = (body, url = ISSUE) =>
  call('/api/issue/comment', { method: 'POST', body: JSON.stringify({ url, body }) });

/**
 * Everything a shell would have mangled, in one body.
 *
 * `$(echo hi)` is the one that decides it: reaching a `bash -lc` it becomes `hi`, and the
 * comment posted is not the comment written.
 */
const NASTY = [
  'Answering the open questions.',
  '',
  'Verbatim, please — "double" and \'single\' quotes, `backticks`,',
  '$(echo hi) and $HOME and ${PATH}, a semicolon; a pipe | and an & ampersand,',
  'a > redirect and a < one, and a trailing backslash \\',
].join('\n');

try {
  const local = startCanvas(port, '127.0.0.1');
  await waitForHealth(BASE, local.child, local.read);

  console.log('1. an observation can be added to an issue that already exists');
  const posted = await postComment(NASTY);
  check('200 OK', posted.status === 200,
        `got ${posted.status}: ${JSON.stringify(posted.body).slice(0, 300)}`);
  check('exactly one gh comment ran', commentCalls().length === 1,
        `${commentCalls().length} calls: ${JSON.stringify(commentCalls().map((c) => c.args))}`);

  console.log('\n2. the body reaches gh on stdin and never on a command line');
  const call1 = commentCalls()[0] ?? { args: [], stdin: null };
  check('argv is the command and nothing else',
        JSON.stringify(call1.args) === JSON.stringify(['issue', 'comment', ISSUE, '--body-file', '-']),
        JSON.stringify(call1.args));
  check('the body arrived on stdin, byte for byte', call1.stdin === NASTY,
        JSON.stringify(call1.stdin));
  check('and no fragment of it is in argv',
        !call1.args.some((arg) => /echo hi|backticks|quotes/.test(arg)),
        JSON.stringify(call1.args));
  check('a substitution the shell would have run is still text',
        (call1.stdin ?? '').includes('$(echo hi)'),
        'the body was expanded somewhere between the panel and gh');

  console.log('\n3. an empty observation posts nothing and spawns no gh');
  const before = ghCalls().length;
  const empty = await postComment('');
  check('400 for an empty body', empty.status === 400, `got ${empty.status}`);
  const blank = await postComment('  \n\t  ');
  check('400 for whitespace only', blank.status === 400, `got ${blank.status}`);
  const notAnIssue = await postComment('something', 'https://github.com/vitorengers/mcp_excalidraw');
  check('400 for a URL that is not an issue', notAnIssue.status === 400, `got ${notAnIssue.status}`);
  check('no gh was spawned by any of them', ghCalls().length === before,
        `${ghCalls().length - before} extra call(s)`);

  console.log('\n4. the comment comes back, so the panel needs no reload');
  check('the response carries the issue', Boolean(posted.body?.issue),
        JSON.stringify(posted.body).slice(0, 200));
  const backImmediately = (posted.body?.issue?.comments ?? []).some((c) => c.body === NASTY);
  check('with the comment just posted in it', backImmediately,
        JSON.stringify(posted.body?.issue?.comments ?? []).slice(0, 300));
  const reread = await call(`/api/issue?url=${encodeURIComponent(ISSUE)}`);
  check('and reading the issue lists comments too',
        (reread.body?.issue?.comments ?? []).some((c) => c.body === NASTY),
        JSON.stringify(reread.body?.issue ?? {}).slice(0, 300));
  check('each comment says who wrote it',
        Boolean((reread.body?.issue?.comments ?? [])[0]?.author),
        JSON.stringify((reread.body?.issue?.comments ?? [])[0] ?? {}));

  console.log('\n5. a mirrored card, which has no element on the server, can comment');
  // Case 1 already did: nothing was ever created for this issue. Stated rather than
  // assumed, because addressing by element id is exactly what a card cannot do.
  const elements = (await call('/api/elements')).body?.elements ?? [];
  check('no element stands for this issue',
        !elements.some((el) => el?.customData?.issueUrl === ISSUE),
        `${elements.length} element(s) on the board`);

  console.log('\n6. a gh that fails reaches the panel as an error');
  writeFileSync(failFlag, '', 'utf8');
  const failed = await postComment('this one cannot be posted');
  rmSync(failFlag, { force: true });
  check('502, the failure is gh\'s and not the request\'s', failed.status === 502,
        `got ${failed.status}: ${JSON.stringify(failed.body).slice(0, 200)}`);
  check('and it carries what gh said',
        /could not add comment/i.test(failed.body?.error ?? ''), failed.body?.error);

  console.log('\n7. commenting changes nothing else about the block');
  const block = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
      customData: { kind: 'issue', issueState: 'created', issueUrl: ISSUE, issueTitle: 'An issue' },
    }),
  });
  const blockId = block.body.element.id;

  const implemented = await call('/api/implement', {
    method: 'POST', body: JSON.stringify({ url: ISSUE }),
  });
  check('the stub implementation started', implemented.status === 202, `got ${implemented.status}`);
  let record = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    record = (await call(`/api/implement?url=${encodeURIComponent(ISSUE)}`)).body?.implement ?? null;
    if (record?.state && record.state !== 'running') break;
    await sleep(150);
  }
  check('and finished', record?.state === 'done', JSON.stringify(record));

  // Taken after the run, not before it: the run itself mirrors its state onto the block,
  // and what this case is about is the comment changing nothing beyond that.
  const customBefore = JSON.stringify((await call(`/api/elements/${blockId}`)).body.element.customData);

  const afterImplement = await postComment('One more thing, now that a run has been made.');
  check('a comment is still accepted once the issue has a pull request',
        afterImplement.status === 200, `got ${afterImplement.status}`);

  const customAfter = JSON.stringify((await call(`/api/elements/${blockId}`)).body.element.customData);
  check('the block is untouched — issueState is still created', customAfter === customBefore,
        `before ${customBefore} after ${customAfter}`);
  const recordAfter = (await call(`/api/implement?url=${encodeURIComponent(ISSUE)}`)).body?.implement;
  check('the finished implementation is not cleared', recordAfter?.state === 'done',
        JSON.stringify(recordAfter));
  check('so the block does not become runnable again',
        recordAfter?.url === 'https://github.com/vitorengers/mcp_excalidraw/pull/7',
        JSON.stringify(recordAfter));

  console.log('\n8. it writes to GitHub, so it refuses to run off loopback');
  const remote = startCanvas(remotePort, '0.0.0.0');
  await waitForHealth(REMOTE_BASE, remote.child, remote.read);
  const off = await call('/api/issue/comment', {
    method: 'POST', body: JSON.stringify({ url: ISSUE, body: 'from the network' }),
  }, REMOTE_BASE);
  check('403 Forbidden', off.status === 403, `got ${off.status}`);
  check('and it says loopback', /loopback/i.test(off.body?.error ?? ''), off.body?.error);

  console.log('\n9. the implement agent is told the comments are part of the issue');
  const { IMPLEMENT_AGENT_PROMPT } = await import(
    new URL('../dist/core/implement-agent.js', import.meta.url).href
  );
  check('the prompt names gh issue view --comments',
        IMPLEMENT_AGENT_PROMPT.includes('gh issue view --comments'),
        'an observation added after the issue was written would never be read');

  console.log('\n10. the panel offers the two actions as one row');
  // Comments stripped: the prose around this code names both buttons, and a case that
  // reads the order out of a paragraph is reading the wrong thing.
  const panel = readFileSync(join(repoRoot, 'frontend', 'src', 'components', 'DocsPanel.tsx'), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const css = readFileSync(join(repoRoot, 'frontend', 'src', 'components', 'DocsPanel.css'), 'utf8');
  const row = actionRow(panel);
  check('Add observations and Implement / Fix share one container',
        row.includes('Add observations') && row.includes('Implement / Fix'),
        'the two buttons are not inside the same action row');
  check('Add observations comes first',
        row.includes('Add observations') && row.includes('Implement / Fix')
          && row.indexOf('Add observations') < row.indexOf('Implement / Fix'),
        'the observation says Add observations is the first of the two');
  const rowRule = css.match(/\.element-docs__actions\s*\{[^}]*\}/)?.[0] ?? '';
  const itemRule = css.match(/\.element-docs__action\s*\{[^}]*\}/)?.[0] ?? '';
  check('the row is a flex row', /display:\s*flex/.test(rowRule), rowRule || 'no rule');
  check('and each button takes a share of it rather than the whole width',
        /flex:\s*1/.test(itemRule), itemRule || 'no rule');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  stopAll();
  await sleep(300);
  if (existsSync(projectDir)) git(projectDir, ['worktree', 'prune']);
  try { rmSync(`${projectDir}-worktrees`, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ditto */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
