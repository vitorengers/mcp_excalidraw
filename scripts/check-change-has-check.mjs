#!/usr/bin/env node
/**
 * Checks that a change to the product's source arrived with a check — or said why it did not.
 *
 * The central rule of this repository is that every behaviour change ships with a
 * `scripts/check-*.mjs`, written before the fix and run against the old code first. It was
 * enforced by nothing mechanical. No script had ever looked at a diff; the only required
 * signals were the type check, the build and the tiers a runner could satisfy, and every one of
 * those is happy with a source change that brought no check at all. The nearest proxy — the
 * development-log row `check-board-map.mjs` insists on — is a maintainer-only artifact and says
 * nothing about checks. A rule that lives only in prose is the first thing a fork loses.
 *
 * So this is the diff-shaped half of it, and it is deliberately the *weak* half:
 *
 *   - it asks whether a `scripts/check-*.mjs` was **added or modified in the same range** as a
 *     change under `src/` or `frontend/src/`. That is the one part of the rule a machine can
 *     see.
 *   - it cannot ask whether the check was written **first**, and does not pretend to. A squashed
 *     pull request has one commit and no ordering left in it, and a check that guessed at
 *     ordering from commit timestamps would be a check anybody could satisfy by committing in
 *     the other order. Ordering is verified by a person reading the failing output the pull
 *     request template asks to be pasted, and `CONTRIBUTING.md` says so in those words rather
 *     than implying a robot has it covered.
 *
 * ### The escape hatch is a trailer, not a label
 *
 * The rule fires on renames, formatting sweeps, dependency bumps and pure refactors — real
 * changes under `src/` that alter no behaviour and have no check to bring. Those need a way
 * past, and the way past is a `No-behaviour-change: <reason>` line in the pull request body.
 *
 * A trailer rather than a label, because GitHub's squash merge puts the body into the merge
 * commit and drops the labels: a year from now `git log` still carries the sentence somebody
 * wrote to explain why that change needed no check, and the label would be a fact about a web
 * page. The reason has to be non-empty for the same reason — a bare `No-behaviour-change:` is a
 * box ticked, and a box ticked is not an argument.
 *
 * Both spellings of the word are accepted, and the key is matched without regard to case. A
 * contributor held up over a vowel learns that the gate is pedantic, not that the rule matters.
 *
 * ### Two modes, and the default one takes no arguments
 *
 * With **no arguments** this is the suite's check: it drives the decision over inline fixtures,
 * then builds two throwaway git repositories with real commits in them and runs *itself* over
 * their ranges, then asserts this repository's own documents and workflow still carry the rule.
 * Nothing outside the temporary directory is read or written.
 *
 * With **`--base <ref>`** it is the gate: `git diff --name-status base...HEAD` in `--repo`
 * (this repository by default), the pull request body from `--body`/`--body-file`, and an exit
 * code. That is the form `.github/workflows/ci.yml`'s `pr-discipline` job runs, and the form to
 * type by hand before opening a pull request.
 *
 * Exit codes: 0 the rule holds, 1 it does not, 2 the question could not be asked — an
 * unresolvable ref or a checkout too shallow to hold the base, which is a fact about the
 * checkout rather than about the branch.
 *
 * Offline and self-contained apart from `git`. No server, no browser, no build.
 *
 * Usage:
 *   node scripts/check-change-has-check.mjs
 *   node scripts/check-change-has-check.mjs --base origin/main [--head HEAD] [--repo <dir>]
 *                                           [--body <text> | --body-file <path>]
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(selfPath), '..');

// ─── The rule, as three predicates ────────────────────────────

/**
 * What counts as the product's source.
 *
 * The server and the frontend, and nothing else. `scripts/` is the checks themselves,
 * `launchers/` and `skills/` are packaging, and `docs/` is prose — a rule that fired on all of
 * them would fire on every change, and a rule that fires on every change gets an escape hatch
 * typed without reading it.
 */
const SOURCE = [/^src\//, /^frontend\/src\//];

/** A check script, by the name the rest of the suite selects on. */
const CHECK_SCRIPT = /^scripts\/check-[A-Za-z0-9._-]+\.mjs$/;

/**
 * The escape hatch, as it appears in a pull request body.
 *
 * Anchored to the start of its own line, so a sentence *about* the trailer — this file,
 * `CONTRIBUTING.md`, a review comment arguing that the change does not qualify — is not one.
 * A leading list marker is allowed because a pull request body is Markdown and a rule that
 * fires on a bare line but not on the same words after a `-` is a rule that reads as a bug.
 */
const TRAILER = /^[ \t]*(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)?No-beha[vw]?i?o?u?r?-change:[ \t]*(.*)$/im;

/** A placeholder nobody replaced. `<why this changes no behaviour>` is not a reason. */
const PLACEHOLDER = /^<[^>]*>$/;

/**
 * The body as the author wrote it, with the template's own instructions taken out.
 *
 * `.github/pull_request_template.md` carries the trailer in an HTML comment, because a form
 * somebody has to retype from prose is a form that gets typed wrong. A comment is guidance and
 * not a statement, so it is removed before anything looks for one — otherwise every pull
 * request opened from the template would arrive pre-excused.
 */
const withoutComments = (body) => String(body ?? '').replace(/<!--[\s\S]*?-->/g, '');

const isSource = (path) => SOURCE.some((rule) => rule.test(path));

/** `null` for no trailer at all, `''` for one with no usable reason, else the reason. */
function trailerReason(body) {
  const found = TRAILER.exec(withoutComments(body));
  if (!found) return null;
  const reason = found[1].trim();
  return PLACEHOLDER.test(reason) ? '' : reason;
}

/**
 * The whole decision, over `{ status, path }` records.
 *
 * A deleted check script does not count as one shipped: `git diff` lists it in the range, and a
 * change that removes the only check covering what it just rewrote is the case this rule exists
 * for. Everything else counts, deletions of source included — removing a file is a behaviour
 * change like any other.
 */
function verdict({ changed, body }) {
  const source = changed.filter(({ path }) => isSource(path));
  const checks = changed.filter(({ status, path }) => status !== 'D' && CHECK_SCRIPT.test(path));
  if (source.length === 0) return { ok: true, why: 'no-source', source, checks };
  if (checks.length > 0) return { ok: true, why: 'check', source, checks };
  const reason = trailerReason(body);
  if (reason) return { ok: true, why: 'trailer', reason, source, checks };
  return { ok: false, why: reason === null ? 'no-check' : 'empty-trailer', source, checks };
}

// ─── git ──────────────────────────────────────────────────────

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim() || result.error?.message || '',
  };
}

/**
 * `git diff --name-status -z --no-renames base...head`, as records.
 *
 * `--no-renames` on purpose: a rename comes back as a delete and an add, which is what it is
 * to this rule. Told about renames, git would report `R100` for a file that moved and this
 * would have to decide whether a moved source file is a source change — and it is, which is
 * exactly the case the risk in the issue named and the trailer answers.
 */
function changedFiles(base, head, cwd) {
  const diff = git(['diff', '--name-status', '-z', '--no-renames', `${base}...${head}`], cwd);
  if (!diff.ok) return { error: diff.stderr };
  const fields = diff.stdout.split('\0').filter((field) => field !== '');
  const changed = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    changed.push({ status: fields[index][0], path: fields[index + 1].split('\\').join('/') });
  }
  return { changed };
}

// ─── The gate ─────────────────────────────────────────────────

function parseArguments(argv) {
  const options = { repo: repoRoot, head: 'HEAD', body: '' };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--base') { options.base = value; index++; continue; }
    if (flag === '--head') { options.head = value; index++; continue; }
    if (flag === '--repo') { options.repo = value; index++; continue; }
    if (flag === '--body') { options.body = value ?? ''; index++; continue; }
    if (flag === '--body-file') { options.bodyFile = value; index++; continue; }
    return { error: `unknown argument: ${flag}` };
  }
  return options;
}

const USAGE = `Usage:
  node scripts/check-change-has-check.mjs
  node scripts/check-change-has-check.mjs --base <ref> [--head <ref>] [--repo <dir>]
                                          [--body <text> | --body-file <path>]

With no arguments this runs its own cases. With --base it is the gate: a change under src/ or
frontend/src/ has to arrive with a scripts/check-*.mjs added or modified in the same range, or
the body has to carry a "No-behaviour-change: <reason>" trailer.`;

function gate(options) {
  if (options.bodyFile !== undefined) {
    if (!existsSync(options.bodyFile)) {
      console.error(`cannot read the pull request body: ${options.bodyFile} does not exist`);
      return 2;
    }
    options.body = readFileSync(options.bodyFile, 'utf8');
  }

  for (const ref of [options.base, options.head]) {
    if (!git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], options.repo).ok) {
      console.error(`cannot resolve ${ref} in ${options.repo}.`);
      console.error('A shallow clone does not hold the base of a pull request — check out with '
                    + 'fetch-depth: 0. This is a fact about the checkout, not about the branch.');
      return 2;
    }
  }

  const { changed, error } = changedFiles(options.base, options.head, options.repo);
  if (error) { console.error(`git diff failed: ${error}`); return 2; }

  const result = verdict({ changed, body: options.body });
  const range = `${options.base}...${options.head}`;

  if (result.why === 'no-source') {
    console.log(`ok — ${range} changes nothing under src/ or frontend/src/ `
                + `(${changed.length} file(s) changed)`);
    return 0;
  }
  if (result.why === 'check') {
    console.log(`ok — ${result.source.length} source file(s) changed, and the range carries `
                + `${result.checks.length} check script(s):`);
    for (const { path } of result.checks) console.log(`       ${path}`);
    console.log('Whether the check was written *first* is not something this can see. '
                + 'The pull request has to paste what it printed when it was red.');
    return 0;
  }
  if (result.why === 'trailer') {
    console.log(`ok — ${result.source.length} source file(s) changed with no check, and the body `
                + 'says why:');
    console.log(`       No-behaviour-change: ${result.reason}`);
    return 0;
  }

  console.error(`FAIL — ${range} changes ${result.source.length} source file(s) and adds or `
                + 'modifies no scripts/check-*.mjs:');
  for (const { status, path } of result.source.slice(0, 20)) console.error(`       ${status} ${path}`);
  if (result.source.length > 20) console.error(`       … and ${result.source.length - 20} more`);
  console.error('');
  if (result.why === 'empty-trailer') {
    console.error('The body carries a No-behaviour-change: trailer with nothing after the colon. '
                  + 'The reason is the whole point of it — a box ticked is not an argument.');
  } else {
    console.error('Every behaviour change ships with a scripts/check-*.mjs, run against the old '
                  + 'code first. See CONTRIBUTING.md.');
  }
  console.error('');
  console.error('Two ways past this, and only two:');
  console.error('  1. add the check, and paste in the pull request what it printed when it was red;');
  console.error('  2. or put a line in the pull request body saying why this changes no behaviour:');
  console.error('');
  console.error('       No-behaviour-change: a rename, no call site changed');
  console.error('');
  console.error('It is a trailer rather than a label so that the squash merge carries it into '
                + 'git log.');
  return 1;
}

// ─── The cases ────────────────────────────────────────────────

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const files = (...paths) => paths.map((entry) => {
  const [status, path] = entry.includes(' ') ? entry.split(/\s+/) : ['M', entry];
  return { status, path };
});

function selfTest() {
  console.log('0. the decision, over file lists');

  check('a source change with no check and no trailer fails',
        verdict({ changed: files('src/server.ts'), body: 'Closes #1' }).ok === false);
  check('the same range with a check script in it passes',
        verdict({ changed: files('src/server.ts', 'A scripts/check-thing.mjs'), body: '' }).ok === true);
  check('a range under frontend/src counts as source',
        verdict({ changed: files('frontend/src/app.tsx'), body: '' }).ok === false);
  check('a range that touches neither passes',
        verdict({ changed: files('docs/index.md', 'README.md'), body: '' }).why === 'no-source');
  check('a deleted source file is still a source change',
        verdict({ changed: files('D src/gone.ts'), body: '' }).ok === false);
  check('a deleted check script does not count as one shipped',
        verdict({ changed: files('src/server.ts', 'D scripts/check-gone.mjs'), body: '' }).ok === false);
  check('a modified check script does',
        verdict({ changed: files('src/server.ts', 'M scripts/check-thing.mjs'), body: '' }).ok === true);
  check('scripts/lib is not a check script',
        verdict({ changed: files('src/server.ts', 'A scripts/lib/helper.mjs'), body: '' }).ok === false);
  check('run-checks.mjs is not a check script either',
        verdict({ changed: files('src/server.ts', 'M scripts/run-checks.mjs'), body: '' }).ok === false);

  console.log('\n1. the trailer, and only on its own line');

  const trailer = (body) => verdict({ changed: files('src/server.ts'), body });
  check('a trailer with a reason lets a source-only range through',
        trailer('Closes #1\n\nNo-behaviour-change: a rename, no call site changed').ok === true);
  check('and the reason is what it reports',
        trailer('No-behaviour-change: a rename').reason === 'a rename');
  check('a trailer with nothing after the colon does not',
        trailer('Closes #1\n\nNo-behaviour-change:').why === 'empty-trailer');
  check('nor one with only whitespace after it',
        trailer('No-behaviour-change:    \n').why === 'empty-trailer');
  check('the key is matched without regard to case',
        trailer('no-behaviour-change: lowercase, and fine').ok === true);
  check('and the other spelling of the word is accepted',
        trailer('No-behavior-change: an American vowel').ok === true);
  check('a sentence mentioning the trailer mid-line is not one',
        trailer('We discussed a No-behaviour-change: line and decided against it, because this '
                + 'really does change behaviour.').ok === false,
        'the trailer has to start its own line, or quoting the rule satisfies it');
  check('a trailer written as a checklist item still counts',
        trailer('- [x] No-behaviour-change: a dependency bump').ok === true);
  check('an empty body is no trailer at all', trailer('').why === 'no-check');
  check('a placeholder nobody replaced is not a reason',
        trailer('No-behaviour-change: <why this changes no behaviour>').why === 'empty-trailer');
  check('and the template\'s own instructions do not excuse the change that used it',
        trailer('<!--\nIf this changes no behaviour, write:\n'
                + 'No-behaviour-change: a rename\n-->\n\nCloses #1').why === 'no-check',
        'a form that arrives pre-excused excuses everything');

  // ─── 2. Real commits, in throwaway repositories ─────────────

  console.log('\n2. the gate, over real commits in throwaway repositories');

  const workDir = mkdtempSync(join(tmpdir(), 'change-has-check-'));
  try {
    /** A repository with one commit per entry, and the SHA of each. */
    function makeRepo(name, commits) {
      const dir = join(workDir, name);
      mkdirSync(dir, { recursive: true });
      const must = (args) => {
        const result = git(args, dir);
        if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        return result.stdout.trim();
      };
      // Pinned rather than inherited: an identity, a signing setting or a hooks path from the
      // machine running this would be a third party in a fixture.
      must(['init', '-q', '-b', 'main']);
      must(['config', 'user.email', 'check@example.com']);
      must(['config', 'user.name', 'Check']);
      must(['config', 'commit.gpgsign', 'false']);
      must(['config', 'core.hooksPath', join(dir, 'no-hooks')]);
      const shas = [];
      for (const { message, write = {}, remove = [] } of commits) {
        for (const [path, content] of Object.entries(write)) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), content, 'utf8');
        }
        for (const path of remove) rmSync(join(dir, path), { force: true });
        must(['add', '-A']);
        must(['commit', '-qm', message]);
        shas.push(must(['rev-parse', 'HEAD']));
      }
      return { dir, shas };
    }

    /** This very script, over a range, the way the workflow runs it. */
    function run(dir, base, extra = []) {
      const result = spawnSync(process.execPath, [selfPath, '--repo', dir, '--base', base, ...extra],
                               { encoding: 'utf8' });
      return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    }

    const BASE = {
      'src/server.ts': 'export const version = 1;\n',
      'frontend/src/app.ts': 'export const app = 1;\n',
      'scripts/check-thing.mjs': '// Tier: fast\n',
      'docs/index.md': '# Docs\n',
    };

    // One repository, three commits past the base, each reached by SHA. The base commit
    // is shared, so every range below starts from the same tree and differs only in what the
    // commit under test did.
    const bare = makeRepo('bare', [
      { message: 'base', write: BASE },
      { message: 'a source change and nothing else',
        write: { 'src/server.ts': 'export const version = 2;\n' } },
      { message: 'a source change with its check',
        write: { 'src/server.ts': 'export const version = 3;\n',
                 'scripts/check-new-thing.mjs': '// Tier: fast\n' } },
      { message: 'documentation only', write: { 'docs/index.md': '# Docs, again\n' } },
    ]);
    const [baseSha, sourceOnly, withCheck, docsOnly] = bare.shas;

    const sourceOnlyRun = run(bare.dir, baseSha, ['--head', sourceOnly]);
    check('a range touching only src/ exits non-zero', sourceOnlyRun.code === 1,
          `exit ${sourceOnlyRun.code}: ${sourceOnlyRun.out.trim().split('\n')[0]}`);
    check('and says which source file it was',
          sourceOnlyRun.out.includes('src/server.ts'), sourceOnlyRun.out);
    check('and names both ways past it',
          /No-behaviour-change:/.test(sourceOnlyRun.out) && /CONTRIBUTING\.md/.test(sourceOnlyRun.out),
          sourceOnlyRun.out);

    const withCheckRun = run(bare.dir, sourceOnly, ['--head', withCheck]);
    check('a range touching src/ and a scripts/check-*.mjs exits zero', withCheckRun.code === 0,
          `exit ${withCheckRun.code}: ${withCheckRun.out}`);
    check('and names the check it found',
          withCheckRun.out.includes('scripts/check-new-thing.mjs'), withCheckRun.out);
    check('while still saying that the ordering is not something it can see',
          /written \*first\* is not something this can see/.test(withCheckRun.out), withCheckRun.out);

    const docsRun = run(bare.dir, withCheck, ['--head', docsOnly]);
    check('a range touching neither exits zero', docsRun.code === 0,
          `exit ${docsRun.code}: ${docsRun.out}`);

    // The trailer, passed the two ways the gate accepts it.
    const inline = run(bare.dir, baseSha,
                       ['--head', sourceOnly, '--body', 'Closes #1\n\nNo-behaviour-change: a rename']);
    check('the same src/-only range exits zero when the body carries the trailer',
          inline.code === 0, `exit ${inline.code}: ${inline.out}`);
    check('and echoes the reason back', inline.out.includes('a rename'), inline.out);

    const bodyPath = join(workDir, 'body.txt');
    writeFileSync(bodyPath, 'Closes #1\n\nNo-behaviour-change: a dependency bump\n', 'utf8');
    const fromFile = run(bare.dir, baseSha, ['--head', sourceOnly, '--body-file', bodyPath]);
    check('--body-file is read the same way', fromFile.code === 0,
          `exit ${fromFile.code}: ${fromFile.out}`);

    const empty = run(bare.dir, baseSha,
                      ['--head', sourceOnly, '--body', 'Closes #1\n\nNo-behaviour-change:']);
    check('a trailer with no reason after it does not let the range through', empty.code === 1,
          `exit ${empty.code}: ${empty.out}`);

    // A rename, which is the case the risk in the issue named: `--no-renames` makes it a delete
    // and an add, and both are source changes, so the trailer is the only way past.
    const renamed = makeRepo('renamed', [
      { message: 'base', write: BASE },
      { message: 'move a file', write: { 'src/moved.ts': 'export const version = 1;\n' },
        remove: ['src/server.ts'] },
    ]);
    const renameRun = run(renamed.dir, renamed.shas[0]);
    check('a rename under src/ is a source change, and fails without the trailer',
          renameRun.code === 1, `exit ${renameRun.code}: ${renameRun.out}`);
    check('and passes with it',
          run(renamed.dir, renamed.shas[0],
              ['--body', 'No-behaviour-change: a rename, no call site changed']).code === 0);

    // A range that deletes the check covering what it rewrote.
    const dropped = makeRepo('dropped', [
      { message: 'base', write: BASE },
      { message: 'rewrite the thing and drop its check',
        write: { 'src/server.ts': 'export const version = 9;\n' },
        remove: ['scripts/check-thing.mjs'] },
    ]);
    check('a range that deletes a check while changing src/ does not count it as one shipped',
          run(dropped.dir, dropped.shas[0]).code === 1);

    // And a checkout that cannot answer says so, rather than answering wrongly.
    const unknown = run(bare.dir, '0000000000000000000000000000000000000000');
    check('an unresolvable base exits 2 rather than passing or failing the branch',
          unknown.code === 2, `exit ${unknown.code}: ${unknown.out}`);
    check('and says a shallow clone is the likely reason',
          /fetch-depth: 0/.test(unknown.out), unknown.out);
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }

  // ─── 3. And the rule is written where a contributor reads ───

  console.log('\n3. the rule is written down where somebody outside this board will find it');

  const read = (path) => (existsSync(join(repoRoot, path)) ? readFileSync(join(repoRoot, path), 'utf8') : '');

  const TRAILER_NAMED = /No-beha[vw]?i?o?u?r?-change:/i;

  for (const file of ['CONTRIBUTING.md', 'AGENTS.md']) {
    const text = read(file);
    check(`${file} names the escape hatch as a trailer`, TRAILER_NAMED.test(text),
          'a rule with no way past is a rule people route around');
    check(`${file} names this check`, /check-change-has-check\.mjs/.test(text),
          'the gate a pull request will meet is not a surprise to spring on somebody');
  }

  check('CONTRIBUTING.md names the tier a contributor is actually held to',
        /--tier\s+fast,browser/.test(read('CONTRIBUTING.md')),
        '`repo` and `wsl` cannot be satisfied from a fork, and a gate nobody can pass is a gate '
        + 'nobody tries');
  check('CONTRIBUTING.md says a person verifies the ordering, not a script',
        /ordering/i.test(read('CONTRIBUTING.md'))
        && /(no script|nothing mechanical|cannot be recovered|not recoverable|a person|a human)/i
          .test(read('CONTRIBUTING.md')),
        'the one part of the rule no diff can carry has to be stated, or the gate reads as the '
        + 'whole of it');

  const template = read('.github/pull_request_template.md');
  check('the pull request template asks for the check by name',
        /scripts\/check-/.test(template));
  check('and for the command that ran it',
        /node scripts\/check-/.test(template));
  check('and for what it printed when it was red',
        /(pasted?|paste|printed|output)/i.test(template) && /red|fail/i.test(template));
  check('and offers the trailer as the other answer', TRAILER_NAMED.test(template));

  // The workflow half. Parsed loosely on purpose — `check-ci-workflow.mjs` owns the shape of
  // `ci.yml`, and what this needs to know is only that the gate is wired to a pull request with
  // a history deep enough to answer.
  const workflow = read('.github/workflows/ci.yml');
  const job = workflow.split(/^\s{2}[a-z][a-z0-9-]*:\s*$/m)
    .find((section) => /check-change-has-check\.mjs/.test(section)) ?? '';
  check('ci.yml runs this check', job !== '', 'no job in ci.yml invokes it');
  check('the job is a pull_request job',
        /pull_request/.test(job) || /pull_request/.test(workflow.split('jobs:')[0] ?? ''),
        'a push to the default branch has no body to carry the trailer');
  check('and checks out with fetch-depth: 0',
        /fetch-depth:\s*0/.test(job),
        'a shallow clone does not hold the base commit, and the gate would exit 2 on every run');

  console.log('');
  if (failures) { console.error(`${failures} case(s) failed`); return 1; }
  console.log('All checks passed');
  return 0;
}

// ─── Which one ────────────────────────────────────────────────

const options = parseArguments(process.argv.slice(2));
if (options.help) { console.log(USAGE); process.exit(0); }
if (options.error) { console.error(`${options.error}\n\n${USAGE}`); process.exit(2); }
process.exit(options.base === undefined ? selfTest() : gate(options));
