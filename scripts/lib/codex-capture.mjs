/**
 * One real `codex exec --json` stream, kept whole, and the record of how it was taken.
 *
 * `scripts/check-agent-stream-render.mjs` records in its own header that its Claude Code fixtures
 * were copied from a real capture rather than invented, and that is the standard this file exists
 * to hold the second backend to. A renderer written from a CLI's documentation renders the
 * documentation: it is right about the field names somebody wrote down and wrong about everything
 * they left out — which of `item.started` and `item.completed` carries the output, whether a
 * failed command says so in `status` or in `exit_code`, whether `web_search` spells its query at
 * the top of the item or only inside `action`. Every one of those is answered below, by the
 * binary, rather than by a sentence about the binary.
 *
 * ## Where it came from
 *
 * **codex-cli 0.146.0**, the real binary out of `@openai/codex`, run on Windows as
 *
 *     codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
 *       "Run the tests and update the note."
 *
 * with a `CODEX_HOME` of its own naming one MCP server over stdio and one **stub model
 * provider**: a loopback HTTP server answering `POST /v1/responses` with a canned Responses API
 * stream, so that a capture could be taken with no account, no key and no network.
 *
 * What that stubs is the *model* — the words it chose, the commands it asked for, the figures it
 * reported. Everything below is Codex's own. It ran those commands itself through PowerShell,
 * applied that patch itself through its own `apply_patch`, called that MCP tool itself over
 * stdio, and wrote every envelope here itself. The version is recorded because this schema has
 * churned: releases before the `item.*` vocabulary emitted `{"id":…,"msg":{"type":…}}` instead,
 * so a capture with no version on it is a capture nobody can re-take or compare against.
 *
 * ## What is in it, and what that settles
 *
 * Every item type this release has — `error`, `reasoning`, `command_execution` both completed
 * **and failed**, `file_change`, `mcp_tool_call`, `web_search`, `todo_list` and `agent_message` —
 * inside `thread.started` → `turn.started` → `turn.completed`. Four things it settles that
 * documentation left open:
 *
 *  - **A step is announced twice.** `item.started` carries `aggregated_output: ""` and
 *    `exit_code: null`; only `item.completed` has the answer. A renderer drawing both would draw
 *    every command twice, once with no output under it.
 *  - **A failed command says so in both places**, `exit_code: 1` *and* `status: "failed"`.
 *  - **`reasoning_output_tokens` is on the wire**, which the issue this came from expected it not
 *    to be — see `CODEX_CAPTURE_TOTALS`.
 *  - **The items do not complete in the order they were started**: `item_5`, the plan, completes
 *    after `item_6`, `item_7` and `item_8`. That is Codex's own interleaving, kept, because
 *    pairing a step with its answer by position is exactly what it breaks.
 *
 * Shared by three checks rather than pasted into each, because a fixture copied is a fixture that
 * drifts, and the whole point of this one is that it is the bytes a program wrote.
 */

/** The release this was taken from, and the release a re-capture has to be compared against. */
export const CODEX_CLI_VERSION = '0.146.0';

/** The stream, line for line, as `codex exec --json` wrote it to stdout. */
export const CODEX_CAPTURE = [
  "{\"type\":\"thread.started\",\"thread_id\":\"019fbe5e-795d-7dd1-af96-f950b3937352\"}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"Model metadata for `stub-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\"}}",
  "{\"type\":\"turn.started\"}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"reasoning\",\"text\":\"**Looking at the repository**\"}}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_2\",\"type\":\"command_execution\",\"command\":\"\\\"C:\\\\\\\\WINDOWS\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\\" -Command \\\"node -e \\\\\\\"console.log('all cases passed')\\\\\\\"\\\"\",\"aggregated_output\":\"\",\"exit_code\":null,\"status\":\"in_progress\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_2\",\"type\":\"command_execution\",\"command\":\"\\\"C:\\\\\\\\WINDOWS\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\\" -Command \\\"node -e \\\\\\\"console.log('all cases passed')\\\\\\\"\\\"\",\"aggregated_output\":\"all cases passed\\n\",\"exit_code\":0,\"status\":\"completed\"}}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_3\",\"type\":\"command_execution\",\"command\":\"\\\"C:\\\\\\\\WINDOWS\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\\" -Command \\\"node -e \\\\\\\"console.error('lint failed: 2 problems'); process.exit(1)\\\\\\\"\\\"\",\"aggregated_output\":\"\",\"exit_code\":null,\"status\":\"in_progress\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_3\",\"type\":\"command_execution\",\"command\":\"\\\"C:\\\\\\\\WINDOWS\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\\" -Command \\\"node -e \\\\\\\"console.error('lint failed: 2 problems'); process.exit(1)\\\\\\\"\\\"\",\"aggregated_output\":\"lint failed: 2 problems\\n\",\"exit_code\":1,\"status\":\"failed\"}}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_4\",\"type\":\"file_change\",\"changes\":[{\"path\":\"C:\\\\Users\\\\Public\\\\codex-capture\\\\work\\\\notes.txt\",\"kind\":\"update\"}],\"status\":\"in_progress\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_4\",\"type\":\"file_change\",\"changes\":[{\"path\":\"C:\\\\Users\\\\Public\\\\codex-capture\\\\work\\\\notes.txt\",\"kind\":\"update\"}],\"status\":\"completed\"}}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_5\",\"type\":\"todo_list\",\"items\":[{\"text\":\"run the suite\",\"completed\":true},{\"text\":\"update the note\",\"completed\":false}]}}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_6\",\"type\":\"mcp_tool_call\",\"server\":\"notes\",\"tool\":\"lookup\",\"arguments\":{\"name\":\"notes.txt\"},\"result\":null,\"error\":null,\"status\":\"in_progress\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_6\",\"type\":\"mcp_tool_call\",\"server\":\"notes\",\"tool\":\"lookup\",\"arguments\":{\"name\":\"notes.txt\"},\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"the note says: one and a half\"}],\"structured_content\":null},\"error\":null,\"status\":\"completed\"}}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_7\",\"type\":\"web_search\",\"id\":\"ws_1\",\"query\":\"codex exec json schema\",\"action\":{\"type\":\"search\",\"query\":\"codex exec json schema\"}}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_7\",\"type\":\"web_search\",\"id\":\"ws_1\",\"query\":\"codex exec json schema\",\"action\":{\"type\":\"search\",\"query\":\"codex exec json schema\"}}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_8\",\"type\":\"agent_message\",\"text\":\"The suite passes and the note is updated: https://github.com/vitorengers/vibemaxxing/pull/333\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_5\",\"type\":\"todo_list\",\"items\":[{\"text\":\"run the suite\",\"completed\":true},{\"text\":\"update the note\",\"completed\":false}]}}",
  "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":74070,\"cached_input_tokens\":66048,\"cache_write_input_tokens\":0,\"output_tokens\":3852,\"reasoning_output_tokens\":2688}}",
];

/** The same stream as one stdout would deliver it, newline terminated. */
export const CODEX_CAPTURE_STREAM = `${CODEX_CAPTURE.join('\n')}\n`;

/** The pull request URL the captured run announced, which a transcript must not break. */
export const CODEX_CAPTURE_URL = 'https://github.com/vitorengers/vibemaxxing/pull/333';

/**
 * The figures the closing `turn.completed` reports, and the reading each one is.
 *
 * `cachedInput` is a **share of** `input`, not a figure beside it, and that is the one thing here
 * worth measuring rather than assuming: Claude Code's `cache_read_input_tokens` is disjoint from
 * its `input_tokens` and is added to it, so the two CLIs read opposite ways and a meter that
 * guessed would show a plausible wrong number rather than no number, which is worse.
 *
 * Two pieces of evidence, and they are independent.
 *
 * **Measured in this capture.** The stub reported `input_tokens: 12345` with
 * `input_tokens_details.cached_tokens: 11008` on each of six turns, and Codex closed the run with
 * `input_tokens: 74070` — six times 12345 exactly, with nothing added and nothing taken off. So
 * `cached_input_tokens` is whatever the API called cached and `input_tokens` is whatever the API
 * called input; Codex passes both through and sums them per turn.
 *
 * **And the API says which of the two contains the other.** OpenAI's prompt caching guide
 * documents `cached_tokens` as how many *input* tokens were read from cache, and its own worked
 * example pairs `prompt_tokens: 2006` with `cached_tokens: 1920` — a share of the input, billed
 * at a discount, never an addition to it.
 *
 * `reasoning` is the third figure, and it is on the wire in this release. The issue this came
 * from expected it not to be, on the strength of an open request against the CLI to add it; the
 * capture says otherwise, which is what a capture is for.
 */
export const CODEX_CAPTURE_TOTALS = {
  input: 74_070,
  cachedInput: 66_048,
  cacheWriteInput: 0,
  output: 3_852,
  reasoning: 2_688,
};
