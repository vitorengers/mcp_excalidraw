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
 *   1. it is `package.json` `name` — and *not* merely one of its `bin` keys — *and*
 *      `package.json` is this repository's package record rather than upstream's, which is
 *      decided here by whether `repository.url` names the repository in `board.config.json`.
 *      That second half is what stopped the rule going vacuous while the tree still carried
 *      upstream's record verbatim: it would otherwise have "published" upstream's name by
 *      definition and waved every command through. It reads the record rather than a literal,
 *      which is why #293 claiming `@vitorengers/vibemaxxing` needed no edit here — and why
 *      the `bin` half matters now that the two disagree, `mcp-excalidraw-server` surviving as
 *      an alias while the registry entry under that name is still upstream's;
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
 *   - **skills/vibemaxxing-canvas/SKILL.md** may declare once, in its first section. It is a
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

/**
 * The one name a fetch may legitimately use: `package.json` `name`.
 *
 * **Not the `bin` keys.** `npx -y <x>` and `npm i -g <x>` resolve `x` as a *package* on the
 * registry; a bin key is only what you type once the package is installed. Since #293 the two
 * disagree on purpose — this tree publishes `@vitorengers/vibemaxxing` and keeps
 * `mcp-excalidraw-server` as a bin alias so existing MCP client configurations survive the
 * rename — and `mcp-excalidraw-server` on the registry is still upstream's package. Letting a
 * bin key license a fetch would wave through the exact command this check exists to catch.
 */
const ownNames = new Set([pkg.name].filter(Boolean));

/** Bin aliases, named here only so the failure can say why the name is not enough. */
const binNames = new Set(Object.keys(pkg.bin ?? {}).filter((name) => name !== pkg.name));

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
    for (const name of [...ownNames, ...binNames]) {
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
  if (binNames.has(name)) {
    return `"${name}" is a bin alias, not the package name — \`npx\` and \`npm i\` resolve it on `
         + `the registry, where it is somebody else's package. Fetch "${pkg.name}"`;
  }
  if (/excalidraw/i.test(name) && !dependencyNames.has(name)) {
    return `"${name}" is neither published by this repository nor one of its dependencies`;
  }
  return null;
}

// ─── 1. The documents ─────────────────────────────────────────

console.log('1. no document hands out a command that fetches somebody else\'s package');

for (const relative of ['README.md', 'skills/vibemaxxing-canvas/SKILL.md']) {
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
  /**
   * Whichever way the publishing question is answered, the install section has to name a way
   * in that belongs to this repository: the package it publishes, or a clone of it. #293
   * answered it — `@vitorengers/vibemaxxing` — and this holds either answer, so it does not
   * have to be rewritten if the tree ever stops publishing.
   */
  const namesOwnPackage = publishesOwnPackage && installSection.includes(pkg.name);
  const installsFromClone = installSection.includes('npm ci');
  check('it names a way in that is this repository\'s', namesOwnPackage || installsFromClone,
        `neither "${pkg.name}" nor a clone (\`npm ci\`) appears in it`);
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
