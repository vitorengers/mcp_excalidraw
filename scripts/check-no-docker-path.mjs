#!/usr/bin/env node
/**
 * Checks that this repository does not half-support Docker.
 *
 * The tree carried both answers at once. `README.md` sent a reader to
 * `ghcr.io/yctimlin/mcp_excalidraw-canvas:latest` — the upstream project's image, which has none
 * of the workspace registry, block kinds, agents, worktrees or terminals the same page spends
 * five hundred lines describing — while `.github/workflows/docker.yml` built and pushed two
 * images of this fork's own on every push to `main`, and four MCP client sections handed out a
 * `docker run` of upstream's MCP image as a configuration to copy. `Dockerfile.canvas` set
 * `ENV HOST=0.0.0.0` and `docker-compose.yml` published `3000:3000`, which is the opposite of the
 * security note the same README carries, on a server whose API has no authentication; and the
 * runtime image carries neither `gh` nor `git`, so every GitHub-shaped route in it would 403 by
 * construction and say nothing about why. #300 decided the whole path out rather than repairing
 * each half.
 *
 * A deletion is the kind of change that comes back, one convenient file at a time, so the rules
 * here are about the shape of the tree rather than about the six files that were removed:
 *
 *  1. **no tracked Docker build input.** A `Dockerfile`, a `.dockerignore`, a compose file —
 *     anywhere in the tree, not only at the root.
 *  2. **no workflow builds, publishes or runs an image.** `docker/build-push-action`,
 *     `docker/login-action`, a `docker` verb in a `run:` step, or a `ghcr.io` coordinate.
 *  3. **no document hands the reader a Docker install path.** A `docker run`, a `docker compose`,
 *     a `ghcr.io` image, or a `host.docker.internal` in any tracked Markdown.
 *  4. **the README's publishing claims agree with the tracked workflow set.** This is the half
 *     that was false in the other direction: README.md said "This fork publishes no package and
 *     runs no pipeline of its own" while `npm-publish.yml` published `package.json`'s name on
 *     every release and `ci.yml` ran the suite on three operating systems. So the claim phrases
 *     are read out of the README and checked against what the workflows do, in both directions —
 *     a tree that stops publishing and forgets to say so fails here too.
 *
 * `docs/development-log.md` is exempt from rule 3, as it is from `check-docs-counts.mjs`: it is
 * the dated record of what was decided, one entry per merged pull request, and the entry that
 * records this deletion has to be able to name what it deleted.
 *
 * Section 0 drives all four rules over in-memory trees carrying each defect, and over one
 * carrying none, so a future green run means the tree is clean rather than the scanner having
 * stopped looking.
 *
 * Offline and self-contained: `git ls-files` and tracked files. No server, no browser, no
 * network, and — pointedly — no Docker.
 *
 * `fast`, not `repo`, though it is a discipline check: `repo` is the roster that needs this
 * repository's own board or its full history, and this needs neither. It reads the tracked file
 * list and four of the files in it, which a `--depth 1` clone on any of the three runner
 * operating systems can answer — `check-fork-identity.mjs` is the same shape and the same tier.
 *
 * Usage: node scripts/check-no-docker-path.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The log records what was true then, and names the files it deleted. */
const EXEMPT = new Set(['docs/development-log.md']);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The four rules, as functions over paths and text ─────────

/**
 * Whether a tracked path is a Docker build input.
 *
 * Basename only, and anywhere in the tree: a `Dockerfile` under `deploy/` is the same
 * reintroduction as one at the root, and `Dockerfile.canvas` is the shape the second one took.
 */
const DOCKER_FILE = [
  /^Dockerfile(\..+)?$/i,
  /^.+\.dockerfile$/i,
  /^\.dockerignore$/i,
  /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/i,
];

const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

const isDockerFile = (path) => DOCKER_FILE.some((shape) => shape.test(basename(path)));

/**
 * Where a workflow reaches for Docker.
 *
 * Text, not YAML: this asks whether the workflow set has an image story at all, and every way
 * of having one leaves one of these strings behind. `check-ci-workflow.mjs` is the one that
 * parses, and it holds the finer rule — what a `pull_request` may push — for as long as there is
 * a workflow left to hold it to.
 */
const DOCKER_ACTION = /\buses:\s*docker\/(build-push|login|setup-buildx|metadata)-action\b/;
const DOCKER_VERB = /\bdocker(-compose)?\s+(build|buildx|push|pull|run|compose|save|load|image)\b/;
const GHCR = /\bghcr\.io\/[\w.\-/]+/;

function workflowIssues(path, text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `${path}:${index + 1}`;
    if (DOCKER_ACTION.test(line)) out.push(`${where} uses a docker/* action`);
    else if (DOCKER_VERB.test(line)) out.push(`${where} runs \`${line.trim().slice(0, 60)}\``);
    else if (GHCR.test(line)) out.push(`${where} names ${line.match(GHCR)[0]}`);
  });
  return out;
}

/**
 * Where a document hands the reader a Docker install path.
 *
 * `host.docker.internal` is on the list because it is what the four MCP client blocks used to
 * reach the canvas from inside a container: a config that names it is a Docker path whether or
 * not the word `docker` appears as a verb on the same line.
 */
const PROSE_DOCKER = [
  { shape: /\bdocker(-compose)?\s+(run|compose|build|buildx|pull|push|exec)\b/, why: 'a docker command' },
  { shape: /\bhost\.docker\.internal\b/, why: 'a container-to-host address' },
  { shape: GHCR, why: 'a container image coordinate' },
];

function prose(path, text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const { shape, why } of PROSE_DOCKER) {
      if (shape.test(line)) out.push(`${path}:${index + 1} ${why} — ${line.trim().slice(0, 70)}`);
    }
  });
  return out;
}

/**
 * Where the README's claims about what this repository publishes disagree with its workflows.
 *
 * Each entry is a sentence the README may carry and the condition that makes it true. The
 * README half is a phrase rather than a whole sentence because the paragraph gets rewritten and
 * the claim survives the rewrite; the workflow half is read from the tracked set every run, so
 * neither side can drift without this saying which one did.
 */
const CLAIMS = [
  {
    phrase: /publishes no package\b/i,
    holds: (facts) => !facts.publishesPackage,
    why: 'a workflow runs `npm publish`',
  },
  {
    phrase: /runs no pipeline of its own\b/i,
    holds: (facts) => !facts.hasWorkflows,
    why: 'this repository tracks its own workflows',
  },
  {
    phrase: /(builds and pushes none|publishes none) of its own\b/i,
    holds: (facts) => !facts.publishesImage,
    why: 'a workflow builds and pushes an image',
  },
  {
    phrase: /\bpublishes (its own|both) images?\b/i,
    holds: (facts) => facts.publishesImage,
    why: 'no workflow builds an image any more',
  },
];

function claimIssues(readme, facts) {
  return CLAIMS
    .filter(({ phrase }) => phrase.test(readme))
    .filter(({ holds }) => !holds(facts))
    .map(({ phrase, why }) => `README.md says ${phrase.source} — but ${why}`);
}

// ─── 0. The rules catch each defect, and clear a fixed tree ───

console.log('0. the rules catch each defect, and clear a tree that has none');

const DIRTY_PATHS = ['Dockerfile', 'Dockerfile.canvas', '.dockerignore', 'docker-compose.yml',
                     'deploy/Dockerfile', 'compose.yaml', 'src/server.ts', 'README.md'];
check('every Docker build input is caught, at the root and below it',
      DIRTY_PATHS.filter(isDockerFile).length === 6,
      DIRTY_PATHS.filter(isDockerFile).join(', '));
check('an ordinary source file is not', !isDockerFile('src/server.ts') && !isDockerFile('README.md'));
check('a workflow named docker.yml is not caught by its name alone',
      !isDockerFile('.github/workflows/docker.yml'),
      'rule 2 reads what a workflow does; a file name is not a build input');

const DIRTY_WORKFLOW = `name: Docker Build & Push
jobs:
  build:
    steps:
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/someone/their_tool:latest
      - run: docker save --output /tmp/mcp.tar their_tool:ci
`;
const CLEAN_WORKFLOW = `name: CI
jobs:
  fast:
    steps:
      - run: npm ci
      - run: node scripts/run-checks.mjs --tier fast
`;
check('a workflow that builds and pushes an image is caught, action, tag and verb',
      workflowIssues('docker.yml', DIRTY_WORKFLOW).length === 3,
      workflowIssues('docker.yml', DIRTY_WORKFLOW).join(' / ') || 'nothing caught');
check('a workflow that only runs the suite is not',
      workflowIssues('ci.yml', CLEAN_WORKFLOW).length === 0,
      workflowIssues('ci.yml', CLEAN_WORKFLOW).join(' / '));

const DIRTY_PROSE = `Docker canvas server:
\`\`\`bash
docker run -d -p 3000:3000 ghcr.io/yctimlin/mcp_excalidraw-canvas:latest
\`\`\`
- **Docker networking**: use \`host.docker.internal\` to reach the canvas on your host.
`;
const CLEAN_PROSE = `From source (Node >= 18):
\`\`\`bash
npm ci
npm run build
\`\`\`
The canvas server binds 127.0.0.1 only by default.
`;
check('a documented docker run, its image and a container address are all caught',
      prose('README.md', DIRTY_PROSE).length === 3,
      prose('README.md', DIRTY_PROSE).join(' / ') || 'nothing caught');
check('a from-source quick start is not', prose('README.md', CLEAN_PROSE).length === 0,
      prose('README.md', CLEAN_PROSE).join(' / '));

const PUBLISHING = { publishesPackage: true, publishesImage: false, hasWorkflows: true };
check('"publishes no package" is caught while a workflow publishes one',
      claimIssues('This fork publishes no package and runs no pipeline of its own.',
                  PUBLISHING).length === 2,
      'both halves of that sentence are claims about the tracked workflow set');
check('"publishes its own images" is caught once no workflow builds one',
      claimIssues('This fork publishes its own images to ghcr.io.', PUBLISHING).length === 1);
check('a paragraph that matches the facts is accepted',
      claimIssues('This fork publishes `@vitorengers/vibemaxxing` on a release and runs its own '
                  + 'checks in CI; it builds no container image.', PUBLISHING).length === 0,
      claimIssues('This fork publishes `@vitorengers/vibemaxxing` on a release and runs its own '
                  + 'checks in CI; it builds no container image.', PUBLISHING).join(' / '));
check('a tree that publishes neither may say so',
      claimIssues('This fork publishes no package and builds and pushes none of its own images.',
                  { publishesPackage: false, publishesImage: false, hasWorkflows: true })
        .length === 0);

// ─── The tree itself ──────────────────────────────────────────

const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n').map((line) => line.trim()).filter(Boolean);

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

console.log('\n1. no Docker build input is tracked');

const inputs = tracked.filter(isDockerFile);
check('no Dockerfile, .dockerignore or compose file is tracked', inputs.length === 0,
      `${inputs.join(', ')} — #300 deleted the Docker path rather than half-supporting it`);

console.log('\n2. no workflow builds, publishes or runs an image');

const workflows = tracked.filter((path) => /^\.github\/workflows\/.+\.ya?ml$/.test(path));
check('this repository tracks workflows at all', workflows.length > 0,
      'nothing to hold rule 4 against');

const reaching = workflows.flatMap((path) => workflowIssues(path, read(path)));
check('no tracked workflow reaches for Docker', reaching.length === 0,
      `\n        ${reaching.join('\n        ')}`);

console.log('\n3. no document hands the reader a Docker install path');

const markdown = tracked.filter((path) => path.endsWith('.md') && !EXEMPT.has(path));
const documented = markdown.flatMap((path) => prose(path, read(path)));
check('no tracked Markdown documents a Docker install path', documented.length === 0,
      `\n        ${documented.join('\n        ')}`);

console.log('\n4. the README\'s publishing claims are true of the tracked workflow set');

const workflowText = workflows.map((path) => read(path)).join('\n');
const facts = {
  publishesPackage: /\bnpm\s+publish\b/.test(workflowText),
  publishesImage: DOCKER_ACTION.test(workflowText) || GHCR.test(workflowText),
  hasWorkflows: workflows.length > 0,
};
const disagreements = claimIssues(read('README.md'), facts);
check('every claim the README makes about what this fork publishes holds',
      disagreements.length === 0,
      `\n        ${disagreements.join('\n        ')}`
      + `\n        tracked workflows: ${workflows.map(basename).join(', ')}`);

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
