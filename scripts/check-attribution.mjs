#!/usr/bin/env node
/**
 * Checks that what this fork ships says whose work it is.
 *
 * `LICENSE` entered this tree in cb743c6, written by the upstream author, and its notice reads
 * `Copyright (c) 2024 MCP Excalidraw Server` — a product string naming neither a person nor an
 * entity, while the permission text three paragraphs below requires that notice be carried into
 * every copy. `package.json` ships `LICENSE` in every tarball, so a notice naming nobody travels
 * with every download, and nothing in the tree stated the fork relationship except prose in the
 * middle of `README.md`, which is not what a redistributor ships. The front page meanwhile
 * rendered `demo.gif` — committed by the upstream author in 9883dce — as this project's hero
 * image, above a caption that claimed the recording without saying whose it was.
 *
 * Four rules, and each is about a copy leaving this repository rather than about prose:
 *
 *  1. **`LICENSE` names both.** The inherited notice stays verbatim, because MIT says it must;
 *     above the permission text there is now also a line naming the upstream author and one
 *     naming this fork's own maintainer, so a reader of the licence alone can tell who holds
 *     what.
 *  2. **`NOTICE.md` states the divergence**, names the fork base commit, and the commit
 *     resolves in this repository — a sha nobody can look up is a claim, not a record.
 *  3. **Both files ship**: listed in `package.json` `files`, and present in what
 *     `npm pack --dry-run` says the tarball will contain. The manifest is the intent; the pack
 *     listing is what npm actually does with it.
 *  4. **No upstream-authored image or video is presented as this project's.** A local image is
 *     upstream's when the commit that introduced it was the upstream author's, read from
 *     `git log --follow`; a link to a video host is upstream's by default, because this fork has
 *     published no video and the README already frames the one it links as the upstream
 *     project's. Either way the word `upstream` has to appear on the reference's own line or in
 *     its caption — the nearest non-empty line above or below.
 *
 * `package.json` `repository.url`, `homepage` and `bugs.url` are **not** re-asserted here.
 * `check-fork-identity.mjs` rule 2 owns them, reading the expectation from `board.config.json`,
 * and a second copy of that rule is a second place to update. What this adds there is `author`,
 * which that check does not read: a package whose author is somebody else sends every bug
 * report and every question about it to a repository that will not answer.
 *
 * The fork base sha is read out of `check-board-map.mjs` rather than written down again, for the
 * same reason.
 *
 * **This check was red on the tree it was written against**, on all four rules. Section 0 is
 * what keeps that meaningful: it drives every rule over text carrying each defect and over text
 * carrying none, so a future green run says the tree is right rather than that the scanner
 * stopped looking.
 *
 * Offline and self-contained: tracked files, `git log`, `git cat-file` and `npm pack --dry-run`,
 * which reads the manifest and touches no registry. No server, no browser, no network.
 *
 * Usage: node scripts/check-attribution.mjs
 *
 * Tier: repo
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

/** The account this fork was cut from, and the repository the inherited code came from. */
const UPSTREAM_OWNER = 'yctimlin';
const UPSTREAM_REPO = 'yctimlin/mcp_excalidraw';

/**
 * Upstream's own copyright line, exactly as it arrived.
 *
 * It names a product rather than a person, which is the defect this change is about — but MIT
 * requires the notice be included in all copies, and this file is a copy. It is kept and a line
 * naming the author added above it, rather than rewritten.
 */
const INHERITED_NOTICE = 'Copyright (c) 2024 MCP Excalidraw Server';

/**
 * A disclaimer, however it is spelled.
 *
 * `neither upstream is affiliated with this project` and `this project is not affiliated with
 * either` say the same thing, and a rule that only accepted one wording would be a rule about
 * phrasing.
 */
const DISCLAIMED = /\b(?:not|neither|no)\b[^.]{0,120}affiliat/i;

/** Where a video lives. Nothing here is published by this fork. */
const VIDEO_HOST = /^(?:https?:)?\/\/(?:[\w.-]+\.)?(?:youtu\.be|youtube\.com|vimeo\.com)(?:[/?]|$)/i;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The four rules, as functions over text ───────────────────

/** Case, separators and diacritics removed: what is left is the identity. */
const fold = (value) => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

/** A copyright line is one that says so and carries the mark. */
const copyrightLines = (text) => text.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /copyright/i.test(line) && /\(c\)|©/i.test(line));

/**
 * Where `LICENSE` fails to say who holds what.
 *
 * Both names are looked for on copyright lines only. A "see also" naming the upstream
 * repository at the bottom of the file is a pointer, not a grant.
 */
function licenceIssues(text, owner) {
  const lines = copyrightLines(text);
  const issues = [];
  if (lines.length === 0) return ['LICENSE carries no copyright line at all'];

  if (!text.includes(INHERITED_NOTICE)) {
    issues.push(`the inherited notice "${INHERITED_NOTICE}" is gone — MIT carries it into `
                + 'every copy, so it stays verbatim and the fork adds a line of its own');
  }
  if (!lines.some((line) => fold(line).includes(fold(UPSTREAM_OWNER)))) {
    issues.push(`no copyright line names "${UPSTREAM_OWNER}", the author of the inherited work: `
                + lines.join(' | '));
  }
  if (!lines.some((line) => fold(line).includes(fold(owner)))) {
    issues.push(`no copyright line names "${owner}", this fork's own maintainer: `
                + lines.join(' | '));
  }
  return issues;
}

/**
 * Where `NOTICE.md` fails to record the divergence.
 *
 * `resolves` answers whether a sha exists in this repository; section 0 passes a stub, so the
 * rule is testable without inventing commits.
 */
function noticeIssues(text, forkBase, resolves) {
  if (!text || !text.trim()) return ['NOTICE.md is missing or empty'];
  const issues = [];

  if (!new RegExp(UPSTREAM_REPO.replace('/', '\\/'), 'i').test(text)) {
    issues.push(`it never names the upstream repository (${UPSTREAM_REPO})`);
  }
  if (!/\bMIT\b/.test(text)) issues.push('it never says which licence either side carries');

  const named = [...text.matchAll(/\b[0-9a-f]{7,40}\b/gi)].map(([sha]) => sha.toLowerCase());
  const base = named.find((sha) => forkBase.startsWith(sha));
  if (!base) {
    issues.push(`it names no commit that is the fork base (${forkBase.slice(0, 7)}); found `
                + `${named.length ? named.join(', ') : 'no commit hash at all'}`);
  } else if (!resolves(base)) {
    issues.push(`the commit it names (${base}) does not resolve in this repository`);
  }

  if (!/excalidraw\/excalidraw/i.test(text)) {
    issues.push('it never names Excalidraw itself as the separate project it depends on');
  }
  if (!DISCLAIMED.test(text) || !/endorse/i.test(text)) {
    issues.push('it never says that neither upstream is affiliated with or endorses this project');
  }
  return issues;
}

/** Where the two attribution files would not reach a tarball. */
function shippedIssues(files, packed) {
  const issues = [];
  for (const wanted of ['LICENSE', 'NOTICE.md']) {
    if (!files.includes(wanted)) issues.push(`package.json files does not list ${wanted}`);
    if (!packed.includes(wanted)) issues.push(`npm pack would not include ${wanted}`);
  }
  return issues;
}

/**
 * Every image and video a Markdown document renders, outside fenced blocks.
 *
 * A fenced block is an example of Markdown, not a rendered claim, and the badge row is
 * `[![…](…)](…)` — an image inside a link, which is why images are collected before links and
 * a link whose target is not a video host is dropped.
 */
function mediaReferences(markdown) {
  const lines = markdown.split(/\r?\n/);
  const refs = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    for (const [, target] of line.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)) {
      refs.push({ kind: 'image', target, at: index });
    }
    for (const [, target] of line.matchAll(/(?<!!)\[[^\]]*\]\(\s*([^)\s]+)/g)) {
      if (VIDEO_HOST.test(target)) refs.push({ kind: 'video', target, at: index });
    }
  });
  return { lines, refs };
}

/** The reference's own line, plus the nearest non-empty line above and below it. */
function caption(lines, at) {
  const out = [lines[at] ?? ''];
  for (const step of [-1, 1]) {
    for (let i = at + step; i >= 0 && i < lines.length; i += step) {
      if (!lines[i].trim()) continue;
      out.push(lines[i]);
      break;
    }
  }
  return out.join('\n');
}

/**
 * Every upstream-authored asset the document presents as its own.
 *
 * `isUpstream` decides authorship; it is injected so section 0 can state it instead of asking
 * git about files that do not exist.
 */
function mediaIssues(markdown, isUpstream) {
  const { lines, refs } = mediaReferences(markdown);
  return refs
    .filter((ref) => isUpstream(ref))
    .filter((ref) => !/upstream/i.test(caption(lines, ref.at)))
    .map((ref) => `line ${ref.at + 1}: the ${ref.kind} ${ref.target} is upstream's and neither `
                  + 'its line nor its caption says so');
}

// ─── 0. The rules catch each defect, and clear a fixed tree ───

console.log('0. the rules catch each defect, and clear text that has none');

const OWNER_FIXTURE = 'someone';

const DIRTY_LICENCE = `MIT License\n\n${INHERITED_NOTICE}\n\nPermission is hereby granted,\n`;
const CLEAN_LICENCE = 'MIT License\n\n'
  + `${INHERITED_NOTICE}\n`
  + `Copyright (c) 2024-2026 ${UPSTREAM_OWNER}, the original work\n`
  + `Copyright (c) 2026 ${OWNER_FIXTURE}, this fork\n\nPermission is hereby granted,\n`;

check('a licence carrying only the inherited product line is caught, twice over',
      licenceIssues(DIRTY_LICENCE, OWNER_FIXTURE).length === 2,
      licenceIssues(DIRTY_LICENCE, OWNER_FIXTURE).join(' / ') || 'nothing caught');
check('a licence that dropped the inherited notice is caught',
      licenceIssues(CLEAN_LICENCE.replace(`${INHERITED_NOTICE}\n`, ''), OWNER_FIXTURE).length === 1);
check('a licence naming the author and the fork is accepted',
      licenceIssues(CLEAN_LICENCE, OWNER_FIXTURE).length === 0,
      licenceIssues(CLEAN_LICENCE, OWNER_FIXTURE).join(' / '));
check('a licence with no copyright line at all is caught',
      licenceIssues('MIT License\n', OWNER_FIXTURE).length === 1);

const BASE_FIXTURE = '505f4c6e0ca1fe2489b4c18c9fedc24ac50a9002';
const resolvesAll = () => true;
const CLEAN_NOTICE = `# Notice\n\nThis project is an MIT fork of ${UPSTREAM_REPO} at commit\n`
  + `${BASE_FIXTURE}. Excalidraw itself (github.com/excalidraw/excalidraw) is a separate MIT\n`
  + 'project. Neither upstream is affiliated with this project, and neither endorses it.\n';

check('a missing NOTICE.md is caught', noticeIssues('', BASE_FIXTURE, resolvesAll).length === 1);
check('a NOTICE.md naming no commit is caught',
      noticeIssues(CLEAN_NOTICE.replace(BASE_FIXTURE, 'some later commit'), BASE_FIXTURE,
                   resolvesAll).length === 1);
check('a NOTICE.md naming a commit that is not the fork base is caught',
      noticeIssues(CLEAN_NOTICE.replace(BASE_FIXTURE, 'deadbeefcafe1234'), BASE_FIXTURE,
                   resolvesAll).length === 1);
check('a NOTICE.md whose commit does not resolve is caught',
      noticeIssues(CLEAN_NOTICE, BASE_FIXTURE, () => false).length === 1);
check('a NOTICE.md that never disclaims affiliation is caught',
      noticeIssues(CLEAN_NOTICE.slice(0, CLEAN_NOTICE.indexOf('Neither')), BASE_FIXTURE,
                   resolvesAll).length === 1);
check('a NOTICE.md stating the divergence is accepted, abbreviated sha and all',
      noticeIssues(CLEAN_NOTICE.replace(BASE_FIXTURE, BASE_FIXTURE.slice(0, 7)), BASE_FIXTURE,
                   resolvesAll).length === 0,
      noticeIssues(CLEAN_NOTICE, BASE_FIXTURE, resolvesAll).join(' / '));

check('a manifest that lists neither file, and a pack that has neither, is caught four times',
      shippedIssues(['README.md'], ['README.md']).length === 4);
check('a manifest listing both, packed with both, is accepted',
      shippedIssues(['README.md', 'LICENSE', 'NOTICE.md'], ['LICENSE', 'NOTICE.md']).length === 0);

const upstreamAsset = (ref) => ref.kind === 'video' || ref.target === 'demo.gif';
const DIRTY_README = '## Demo\n\n![An agent drawing](demo.gif)\n\n'
  + '*An agent draws a diagram. [Watch the full video](https://youtu.be/ufW78Amq5qA)*\n';
const CLEAN_README = '## Demo\n\n![The upstream project\'s demo](demo.gif)\n\n'
  + '*The upstream project\'s demo. [Watch it on YouTube](https://youtu.be/ufW78Amq5qA)*\n';

check('an uncaptioned hero image and an uncaptioned video link are both caught',
      mediaIssues(DIRTY_README, upstreamAsset).length === 2,
      mediaIssues(DIRTY_README, upstreamAsset).join(' / ') || 'nothing caught');
check('the caption may be the line below the image rather than the image\'s own line',
      mediaIssues('![An agent drawing](demo.gif)\n\n*Upstream\'s recording.*\n',
                  upstreamAsset).length === 0);
check('an asset this fork made is not a hit',
      mediaIssues('![The board](docs/board.png)\n', upstreamAsset).length === 0);
check('a badge is an image inside a link, and neither half is a video',
      mediaReferences('[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n')
        .refs.length === 1);
check('a fenced example of the same Markdown is not a rendered claim',
      mediaIssues('```md\n![An agent drawing](demo.gif)\n```\n', upstreamAsset).length === 0);
check('a captioned front page is accepted', mediaIssues(CLEAN_README, upstreamAsset).length === 0,
      mediaIssues(CLEAN_README, upstreamAsset).join(' / '));

// ─── The real tree ────────────────────────────────────────────

const config = JSON.parse(read('board.config.json'));
const repo = String(config.repo ?? '');
const [repoOwner] = repo.split('/');

/** One sha, recorded once. `check-board-map.mjs` is where it lives. */
function forkBase() {
  const source = read('scripts/check-board-map.mjs');
  const found = source.match(/FORK_BASE\s*=\s*'([0-9a-f]{40})'/i);
  return found ? found[1].toLowerCase() : null;
}

const base = forkBase();

console.log('\n1. LICENSE names the author of the inherited work and this fork');

check('the fork base sha is still recorded in check-board-map.mjs', base !== null,
      'nothing to hold NOTICE.md to');

const licence = licenceIssues(read('LICENSE'), repoOwner);
check(`LICENSE carries a line for ${UPSTREAM_OWNER} and a line for ${repoOwner}`,
      licence.length === 0, licence.join('\n        '));

console.log('\n2. NOTICE.md records the divergence, and the commit resolves');

const resolves = (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`],
                                    { cwd: repoRoot }).status === 0;

const noticePath = join(repoRoot, 'NOTICE.md');
const notice = existsSync(noticePath) ? readFileSync(noticePath, 'utf8') : '';
const noticeProblems = base ? noticeIssues(notice, base, resolves)
                            : ['no fork base sha to check NOTICE.md against'];
check('NOTICE.md exists and states the fork, the base commit and the two upstreams',
      noticeProblems.length === 0, noticeProblems.join('\n        '));

console.log('\n3. LICENSE and NOTICE.md ship with the package');

const pkg = JSON.parse(read('package.json'));

/** What npm says the tarball will hold. `--dry-run` writes nothing and asks no registry. */
function packedPaths() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
                           { cwd: repoRoot, encoding: 'utf8', shell: true });
  const text = String(result.stdout ?? '');
  const start = text.indexOf('[');
  if (start === -1) return null;
  try {
    return (JSON.parse(text.slice(start))[0]?.files ?? []).map(({ path }) => path);
  } catch { return null; }
}

const packed = packedPaths();
check('npm pack --dry-run answered with a file list', packed !== null,
      'npm could not be run, or printed something else');

const shipped = packed === null ? ['npm pack --dry-run produced no listing']
                                : shippedIssues(pkg.files ?? [], packed);
check('package.json files lists both, and npm pack --dry-run includes both',
      shipped.length === 0, shipped.join('\n        '));

check(`package.json author names ${repoOwner} rather than another account`,
      fold(pkg.author?.name ?? pkg.author).includes(fold(repoOwner)),
      `author is ${JSON.stringify(pkg.author ?? null)} — repository.url, homepage and bugs.url `
      + 'are check-fork-identity.mjs rule 2');

console.log('\n4. no upstream asset on the front page is presented as this project\'s');

/** Who introduced a tracked file: the earliest commit `--follow` reaches. */
function introducedBy(path) {
  try {
    const log = execFileSync('git', ['log', '--follow', '--format=%an', '--', path],
                             { cwd: repoRoot, encoding: 'utf8' }).trim();
    return log ? log.split(/\r?\n/).at(-1) : null;
  } catch { return null; }
}

/**
 * A video link is upstream's unless this fork starts publishing video; a hosted image — a
 * shields.io badge — is generated rather than authored, and a local one is whoever committed it.
 */
function isUpstreamAsset(ref) {
  if (ref.kind === 'video') return true;
  if (/^(?:[a-z]+:)?\/\//i.test(ref.target)) return false;
  const path = ref.target.split(/[?#]/)[0];
  if (!existsSync(join(repoRoot, path))) return false;
  return fold(introducedBy(path)) === fold(UPSTREAM_OWNER);
}

const readme = read('README.md');
const { refs } = mediaReferences(readme);
const upstreamRefs = refs.filter((ref) => isUpstreamAsset(ref));
check(`the front page still carries upstream assets to caption (${upstreamRefs.length} found)`,
      upstreamRefs.length > 0,
      'none found — if they were deleted rather than captioned, drop this case with them');

const media = mediaIssues(readme, isUpstreamAsset);
check('every upstream image and video is captioned as upstream', media.length === 0,
      media.join('\n        '));

console.log('');
if (failures) { console.error(`${failures} case(s) failed`); process.exit(1); }
console.log('All checks passed');
