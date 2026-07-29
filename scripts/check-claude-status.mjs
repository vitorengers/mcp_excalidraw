#!/usr/bin/env node
/**
 * Checks `GET /api/claude-status` — what each Claude Code environment on this machine has
 * spent against its 5-hour and 7-day windows, and which account spent it.
 *
 * Nothing in this repository had ever read Claude Code's account or its limits, and there is
 * no supported way to pull them: the figures are *pushed*, once, into a live session's status
 * line command as `rate_limits.five_hour` and `rate_limits.seven_day`
 * (https://code.claude.com/docs/en/statusline). `/status` and `/usage` are interactive slash
 * commands, the OpenTelemetry export carries no quota, and the OAuth token in
 * `.credentials.json` is authentication material this repository has never touched.
 *
 * So the status line writes them down and the board reads them. `EXCALIDRAW_CLAUDE_STATUS`
 * names a **directory** the operator's status line command drops one small JSON file into,
 * per environment: `native.json` for the host, `wsl-<distro>.json` for a session inside a
 * distro (which reaches that directory through `/mnt/c/...`). A directory rather than each
 * home's own file is what lets one board see two machines without guessing at another
 * environment's `$HOME` or spawning a `wsl.exe` per poll.
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
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-claude-status.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => value.replace(/\\/g, '/');

/** A port nobody is on, so this can never collide with the board or another check. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const workDir = mkdtempSync(join(tmpdir(), 'check-claude-status-'));
const statusDir = join(workDir, 'claude-status');
const nativeProject = join(workDir, 'native-project');
mkdirSync(statusDir, { recursive: true });
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
writeFileSync(join(statusDir, 'native.json'), JSON.stringify({
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
writeFileSync(join(statusDir, 'wsl-Ubuntu-22.04.json'), JSON.stringify({
  account: 'wsl-user@example.com',
  rate_limits: { seven_day: { used_percentage: 12, resets_at: NOW + 5 * 86400 } },
  observedAt: NOW - 3600,
}), 'utf8');

// `Debian` gets no file at all: an environment nobody has run a session in is unknown.

// And one that is not JSON. A half-written file is the normal failure of a status line
// command that was killed mid-write, and it must cost that one environment its reading
// rather than the whole route.
writeFileSync(join(statusDir, 'wsl-Malformed.json'), '{ "account": "half-writ', 'utf8');

/**
 * A distro with a file and no project registered.
 *
 * The issue left this open — the registry is the only place a distro is declared, so an
 * environment the board has no project in cannot be enumerated from it. A file in the
 * directory is a declaration too, and the operator writing one is a clearer signal of intent
 * than a project they happen to have registered.
 */
writeFileSync(join(statusDir, 'wsl-Unregistered.json'), JSON.stringify({
  account: 'other@example.com',
  fiveHour: { usedPercent: 7, resetsAt: NOW + 900 },
  observedAt: NOW - 30,
}), 'utf8');

const started = [];

/**
 * A canvas server with exactly the environment given — every `EXCALIDRAW_*` this process
 * happens to hold is stripped first, so the machine running the check cannot decide the answer.
 */
async function startCanvas(extraEnv, host = '127.0.0.1') {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: host, LOG_LEVEL: 'error' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('EXCALIDRAW_')) delete env[key];
  }
  const child = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
    cwd: repoRoot, stdio: 'ignore', env: { ...env, ...extraEnv },
  });
  started.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${base}/health`);
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

  const board = await startCanvas({
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_CLAUDE_STATUS: statusDir,
  });

  const read = await get(board, '/api/claude-status');
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
    !read.text.includes(slash(statusDir)) && !read.text.includes(statusDir),
    'the status directory leaked into the response');

  // ─── Off unless configured, loopback only ───────────────────

  console.log('\n9. off unless configured');

  const unconfigured = await startCanvas({ EXCALIDRAW_WORKSPACES: registryPath });
  const missing = await get(unconfigured, '/api/claude-status');
  check('404 with no directory configured', missing.status === 404,
    `got ${missing.status} — ${missing.text.slice(0, 200)}`);
  check('and the refusal names the variable that would turn it on',
    /EXCALIDRAW_CLAUDE_STATUS/.test(missing.text), missing.text.slice(0, 200));

  console.log('\n10. and never off loopback, because it carries an email');

  const open = await startCanvas({
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_CLAUDE_STATUS: statusDir,
  }, '0.0.0.0');
  const refused = await get(open, '/api/claude-status');
  check('403 for a board that is not bound to loopback', refused.status === 403,
    `got ${refused.status} — ${refused.text.slice(0, 200)}`);
  check('the refusal names loopback', /loopback/i.test(refused.text), refused.text.slice(0, 200));
  check('and no account came back with it',
    !refused.text.includes('@example.com'), 'an email was served off loopback');
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
