/**
 * The variable tables in `docs/running.md`, rendered from `src/core/settings.ts`.
 *
 * One module rather than two copies, because the generator and the check have to agree byte for
 * byte or the check is asserting something nobody can satisfy: `generate-settings-docs.mjs`
 * writes what this returns, `check-settings-documented.mjs` compares what is tracked against it.
 *
 * The declaration is read out of `dist/`, not parsed out of the `.ts`. A regex over a source
 * file would be a second, weaker declaration of the same list — and the descriptions are
 * Markdown containing quotes, backticks and links, which is exactly the text a regex gets wrong.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The marker a generated region opens and closes with. One per table. */
export const REGIONS = [
  {
    id: 'settings-table',
    /** Everything that means the same thing on all three platforms. */
    select: (setting) => setting.prefixed && !setting.windowsOnly
  },
  {
    id: 'settings-wsl-table',
    select: (setting) => setting.prefixed && setting.windowsOnly
  },
  {
    id: 'settings-plain-table',
    select: (setting) => !setting.prefixed
  }
];

const OPEN = (id) =>
  `<!-- generated: ${id} — from src/core/settings.ts, by scripts/generate-settings-docs.mjs -->`;
const CLOSE = (id) => `<!-- /generated: ${id} -->`;

/** Where the compiled declaration is, and what to say when it is not built yet. */
export function settingsModulePath(repoRoot) {
  return join(repoRoot, 'dist', 'core', 'settings.js');
}

/**
 * The declaration, or `null` when `dist/` has not been built.
 *
 * `null` rather than a throw: a check that dies here says nothing about the rules it exists for,
 * and the caller can report one clear line instead of a stack trace.
 */
export async function loadSettings(repoRoot) {
  const modulePath = settingsModulePath(repoRoot);
  if (!existsSync(modulePath)) return null;
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.documentedSettings !== 'function') return null;
  return module.documentedSettings();
}

/** One Markdown table. The three columns `docs/running.md` has carried since it was written. */
export function renderTable(settings) {
  return [
    '| Variable | Default | What it does |',
    '|---|---|---|',
    ...settings.map(({ variable, fallback, description }) =>
      `| \`${variable}\` | ${fallback} | ${description} |`)
  ].join('\n');
}

/** A whole generated region, markers included, exactly as it belongs in the document. */
export function renderRegion(id, settings) {
  return `${OPEN(id)}\n\n${renderTable(settings)}\n\n${CLOSE(id)}`;
}

/**
 * Find one region in a document.
 *
 * Returns the character range the markers enclose, or `null` when the document does not carry
 * that region at all — which is a failure the check reports rather than a reason to throw.
 */
export function findRegion(text, id) {
  const open = text.indexOf(OPEN(id));
  if (open < 0) return null;
  const close = text.indexOf(CLOSE(id), open);
  if (close < 0) return null;
  return { start: open, end: close + CLOSE(id).length };
}

/** Every region, rendered, keyed by id. */
export function renderRegions(settings) {
  return REGIONS.map(({ id, select }) => ({ id, text: renderRegion(id, settings.filter(select)) }));
}
