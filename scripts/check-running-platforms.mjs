#!/usr/bin/env node
/**
 * Checks that the run procedure's start step is written for the machine the reader is on.
 *
 * `docs/running.md` is the operator procedure, and its one mandatory *before you start* step —
 * killing whatever is already listening, the trap `docs/trap-stale-server.md` exists for — was
 * a PowerShell loop and nothing else. The words macOS, Linux and `lsof` did not appear in the
 * file. A reader on either of those two hit a `Get-NetTCPConnection` block as step one and had
 * to translate it before they could follow the document at all, and the note about
 * PowerShell's read-only `$PID` sat outside the block it is about, where it reads as advice to
 * everybody.
 *
 * Four rules, and the first is the one the document failed:
 *
 *  1. **each of Windows, macOS and Linux has a heading of its own in that section, with a
 *     command under it** that the named platform can actually run — a section that mentions
 *     macOS in prose while offering one shell's commands is the same document with an
 *     apology in it;
 *  2. **the `$PID` note is inside the Windows subsection**, because it is a fact about
 *     PowerShell and about nothing else;
 *  3. **no POSIX block pipes `lsof` into a bare `xargs kill`.** This was measured rather than
 *     assumed: with nothing listening `lsof -ti tcp:<port>` prints nothing and exits 1, and
 *     GNU `xargs` then runs `kill` with no arguments at all — the usage message on stderr and
 *     exit 123, from the one step whose success case is finding nothing. `xargs -r` suppresses
 *     it on GNU systems, and BSD `xargs` does not run the utility on empty input at all, so
 *     the loud failure is Linux-only and lands on exactly the reader this rule is for;
 *  4. **every port literal a reader might type is marked** as an example, as the default, or
 *     as this particular board's, rather than stated as the value. The unit is the paragraph,
 *     not the sentence: a paragraph is what a reader takes a number out of, and the sentence
 *     that marks a number is routinely the one before it.
 *
 * Port **3000** is exempt from rule 4, deliberately. It is the one port this document never
 * tells anybody to use — every mention of it is the trap in `docs/trap-port-3000.md` — and a
 * rule that demanded the trap be marked as an example would be asking for the opposite of
 * what it means.
 *
 * Offline and self-contained: it reads one tracked file and starts nothing.
 *
 * Usage: node scripts/check-running-platforms.mjs
 *
 * Tier: fast
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOC = 'docs/running.md';

/** The H2 the start step lives under. `docs/install.md` links this anchor. */
const SECTION = /^##\s+Before you start/i;

/**
 * The three platforms, the heading that names each one, and a command each can run.
 *
 * The command patterns are what makes a heading mean something: three headings over three
 * copies of the same PowerShell loop would satisfy a rule about headings alone.
 */
const PLATFORMS = [
  {
    name: 'Windows',
    heading: /windows/i,
    command: /Get-NetTCPConnection|Stop-Process|taskkill|netstat/i,
    wants: 'a PowerShell or cmd way to find the listener and stop it',
  },
  {
    name: 'macOS',
    heading: /mac\s?os|\bmac\b/i,
    command: /\blsof\b|\bfuser\b|\bkill\b/,
    wants: 'lsof, fuser or kill — a command a POSIX shell has',
  },
  {
    name: 'Linux',
    heading: /linux/i,
    command: /\blsof\b|\bfuser\b|\bss\b|\bkill\b/,
    wants: 'lsof, fuser, ss or kill — a command a POSIX shell has',
  },
];

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const doc = readFileSync(join(repoRoot, DOC), 'utf8');
const lines = doc.split(/\r?\n/);

/**
 * The lines of the document, each told whether it is inside a fenced block and whether it is
 * inside a generated region.
 *
 * The generated regions are the settings tables, produced from `src/core/settings.ts` by
 * `scripts/generate-settings-docs.mjs`. Their numbers sit in a column headed *Default* and
 * are not this file's to rewrite.
 */
function classify(source) {
  let fenced = false;
  let generated = false;
  return source.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (/^<!--\s*generated:/.test(line)) { generated = true; return { raw, fenced, generated }; }
    if (/^<!--\s*\/generated:/.test(line)) { generated = false; return { raw, fenced, generated: true }; }
    // The fence line itself is neither prose nor content: counting it as fenced keeps a
    // heading-shaped line inside a block from being read as a heading.
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; return { raw, fenced: true, generated }; }
    return { raw, fenced, generated };
  });
}

const classified = classify(doc);

// ─── 1. Three platforms, three headings, a command under each ─

console.log('1. the start step is written for all three platforms');

const start = lines.findIndex((line, index) => !classified[index].fenced && SECTION.test(line));
check(`${DOC} has a "Before you start" section`, start !== -1,
      'the mandatory pre-start step is the one every reader hits first');

if (start === -1) { console.error('\n1 case(s) failed'); process.exit(1); }

let end = lines.length;
for (let index = start + 1; index < lines.length; index++) {
  if (!classified[index].fenced && /^##\s+/.test(lines[index])) { end = index; break; }
}

/** The H3 subsections of that section, each with the lines under it. */
const subsections = [];
for (let index = start + 1; index < end; index++) {
  if (classified[index].fenced || !/^###\s+/.test(lines[index])) continue;
  if (subsections.length) subsections[subsections.length - 1].end = index;
  subsections.push({ title: lines[index].replace(/^#+\s*/, ''), start: index, end });
}

const bodyOf = ({ start: from, end: to }) => lines.slice(from, to).join('\n');
const blocksIn = (subsection) => {
  const found = [];
  let current = null;
  for (let index = subsection.start; index < subsection.end; index++) {
    const line = lines[index].trim();
    if (/^(?:```|~~~)/.test(line)) {
      if (current) { found.push(current.join('\n')); current = null; } else current = [];
      continue;
    }
    if (current) current.push(lines[index]);
  }
  return found;
};

const owned = new Map();
for (const platform of PLATFORMS) {
  const matching = subsections.filter((subsection) => platform.heading.test(subsection.title));
  check(`the section has a heading naming ${platform.name}`, matching.length > 0,
        `headings found: ${subsections.map((s) => s.title).join(' | ') || 'none'}`);
  if (!matching.length) continue;
  const subsection = matching[0];
  owned.set(platform.name, subsection);
  const blocks = blocksIn(subsection);
  check(`${platform.name}: a command block under its own heading`,
        blocks.some((block) => platform.command.test(block)), platform.wants);
}

// ─── 2. The PowerShell note is where PowerShell is ────────────

console.log('\n2. the note about $PID is inside the Windows subsection');

const NOTE = /\$PID|\$processId|automatic variable/;
const windows = owned.get('Windows');
if (windows) {
  const elsewhere = lines
    .slice(start, end)
    .filter((_, offset) => start + offset < windows.start || start + offset >= windows.end);
  check('the note is under the Windows heading', NOTE.test(bodyOf(windows)),
        'it is a fact about PowerShell, and it is what the block gets wrong when it is missing');
  check('and nowhere else in the section', !NOTE.test(elsewhere.join('\n')),
        'a PowerShell caveat above three platforms reads as advice to all three');
}

// ─── 3. The POSIX command does not fail loudly on a clean box ─

console.log('\n3. no block pipes lsof into a bare xargs kill');

const XARGS = /\|\s*xargs\s+(?!-r\b|--no-run-if-empty\b)/;
for (const subsection of subsections) {
  const offending = blocksIn(subsection).filter((block) => XARGS.test(block));
  check(`${subsection.title}: no unguarded xargs`, offending.length === 0,
        'with no listener lsof exits 1 with no output and GNU xargs runs kill with no arguments: '
        + 'usage on stderr, exit 123, from a step that had nothing to do');
}

// ─── 4. Every port a reader might type is marked ──────────────

console.log('\n4. every port literal in prose is marked as an example');

/**
 * A number that could be a port, and the two ways one is written.
 *
 * The number alone is not enough to know: this document also carries a year, a millisecond
 * default and a four-digit issue number, and a rule that read `April 2025` as a port would be
 * turned off rather than obeyed. So a candidate counts when the paragraph is talking about a
 * port, or when it is written in the one place a number can only be one — after the colon of
 * an authority, `127.0.0.1:3737`. 3000 is the trap and is never offered: see the banner.
 */
const CANDIDATE = /(?<![\w.#-])(?!3000(?![\d]))\d{4,5}(?![\w-])(?!\.\d)/g;
const ABOUT_PORTS = /\bports?\b/i;
const MARKERS = [
  /\bexamples?\b/i,
  /\be\.g\.\b/i,
  /\bdefaults?\b/i,
  /yours to pick|your own|whatever port|the port your board/i,
  /this machine|this board|this repository's own board/i,
];

/** Every paragraph of prose — a run of non-blank lines outside a fence and outside a table. */
function prosePorts(source) {
  const rows = classify(source);
  const offences = [];
  let paragraph = null;
  const settle = () => {
    if (!paragraph) return;
    const text = paragraph.lines.join('\n');
    // Emphasis is markup, not words: a reader sees "this board" where the source says
    // "*this* board", and the marker has to be read the way the reader reads it.
    const plain = text.replace(/[*_`]/g, '');
    const marked = MARKERS.some((marker) => marker.test(plain));
    for (const hit of text.matchAll(CANDIDATE)) {
      const isAuthority = text[hit.index - 1] === ':';
      if (!isAuthority && !ABOUT_PORTS.test(plain)) continue;
      if (marked) break;
      offences.push({ at: paragraph.at, port: hit[0], text: paragraph.lines[0] });
      break;
    }
    paragraph = null;
  };
  rows.forEach((row, index) => {
    if (row.fenced || row.generated || !row.raw.trim()) { settle(); return; }
    if (!paragraph) paragraph = { at: index + 1, lines: [] };
    paragraph.lines.push(row.raw);
  });
  settle();
  return offences;
}

// The fixtures come first. This rule is a regex over prose, and a regex over prose that has
// never been shown what it must not match is one false positive away from being deleted.
const FIXTURES = [
  ['a bare port stated as the value is caught', 1, 'The board listens on port 3737.\n'],
  ['the same port called the default is not', 0, 'The default is 3737, and `PORT` pins it.\n'],
  ['nor is one marked as an example', 0, 'The port below is an example: 3737.\n'],
  ['a marker one sentence earlier still counts', 0,
   'The port below is an example.\nPut yours in place of 3737.\n'],
  ['a marker in another paragraph does not', 1,
   'The port below is an example.\n\nThe board listens on port 3737.\n'],
  ['a port inside a fenced block is not prose', 0, '```bash\nkill $(lsof -ti tcp:3737)\n```\n'],
  ['port 3000 is the trap, not an offer', 0, 'The upstream README said port 3000.\n'],
  ['a generated table is not this file\'s to rewrite', 0,
   '<!-- generated: settings-table -->\n| `PORT` | `3737` | the port |\n<!-- /generated: settings-table -->\n'],
  ['a millisecond default is not a port', 0, 'The memo is 30000 ms by default.\n'],
  ['a year in a paragraph about anything else is not a port', 0,
   'Node 18 went end of life in April 2025, so the floor was raised.\n'],
  ['a bare authority is a port wherever it appears', 1, 'Open http://127.0.0.1:3737 and look.\n'],
  ['emphasis does not hide the marker', 0,
   'It is the port *this* board was started on — 3737 here.\n'],
];

for (const [name, expected, text] of FIXTURES) {
  const found = prosePorts(text);
  check(`the rule: ${name}`, found.length === expected,
        `${found.length} offence(s), expected ${expected}`);
}

const offences = prosePorts(doc);
check(`${DOC} marks every port literal it prints`, offences.length === 0,
      offences.map(({ at, port, text }) => `${DOC}:${at}: ${port} in "${text.slice(0, 72)}"`)
        .join('\n        '));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
