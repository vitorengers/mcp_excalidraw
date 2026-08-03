#!/usr/bin/env node
/**
 * Checks that a founder chat can read and answer, and cannot file or edit anything on GitHub.
 *
 * The chat runs a coding agent against a founder's free-typed question. Handed the issue role's
 * grant as it stands, it inherits `Bash(gh issue create:*)`, `Bash(gh issue edit:*)`,
 * `Bash(gh issue comment:*)` and `Bash(gh project item-add:*)` — every one of them unscoped to
 * any issue number, because nothing in that allow-list grammar can express "only issue #N". An
 * agent that decides the right answer to "which plan should I buy?" is to open a tracking issue
 * will open one, and the board's own habit is to move a created issue into the column the
 * implement queue drains. That is a coding agent started by a question nobody reviewed.
 *
 * `withoutGhWrites` is the narrowing that closes it, and it is a narrowing of one *invocation*
 * rather than a fourth `AgentRole` — see its comment for what a role would have cost. The cases
 * below are its contract:
 *
 *  1. **the grant it is given really does reach those writes**, which is the control: a check
 *     whose "before" already refused them would go green against a helper that does nothing;
 *  2. **every one of them is gone afterwards, verb by verb**, and every read the agent is told
 *     to run survives — a refused read is the silent-exit-0 trap `docs/trap-allowed-tools.md`
 *     is about, so narrowing that took `gh issue list` with it would be a different defect;
 *  3. **it never widens** — no rule that was not in the input appears in the output, and
 *     nothing outside the list is touched;
 *  4. **a `codex-cli` invocation yields the read-only sandbox** rather than silently doing
 *     nothing, because that CLI grants a mode and not a list;
 *  5. **a `raw` board reports that it could not narrow**, since it writes no permission flags
 *     at all, and so does a board whose operator pinned their own posture — in both cases the
 *     chat has to be refused rather than run with a grant this board never wrote;
 *  6. **`implementFullAccess` changes nothing about it**, because that opt-in reaches the
 *     implement role alone, at the single call site in `agentRunFor`.
 *
 * **The realised argv is what is asserted**, never `AGENT_PERMISSIONS` or the exported list. A
 * check that read the constant would pass on a build where the adapter had stopped writing it,
 * and the constant is not what a process is spawned with.
 *
 * The permission rule is Claude Code's own and was confirmed by running that CLI rather than
 * remembered — `docs/trap-allowed-tools.md` records the runs. `permits` below is that rule:
 * `Bash(x:*)` matches a command that is `x` or begins `x `, a bare `Bash(x)` matches only `x`,
 * and a compound command needs every segment allowed.
 *
 * Offline and self-contained: the compiled adapters in this process, no server, no browser, no
 * GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-chat-posture.mjs
 *
 * Tier: fast
 */

// Before anything imports the settings module, which folds a `.env` and a `config.json` into
// `process.env` on import: this check sets `IMPLEMENT_FULL_ACCESS` itself and must not inherit
// the operator's real one either way round.
process.env.VIBEMAXXING_NO_DOTENV = '1';
process.env.EXCALIDRAW_NO_DOTENV = '1';
delete process.env.VIBEMAXXING_IMPLEMENT_FULL_ACCESS;
delete process.env.EXCALIDRAW_IMPLEMENT_FULL_ACCESS;

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const adapterModule = await importDist(join('core', 'agent-adapter.js'), 'the agent adapter');
const { adapterFor } = await importDist(join('core', 'agents', 'index.js'), 'the adapter registry');
const { agentRunFor, implementFullAccess } =
  await importDist(join('core', 'issue-agent.js'), 'the issue agent');

const { withoutGhWrites } = adapterModule;

/**
 * The commands a founder chat must not be able to run, spelled out here rather than imported.
 *
 * A check that took its expectations from the module it checks would pass whatever that module
 * happened to decide. One row per verb, so that a verb added to the issue grant is one line
 * here — which is the whole shape of this list.
 *
 * `granted` is whether the *unnarrowed* grant reaches it, and it is what section 1 iterates.
 * Four of these are in the issue agent's list today; the last two are not, and are named anyway
 * because `gh project` is taken away bare — a verb that CLI grows tomorrow, or a rule somebody
 * widens to `Bash(gh project:*)`, must not walk back in unnoticed.
 */
const MUST_REFUSE = [
  { verb: 'gh issue create', granted: true, command: 'gh issue create --title x --body-file -' },
  { verb: 'gh issue edit', granted: true, command: 'gh issue edit 543 --body-file -' },
  { verb: 'gh issue comment', granted: true, command: 'gh issue comment 543 --body-file -' },
  { verb: 'gh project item-add', granted: true,
    command: 'gh project item-add 5 --owner vitorengers --url https://github.com/x/y/issues/1' },
  { verb: 'gh project item-create', granted: false,
    command: 'gh project item-create 5 --owner vitorengers --title x' },
  { verb: 'gh project item-edit', granted: false,
    command: 'gh project item-edit --id x --field-id y --text z' },
];

/**
 * And what it must still be able to do, because a refused read is the trap one document along.
 *
 * The chat exists to answer a founder's question about a blocker the board detected. An agent
 * that cannot read the issue it is being asked about answers from nothing, silently, exiting 0.
 */
const MUST_KEEP = [
  { verb: 'gh issue list', command: 'gh issue list --state open' },
  { verb: 'gh issue view', command: 'gh issue view https://github.com/x/y/issues/1 --comments' },
  { verb: 'git log', command: 'git log --oneline -20' },
  { verb: 'git show', command: 'git show abc1234' },
  { verb: 'git diff', command: 'git diff abc1234..def5678' },
  { verb: 'git blame', command: 'git blame src/server.ts' },
];

/** The bare tool names the chat reads and researches with, which are not `Bash` rules. */
const MUST_KEEP_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

/** The value of a flag on an argv, in either spelling, or null. */
function valueOf(argv, name) {
  const at = argv.indexOf(name);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  const joined = argv.find((argument) => argument.startsWith(`${name}=`));
  return joined ? joined.slice(name.length + 1) : null;
}

/** The permission list an argv carries, in either flag spelling, or null. */
const listOf = (argv) => valueOf(argv, '--allowedTools') ?? valueOf(argv, '--allowed-tools');

/**
 * The rules of a permission list, split on the parentheses.
 *
 * A scoped rule has spaces inside it — `Bash(gh issue list:*)` — so a whitespace split shatters
 * every one of them into three rules that match nothing.
 */
const rulesOf = (list) => (list ?? '').match(/[A-Za-z_]\w*\([^)]*\)|\S+/g) ?? [];

/** Whether a permission list allows a command line, by the CLI's own rule. */
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

/** One realised invocation, as the board would build it for a chat turn. */
function invocationFor(backend, command, extra = {}) {
  return adapterFor(backend).invoke({ mode: 'headless', role: 'issue', command, ...extra });
}

// ─── 0. is there a narrowing to ask about ─────────────────────

console.log('0. the adapter publishes the narrowing a founder chat needs');
check('withoutGhWrites is exported', typeof withoutGhWrites === 'function',
      'dist/core/agent-adapter.js exports no withoutGhWrites');
if (typeof withoutGhWrites !== 'function') { console.error('\n1 case(s) failed'); process.exit(1); }

// ─── 1. the grant it is handed really does reach the writes ───

console.log('\n1. the issue grant a chat would inherit reaches every one of those writes');
const claude = invocationFor('claude-code', 'claude');
/** The argv exactly as the adapter built it, kept so that a mutation of it can be seen. */
const asGiven = [...claude.args];
const before = rulesOf(listOf(claude.args));
check('a claude-code issue run carries a permission list at all', before.length > 0,
      JSON.stringify(claude.args));
for (const { verb, command, granted } of MUST_REFUSE) {
  if (!granted) continue;
  check(`unnarrowed, it permits \`${verb}\``, permits(before, command),
        'the control failed: this check would go green against a helper that does nothing');
}

// ─── 2. and the narrowed run reaches none of them ─────────────

console.log('\n2. narrowed, every gh write is gone and every read is still there');
const narrowed = withoutGhWrites(claude.args);
check('the helper reports that it narrowed the run', narrowed.narrowed === true,
      JSON.stringify(narrowed.reason));
const after = rulesOf(listOf(narrowed.args));
check('and the narrowed argv still carries a permission list', after.length > 0,
      JSON.stringify(narrowed.args));

for (const { verb, command } of MUST_REFUSE) {
  check(`it refuses \`${verb}\``, !permits(after, command),
        `the founder chat could still run \`${command}\` — the list is ${after.join(' ')}`);
}
for (const { verb, command } of MUST_KEEP) {
  check(`and still permits \`${verb}\``, permits(after, command),
        'a refused read is the silent exit-0 trap, and the chat answers from nothing');
}
for (const tool of MUST_KEEP_TOOLS) {
  check(`and keeps \`${tool}\``, after.includes(tool), `the list is ${after.join(' ')}`);
}

// ─── 3. it never widens ───────────────────────────────────────

console.log('\n3. it only ever removes');
const appeared = after.filter((rule) => !before.includes(rule));
check('no rule the input did not have appears in the output', appeared.length === 0,
      `added ${appeared.join(' ')}`);
check('and the narrowed list is genuinely shorter', after.length < before.length,
      `${before.length} rule(s) before, ${after.length} after`);
check('the argv is the same length', narrowed.args.length === claude.args.length,
      `${claude.args.length} before, ${narrowed.args.length} after`);
{
  const list = listOf(claude.args);
  const untouched = claude.args
    .map((argument, at) => (argument === list ? null : [at, argument]))
    .filter(Boolean)
    .every(([at, argument]) => narrowed.args[at] === argument);
  check('and every argument that is not the list is untouched', untouched,
        JSON.stringify(narrowed.args));
}
check('and the argv it was given is not written into',
      JSON.stringify(claude.args) === JSON.stringify(asGiven),
      'withoutGhWrites mutated the array it was handed, so a caller that kept it has the narrowed one');

// ─── 4. the other named backend grants a mode, not a list ─────

console.log('\n4. a codex-cli invocation yields the read-only sandbox');
{
  const codex = invocationFor('codex-cli', 'codex');
  const result = withoutGhWrites(codex.args);
  check('the helper reports that it narrowed the run', result.narrowed === true,
        JSON.stringify(result.reason));
  check('and the argv it hands back is a read-only sandbox',
        valueOf(result.args, '--sandbox') === 'read-only' || valueOf(result.args, '-s') === 'read-only',
        JSON.stringify(result.args));
  check('which is a mode with no network in it, so gh cannot reach github.com at all',
        !result.args.includes('workspace-write') && !result.args.includes('danger-full-access'),
        JSON.stringify(result.args));
}

// ─── 5. the boards where it can do nothing say so ─────────────

console.log('\n5. where there is no grant of this board\'s to narrow, it refuses instead');
{
  const raw = adapterFor('raw').invoke({
    mode: 'headless', role: 'issue', command: 'claude -p --output-format stream-json --verbose',
  });
  const result = withoutGhWrites(raw.args);
  check('raw: the helper reports that it could not narrow', result.narrowed === false,
        JSON.stringify(result.args));
  check('raw: and it says why, so a refusal has something to print',
        typeof result.reason === 'string' && result.reason.trim().length > 0,
        JSON.stringify(result.reason));
  check('raw: and the argv comes back unchanged',
        JSON.stringify(result.args) === JSON.stringify(raw.args), JSON.stringify(result.args));
}
{
  // The operator pinned their own list, so `permissionArgs` wrote nothing and the grant on the
  // argv is theirs. Narrowing it would be this board overruling a posture it was handed.
  const pinned = invocationFor('claude-code', 'claude --allowedTools "Bash(gh:*) Read"');
  const result = withoutGhWrites(pinned.args);
  check('a pinned --allowedTools: the helper reports that it could not narrow',
        result.narrowed === false, JSON.stringify(result.args));
  check('and the operator\'s own list is handed back untouched',
        listOf(result.args) === 'Bash(gh:*) Read', JSON.stringify(result.args));
}
{
  const mode = invocationFor('claude-code', 'claude --permission-mode acceptEdits');
  const result = withoutGhWrites(mode.args);
  check('a pinned --permission-mode: the helper reports that it could not narrow',
        result.narrowed === false, JSON.stringify(result.args));
}
{
  const wide = invocationFor('codex-cli', 'codex exec --sandbox workspace-write');
  const result = withoutGhWrites(wide.args);
  check('a pinned --sandbox workspace-write: the helper reports that it could not narrow',
        result.narrowed === false, JSON.stringify(result.args));
}

// ─── 6. no setting makes a chat a full-access run ─────────────

console.log('\n6. implementFullAccess changes nothing about a run narrowed this way');
{
  const agent = { backend: 'claude-code', command: 'claude' };
  const plain = agentRunFor(agent, 'issue', null).invocation;
  const plainNarrowed = withoutGhWrites(plain.args);

  process.env.VIBEMAXXING_IMPLEMENT_FULL_ACCESS = '1';
  check('the opt-in is on for this part of the check', implementFullAccess() === true,
        'the setting did not reach the module, so the case below proves nothing');
  const opted = agentRunFor(agent, 'issue', null).invocation;
  const optedNarrowed = withoutGhWrites(opted.args);
  delete process.env.VIBEMAXXING_IMPLEMENT_FULL_ACCESS;

  check('the built issue-role argv is the same either way',
        JSON.stringify(opted.args) === JSON.stringify(plain.args),
        `${JSON.stringify(plain.args)} vs ${JSON.stringify(opted.args)}`);
  check('and so is the narrowed one',
        JSON.stringify(optedNarrowed.args) === JSON.stringify(plainNarrowed.args)
        && optedNarrowed.narrowed === plainNarrowed.narrowed,
        JSON.stringify(optedNarrowed.args));
  check('and it carries no full-access marker',
        !opted.args.includes('--dangerously-skip-permissions'), JSON.stringify(opted.args));
  const optedRules = rulesOf(listOf(optedNarrowed.args));
  for (const { verb, command } of MUST_REFUSE) {
    check(`and still refuses \`${verb}\``, !permits(optedRules, command),
          JSON.stringify(optedNarrowed.args));
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
