#!/usr/bin/env node
/**
 * Checks that the commands this package installs, and the name it announces over stdio, are
 * this project's own — and that no file spells one of them out.
 *
 * `package.json` declared three bins: `vibemaxxing`, and `mcp-excalidraw-server` and
 * `excalidraw-canvas` inherited from upstream. `npm view mcp-excalidraw-server bin` answers
 * with exactly those two names, so upstream's published package installs them too: a global
 * install of both packages is a collision over `node_modules/.bin`, and `npx` resolves the
 * shadowed one to whichever is nearer. Keeping them was a kindness to an existing MCP client
 * configuration and it cannot be paid for with somebody else's command names.
 *
 * The second half is drift. The command name was written out as a literal in eight places of
 * `src/cli/run.ts`'s help and error text and once more in `src/core/spawn.ts`'s start hint, so
 * the rename of #293 had to find all nine by hand, and the next one would too. Help text that
 * names a command the package does not install is worse than no help: it is confidently wrong,
 * and nothing goes red.
 *
 * Six rules:
 *
 *  1. **`package.json` `bin` declares neither inherited name**, and declares at least the
 *     product's own command. Its first key is the package's identity, unscoped.
 *  2. **The exported `BIN_NAME` is that first key**, and `BIN_NAMES` is every key in order —
 *     read out of the built `dist/`, so this asserts what the CLI will actually print rather
 *     than what the source appears to say.
 *  3. **`src/cli/run.ts` and `src/core/spawn.ts` spell no command name out at all** — not the
 *     inherited ones and not the current one either. A literal that is right today is what
 *     rule 2 exists to stop being written again.
 *  4. **No inherited command name survives anywhere in `src/`**, beyond a short list of
 *     identifiers that merely look like one and are not commands (below).
 *  5. **The MCP handshake announces this project**: `initialize` is spoken to the real bin over
 *     stdio, and `serverInfo.name` has to be the package's own name — the same string as
 *     `BIN_NAME` — rather than upstream's.
 *  6. **The documentation renamed the client-config key with it.** `mcp__excalidraw__*` is what
 *     a client builds from the `mcpServers` key `excalidraw`, and an agent whose
 *     `--allowedTools` pattern no longer matches is refused and exits 0
 *     (`docs/trap-allowed-tools.md`), so the README has to say the key changed rather than only
 *     changing it.
 *
 * **What rule 4 deliberately allows.** Three strings in `src/` are the same shape as an
 * inherited bin and name something else: the pidfile state directory (`excalidraw-canvas`,
 * where a running server's pid already lives — renaming it orphans one), and the `source` field
 * written into an exported scene (`mcp-excalidraw-server`, left alone by #293 on the grounds
 * that nothing reads it back and it instructs nobody to install anything). Each is listed with
 * its file and an exact count, so a fourth occurrence anywhere is a failure. The health-identity
 * marker `mcp-excalidraw-canvas` is a different token and never a hit, the way
 * `check-fork-identity.mjs` treats `mcp-excalidraw-mcp`.
 *
 * **Run against the tree before the change it guards**, where it is red on rules 1, 3, 4 and 6.
 * Section 0 is what says its rules work at all: it drives each one over fixtures carrying the
 * defect and over fixtures carrying none, so a green run later means the tree was fixed rather
 * than the scanner having stopped looking.
 *
 * Self-contained: tracked files, the built `dist/`, and one short-lived MCP stdio process with
 * auto-start turned off. No canvas server, no browser, no network. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-bin-identity.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The two command names upstream's published package installs. */
const INHERITED = ['mcp-excalidraw-server', 'excalidraw-canvas'];

/** The files whose help and error text must read the constant instead of naming a command. */
const NO_LITERALS_IN = ['src/cli/run.ts', 'src/core/spawn.ts'];

/**
 * Strings in `src/` shaped like an inherited bin that name something else entirely. File,
 * term, exact count, and why it is not a command.
 */
const NOT_COMMANDS = [
  { file: 'src/core/pidfile.ts', term: 'excalidraw-canvas', count: 2,
    why: 'the state directory a running server\'s pidfile already sits in' },
  { file: 'src/core/scene-io.ts', term: 'mcp-excalidraw-server', count: 1,
    why: 'the "source" field of an exported scene; nothing reads it back (#293)' },
];

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The rules, as functions over text ────────────────────────

/** What counts as part of a command name, and therefore as *not* a boundary around one. */
const NAME_CHAR = 'A-Za-z0-9_-';
const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matcher = (term) => new RegExp(`(?<![${NAME_CHAR}])${escape(term)}(?![${NAME_CHAR}])`, 'g');

/** Every whole-token occurrence of `term` in `text`, as `{ line, text }`. */
function occurrences(text, term) {
  const out = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const hits = line.match(matcher(term));
    if (hits) for (let i = 0; i < hits.length; i++) out.push({ line: index + 1, text: line.trim() });
  });
  return out;
}

/** Where a `bin` map still installs somebody else's commands, or installs nothing of its own. */
function binIssues(pkg) {
  const bin = pkg.bin;
  const names = bin && typeof bin === 'object' ? Object.keys(bin) : [];
  const issues = [];
  if (names.length === 0) return ['package.json declares no bin map at all'];
  for (const name of names) {
    if (INHERITED.includes(name)) issues.push(`bin declares "${name}", which upstream publishes`);
  }
  const unscoped = String(pkg.name ?? '').replace(/^@[^/]+\//, '');
  if (names[0] !== unscoped) {
    issues.push(`the first bin is "${names[0]}" — expected "${unscoped}", the package's own name`);
  }
  return issues;
}

/** Every command name spelled out in a file that is supposed to read one constant. */
function literalIssues(path, text, terms) {
  return terms.flatMap((term) => occurrences(text, term)
    .map(({ line, text: line_text }) => `${path}:${line} names "${term}" — ${line_text.slice(0, 68)}`));
}

/**
 * Every inherited command name in `src/` that is not one of the identifiers on the allow list.
 *
 * The allowance is by file, term and count: the listed occurrences are subtracted, and anything
 * beyond them is reported. A file that grows a fourth one fails even though its first three are
 * permitted.
 */
function inheritedIssues(files, allowed = NOT_COMMANDS) {
  const issues = [];
  for (const [path, text] of files) {
    for (const term of INHERITED) {
      const hits = occurrences(text, term);
      const permit = allowed.find((entry) => entry.file === path && entry.term === term);
      if (hits.length === 0 && !permit) continue;
      const spare = hits.slice(permit ? permit.count : 0);
      for (const hit of spare) {
        issues.push(`${path}:${hit.line} names "${term}" — ${hit.text.slice(0, 68)}`);
      }
      if (permit && hits.length < permit.count) {
        issues.push(`${path} names "${term}" ${hits.length} time(s); the allow list says `
                    + `${permit.count} — trim the list rather than leaving it stale`);
      }
    }
  }
  return issues;
}

/** A client-config server key: the JSON object key, and the CLI form `codex mcp add <key>`. */
function serverKeys(text, key) {
  const out = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (new RegExp(`^\\s*"${escape(key)}"\\s*:\\s*\\{`).test(line)
        || new RegExp(`\\bmcp\\s+(?:add|remove)\\s+${escape(key)}(?![${NAME_CHAR}])`).test(line)) {
      out.push({ line: index + 1, text: line.trim() });
    }
  });
  return out;
}

/** How many client-config blocks the document contains — one key each is what is owed. */
const configBlocks = (text) =>
  (text.match(/^\s*"(?:mcpServers|mcp)"\s*:\s*\{/gm) ?? []).length
  + (text.match(/^\s*(?:codex|claude)\s+mcp\s+add\s+\S+/gm) ?? []).length;

/** Whether one line tells a reader that their allowed-tools pattern has to change. */
const renamesToolIds = (text, from, to) => text.split(/\r?\n/).some((line) =>
  line.includes(`mcp__${from}__`) && line.includes(`mcp__${to}__`) && /allowed[-]?tools/i.test(line));

// ─── 0. The rules catch each defect, and clear a fixed tree ───

console.log('0. the rules catch each defect, and clear fixtures that have none');

const DIRTY_PKG = { name: '@someone/their-tool',
                    bin: { 'their-tool': 'dist/bin.js', 'mcp-excalidraw-server': 'dist/bin.js',
                           'excalidraw-canvas': 'dist/bin.js' } };
const CLEAN_PKG = { name: '@someone/their-tool',
                    bin: { 'their-tool': 'dist/bin.js', 'their-tl': 'dist/bin.js' } };

check('both inherited bins are caught in a bin map', binIssues(DIRTY_PKG).length === 2,
      binIssues(DIRTY_PKG).join(' / ') || 'nothing caught');
check('a bin map of the package\'s own commands is accepted', binIssues(CLEAN_PKG).length === 0,
      binIssues(CLEAN_PKG).join(' / '));
check('a first bin that is not the package\'s own name is caught',
      binIssues({ ...CLEAN_PKG, bin: { other: 'dist/bin.js' } }).length === 1);
check('a package with no bin map at all is caught', binIssues({ name: 'x' }).length === 1);

const HELP_DIRTY = ['  their-tool <command> [...]   Drive it',
                    '  excalidraw-canvas <command>  Same CLI under its short alias'].join('\n');
const HELP_CLEAN = ['  ${BIN_NAME} <command> [...]   Drive it',
                    '  ${alias} <command> [...]      Same CLI under a shorter alias'].join('\n');
const HELP_TERMS = ['their-tool', ...INHERITED];

check('a current command name spelled out is caught, not only an inherited one',
      literalIssues('run.ts', HELP_DIRTY, HELP_TERMS).length === 2,
      literalIssues('run.ts', HELP_DIRTY, HELP_TERMS).join(' / ') || 'nothing caught');
check('help text built out of the constant is accepted',
      literalIssues('run.ts', HELP_CLEAN, HELP_TERMS).length === 0,
      literalIssues('run.ts', HELP_CLEAN, HELP_TERMS).join(' / '));
check('two names on one line are two findings',
      literalIssues('run.ts', 'excalidraw-canvas and mcp-excalidraw-server', INHERITED).length === 2);

const ALLOW_FIXTURE = [{ file: 'pidfile.ts', term: 'excalidraw-canvas', count: 1, why: 'a directory' }];
check('a permitted identifier is not a finding',
      inheritedIssues([['pidfile.ts', "join(state, 'excalidraw-canvas')"]], ALLOW_FIXTURE).length === 0);
check('a second occurrence beyond the permitted count is',
      inheritedIssues([['pidfile.ts', "join(state, 'excalidraw-canvas')\nrun('excalidraw-canvas stop')"]],
                      ALLOW_FIXTURE).length === 1);
check('an allow-list entry that has gone stale is reported',
      inheritedIssues([['pidfile.ts', 'nothing here']], ALLOW_FIXTURE).length === 1,
      'a list nobody trims is a list that stops meaning anything');
check('the health-identity marker is a different word from a bin',
      inheritedIssues([['canvas-client.ts', "const SERVICE = 'mcp-excalidraw-canvas'"]]).length === 0,
      'mcp-excalidraw-canvas is not excalidraw-canvas');
check('a command name in a comment is still a command name',
      inheritedIssues([['server.ts', '// lets `excalidraw-canvas stop` find us']]).length === 1);

const README_DIRTY = ['  "mcpServers": {', '    "excalidraw": {', '  }',
                      'codex mcp add excalidraw -- npx -y @someone/their-tool'].join('\n');
const README_CLEAN = ['  "mcpServers": {', '    "their-tool": {', '  }',
                      'codex mcp add their-tool -- npx -y @someone/their-tool'].join('\n');

check('both spellings of the old server key are caught',
      serverKeys(README_DIRTY, 'excalidraw').length === 2,
      serverKeys(README_DIRTY, 'excalidraw').map((hit) => hit.text).join(' / ') || 'nothing caught');
check('a renamed config block keeps no old key', serverKeys(README_CLEAN, 'excalidraw').length === 0);
check('every config block is counted, JSON and CLI alike', configBlocks(README_CLEAN) === 2);
check('the sentence about allowed-tools patterns is recognised',
      renamesToolIds('Anyone whose --allowedTools said mcp__excalidraw__* must say mcp__their__*.',
                     'excalidraw', 'their'));
check('a rename with no such sentence is not',
      !renamesToolIds('The key is now their-tool.', 'excalidraw', 'their'));

// ─── The real tree ────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const binNames = pkg.bin && typeof pkg.bin === 'object' ? Object.keys(pkg.bin) : [];

console.log('\n1. package.json installs this project\'s commands and nobody else\'s');

const issues = binIssues(pkg);
check('bin declares neither mcp-excalidraw-server nor excalidraw-canvas, and leads with our own',
      issues.length === 0, issues.join('\n        '));
check(`bin declares the command plus a short alias (${binNames.join(', ') || 'none'})`,
      binNames.length >= 2,
      'the issue asks for the new name plus one alias, so a habit has somewhere to go');
check('every bin points at the same entry point',
      new Set(Object.values(pkg.bin ?? {})).size === 1, JSON.stringify(pkg.bin));

console.log('\n2. the exported constant is package.json\'s first bin');

const version = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'version.js')).href)
  .catch((error) => ({ error }));
check('dist/core/version.js exports BIN_NAME and BIN_NAMES', !version.error
      && typeof version.BIN_NAME === 'string' && Array.isArray(version.BIN_NAMES),
      version.error ? `import failed: ${version.error.message} — run ./node_modules/.bin/tsc`
                    : `BIN_NAME=${JSON.stringify(version.BIN_NAME)} `
                      + `BIN_NAMES=${JSON.stringify(version.BIN_NAMES)}`);
check('BIN_NAME is the first key of package.json bin', version.BIN_NAME === binNames[0],
      `${JSON.stringify(version.BIN_NAME)} vs ${JSON.stringify(binNames[0])}`);
check('BIN_NAMES is every key of package.json bin, in order',
      JSON.stringify(version.BIN_NAMES ?? null) === JSON.stringify(binNames),
      `${JSON.stringify(version.BIN_NAMES ?? null)} vs ${JSON.stringify(binNames)}`);

console.log('\n3. the help and error text spell no command name out');

const currentAndInherited = [...new Set([...binNames, ...INHERITED])];
for (const path of NO_LITERALS_IN) {
  const found = literalIssues(path, readFileSync(join(repoRoot, path), 'utf8'), currentAndInherited);
  check(`${path} reads the constant rather than naming a command`, found.length === 0,
        found.join('\n        '));
}

console.log('\n4. no inherited command name survives in src/');

function trackedSources() {
  const listed = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter((path) => path.endsWith('.ts'));
  return listed.map((path) => [path, readFileSync(join(repoRoot, path), 'utf8')]);
}

const sources = trackedSources();
check(`there were sources to scan (${sources.length})`, sources.length > 0);
const inherited = inheritedIssues(sources);
check('every remaining occurrence is an identifier the allow list names', inherited.length === 0,
      inherited.join('\n        '));
for (const entry of NOT_COMMANDS) {
  console.log(`  note  ${entry.file} keeps "${entry.term}" ×${entry.count} — ${entry.why}`);
}

console.log('\n5. the MCP handshake announces this project');

/** Speak `initialize` to the real bin over stdio and return its result, or null. */
async function initialize(timeoutMs = 20000) {
  const env = { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1', ENABLE_CANVAS_SYNC: 'false' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('EXCALIDRAW_') && key !== 'EXCALIDRAW_NO_AUTOSTART') delete env[key];
  }
  const child = spawn(process.execPath, [join(repoRoot, 'dist', 'bin.js')],
                      { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.resume();
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {},
              clientInfo: { name: 'check-bin-identity', version: '0' } }
  }) + '\n');

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      for (const line of out.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) return message.result ?? { error: message.error };
        } catch { /* a partial line */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    child.kill();
  }
  return null;
}

const result = await initialize();
const serverInfo = result?.serverInfo ?? {};
check('the bin answers initialize over stdio', result !== null && !result.error,
      result === null ? 'no response within the timeout' : JSON.stringify(result).slice(0, 200));
check('serverInfo.name is the package\'s own name', serverInfo.name === binNames[0],
      `${JSON.stringify(serverInfo.name)} vs ${JSON.stringify(binNames[0])}`);
check('serverInfo.name is neither inherited command name',
      !INHERITED.includes(String(serverInfo.name)), JSON.stringify(serverInfo.name));
check('serverInfo.version is package.json\'s version', serverInfo.version === pkg.version,
      `${JSON.stringify(serverInfo.version)} vs ${JSON.stringify(pkg.version)}`);
check('serverInfo.description is package.json\'s, which leads with the product',
      serverInfo.description === pkg.description
      && String(pkg.description).trim().length > 0,
      `${JSON.stringify(serverInfo.description)} vs ${JSON.stringify(pkg.description)}`);

console.log('\n6. the documentation renamed the client-config key with it');

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const stale = serverKeys(readme, 'excalidraw');
check('README.md carries no "excalidraw" server key in any client config', stale.length === 0,
      stale.map(({ line, text }) => `README.md:${line} ${text}`).join('\n        '));
const renamed = serverKeys(readme, binNames[0] ?? '');
check(`every client-config block names "${binNames[0]}" (${renamed.length} of `
      + `${configBlocks(readme)})`, renamed.length >= configBlocks(readme) && renamed.length > 0);
check('one sentence tells a reader their allowed-tools pattern has to change',
      renamesToolIds(readme, 'excalidraw', binNames[0] ?? ''),
      'mcp__excalidraw__* no longer matches, and an agent whose list misses is refused and '
      + 'exits 0 — docs/trap-allowed-tools.md');

const cli = readFileSync(join(repoRoot, 'docs', 'cli.md'), 'utf8');
const cliStale = INHERITED.flatMap((term) => occurrences(cli, term)
  .map(({ line, text }) => `docs/cli.md:${line} names "${term}" — ${text.slice(0, 68)}`));
check('docs/cli.md names no command this package does not install', cliStale.length === 0,
      cliStale.join('\n        '));

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
