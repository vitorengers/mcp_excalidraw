#!/usr/bin/env node
/**
 * Checks what a board may say about its projects to a machine that is not this one.
 *
 * `GET /api/workspaces` is guarded for a stated reason, written above it in `src/server.ts`: it
 * does not read *a* project, it reads the map of all of them — every registered project's
 * absolute path, and a WSL project's path inside its distro too. A federated board is by
 * construction the thing that carries that off the machine, so which fields cross has to be a
 * decision somebody took rather than a consequence of forwarding a struct.
 *
 * Two halves, and the second is the one that lasts.
 *
 *  1. **The marker sweep.** A `Workspace` is built in which every string field is a
 *     distinguishable marker and every number a distinguishable number, it is projected, and no
 *     withheld marker may appear anywhere in `JSON.stringify` of the result. A substring sweep
 *     rather than a key check, because a path can arrive concatenated into something else — a
 *     tooltip line, a label, a composed id — and a key check would call that clean. The same
 *     sweep runs over the string this module says replaces the path on a peer's tab.
 *  2. **The interface's key list.** `src/core/workspaces.ts` is read and every key of
 *     `interface Workspace` has to be either projected or on the explicit withheld list in this
 *     module. A field added there without a decision here is then a failing check rather than a
 *     silent leak — which is the whole difference between a projection built by *naming what it
 *     includes* and one built by spreading a struct and deleting three keys.
 *
 * A third half, smaller: the module must be nameable by the frontend. `frontend/tsconfig.json`
 * compiles with `types: []`, so an `import type` of anything that reaches a Node built-in reds
 * `check-frontend-types.mjs` in files nobody touched — the reason `src/core/workspace-environment.ts`
 * is a file with no imports at all. A probe compiled under the real frontend configuration is
 * what proves it, rather than a comment saying so.
 *
 * **Run against the old code first.** The draft it was written against spreads the workspace and
 * deletes `path`, `innerPath` and `docsDir` — the shape this issue exists to refuse — and the
 * sweep finds `boardFile`, `libraryFile`, `agents` and the rest still on the wire.
 *
 * Offline and self-contained. No server, no browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-remote-workspace-view.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The module under test ────────────────────────────────────

const modulePath = join(repoRoot, 'dist', 'core', 'remote-workspace-view.js');
const sourcePath = join(repoRoot, 'src', 'core', 'remote-workspace-view.ts');

console.log('\n1. the module is there and compiled');

check('src/core/remote-workspace-view.ts exists', existsSync(sourcePath));
if (!existsSync(modulePath)) {
  console.error('  FAIL  dist/core/remote-workspace-view.js exists — run ./node_modules/.bin/tsc first');
  console.error('\n1 case(s) failed');
  process.exit(1);
}
console.log('  ok    dist/core/remote-workspace-view.js exists');

const module = await import(pathToFileURL(modulePath).href);
const source = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';

check('it exports projectWorkspaceForPeer', typeof module.projectWorkspaceForPeer === 'function');
check('it exports the withheld list', Array.isArray(module.WITHHELD_FROM_PEERS),
      `WITHHELD_FROM_PEERS is ${typeof module.WITHHELD_FROM_PEERS}`);
check('it exports what replaces the path', typeof module.remoteWorkspaceLocation === 'function',
      'the tooltip needs something where the path was, and this module decides what');

if (typeof module.projectWorkspaceForPeer !== 'function') {
  console.error('\nnothing below can run without the projection');
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}

const withheld = Array.isArray(module.WITHHELD_FROM_PEERS) ? [...module.WITHHELD_FROM_PEERS] : [];

// ─── 2. The marker sweep ──────────────────────────────────────

/**
 * A resolved `Workspace` in which every string is its own marker.
 *
 * Every marker names the field it came from, so a failure says which field crossed rather than
 * that something did, and none of them is a substring of another. The numbers are markers too:
 * a card limit and a timeout are as much a fact about the owner's configuration as a path is.
 */
const MARKED = {
  id: 'MARKER-id-01',
  name: 'MARKER-name-02',
  path: 'MARKER-path-03',
  innerPath: 'MARKER-innerPath-04',
  environment: { kind: 'wsl', distro: 'MARKER-distro-05' },
  language: 'MARKER-language-06',
  docsDir: 'MARKER-docsDir-07',
  boardFile: 'MARKER-boardFile-08',
  libraryFile: 'MARKER-libraryFile-09',
  repo: 'MARKER-repo-10',
  githubProject: 'MARKER-githubProject-11',
  projectField: 'MARKER-projectField-12',
  projectCardLimit: 424212,
  projectInProgressColumn: 'MARKER-projectInProgressColumn-13',
  projectTodoColumn: 'MARKER-projectTodoColumn-14',
  agents: {
    issue: {
      backend: 'MARKER-issueBackend-15',
      model: 'MARKER-issueModel-16',
      effort: 'MARKER-issueEffort-17',
      timeoutMs: 424218,
      workflow: 'MARKER-issueWorkflow-19'
    },
    implement: {
      backend: 'MARKER-implementBackend-20',
      model: 'MARKER-implementModel-21',
      effort: 'MARKER-implementEffort-22',
      timeoutMs: 424223,
      workflow: 'MARKER-implementWorkflow-24'
    }
  },
  error: 'MARKER-error-25'
};

/** Every marker in the fixture, whatever depth it sits at, as the string a sweep looks for. */
function markersUnder(value) {
  if (typeof value === 'string') return value.startsWith('MARKER-') ? [value] : [];
  if (typeof value === 'number') return [String(value)];
  if (value && typeof value === 'object') return Object.values(value).flatMap(markersUnder);
  return [];
}

/** The markers a given top-level field of the fixture put on the wire, directly or nested. */
const markersOf = (field) => markersUnder(MARKED[field]);

/**
 * The floor, held here rather than read off the module.
 *
 * These are the fields the issue names as the owning machine's business alone, and a module that
 * shortened its own withheld list would otherwise shorten the sweep with it. `environment` is on
 * it for the distro name inside it and for nothing else: a marker sweep looks for
 * `MARKER-distro-05`, so a later decision to cross `{ kind }` and no name is a decision this
 * still allows.
 */
const MUST_NOT_CROSS = [
  'path', 'innerPath', 'environment', 'docsDir', 'boardFile', 'libraryFile', 'agents'
];

/** What the sweep looks for: the floor above, plus whatever else the module decided to withhold. */
const swept = [...new Set([...MUST_NOT_CROSS, ...withheld])];

console.log('\n2. no withheld field reaches the wire, by substring and not by key');

const view = module.projectWorkspaceForPeer(MARKED);
const wire = JSON.stringify(view);

check('the projection answers an object', view !== null && typeof view === 'object',
      `it answered ${typeof view}`);

for (const field of swept) {
  const leaked = markersOf(field).filter((marker) => wire.includes(marker));
  check(`${field} is nowhere in the result`, leaked.length === 0,
        `${leaked.join(', ')} is on the wire — ${wire.slice(0, 400)}`);
}

// The sweep above passes trivially against a projection that answers `{}`, so the fields that
// are supposed to cross have to be asserted present as well.
const projectedKeys = view && typeof view === 'object' ? Object.keys(view) : [];
check('something crosses at all', projectedKeys.length > 0,
      'a projection that answers nothing passes every sweep and serves no tab strip');
for (const field of projectedKeys) {
  check(`${field} crosses`, markersOf(field).every((marker) => wire.includes(marker)),
        `${field} is a projected key and its value did not survive the projection`);
}

// The property the issue is about, stated behaviourally: a field this module has never heard of
// cannot appear in the result. A spread-and-delete projection fails exactly here.
const withAFutureField = module.projectWorkspaceForPeer({ ...MARKED, futureField: 'MARKER-future-99' });
check('a field added to Workspace next year does not cross by itself',
      !JSON.stringify(withAFutureField).includes('MARKER-future-99'),
      'the projection is spreading its input rather than naming what it includes');

console.log('\n3. and neither does what replaces the path');

// The tab strip needs *something* where the path was: the path is what disambiguates two
// projects with the same name in the tooltip. A peer's name and the project's own name are
// enough for that and disclose nothing about the peer's disk.
if (typeof module.remoteWorkspaceLocation === 'function') {
  const origin = module.remoteWorkspaceLocation(view, 'studio-desktop');
  check('it is a string a tooltip can show', typeof origin === 'string' && origin.length > 0,
        `it answered ${JSON.stringify(origin)}`);
  check('it names the project', String(origin).includes(MARKED.name),
        `${origin} — two projects of the same name are what it has to tell apart`);
  check('it names the peer', String(origin).includes('studio-desktop'), String(origin));
  const leaked = swept.flatMap(markersOf).filter((marker) => String(origin).includes(marker));
  check('and discloses nothing withheld', leaked.length === 0, leaked.join(', '));

  // A peer this board has no name for still gets a sentence rather than `undefined`.
  const unnamed = module.remoteWorkspaceLocation(view, '');
  check('a peer with no name still reads as a sentence',
        typeof unnamed === 'string' && unnamed.length > 0 && !unnamed.includes('undefined'),
        JSON.stringify(unnamed));
}

// ─── 4. Every key of Workspace is a decision taken here ───────

console.log('\n4. every field of Workspace is either projected or withheld on purpose');

const workspacesSource = readFileSync(join(repoRoot, 'src', 'core', 'workspaces.ts'), 'utf8');

/** The keys of one exported interface, read from the source rather than from a list kept here. */
function keysOfInterface(text, name) {
  const start = text.indexOf(`export interface ${name} {`);
  if (start < 0) return null;
  const end = text.indexOf('\n}', start);
  if (end < 0) return null;
  const body = text.slice(text.indexOf('{', start) + 1, end);
  return [...body.matchAll(/^\s{2}(\w+)\??\s*:/gm)].map(([, key]) => key);
}

const workspaceKeys = keysOfInterface(workspacesSource, 'Workspace');

check('interface Workspace can be read out of src/core/workspaces.ts',
      workspaceKeys !== null && workspaceKeys.length >= 10,
      `read ${workspaceKeys ? workspaceKeys.length : 'no'} key(s)`);

if (workspaceKeys) {
  const decided = new Set([...projectedKeys, ...withheld]);
  const undecided = workspaceKeys.filter((key) => !decided.has(key));
  check('no field of Workspace is undecided', undecided.length === 0,
        `${undecided.join(', ')} — add it to the projection or to WITHHELD_FROM_PEERS, `
        + 'with the reason, rather than letting it cross by default');

  const known = new Set(workspaceKeys);
  const stale = withheld.filter((key) => !known.has(key));
  check('nothing on the withheld list has stopped existing', stale.length === 0,
        `${stale.join(', ')} is withheld and is not a field of Workspace any more`);

  const both = projectedKeys.filter((key) => withheld.includes(key));
  check('nothing is both projected and withheld', both.length === 0, both.join(', '));

  const strayed = projectedKeys.filter((key) => !known.has(key));
  check('every projected key is a field of Workspace', strayed.length === 0,
        `${strayed.join(', ')} — the projection is inventing fields rather than choosing them`);
}

// ─── 5. `error` crosses as itself, and is not liveness ────────

console.log('\n5. error crosses as itself, and carries no liveness');

check('error is projected', projectedKeys.includes('error'),
      'a misconfigured project has to read as misconfigured on either machine');
check('it crosses verbatim', view?.error === MARKED.error, JSON.stringify(view?.error));
check('and null stays null',
      module.projectWorkspaceForPeer({ ...MARKED, error: null }).error === null);

// `error` gates behaviour — an implement run refuses outright on it and the queue treats the
// board as unusable — so a sleeping laptop's projects arriving with it set would refuse runs on
// projects that have nothing to do with any laptop. Liveness is `core/peer-liveness.ts`'s, and
// is attached beside this rather than folded into it.
const livenessish = projectedKeys.filter((key) => /^(state|liveness|online|reachable|at)$/.test(key));
check('no liveness state is folded into the projection', livenessish.length === 0,
      `${livenessish.join(', ')} — the four answers are core/peer-liveness.ts's, attached beside this`);
check('the module says what error means, in the module',
      /config/i.test(source) && /peer-liveness|liveness/.test(source),
      'a reader of the wire has to be told error is a config-resolution failure and not a '
      + 'machine that is asleep');

// ─── 6. The frontend may name the type ────────────────────────

console.log('\n6. the frontend can name the type');

check('the module imports nothing at all', !/^\s*import\s/m.test(source),
      'frontend/tsconfig.json compiles with types: [] — an import of a Node built-in here, even '
      + 'an import type, reds check-frontend-types.mjs in files nobody touched');

const frontendConfig = join(repoRoot, 'frontend', 'tsconfig.json');
const tscEntry = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

// Under `node_modules` rather than under `%TEMP%`, for the reason `check-frontend-types.mjs`
// gives: a probe outside the repository has no `node_modules` above it and fails on its own
// address rather than on anything under test. `git` already ignores this path.
const scratch = mkdtempSync(join(repoRoot, 'node_modules', '.remote-workspace-view-'));
try {
  const probeDir = join(scratch, 'probe');
  mkdirSync(probeDir, { recursive: true });
  const moduleFrom = join(repoRoot, 'src', 'core', 'remote-workspace-view').replace(/\\/g, '/');
  writeFileSync(join(probeDir, 'probe.ts'), `import { remoteWorkspaceLocation } from '${moduleFrom}'
import type { RemoteWorkspaceView } from '${moduleFrom}'

export function tabTitle(view: RemoteWorkspaceView, peer: string): string {
  return [view.name, remoteWorkspaceLocation(view, peer), view.error].filter(Boolean).join('\\n')
}
`, 'utf8');
  // No `compilerOptions` of its own: every flag under test is the one the frontend ships with.
  writeFileSync(join(probeDir, 'tsconfig.json'), JSON.stringify({
    extends: frontendConfig.replace(/\\/g, '/'),
    include: [],
    files: ['./probe.ts']
  }, null, 2), 'utf8');

  const run = spawnSync(process.execPath, [tscEntry, '--noEmit', '-p', probeDir],
                        { cwd: repoRoot, encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  check('a frontend program naming the type compiles clean', run.status === 0 && output === '',
        output.split('\n').slice(0, 12).join('\n        ') || `exit ${run.status}`);
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a Windows lock, not a failure */ }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('all cases passed');
