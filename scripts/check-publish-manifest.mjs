#!/usr/bin/env node
/**
 * Checks what `npm publish` would actually put on the registry.
 *
 * `package.json`'s `files` allowlist was written once and never asserted, and the tarball it
 * produces is the one artifact of this project nobody can take back: an unpublish leaves a
 * tombstone on the name, which is how `vibemaxxing` stopped being claimable. Two things about
 * it were unproven before the first release.
 *
 * The first is the allowlist itself. It correctly excludes `.env`, but nothing said so — a
 * later `files` entry, or one deleted, changes what ships and no run goes red. So the listing
 * `npm pack` computes is compared against the allowlist it was computed from, which sounds
 * circular and is not: npm adds files of its own (`package.json`, the licence, the readme)
 * and the point is that *those* are the only additions.
 *
 * The second is what is inside the files. `docs/*.md` ships, and `docs/workspaces.md` carried
 * the maintainer's own `C:/Users/vtr_d/…` paths in its worked example — a home directory,
 * with a login name in it, published to npm under an MIT licence. The scan is for the shape
 * rather than for that one login: a `Users/<name>` or `/home/<name>/` segment fails unless
 * `<name>` is one of the placeholders this repository's documentation already uses, which is
 * the rule that also catches the next person's.
 *
 * Three rules:
 *
 *  1. **every packed path matches the `files` allowlist**, or is one npm includes whatever
 *     the allowlist says.
 *  2. **no packed file names a real home directory.** `C:\Users\you`, `/home/me` and
 *     `C:/Users/x` are worked examples and pass; a login name does not.
 *  3. **the manifest is this project's** — the packed name and version are `package.json`'s,
 *     and `package.json` carries no upstream identifier. `check-fork-identity.mjs` holds the
 *     identity fields themselves; this is the half that says the *tarball* agrees with them.
 *
 * Section 0 drives all three over listings and texts built in memory, one carrying each
 * defect and one carrying none, so a green run means the tree is clean rather than the
 * scanner having stopped looking.
 *
 * `npm pack --dry-run` writes nothing: it computes the listing and reports it. `--ignore-scripts`
 * keeps `prepack` out of it, so this never triggers a build — but it does mean the run reports
 * the tree as it stands, and a missing `dist/` is a listing with the largest half absent. That
 * is a failure here rather than a quiet pass, because the tarball nobody built is not the
 * tarball that ships.
 *
 * Offline apart from `npm pack`, which does not contact the registry. No server, no browser.
 *
 * Usage: node scripts/check-publish-manifest.mjs
 *
 * Tier: fast
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The three rules, as functions over a listing and a text ──

/**
 * What npm puts in the tarball whatever `files` says.
 *
 * The manifest is the package; the licence and the readme are what a registry page is built
 * from. None of them can be excluded, so none of them is evidence about the allowlist.
 */
const ALWAYS_PACKED = /^(?:package\.json|README(?:\.\w+)?|LICEN[SC]E(?:\.\w+)?|CHANGELOG(?:\.\w+)?|NOTICE(?:\.\w+)?)$/i;

/**
 * One `files` entry as a matcher over packed paths.
 *
 * The two placeholders are there because `*` and `**` mean different things and the second
 * contains the first: substituting them out before `*` is rewritten is what keeps `src/**` from
 * being read as two single-segment wildcards.
 */
function globToRegExp(pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*\*\//g, '@@DIRS@@')
    .replace(/\*\*/g, '@@ANY@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DIRS@@/g, '(?:[^/]+/)*')
    .replace(/@@ANY@@/g, '.*');
  return new RegExp(`^${source}$`);
}

/** A `files` entry naming a directory covers everything under it, the way `.gitignore` does. */
const asPatterns = (files) => files.flatMap((entry) => {
  const trimmed = String(entry).replace(/^\.\//, '').replace(/\/$/, '');
  return /[*?]/.test(trimmed) ? [trimmed] : [trimmed, `${trimmed}/**`];
});

/** Every packed path the allowlist does not account for. */
function outsideAllowlist(paths, files) {
  const matchers = asPatterns(files).map(globToRegExp);
  return paths.filter((path) => !ALWAYS_PACKED.test(path)
                             && !matchers.some((matcher) => matcher.test(path)));
}

/**
 * The names this repository's documentation uses when it needs a home directory in an example.
 *
 * `linuxbrew` is not a user at all — `/home/linuxbrew/.linuxbrew/bin` is where Homebrew
 * installs on Linux, and `docs/trap-gh-path.md` lists it because that is where `gh` is found.
 */
const PLACEHOLDER_USERS = new Set(['you', 'your-name', 'user', 'username', 'me', 'x', 'someone',
                                   'alice', 'bob', 'linuxbrew', 'runner']);

/** A Windows or POSIX home directory, with whoever it belongs to captured. */
const HOME_PATH = /(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/)([A-Za-z0-9._-]+)/g;

/** Every home directory in `text` that belongs to somebody rather than to an example. */
function homePathIssues(text) {
  const out = new Map();
  for (const [match, user] of text.matchAll(HOME_PATH)) {
    if (PLACEHOLDER_USERS.has(user.toLowerCase())) continue;
    if (!out.has(user)) out.set(user, match);
  }
  return [...out.values()];
}

// ─── 0. The rules catch each defect, and clear a clean pack ───

console.log('0. the rules catch each defect, and clear a listing that has none');

const FILES_FIXTURE = ['src/**/*', 'dist/**/*', 'skills/**/*', 'docs/*.md', '*.d.ts',
                       'README.md', 'LICENSE'];

const CLEAN_LISTING = ['package.json', 'README.md', 'LICENSE', 'index.d.ts',
                       'src/index.ts', 'src/core/spawn.ts', 'dist/frontend/assets/index.js',
                       'skills/excalidraw-skill/SKILL.md', 'docs/running.md'];
const DIRTY_LISTING = [...CLEAN_LISTING, '.env', 'scripts/export-board.mjs',
                       'docs/board.excalidraw', 'board.config.json'];

check('a clean listing is entirely accounted for by the allowlist',
      outsideAllowlist(CLEAN_LISTING, FILES_FIXTURE).length === 0,
      outsideAllowlist(CLEAN_LISTING, FILES_FIXTURE).join(', '));
check('a secret, a script, a board and a stray manifest are all caught',
      outsideAllowlist(DIRTY_LISTING, FILES_FIXTURE).length === 4,
      outsideAllowlist(DIRTY_LISTING, FILES_FIXTURE).join(', ') || 'nothing caught');
check('`docs/*.md` covers one level and not the tree under it',
      outsideAllowlist(['docs/a.md', 'docs/nested/b.md'], ['docs/*.md']).length === 1);
check('a bare directory entry covers everything under it',
      outsideAllowlist(['skills/a/b/c.md'], ['skills']).length === 0);

check('a real home directory is caught, on either separator',
      homePathIssues('"path": "C:/Users/vtr_d/Documents"\nEXCALIDRAW_X=C:\\Users\\vtr_d\\.claude\n')
        .length === 1);
check('a POSIX home directory is caught too', homePathIssues('/home/vtr_d/proj').length === 1);
check('the placeholders the documentation already uses are not',
      homePathIssues('C:\\Users\\you\\.claude · C:/Users/x/.local/bin · /home/me/Board '
                     + '· /home/linuxbrew/.linuxbrew/bin').length === 0,
      homePathIssues('C:\\Users\\you\\.claude · /home/me/Board').join(', '));

// ─── The real pack ────────────────────────────────────────────

console.log('\n1. every packed path is one the files allowlist accounts for');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

// One command line rather than a program and an argument list: `npm` on Windows is a `.cmd`,
// which since Node 20 `execFile` will not run without a shell, and passing an argument array
// through a shell is deprecated. Every word of it is a literal.
let packed;
try {
  const stdout = execSync('npm pack --dry-run --json --ignore-scripts',
                          { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  packed = JSON.parse(stdout)[0];
} catch (error) {
  console.error(`  FAIL  npm pack --dry-run --json did not report a listing — ${error.message}`);
  process.exit(1);
}

const paths = (packed.files ?? []).map((file) => file.path);
check(`npm pack reported a listing (${paths.length} entries, ${packed.filename})`,
      paths.length > 0);
check('the build is in the tarball, so this is the tarball that would ship',
      paths.some((path) => path.startsWith('dist/')),
      'no dist/ in the listing — run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`');

const strays = outsideAllowlist(paths, pkg.files ?? []);
check('no packed path falls outside the files allowlist', strays.length === 0,
      strays.join('\n        '));

console.log('\n2. no packed file names a real home directory');

const homeOffenders = [];
for (const path of paths) {
  const full = join(repoRoot, path);
  if (!existsSync(full)) continue;
  const issues = homePathIssues(readFileSync(full, 'utf8'));
  if (issues.length) homeOffenders.push(`${path}: ${issues.join(', ')}`);
}
check(`no operator home path in any of the ${paths.length} packed files`,
      homeOffenders.length === 0, homeOffenders.join('\n        '));

console.log('\n3. the manifest is this project\'s');

check(`the tarball is named for package.json ("${packed.name}@${packed.version}")`,
      packed.name === pkg.name && packed.version === pkg.version,
      `package.json says ${pkg.name}@${pkg.version}`);
check('package.json carries no upstream identifier',
      !/(?<![A-Za-z0-9_-])yctimlin(?![A-Za-z0-9_-])/i
        .test(readFileSync(join(repoRoot, 'package.json'), 'utf8')));

console.log('');
if (failures) { console.error(`${failures} case(s) failed`); process.exit(1); }
console.log('All checks passed');
