#!/usr/bin/env node
/**
 * The founder column is named per project, and a project may not point it at the queue's own.
 *
 * Column identity in this codebase is a case-insensitive name plus the `board.config.json`
 * key that would fix it — the `ColumnTarget` shape. A founder column follows that pattern
 * or it is the constant `project-board.ts` was built to avoid, so this check covers the
 * resolver, the setting's route through the config loader and the config validator, and the
 * one misconfiguration that would undo the whole arrangement.
 *
 * Three things, and the third is the load-bearing one:
 *
 *  1. **`founderColumn(workspace)` is a `ColumnTarget`** like `todoColumn` and
 *     `inProgressColumn`: `Founder Actions` unset, the configured name when set, and always
 *     `projectFounderColumn` as the key that would fix a column the project does not have.
 *     `scripts/check-founder-not-startable.mjs` declares that name locally rather than
 *     importing it, so that fence does not depend on this column having landed; asserting
 *     the two agree is this check's job, and it is done by reading the literal out of that
 *     file.
 *  2. **The setting round-trips.** A `board.config.json` carrying `projectFounderColumn`
 *     loads as that string, and `validateWorkspaceConfigPatch` accepts it by name — while
 *     still refusing a genuinely unknown key by name, which is the positive control that
 *     stops "accepts everything" from reading as a pass.
 *  3. **A colliding configuration is refused, by both readers.** The queue drains exactly
 *     one column, resolved by name at dispatch time, and `findColumn` matches
 *     `trim().toLowerCase()`. That makes a distinctly named founder column invisible to the
 *     start loop by construction — but only while the two names differ. So a
 *     `projectFounderColumn` equal to `projectTodoColumn` or to `projectInProgressColumn`
 *     is refused by `loadWorkspace` and by `validateWorkspaceConfigPatch`, with a message
 *     naming **both** keys, and neither case nor surrounding whitespace evades it. The
 *     refusal fires against the *default* too, so a project that never wrote
 *     `projectTodoColumn` cannot reach the same collision by naming its founder column
 *     `Todo`.
 *
 * And `findColumn` never resolves the founder name to the `No Status` section, whatever that
 * section happens to be called — asserted against a board whose unstatused section carries
 * the founder column's own name.
 *
 * Nothing here is allowed to be vacuously green: every refusal section carries a
 * configuration that must load *healthy*, and every acceptance carries one that must be
 * refused.
 *
 * Pure apart from one temporary directory for the registry fixtures: no server, no Chrome,
 * no network. It imports `dist/core/project-board.js` and `dist/core/workspaces.js`, so run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-column-setting.mjs
 *
 * Tier: fast
 */

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const board = await import(new URL('../dist/core/project-board.js', import.meta.url).href);
const workspaces = await import(new URL('../dist/core/workspaces.js', import.meta.url).href);

const {
  DEFAULT_FOUNDER_COLUMN,
  DEFAULT_TODO_COLUMN,
  DEFAULT_IN_PROGRESS_COLUMN,
  founderColumn,
  todoColumn,
  inProgressColumn,
  findColumn,
  NO_STATUS_OPTION_ID,
  NO_STATUS_NAME,
} = board;
const { loadWorkspaces, validateWorkspaceConfigPatch } = workspaces;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * Run one assertion whose *subject* may not exist yet.
 *
 * Against a tree where `founderColumn` has not landed, calling it throws a `TypeError` —
 * which would end the run at the first case and leave every later section unevidenced. A
 * throw is recorded as the failure it is, and the check goes on.
 */
function checking(name, produce, detail = () => '') {
  let value;
  try {
    value = produce();
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${name} — threw: ${error.message}`);
    return;
  }
  check(name, value === true, detail());
}

// ─── The fixtures ─────────────────────────────────────────────

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'founder-column-'));

/** One project on disk with the given config, loaded through the real registry reader. */
let projectCount = 0;
async function load(config) {
  const dir = path.join(tmp, `project-${++projectCount}`);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'board.config.json'), JSON.stringify(config, null, 2));
  const registryPath = path.join(dir, 'workspaces.json');
  await fs.writeFile(registryPath, JSON.stringify({ workspaces: [{ id: `p${projectCount}`, path: dir }] }));
  const [loaded] = await loadWorkspaces(registryPath);
  return loaded;
}

/**
 * A collision refusal, rather than any refusal that happens to mention the same words.
 *
 * Both keys **quoted**, and the colliding name quoted beside them. Written loosely — the
 * bare substrings — this passed against the old tree for the wrong reason: there
 * `projectFounderColumn` is an unknown key, and that refusal names the offending key and
 * then lists every known setting, `projectTodoColumn` among them. The quotes are what
 * separates "this is the column you already named" from "I have never heard of this key".
 */
const refusesCollision = (message, other, value) =>
  typeof message === 'string'
  && message.includes('"projectFounderColumn"')
  && message.includes(`"${other}"`)
  && message.includes(`"${String(value).trim()}"`);

/**
 * The one collision table, run through both readers.
 *
 * Every row is the same collision written differently — case flipped, whitespace added — so
 * a refusal that compared the raw strings would pass the first row and fail the rest.
 */
const SPELLINGS = [
  { label: 'exactly as configured', spell: (name) => name },
  { label: 'in lower case', spell: (name) => name.toLowerCase() },
  { label: 'in upper case', spell: (name) => name.toUpperCase() },
  { label: 'with leading space', spell: (name) => `   ${name}` },
  { label: 'with trailing space', spell: (name) => `${name}   ` },
  { label: 'padded and in mixed case', spell: (name) => `  ${name.toUpperCase()}  ` },
];

async function main() {
  // ─── 1. The resolver ────────────────────────────────────────

  console.log('1. founderColumn is a ColumnTarget beside the other two');

  checking(
    `the default is "Founder Actions"`,
    () => DEFAULT_FOUNDER_COLUMN === 'Founder Actions',
    () => `got ${JSON.stringify(DEFAULT_FOUNDER_COLUMN)}`
  );
  checking(
    'unset resolves to the default, keyed by projectFounderColumn',
    () => {
      const target = founderColumn({ projectFounderColumn: null });
      return target.name === 'Founder Actions' && target.setting === 'projectFounderColumn';
    },
    () => JSON.stringify(founderColumn({ projectFounderColumn: null }))
  );
  checking(
    'a configured name is returned, still keyed by projectFounderColumn',
    () => {
      const target = founderColumn({ projectFounderColumn: 'By Hand' });
      return target.name === 'By Hand' && target.setting === 'projectFounderColumn';
    },
    () => JSON.stringify(founderColumn({ projectFounderColumn: 'By Hand' }))
  );
  // The positive control: the two that already existed still answer, so a section that went
  // green because every resolver returned the same thing would be caught here.
  checking(
    'the queue column is untouched beside it',
    () => {
      const queue = todoColumn({ projectTodoColumn: null });
      const doing = inProgressColumn({ projectInProgressColumn: null });
      return queue.name === DEFAULT_TODO_COLUMN && queue.setting === 'projectTodoColumn'
        && doing.name === DEFAULT_IN_PROGRESS_COLUMN && doing.setting === 'projectInProgressColumn';
    }
  );
  checking(
    'the founder column is not one of the queue columns',
    () => DEFAULT_FOUNDER_COLUMN.toLowerCase() !== DEFAULT_TODO_COLUMN.toLowerCase()
      && DEFAULT_FOUNDER_COLUMN.toLowerCase() !== DEFAULT_IN_PROGRESS_COLUMN.toLowerCase()
  );

  // `check-founder-not-startable.mjs` declares this name locally on purpose, so that fence
  // stands without this column having landed. The agreement between the two is asserted
  // here, which is where the constant actually lives.
  const fence = readFileSync(join(repoRoot, 'scripts', 'check-founder-not-startable.mjs'), 'utf8');
  const declared = /SHIPPED_NAMES\s*=\s*\{[^}]*\bfounder:\s*'([^']+)'/.exec(fence)?.[1] ?? null;
  check(
    'the fence check declares the same name locally',
    declared !== null && declared === DEFAULT_FOUNDER_COLUMN,
    `check-founder-not-startable.mjs says ${JSON.stringify(declared)}`
  );

  // ─── 2. The setting round-trips ─────────────────────────────

  console.log('\n2. projectFounderColumn is a project setting like the other two');

  const named = await load({ name: 'Named', projectFounderColumn: 'By Hand' });
  check(
    'a configured founder column loads as that string',
    named?.projectFounderColumn === 'By Hand',
    `got ${JSON.stringify(named?.projectFounderColumn)}`
  );
  check('and the project is healthy', named?.error === null, String(named?.error));

  const padded = await load({ name: 'Padded', projectFounderColumn: '   By Hand   ' });
  check(
    'surrounding whitespace is trimmed off, as the other two are',
    padded?.projectFounderColumn === 'By Hand',
    `got ${JSON.stringify(padded?.projectFounderColumn)}`
  );

  const silent = await load({ name: 'Silent' });
  check(
    'a project that names none loads as null',
    silent?.projectFounderColumn === null,
    `got ${JSON.stringify(silent?.projectFounderColumn)}`
  );
  checking(
    'and resolves to the default through founderColumn',
    () => founderColumn(silent).name === DEFAULT_FOUNDER_COLUMN
  );

  const accepted = validateWorkspaceConfigPatch({ projectFounderColumn: 'By Hand' });
  check(
    'the validator accepts it by name rather than refusing it as unknown',
    accepted?.ok === true,
    accepted?.error
  );
  const cleared = validateWorkspaceConfigPatch({ projectFounderColumn: null });
  check('null clears it, like every other string field', cleared?.ok === true, cleared?.error);
  const mistyped = validateWorkspaceConfigPatch({ projectFounderColumn: 7 });
  check(
    'a number is refused as text, like every other string field',
    mistyped?.ok === false && mistyped.error.includes('projectFounderColumn'),
    JSON.stringify(mistyped)
  );

  // The positive control on the whole `known` set: widening it must not have opened it.
  const typo = validateWorkspaceConfigPatch({ projectFounderColmn: 'By Hand' });
  check(
    'a genuinely unknown key is still refused, by name',
    typo?.ok === false && typo.error.includes('projectFounderColmn'),
    JSON.stringify(typo)
  );
  check(
    'and the refusal lists the new setting among the known ones',
    typo?.ok === false && typo.error.includes('projectFounderColumn'),
    typo?.error
  );

  // ─── 3. A collision with either queue column is refused ──────

  console.log('\n3. a founder column pointed at a column the queue works on is refused');

  for (const [setting, configured] of [
    ['projectTodoColumn', 'Up Next'],
    ['projectInProgressColumn', 'Underway'],
  ]) {
    for (const { label, spell } of SPELLINGS) {
      const config = { name: 'Colliding', [setting]: configured, projectFounderColumn: spell(configured) };

      const loaded = await load(config);
      check(
        `loadWorkspace refuses ${setting} ${label}`,
        refusesCollision(loaded?.error, setting, spell(configured)),
        `error was ${JSON.stringify(loaded?.error)}`
      );

      const validated = validateWorkspaceConfigPatch(stripName(config));
      check(
        `validateWorkspaceConfigPatch refuses ${setting} ${label}`,
        validated?.ok === false && refusesCollision(validated.error, setting, spell(configured)),
        JSON.stringify(validated)
      );
    }
  }

  // Vacuity control: a project that names a distinct founder column is healthy through both.
  const distinct = { projectTodoColumn: 'Up Next', projectInProgressColumn: 'Underway', projectFounderColumn: 'By Hand' };
  const healthy = await load({ name: 'Distinct', ...distinct });
  check('a distinctly named founder column still loads', healthy?.error === null, String(healthy?.error));
  check('and keeps its name', healthy?.projectFounderColumn === 'By Hand', String(healthy?.projectFounderColumn));
  const okPatch = validateWorkspaceConfigPatch(distinct);
  check('and the validator accepts it', okPatch?.ok === true, okPatch?.error);

  // ─── 4. The refusal fires against the default too ────────────

  console.log('\n4. and against the default, not only against a value somebody wrote');

  for (const [setting, fallback] of [
    ['projectTodoColumn', DEFAULT_TODO_COLUMN ?? 'Todo'],
    ['projectInProgressColumn', DEFAULT_IN_PROGRESS_COLUMN ?? 'In Progress'],
  ]) {
    for (const { label, spell } of SPELLINGS) {
      const config = { projectFounderColumn: spell(fallback) };

      const loaded = await load({ name: 'Defaulted', ...config });
      check(
        `${setting} unset: loadWorkspace still refuses "${spell(fallback)}" (${label})`,
        refusesCollision(loaded?.error, setting, spell(fallback)),
        `error was ${JSON.stringify(loaded?.error)}`
      );

      const validated = validateWorkspaceConfigPatch(config);
      check(
        `${setting} unset: the validator still refuses it (${label})`,
        validated?.ok === false && refusesCollision(validated.error, setting, spell(fallback)),
        JSON.stringify(validated)
      );
    }
  }

  // Vacuity control for section 4: with both keys unset, the shipped default is fine.
  const shipped = await load({ name: 'Shipped', projectFounderColumn: DEFAULT_FOUNDER_COLUMN ?? 'Founder Actions' });
  check(
    'both unset: the shipped founder name is not a collision',
    shipped?.error === null,
    String(shipped?.error)
  );

  // A project that renamed its queue column *onto* the shipped founder default is the same
  // collision from the other side, and has to be refused just as loudly.
  const founderDefault = DEFAULT_FOUNDER_COLUMN ?? 'Founder Actions';
  const inverted = await load({ name: 'Inverted', projectTodoColumn: founderDefault });
  check(
    'the queue column renamed onto the founder default is refused as well',
    refusesCollision(inverted?.error, 'projectTodoColumn', founderDefault),
    `error was ${JSON.stringify(inverted?.error)}`
  );

  // ─── 5. No Status is not the founder column ──────────────────

  console.log('\n5. findColumn never resolves the founder name to No Status');

  const name = DEFAULT_FOUNDER_COLUMN ?? 'Founder Actions';
  const unstatused = {
    sections: [
      { optionId: NO_STATUS_OPTION_ID, name, cards: [] },
      { optionId: 'f75ad846', name: 'Todo', cards: [] },
    ],
  };
  check(
    'a No Status section carrying the founder name resolves to nothing',
    findColumn(unstatused, name) === null,
    JSON.stringify(findColumn(unstatused, name))
  );
  check(
    'even though a real column of that name resolves',
    findColumn(
      { sections: [...unstatused.sections, { optionId: '4a1c90bb', name, cards: [] }] },
      name
    )?.optionId === '4a1c90bb'
  );
  check(
    'and No Status is still unreachable under its own name',
    findColumn({ sections: [{ optionId: NO_STATUS_OPTION_ID, name: NO_STATUS_NAME, cards: [] }] }, NO_STATUS_NAME) === null
  );

  await fs.rm(tmp, { recursive: true, force: true });

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

/** The config a settings save would send: everything the dialog holds, minus what it does not. */
function stripName({ name, ...rest }) {
  return rest;
}

main().catch(async (err) => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  console.error(`\nerror: ${err.stack ?? err.message}`);
  process.exit(1);
});
