#!/usr/bin/env node
/**
 * Checks that the issue agent's documented allowlist grants what the prose beside it says.
 *
 * `docs/trap-allowed-tools.md` carried `Bash(gh:*) Bash(git:*)` under the sentence "the agent
 * opens issues; it does not touch the repository". A rule naming a binary grants every
 * sub-command of it: `git commit`, `git push --force`, `git config`, `gh repo delete`,
 * `gh issue develop` — which creates a branch — and `gh api -X DELETE` against anything the
 * operator's credentials reach. The agent is pointed at repository text and at the open web
 * and told to follow what it finds, so that gap was between what an operator was promised and
 * what an operator got, in the one document written to be believed about permissions.
 *
 * The allowlist itself is not in this repository — it lives in whatever starts the board, the
 * same way `check-agent-research.mjs` says the prompts are here and the command line is not.
 * What is here is the documented default an operator copies, and the claims printed next to
 * it. So this check is a lint over one document's internal consistency: it parses the list out
 * of the command line the document ships and holds every claim in the document to it.
 *
 * **The permission rule is the CLI's, and it was confirmed by running it** rather than
 * remembered, because the whole fix rests on sub-command scoping actually being honoured:
 *
 *  - `--allowedTools "Bash(gh issue:*)"` runs `gh issue list` and refuses `gh repo view`;
 *  - `--allowedTools "Bash(git log:*)"` refuses `git commit --allow-empty -m x`;
 *  - and it refuses `git log --oneline && git commit --allow-empty -m x`, so a compound
 *    command is judged per segment rather than by its first word.
 *
 * Every one of those refusals exits 0 with no result, which is the trap the document is about
 * and the cost of narrowing: `permits()` below implements exactly that rule, so a list that
 * would silently refuse something the agent's own prompt tells it to run fails here instead.
 *
 * Offline and self-contained. No server, no browser.
 *
 * Tier: fast
 *
 * Usage: node scripts/check-issue-agent-allowlist.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const trapPath = join(repoRoot, 'docs', 'trap-allowed-tools.md');
const blockPath = join(repoRoot, 'docs', 'issue-block.md');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

// The server's own tokeniser, so the list is read out of the documented command line the way
// the spawn reads it — quotes consumed, the quoted run kept whole.
const { ISSUE_AGENT_PROMPT, ISSUE_REVISE_PROMPT, tokenizeCommand } =
  await importDist(join('core', 'issue-agent.js'), 'the issue agent');

const trap = readFileSync(trapPath, 'utf8');
const block = readFileSync(blockPath, 'utf8');

/**
 * The `--allowedTools` argument of the `EXCALIDRAW_ISSUE_AGENT` line in a document.
 *
 * The line is shipped inside single quotes, as an operator pastes it, so the outer quoting
 * comes off first and what is left is a command line `tokenizeCommand` understands.
 */
function documentedAllowlist(source) {
  const line = source.split(/\r?\n/).find((l) => l.includes('EXCALIDRAW_ISSUE_AGENT=')
                                                 && l.includes('--allowedTools'));
  if (!line) return null;
  const command = line.slice(line.indexOf('=') + 1).trim().replace(/^'|'$/g, '');
  const argv = tokenizeCommand(command);
  const at = argv.indexOf('--allowedTools');
  if (at < 0 || at + 1 >= argv.length) return null;
  // Split on the parentheses rather than on whitespace: a scoped rule has spaces *inside* it,
  // `Bash(gh issue list:*)`, and a whitespace split shatters every one of them into three
  // rules that match nothing. Confirmed to be what the CLI does too — a list of four such
  // rules in one argument runs `gh issue list` and still refuses `gh repo view`.
  return argv[at + 1].match(/[A-Za-z_]\w*\([^)]*\)|\S+/g) ?? [];
}

/**
 * Whether a permission list allows a command line, by the rule confirmed above.
 *
 * `Bash(x:*)` matches a command that is `x` or begins `x `; `Bash(x)` matches only `x`. A
 * compound command has to have every segment allowed, which is what the CLI does and what
 * makes `Bash(git log:*)` a real refusal of `git log && git push` rather than a first-word
 * check anything can walk past.
 */
function permits(rules, command) {
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean);
  return segments.every((segment) => rules.some((rule) => {
    const named = /^Bash\((.*)\)$/.exec(rule);
    if (!named) return false;
    const pattern = named[1];
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2);
      return segment === prefix || segment.startsWith(`${prefix} `);
    }
    return segment === pattern;
  }));
}

/** The first backticked command of every row of the table under a heading. */
function tableCommands(source, heading) {
  const start = source.indexOf(heading);
  if (start < 0) return null;
  const rest = source.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  const body = end < 0 ? rest : rest.slice(0, end);
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const first = line.split('|')[1] ?? '';
    const command = /`([^`]+)`/.exec(first);
    if (command) rows.push(command[1]);
  }
  return rows;
}

/**
 * The capabilities the surrounding prose denies, in the words of the issue that found them.
 *
 * Held here as well as parsed out of the document, because a table is only evidence while it
 * still has the rows that matter: deleting the `git push --force` row would otherwise make
 * the document self-consistent and the check green, which is the failure this replaces rather
 * than a different one.
 */
const MUST_REFUSE = [
  'git commit -m x',
  'git push --force',
  'git config user.email nobody@example.com',
  'gh api -X DELETE repos/vitorengers/vibemaxxing/git/refs/heads/main',
  'gh repo delete vitorengers/vibemaxxing --yes',
  'gh issue develop 1 --checkout',
];

console.log('1. the documented default carries a list at all');
const rules = documentedAllowlist(trap);
check('docs/trap-allowed-tools.md ships an EXCALIDRAW_ISSUE_AGENT line with --allowedTools',
      rules !== null && rules.length > 0);
if (!rules) { console.error('\n1 case(s) failed'); process.exit(1); }
console.log(`        ${rules.join(' ')}`);

console.log('\n2. every capability the prose denies is absent from it');
for (const command of MUST_REFUSE) {
  check(`refuses \`${command}\``, !permits(rules, command),
        'the list grants a whole binary, so the sentence beside it is not true');
}

console.log('\n3. the document states those denials where a reader will meet them');
const refused = tableCommands(trap, '### What the list refuses') ?? [];
check('docs/trap-allowed-tools.md has a table of what the list refuses', refused.length > 0,
      'a claim with nothing under it is the shape this check exists for');
for (const command of MUST_REFUSE) {
  // The leading run of bare words, which is the sub-command: everything from the first flag
  // or argument on is this check's example rather than the capability being denied.
  const verb = [];
  for (const word of command.split(/\s+/)) {
    if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
    verb.push(word);
  }
  const named = verb.join(' ');
  check(`the table names \`${named}\``,
        refused.some((row) => row === named || row.startsWith(`${named} `)),
        `no row of the refused table begins \`${named}\``);
}
for (const command of refused) {
  check(`the table's own row \`${command}\` really is refused`, !permits(rules, command),
        'the document denies something the list permits');
}

console.log('\n4. and it permits what the agent is actually told to run');
const permitted = tableCommands(trap, '### What the list permits') ?? [];
check('docs/trap-allowed-tools.md has a table of what the list permits', permitted.length > 0);
for (const command of permitted) {
  check(`the table's own row \`${command}\` really is permitted`, permits(rules, command),
        'narrowing that refuses this is the silent-refusal trap, one document along');
}

// The prompts are in this repository even though the list is not, so the commands they name
// are the one part of "what the agent needs" that can be read rather than asserted.
const named = new Set();
for (const prompt of [ISSUE_AGENT_PROMPT, ISSUE_REVISE_PROMPT]) {
  for (const [, quoted] of prompt.matchAll(/`(gh [^`]+)`/g)) named.add(quoted.trim());
}
check('the prompts name commands to run', named.size > 0);
for (const command of named) {
  check(`the prompt's \`${command}\` is permitted`, permits(rules, command),
        'the agent is ordered to run it and would be refused, silently, exiting 0');
}

console.log('\n5. the other document describing these powers says the same thing');
const elsewhere = documentedAllowlist(block);
check('docs/issue-block.md ships the same allowlist, rule for rule',
      elsewhere !== null && elsewhere.length === rules.length
      && elsewhere.every((rule, i) => rule === rules[i]),
      `found ${elsewhere ? elsewhere.join(' ') : '(no EXCALIDRAW_ISSUE_AGENT line)'}`);

// The list was quoted a second time in that document's prose, and prose is where a copy goes
// stale unnoticed: the paragraph on sub-agents recited the whole list to say what was missing
// from it. Any rule spelled out anywhere in either document has to be one of these — except a
// placeholder, `Bash(<binary> <verb>:*)`, which is how an operator is told the shape to widen
// by, and except the rules the confirmation runs at the end of the trap document quote, which
// are narrower lists fed to the CLI to see what it did with them.
const granted = new Set(rules);
const confirmation = trap.indexOf('confirmed by running the CLI');
const prose = confirmation < 0 ? trap : trap.slice(0, confirmation);
for (const [name, source] of [['trap-allowed-tools.md', prose], ['issue-block.md', block]]) {
  const stale = [...source.matchAll(/Bash\([^)]*\)/g)]
    .map((m) => m[0])
    .filter((rule) => !/[<>]/.test(rule) && !granted.has(rule));
  check(`${name} spells out no rule the list does not have`, stale.length === 0,
        `found ${stale.join(' ')}`);
}

console.log('\n6. neither document claims a reach the list does not deny');
for (const [name, source] of [['trap-allowed-tools.md', trap], ['issue-block.md', block]]) {
  check(`${name} does not say the agent "does not touch the repository"`,
        !/does not touch the repositor/i.test(source),
        'true only of a list that refuses every write, and said of one that refused none');
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
