#!/usr/bin/env node
/**
 * Checks that no machine-readable artifact in this repository declares somebody else as its
 * owner.
 *
 * The only guard this fork had on its own identity read one file. `check-readme.mjs` loads
 * `README.md` and the package manifest, and its upstream rule scans README prose. That is why,
 * 130 commits past the fork base recorded at `check-board-map.mjs`, five tracked artifacts
 * still named the upstream author as the owner and nothing went red: `package.json` (author
 * `yctimlin`, with `repository`, `homepage` and `bugs` all pointing at the upstream
 * repository), `LICENSE` (a copyright line naming a product rather than anybody), `Dockerfile`
 * and `Dockerfile.canvas` (`org.opencontainers.image.source` at the upstream repository), and
 * `claude_desktop_config.json` (`npx -y excalidraw-mcp`, a third package name that neither this
 * fork nor upstream owns). Every other item in this dimension is a one-off correction to one of
 * those files; without a guard the next one drifts back the same way.
 *
 * This sits **beside** `check-readme.mjs` rather than replacing it, and the split is the point:
 * `check-readme.mjs` is about what a reader is told, and permits an upstream mention that says
 * that is what it is. This is about what a machine-readable artifact *declares* — an npm
 * registry entry, an image label, an MCP client's launch command. A machine cannot read a
 * caption, so in those files there is no attributed mention and no exception.
 *
 * `README.md` is deliberately outside the scan for that reason. `LICENSE` and `NOTICE.md` are
 * inside it but held to the reader's rule, not the machine's: an attribution document exists in
 * order to name the upstream project, so a mention there passes when its own line says the word
 * `upstream`, `original`, `fork` or `copyright`. An unmarked one still fails, and the third
 * package name is never permitted anywhere.
 *
 * Four rules:
 *
 *  1. **no scanned artifact names `yctimlin` or `excalidraw-mcp`.** The list is fixed —
 *     `package.json`, `LICENSE`, `NOTICE.md`, `Dockerfile`, `Dockerfile.canvas`,
 *     `docker-compose.yml`, and every tracked `*.json` at the repository root. A file on the
 *     list that does not exist is not a failure: `NOTICE.md` has not been written yet, and the
 *     Docker files are scheduled for deletion.
 *  2. **`package.json` agrees with what this tree records itself as.** `repository.url`,
 *     `homepage` and `bugs.url` point at `github.com/<repo>`, and `name` is either the
 *     repository's own name or scoped to the account that holds it. The expectation is read
 *     rather than written down here, so a rename lands in one place — and since #315 that place
 *     is `FORK_REPO` in `scripts/lib/repo-identity.mjs`, not `board.config.json`, which no
 *     longer names a repository at all: a board configuration is read by the running server and
 *     copied by everyone who clones the tree, so an account named in it is an account every
 *     clone gets pointed at. It stays *outside* the manifest either way. The state this rule
 *     was written for is a tree carrying upstream's manifest verbatim, in which `name` and
 *     `repository.url` agree with each other perfectly and are both upstream's, so a manifest
 *     compared against itself would pass by definition.
 *  3. **`LICENSE` names a copyright holder**, an account this repository can be traced to,
 *     rather than a product string. `Copyright (c) 2024 MCP Excalidraw Server` names nobody,
 *     and MIT requires that notice be carried into every copy.
 *  4. **no workflow spells a package identity out.** `npm-publish.yml` decided whether to
 *     publish by asking the registry about `mcp-excalidraw-server` — a package this fork does
 *     not own — so the probe always succeeded, both publish steps were skipped, and the run
 *     printed *"Please bump the version in package.json"*, advice that could never help. A
 *     literal is what made that possible: it agreed with `package.json` on the day it was
 *     written and nothing tied the two together afterwards. So a package name in a workflow
 *     has to come from `package.json`, and in the workflow that actually publishes a
 *     currently-correct literal fails too — being right today is not the property being
 *     asked for.
 *
 * A match is a whole token: `yctimlin` and `excalidraw-mcp` are an account and a package name,
 * so `mcp-excalidraw-mcp` — a container name in `docker-compose.yml` — is a different word and
 * not a hit. Reporting it as the third package would be false.
 *
 * **This check is red on the tree it lands on, on purpose.** It is the guard written before the
 * renames it guards, so section 0 is what says its rules work: it drives all four over an
 * in-memory tree carrying each defect, and over one carrying none, so a future green run is
 * known to mean the tree was fixed rather than the scanner having stopped looking.
 *
 * Offline and self-contained: tracked files and `git ls-files`. No server, no browser, no
 * network.
 *
 * Usage: node scripts/check-fork-identity.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoIdentity } from './lib/repo-identity.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The account the fork was cut from, and a package name neither side owns. */
const UPSTREAM_OWNER = 'yctimlin';
const FOREIGN_PACKAGE = 'excalidraw-mcp';
const TERMS = [UPSTREAM_OWNER, FOREIGN_PACKAGE];

/** The artifacts that are always scanned, whether or not they exist yet. */
const FIXED_LIST = ['package.json', 'LICENSE', 'NOTICE.md', 'Dockerfile', 'Dockerfile.canvas',
                    'docker-compose.yml'];

/**
 * `check-readme.mjs` owns prose attribution and permits a marked upstream mention. Two files
 * here are prose too, and are the two whose job is to name the upstream project.
 */
const EXCLUDED = ['README.md'];
const ATTRIBUTION_DOCS = new Set(['LICENSE', 'NOTICE.md']);
const ATTRIBUTED = /\b(upstream|original|fork|copyright)/i;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The four rules, as functions over text ───────────────────

/** What counts as part of a name, and therefore as *not* a boundary around one. */
const NAME_CHAR = 'A-Za-z0-9_-';
const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matcher = (term) => new RegExp(`(?<![${NAME_CHAR}])${escape(term)}(?![${NAME_CHAR}])`, 'i');

/**
 * Every line of `text` that names one of the terms and is not allowed to.
 *
 * `path` decides the rule: an attribution document may name the upstream account on a line
 * that says so, and nothing may name the third package.
 */
function findings(path, text) {
  const attributable = ATTRIBUTION_DOCS.has(path);
  const out = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const term of TERMS) {
      if (!matcher(term).test(line)) continue;
      if (attributable && term === UPSTREAM_OWNER && ATTRIBUTED.test(line)) continue;
      out.push({ file: path, line: index + 1, term, text: line.trim() });
    }
  });
  return out;
}

/** Case, separators and diacritics all removed: what is left is the identity. */
const fold = (value) => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Where `package.json` disagrees with the repository it declares itself to be in.
 *
 * The name rule is deliberately two-sided. A bare package name has to *be* the repository's
 * name, and a scoped one only has to sit under the account that holds the repository — which
 * is what a fork does when the bare name is taken, and is the identity decided for this one.
 */
function packageIssues(pkg, repo) {
  const [owner, name] = repo.split('/');
  const issues = [];

  const declared = String(pkg.name ?? '');
  const scoped = declared.toLowerCase().startsWith(`@${owner.toLowerCase()}/`);
  if (!scoped && fold(declared) !== fold(name)) {
    issues.push(`name is "${declared}" — expected "${name}", or a scope this account owns `
                + `("@${owner}/…")`);
  }

  const expected = `github.com/${repo}`;
  const fields = [['repository.url', pkg.repository?.url], ['homepage', pkg.homepage],
                  ['bugs.url', pkg.bugs?.url]];
  for (const [field, value] of fields) {
    if (String(value ?? '').toLowerCase().includes(expected.toLowerCase())) continue;
    issues.push(`${field} is ${value === undefined ? 'missing' : `"${value}"`} `
                + `— expected it to name ${expected}`);
  }
  return issues;
}

/**
 * Where the licence's copyright notice names nobody.
 *
 * A URL is stripped before the line is read: `github.com/<owner>/…` in a "see also" would
 * otherwise answer the question the copyright line is being asked.
 */
function licenceIssues(text, owner) {
  const lines = text.split(/\r?\n/)
    .filter((line) => /copyright/i.test(line) && /\(c\)|©/i.test(line))
    .map((line) => line.trim());
  if (lines.length === 0) return ['LICENSE carries no copyright line at all'];

  const withoutUrls = (line) => line.replace(/\bhttps?:\/\/\S+/gi, ' ');
  if (lines.some((line) => fold(withoutUrls(line)).includes(fold(owner)))) return [];
  return [`no copyright line in LICENSE names "${owner}" — a product string names nobody, and `
          + `MIT carries this notice into every copy: ${lines.join(' | ')}`];
}

/**
 * The three places a workflow names a package: the first non-flag argument of an `npm`
 * sub-command that takes one, an npmjs.com URL, and the filename of a release artifact.
 *
 * `npm ci` and `npm run build` are deliberately not on the verb list — neither takes a
 * package name, and both are on every workflow in the repository.
 */
const NPM_VERB = /\bnpm\s+(?:view|info|show|publish|install|add|i)\s+(\S+)/g;
const NPM_URL = /npmjs\.com\/package\/([^\s"'`)]+)/g;
const ARTIFACT = /(\S+)\.(?:tgz|tar\.gz)\b/g;

/**
 * A GitHub expression, a shell substitution, or a shell variable — anything whose value comes
 * from somewhere else at run time.
 *
 * Each is replaced by one sentinel character before the line is read, so that what is left is
 * exactly the part somebody typed. `mcp-excalidraw-server-${{ … }}.tar.gz` has to keep saying
 * `mcp-excalidraw-server` after the substitution, or the hardcoded half of a half-derived
 * name goes unseen — which is the shape line 85 actually had.
 */
const EXPRESSION = /\$\{\{[^}]*\}\}|\$\((?:[^()]|\([^()]*\))*\)|\$\{[^}]*\}/g;
const SUPPLIED = '%';
const literalOnly = (line) => line.replace(EXPRESSION, SUPPLIED);

/** npm's own rule for what a package name may contain, scope and all. */
const NAME_SHAPE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

/**
 * The package name inside a raw token, or `''` when there is no literal one left.
 *
 * `kind` says which suffix to drop: a registry query carries `@<version>`, an artifact
 * filename carries `-<version>`. What a substitution supplied is dropped with it, so a fully
 * derived token normalises to nothing and is not compared against anything.
 */
function packageToken(raw, kind) {
  let token = raw.replace(/^[\s'"`]+|[\s'"`,;:]+$/g, '');
  if (kind === 'artifact') {
    token = token.replace(/\.(?:tgz|tar\.gz)$/i, '').replace(/-v?[\d][\w.+-]*$/i, '');
  } else {
    const at = token.lastIndexOf('@');
    if (at > 0 && !token.slice(at).includes('/')) token = token.slice(0, at);
  }
  token = token.split(SUPPLIED).join('').replace(/^[-_.]+|[-_.]+$/g, '');
  return NAME_SHAPE.test(token) ? token : '';
}

/** Every package-identity position on a line, paired with the rule that reads it. */
function positions(line) {
  const bare = literalOnly(line);
  const out = [];
  for (const [, raw] of bare.matchAll(NPM_VERB)) if (!raw.startsWith('-')) out.push([raw, 'npm']);
  for (const [, raw] of bare.matchAll(NPM_URL)) out.push([raw, 'npm']);
  for (const [, raw] of bare.matchAll(ARTIFACT)) out.push([raw, 'artifact']);
  return out;
}

/**
 * Where a workflow names a package rather than reading one.
 *
 * `publishes` is the stricter half: the workflow that runs `npm publish` is the one whose
 * identity has to survive a rename, so a literal there fails even when it is right.
 */
function workflowIssues(path, text, packageName, publishes) {
  const issues = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [raw, kind] of positions(line)) {
      const token = packageToken(raw, kind);
      if (!token) continue;
      const where = `${path}:${index + 1}`;
      if (fold(token) !== fold(packageName)) {
        issues.push(`${where} names "${token}" — package.json is "${packageName}"`);
      } else if (publishes) {
        issues.push(`${where} spells "${token}" out — the workflow that publishes has to read `
                    + `the name from package.json, so a rename cannot leave it behind`);
      }
    }
  });
  return issues;
}

// ─── 0. The rules catch each defect, and clear a fixed tree ───

console.log('0. the rules catch each defect, and clear a tree that has none');

const REPO_FIXTURE = 'someone/their_tool';

const DIRTY = {
  'package.json': JSON.stringify({
    name: 'mcp-excalidraw-server',
    author: { name: 'yctimlin', email: 'c22647809@gmail.com' },
    repository: { type: 'git', url: 'https://github.com/yctimlin/mcp_excalidraw.git' },
    homepage: 'https://github.com/yctimlin/mcp_excalidraw#readme',
    bugs: { url: 'https://github.com/yctimlin/mcp_excalidraw/issues' },
  }, null, 2),
  LICENSE: 'MIT License\n\nCopyright (c) 2024 MCP Excalidraw Server\n',
  'NOTICE.md': '# Notice\n\nBuilt on work by yctimlin.\n',
  Dockerfile: 'LABEL org.opencontainers.image.source="https://github.com/yctimlin/mcp_excalidraw"\n',
  'docker-compose.yml': 'services:\n  mcp:\n    container_name: mcp-excalidraw-mcp\n',
  'claude_desktop_config.json': '{ "args": ["-y", "excalidraw-mcp"] }\n',
};

const CLEAN = {
  'package.json': JSON.stringify({
    name: '@someone/their-tool',
    author: { name: 'Someone Themselves' },
    repository: { type: 'git', url: 'https://github.com/someone/their_tool.git' },
    homepage: 'https://github.com/someone/their_tool#readme',
    bugs: { url: 'https://github.com/someone/their_tool/issues' },
  }, null, 2),
  LICENSE: 'MIT License\n\nCopyright (c) 2025 yctimlin, for the original work\n'
    + 'Copyright (c) 2026 Someone Themselves\n',
  'NOTICE.md': '# Notice\n\nThis project is a fork of yctimlin/mcp_excalidraw at 505f4c6.\n',
  'docker-compose.yml': 'services:\n  mcp:\n    container_name: mcp-excalidraw-mcp\n',
  'claude_desktop_config.json': '{ "args": ["-y", "@someone/their-tool"] }\n',
};

const scanAll = (tree) => Object.entries(tree).flatMap(([path, text]) => findings(path, text));

const dirtyFiles = new Set(scanAll(DIRTY).map(({ file }) => file));
check('an upstream account is caught in a manifest, a label and a launch command',
      ['package.json', 'Dockerfile', 'claude_desktop_config.json']
        .every((file) => dirtyFiles.has(file)),
      `caught: ${[...dirtyFiles].join(', ')}`);
check('an unattributed mention in an attribution document is caught too',
      dirtyFiles.has('NOTICE.md'));
check('a container name that merely contains the package name is not a hit',
      !dirtyFiles.has('docker-compose.yml'),
      'mcp-excalidraw-mcp is a different word from excalidraw-mcp');
check('a fixed tree is clean, attribution and all', scanAll(CLEAN).length === 0,
      scanAll(CLEAN).map(({ file, line, text }) => `${file}:${line} ${text}`).join('; '));

const dirtyPackage = packageIssues(JSON.parse(DIRTY['package.json']), REPO_FIXTURE);
check('all four package.json fields are caught when they name another repository',
      dirtyPackage.length === 4, dirtyPackage.join(' / ') || 'nothing caught');
check('a package scoped to the account that holds the repository is accepted',
      packageIssues(JSON.parse(CLEAN['package.json']), REPO_FIXTURE).length === 0,
      packageIssues(JSON.parse(CLEAN['package.json']), REPO_FIXTURE).join(' / '));
check('a bare package name matching the repository is accepted, separators and all',
      packageIssues({ ...JSON.parse(CLEAN['package.json']), name: 'their-tool' },
                    REPO_FIXTURE).length === 0);
check('a bare package name that is somebody else\'s is not',
      packageIssues({ ...JSON.parse(CLEAN['package.json']), name: 'their-tool-server' },
                    REPO_FIXTURE).length === 1);

check('a copyright line naming a product is caught',
      licenceIssues(DIRTY.LICENSE, 'someone').length === 1);
check('a copyright line naming the account is accepted, spelled as a person',
      licenceIssues(CLEAN.LICENSE, 'someone').length === 0,
      licenceIssues(CLEAN.LICENSE, 'someone').join(' / '));
check('a licence with no copyright line at all is caught',
      licenceIssues('MIT License\n', 'someone').length === 1);

/**
 * The publish workflow as it stood, and as it has to stand: the same four positions, spelled
 * out on one side and read from `package.json` on the other. The last two lines of each are
 * the sub-commands that take no package name and are on every workflow in the repository.
 */
const WORKFLOW_DIRTY = [
  '          if npm view their-tool-server@${{ steps.package-version.outputs.version }} version; then',
  '          tar -czf their-tool-server-${{ steps.package-version.outputs.version }}.tar.gz dist/',
  '            their-tool-server-${{ steps.package-version.outputs.version }}.tar.gz',
  '          echo "View at: https://www.npmjs.com/package/their-tool-server"',
  '        run: npm publish --provenance --access public',
  '        run: npm ci',
  '        run: npm run build',
].join('\n');

const WORKFLOW_CLEAN = [
  '          if npm view "${{ steps.package.outputs.name }}@${{ steps.package.outputs.version }}" version; then',
  '          tar -czf ${{ steps.package.outputs.slug }}-${{ steps.package.outputs.version }}.tar.gz dist/',
  '            ${{ steps.package.outputs.slug }}-${{ steps.package.outputs.version }}.tar.gz',
  '          echo "View at: https://www.npmjs.com/package/${{ needs.publish.outputs.name }}"',
  '        run: npm publish --provenance --access public',
  '        run: npm ci',
  '        run: npm run build',
].join('\n');

const FIXTURE_NAME = '@someone/their-tool';
const dirtyWorkflow = workflowIssues('publish.yml', WORKFLOW_DIRTY, FIXTURE_NAME, true);
check('all four positions are caught when a workflow spells another package out',
      dirtyWorkflow.length === 4, dirtyWorkflow.join(' / ') || 'nothing caught');
check('a hardcoded name is still caught when only the version is derived',
      dirtyWorkflow.some((issue) => issue.startsWith('publish.yml:2')),
      'the tarball line supplies its version from an expression and its name from nobody');
check('a workflow that reads every position from package.json is accepted',
      workflowIssues('publish.yml', WORKFLOW_CLEAN, FIXTURE_NAME, true).length === 0,
      workflowIssues('publish.yml', WORKFLOW_CLEAN, FIXTURE_NAME, true).join(' / '));
check('npm ci and npm run build are not package references',
      workflowIssues('ci.yml', '        run: npm ci\n        run: npm run build\n',
                     FIXTURE_NAME, false).length === 0);
check('the scoped name and the tarball slug it packs to are the same identity',
      workflowIssues('publish.yml',
                     '          tar -czf someone-their-tool-1.2.3.tar.gz dist/',
                     FIXTURE_NAME, false).length === 0,
      'npm packs @someone/their-tool as someone-their-tool-<version>.tgz');
check('a correct literal still fails in the workflow that publishes',
      workflowIssues('publish.yml', `          run: npm view ${FIXTURE_NAME}@1.2.3 version`,
                     FIXTURE_NAME, true).length === 1,
      'being right today is not the property being asked for');
check('the same literal passes in a workflow that does not publish',
      workflowIssues('ci.yml', `          run: npm view ${FIXTURE_NAME}@1.2.3 version`,
                     FIXTURE_NAME, false).length === 0);

// ─── The real tree ────────────────────────────────────────────

// `package.json`'s `repository` since #315, where `board.config.json` stopped naming one: a
// board configuration is copied by everyone who clones the tree, so an account named in it is
// an account every clone is pointed at. The manifest is the file whose job that is.
const { repo, owner: repoOwner } = repoIdentity();

/**
 * Tracked files at the repository root. An untracked `*.json` is somebody's local scratch and
 * is not what this repository declares; without git the fallback reads the directory and says
 * so, because a scan that quietly narrows is the failure this whole check exists to prevent.
 */
function rootJsonFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\0').filter((path) => path && !path.includes('/') && path.endsWith('.json'));
  } catch {
    console.log('  note  git ls-files is unavailable; reading the root directory instead');
    return readdirSync(repoRoot).filter((name) => name.endsWith('.json'));
  }
}

/**
 * Every tracked workflow, not the one this issue was about. A second workflow that learned to
 * publish, or to print an npm URL, is exactly the drift rule 4 exists to stop.
 */
function trackedWorkflows() {
  const dir = '.github/workflows';
  try {
    return execFileSync('git', ['ls-files', '-z', dir], { cwd: repoRoot, encoding: 'utf8' })
      .split('\0').filter((path) => /\.ya?ml$/i.test(path));
  } catch {
    console.log('  note  git ls-files is unavailable; reading .github/workflows instead');
    if (!existsSync(join(repoRoot, dir))) return [];
    return readdirSync(join(repoRoot, dir)).filter((name) => /\.ya?ml$/i.test(name))
      .map((name) => `${dir}/${name}`);
  }
}

const scanned = [...new Set([...FIXED_LIST, ...rootJsonFiles()])]
  .filter((path) => !EXCLUDED.includes(path))
  .sort();

console.log(`\n1. no machine-readable artifact declares somebody else's identity`);

check(`the tree records which repository this is ("${repo}")`, /^[^/]+\/[^/]+$/.test(repo),
      `FORK_REPO is ${JSON.stringify(repo || null)}`);
check(`README.md is left to check-readme.mjs`, !scanned.includes('README.md'));

const offenders = [];
let present = 0;

for (const path of scanned) {
  const full = join(repoRoot, path);
  if (!existsSync(full)) continue;
  present++;
  const hits = findings(path, readFileSync(full, 'utf8'));
  if (hits.length) offenders.push(path);
  check(`${path} names nobody but this project`, hits.length === 0,
        hits.map(({ line, term, text }) => `${line}: ${term} in "${text.slice(0, 72)}"`)
          .join('\n        '));
}

check(`there were artifacts to scan (${present} of ${scanned.length} exist)`, present > 0);

console.log('\n2. package.json agrees with the repository it declares');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const pkgIssues = packageIssues(pkg, repo);
if (pkgIssues.length && !offenders.includes('package.json')) offenders.push('package.json');
check('package.json name, repository.url, homepage and bugs.url all describe this repository',
      pkgIssues.length === 0, pkgIssues.join('\n        '));

console.log('\n3. LICENSE names a copyright holder rather than a product');

const licence = licenceIssues(readFileSync(join(repoRoot, 'LICENSE'), 'utf8'), repoOwner);
if (licence.length && !offenders.includes('LICENSE')) offenders.push('LICENSE');
check('LICENSE carries a copyright line naming a person or entity', licence.length === 0,
      licence.join('\n        '));

console.log('\n4. no workflow spells a package identity out');

const workflows = trackedWorkflows();
check(`there were workflows to scan (${workflows.length})`, workflows.length > 0);

for (const path of workflows) {
  const text = readFileSync(join(repoRoot, path), 'utf8');
  const publishes = /\bnpm\s+publish\b/.test(text);
  const issues = workflowIssues(path, text, String(pkg.name ?? ''), publishes);
  if (issues.length) offenders.push(path);
  check(`${path} reads the package name from package.json`, issues.length === 0,
        issues.join('\n        '));
}

console.log('');
if (failures) {
  console.error(`Artifacts still declaring somebody else: ${offenders.sort().join(', ') || 'none'}`);
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
