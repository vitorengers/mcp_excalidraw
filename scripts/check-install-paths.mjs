#!/usr/bin/env node
/**
 * Checks that nothing in this repository tells a reader to install a package it does not
 * publish.
 *
 * `check-readme.mjs` asks whether the front page is *about* this repository. This asks the
 * question underneath it: does the front page hand out commands that fetch this repository.
 * It did not. Every install line said `npx -y mcp-excalidraw-server`, which resolves on the
 * npm registry to the upstream project's published build — a diagramming toolkit with none
 * of the workspace registry, block kinds, agents, worktrees or terminals the same page spends
 * five hundred lines describing. The README even says so at the Docker section and then keeps
 * using the commands. The tracked root `claude_desktop_config.json` named a third package
 * again, `excalidraw-mcp`, which is neither this fork nor the one the README names.
 *
 * A package name in an install command is only honest under one of three conditions:
 *
 *   1. it is a name this tree publishes — `package.json` `name` or one of its `bin` keys —
 *      *and* `package.json` is this repository's package record rather than upstream's,
 *      which is decided here by whether `repository.url` names the repository in
 *      `board.config.json`. That second half is what stops the rule going vacuous: a tree
 *      that carries upstream's package record verbatim would otherwise "publish" upstream's
 *      name by definition, and every command naming it would pass. It also means the rule
 *      needs no edit when #293 claims an npm identity — it reads the record, not a literal;
 *   2. it sits under a heading that says the command installs upstream's package;
 *   3. it names something this tree declares as a dependency, or something that is plainly
 *      not this product at all (`@modelcontextprotocol/inspector`). A name carrying
 *      `excalidraw` that is neither published here nor depended on here is claiming to be
 *      this product while being something else, and that is the `excalidraw-mcp` defect.
 *
 * The two markdown files are held to it differently, on purpose:
 *
 *   - **README.md** must label per block. It is the front page and a reader arrives in the
 *     middle of it from the table of contents, so a disclaimer at the top labels nothing
 *     that a reader of the Cursor section will ever see.
 *   - **skills/excalidraw-skill/SKILL.md** may declare once, in its first section. It is a
 *     portable skill that `install-skill` copies onto machines that have no clone of this
 *     repository, so it *has* to name a package on the registry; and it is one document an
 *     agent reads from the top before running anything in it. A single line there naming the
 *     package and saying whose it is licenses that name for the file.
 *
 * Offline and self-contained. No server, no browser.
 *
 * Usage: node scripts/check-install-paths.mjs
 *
 * Tier: repo
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');
const present = (relative) => existsSync(join(repoRoot, relative));

const pkg = JSON.parse(read('package.json'));
const board = JSON.parse(read('board.config.json'));

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── What this tree may legitimately name ─────────────────────

/** Names this tree claims as its own: the package name and every bin it installs. */
const ownNames = new Set([pkg.name, ...Object.keys(pkg.bin ?? {})].filter(Boolean));

/** Names this tree depends on, and may therefore document a reader fetching. */
const dependencyNames = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);

/**
 * Whether `package.json` describes *this* repository. While it carries upstream's
 * `repository.url`, the name in it is upstream's name, and telling a reader to fetch it
 * hands them upstream's product.
 */
const publishesOwnPackage = typeof pkg.repository?.url === 'string'
  && pkg.repository.url.includes(board.repo);

// ─── Finding install and run commands ─────────────────────────

const NAME = String.raw`(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*`;
const FLAGS = String.raw`(?:-{1,2}[\w-]+\s+)*`;

/**
 * Three shapes an install or run target takes across the files scanned here: a shell `npx`,
 * a shell `npm install`, and an MCP client config where `npx` and its argument list are on
 * separate lines (`"args": ["-y", "<package>"]`, and OpenCode's `["npx", "-y", "<package>"]`).
 */
const COMMANDS = [
  { label: 'npx', pattern: String.raw`\bnpx\s+${FLAGS}(${NAME})` },
  { label: 'npm install', pattern: String.raw`\bnpm\s+(?:i|install|add|exec)\s+${FLAGS}(${NAME})` },
  { label: 'config args', pattern: String.raw`["']-{1,2}y(?:es)?["']\s*,\s*["'](${NAME})["']` },
];

/** Every package name a line asks the reader to fetch. */
function targetsIn(line) {
  const found = [];
  for (const { label, pattern } of COMMANDS) {
    for (const match of line.matchAll(new RegExp(pattern, 'g'))) {
      found.push({ name: match[1], label });
    }
  }
  return found;
}

/**
 * Walk a markdown file, carrying the stack of headings each line sits under. Fenced blocks
 * are transparent to the scan — the commands live in them — but a `#` inside one is a shell
 * comment and never a heading.
 */
function* markdownLines(text) {
  const stack = [];
  let fenced = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, title: heading[2] });
        continue;
      }
    }
    yield { line, number: index + 1, headings: stack.map((entry) => entry.title) };
  }
}

/** The text of a markdown file up to its second `##` heading — its opening section. */
function firstSection(text) {
  const lines = text.split(/\r?\n/);
  let seen = 0;
  const collected = [];
  for (const line of lines) {
    if (/^##\s+/.test(line) && ++seen > 1) break;
    collected.push(line);
  }
  return collected;
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Package names the opening section of a file declares as somebody else's, by naming the
 * package and whose it is on one line. One line, so the sentence has to be about the package
 * rather than the word "upstream" appearing anywhere nearby; and only a name this tree claims
 * can be declared away, so a third package cannot be laundered by a disclaimer.
 */
function declaredUpstream(text) {
  const declared = new Set();
  for (const line of firstSection(text)) {
    if (!/upstream/i.test(line)) continue;
    for (const name of ownNames) {
      if (new RegExp(String.raw`(^|[^\w.@/-])${escaped(name)}([^\w.@/-]|$)`).test(line)) {
        declared.add(name);
      }
    }
  }
  return declared;
}

/** Why a target is not allowed here, or null when it is. */
function offence({ name, headings, declared }) {
  const labelled = headings.some((title) => /upstream/i.test(title)) || declared.has(name);
  if (ownNames.has(name)) {
    if (publishesOwnPackage || labelled) return null;
    return `"${name}" is package.json's name, but package.json still describes `
         + `${pkg.repository?.url ?? 'no repository'} rather than ${board.repo} — the registry `
         + `entry under that name is not this tree's`;
  }
  if (/excalidraw/i.test(name) && !dependencyNames.has(name)) {
    return `"${name}" is neither published by this repository nor one of its dependencies`;
  }
  return null;
}

// ─── 1. The documents ─────────────────────────────────────────

console.log('1. no document hands out a command that fetches somebody else\'s package');

for (const relative of ['README.md', 'skills/excalidraw-skill/SKILL.md']) {
  const text = read(relative);
  const declared = relative.endsWith('SKILL.md') ? declaredUpstream(text) : new Set();
  const offences = [];
  for (const { line, number, headings } of markdownLines(text)) {
    for (const { name, label } of targetsIn(line)) {
      const reason = offence({ name, headings, declared });
      if (reason) offences.push(`${relative}:${number} (${label}) ${reason}`);
    }
  }
  check(`${relative} names only packages this repository publishes or labels as upstream's`,
        offences.length === 0, `\n        ${offences.join('\n        ')}`);
}

// ─── 2. The tracked root MCP config ───────────────────────────

console.log('\n2. the tracked root MCP config is this repository\'s, or is not there');

const rootConfig = 'claude_desktop_config.json';
if (!present(rootConfig)) {
  check(`${rootConfig} is absent`, true);
} else {
  const text = read(rootConfig);
  const offences = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const { name, label } of targetsIn(line)) {
      const reason = offence({ name, headings: [], declared: new Set() });
      if (reason) offences.push(`${rootConfig}:${index + 1} (${label}) ${reason}`);
    }
  });
  check(`${rootConfig} names the package in package.json`, offences.length === 0,
        `\n        ${offences.join('\n        ')}`
        + '\n        a tracked root config is copied verbatim by whoever finds it');
}

// ─── 3. The install section says how to get this tree ─────────

console.log('\n3. the README install section is about getting this repository');

const installSection = (() => {
  const lines = read('README.md').split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Installation\s*$/.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
})();

check('the README has an Installation section', installSection !== null);
if (installSection !== null) {
  check('it installs from a clone (`npm ci`)', installSection.includes('npm ci'),
        'the only supported install path is a checkout of this repository');
  check('it points at the run procedure (docs/running.md)',
        installSection.includes('docs/running.md'),
        'installing is half of it; the launcher and its environment live in that document');
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
