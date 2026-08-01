#!/usr/bin/env node
/**
 * Checks that a Codex run's token counts arrive, and arrive counted once.
 *
 * `UsageMeter` recognised three shapes and all three were Claude Code's: `record.message.usage`,
 * a `result` event carrying `usage.iterations`, and that CLI's private
 * `{"type":"system","subtype":"thinking_tokens"}`. Codex closes a run with
 * `{"type":"turn.completed","usage":{…}}` — `usage` at the event root, under a type nothing
 * matched — so every figure a Codex run reported was dropped and the block showed a clock and no
 * numbers for the life of the run.
 *
 * ## The question this check is really about
 *
 * Not "does a number arrive" — that one is easy and it is the first case below. It is **which
 * number**, and the two CLIs read opposite ways:
 *
 *  - Claude Code's `cache_read_input_tokens` is **disjoint** from its `input_tokens`, so
 *    `countsFrom` adds the two and has to.
 *  - Codex's `cached_input_tokens` is a **share of** its `input_tokens`, so adding them counts
 *    the cached share twice. On the capture below that is 74,070 read as 140,118 — a plausible
 *    wrong figure, which is worse than none, because nothing about it looks wrong.
 *
 * The evidence for that reading is in `scripts/lib/codex-capture.mjs`: measured against the
 * capture, where six turns of `input_tokens: 12345` came back as exactly `74070` with the cached
 * share neither added nor removed, and confirmed against OpenAI's own prompt-caching guide, whose
 * worked example pairs `prompt_tokens: 2006` with `cached_tokens: 1920`.
 *
 * ## What it runs against
 *
 * A real `codex exec --json` capture — see that file's header for the version it was taken from
 * and how — fed to a real `UsageMeter` a byte at a time, so the line buffering, the throttle and
 * the settled-replaces-running rule are all in the path rather than stepped around. Beside it the
 * Claude Code shapes, so that the branch this moved behind the adapter still totals what it
 * totalled; and a backend that reports nothing, which must report null rather than zero, because
 * `RunProgress` draws a clock alone for null and `0 in · 0 out` for zero.
 *
 * Self-contained and offline: no agent, no server, no browser. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-agent-usage-codex.mjs
 *
 * Tier: fast
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CODEX_CAPTURE, CODEX_CAPTURE_STREAM, CODEX_CAPTURE_TOTALS, CODEX_CLI_VERSION,
} from './lib/codex-capture.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  the built server exists — dist/${relative.replace(/\\/g, '/')} not found`);
    console.error('        (run ./node_modules/.bin/tsc first)');
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const { UsageMeter } = await importDist(join('core', 'agent-usage.js'));
const { adapterFor } = await importDist(join('core', 'agents', 'index.js'));

/**
 * Every report one stream produced, through a real meter.
 *
 * Fed in small pieces on purpose: a `turn.completed` line cut in half is what a socket does, and
 * a meter that read chunks rather than lines would drop the only event that carries the figures.
 * The interval is 0 so the throttle never withholds the last report from a check.
 */
function meter(stream, backend, chunkSize = 37) {
  const reports = [];
  const usage = new UsageMeter(
    (one) => reports.push(one), 0, backend ? adapterFor(backend) : null
  );
  for (let at = 0; at < stream.length; at += chunkSize) {
    usage.take(stream.slice(at, at + chunkSize));
  }
  usage.flush();
  return { reports, last: reports[reports.length - 1] ?? null };
}

console.log(`\nA captured codex exec --json stream (codex-cli ${CODEX_CLI_VERSION})`);

const codex = meter(CODEX_CAPTURE_STREAM, 'codex-cli');

check('the run reports figures at all, rather than a clock and nothing',
      Boolean(codex.last) && codex.last.inputTokens > 0 && codex.last.outputTokens > 0,
      JSON.stringify(codex.last));

// ─── 1. counted once ──────────────────────────────────────────

console.log('\n1. the cached share is counted once, because it is a share and not a second figure');

const doubled = CODEX_CAPTURE_TOTALS.input + CODEX_CAPTURE_TOTALS.cachedInput;

check('the input total is what the run said its input was',
      codex.last?.inputTokens === CODEX_CAPTURE_TOTALS.input,
      `${codex.last?.inputTokens} — the run reported ${CODEX_CAPTURE_TOTALS.input}`);
check('and not that figure with its own cached share added on top of it',
      codex.last?.inputTokens !== doubled,
      `${codex.last?.inputTokens} is ${CODEX_CAPTURE_TOTALS.input} + `
      + `${CODEX_CAPTURE_TOTALS.cachedInput}, so the cached share is being counted twice`);
check('the output total is the run\'s own',
      codex.last?.outputTokens === CODEX_CAPTURE_TOTALS.output,
      `${codex.last?.outputTokens} — the run reported ${CODEX_CAPTURE_TOTALS.output}`);

// `reasoning_output_tokens` is on the wire in this release, which the issue this came from
// expected it not to be. It is a decomposition of the output and never an addition to it, so it
// has to be inside the figure beside it rather than pushing it up.
check('the reasoning share is read, rather than reported as silence',
      codex.last?.thinkingTokens === CODEX_CAPTURE_TOTALS.reasoning,
      String(codex.last?.thinkingTokens));
check('and it is a share of the output rather than a fifth bucket',
      codex.last?.thinkingTokens <= codex.last?.outputTokens,
      `${codex.last?.thinkingTokens} of ${codex.last?.outputTokens}`);

// ─── 2. nothing else in the stream moves the totals ───────────

console.log('\n2. the closing accounting is the whole of it, and it replaces rather than adds');

const beforeClose = CODEX_CAPTURE.filter((line) => !line.includes('turn.completed'));
const partial = meter(`${beforeClose.join('\n')}\n`, 'codex-cli');
check('a run that has not closed yet reports nothing at all',
      partial.reports.length === 0,
      JSON.stringify(partial.last));

// Twice, because `codex exec` is one turn and a `usage` that turned out to be cumulative would be
// added to itself by a meter that accumulated. Settled means the last one wins.
const twice = meter(`${CODEX_CAPTURE_STREAM}${CODEX_CAPTURE_STREAM}`, 'codex-cli');
check('the same accounting arriving twice is not twice the total',
      twice.last?.inputTokens === CODEX_CAPTURE_TOTALS.input,
      String(twice.last?.inputTokens));

// ─── 3. what the other backends still do ──────────────────────

console.log('\n3. Claude Code totals what it totalled, and the two readings stay opposite');

// The shapes are Claude Code's own, from the capture `agent-usage.ts` records: an assistant
// message re-sent as it grows, and a `result` carrying the run's own accounting. Its cache fields
// are disjoint from `input_tokens`, so 1000 + 2000 + 500 is the answer and 1000 is not.
const CLAUDE = [
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 2 } } },
  { type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 39 } } },
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 },
  {
    type: 'result',
    usage: {
      input_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 2000,
      output_tokens: 300,
    },
  },
];
const claudeStream = `${CLAUDE.map((event) => JSON.stringify(event)).join('\n')}\n`;

const byName = meter(claudeStream, 'claude-code');
const byDefault = meter(claudeStream, null);
const byRaw = meter(claudeStream, 'raw');

check('a Claude Code run still adds its two cache fields into the input',
      byName.last?.inputTokens === 3500 && byName.last?.outputTokens === 300,
      JSON.stringify(byName.last));
check('and a caller with no backend to name gets exactly the same totals',
      JSON.stringify(byDefault.last) === JSON.stringify(byName.last)
      && JSON.stringify(byRaw.last) === JSON.stringify(byName.last),
      `${JSON.stringify(byDefault.last)} / ${JSON.stringify(byRaw.last)}`);
check('its reasoning is still the estimate its own events carry',
      byName.last?.thinkingTokens === 50, String(byName.last?.thinkingTokens));

// The proof that the two readings are two: each backend's own closing event says nothing to the
// other one, so neither is quietly tolerant of the other's shape.
const codexByClaude = meter(CODEX_CAPTURE_STREAM, 'claude-code');
const claudeByCodex = meter(claudeStream, 'codex-cli');
check('a Codex stream read as Claude Code\'s reports nothing rather than a wrong figure',
      codexByClaude.reports.length === 0, JSON.stringify(codexByClaude.last));
check('and a Claude Code stream read as Codex\'s does the same',
      claudeByCodex.reports.length === 0, JSON.stringify(claudeByCodex.last));

// ─── 4. a backend that says nothing says null ─────────────────

console.log('\n4. silence is null, which is not the figure zero');

const quiet = meter('warning: this command streams prose\nand more prose\n', 'codex-cli');
check('a stream with no accounting in it reports nothing at all',
      quiet.reports.length === 0, JSON.stringify(quiet.reports));

// A run that reported input and output but never broke its output down has not claimed its
// reasoning was zero, and `RunProgress` draws the split only when there is one.
const noReasoning = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 40 },
});
const unsplit = meter(`${noReasoning}\n`, 'codex-cli');
check('a run that reported no reasoning reports null for it, not 0',
      unsplit.last?.thinkingTokens === null,
      JSON.stringify(unsplit.last));
check('and its other two figures are still its own',
      unsplit.last?.inputTokens === 120 && unsplit.last?.outputTokens === 40,
      JSON.stringify(unsplit.last));

// ─── Done ─────────────────────────────────────────────────────

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
