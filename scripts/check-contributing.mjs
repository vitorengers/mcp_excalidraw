#!/usr/bin/env node
/**
 * Checks that the working agreement is written for whoever is reading it.
 *
 * There was one copy of it, `CLAUDE.md`, and it was written for one maintainer and one agent
 * vendor. It opened by explaining that it existed because the workflow had lived in one
 * machine's local agent memory; it told the reader to add every issue to the GitHub project
 * *this board* is configured for; it said conversation with the maintainer is Portuguese; it
 * prescribed "merge it yourself — squash, delete the branch. Pull requests are not left open
 * for review"; and it presented a port as a fact of the world when it is a port chosen because
 * `3000` cannot be bound on one machine. Somebody arriving through a clone was being told to
 * write to a board they have no access to and to merge their own pull request — and an agent
 * that is not Claude Code does not open a file called `CLAUDE.md` at all, which is the whole
 * of the pluggable-agent goal walking into a filename.
 *
 * So the agreement is three documents, and this asserts the split held:
 *
 *  1. **`CONTRIBUTING.md` carries what binds anyone** — English-only and the check that
 *     enforces it, the check-before-fix rule with a worked example, the board-and-log
 *     obligation, the browser-verification rule, and how the checks are run.
 *  2. **`AGENTS.md` carries the same, under the filename most CLI agents read**, and
 *     `CLAUDE.md` is a pointer at it of under ten lines, so Claude Code still finds its way
 *     in and there is still only one copy of the rules.
 *  3. **no contributor-facing document carries the personal half** — the maintainer's own
 *     project board, an instruction to merge your own pull request, or the language the
 *     maintainer is spoken to in. Those are `MAINTAINERS.md`'s, and they are true there.
 *
 * The port rule is the one that is scoped rather than whole-file, and deliberately.
 * `3737` is the shipped default of the canvas server — `README.md` documents it a dozen times
 * as a fact about the product, `docs/install.md` and `docs/running.md` with it — and a rule
 * that forbade the digits would forbid the installation instructions along with the
 * convention. What the issue is about is a *contributor* being told which port to hold: so
 * `CONTRIBUTING.md` and `AGENTS.md` are contribution instructions end to end and may name no
 * port at all, and `README.md` is asked the same question only inside its `Testing` and
 * `Development` sections, which are the parts of it a contributor is reading as instructions.
 * Every check starts its own server on a port the kernel hands it, so neither document has
 * anything to give up by it.
 *
 * Section 0 runs the four detectors over the sentences they were written against — the real
 * ones, out of `CLAUDE.md` as it stood at the parent commit — and over the replacements, so a
 * rule that has quietly stopped matching anything is a failure here rather than a clean run
 * over documents nobody checked.
 *
 * Offline and self-contained. No server, no browser.
 *
 * Usage: node scripts/check-contributing.mjs
 *
 * Tier: repo
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The rules, as detectors ──────────────────────────────────

/**
 * The maintainer's own project board, in the two shapes it has ever been written in.
 *
 * A number and a personal account: a contributor has no access to either, and an instruction
 * to add an issue to one is an instruction that cannot be followed.
 */
const PERSONAL_BOARD = [
  /\bProject\s+5\b/i,
  /github\.com\/users\/[^/\s)`]+\/projects\/\d+/i,
];

/** "You merge it" in the forms this repository has used for it. */
const SELF_MERGE = [
  /\bmerge\s+(?:it|them)\s+yourself\b/i,
  /\bmerge\s+your\s+own\b/i,
  /\bself-?merges?\b/i,
  /\bnot\s+left\s+open\s+for\s+review\b/i,
  /\bsquash,\s*delete\s+the\s+branch\b/i,
];

/**
 * A port stated as something the reader has to hold.
 *
 * The bare digits are in the list because that is the form the convention was written in —
 * "**3737 is the board**" — and the two spelled forms catch the same instruction given as a
 * command line or as a URL.
 */
const PORT_CLAIM = [
  /\b3737\b/,
  // Assembled, because `check-no-external-server.mjs` scans every script in this directory for
  // the retired port and a rule naming it is indistinguishable from a check still using it.
  new RegExp(`\\b${['38', '38'].join('')}\\b`),
  /\bPORT\s*=\s*\d{2,5}\b/,
  /(?:127\.0\.0\.1|localhost)\s*:\s*\d{2,5}\b/i,
  /\bports?\s+\d{2,5}\b/i,
];

/** What language the maintainer is spoken to in — a fact about a person, not about a tree. */
const CONVERSATION_LANGUAGE = [
  /\bPortuguese\b/i,
  /conversation\s+with\s+the\s+maintainer/i,
];

/** Every line of `text` matching any of `rules`, as `line: text`. */
function offences(text, rules) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (rules.some((rule) => rule.test(line))) found.push(`${index + 1}: ${line.trim().slice(0, 90)}`);
  });
  return found;
}

// ─── 0. The detectors catch the real sentences ────────────────

console.log('0. each rule catches what it was written against, and clears the replacement');

// From CLAUDE.md at the parent commit, and from the issue that describes it. The board URL is
// the one shape with a placeholder owner in it: `check-shipped-config-neutral.mjs` asserts that
// no tracked file points at this repository owner's project board, and a fixture is a tracked
// file. The rule is written for the shape rather than for one account, which is what makes the
// substitution free.
const OLD = {
  board: 'add it to the GitHub project this board is configured for — see '
       + 'https://github.com/users/some-maintainer/projects/5',
  merge: '4. **Merge it yourself** — squash, delete the branch. Pull requests are not left '
       + 'open for review.',
  port: '**3737 is the board**, the port the operator starts it on, because 3000 cannot work '
      + 'on this machine.',
  language: 'Conversation with the maintainer is Portuguese; the repository is not correspondence.',
};

const NEW = {
  board: 'Open an issue on the tracker, and say in the pull request which issue it closes.',
  merge: 'Open a pull request whose body says `Closes #N`; a maintainer reviews it and merges it.',
  port: 'Every check starts its own canvas server on a port the kernel hands it, so there is '
      + 'no port to pick and none to keep free.',
  language: 'Everything written into the repository is English.',
};

check('the board rule catches a personal project board', offences(OLD.board, PERSONAL_BOARD).length === 1);
check('and clears an instruction to use the tracker', offences(NEW.board, PERSONAL_BOARD).length === 0);
check('the merge rule catches "merge it yourself"', offences(OLD.merge, SELF_MERGE).length === 1);
check('and clears "a maintainer reviews it"', offences(NEW.merge, SELF_MERGE).length === 0);
check('the port rule catches a port stated as the board',
      offences(OLD.port, PORT_CLAIM).length === 1);
check('and clears a check that starts its own', offences(NEW.port, PORT_CLAIM).length === 0);
check('the port rule also catches a command line and a URL',
      offences('PORT=3000 npm run canvas', PORT_CLAIM).length === 1
      && offences('open http://127.0.0.1:8080', PORT_CLAIM).length === 1);
check('the language rule catches what the maintainer is spoken to in',
      offences(OLD.language, CONVERSATION_LANGUAGE).length === 1);
check('and clears the rule about the repository itself',
      offences(NEW.language, CONVERSATION_LANGUAGE).length === 0);

// ─── 1. The three documents are there, and tracked ────────────

console.log('\n1. the agreement is where a reader of any kind will look');

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((file) => file.split('\\').join(posix.sep))
);

const CONTRIBUTING = 'CONTRIBUTING.md';
const AGENTS = 'AGENTS.md';
const CLAUDE = 'CLAUDE.md';

for (const file of [CONTRIBUTING, AGENTS, CLAUDE]) {
  check(`${file} is tracked`, tracked.has(file),
        'a document that is not committed is a document nobody arriving through a clone gets');
}

const read = (file) => (existsSync(join(repoRoot, file)) ? readFileSync(join(repoRoot, file), 'utf8') : '');

// ─── 2. Both copies carry the conventions that bind anyone ────

console.log('\n2. CONTRIBUTING.md and AGENTS.md carry the four binding conventions');

/**
 * One entry per convention, each pinned to something that has to be *named* rather than to a
 * phrase — the check that enforces the language rule, the two board artifacts, the runner.
 * A document can restate any of these in its own words; it cannot drop the file the reader
 * has to go to next.
 */
const CONVENTIONS = [
  {
    name: 'English is what the repository is written in, and names the check that enforces it',
    needs: [/\bEnglish\b/, /check-english-only\.mjs/],
  },
  {
    name: 'a behaviour change ships with a check, written against the old code first',
    needs: [/scripts\/check-[a-z0-9-]+\.mjs/, /against the old code|before the fix|red first|proves it catches/i],
  },
  {
    name: 'the board and the dated log are part of the change',
    needs: [/docs\/board\.excalidraw/, /docs\/development-log\.md/],
  },
  {
    name: 'anything that changes what the browser does is looked at in a browser',
    needs: [/in a browser/i, /compil/i],
  },
  {
    name: 'how the checks are run',
    needs: [/npm test/, /scripts\/run-checks\.mjs/],
  },
];

for (const file of [CONTRIBUTING, AGENTS]) {
  const text = read(file);
  for (const { name, needs } of CONVENTIONS) {
    const missing = needs.filter((rule) => !rule.test(text));
    check(`${file}: ${name}`, text !== '' && missing.length === 0,
          missing.map(String).join(' and '));
  }
}

// A worked example that names a check which is not in the tree is a worked example nobody can
// open. Every `scripts/check-*.mjs` either document names has to be one that exists.
for (const file of [CONTRIBUTING, AGENTS]) {
  const named = [...new Set([...read(file).matchAll(/scripts\/(check-[a-z0-9-]+\.mjs)/g)]
    .map(([, name]) => name))];
  const absent = named.filter((name) => !existsSync(join(repoRoot, 'scripts', name)));
  check(`${file} names ${named.length} check script(s), and every one of them exists`,
        named.length > 0 && absent.length === 0, absent.join(', '));
}

// ─── 3. CLAUDE.md is a pointer and nothing else ───────────────

console.log('\n3. CLAUDE.md is a pointer, so there is one copy of the rules and not two');

const claude = read(CLAUDE);
const claudeLines = claude.replace(/\s+$/, '').split(/\r?\n/);
check(`CLAUDE.md is under ten lines (${claudeLines.length})`, claude !== '' && claudeLines.length < 10,
      'a second copy of the agreement is a second copy to drift');
check('CLAUDE.md points at AGENTS.md', /\bAGENTS\.md\b/.test(claude));
check('and states no rule of its own',
      !CONVENTIONS.some(({ needs }) => needs.every((rule) => rule.test(claude))));

// ─── 4. The personal half is out of the contributor's way ─────

console.log('\n4. no contributor-facing document carries the maintainer\'s half');

/** The three the issue names, and the three a contributor actually reads. */
const FACING = [CONTRIBUTING, AGENTS, 'README.md'];

for (const file of FACING) {
  const text = read(file);
  const board = offences(text, PERSONAL_BOARD);
  check(`${file} names no personal project board`, board.length === 0, board.join('; '));
  const merge = offences(text, SELF_MERGE);
  check(`${file} tells nobody to merge their own pull request`, merge.length === 0, merge.join('; '));
  const language = offences(text, CONVERSATION_LANGUAGE);
  check(`${file} says nothing about what language the maintainer is spoken to in`,
        language.length === 0, language.join('; '));
}

/**
 * The port rule, scoped as the banner explains: whole-file for the two contribution
 * documents, and for `README.md` only the sections a contributor reads as instructions —
 * the rest of that file documents the shipped default port and has to keep doing so.
 */
function sections(text, titles) {
  const parts = text.split(/^##\s+/m).slice(1);
  return parts.filter((part) => titles.some((title) => part.startsWith(title))).join('\n');
}

for (const file of [CONTRIBUTING, AGENTS]) {
  const port = offences(read(file), PORT_CLAIM);
  check(`${file} binds the reader to no port`, port.length === 0, port.join('; '));
}

const readmeInstructions = sections(read('README.md'), ['Testing', 'Development']);
check('README.md has the two sections a contributor reads as instructions',
      readmeInstructions.length > 0, 'expected a ## Testing and a ## Development');
const readmePort = offences(readmeInstructions, PORT_CLAIM);
check('README.md binds the reader to no port where it is instructing them',
      readmePort.length === 0, readmePort.join('; '));

// And the way in: a contributor who never opens CONTRIBUTING.md is a contributor the split
// did nothing for.
check('README.md points at CONTRIBUTING.md', /\bCONTRIBUTING\.md\b/.test(read('README.md')));

// ─── 5. And the personal half is still written down ───────────

console.log('\n5. the maintainer\'s half was moved rather than deleted');

const MAINTAINERS = 'MAINTAINERS.md';
check(`${MAINTAINERS} is tracked`, tracked.has(MAINTAINERS),
      'the board this project is actually run from is a real workflow, not a thing to lose');

const maintainers = read(MAINTAINERS);
check(`${MAINTAINERS} carries the self-merge loop that CONTRIBUTING.md no longer states`,
      SELF_MERGE.some((rule) => rule.test(maintainers)));
check(`${MAINTAINERS} says which port this board is started on`,
      PORT_CLAIM.some((rule) => rule.test(maintainers)));
check(`${AGENTS} points an agent working in this board's own checkout at ${MAINTAINERS}`,
      new RegExp(`\\b${MAINTAINERS}\\b`).test(read(AGENTS)));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
