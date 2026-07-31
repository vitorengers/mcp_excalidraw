#!/usr/bin/env node
/**
 * The `gh` a check gets when it never said what GitHub should answer.
 *
 * `canvasEnvironment` points `EXCALIDRAW_GH_COMMAND` here by default, for the same reason it
 * deletes every inherited `EXCALIDRAW_*` and turns `.env` off: without it, the variable is
 * simply unset and the server runs whatever `gh` is on the operator's PATH — logged in as
 * them, against a repository that exists, from a check whose own header says "nothing here
 * talks to GitHub". Sealing it is the same rule as sealing `PORT`.
 *
 * Two answers, and the split is the point.
 *
 * **`pr view` gets `{}`** — a well-formed reply that says nothing. Reading it, `fetchPullLanding`
 * returns null, which every caller already has to treat as "nobody could say", and the run's
 * outcome stands exactly as it did before that read existed. This is what keeps the thirty-odd
 * assertions across the suite that expect a stubbed agent's fabricated pull request to settle as
 * `done` green, and it keeps them green *honestly*: a check that has not said whether a pull
 * request merged has not said it, and the server's answer to that is written down.
 *
 * **Everything else exits 1, loudly, naming the variable.** No check should be reaching GitHub
 * for a board read or a card move without having stubbed it, so anything else arriving here is a
 * check testing against the network without knowing it.
 */
const args = process.argv.slice(2);

if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write('{}\n');
  process.exit(0);
}

process.stderr.write(
  `this check did not stub gh, so "gh ${args.join(' ')}" has no answer here.\n`
  + 'Set EXCALIDRAW_GH_COMMAND to a stub of your own if the case needs one.\n'
);
process.exit(1);
