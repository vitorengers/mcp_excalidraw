#!/usr/bin/env node
/**
 * Checks that a thin checkout fails honestly, and that the export refuses to guess.
 *
 * Two scripts read something they had no right to assume was there.
 *
 * `check-board-map.mjs` asks `git log <fork base>..HEAD` for the merges it holds the
 * development log to. The fork base is a fixed historical fact and stays a hardcoded SHA —
 * `origin/main` moves and this is a question about a commit that does not — but on a
 * `--depth 1` clone that commit is simply absent, `git` answers `fatal: Invalid revision
 * range`, and an unguarded `execFileSync` turns that into an uncaught error. The check then
 * prints a stack trace instead of a verdict, and the four rules it had already asserted are
 * lost with it. `actions/checkout@v4` clones at depth 1 by default, so this is the shape a
 * contributor's CI run has. A missing commit is a fact about the checkout, not about the
 * branch, so rule 4 gives itself up and says so, and rules 1-3 and 5 still answer.
 *
 * `export-board.mjs` defaulted to `--url http://127.0.0.1:3737 --workspace board-tool` — the
 * operator's live board — and it is the only path into the tracked `docs/board.excalidraw`.
 * Run with no arguments in a clone it had never been pointed at, it wrote 225 elements of
 * somebody else's board over a tracked file and exited 0. The two flags are required now.
 *
 * How this is decided:
 *
 *   - the repository is cloned twice into a temporary directory, once with `--depth 1` and
 *     once in full, so the two checkouts differ in history and in nothing else. The
 *     comparison the definition of done asks for — the same exit code as a full clone — is
 *     then a comparison between two clones rather than against this machine's working tree;
 *   - the *working tree's* `check-board-map.mjs` and `export-board.mjs` are copied into both,
 *     so this check reads the scripts as they are on disk rather than as they were last
 *     committed. Nothing else is copied over the clones' own content: the board file, the
 *     documents and `git ls-files` are theirs;
 *   - `dist/core` is copied in as well. Rule 5 imports the compiled section resolver, and a
 *     clone has no `dist/`. The subject here is how deep the history is, not whether the
 *     clone was built, and a rule failing for the second reason would say nothing about the
 *     first.
 *
 * `export-board.mjs` is exercised inside the shallow clone, never in this working tree: the
 * old behaviour is to write `docs/board.excalidraw` from whatever answers on 3737, and a
 * check that proves that must not do it to the real file.
 *
 * Offline and self-contained apart from `git`. No server, no browser — and deliberately no
 * server for the export either, so a run cannot depend on whether the operator's board
 * happens to be up.
 *
 * Usage: node scripts/check-shallow-clone.mjs
 *
 * Tier: repo
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The same commit `check-board-map.mjs` reads from, stated again so a change to it is seen. */
const FORK_BASE = '505f4c6e0ca1fe2489b4c18c9fedc24ac50a9002';

/** What rule 4 has to say when it cannot see far enough back to answer. */
const SKIP_LINE = 'SKIPPED — shallow clone, the merge log cannot be verified here';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const workDir = mkdtempSync(join(tmpdir(), 'check-shallow-clone-'));

try {
  // ─── 0. Two clones of one repository ──────────────────────────
  console.log('0. the same checkout at two depths');

  const source = pathToFileURL(repoRoot).href;
  const shallow = join(workDir, 'shallow');
  const full = join(workDir, 'full');

  // `--depth` is ignored for a plain local path — git hardlinks the object store instead —
  // so the source has to be a file:// URL for the clone to actually come out shallow.
  const cloneShallow = run('git', ['clone', '--quiet', '--depth', '1', source, shallow], workDir);
  check('the repository clones at depth 1', cloneShallow.status === 0, cloneShallow.out);
  const cloneFull = run('git', ['clone', '--quiet', source, full], workDir);
  check('and again in full', cloneFull.status === 0, cloneFull.out);

  if (!existsSync(join(shallow, '.git')) || !existsSync(join(full, '.git'))) {
    console.error('\nboth clones are needed to decide anything here');
    process.exit(1);
  }

  const isShallow = (dir) => run('git', ['rev-parse', '--is-shallow-repository'], dir).out.trim();
  check('the first clone is shallow', isShallow(shallow) === 'true', isShallow(shallow));
  check('and the second is not', isShallow(full) === 'false', isShallow(full));

  const hasForkBase = (dir) =>
    run('git', ['cat-file', '-e', `${FORK_BASE}^{commit}`], dir).status === 0;
  check('the fork base is missing from the shallow clone', !hasForkBase(shallow),
        'without that, nothing here is being tested');
  check('and present in the full one', hasForkBase(full),
        'the full clone has to be able to answer rule 4 for the comparison to mean anything');

  // The scripts under test, as they are on disk right now, and the one build artifact rule 5
  // imports. Everything else in each clone is the clone's own.
  for (const dir of [shallow, full]) {
    for (const script of ['check-board-map.mjs', 'export-board.mjs']) {
      copyFileSync(join(repoRoot, 'scripts', script), join(dir, 'scripts', script));
    }
    mkdirSync(join(dir, 'dist'), { recursive: true });
    cpSync(join(repoRoot, 'dist', 'core'), join(dir, 'dist', 'core'), { recursive: true });
  }

  // ─── 1. Rule 4 gives itself up rather than throwing ────────────
  console.log('\n1. check-board-map.mjs on a depth-1 clone');

  const shallowRun = run(process.execPath, [join(shallow, 'scripts', 'check-board-map.mjs')], shallow);
  const fullRun = run(process.execPath, [join(full, 'scripts', 'check-board-map.mjs')], full);

  check('it says the merge log cannot be verified here', shallowRun.out.includes(SKIP_LINE),
        shallowRun.out.slice(-800));
  check('it does not print a stack trace',
        !/^\s+at\s/m.test(shallowRun.out) && !/Invalid revision range/.test(shallowRun.out),
        shallowRun.out.slice(-800));
  check('and it exits with the same code as the full clone',
        shallowRun.status === fullRun.status,
        `shallow ${shallowRun.status}, full ${fullRun.status}\n${shallowRun.out.slice(-800)}`);

  // The skip is worth nothing if the rule was never asserting in the first place, so the full
  // clone is held to the opposite: it answers rule 4 and never prints the skip.
  check('the full clone still answers rule 4',
        /every merged pull request has an entry/.test(fullRun.out) && !fullRun.out.includes(SKIP_LINE),
        fullRun.out.slice(-800));

  // And the rules that have nothing to do with the history are still being decided — the
  // failure this replaces took all four down with it.
  const STILL_ASSERTED = [
    'the board declares at least two sections',
    'no card with a document is outside every section',
    'no tracked document is left off the board',
    'this board binds one key per section',
  ];
  for (const line of STILL_ASSERTED) {
    check(`rule for "${line}" still runs`, shallowRun.out.includes(line), shallowRun.out.slice(-800));
  }

  // ─── 2. The export will not guess which board it is reading ────
  console.log('\n2. export-board.mjs with the flags left off');

  const boardPath = join(shallow, 'docs', 'board.excalidraw');
  const before = readFileSync(boardPath, 'utf8');
  const unchanged = () => readFileSync(boardPath, 'utf8') === before;
  const exportRun = (...args) =>
    run(process.execPath, [join(shallow, 'scripts', 'export-board.mjs'), ...args], shallow);

  // Matched on the refusal itself rather than on the flag name anywhere in the output: the
  // message that a request failed names `--url` too, and the control below turns on the
  // difference between the two.
  const refused = (out, flag) => new RegExp(`^Missing --${flag}\\b`, 'm').test(out);

  const noUrl = exportRun();
  check('no --url exits non-zero', noUrl.status !== 0, `exit ${noUrl.status}\n${noUrl.out}`);
  check('and says which flag is missing', refused(noUrl.out, 'url'), noUrl.out);
  check('and writes nothing', unchanged(), `${boardPath} was rewritten`);

  const noWorkspace = exportRun('--url', 'http://127.0.0.1:1');
  check('no --workspace exits non-zero', noWorkspace.status !== 0,
        `exit ${noWorkspace.status}\n${noWorkspace.out}`);
  check('and says which flag is missing', refused(noWorkspace.out, 'workspace'), noWorkspace.out);
  check('and writes nothing', unchanged(), `${boardPath} was rewritten`);

  // The control: a script that exits non-zero on everything would pass both cases above. With
  // both flags given it has to get past the arguments and fail on the fetch instead.
  const bothGiven = exportRun('--url', 'http://127.0.0.1:1', '--workspace', 'any-board');
  check('with both flags it gets as far as the request',
        bothGiven.status !== 0
        && !refused(bothGiven.out, 'url') && !refused(bothGiven.out, 'workspace'),
        `exit ${bothGiven.status}\n${bothGiven.out}`);
  check('and still writes nothing when the request fails', unchanged(), `${boardPath} was rewritten`);
  check('and reports the failure rather than throwing', !/^\s+at\s/m.test(bothGiven.out),
        bothGiven.out);

  // ─── 3. No default left in the file to fall back to ────────────
  console.log('\n3. the operator\'s board is not a default any more');

  const exportSource = readFileSync(join(repoRoot, 'scripts', 'export-board.mjs'), 'utf8');
  check('scripts/export-board.mjs names no port', !/3737/.test(exportSource),
        'a default url is one absent flag away from committing somebody else\'s board');

  // ─── 4. A reader is told the invocation ────────────────────────
  console.log('\n4. the documents give the whole command');

  const names = (file) => {
    const text = readFileSync(join(repoRoot, 'docs', file), 'utf8');
    return [...text.matchAll(/^.*export-board\.mjs.*$/gm)].map(([line]) => line);
  };
  for (const file of ['running.md', 'board-sections.md']) {
    const lines = names(file);
    check(`docs/${file} shows how to run the export`, lines.length > 0,
          'the only path into the tracked board file is undocumented there');
    check(`docs/${file} shows it with both flags`,
          lines.some((line) => /--url/.test(line)) && lines.some((line) => /--workspace/.test(line)),
          lines.join('\n') || 'no mention at all');
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
