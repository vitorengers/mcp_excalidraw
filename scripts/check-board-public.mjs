#!/usr/bin/env node
/**
 * Checks that the board describes the product rather than the machine it grew on.
 *
 * `docs/board.excalidraw` is this tool's own map, and it is the first thing a stranger opens
 * after the README. It was written by, and about, one developer's laptop. The subtitle called
 * the repository "a private fork of yctimlin/mcp_excalidraw" — the upstream product's name, and
 * a word that stopped being true the day the release was planned. The "Start the board" card
 * said `node dist/server.js on PORT=3737` and counted the `EXCALIDRAW_*` variables, so a reader
 * on a machine where 3737 is taken was told to do something that would not work, and the count
 * went stale the first time anybody added a setting. A trap card explained a Windows portproxy
 * bug and concluded "Hence 3737." — one machine's defect, presented as the tool's port.
 *
 * `check-board-map.mjs` asks whether the map is still *there*: two sections, every document with
 * a card, every merge in the log. This asks the other question — whether what the map says is
 * true of anybody but the person who drew it. The two are deliberately separate: a board can be
 * perfectly complete and still be a set of notes about one laptop.
 *
 * So:
 *
 *  1. no card pins the tool to one machine's port — `PORT=3737` is an instruction that fails on
 *     a machine where 3737 is taken, and "Hence 3737" makes a local bug into the product;
 *  2. no card calls this repository a private fork, of anything;
 *  3. no card names the product by the name it no longer has;
 *  4. no card counts the `EXCALIDRAW_*` variables — the count is generated from
 *     `src/core/settings.ts` for exactly this reason, and a number written onto a shape is a
 *     copy that goes stale silently (`check-settings-documented.mjs` holds the prose to the
 *     same rule);
 *  5. and the board carries at least one *functional* block, with something written in it. A
 *     board of 27 documentation cards and nothing to press is a diagram of the tool rather than
 *     the tool. The mirror and the terminal cannot be it: both are derived, and
 *     `scripts/export-board.mjs` strips them out of every export on purpose, so an `issue`
 *     block is the only one a tracked board can carry.
 *
 * Offline: it reads the board file and nothing else. The shape it seeds still has to be looked
 * at in a browser once — a block that renders wrong parses perfectly.
 *
 * Usage: node scripts/check-board-public.mjs
 *
 * Tier: fast
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * The names this product has answered to that are not its name.
 *
 * `mcp_excalidraw` is the upstream repository and was this fork's directory name;
 * `mcp-excalidraw-server` is the package upstream publishes. Either one on the board reads as
 * what the reader is holding.
 */
const OLD_NAME = /mcp[_-]excalidraw/i;

/**
 * A card pinning the tool to a port.
 *
 * Three shapes, and the anchoring matters in each. `PORT=3737` is an instruction; `:3000` in
 * `0.0.0.0:3000 to localhost:3000` is a *description of a bug on one machine*, which the
 * Development section is entirely for and which this must not catch. So an offence is an
 * assignment (`PORT=`, and the prefixed spellings of it), or a sentence concluding that the
 * board runs on a number — "Hence 3737", "on port 3737", "defaults to 3737".
 */
const PORT_CLAIMS = [
  /\b[A-Z_]*PORT\s*=\s*\d+/,
  /\bhence\s+\d{4,5}\b/i,
  /\bon\s+port\s+\d{4,5}\b/i,
  /\bdefaults?\s+to\s+\d{4,5}\b/i,
];

const PRIVATE_FORK = /\bprivate\s+fork\b/i;

/**
 * A count of the settings family, written onto a shape.
 *
 * Same shape as the rule `check-settings-documented.mjs` holds the prose to: a number, then a
 * short run of words, then the family. Short, because "eight per board" forty characters away
 * from the word `EXCALIDRAW_*` is a sentence about something else.
 */
const SPELLED = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen'
  + '|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty';
const VARIABLE_COUNT =
  new RegExp(`\\b(?:\\d+|${SPELLED})\\b[A-Za-z ,;:\\-\`*]{0,40}(?:EXCALIDRAW|VIBEMAXXING)_\\*`, 'i');

const RULES = [
  ['pins the tool to one machine\'s port', (text) => PORT_CLAIMS.some((rule) => rule.test(text))],
  ['calls the repository a private fork', (text) => PRIVATE_FORK.test(text)],
  ['names the product by its old name', (text) => OLD_NAME.test(text)],
  ['counts the EXCALIDRAW_* variables', (text) => VARIABLE_COUNT.test(text)],
];

/** The kinds a tracked board can carry. The other two are derived and never survive an export. */
const FUNCTIONAL_KINDS = ['issue'];
const DERIVED_KINDS = ['project-board', 'terminal'];

/** What a shape says: the label as typed, before Excalidraw wrapped it. */
const textOf = (element) => element?.originalText ?? element?.text ?? '';

/**
 * What a reader would call the shape an offending string is on.
 *
 * A card here is a title, a body and usually a box, and the string that breaks a rule is nearly
 * always in the body — reporting `ms151running00003` names nothing anybody can find on a canvas.
 * The title is the largest text directly above it in the same column, which is how every card on
 * this board is drawn.
 */
function cardName(element, elements) {
  const container = elements.find((other) => other.id === element.containerId);
  if (container) {
    const kind = container.customData?.kind ?? container.customData?.docKey;
    if (kind) return `the "${kind}" block`;
  }
  const title = elements
    .filter((other) => other.type === 'text' && other !== element)
    .filter((other) => (other.fontSize ?? 0) > (element.fontSize ?? 0))
    .filter((other) => Math.abs(other.x - element.x) < 40)
    .filter((other) => other.y < element.y && element.y - other.y < 120)
    .sort((a, b) => b.y - a.y)[0];
  return title ? `the "${textOf(title).split('\n')[0]}" card` : `element ${element.id}`;
}

/** Every rule an element's text breaks. */
function offences(element, elements) {
  const text = textOf(element);
  if (!text) return [];
  return RULES
    .filter(([, breaks]) => breaks(text))
    .map(([rule]) => ({ rule, where: cardName(element, elements), id: element.id }));
}

// ─── 0. The rules, shown what they must and must not catch ────

// This is a set of regular expressions over prose that a person will keep editing, and a rule
// that has never been shown what it must *not* match is one false positive from being deleted.
console.log('0. the rules catch the four strings and nothing near them');

const fixture = (text, extra = {}) => ({ id: 'fixture', type: 'text', x: 0, y: 0, text, ...extra });
const broken = (text) => offences(fixture(text), []).map(({ rule }) => rule);

const FIXTURES = [
  ['`PORT=3737` in an instruction is caught', 1, 'npm run build, then node dist/server.js on PORT=3737.'],
  ['so is a prefixed spelling of it', 1, 'Set EXCALIDRAW_CANVAS_PORT=3737 before starting.'],
  ['"Hence 3737" is caught', 1, 'iphlpsvc answers and the connection dies in the loop. Hence 3737.'],
  ['so is "defaults to 3737"', 1, 'The canvas defaults to 3737 and scans upward.'],
  ['a bug described at a port is not a claim about the tool', 0,
   'A Windows portproxy rule maps 0.0.0.0:3000 to localhost:3000 — itself.'],
  ['nor is the port named as a thing you choose', 0,
   'Start it on the port you like; docs/running.md has the invocation.'],
  ['"private fork" is caught', 1, 'A private fork of somebody else\'s project.'],
  ['an ordinary fork is not this rule\'s business', 0, 'A fork of an upstream project.'],
  ['the old repository name is caught', 1, 'agents drive over an API · a fork of yctimlin/mcp_excalidraw'],
  ['so is the package upstream publishes', 1, 'Installs as mcp-excalidraw-server.'],
  ['the word Excalidraw on its own is not', 0, 'MCP server + Excalidraw canvas agents drive over an API.'],
  ['a spelled-out count of the variables is caught', 1, 'Eighteen EXCALIDRAW_* variables, all optional.'],
  ['a digit count is caught too', 1, '26 EXCALIDRAW_* variables are read at startup.'],
  ['saying every one of them is optional counts nothing', 0,
   'Every EXCALIDRAW_* variable is optional and github.com is required.'],
  ['a number a sentence away from the family is not a count', 0,
   'Up to eight shells per board. Its tables are generated from src/core/settings.ts, '
   + 'one row per variable.'],
  ['but a number beside the family is one, whatever it was counting', 1,
   'Up to eight shells per board, and every EXCALIDRAW_* variable is optional.'],
];

for (const [name, expected, text] of FIXTURES) {
  const found = broken(text);
  check(`the rules: ${name}`, found.length === expected,
        `${found.length} rule(s) broken (${found.join('; ') || 'none'}), expected ${expected}`);
}

// ─── The board itself ─────────────────────────────────────────

const config = JSON.parse(read('board.config.json'));
const scene = JSON.parse(readFileSync(resolve(repoRoot, config.board), 'utf8'));
const elements = (scene.elements ?? []).filter((element) => !element.isDeleted);

console.log(`\n1. no card on ${config.board} is about one machine`);

const found = elements.flatMap((element) => offences(element, elements));
for (const [rule] of RULES) {
  const hits = found.filter((offence) => offence.rule === rule);
  check(`no card ${rule}`, hits.length === 0,
        hits.map(({ where, id }) => `${where} (${id})`).join('\n        '));
}

console.log('\n2. the board carries something a reader can press');

const kindOf = (element) => element.customData?.kind;
const functional = elements.filter((element) => FUNCTIONAL_KINDS.includes(kindOf(element)));
check(`at least one functional block (${FUNCTIONAL_KINDS.join(', ')})`, functional.length > 0,
      'a board of documentation cards is a diagram of the tool, not the tool — seed one');

// A block whose label is the placeholder Excalidraw gives an empty container is a box with
// nothing in it, and a reader is being invited to press it.
const labelled = functional.filter((block) => {
  const bound = (block.boundElements ?? []).filter((binding) => binding.type === 'text');
  return bound.some((binding) => {
    const label = elements.find((element) => element.id === binding.id);
    return textOf(label).trim().length > 0;
  });
});
check('and it says what to write in it', functional.length === 0 || labelled.length > 0,
      'the block carries no bound text, so it renders as an empty box');

// The derived blocks are the mirror and the terminal, and neither is this board's to save: one
// is redrawn from GitHub on every read, the other exists for as long as a shell does.
const derived = elements.filter((element) => DERIVED_KINDS.includes(kindOf(element)));
check('and no derived block was exported into the file', derived.length === 0,
      derived.map((element) => `${kindOf(element)} (${element.id})`).join(', '));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
