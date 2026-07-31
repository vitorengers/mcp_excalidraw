#!/usr/bin/env node
/**
 * Writes the variable tables in `docs/running.md` out of `src/core/settings.ts`.
 *
 * The tables were hand-kept beside a declaration that already had every name in it, so the two
 * drifted the way two copies of a list always do: three documents asserted three different
 * counts of the same set, and three variables the server reads — `LOG_LEVEL`, `LOG_FILE_PATH`
 * and `DEBUG` — were in no table at all. `LOG_FILE_PATH` was the expensive one: the console
 * transport is warn-and-above, so every `logger.info` goes to a file whose location nothing
 * documented.
 *
 * So the declaration is the document now. Each setting carries the name, the default and the
 * whole **What it does** cell, and this writes the three tables between markers.
 * `check-settings-documented.mjs` fails when what is tracked is not what this produces, so the
 * generator is not something anybody has to remember to run — forgetting it is a red check.
 *
 * `--check` prints the diff and exits non-zero instead of writing, which is what the check runs.
 *
 * Run `./node_modules/.bin/tsc` first: it reads the compiled declaration.
 *
 * Usage: node scripts/generate-settings-docs.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRegion, loadSettings, renderRegions, settingsModulePath } from './lib/settings-tables.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const document = join(repoRoot, 'docs', 'running.md');
const checkOnly = process.argv.includes('--check');

const settings = await loadSettings(repoRoot);
if (!settings) {
  console.error(`${settingsModulePath(repoRoot)} is not built — run ./node_modules/.bin/tsc first`);
  process.exit(1);
}

const before = readFileSync(document, 'utf8');
let after = before;
const missing = [];

for (const { id, text } of renderRegions(settings)) {
  const region = findRegion(after, id);
  if (!region) { missing.push(id); continue; }
  after = after.slice(0, region.start) + text + after.slice(region.end);
}

if (missing.length) {
  console.error(`docs/running.md carries no generated region: ${missing.join(', ')}`);
  console.error('Each table sits between <!-- generated: <id> ... --> and <!-- /generated: <id> -->.');
  process.exit(1);
}

if (after === before) {
  console.log('docs/running.md already matches src/core/settings.ts');
  process.exit(0);
}

if (checkOnly) {
  console.error('docs/running.md is not what src/core/settings.ts produces.');
  console.error('Run: node scripts/generate-settings-docs.mjs');
  process.exit(1);
}

writeFileSync(document, after, 'utf8');
console.log('docs/running.md rewritten from src/core/settings.ts');
