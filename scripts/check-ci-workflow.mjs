#!/usr/bin/env node
/**
 * Checks that no workflow publishes anything from a pull request, that none of them binds
 * host port 3000, and that `ci.yml` actually runs this repository's checks, on three
 * operating systems, from a build it made itself.
 *
 * `docker.yml` triggered on `pull_request` with `push: true` on both build jobs. A pull request
 * from a fork gets a read-only `GITHUB_TOKEN` whatever the `permissions:` block asks for, so the
 * push 403s, and `test-docker-images` — which `needs:` both — never runs: every outside
 * contribution arrived with two red jobs it had no way to fix. A pull request from a branch in
 * this repository was worse. It succeeded, and published an unreviewed `pr-N` tag of the head
 * commit to a public registry on every push to the branch.
 *
 * The rule is about reachability, not about grep. `push: true` written under a step that cannot
 * run on a pull request is fine; `push: ${{ github.event_name != 'pull_request' }}` is fine; a
 * bare `push: true` in a job the `pull_request` trigger reaches is not. So this parses the
 * workflows, walks `on:` → job `if:`/`needs:` → step `if:`, and evaluates what `push:` comes out
 * as under a simulated `pull_request` event.
 *
 * The evaluator is deliberately three-valued and biased against the workflow: an expression it
 * cannot decide counts as *reachable* and as *pushing*. A safety check that gives an unfamiliar
 * expression the benefit of the doubt is a safety check that stops working the first time
 * somebody writes something clever.
 *
 * `docker/login-action` is held to the same reachability rule. The registry login is the one step
 * whose behaviour on a fork pull request the issue could not confirm — whether it fails there or
 * only the push after it does — and a step that never runs answers the question by not asking it.
 *
 * Host port 3000 is separate and applies to every workflow. 3000 is the port this project has
 * already paid for twice ([docs/trap-port-3000.md](../docs/trap-port-3000.md)); a runner is a
 * shared machine and the container health test has no reason to want a fixed one. The container
 * side may still be 3000 — that is the port the image `EXPOSE`s — so only the host half of a
 * `-p` spec is read.
 *
 * If `.github/workflows/docker.yml` is gone, the docker-specific cases are satisfied by its
 * absence and say so: the issue this check was written for offered deleting the workflow as the
 * other acceptable answer, and a check that fails on the answer it allowed is a check that forces
 * one hand.
 *
 * Section 0 runs the parser and the reachability walk over inline fixtures, including a workflow
 * that does publish from a pull request, so the analysis is known to catch one after the real
 * workflow stops being an example of the defect.
 *
 * ### And that `ci.yml` runs the suite rather than only compiling it (#280)
 *
 * Both jobs in `ci.yml` were `runs-on: ubuntu-latest`, and between them they type-checked,
 * built, asserted three artifacts existed and ran two of the hundred and seventy-odd
 * `scripts/check-*.mjs`. Nothing in this repository had ever been *exercised* on macOS or on
 * Windows, which is the platform it is maintained on and the one the terminal, the worktrees
 * and the paths all behave differently on. `CLAUDE.md` says compiling is not working, and the
 * workflow was compiling.
 *
 * So sections 5 to 7 hold `ci.yml` to the shape the issue asked for, and each rule is about a
 * way the matrix could go green having proved nothing:
 *
 *   - **a job that runs checks builds first.** `scripts/run-checks.mjs` deliberately does not
 *     build — a missing `dist/` is exit 2 — so a job that forgets is a red run rather than a
 *     silent one, but it is still a job that ran nothing. Order matters, so this asks for the
 *     build *before* the run rather than merely somewhere in the job.
 *   - **the `fast` and `browser` matrices name all three runner operating systems**, since
 *     one of them is the whole point.
 *   - **the `repo` job checks out with `fetch-depth: 0`**, because `check-board-map.mjs` and
 *     `check-shallow-clone.mjs` read this fork's merge history and a shallow clone has none.
 *   - **exactly one job runs `--tier repo`, on ubuntu.** Those five checks read tracked files
 *     and need no platform; three copies of them is three chances to disagree about a file.
 *   - **the browser job installs a Chrome and points `CHROME_PATH` at it** rather than
 *     trusting the image to carry one, and runs `--strict`, which is what turns a check that
 *     found no browser from a silent exit 0 into a failure.
 *   - **nothing reads a secret**, so a pull request from a fork completes all three jobs.
 *
 * Section 5 runs those rules over inline fixtures first — a workflow that runs checks without
 * building, and one that builds after running them — so the analysis is known to catch the
 * defect rather than to describe whatever `ci.yml` happens to say.
 *
 * ### And that the three images it names can each get as far as starting the board (#281)
 *
 * The matrix grew to three operating systems before anything in the tree had ever started a
 * server on two of them. Sections 8 and 9 are the other half of that: `scripts/run-checks.mjs
 * --tier fast` has to include a check that starts the board and watches it come up, so the
 * platform-forked code underneath — the state directory, the log path, the pidfile — is
 * exercised rather than merely compiled on macOS and Windows.
 *
 * Two rules beside it, both about a matrix that claims more than it runs:
 *
 *   - **no step depends on a POSIX shell built-in.** `windows-latest` runs a `run:` block under
 *     PowerShell unless the step says `shell:`, and `test -f dist/server.js` — which this
 *     workflow carried until #280 — is not a program it can find. A step meant to prove the
 *     build would have been the first thing to fail there, for a reason that is not the build.
 *   - **`engines.node` names the oldest Node a job runs.** The field claimed `>=18` and CI ran
 *     18 on ubuntu alone to see whether that held; Node 18 is past end of life, so the answer
 *     is to drop it and raise the floor rather than to keep buying one job's worth of evidence
 *     about a runtime nobody should install.
 *
 * Section 8 drives both over inline fixtures — a `test -f` hidden behind an `&&`, the bracket
 * spelling, a step that names `shell: bash` and is therefore fine, and a matrix whose 18 is in
 * an `include:` rather than on the axis.
 *
 * Offline and self-contained: it reads `.github/workflows/*.yml`. No server, no browser, no
 * network, no Docker.
 *
 * Usage: node scripts/check-ci-workflow.mjs
 *
 * Tier: fast
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from './lib/parse-yaml.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = join(repoRoot, '.github', 'workflows');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── A YAML subset, enough for a workflow ─────────────────────
//
// `parseYaml` moved to `scripts/lib/parse-yaml.mjs` when the issue forms needed the same
// subset — see the banner there. The fixtures in section 0 exercise it from here.

// ─── What an `if:` comes out as, for one event ────────────────
//
// Three-valued on purpose. `null` is "this evaluator does not know", and every caller reads it
// as the dangerous answer.

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const here = source[index];
    if (/\s/.test(here)) { index++; continue; }
    if (here === "'" || here === '"') {
      const end = source.indexOf(here, index + 1);
      if (end === -1) return null;
      tokens.push({ kind: 'string', value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    const two = source.slice(index, index + 2);
    if (two === '==' || two === '!=' || two === '&&' || two === '||') {
      tokens.push({ kind: two });
      index += 2;
      continue;
    }
    if (here === '(' || here === ')' || here === '!') { tokens.push({ kind: here }); index++; continue; }
    const word = /^[A-Za-z0-9_.[\]-]+/.exec(source.slice(index));
    if (!word) return null;
    tokens.push({ kind: 'word', value: word[0] });
    index += word[0].length;
    continue;
  }
  return tokens;
}

const AND = (left, right) => (left === false || right === false ? false
  : left === true && right === true ? true : null);
const OR = (left, right) => (left === true || right === true ? true
  : left === false && right === false ? false : null);

/**
 * `undefined` for an operand this evaluator has no value for, which is not the same as `null`:
 * an unknown operand only poisons the comparison it is in.
 */
function operandValue(token, context) {
  if (token.kind === 'string') return token.value;
  if (token.kind !== 'word') return undefined;
  if (token.value === 'true') return true;
  if (token.value === 'false') return false;
  if (token.value === 'github.event_name') return context.eventName;
  if (token.value === 'github.ref_type') return context.refType;
  return undefined;
}

function evaluate(source, context) {
  const tokens = tokenize(source);
  if (!tokens || tokens.length === 0) return null;
  let at = 0;
  const peek = () => tokens[at];

  function parsePrimary() {
    const token = peek();
    if (!token) return null;
    if (token.kind === '!') { at++; const inner = parsePrimary(); return inner === null ? null : !inner; }
    if (token.kind === '(') {
      at++;
      const inner = parseOr();
      if (peek() && peek().kind === ')') at++;
      return inner;
    }
    at++;
    const left = operandValue(token, context);
    const next = peek();
    if (next && (next.kind === '==' || next.kind === '!=')) {
      at++;
      const rightToken = peek();
      if (!rightToken) return null;
      at++;
      const right = operandValue(rightToken, context);
      if (left === undefined || right === undefined) return null;
      return next.kind === '==' ? left === right : left !== right;
    }
    if (left === true || left === false) return left;
    return null;
  }

  function parseAnd() {
    let value = parsePrimary();
    while (peek() && peek().kind === '&&') { at++; value = AND(value, parsePrimary()); }
    return value;
  }

  function parseOr() {
    let value = parseAnd();
    while (peek() && peek().kind === '||') { at++; value = OR(value, parseAnd()); }
    return value;
  }

  const result = parseOr();
  return at === tokens.length ? result : null;
}

/** `${{ … }}` is optional in an `if:` and mandatory anywhere else; both forms arrive here. */
const unwrap = (text) => {
  const trimmed = String(text).trim();
  const match = /^\$\{\{(.*)\}\}$/s.exec(trimmed);
  return match ? match[1].trim() : trimmed;
};

/** A missing `if:` runs; an `if:` this evaluator cannot read is assumed to run. */
const allows = (condition, context) =>
  condition === undefined || condition === null ? true : evaluate(unwrap(condition), context) !== false;

function triggersOn(workflow, eventName) {
  const on = workflow.on;
  if (on === undefined || on === null) return false;
  if (typeof on === 'string') return on === eventName;
  if (Array.isArray(on)) return on.includes(eventName);
  return Object.prototype.hasOwnProperty.call(on, eventName);
}

/** Every step that can run for this event, with the job it belongs to. */
function reachableSteps(workflow, context) {
  if (!triggersOn(workflow, context.eventName)) return [];
  const jobs = workflow.jobs ?? {};
  const reachableJob = (id, seen = new Set()) => {
    const job = jobs[id];
    if (!job || seen.has(id)) return false;
    seen.add(id);
    if (!allows(job.if, context)) return false;
    const needs = job.needs === undefined ? [] : [].concat(job.needs);
    return needs.every((parent) => reachableJob(parent, seen));
  };
  const out = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!reachableJob(id)) continue;
    for (const step of job.steps ?? []) {
      if (step && allows(step.if, context)) out.push({ job: id, step });
    }
  }
  return out;
}

/** What `with.push` comes out as. Missing is the action's own default of false. */
function publishes(step, context) {
  const value = step.with?.push;
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  return evaluate(unwrap(value), context) !== false;
}

const usesAction = (step, name) => typeof step.uses === 'string' && step.uses.split('@')[0] === name;

const PULL_REQUEST = { eventName: 'pull_request' };
const PUSH = { eventName: 'push' };

/** Every `run:` script in a workflow, whatever its reachability — a bind is a bind. */
function runScripts(workflow) {
  const out = [];
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (step && typeof step.run === 'string') out.push({ job: id, text: step.run });
    }
  }
  return out;
}

/**
 * Host ports in a `-p`/`--publish` spec. `-p 3000:3000` is host 3000; `-p 127.0.0.1::3000` and
 * `-p 3000` are the container port with an ephemeral host port, and neither binds one.
 */
function publishedHostPorts(script) {
  const ports = [];
  const spec = /(?:^|\s)(?:-p|--publish(?:=|\s+))\s*"?([0-9.:]+)"?/g;
  for (const [, value] of script.matchAll(spec)) {
    const parts = value.split(':');
    if (parts.length < 2) continue;            // `-p 3000` — container port only
    const host = parts[parts.length - 2];
    if (host !== '') ports.push(host);
  }
  return ports;
}

// ─── What a job builds, runs and runs on ──────────────────────

/** Every step of a job, in the order they are written. Reachability is not the subject here. */
const stepsOf = (job) => (job?.steps ?? []).filter(Boolean);

/** The index of the first step whose `run:` matches, or -1. */
const firstRunning = (job, pattern) => stepsOf(job)
  .findIndex((step) => typeof step.run === 'string' && pattern.test(step.run));

const RUNS_CHECKS = /run-checks\.mjs/;
const BUILDS = /npm run build\b/;

/**
 * The runner images a job can land on.
 *
 * `runs-on: ${{ matrix.os }}` says nothing on its own, so the matrix is what is read; a job
 * naming its image directly is read off `runs-on`. An expression pointing at anything else is
 * no answer and comes back empty, which every caller reads as the failing one.
 */
function runnerOses(job) {
  const fromMatrix = job?.strategy?.matrix?.os;
  if (Array.isArray(fromMatrix)) return fromMatrix.map(String);
  if (typeof fromMatrix === 'string' && fromMatrix !== '') return [fromMatrix];
  const runsOn = job?.['runs-on'];
  if (Array.isArray(runsOn)) return runsOn.map(String);
  if (typeof runsOn === 'string' && !/\$\{\{/.test(runsOn)) return [runsOn];
  return [];
}

/** The tiers a job asks `run-checks.mjs` for. An invocation with no `--tier` reports `''`. */
function tiersRunBy(job) {
  const out = [];
  for (const step of stepsOf(job)) {
    if (typeof step.run !== 'string') continue;
    for (const [, invocation] of step.run.matchAll(/run-checks\.mjs([^\n]*)/g)) {
      const named = /--tier\s+(\S+)/.exec(invocation);
      if (!named) { out.push(''); continue; }
      out.push(...named[1].split(',').map((tier) => tier.trim()).filter(Boolean));
    }
  }
  return out;
}

/** `with:` of the job's `actions/checkout` step, or an empty mapping. */
const checkoutWith = (job) =>
  stepsOf(job).find((step) => usesAction(step, 'actions/checkout'))?.with ?? {};

/**
 * Every Node version a job can be handed, matrix axis and `include:` entries together.
 *
 * The `include:` half is the one that matters here: a version dropped from the axis and left in
 * an `include` is still a version CI runs, and a rule that read only `matrix.node` would call
 * that removed.
 */
function nodeVersions(job) {
  const out = [];
  const axis = job?.strategy?.matrix?.node;
  if (Array.isArray(axis)) out.push(...axis.map(String));
  else if (typeof axis === 'string' && axis !== '') out.push(axis);
  for (const entry of job?.strategy?.matrix?.include ?? []) {
    if (entry?.node !== undefined) out.push(String(entry.node));
  }
  const setup = stepsOf(job).find((step) => usesAction(step, 'actions/setup-node'));
  const pinned = setup?.with?.['node-version'];
  if (typeof pinned === 'string' && !/\$\{\{/.test(pinned)) out.push(pinned);
  return out;
}

/** `'20.x'` → 20, `'>=18.0.0'` → 18. The major is the whole of what these rules compare. */
const majorOf = (version) => {
  const found = /(\d+)/.exec(String(version));
  return found ? Number(found[1]) : NaN;
};

/**
 * Shell words that only a POSIX shell has.
 *
 * `windows-latest` runs a `run:` block under PowerShell unless the step says otherwise, and
 * these are not programs it could find — they are built into `sh`. `test -f dist/server.js`
 * was in this workflow until #280, on a job that only ever ran on ubuntu, and it would have
 * been the first thing to fail the moment the matrix grew: a step meant to prove the build
 * failing for a reason that has nothing to do with the build.
 *
 * Only built-ins, deliberately. A rule that also banned `grep` or `touch` would be guessing at
 * what a hosted image happens to carry, and the guess would be wrong on some of them; a
 * built-in of the wrong shell is absent by definition.
 */
const POSIX_BUILTINS = ['test', '[', '[[', 'source', '.', 'export', 'unset', 'local', 'trap', 'eval'];

/** A step that names its own `shell:` is not depending on the runner's default one. */
const declaresShell = (step) => typeof step?.shell === 'string' && step.shell !== '';

/** `{ job, command }` for every `run:` command line that starts with one of the built-ins. */
function posixOnlyCommands(workflow) {
  const out = [];
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of stepsOf(job)) {
      if (typeof step.run !== 'string' || declaresShell(step)) continue;
      // `&&`, `||`, `;` and `|` each start a new command, and so does a newline. Splitting on
      // all of them is what catches `npm ci && test -f dist/server.js`, which reads as an npm
      // invocation to anything that only looks at the first word of the block.
      for (const piece of step.run.split(/\n|&&|\|\||[;|]/)) {
        const command = piece.trim();
        if (command === '') continue;
        const [word] = command.split(/\s+/);
        if (POSIX_BUILTINS.includes(word)) out.push({ job: id, command });
      }
    }
  }
  return out;
}

/** Jobs that run a check and do not run `npm run build` in an earlier step. */
function jobsRunningChecksUnbuilt(workflow) {
  const out = [];
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    const runsAt = firstRunning(job, RUNS_CHECKS);
    if (runsAt === -1) continue;
    const buildsAt = firstRunning(job, BUILDS);
    if (buildsAt === -1 || buildsAt > runsAt) out.push(id);
  }
  return out;
}

// ─── 0. The analysis catches a workflow that does it ──────────

console.log('0. the reachability walk finds a publish a pull request can reach');

const FIXTURE_BAD = `name: Bad
on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/example/image:latest
`;

const FIXTURE_GOOD = `name: Good
on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Build for the test
        uses: docker/build-push-action@v5
        with:
          context: .
          load: true
          push: false
      - name: Push
        if: github.event_name != 'pull_request'
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
      - name: Push, said another way
        uses: docker/build-push-action@v5
        with:
          context: .
          push: \${{ github.event_name != 'pull_request' }}
  gated:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v5
        with:
          push: true
  downstream:
    needs: [ gated ]
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v5
        with:
          push: true
`;

const bad = parseYaml(FIXTURE_BAD);
const good = parseYaml(FIXTURE_GOOD);

check('the parser reads a workflow', bad.name === 'Bad' && Object.keys(bad.jobs ?? {}).length === 1,
      JSON.stringify(Object.keys(bad)));
check('a bare push: true under a pull_request trigger is caught',
      reachableSteps(bad, PULL_REQUEST).some(({ step }) => publishes(step, PULL_REQUEST)));
check('a step if:, a job if:, a needs: chain and an expression are all read',
      reachableSteps(good, PULL_REQUEST).every(({ step }) => !publishes(step, PULL_REQUEST)),
      reachableSteps(good, PULL_REQUEST).filter(({ step }) => publishes(step, PULL_REQUEST))
        .map(({ step }) => step.name ?? step.uses).join(', '));
check('the same workflow still publishes on a push',
      reachableSteps(good, PUSH).filter(({ step }) => publishes(step, PUSH)).length === 4,
      `${reachableSteps(good, PUSH).filter(({ step }) => publishes(step, PUSH)).length} publishing step(s)`);
check('an if: nobody can evaluate counts as reachable',
      allows('steps.probe.outputs.value == 1', PULL_REQUEST));
check('a host port is read off a -p spec, and an ephemeral one is not',
      publishedHostPorts('docker run -p 3000:3000 a').join() === '3000'
      && publishedHostPorts('docker run -p 127.0.0.1:8080:3000 a').join() === '8080'
      && publishedHostPorts('docker run --publish=127.0.0.1:3000:3000 a').join() === '3000'
      && publishedHostPorts('docker run -p 127.0.0.1::3000 a').length === 0
      && publishedHostPorts('docker run -p 3000 a').length === 0,
      JSON.stringify([publishedHostPorts('docker run -p 3000:3000 a'),
                      publishedHostPorts('docker run -p 127.0.0.1:8080:3000 a'),
                      publishedHostPorts('docker run --publish=127.0.0.1:3000:3000 a'),
                      publishedHostPorts('docker run -p 127.0.0.1::3000 a')]));

// ─── The real workflows ───────────────────────────────────────

const files = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort()
  : [];
const workflows = new Map(files.map((name) => [name, parseYaml(readFileSync(join(workflowDir, name), 'utf8'))]));

console.log('\n1. nothing a pull request can reach publishes anything');

check(`there are workflows to inspect (${files.length} found)`, files.length > 0);

const publishing = [];
const loggingIn = [];
for (const [name, workflow] of workflows) {
  for (const { job, step } of reachableSteps(workflow, PULL_REQUEST)) {
    if (usesAction(step, 'docker/build-push-action') && publishes(step, PULL_REQUEST)) {
      publishing.push(`${name} · ${job} · ${step.name ?? step.uses}`);
    }
    if (usesAction(step, 'docker/login-action')) {
      loggingIn.push(`${name} · ${job} · ${step.name ?? step.uses}`);
    }
  }
}

check('no docker/build-push-action step reachable on a pull_request has push: true',
      publishing.length === 0, publishing.join('; '));
check('no docker/login-action step is reachable on a pull_request either',
      loggingIn.length === 0,
      `${loggingIn.join('; ')} — a fork's token is read-only, and a step that never runs cannot 403`);

console.log('\n2. no workflow asks the runner for host port 3000');

const bound = [];
const named = [];
for (const [name, workflow] of workflows) {
  for (const { job, text } of runScripts(workflow)) {
    for (const host of publishedHostPorts(text)) {
      if (host === '3000') bound.push(`${name} · ${job} · -p ${host}:…`);
    }
    for (const [hit] of text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):3000\b/g)) {
      named.push(`${name} · ${job} · ${hit}`);
    }
  }
}

check('no run: step publishes a container on host port 3000', bound.length === 0,
      `${bound.join('; ')} — see docs/trap-port-3000.md`);
check('no run: step reaches for a service on host port 3000', named.length === 0, named.join('; '));

console.log('\n3. the docker workflow proves the images build on a pull request');

const docker = workflows.get('docker.yml');

if (!docker) {
  console.log('  note  .github/workflows/docker.yml is gone — this fork publishes no images,');
  console.log('        which is the other answer the issue allowed. Nothing left to hold.');
} else {
  const jobs = docker.jobs ?? {};
  const test = jobs['test-docker-images'];
  check('docker.yml still has a test-docker-images job', Boolean(test),
        `jobs: ${Object.keys(jobs).join(', ')}`);

  const reachableOnPr = new Set(reachableSteps(docker, PULL_REQUEST).map(({ job }) => job));
  check('test-docker-images runs on a pull request', reachableOnPr.has('test-docker-images'),
        `jobs a pull request reaches: ${[...reachableOnPr].join(', ') || 'none'}`);

  const testSteps = (test?.steps ?? []).filter((step) => typeof step?.run === 'string');
  const pulls = testSteps.filter(({ run }) => /\bdocker\s+(image\s+)?pull\b/.test(run));
  check('it does not docker pull a remote tag', pulls.length === 0,
        pulls.map(({ name }) => name ?? '(unnamed step)').join('; '));
  check('it loads the image the build job made instead',
        testSteps.some(({ run }) => /\bdocker\s+(image\s+)?load\b/.test(run)),
        'nothing in the job loads a local image, so it has nothing to test');

  const builds = reachableSteps(docker, PULL_REQUEST)
    .filter(({ step }) => usesAction(step, 'docker/build-push-action'));
  check('both images are still built on a pull request', builds.length >= 2,
        `${builds.length} build step(s) a pull request reaches`);
  const notLoaded = builds.filter(({ step }) => step.with?.load !== true && !step.with?.outputs);
  check('each of those builds keeps its image', notLoaded.length === 0,
        `${notLoaded.map(({ job }) => job).join(', ')} — built with neither load: true nor outputs:`);

  console.log('\n4. and still publishes them from main and from a tag');

  const onPush = reachableSteps(docker, PUSH)
    .filter(({ step }) => usesAction(step, 'docker/build-push-action') && publishes(step, PUSH));
  check('a push still reaches a build-push-action step with push: true', onPush.length >= 2,
        `${onPush.length} publishing step(s) — the trigger split must not have dropped the push`);
  check('a push still logs in to the registry',
        reachableSteps(docker, PUSH).some(({ step }) => usesAction(step, 'docker/login-action')));

  const on = docker.on ?? {};
  check('docker.yml still triggers on a pull request', triggersOn(docker, 'pull_request'));
  check('docker.yml still triggers on a push to main and on a version tag',
        [].concat(on.push?.branches ?? []).includes('main')
        && [].concat(on.push?.tags ?? []).some((tag) => /^v/.test(String(tag))),
        JSON.stringify(on.push ?? null));
}

// ─── 5. The build-before-run rule catches a job that skips it ─

console.log('\n5. a job that runs the checks without building first is caught');

const FIXTURE_UNBUILT = `name: Unbuilt
on:
  pull_request:
    branches: [ main ]

jobs:
  fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: npm ci
      - name: Run the fast tier
        run: node scripts/run-checks.mjs --tier fast
  late:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run the fast tier
        run: node scripts/run-checks.mjs --tier fast
      - name: Build project
        run: npm run build
  built:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Build project
        run: npm run build
      - name: Run the fast tier
        run: node scripts/run-checks.mjs --tier fast
`;

const unbuilt = parseYaml(FIXTURE_UNBUILT);

check('a job that runs checks with no build at all is caught',
      jobsRunningChecksUnbuilt(unbuilt).includes('fast'));
check('so is one that builds after running them',
      jobsRunningChecksUnbuilt(unbuilt).includes('late'));
check('and a job that builds first is not',
      !jobsRunningChecksUnbuilt(unbuilt).includes('built'),
      jobsRunningChecksUnbuilt(unbuilt).join(', '));
check('a matrix of runner images is read, and a bare runs-on too',
      runnerOses(unbuilt.jobs.built).join() === 'ubuntu-latest,macos-latest,windows-latest'
      && runnerOses(unbuilt.jobs.fast).join() === 'ubuntu-latest',
      JSON.stringify([runnerOses(unbuilt.jobs.built), runnerOses(unbuilt.jobs.fast)]));
check('fetch-depth: 0 is read off the checkout step',
      String(checkoutWith(unbuilt.jobs.built)['fetch-depth']) === '0'
      && checkoutWith(unbuilt.jobs.fast)['fetch-depth'] === undefined,
      JSON.stringify(checkoutWith(unbuilt.jobs.built)));
check('the tier a job asks for is read off the invocation',
      tiersRunBy(unbuilt.jobs.built).join() === 'fast',
      JSON.stringify(tiersRunBy(unbuilt.jobs.built)));

// ─── 6. ci.yml runs the checks, on three platforms ────────────

console.log('\n6. ci.yml runs the checks, from a build it made, on three platforms');

const ci = workflows.get('ci.yml');
const ciJobs = ci?.jobs ?? {};
const ciText = existsSync(join(workflowDir, 'ci.yml'))
  ? readFileSync(join(workflowDir, 'ci.yml'), 'utf8') : '';

/** The three the issue names. A fourth image is welcome; a missing one is the defect. */
const OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'];

check('there is a ci.yml to inspect', Boolean(ci));

const runningJobs = Object.entries(ciJobs).filter(([, job]) => firstRunning(job, RUNS_CHECKS) !== -1);
check('at least one job runs scripts/run-checks.mjs', runningJobs.length > 0,
      `jobs: ${Object.keys(ciJobs).join(', ') || 'none'} — a workflow that only compiles proves `
      + 'the TypeScript compiles, which CLAUDE.md says is not working');

check('every job that runs a check runs npm run build before it',
      jobsRunningChecksUnbuilt(ci ?? {}).length === 0,
      `${jobsRunningChecksUnbuilt(ci ?? {}).join(', ')} — run-checks.mjs does not build, by design`);

for (const tier of ['fast', 'browser']) {
  const jobsForTier = runningJobs.filter(([, job]) => tiersRunBy(job).includes(tier));
  check(`a job runs --tier ${tier}`, jobsForTier.length > 0);
  for (const [id, job] of jobsForTier) {
    const oses = runnerOses(job);
    check(`the ${id} job runs on ${OSES.join(', ')}`, OSES.every((os) => oses.includes(os)),
          `runs on: ${oses.join(', ') || 'nothing this can read'}`);
  }
}

const repoJobs = runningJobs.filter(([, job]) => tiersRunBy(job).includes('repo'));
check('exactly one job runs --tier repo', repoJobs.length === 1,
      `${repoJobs.map(([id]) => id).join(', ') || 'none'} — check-english-only.mjs and `
      + 'check-board-map.mjs read tracked files and need no platform');
for (const [id, job] of repoJobs) {
  check(`the ${id} job checks out with fetch-depth: 0`,
        String(checkoutWith(job)['fetch-depth']) === '0',
        'a shallow clone cannot answer what this fork has merged');
  check(`the ${id} job runs on ubuntu alone`, runnerOses(job).join() === 'ubuntu-latest',
        `runs on: ${runnerOses(job).join(', ') || 'nothing this can read'}`);
}

const untiered = runningJobs.filter(([, job]) => tiersRunBy(job).includes(''));
check('no job invokes run-checks.mjs without naming a tier', untiered.length === 0,
      `${untiered.map(([id]) => id).join(', ')} — an untiered run drags repo onto every platform`);

// ─── 7. And a fork's pull request can complete all of it ──────

console.log('\n7. the browser job brings its own Chrome, and no job needs a secret');

for (const [id, job] of runningJobs.filter(([, job]) => tiersRunBy(job).includes('browser'))) {
  check(`the ${id} job installs a browser rather than trusting the image`,
        stepsOf(job).some((step) => usesAction(step, 'browser-actions/setup-chrome')),
        'no step installs one, so the tier passes or fails on whatever the image happens to ship');
  const strictly = stepsOf(job).some((step) => typeof step.run === 'string'
    && RUNS_CHECKS.test(step.run) && /--strict\b/.test(step.run));
  check(`the ${id} job runs the browser tier with --strict`, strictly,
        'without it a check that found no browser exits 3 and is reported as a skip');
  check(`the ${id} job points CHROME_PATH at what it installed`,
        stepsOf(job).some((step) => step.env?.CHROME_PATH !== undefined) || /CHROME_PATH/.test(ciText),
        'nothing in the job names CHROME_PATH');
}

check('ci.yml declares permissions: contents: read',
      ci?.permissions?.contents === 'read', JSON.stringify(ci?.permissions ?? null));
check('ci.yml declares a concurrency group that cancels the run it replaces',
      Boolean(ci?.concurrency?.group) && ci?.concurrency?.['cancel-in-progress'] === true,
      JSON.stringify(ci?.concurrency ?? null));
check('no step in ci.yml reads a secret',
      !/secrets\./.test(ciText),
      'a pull request from a fork gets none of them, and would fail on the step that asks');

// ─── 8. The rules catch a workflow that cannot run on Windows ─

console.log('\n8. a step written for sh, and a matrix that outruns engines, are caught');

const FIXTURE_POSIX = `name: Posix
on:
  pull_request:
    branches: [ main ]

jobs:
  sh:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: ['20.x', '22.x']
        include:
          - os: ubuntu-latest
            node: '18.x'
    steps:
      - name: Build project
        run: npm run build
      - name: Assert the artifacts
        run: |
          npm run build && test -f dist/server.js
          [ -f dist/frontend/index.html ]
      - name: Deliberately bash
        shell: bash
        run: test -f dist/bin.js
  clean:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20.x'
      - name: Assert the artifacts
        run: node -e "require('node:fs').statSync('dist/server.js')"
`;

const posixFixture = parseYaml(FIXTURE_POSIX);
const caught = posixOnlyCommands(posixFixture);

check('a `test -f` after an `&&` is caught, not read as the npm invocation in front of it',
      caught.some(({ job, command }) => job === 'sh' && command === 'test -f dist/server.js'),
      JSON.stringify(caught));
check('so is the bracket spelling of the same thing',
      caught.some(({ command }) => command.startsWith('[ -f')), JSON.stringify(caught));
check('a step that names shell: bash is not caught — GitHub ships one on all three images',
      !caught.some(({ command }) => command.includes('dist/bin.js')), JSON.stringify(caught));
check('and a node one-liner doing the same job is not caught',
      !caught.some(({ job }) => job === 'clean'), JSON.stringify(caught));
check('the node versions of a job are its axis and its include entries together',
      nodeVersions(posixFixture.jobs.sh).join() === '20.x,22.x,18.x',
      JSON.stringify(nodeVersions(posixFixture.jobs.sh)));
check('a job with no matrix is read off the version its setup-node pins',
      nodeVersions(posixFixture.jobs.clean).join() === '20.x',
      JSON.stringify(nodeVersions(posixFixture.jobs.clean)));

// ─── 9. ci.yml runs the smoke check, in a shell every runner has ─

console.log('\n9. ci.yml starts the board on every image it claims, and engines agrees');

const SMOKE_CHECK = 'check-smoke-start.mjs';
const smokePath = join(repoRoot, 'scripts', SMOKE_CHECK);
const smokeSource = existsSync(smokePath) ? readFileSync(smokePath, 'utf8') : '';

check(`scripts/${SMOKE_CHECK} exists`, smokeSource !== '',
      'three workflows ran only on Linux and nothing had ever started the board anywhere else');
check(`scripts/${SMOKE_CHECK} declares the fast tier`,
      /^\s*\*?\s*Tier:\s*fast\s*$/m.test(smokeSource),
      'the fast tier is the one ci.yml runs on all three images; any other tier and this runs '
      + 'on none of them');

const stray = posixOnlyCommands(ci ?? {});
check('no step in ci.yml depends on a POSIX shell built-in',
      stray.length === 0,
      stray.map(({ job, command }) => `${job}: ${command}`).join(' / ')
      + ' — windows-latest runs a step under PowerShell unless it says otherwise');

const fastJobs = runningJobs.filter(([, job]) => tiersRunBy(job).includes('fast'));
for (const [id, job] of fastJobs) {
  check(`the ${id} job type-checks before it runs anything`,
        firstRunning(job, /type-check|\btsc\b/) !== -1
        && firstRunning(job, /type-check|\btsc\b/) < firstRunning(job, RUNS_CHECKS),
        'the type check is one of the three things the done-when asks for on all three images');
}

/**
 * `engines.node` and the matrix are one claim, and CI is the half with evidence.
 *
 * Node 18 went end of life in April 2025 and the fork has never published, so the field was
 * describing a runtime nothing would ever be run on. Either the matrix proves the floor or the
 * floor comes up to the matrix; what cannot stand is the field claiming a version no job runs.
 */
const enginesNode = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).engines?.node ?? '';
const ciNodeMajors = [...new Set(Object.values(ciJobs).flatMap((job) => nodeVersions(job).map(majorOf)))]
  .filter(Number.isFinite).sort((a, b) => a - b);

check('no job in ci.yml runs Node 18', !ciNodeMajors.includes(18),
      `node majors in the matrix: ${ciNodeMajors.join(', ') || 'none'} — 18 reached end of life `
      + 'in April 2025');
check('engines.node names the oldest Node ci.yml actually runs',
      majorOf(enginesNode) === ciNodeMajors[0],
      `engines.node is ${JSON.stringify(enginesNode)} and the oldest job runs `
      + `${ciNodeMajors[0] ?? 'nothing this can read'}`);

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
