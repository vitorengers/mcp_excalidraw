#!/usr/bin/env node
/**
 * Checks that the numbers the documentation asserts are the numbers the code has.
 *
 * Three surfaces are counted in prose and on the board — the REST routes, the MCP tools and
 * the CLI commands — and one of them had been wrong for fifty merges. `docs/rest-api.md` and
 * the structure map both said `src/server.ts · 27 routes` while `src/server.ts` had 50, and
 * the repository already knew: `docs/development-log.md` records "the structure map still
 * says 27 routes, and there are 48". It was noted rather than fixed, because nothing failed
 * on it. A count is the one claim in a document that can be checked mechanically, so it is.
 *
 * Two rules, both derived from `src/` rather than from a list kept here:
 *
 *  1. every `N routes` / `N tools` / `N commands` claim in the scanned files is the real N;
 *  2. every route, tool and command is named in the document that catalogues it — a count
 *     that matches while twenty routes are missing from the table is a count that lies.
 *
 * `docs/development-log.md` is exempt. It is the dated record of what was decided, one entry
 * per merged pull request, and an entry saying "there are 48" was true on the day it was
 * written. Rewriting history to keep a check green is the wrong direction.
 *
 * Offline and self-contained; it reads sources, not a running server.
 *
 * Usage: node scripts/check-docs-counts.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The log is the record of what was true then, so its numbers are allowed to be old. */
const EXEMPT = new Set(['docs/development-log.md']);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

// ─── What the code actually has ───────────────────────────────

/** Every Express route, as `METHOD /path` — the form a document can spell out verbatim. */
function routesOf(source) {
  return [...source.matchAll(/^\s*app\.(get|post|put|delete|patch)\(\s*'([^']+)'/gm)]
    .map(([, method, path]) => `${method.toUpperCase()} ${path}`);
}

/** The MCP tool names, from the one array `ListTools` answers with. */
function toolsOf(source) {
  const start = source.indexOf('const tools: Tool[] = [');
  if (start < 0) return [];
  const body = source.slice(start, source.indexOf('\n];', start));
  return [...body.matchAll(/^\s{4}name: '([a-z_]+)',/gm)].map(([, name]) => name);
}

/** The CLI subcommands, from the one record the dispatcher and `help` both read. */
function commandsOf(source) {
  const start = source.indexOf('const COMMANDS: Record<string, Command> = {');
  if (start < 0) return [];
  const body = source.slice(start, source.indexOf('\n};', start));
  return [...body.matchAll(/^\s{2}'?([a-z][a-z-]*)'?: \{ handler:/gm)].map(([, name]) => name);
}

const routes = routesOf(read('src/server.ts'));
const tools = toolsOf(read('src/index.ts'));
const commands = commandsOf(read('src/cli/run.ts'));

console.log('1. the sources were read, so the numbers below mean something');
check('src/server.ts declares routes', routes.length > 0);
check('src/index.ts declares MCP tools', tools.length > 0);
check('src/cli/run.ts declares CLI commands', commands.length > 0);
if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log(`        ${routes.length} routes · ${tools.length} tools · ${commands.length} commands`);

// ─── 2. Every count claimed anywhere is the real one ──────────

console.log('\n2. every count asserted in the documentation matches the code');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((file) => file.split('\\').join(posix.sep));

/** Markdown, plus the board — its cards carry the same claims, in `text` and `originalText`. */
const scanned = tracked.filter((file) =>
  !EXEMPT.has(file) && (file.endsWith('.md') || file.endsWith('.excalidraw')));

const SUBJECTS = [
  { word: 'routes', actual: routes.length },
  { word: 'tools', actual: tools.length },
  { word: 'commands', actual: commands.length },
];

/**
 * The spelled-out forms, because prose does not use digits.
 *
 * The count claims this repository actually drifted on were every one of them a word — "all
 * fifteen", "all nineteen are optional", "Eighteen `EXCALIDRAW_*` variables" — and a pattern
 * matching `\d+` saw none of them. Up to thirty, which is well past any of the three surfaces
 * and past the point where prose stops spelling a number out.
 */
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty',
];

/** `twenty-six` as 26, `48` as 48, and `null` for a word this does not spell. */
function valueOf(claimed) {
  if (/^\d+$/.test(claimed)) return Number(claimed);
  const [tens, units] = claimed.toLowerCase().split('-');
  const base = NUMBER_WORDS.indexOf(tens);
  if (base < 0) return null;
  const scale = tens === 'thirty' ? 30 : base;
  if (!units) return scale;
  const extra = NUMBER_WORDS.indexOf(units);
  return extra > 0 && extra < 10 ? scale + extra : null;
}

const SPELLED = `(?:twenty|thirty)-(?:${NUMBER_WORDS.slice(1, 10).join('|')})|${NUMBER_WORDS.join('|')}`;

/**
 * A spelled-out number is only a claim about this codebase when something quantifies it.
 *
 * `all twenty-six tools` is; `the model gets two tools` is not, and neither is "two tools of a
 * kind drawn alike" in `docs/terminal.md`, which is about ANSI colour. Digits keep the broader
 * pattern they have always had — nobody writes `the model gets 2 tools` — but small numbers
 * spelled out are ordinary English and matching them bare would red the check on prose that
 * counts something else entirely. So a word needs `all` in front of it, or `MCP`/`CLI` behind:
 * both of the forms this repository actually drifted in.
 */
function claimPatterns(word) {
  return [
    new RegExp(`\\b(\\d+)(?:\\s+(?:MCP|CLI))?\\s+${word}\\b`, 'gi'),
    new RegExp(`\\ball\\s+(?:of\\s+the\\s+)?(${SPELLED})(?:\\s+(?:MCP|CLI))?\\s+${word}\\b`, 'gi'),
    new RegExp(`\\b(${SPELLED})\\s+(?:MCP|CLI)\\s+${word}\\b`, 'gi'),
  ];
}

const wrong = [];
for (const file of scanned) {
  const text = read(file);
  for (const { word, actual } of SUBJECTS) {
    for (const claim of claimPatterns(word)) {
      for (const [whole, number] of text.matchAll(claim)) {
        const claimed = valueOf(number);
        if (claimed !== null && claimed !== actual) {
          wrong.push(`${file}: "${whole}" (there are ${actual})`);
        }
      }
    }
  }
}
check('no document or card asserts a count the code does not have', wrong.length === 0,
      `\n        ${[...new Set(wrong)].join('\n        ')}`);

// ─── 3. Every member is named where it is catalogued ──────────

console.log('\n3. the catalogue behind each count is complete');

const restApi = read('docs/rest-api.md');
const missingRoutes = routes.filter((route) => !restApi.includes(`\`${route}\``));
check('every route in src/server.ts appears in docs/rest-api.md', missingRoutes.length === 0,
      `${missingRoutes.length} missing: ${missingRoutes.join(', ')}`);

const mcpDoc = read('docs/mcp-server.md');
const missingTools = tools.filter((tool) => !mcpDoc.includes(`\`${tool}\``));
check('every MCP tool appears in docs/mcp-server.md', missingTools.length === 0,
      `${missingTools.length} missing: ${missingTools.join(', ')}`);

const cliDoc = read('docs/cli.md');
const missingCommands = commands.filter((command) => !cliDoc.includes(`\`${command}\``));
check('every CLI command appears in docs/cli.md', missingCommands.length === 0,
      `${missingCommands.length} missing: ${missingCommands.join(', ')}`);

// The structure map is the other place a reader is told what each file is, and it is the
// place that went stale. It names the file, so it has to name the right number beside it.
const board = read('docs/board.excalidraw');
const mapped = [
  ['src/server.ts', routes.length, 'routes'],
  ['src/index.ts', tools.length, 'tools'],
  ['src/bin.ts', commands.length, 'commands'],
];
for (const [file, actual, word] of mapped) {
  check(`the structure map says ${actual} ${word} beside ${file}`,
        board.includes(`${file} · ${actual} ${word}`)
        || new RegExp(`${file.replace(/[./]/g, '\\$&')}[^"]*?${actual} ${word}`).test(board),
        `no card on the board pairs ${file} with ${actual} ${word}`);
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
