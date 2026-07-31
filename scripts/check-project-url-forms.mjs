#!/usr/bin/env node
/**
 * Checks that the URL GitHub's address bar produces is a URL this board accepts.
 *
 * `parseProjectUrl` anchored on `/projects/<n>` and nothing after it, so only a bare
 * `https://github.com/users/<login>/projects/5` was ever a project. Opening that project on
 * github.com puts `https://github.com/users/<login>/projects/5/views/1` in the address bar —
 * and `?pane=issue&itemId=…` on top of that once a card's side panel is open — so the value a
 * reader copies is not the value the reader had to type. Nothing said so, either: the settings
 * dialog saved the paste happily, the mirror read 404, and the browser reads 404 as "this
 * board has no project" and clears the region. The failure was therefore silent at every step
 * a person could see.
 *
 * Two halves, and the second one is what makes the first honest:
 *
 *  1. **the parse widens to the address bar's own shapes** — a trailing `/views/<n>`, a query
 *     string, a fragment — normalising all of them to owner type, login and number. It stays a
 *     whitelist: the login and the number reach a `bash -lc` command line, so what is *matched*
 *     is still only what GitHub allows in a login and in a number, and everything the address
 *     bar adds is recognised and then dropped rather than carried;
 *  2. **a value that can never resolve is refused at save time**, by the same function that
 *     already refuses a `name` that is not text, so the dialog says what is wrong instead of
 *     saving a board that will mirror nothing. A classic repository project is refused by name,
 *     because "not a GitHub project URL" is a lie about a URL that plainly is one — it is the
 *     wrong kind of project, and saying so is the difference between a typo and a migration.
 *
 * Section 4 is the end of the wire: the widened parse has to reach `gh`, carrying the login and
 * the number and none of the address bar's decoration, and a board that names no project has to
 * go on answering 404 exactly as it did.
 *
 * Self-contained: throwaway projects, a stub `gh`, its own canvas server on a free port.
 * Nothing here talks to GitHub and nothing needs a browser. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-project-url-forms.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${slash(relative)} not found; run tsc first`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const { parseProjectUrl } = await importDist(join('core', 'project-board.js'), 'the project reader');
const { validateWorkspaceConfigPatch } =
  await importDist(join('core', 'workspaces.js'), 'the workspace loader');

// ─── 1. the forms the address bar produces ─────────────────────

console.log('1. the address bar\'s own URLs parse');

const USER = 'https://github.com/users/vitorengers/projects/5';
const ORG = 'https://github.com/orgs/acme/projects/12';

/** Owner type, login and number as one comparable string, or what went wrong instead. */
const parsed = (url) => {
  const ref = parseProjectUrl(url);
  return ref ? `${ref.ownerType}/${ref.login}/${ref.number}` : `refused: ${url}`;
};

check('a bare user project still parses, as it always did',
      parsed(USER) === 'user/vitorengers/5', parsed(USER));
check('and a bare organisation one',
      parsed(ORG) === 'organization/acme/12', parsed(ORG));

check('the view the address bar adds is accepted and dropped',
      parsed(`${USER}/views/1`) === 'user/vitorengers/5', parsed(`${USER}/views/1`));
check('for an organisation too',
      parsed(`${ORG}/views/3`) === 'organization/acme/12', parsed(`${ORG}/views/3`));
check('and with the trailing slash a copied link sometimes carries',
      parsed(`${USER}/views/1/`) === 'user/vitorengers/5', parsed(`${USER}/views/1/`));

// What the address bar holds while a card's side panel is open. The item and the issue are
// GitHub's own encoding, pipes and all, and none of it is this board's business.
const PANE = `${USER}/views/1?pane=issue&itemId=115447583&issue=vitorengers%7Cvibemaxxing%7C318`;
check('a project with a card open in the side panel parses to the project',
      parsed(PANE) === 'user/vitorengers/5', parsed(PANE));
check('a query on the bare form parses too',
      parsed(`${USER}?pane=info`) === 'user/vitorengers/5', parsed(`${USER}?pane=info`));
check('and a fragment is dropped the same way',
      parsed(`${USER}/views/1#board`) === 'user/vitorengers/5', parsed(`${USER}/views/1#board`));
check('surrounding whitespace is still trimmed',
      parsed(`  ${USER}/views/1  `) === 'user/vitorengers/5', parsed(`  ${USER}/views/1  `));

console.log('\n2. and it is still a whitelist');

const refused = (url) => parseProjectUrl(url) === null;

check('another host is refused', refused('https://example.com/users/x/projects/5'));
check('http is refused', refused('http://github.com/users/vitorengers/projects/5'));
check('a login that is a command line is refused',
      refused('https://github.com/users/a;rm -rf b/projects/5'),
      JSON.stringify(parseProjectUrl('https://github.com/users/a;rm -rf b/projects/5')));
check('a number that is a command line is refused',
      refused('https://github.com/users/vitorengers/projects/5;rm -rf b'));
check('a path segment this board has never heard of is refused',
      refused(`${USER}/settings`), JSON.stringify(parseProjectUrl(`${USER}/settings`)));
check('a view that is not a number is refused', refused(`${USER}/views/one`));
check('and a path past the view is refused', refused(`${USER}/views/1/insights`));
check('a space in the query is refused rather than carried',
      refused(`${USER}?pane=issue itemId=1`));
check('and so is a quote in it, of either kind',
      refused(`${USER}?pane='issue'`) && refused(`${USER}?pane="issue"`));
check('a classic repository project is not a project this board can read',
      refused('https://github.com/vitorengers/vibemaxxing/projects/1'));
check('nothing at all is refused', refused(null) && refused(undefined) && refused(''));
check('and something that is not a string is refused', refused(5) && refused({}));

// ─── 3. refused at save time ───────────────────────────────────

console.log('\n3. a value that can never resolve is refused before it is written');

const patch = (githubProject) => validateWorkspaceConfigPatch({ githubProject });

check('the address bar\'s form saves', patch(`${USER}/views/1`).ok === true,
      JSON.stringify(patch(`${USER}/views/1`)));
check('the bare form saves', patch(USER).ok === true, JSON.stringify(patch(USER)));
check('the side-panel form saves', patch(PANE).ok === true, JSON.stringify(patch(PANE)));
check('clearing the field saves', patch(null).ok === true, JSON.stringify(patch(null)));
check('and so does blanking it, which is how the dialog clears it',
      patch('   ').ok === true, JSON.stringify(patch('   ')));

const garbage = patch('projeto 5');
check('a value that is not a project URL is refused', garbage.ok === false,
      JSON.stringify(garbage));
check('and the refusal names the field and quotes what was typed',
      garbage.ok === false && /githubProject/.test(garbage.error) && /projeto 5/.test(garbage.error),
      JSON.stringify(garbage));
check('and it shows a form that does work',
      garbage.ok === false && /github\.com\/users\/.+\/projects\//.test(garbage.error),
      JSON.stringify(garbage));

const classic = patch('https://github.com/vitorengers/vibemaxxing/projects/1');
check('a classic repository project is refused', classic.ok === false, JSON.stringify(classic));
check('by name, rather than as a URL that is merely malformed',
      classic.ok === false && /classic/i.test(classic.error) && /repository/i.test(classic.error),
      JSON.stringify(classic));

check('a value of the wrong type is still refused as a type',
      patch(5).ok === false && /text/.test(patch(5).error), JSON.stringify(patch(5)));
check('and the other settings are untouched by any of this',
      validateWorkspaceConfigPatch({ repo: 'vitorengers/vibemaxxing', name: 'Anything' }).ok === true);

// ─── 4. through the route, to the command line ─────────────────

const workDir = join(tmpdir(), `check-project-url-forms-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const logPath = join(workDir, 'gh-calls.log');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');
const stubGhPath = join(workDir, 'stub-gh.mjs');

const PAYLOAD = {
  data: {
    owner: {
      projectV2: {
        id: 'PVT_kwHOBVSHIs4BefUS',
        title: 'VibeMaxxing',
        url: USER,
        field: {
          id: 'PVTSSF_status',
          name: 'Status',
          options: [{ id: 'f75ad846', name: 'Todo' }, { id: '98236657', name: 'Done' }],
        },
        items: { pageInfo: { hasNextPage: false }, nodes: [] },
      },
    },
  },
};

writeFileSync(fixturePath, JSON.stringify(PAYLOAD), 'utf8');
writeFileSync(logPath, '', 'utf8');
writeFileSync(stubGhPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
if (args.includes('graphql')) {
  process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

/** `pasted` is saved through the route; `plain` names no project and must stay dormant. */
const WORKSPACES = [
  { id: 'pasted', config: { name: 'Pasted' } },
  { id: 'plain', config: { name: 'Plain' } },
];
for (const workspace of WORKSPACES) {
  const dir = join(workDir, workspace.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(workspace.config, null, 2), 'utf8');
  workspace.path = slash(dir);
  workspace.configPath = join(dir, 'board.config.json');
}
writeFileSync(registryPath, JSON.stringify({
  workspaces: WORKSPACES.map((workspace) => ({ id: workspace.id, path: workspace.path })),
}, null, 2), 'utf8');

const port = await freePort();
const server = spawnCanvas({
  port,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${slash(stubGhPath)}"`,
    STUB_GH_FIXTURE: fixturePath,
    STUB_GH_LOG: logPath,
  },
});
const BASE = server.base;

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the canvas server exited early:\n${server.read()}`);
    }
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${server.read()}`);
}

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const saveProject = (id, githubProject) => call(`/api/workspaces/${id}/config`, {
  method: 'PUT',
  body: JSON.stringify({ config: { githubProject } }),
});

const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
const configOf = (id) =>
  JSON.parse(readFileSync(WORKSPACES.find((w) => w.id === id).configPath, 'utf8'));

try {
  await waitForHealth();

  console.log('\n4. and the whole wire, from the paste to the command line');

  const saved = await saveProject('pasted', `${USER}/views/1?pane=issue&itemId=115447583`);
  check('the settings dialog can save what the address bar gave it', saved.status === 200,
        `${saved.status} ${JSON.stringify(saved.body)}`);
  check('and the config on disk holds it verbatim',
        configOf('pasted').githubProject === `${USER}/views/1?pane=issue&itemId=115447583`,
        JSON.stringify(configOf('pasted')));

  const board = await call('/api/project-board?workspace=pasted');
  check('the mirror reads that board rather than answering 404', board.status === 200,
        `${board.status} ${JSON.stringify(board.body).slice(0, 300)}`);

  const graphql = ghCalls().map((line) => JSON.parse(line).join(' ')).filter((line) => /graphql/.test(line));
  check('gh was asked for it at all', graphql.length > 0, JSON.stringify(ghCalls()).slice(0, 300));
  // `length > 0` on each of the three: `every` over nothing is true, so a run where `gh` was
  // never called would otherwise report the command line as correct.
  check('with the login the URL named',
        graphql.length > 0 && graphql.every((line) => /(^| )login=vitorengers( |$)/.test(line)),
        JSON.stringify(graphql).slice(0, 400));
  check('and the number, normalised out of the address bar\'s decoration',
        graphql.length > 0 && graphql.every((line) => /(^| )number=5( |$)/.test(line)),
        JSON.stringify(graphql).slice(0, 400));
  check('and none of the address bar\'s decoration on the command line',
        graphql.length > 0 && graphql.every((line) => !/views|pane=|itemId/.test(line)),
        JSON.stringify(graphql).slice(0, 400));

  const before = configOf('pasted').githubProject;
  const rejected = await saveProject('pasted', 'projeto 5');
  check('a value that can never resolve is refused by the route', rejected.status === 400,
        `${rejected.status} ${JSON.stringify(rejected.body)}`);
  check('with an error the dialog can show',
        typeof rejected.body?.error === 'string' && rejected.body.error.length > 0,
        JSON.stringify(rejected.body));
  check('and nothing is written when it is refused',
        configOf('pasted').githubProject === before, JSON.stringify(configOf('pasted')));

  const callsBefore = ghCalls().length;
  const dormant = await call('/api/project-board?workspace=plain');
  check('a board that names no project still answers 404', dormant.status === 404,
        `${dormant.status} ${JSON.stringify(dormant.body)}`);
  check('and says so in the words it always said it in',
        /githubProject/.test(String(dormant.body?.error)), JSON.stringify(dormant.body));
  check('and spawns no gh for it', ghCalls().length === callsBefore,
        JSON.stringify(ghCalls().slice(callsBefore)));
} finally {
  server.stop();
}

// A live server holds handles that would keep this process up after the last case.
await sleep(200);
rmSync(workDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
