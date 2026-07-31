#!/usr/bin/env node
/**
 * Checks that every setting is declared once, and that the documentation is that declaration.
 *
 * The variable count had drifted three ways at the same time. `docs/running.md` said "all
 * nineteen are optional" above a table of twenty rows; `README.md` and `docs/index.md` said
 * "all fifteen"; the card on the board said "Eighteen". None of them was right, and none of
 * them could be — a number typed into prose has nothing holding it to the list it describes.
 * Three variables the server reads were meanwhile in no table anywhere: `LOG_LEVEL`,
 * `LOG_FILE_PATH` and `DEBUG`. `LOG_FILE_PATH` cost the most, because the console transport is
 * warn-and-above, so every `logger.info` the server writes goes to a file nothing named.
 *
 * So `src/core/settings.ts` carries the name, the default and the whole table cell for each
 * one, `scripts/generate-settings-docs.mjs` writes `docs/running.md` from that, and the four
 * rules below hold it there:
 *
 *  1. **nothing reads a prefixed variable off `process.env` but the declaration.** A read
 *     somewhere else is a setting with no row and no default, which is how the list drifted
 *     from the documentation in the first place. An *assignment* is allowed and is not the same
 *     thing: `src/bin.ts` turns `--no-open` into a variable so that one code path downstream
 *     reads it, which is a flag reaching the environment rather than a second declaration.
 *  2. **the tables are byte-identical to what the generator produces.** Not "every name has a
 *     row" — that passes while a default says `3737` and the code says something else.
 *  3. **no tracked document states a count of the variables.** Word or digit: the three that
 *     disagreed were spelled out, which is exactly why `check-docs-counts.mjs` never saw them.
 *     `docs/development-log.md` is exempt, as it is everywhere else — it records what was true
 *     on the day, and rewriting that to keep a check green is the wrong direction.
 *  4. **every `process.env` name the tool reads is declared or is one it does not own.** The
 *     allowlist below is the second half of that sentence, and it is short on purpose: a new
 *     `process.env.SOMETHING` in `src/` is red until it is either declared or named there.
 *
 * `EXCALIDRAW_ASSET_PATH` and `EXCALIDRAW_ELEMENT_TYPES` match the prefix and are not settings —
 * one is Excalidraw's own browser global and the other a TypeScript constant. Section 4 asserts
 * they stayed out, because a derivation that keyed on the prefix rather than on `process.env.`
 * would have swept both in and demanded rows for them.
 *
 * Offline and self-contained: it reads tracked files and the compiled declaration, starts no
 * server, spawns no agent and opens no browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-settings-documented.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findRegion, loadSettings, renderRegions, settingsModulePath
} from './lib/settings-tables.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The record of what was true then. Its numbers are allowed to be old — see the banner. */
const EXEMPT = new Set(['docs/development-log.md']);

/** The one file allowed to read a prefixed variable off `process.env`. */
const DECLARATION = 'src/core/settings.ts';

/**
 * Names the tool reads and does not own, so they carry no row of their own here.
 *
 * Two kinds. The platform's — `PATH`, `SHELL`, the two directory conventions, the two colour
 * conventions — which are the machine's answer and not this tool's setting. And the transport's:
 * `PORT`, `HOST`, the canvas-URL variable and `ENABLE_CANVAS_SYNC` are per-invocation, `PORT` is
 * a pin the launch path never scans past, and all four are documented in the README beside the
 * MCP client configuration that sets them.
 *
 * The canvas-URL one is assembled rather than spelled: `check-no-external-server.mjs` bans that
 * string from every check, because a check must never take its target from a variable somebody
 * exported months ago, and a ban that a mention can defeat is not a ban.
 */
const CANVAS_URL_VARIABLE = ['EXPRESS', 'SERVER', 'URL'].join('_');

const NOT_OURS = new Set([
  'PATH', 'PATHEXT', 'SHELL', 'HOME', 'LOCALAPPDATA', 'XDG_STATE_HOME', 'APPDATA', 'TMPDIR',
  'NO_COLOR', 'NODE_DISABLE_COLORS', 'NODE_ENV',
  'PORT', 'HOST', CANVAS_URL_VARIABLE, 'ENABLE_CANVAS_SYNC',
]);

/** English for a count. Prose says "nineteen", never `19`, which is how three of them hid. */
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty', 'forty', 'fifty',
];

/**
 * What a count claim looks like when it is about *the set* rather than about two named things.
 *
 * The anchor is `EXCALIDRAW_*` or `VIBEMAXXING_*` with the asterisk — the whole family — or one
 * of the phrases the prose used to introduce a table with. `docs/running.md` says "the two
 * variables are separate ones" about one deliberate pair, and that is a sentence about those
 * two, not a count of the family; it carries no asterisk and is left alone.
 */
const ANCHORS = [
  '`?(?:EXCALIDRAW|VIBEMAXXING)_\\*`?',
  'below (?:mean|are|is)\\b',
  'more are\\b',
  'variables? (?:below|above)\\b',
];

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((file) => file.split('\\').join(posix.sep));

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

/** `file:line` for every line of `files` the pattern matches, with the text that matched. */
function scan(files, pattern) {
  const found = [];
  for (const file of files) {
    read(file).split(/\r?\n/).forEach((line, index) => {
      for (const [whole] of line.matchAll(pattern)) {
        found.push(`${file}:${index + 1}  ${whole.trim()}`);
      }
    });
  }
  return found;
}

// ─── 1. The declaration is the only place a prefixed variable is read ───

console.log('1. nothing but the declaration reads a prefixed variable off process.env');

const sources = tracked.filter((file) =>
  (file.startsWith('src/') || file.startsWith('frontend/')) && file !== DECLARATION
  && /\.(ts|tsx|js|jsx|mjs|cjs|html)$/.test(file));

// A read, not a write: `process.env.X = …` is a flag reaching the environment. `==`/`===` are
// comparisons and stay reads, so the negative lookahead has to spare them.
const READ = /process\.env\.(?:EXCALIDRAW|VIBEMAXXING)_[A-Z0-9_]+\b(?!\s*=[^=])/g;
const strays = scan(sources, READ);
check(`only ${DECLARATION} reads one`, strays.length === 0,
      `\n        ${strays.join('\n        ')}`
      + `\n        (call env('NAME') from ${DECLARATION} instead, and declare it there)`);

// ─── 2. The tables are what the declaration produces ────────────────────

console.log('\n2. docs/running.md carries the tables the declaration generates');

const settings = await loadSettings(repoRoot);
if (!settings) {
  console.error(`  FAIL  ${settingsModulePath(repoRoot)} is not built`);
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
console.log(`        ${settings.length} settings declared`);

const running = read('docs/running.md');
for (const { id, text } of renderRegions(settings)) {
  const region = findRegion(running, id);
  if (!region) {
    check(`docs/running.md carries the "${id}" region`, false,
          'the table is hand-written; regenerate it with node scripts/generate-settings-docs.mjs');
    continue;
  }
  const tracked_ = running.slice(region.start, region.end);
  check(`"${id}" is byte-identical to what src/core/settings.ts produces`, tracked_ === text,
        'run: node scripts/generate-settings-docs.mjs');
}

const rows = [...running.matchAll(/^\|\s*`([A-Z0-9_]+)`/gm)].map((match) => match[1]);
const unrowed = settings.filter((setting) => !rows.includes(setting.variable));
check('every declared variable has a row', unrowed.length === 0,
      unrowed.map((setting) => setting.variable).join(', '));

for (const name of ['LOG_LEVEL', 'LOG_FILE_PATH', 'DEBUG']) {
  check(`${name} is one of them`, rows.includes(name),
        'the server reads it and nothing documented it');
}

// ─── 3. No document states a count of them ──────────────────────────────

console.log('\n3. no tracked document states a count of the variables');

const documents = tracked.filter((file) =>
  !EXEMPT.has(file) && (file.endsWith('.md') || file.endsWith('.excalidraw')));

const numeral = `(?:\\d+|${NUMBER_WORDS.join('|')})`;
// The gap spans words, backticks and an escaped newline — the board card's count and the noun
// it counts are on two lines of one JSON string — and stops at a pipe or a full stop, which is
// where one table row or one sentence ends and the next begins.
const gap = '(?:[A-Za-z ,;:\\-`*]|\\\\n){0,40}';
const claims = scan(documents,
                    new RegExp(`\\b${numeral}\\b${gap}(?:${ANCHORS.join('|')})`, 'gi'));
check('no count of the variable set is asserted anywhere', claims.length === 0,
      `\n        ${claims.join('\n        ')}`
      + '\n        (name docs/running.md, not a number — a number nothing derives goes stale)');

// ─── 4. Every name the tool reads is declared, or is not its own ────────

console.log('\n4. every process.env name src/ reads is declared or is one this tool does not own');

const declared = new Set(settings.map((setting) => setting.variable));
const namesRead = new Set();
for (const file of tracked.filter((f) => f.startsWith('src/') && /\.(ts|tsx)$/.test(f))) {
  for (const [, name] of read(file).matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    namesRead.add(name);
  }
}

const undocumented = [...namesRead]
  .filter((name) => !NOT_OURS.has(name))
  .filter((name) => !declared.has(name))
  // The prefixed ones are section 1's business: an undeclared one is already a failure there,
  // and reporting it twice would say the fix is a table row when it is a call to `env()`.
  .filter((name) => !/^(?:EXCALIDRAW|VIBEMAXXING)_/.test(name));
check('nothing is read that no table describes', undocumented.length === 0,
      `${undocumented.join(', ')} — declare it in ${DECLARATION} or name it in NOT_OURS here`);

// The derivation keys on `process.env.`, so a constant and a browser global that happen to carry
// the prefix stay out. Both are still in the tree, so this is an assertion rather than a wish.
const prefixedButNot = ['EXCALIDRAW_ASSET_PATH', 'EXCALIDRAW_ELEMENT_TYPES'];
for (const name of prefixedButNot) {
  const present = tracked.some((file) =>
    (file.startsWith('src/') || file.startsWith('frontend/'))
    && /\.(ts|tsx|js|jsx|html)$/.test(file) && read(file).includes(name));
  check(`${name} is still in the tree`, present, 'the case below would pass for the wrong reason');
  check(`and is not a setting`, !declared.has(name) && !namesRead.has(name),
        'it matches the prefix but is not read from the environment');
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
