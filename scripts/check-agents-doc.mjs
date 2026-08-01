#!/usr/bin/env node
/**
 * Checks that the board can be run with an agent that is not Claude Code, by reading.
 *
 * The two agents are command lines the operator supplies, and the code has never cared whose
 * binary is in them — `knownBackend` in `src/core/agent-preflight.ts` names nine. The
 * documentation cared very much: the one place the command was specified genericised the
 * binary to `<agent-binary>` and then surrounded it with Claude Code's flag vocabulary, and
 * `docs/running.md` repeated those flags as requirements. A reader who substituted another
 * binary and kept the flags got the failure `docs/trap-allowed-tools.md` exists to warn
 * about: a run that investigates, is refused, and exits 0 with nothing.
 *
 * So `docs/agents.md` is held to being usable rather than to existing:
 *
 *  1. **it is reachable** — tracked, and linked from the index, from `README.md`, and from
 *     the two documents that used to state Claude Code's flags as universal;
 *  2. **every recipe in it is complete and runnable** — a whole `EXCALIDRAW_*_AGENT=` line,
 *     for both roles, for at least two distinct binaries, each carrying the flag that makes
 *     that binary non-interactive and the grant that lets it run `gh` and `git`. A binary
 *     this file has no rule for is a failure rather than a pass: a recipe added without
 *     saying what makes it non-interactive is the defect, written down;
 *  3. **the rules that generalise are stated as rules** — non-interactive, permitted `gh`
 *     and `git`, the URL printed last — because a document that is only two recipes is a
 *     document that is wrong for the third agent.
 *
 * The per-backend rules below are the ones that were checked against each CLI's own
 * documentation, and two of them are the whole reason this is mechanical rather than prose:
 * `-p` is `--print` to Claude Code and `--profile` to Codex CLI, and Codex's `workspace-write`
 * sandbox restricts the network, so a recipe carrying it without `network_access` grants a
 * `gh` that cannot reach github.com.
 *
 * Offline and self-contained: it reads tracked files and starts nothing.
 *
 * Usage: node scripts/check-agents-doc.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOC = 'docs/agents.md';

/** The documents that must be able to send a reader here. */
const LINKING = ['docs/index.md', 'docs/running.md', 'docs/issue-block.md', 'README.md'];

/**
 * What each backend's recipe has to carry, and why.
 *
 * A table rather than a general rule, because "non-interactive" is spelled differently by
 * every CLI and there is nothing in a command line that says which one it is. A backend
 * absent from here fails section 2 — adding a recipe means adding the two facts that make it
 * a working recipe rather than a plausible one.
 */
const BACKENDS = {
  claude: {
    /** `-p`/`--print` answers and exits; without it the CLI draws an interface. */
    nonInteractive: /(?:^|\s)(?:-p|--print)(?:\s|$)/,
    /** An allowlist that names the two, or the flag that stops the asking. */
    permits: /--allowedTools|--dangerously-skip-permissions/,
    /**
     * An enumerated list is also a deny list: in print mode a tool outside it is refused
     * silently and the run exits 0. So a recipe that enumerates must enumerate both.
     *
     * `Bash(gh` and not `Bash(gh:*)`, because a rule may name a sub-command — `Bash(gh issue
     * create:*)` — and since #328 the shipped list does exactly that. What this demand is for
     * is a list with no `gh` in it at all; how narrowly `gh` is granted is
     * `check-issue-agent-allowlist.mjs`, which holds the list against every claim made about
     * it. Pinning the wide spelling here would have made that narrowing fail this check.
     */
    demands: [
      {
        when: /--allowedTools/,
        then: /--allowedTools\s+"[^"]*Bash\(gh[ :][^"]*"/,
        why: 'an --allowedTools list that omits gh refuses it silently and exits 0',
      },
      {
        when: /--allowedTools/,
        then: /--allowedTools\s+"[^"]*Bash\(git[ :][^"]*"/,
        why: 'an --allowedTools list that omits git refuses it silently and exits 0',
      },
    ],
  },
  codex: {
    /** `codex exec` is the non-interactive subcommand; bare `codex` is the interface. */
    nonInteractive: /(?:^|\s)exec(?:\s|$)/,
    permits: /--dangerously-bypass-approvals-and-sandbox|--sandbox\s+workspace-write/,
    demands: [
      {
        when: /--sandbox\s+workspace-write/,
        then: /sandbox_workspace_write\.network_access\s*=\s*true/,
        why: 'workspace-write restricts the network, so gh cannot reach github.com without it',
      },
    ],
  },
};

/** The two roles. A backend documented for one of them is half a recipe. */
const ROLES = ['EXCALIDRAW_ISSUE_AGENT', 'EXCALIDRAW_IMPLEMENT_AGENT'];

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((file) => file.split('\\').join(posix.sep));

// ─── 1. The document exists, and something points at it ───────

console.log('1. the document is there and can be walked into');

const present = tracked.includes(DOC) && existsSync(join(repoRoot, DOC));
check(`${DOC} is tracked`, present,
      'the pluggable-agent goal had no document, and a goal with no document is a goal nobody can follow');

if (!present) {
  console.error('\n1 case(s) failed');
  process.exit(1);
}

const doc = read(DOC);

for (const file of LINKING) {
  const text = read(file);
  // Relative links only. A document reached through github.com is one that stops working
  // the moment the clone is read offline.
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map(([, target]) => target.split('#')[0])
    .filter((target) => target && !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .map((target) => posix.normalize(posix.join(posix.dirname(file), target)));
  check(`${file} links ${DOC}`, links.includes(DOC),
        'it states one vendor\'s flags, so it has to say where the other shapes are');
}

// ─── 2. Every recipe is a command line somebody can paste ─────

console.log('\n2. the recipes are complete, and each one runs');

/** `NAME='<command line>'` — the shape both variables are set in everywhere else. */
const recipes = [...doc.matchAll(/^(EXCALIDRAW_(?:ISSUE|IMPLEMENT)_AGENT)='([^']+)'$/gm)]
  .map(([, role, command]) => ({ role, command }));

/** The binary a recipe spawns, as the board resolves it: argv[0], basename, no suffix. */
function binaryOf(command) {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return posix.basename(first.split('\\').join(posix.sep))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, '');
}

const byBackend = new Map();
for (const recipe of recipes) {
  const binary = binaryOf(recipe.command);
  if (!byBackend.has(binary)) byBackend.set(binary, []);
  byBackend.get(binary).push(recipe);
}

check('the document gives recipes for at least two distinct agent binaries',
      byBackend.size >= 2, `found: ${[...byBackend.keys()].join(', ') || 'none'}`);

const unknown = [...byBackend.keys()].filter((binary) => !BACKENDS[binary]);
check('every recipe names a binary this check has a rule for', unknown.length === 0,
      `${unknown.join(', ')} — add what makes it non-interactive and what grants it gh and git`);

for (const [binary, found] of byBackend) {
  const rules = BACKENDS[binary];
  if (!rules) continue;

  const roles = new Set(found.map((recipe) => recipe.role));
  check(`${binary}: both roles have a command line`,
        ROLES.every((role) => roles.has(role)),
        `missing ${ROLES.filter((role) => !roles.has(role)).join(', ')}`);

  for (const recipe of found) {
    const where = `${binary} ${recipe.role}`;
    check(`${where}: runs non-interactively`, rules.nonInteractive.test(recipe.command),
          'an agent that waits for a keystroke holds the block in running forever');
    check(`${where}: is permitted to run gh and git`, rules.permits.test(recipe.command),
          'a refused run exits 0 with no URL, which reads as an agent that had nothing to say');
    for (const demand of rules.demands) {
      if (!demand.when.test(recipe.command)) continue;
      check(`${where}: ${demand.why}`, demand.then.test(recipe.command), recipe.command);
    }
  }
}

// ─── 3. The rules that hold for the third agent too ───────────

console.log('\n3. the document states the rules, not only the two recipes');

const RULES = [
  ['it says the command must be non-interactive', /non-interactive/i],
  ['it says the agent must be allowed to run gh', /\bgh\b/],
  ['it says the agent must be allowed to run git', /\bgit\b/],
  ['it says the URL is printed last', /(URL[^.\n]*\blast\b)|(\blast\b[^.\n]*URL)/i],
  ['it says what is lost when an agent has no equivalent flag', /degrade|lost|no equivalent/i],
];

for (const [name, pattern] of RULES) check(name, pattern.test(doc));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
