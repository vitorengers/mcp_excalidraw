#!/usr/bin/env node
/**
 * Checks `GET /api/agent-limits` — what each coding-agent environment on this machine has
 * spent against its 5-hour and 7-day windows, and which account spent it.
 *
 * Nothing in this repository had ever read a coding agent's account or its limits, and for the
 * one backend that can answer there is no supported way to *pull* them: the figures are
 * *pushed*, once, into a live session's status line command as `rate_limits.five_hour` and
 * `rate_limits.seven_day` (https://code.claude.com/docs/en/statusline). `/status` and `/usage`
 * are interactive slash commands, the OpenTelemetry export carries no quota, and the OAuth
 * token in `.credentials.json` is authentication material this repository has never touched.
 *
 * So the status line writes them down and the board reads them. `VIBEMAXXING_AGENT_LIMITS`
 * names a **directory** the operator's status line command drops one small JSON file into,
 * per environment: `native.json` for the host, `wsl-<distro>.json` for a session inside a
 * distro (which reaches that directory through `/mnt/c/...`). A directory rather than each
 * home's own file is what lets one board see two machines without guessing at another
 * environment's `$HOME` or spawning a `wsl.exe` per poll.
 *
 * **Reading is a backend's, not the board's.** `AgentAdapter.readLimits` is optional, and it is
 * absent on every backend that cannot answer — so the question "what has this machine spent"
 * is asked of the agent rather than of one vendor's file layout, and a second reader can be
 * added without renaming a route, a component or a variable a second time (#334).
 *
 * The cases below are the ones the shape has to get right, and every one of them is a way of
 * being wrong that reads as an answer:
 *
 *  - **Two environments must not leak into each other.** Different accounts is the normal
 *    case here, not the exception — two homes are two credential stores — and a HUD that
 *    showed one home's percentage against the other's email would be worse than showing
 *    nothing.
 *  - **Absent is `null`, never `0`.** A window "appears only for Claude.ai subscribers
 *    (Pro/Max) after the first API response in the session", each independently. `0%` is a
 *    claim that nothing has been spent; silence is not that claim, and this is the same
 *    distinction `agent-usage.ts` draws for reasoning tokens.
 *  - **A reading has an age.** The honest cost of route A is that the file is only as fresh
 *    as the last session that wrote it, so a percentage without its age reads as current when
 *    it is not.
 *  - **Nothing from the file is echoed.** Only known fields are projected out, so an operator
 *    who dumps a wider object into that directory cannot publish a token through this route.
 *
 * Self-contained: it starts its own canvas servers on free ports of their own and kills them.
 * Nothing here talks to the board, to GitHub, to WSL or to the network. Run
 * `./node_modules/.bin/tsc` first — sections 11 and 12 import the compiled adapters and read
 * the sources beside them.
 *
 * Usage: node scripts/check-agent-limits.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';
import { remoteInterfaceAddress } from './lib/remote-caller.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => value.replace(/\\/g, '/');

const workDir = mkdtempSync(join(tmpdir(), 'check-agent-limits-'));
const limitsDir = join(workDir, 'agent-limits');
const nativeProject = join(workDir, 'native-project');
mkdirSync(limitsDir, { recursive: true });
mkdirSync(nativeProject, { recursive: true });
writeFileSync(join(nativeProject, 'board.config.json'), JSON.stringify({ name: 'Native' }), 'utf8');

// ─── The registry: one native project and three distros ───────
//
// The WSL entries name directories that do not exist, and deliberately: a distro is
// *declared*, never detected (`workspace-paths.ts`), and what this route needs from the
// registry is the distro name and nothing else. `loadWorkspace` returns a project it could
// not read rather than dropping it, so the environment is still enumerated.

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'native-project', path: slash(nativeProject) },
    { id: 'ubuntu-project', path: '/home/me/ubuntu-project', distro: 'Ubuntu-22.04' },
    { id: 'debian-project', path: '/home/me/debian-project', distro: 'Debian' },
    { id: 'broken-project', path: '/home/me/broken-project', distro: 'Malformed' },
  ],
}), 'utf8');

const NOW = Math.floor(Date.now() / 1000);

/**
 * The host: both windows, fresh — and a decoy.
 *
 * `oauthAccessToken` is not a field this reads, and it is here so that a response built by
 * echoing the file rather than by projecting known fields out of it fails loudly. An operator
 * who pipes a wider object into that directory must not thereby publish it on an
 * unauthenticated local route.
 */
const DECOY = 'sk-ant-oat01-NEVER-LEAK-THIS';
writeFileSync(join(limitsDir, 'native.json'), JSON.stringify({
  account: 'windows-user@example.com',
  fiveHour: { usedPercent: 23.5, resetsAt: NOW + 3600 },
  sevenDay: { usedPercent: 41.2, resetsAt: NOW + 3 * 86400 },
  observedAt: NOW,
  oauthAccessToken: DECOY,
}), 'utf8');

/**
 * A distro: a different account, one window only, and an hour old.
 *
 * Spelled the way Claude Code itself spells it — `rate_limits.seven_day.used_percentage` —
 * because the shortest status line command that can write this file is a `jq` that passes
 * the object it was handed straight through. `five_hour` is absent, which is exactly what a
 * session that has not had one reported looks like.
 */
writeFileSync(join(limitsDir, 'wsl-Ubuntu-22.04.json'), JSON.stringify({
  account: 'wsl-user@example.com',
  rate_limits: { seven_day: { used_percentage: 12, resets_at: NOW + 5 * 86400 } },
  observedAt: NOW - 3600,
}), 'utf8');

// `Debian` gets no file at all: an environment nobody has run a session in is unknown.

// And one that is not JSON. A half-written file is the normal failure of a status line
// command that was killed mid-write, and it must cost that one environment its reading
// rather than the whole route.
writeFileSync(join(limitsDir, 'wsl-Malformed.json'), '{ "account": "half-writ', 'utf8');

/**
 * A distro with a file and no project registered.
 *
 * The issue left this open — the registry is the only place a distro is declared, so an
 * environment the board has no project in cannot be enumerated from it. A file in the
 * directory is a declaration too, and the operator writing one is a clearer signal of intent
 * than a project they happen to have registered.
 */
writeFileSync(join(limitsDir, 'wsl-Unregistered.json'), JSON.stringify({
  account: 'other@example.com',
  fiveHour: { usedPercent: 7, resetsAt: NOW + 900 },
  observedAt: NOW - 30,
}), 'utf8');

const started = [];

/**
 * A canvas server with exactly the environment given. Stripping every `EXCALIDRAW_*` out of the
 * child — so the machine running the check cannot decide the answer — is
 * `scripts/lib/spawn-canvas.mjs`'s job now, together with the `.env` this used to miss.
 */
async function canvasWith(extraEnv, host = '127.0.0.1', reachOn = '127.0.0.1') {
  const port = await freePort();
  const { child } = startCanvas({
    port,
    env: {
      HOST: host,
      LOG_LEVEL: 'error',
      // A request to `http://<interface>:<port>` names that authority in `Host`, which a board
      // bound to `0.0.0.0` does not answer for. The origin gate is a different control from the
      // caller guard, and a case that wants the second refusal has to get past the first.
      ...(reachOn === '127.0.0.1' ? {} : { EXCALIDRAW_ALLOWED_HOSTS: `${reachOn}:${port}` }),
      ...extraEnv,
    },
  });
  started.push(child);
  const health = `http://127.0.0.1:${port}`;
  const base = `http://${reachOn}:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${health}/health`);
      if (response.ok) return base;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server on ${port} never came up`);
}

async function get(base, path) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON, which is itself an answer */ }
  return { status: response.status, body, text };
}

const byLabel = (records, label) => (records ?? []).find((entry) => entry.label === label) ?? null;

try {
  // ─── A board with the directory configured ──────────────────

  console.log('\n1. the route answers, once the directory is configured');

  const board = await canvasWith({
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_AGENT_LIMITS: limitsDir,
  });

  const read = await get(board, '/api/agent-limits');
  check('200 for the read', read.status === 200, `got ${read.status} — ${read.text.slice(0, 200)}`);
  check('and it carries a list of environments',
    Array.isArray(read.body?.environments), JSON.stringify(read.body).slice(0, 300));

  const environments = read.body?.environments ?? [];

  // ─── Two environments, kept apart ───────────────────────────

  console.log('\n2. two environments, reported independently');

  const host = environments.find((entry) => entry?.environment?.kind === 'native') ?? null;
  const ubuntu = byLabel(environments, 'Ubuntu-22.04');

  check('the host is reported', host !== null, JSON.stringify(environments.map((e) => e?.label)));
  check('and it is labelled for a reader rather than by its kind',
    typeof host?.label === 'string' && /^(Windows|Host)$/.test(host.label), JSON.stringify(host?.label));
  check('the registered distro is reported, under its own name',
    ubuntu !== null && ubuntu.environment?.kind === 'wsl' && ubuntu.environment?.distro === 'Ubuntu-22.04',
    JSON.stringify(ubuntu));

  check('the host carries its own account',
    host?.account === 'windows-user@example.com', JSON.stringify(host?.account));
  check('the distro carries a different one',
    ubuntu?.account === 'wsl-user@example.com', JSON.stringify(ubuntu?.account));
  check('and neither has taken the other’s',
    host?.account !== ubuntu?.account,
    `both said ${JSON.stringify(host?.account)}`);

  // ─── The windows themselves ─────────────────────────────────

  console.log('\n3. the two windows, as the status line reports them');

  check('the 5-hour window comes through with its percentage',
    host?.fiveHour?.usedPercent === 23.5, JSON.stringify(host?.fiveHour));
  check('and with the moment it resets',
    host?.fiveHour?.resetsAt === NOW + 3600, JSON.stringify(host?.fiveHour));
  check('the 7-day window too',
    host?.sevenDay?.usedPercent === 41.2 && host?.sevenDay?.resetsAt === NOW + 3 * 86400,
    JSON.stringify(host?.sevenDay));

  check('a file written in Claude Code’s own spelling is read the same way',
    ubuntu?.sevenDay?.usedPercent === 12 && ubuntu?.sevenDay?.resetsAt === NOW + 5 * 86400,
    JSON.stringify(ubuntu?.sevenDay));

  check('an absent window stays null, and is never reported as 0%',
    ubuntu?.fiveHour === null, JSON.stringify(ubuntu?.fiveHour));

  // ─── How old the reading is ─────────────────────────────────

  console.log('\n4. a reading is only as fresh as the session that wrote it');

  check('a reading from a moment ago is not stale',
    host?.stale === false, JSON.stringify({ stale: host?.stale, age: host?.ageSeconds }));
  check('and it says how old it is',
    typeof host?.ageSeconds === 'number' && host.ageSeconds >= 0 && host.ageSeconds < 120,
    JSON.stringify(host?.ageSeconds));
  check('an hour-old reading is flagged stale on the record',
    ubuntu?.stale === true, JSON.stringify({ stale: ubuntu?.stale, age: ubuntu?.ageSeconds }));
  check('with an age to match',
    typeof ubuntu?.ageSeconds === 'number' && ubuntu.ageSeconds >= 3500,
    JSON.stringify(ubuntu?.ageSeconds));
  check('and the response says where the line between the two is',
    typeof read.body?.staleAfterSeconds === 'number' && read.body.staleAfterSeconds > 0,
    JSON.stringify(read.body?.staleAfterSeconds));

  // ─── Nothing said is not zero, and not an error ─────────────

  console.log('\n5. an environment that has never answered is unknown');

  const debian = byLabel(environments, 'Debian');
  check('a registered distro with no file is still listed',
    debian !== null, JSON.stringify(environments.map((e) => e?.label)));
  check('and everything about it is null rather than zero',
    debian?.account === null && debian?.fiveHour === null
    && debian?.sevenDay === null && debian?.observedAt === null,
    JSON.stringify(debian));
  check('an unknown environment is not "stale" either — nothing was said to go off',
    debian?.stale === false && debian?.ageSeconds === null, JSON.stringify(debian));

  console.log('\n6. a half-written file costs one environment, not the route');

  const malformed = byLabel(environments, 'Malformed');
  check('the route still answered 200 with a file that is not JSON in the directory',
    read.status === 200, `got ${read.status}`);
  check('the environment is listed, and reads as unknown',
    malformed !== null && malformed.account === null && malformed.fiveHour === null,
    JSON.stringify(malformed));

  console.log('\n7. a file for a distro no project is registered in is still read');

  const unregistered = byLabel(environments, 'Unregistered');
  check('the environment is reported',
    unregistered !== null, JSON.stringify(environments.map((e) => e?.label)));
  check('with its own account and window',
    unregistered?.account === 'other@example.com' && unregistered?.fiveHour?.usedPercent === 7,
    JSON.stringify(unregistered));

  // ─── What must never come back ──────────────────────────────

  console.log('\n8. nothing but the fields this route is for');

  check('no value from the file that this route does not name reaches the response',
    !read.text.includes(DECOY), 'a decoy credential was echoed back');
  check('nor the key it was written under',
    !/oauthAccessToken/i.test(read.text), 'an unknown key was echoed back');
  check('and no absolute path to the directory either',
    !read.text.includes(slash(limitsDir)) && !read.text.includes(limitsDir),
    'the status directory leaked into the response');

  // ─── Off unless configured, loopback only ───────────────────

  console.log('\n9. off unless configured');

  const unconfigured = await canvasWith({ EXCALIDRAW_WORKSPACES: registryPath });
  const missing = await get(unconfigured, '/api/agent-limits');
  check('404 with no directory configured', missing.status === 404,
    `got ${missing.status} — ${missing.text.slice(0, 200)}`);
  check('and the refusal names the variable that would turn it on',
    /VIBEMAXXING_AGENT_LIMITS/.test(missing.text), missing.text.slice(0, 200));

  // Since #501 the guard asks who is calling rather than where the server opened, so a board on
  // every interface is not the case any more: the caller reaching it from somewhere else is.
  console.log('\n10. and never to a caller that is not on this machine, because it carries an email');

  const remote = await remoteInterfaceAddress((line) => console.log(`  note  ${line}`));
  if (!remote) {
    console.log('  note  this machine has no non-loopback address to be called on, so this case '
                + 'could not be run at all');
  } else {
    const open = await canvasWith({
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_AGENT_LIMITS: limitsDir,
    }, '0.0.0.0', remote);
    const refused = await get(open, '/api/agent-limits');
    check('403 for a caller that is not on this machine', refused.status === 403,
      `got ${refused.status} — ${refused.text.slice(0, 200)}`);
    check('the refusal names the caller, and is not the origin gate\'s',
      /machine/i.test(refused.text) && !/DNS rebinding/i.test(refused.text),
      refused.text.slice(0, 200));
    check('and no account came back with it',
      !refused.text.includes('@example.com'), 'an email was served to a caller off this machine');
  }

  // ─── Reading is a capability, not a fact about the board ─────

  console.log('\n11. a backend answers this, or declares that it cannot');

  const adaptersPath = join(repoRoot, 'dist', 'core', 'agents', 'index.js');
  if (!existsSync(adaptersPath)) {
    failures++;
    console.error('  FAIL  the adapters are compiled — dist/core/agents/index.js not found (run tsc)');
  } else {
    const { adapterFor } = await import(pathToFileURL(adaptersPath).href);

    // Optional, and the one backend whose file layout this reads is the one that has it. A
    // reader added for another backend joins here rather than renaming any of this again.
    check('the backend that can answer offers readLimits',
      typeof adapterFor('claude-code').readLimits === 'function',
      typeof adapterFor('claude-code').readLimits);

    // Absent rather than a stub that answers nothing: a method that exists and returns an empty
    // list is a backend claiming to have looked, which is the one answer worse than silence.
    for (const id of ['codex-cli', 'raw']) {
      check(`${id} declares that it cannot, by not having the method`,
        adapterFor(id).readLimits === undefined, typeof adapterFor(id).readLimits);
    }
  }

  // ─── One vendor's name is off every public surface ───────────

  console.log('\n12. nothing in this feature is named after one vendor');

  const source = (relative) => {
    const file = join(repoRoot, relative);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };

  // The file names first: a route can be renamed and the module behind it left where it was.
  for (const gone of [
    'src/core/claude-status.ts',
    'frontend/src/components/ClaudeStatusHud.tsx',
    'frontend/src/components/ClaudeStatusHud.css',
    'scripts/check-claude-status.mjs',
    'scripts/check-claude-status-browser.mjs',
  ]) {
    check(`${gone} is gone`, !existsSync(join(repoRoot, gone)), 'still tracked under the old name');
  }

  for (const there of [
    'src/core/agent-limits.ts',
    'frontend/src/components/AgentLimitsHud.tsx',
    'frontend/src/components/AgentLimitsHud.css',
  ]) {
    check(`${there} is where it went`, existsSync(join(repoRoot, there)), 'not found');
  }

  // Then the names inside them. Only the surfaces the issue names — a file, a route, an
  // exported symbol, a CSS class, an environment variable — because the *prose* still has to be
  // free to say which backend writes the files, and it does: the schema is Claude Code's.
  const named = [
    ['src/server.ts', /['"`]\/api\/claude-status['"`]|CLAUDE_STATUS|readClaudeStatus|ClaudeEnvironmentStatus/],
    ['src/core/settings.ts', /'CLAUDE_STATUS'/],
    ['src/core/agent-limits.ts', /export (?:interface|function|const|type) \w*Claude/],
    ['frontend/src/App.tsx', /claudeStatus|ClaudeStatusHud|ClaudeEnvironmentStatus|\/api\/claude-status/],
    ['frontend/src/components/AgentLimitsHud.tsx', /claude-status|Claude(?:RateWindow|EnvironmentStatus|StatusHud)/],
    ['frontend/src/components/AgentLimitsHud.css', /claude/i],
  ];
  for (const [relative, forbidden] of named) {
    const text = source(relative);
    const hit = text === null ? null : text.match(forbidden);
    check(`${relative} names no vendor in this feature`, text !== null && hit === null,
      text === null ? 'the file is not there' : `still says ${JSON.stringify(hit?.[0])}`);
  }

  check('the route is served under its new name',
    (source('src/server.ts') ?? '').includes(`app.get('/api/agent-limits'`),
    'src/server.ts does not register GET /api/agent-limits');
  check('and the variable that turns it on is the neutral one',
    (source('src/core/settings.ts') ?? '').includes(`name: 'AGENT_LIMITS'`),
    'src/core/settings.ts does not declare AGENT_LIMITS');

  // The old route is not a second door onto the same reading. Whatever an unknown /api path
  // answers on this build, it must not be a list of environments.
  const old = await get(board, '/api/claude-status');
  check('the old route no longer answers a reading',
    !(old.status === 200 && Array.isArray(old.body?.environments)),
    `got ${old.status} — ${old.text.slice(0, 120)}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const child of started) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
