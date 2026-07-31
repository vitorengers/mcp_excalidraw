#!/usr/bin/env node
/**
 * Checks that the front page of the repository is about this repository.
 *
 * `README.md` is the one document a clone reads first, and it is the one document nothing
 * inspected. It still opened with the upstream project's CI and package badges, sent bug
 * reports to the upstream issue tracker, and of everything this fork is — the workspace
 * registry, the two-section board, the block kinds, the worktree per issue — it documented a
 * single troubleshooting bullet. The name in `board.config.json` appeared zero times.
 *
 * The rules are about identity and coverage, not about prose:
 *
 *  1. it says which project and which repository it is;
 *  2. no badge, and no unattributed link, points at the upstream project — a green CI badge
 *     for somebody else's pipeline is worse than no badge;
 *  3. it names each of the load-bearing pieces of this fork, including every block kind the
 *     code defines, so a new kind cannot ship without the front page learning about it;
 *  4. it says how to start the tool, by pointing at the document that says how;
 *  5. and every command it prints runs on the platform the reader is on — which is rule 4
 *     with the reader's machine in it, and the one the front page kept failing. `PORT=3000
 *     npm run canvas` is a parse error in PowerShell and in cmd, and `open <url>` is a macOS
 *     program; a quick start that cannot be typed is not a quick start. `docs/install.md` is
 *     held to the same rule, because it is the document that page now sends a stranger to.
 *
 * `check-docs-index.mjs` separately holds it to naming only files that exist.
 *
 * Offline and self-contained.
 *
 * Usage: node scripts/check-readme.mjs
 *
 * Tier: repo
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoIdentity } from './lib/repo-identity.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

const readme = read('README.md');
const config = JSON.parse(read('board.config.json'));
// The name is the board's — the product is what the board is called. The repository is the
// tree's own record of itself, since #315 took `repo` out of the board config: a configuration
// a clone copies must not name the account it was copied from.
const { repo } = repoIdentity();

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const mentions = (needle) => readme.includes(needle);

// ─── 1. Whose front page this is ──────────────────────────────

console.log('1. the front page says which project it is');
check(`it uses the name in board.config.json ("${config.name}")`, mentions(config.name),
      'the tool has a name and the README never said it');
check(`it names this repository (${repo})`, mentions(repo),
      'a clone cannot tell which fork it is holding');

// ─── 2. Nothing points at the upstream project unmarked ───────

console.log('\n2. no badge or link claims the upstream project as this one');

const UPSTREAM = 'yctimlin';

// A badge is a linked image, and a linked image is a claim about live state: this pipeline
// is green, this package is at this version. Neither is true of a fork that publishes
// neither.
const badges = [...readme.matchAll(/\[!\[[^\]]*\]\(([^)]*)\)\]\(([^)]*)\)/g)]
  .flatMap(([, image, target]) => [image, target]);
const upstreamBadges = badges.filter((url) => url.includes(UPSTREAM));
check('no badge points at the upstream project', upstreamBadges.length === 0,
      upstreamBadges.join(', '));

// The npm badge is the same claim by another route: the published package is the upstream
// one, and a version badge on this page reads as this page's version.
check('no npm version badge stands in for a package this fork does not publish',
      !/img\.shields\.io\/npm\/v\//.test(readme),
      'the published package is upstream\'s; a version badge here misreports this fork');

// Prose only. A fenced block naming `ghcr.io/yctimlin/mcp_excalidraw` is the coordinate of a
// real published image, spelled correctly; it is the sentence around it that has to say whose.
let fenced = false;
const unattributed = readme.split(/\r?\n/)
  .map((line, index) => ({ line, at: index + 1 }))
  .filter(({ line }) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return false; }
    return !fenced && line.includes(UPSTREAM) && !/upstream/i.test(line);
  });
check('every remaining mention of the upstream project says that is what it is',
      unattributed.length === 0,
      unattributed.map(({ line, at }) => `${at}: ${line.trim().slice(0, 80)}`).join('\n        '));

// Bug reports have to arrive somewhere a maintainer of this fork will read them.
check('bug reports are pointed at this fork\'s issue tracker',
      mentions(`github.com/${repo}/issues`), `expected a link to ${repo}/issues`);

// ─── 3. What this fork is, named on its own front page ────────

console.log('\n3. it names what this fork actually is');

/**
 * The block kinds a shape can carry. Three are exported constants; `issue` predates the
 * convention and is written inline. The assertion below keeps the list honest: an exported
 * kind that is not in it fails here rather than quietly missing from the README.
 */
const BLOCK_KINDS = ['issue', 'project-board', 'terminal', 'board-section'];

const declared = [...read('src/core/board-sections.ts').matchAll(/_KIND = '([a-z-]+)'/g),
                  ...read('src/core/project-board-layout.ts').matchAll(/_KIND = '([a-z-]+)'/g),
                  ...read('src/core/terminal-block.ts').matchAll(/_KIND = '([a-z-]+)'/g)]
  .map(([, kind]) => kind);
const unknown = declared.filter((kind) => !BLOCK_KINDS.includes(kind));
check('the list of block kinds below still covers every kind the code exports',
      unknown.length === 0 && declared.length > 0,
      `${unknown.join(', ')} — add it here and to the README`);

for (const kind of BLOCK_KINDS) {
  check(`it names the "${kind}" block`, mentions(`\`${kind}\``) || mentions(`"${kind}"`),
        `customData.kind = "${kind}" is one of the four things a shape on this board can be`);
}

check('it names the workspace registry', mentions('EXCALIDRAW_WORKSPACES'),
      'one project per board is the whole shape of this fork');
check('it names board.config.json', mentions('board.config.json'));

// Both sections, with the keys the board itself declares — read from the board, so renaming
// a section on the canvas fails here rather than silently disagreeing with the front page.
const board = JSON.parse(read(config.board));
const sections = (board.elements ?? [])
  .filter((element) => !element.isDeleted && element.customData?.kind === 'board-section')
  .map((element) => element.customData);
check('the board declares its sections', sections.length >= 2, `${sections.length} found`);
for (const section of sections) {
  const key = `Alt+${(section.hotkeyCode ?? '').replace(/^Key/, '')}`;
  check(`it names the "${section.title}" section and ${key}`,
        mentions(section.title) && mentions(key));
}

check('it names the worktree per issue', /-worktrees\/issue-/.test(readme),
      'an implementation gets a checkout of its own, and nothing on the front page said so');

// ─── 4. How to start it ───────────────────────────────────────

console.log('\n4. it says how to start the tool');
check('it links the run procedure', mentions('docs/running.md'),
      'the only start instruction a clone had was a port that cannot work on this machine');
check('it links the install document', mentions('docs/install.md'),
      'the one page a stranger is sent to before anything else');

// ─── 5. And the commands it prints run on the reader's machine ─

/**
 * A shell command spelled for one platform, and the spelling that pairs with it.
 *
 * The anchoring is the whole rule. `VAR=value cmd` is only POSIX syntax when the assignment
 * is the *first token of a command*, and matching it anywhere would also match
 * `docker run -e PORT=3737`, a `.env` sample, and the prose sentence explaining what the
 * variable does — noise enough to get the rule turned off rather than obeyed. So an offence
 * is the first token of a line inside a fenced block, and nothing else is looked at.
 *
 * A pairing counts when it is under the same heading, which is how a document that means to
 * cover three shells is actually written: one section, one fenced block per shell. It does
 * not count from another section, because a reader on Windows reads the section they are in.
 */
const POSIX_ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const WINDOWS_ENV = /^(?:\$env:[A-Za-z_]|set\s+[A-Za-z_][A-Za-z0-9_]*=)/i;
const URL_ARGUMENT = /^(?:https?:\/\/|[$%<])/;
const WINDOWS_OPEN = /^(?:start\b|Start-Process\b|explorer\b|cmd\s+\/c\s+start\b)/i;

/**
 * Every command in `text` that only one platform can run, minus the ones its own section
 * already gives a Windows spelling for.
 */
function unpairedCommands(text) {
  const scopes = new Map();
  const offences = [];
  let heading = '(before the first heading)';
  let fenced = false;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (!fenced) {
      if (/^#{1,6}\s/.test(line)) heading = line.replace(/^#+\s*/, '');
      return;
    }

    const [first, second] = line.split(/\s+/).filter(Boolean);
    if (!first) return;

    let scope = scopes.get(heading);
    if (!scope) { scope = { env: false, open: false }; scopes.set(heading, scope); }
    if (WINDOWS_ENV.test(line)) scope.env = true;
    if (WINDOWS_OPEN.test(line)) scope.open = true;

    // `PORT=3737` alone is a `.env` line, not a command, and a trailing comment is not a
    // command either. It takes a program after the assignment to be POSIX prefix syntax.
    if (POSIX_ENV_PREFIX.test(first) && second && !second.startsWith('#')) {
      offences.push({ kind: 'env', heading, at: index + 1, line });
    }
    if (first === 'open' && second && URL_ARGUMENT.test(second)) {
      offences.push({ kind: 'open', heading, at: index + 1, line });
    }
  });

  return offences.filter((offence) => !scopes.get(offence.heading)[offence.kind]);
}

console.log('\n5. every command it prints runs on the platform the reader is on');

// The fixtures come first: this rule is a regex over prose, and a regex over prose that has
// never been shown what it must *not* match is one false positive away from being deleted.
const FIXTURES = [
  ['a POSIX env prefix alone in a section is caught', 1,
   '## From source\n\n```bash\nPORT=3737 npm run canvas\n```\n'],
  ['the same command paired with the PowerShell spelling is not', 0,
   '## From source\n\n```powershell\n$env:PORT = "3737"; npm run canvas\n```\n\n'
   + '```bash\nPORT=3737 npm run canvas\n```\n'],
  ['paired with the cmd spelling it is not either', 0,
   '## From source\n\n```bat\nset PORT=3737 && npm run canvas\n```\n\n'
   + '```bash\nPORT=3737 npm run canvas\n```\n'],
  ['a pairing in a different section does not excuse it', 1,
   '## Windows\n\n```powershell\n$env:PORT = "3737"; npm run canvas\n```\n\n'
   + '## Linux\n\n```bash\nPORT=3737 npm run canvas\n```\n'],
  ['`docker run -e KEY=value` is not env-prefix syntax', 0,
   '## Container\n\n```bash\ndocker run -e PORT=3737 some/image\n```\n'],
  ['a `.env` sample is not a command', 0, '## Configuration\n\n```\nPORT=3737\n```\n'],
  ['nor is an assignment with a comment after it', 0,
   '## Configuration\n\n```\nPORT=3737 # the board\n```\n'],
  ['prose naming VAR=value is not a command at all', 0,
   '## Configuration\n\nPORT=3737 npm run canvas is the POSIX spelling.\n'],
  ['a bare `open <url>` is caught', 1,
   '## Open it\n\n```bash\nopen http://127.0.0.1:3737\n```\n'],
  ['paired with `start` it is not', 0,
   '## Open it\n\n```bat\nstart http://127.0.0.1:3737\n```\n\n'
   + '```bash\nopen http://127.0.0.1:3737\n```\n'],
  ['`open` on a file is not the macOS URL opener', 0,
   '## Open it\n\n```bash\nopen docs/index.md\n```\n'],
];

for (const [name, expected, text] of FIXTURES) {
  const found = unpairedCommands(text);
  check(`the rule: ${name}`, found.length === expected,
        `${found.length} offence(s), expected ${expected}`);
}

for (const relative of ['README.md', 'docs/install.md']) {
  if (!existsSync(join(repoRoot, relative))) {
    check(`${relative} exists`, false, 'the document a stranger is sent to is not there');
    continue;
  }
  const offences = unpairedCommands(read(relative));
  check(`${relative} spells every command for more than one platform`, offences.length === 0,
        offences.map(({ at, line, kind }) =>
          `${relative}:${at}: ${line} (${kind === 'env' ? 'POSIX env-prefix syntax'
                                                       : 'macOS-only `open <url>`'})`)
          .join('\n        '));
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
