#!/usr/bin/env node

/**
 * Every dependency this package declares resolves to a version somebody has run.
 *
 * `package.json` declared `"@modelcontextprotocol/sdk": "latest"`. The lockfile pinned it —
 * 1.15.1 — and that is what `npm ci` installs here and in CI, so nothing in this repository
 * ever noticed. A lockfile does not travel to consumers: `npx -y <pkg>` and `npm i -g <pkg>`
 * resolve the manifest's ranges fresh against the registry, so every user installed whatever
 * the SDK's `latest` was on the day they installed, up to and including a new major. What is
 * imported are three deep paths that have moved before — `/server/index.js`, `/server/stdio.js`
 * and `/types.js` (`src/index.ts:7-14`). A product that can break for a new user with no change
 * to this repository, on the exact command the README offers as the one-command install, and no
 * way to reproduce the report afterwards.
 *
 * A dist-tag is the specifier that cannot be reproduced: `latest`, `next`, `beta` and `*` all
 * mean "whatever the registry says now", and *now* is different for the maintainer, for CI and
 * for the user. A range is a claim about what was tested; a dist-tag is the absence of one.
 *
 * Four rules:
 *
 *  1. **No dependency spec is a dist-tag, a wildcard or empty**, across `dependencies`,
 *     `devDependencies`, `optionalDependencies` and `peerDependencies`. A semver range is fine
 *     however loose, and so is a non-registry protocol (`file:`, `git+`, `npm:`, `workspace:`)
 *     because those name a source rather than asking the registry to choose.
 *  2. **The lockfile's root block declares the same specs as `package.json`.** That is the
 *     agreement `npm ci` refuses to install without, so a manifest edited without a
 *     re-resolution is caught here rather than on a contributor's first clone.
 *  3. **The version the lockfile resolved satisfies the range the manifest declares** — for
 *     every registry dependency, not only the one that was wrong. This is the done-when's
 *     "a clean install resolves the SDK inside the declared range", asked offline: `npm ci`
 *     installs exactly what the lockfile holds, so a lockfile inside the range is that install.
 *  4. **`engines.node` states one supported floor, and it is the oldest Node `ci.yml` runs.**
 *     `check-ci-workflow.mjs` holds the same equality from the workflow's side; this one asks it
 *     of the manifest, which is where an editor of `engines` is looking. The rule is cheap and
 *     the two disagreeing about a version is precisely the class of unstated assumption a
 *     dist-tag is, so it is stated in both places on purpose.
 *
 * **The standing policy this replaces `latest` with.** `latest` buys freshness at the price of
 * reproducibility. A caret keeps most of the freshness — a patch or a minor still arrives
 * without a commit here — and gives up only the major, which is the one bump nobody should take
 * unreviewed on three deep import paths. So: a caret on the version the check suite has been run
 * against, bumped deliberately when the suite has been run against a newer one, and the resolved
 * version recorded in `docs/development-log.md` so a bug report can be reproduced against a
 * known tree. Nothing here schedules that bump; a scheduled job that bumps a major on a red
 * suite is the same failure with a calendar attached.
 *
 * **Run against the tree before the change it guards**, where rule 1 is red on
 * `@modelcontextprotocol/sdk`. Section 0 drives every rule over fixtures carrying the defect and
 * over fixtures carrying none, so a green run later means the manifest was fixed rather than the
 * scanner having stopped looking.
 *
 * Offline and self-contained: it reads `package.json`, `package-lock.json` and
 * `.github/workflows/*.yml`. No server, no browser, no network, no build.
 *
 * Usage: node scripts/check-dependency-ranges.mjs
 *
 * Tier: fast
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from './lib/parse-yaml.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The four blocks npm resolves against the registry when it installs this package. */
const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// ─── The rules, as functions over a manifest ──────────────────

/**
 * What a specifier is, in the only three categories that matter here.
 *
 * `range` is a semver range, however wide — a caret, a tilde, an exact pin, a comparator, an
 * `x` in a position, a `||` of any of those. `protocol` names a source instead of asking the
 * registry to pick a version, and is out of scope for the same reason a range is in it: nothing
 * about it changes between the maintainer's install and a user's. `tag` is everything else,
 * which is a dist-tag, a bare wildcard, or an empty string — all of them "whatever the registry
 * says at install time".
 */
function classifySpec(spec) {
  if (typeof spec !== 'string') return { kind: 'tag', why: 'not a string' };
  const trimmed = spec.trim();
  if (trimmed === '') return { kind: 'tag', why: 'empty, which npm reads as "*"' };
  if (/^(?:file|link|git|git\+[a-z]+|https?|npm|workspace|portal|github|bitbucket|gitlab):/i.test(trimmed)
      || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(trimmed)) {
    return { kind: 'protocol', why: 'names a source rather than a registry version' };
  }
  if (/^[*x]$/i.test(trimmed)) return { kind: 'tag', why: 'a wildcard — any version, including a new major' };
  // A range has to start with a digit, a `v`, or one of semver's operators. A dist-tag is a
  // bare npm tag name, and cannot: `latest`, `next`, `beta`, `canary`.
  if (!/^[v\d^~><=]/.test(trimmed)) return { kind: 'tag', why: `"${trimmed}" is a dist-tag` };
  return { kind: 'range' };
}

/** Every `<block>.<name>` in `pkg` whose spec is a dist-tag or a wildcard, with the reason. */
function tagSpecs(pkg) {
  const out = [];
  for (const block of DEPENDENCY_BLOCKS) {
    for (const [name, spec] of Object.entries(pkg?.[block] ?? {})) {
      const { kind, why } = classifySpec(spec);
      if (kind === 'tag') out.push(`${block}.${name} is ${JSON.stringify(spec)} — ${why}`);
    }
  }
  return out;
}

/** `'1.15.1'` → `[1, 15, 1]`, prerelease and build metadata dropped. `null` if unreadable. */
function parseVersion(version) {
  const found = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
}

const compare = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/**
 * Does `version` fall inside `range`?
 *
 * Deliberately small: it reads a caret, a tilde, an exact pin and a single comparator, which is
 * every shape this manifest uses. Anything else answers `null` — "this rule cannot read that" —
 * and the caller fails on it rather than passing, because a range nobody checked is the thing
 * being guarded against.
 */
function satisfies(version, range) {
  const found = parseVersion(version);
  if (!found) return null;
  const spec = String(range).trim();
  const bound = parseVersion(spec.replace(/^[^v\d]*/, ''));
  if (!bound) return null;

  if (/^\^/.test(spec)) {
    const [major, minor] = bound;
    const ceiling = major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, bound[2] + 1];
    return compare(found, bound) >= 0 && compare(found, ceiling) < 0;
  }
  if (/^~/.test(spec)) {
    return compare(found, bound) >= 0 && compare(found, [bound[0], bound[1] + 1, 0]) < 0;
  }
  if (/^>=/.test(spec)) return compare(found, bound) >= 0;
  if (/^>/.test(spec)) return compare(found, bound) > 0;
  if (/^<=/.test(spec)) return compare(found, bound) <= 0;
  if (/^</.test(spec)) return compare(found, bound) < 0;
  if (/^v?\d/.test(spec) || /^=/.test(spec)) return compare(found, bound) === 0;
  return null;
}

/**
 * Every registry dependency whose locked version does not sit inside its declared range, and
 * every one this rule could not read at all.
 */
function resolutionIssues(pkg, lock) {
  const out = [];
  const packages = lock?.packages ?? {};
  for (const block of DEPENDENCY_BLOCKS) {
    for (const [name, spec] of Object.entries(pkg?.[block] ?? {})) {
      if (classifySpec(spec).kind !== 'range') continue;
      const entry = packages[`node_modules/${name}`];
      if (!entry) {
        // An optional dependency the lockfile skipped on this platform is not a resolution
        // failure; anything else missing is.
        if (block !== 'optionalDependencies') out.push(`${name} is declared and the lockfile has no entry for it`);
        continue;
      }
      const verdict = satisfies(entry.version, spec);
      if (verdict === null) out.push(`${name}: cannot read ${JSON.stringify(spec)} against ${entry.version}`);
      else if (!verdict) out.push(`${name} locks ${entry.version}, outside the declared ${spec}`);
    }
  }
  return out;
}

/** Where the lockfile's root block and the manifest disagree about what was asked for. */
function lockDriftIssues(pkg, lock) {
  const root = lock?.packages?.[''] ?? {};
  const out = [];
  for (const block of DEPENDENCY_BLOCKS) {
    const declared = pkg?.[block] ?? {};
    const locked = root[block] ?? {};
    for (const [name, spec] of Object.entries(declared)) {
      if (locked[name] === undefined) out.push(`${block}.${name} is in package.json and not in the lockfile's root block`);
      else if (locked[name] !== spec) out.push(`${block}.${name} is ${JSON.stringify(spec)} in package.json and ${JSON.stringify(locked[name])} in the lockfile`);
    }
    for (const name of Object.keys(locked)) {
      if (declared[name] === undefined) out.push(`${block}.${name} is in the lockfile's root block and not in package.json`);
    }
  }
  return out;
}

/** `'20.x'` → 20, `'>=20.0.0'` → 20. The major is the whole of what these rules compare. */
const majorOf = (version) => {
  const found = /(\d+)/.exec(String(version));
  return found ? Number(found[1]) : NaN;
};

/** Is `engines.node` one floor, rather than a range whose floor has to be inferred? */
const isSingleFloor = (value) => /^>=\s*\d+(\.\d+){0,2}$/.test(String(value).trim());

// ─── 0. The rules, over fixtures ──────────────────────────────

console.log('\n0. the rules catch what they are for, and pass what they are not');

const SPEC_CASES = [
  ['latest', 'tag', 'the specifier this check exists for'],
  ['next', 'tag', 'another dist-tag'],
  ['beta', 'tag', 'and another'],
  ['*', 'tag', 'the wildcard'],
  ['x', 'tag', 'its other spelling'],
  ['', 'tag', 'empty, which npm reads as any version'],
  ['^1.15.1', 'range', 'a caret'],
  ['~1.15.1', 'range', 'a tilde'],
  ['1.15.1', 'range', 'an exact pin'],
  ['>=20.0.0', 'range', 'a comparator'],
  ['1.x', 'range', 'an x in the minor position is a range, not a wildcard'],
  ['^1.2.0-beta.14', 'range', 'a caret on a prerelease'],
  ['1.2.0 || ^2.0.0', 'range', 'a union'],
  ['file:../local', 'protocol', 'a path, not a registry resolution'],
  ['git+https://github.com/o/r.git#v1', 'protocol', 'a git source'],
  ['npm:other-package@^1.0.0', 'protocol', 'an alias, whose version is inside it'],
  ['workspace:*', 'protocol', 'a workspace link resolves locally'],
];
for (const [spec, expected, why] of SPEC_CASES) {
  const { kind } = classifySpec(spec);
  check(`${JSON.stringify(spec)} is a ${expected} — ${why}`, kind === expected, `read as ${kind}`);
}

check('rule 1 finds a dist-tag in any of the four blocks',
      tagSpecs({
        dependencies: { a: 'latest' },
        devDependencies: { b: '^1.0.0' },
        optionalDependencies: { c: '*' },
        peerDependencies: { d: 'next' },
      }).length === 3,
      'expected a, c and d and not b');

check('rule 1 passes a manifest with a range everywhere',
      tagSpecs({ dependencies: { a: '^1.0.0' }, devDependencies: { b: 'file:../b' } }).length === 0);

const SATISFIES_CASES = [
  ['1.15.1', '^1.15.1', true, 'the pinned version itself'],
  ['1.30.0', '^1.15.1', true, 'a minor inside the caret'],
  ['2.0.0', '^1.15.1', false, 'the major a caret exists to refuse'],
  ['1.15.0', '^1.15.1', false, 'below the floor'],
  ['0.18.3', '^0.18.0', true, 'a caret on a 0.x minor'],
  ['0.19.0', '^0.18.0', false, 'and the minor it stops at'],
  ['1.15.9', '~1.15.1', true, 'a tilde takes the patch'],
  ['1.16.0', '~1.15.1', false, 'and not the minor'],
  ['1.15.1', '1.15.1', true, 'an exact pin'],
  ['1.15.2', '1.15.1', false, 'and what it excludes'],
  ['22.0.0', '>=20.0.0', true, 'a comparator'],
  ['1.2.0-beta.14', '^1.2.0-beta.14', true, 'a prerelease against its own caret'],
];
for (const [version, range, expected, why] of SATISFIES_CASES) {
  check(`${version} ${expected ? 'satisfies' : 'does not satisfy'} ${range} — ${why}`,
        satisfies(version, range) === expected, `answered ${satisfies(version, range)}`);
}

check('a range this rule cannot read is reported rather than passed',
      satisfies('1.0.0', 'unreadable') === null);

const FIXTURE_PKG = { dependencies: { sdk: '^1.15.1' } };
check('rule 3 catches a lockfile that resolved outside the declared range',
      resolutionIssues(FIXTURE_PKG, { packages: { 'node_modules/sdk': { version: '2.1.0' } } }).length === 1,
      'a major above the caret should be one issue');
check('rule 3 passes a lockfile inside the range',
      resolutionIssues(FIXTURE_PKG, { packages: { 'node_modules/sdk': { version: '1.30.0' } } }).length === 0);
check('rule 3 catches a declared dependency the lockfile never resolved',
      resolutionIssues(FIXTURE_PKG, { packages: {} }).length === 1);
check('rule 3 allows an optional dependency the lockfile skipped',
      resolutionIssues({ optionalDependencies: { pty: '^1.0.0' } }, { packages: {} }).length === 0);

check('rule 2 catches a manifest edited without re-resolving the lockfile',
      lockDriftIssues({ dependencies: { sdk: '^1.30.0' } },
                      { packages: { '': { dependencies: { sdk: 'latest' } } } }).length === 1,
      'npm ci refuses that pair, so it has to be caught here');
check('rule 2 catches a dependency missing from the lockfile root',
      lockDriftIssues({ dependencies: { sdk: '^1.30.0' } }, { packages: { '': {} } }).length === 1);
check('rule 2 catches a dependency the lockfile root has and the manifest does not',
      lockDriftIssues({}, { packages: { '': { dependencies: { ghost: '^1.0.0' } } } }).length === 1);
check('rule 2 passes a manifest and lockfile that agree',
      lockDriftIssues({ dependencies: { sdk: '^1.30.0' } },
                      { packages: { '': { dependencies: { sdk: '^1.30.0' } } } }).length === 0);

check('rule 4 reads one floor and refuses a two-sided range',
      isSingleFloor('>=20.0.0') && isSingleFloor('>=20') && !isSingleFloor('>=20.0.0 <23.0.0')
      && !isSingleFloor('^20.0.0') && !isSingleFloor('20.x'),
      'engines.node has to state a floor, not a window nothing measures the top of');

// ─── 1. This repository's manifest ────────────────────────────

console.log('\n1. no dependency in package.json resolves to a dist-tag or a wildcard');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));

const tags = tagSpecs(pkg);
check('every declared dependency names a version range', tags.length === 0, tags.join('; '));

const declaredCount = DEPENDENCY_BLOCKS
  .reduce((total, block) => total + Object.keys(pkg[block] ?? {}).length, 0);
check('there is a manifest to read at all', declaredCount > 0, `${declaredCount} dependencies declared`);

// ─── 2. And the lockfile a clean install would use ────────────

console.log('\n2. a clean install lands inside every declared range');

const drift = lockDriftIssues(pkg, lock);
check('package-lock.json asks for the same specs package.json declares', drift.length === 0, drift.join('; '));

const outside = resolutionIssues(pkg, lock);
check('every locked version satisfies its declared range', outside.length === 0, outside.join('; '));

const sdkSpec = pkg.dependencies?.['@modelcontextprotocol/sdk'];
const sdkLocked = lock.packages?.['node_modules/@modelcontextprotocol/sdk']?.version;
check('@modelcontextprotocol/sdk resolves inside its declared range',
      classifySpec(sdkSpec ?? '').kind === 'range' && satisfies(sdkLocked, sdkSpec) === true,
      `declared ${JSON.stringify(sdkSpec)}, locked ${sdkLocked}`);

// ─── 3. The supported Node floor, stated once ─────────────────

console.log('\n3. engines.node states one floor and the CI matrix runs it');

const workflowsDir = join(repoRoot, '.github', 'workflows');
const ciJobs = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .flatMap((name) => Object.values(parseYaml(readFileSync(join(workflowsDir, name), 'utf8')).jobs ?? {}));

/** Every Node version a job names, on the matrix axis, in an `include:`, or pinned on setup-node. */
function nodeVersions(job) {
  const out = [];
  const axis = job?.strategy?.matrix?.node;
  if (Array.isArray(axis)) out.push(...axis.map(String));
  else if (typeof axis === 'string' && axis !== '') out.push(axis);
  for (const entry of job?.strategy?.matrix?.include ?? []) {
    if (entry?.node !== undefined) out.push(String(entry.node));
  }
  for (const step of job?.steps ?? []) {
    const pinned = step?.with?.['node-version'];
    if (typeof pinned === 'string' && !/\$\{\{/.test(pinned)) out.push(pinned);
  }
  return out;
}

const ciMajors = [...new Set(ciJobs.flatMap((job) => nodeVersions(job).map(majorOf)))]
  .filter(Number.isFinite).sort((a, b) => a - b);

const enginesNode = pkg.engines?.node ?? '';
check('engines.node states one supported floor', isSingleFloor(enginesNode),
      `engines.node is ${JSON.stringify(enginesNode)} — a floor is what a consumer's npm reads`);
check('the CI matrix names a Node version this can read', ciMajors.length > 0,
      'no job in .github/workflows names a node version');
check('that floor is the oldest Node the CI matrix runs', majorOf(enginesNode) === ciMajors[0],
      `engines.node is ${JSON.stringify(enginesNode)} and the matrix runs ${ciMajors.join(', ') || 'nothing'}`);

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
