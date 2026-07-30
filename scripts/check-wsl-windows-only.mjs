#!/usr/bin/env node
/**
 * Checks that a WSL-backed project is refused off Windows, in words, instead of spawning a
 * binary that is not there.
 *
 * Nothing conditioned the WSL path on the host platform. `resolveWorkspacePath` answers
 * `environment.kind === 'wsl'` for any registry entry carrying a `distro`, and for any
 * `\\wsl.localhost\…` path, on every platform — the only platform test in it decides whether
 * `hostPath` goes through the UNC share. Everything downstream then builds the literal binary
 * `wsl.exe`: the agent command, the worktree's `git`, the `gh` the project board mirror polls
 * with. On a mac each of those died with `spawn wsl.exe ENOENT`, naming a program the reader
 * has never heard of and cannot install, and `POST /api/workspaces` accepted a `distro` field
 * that could only ever produce such a project.
 *
 * So the four sections are the four halves of "Windows-only" being said out loud:
 *
 *  1. **The statement itself**, pure: `win32` has nothing to refuse, and anywhere else the
 *     sentence names WSL, Windows, and the platform the reader is actually on.
 *  2. **A board on a platform with no `wsl.exe`.** The tab comes up broken with that sentence
 *     on it rather than with `No board.config.json at /home/me/proj`, which reads as a missing
 *     file; a run against it is refused before anything is spawned; and the `+` refuses to
 *     write such a project down in the first place. A native project beside it stays clean —
 *     one project this board cannot reach must not take the others with it.
 *  3. **Windows is untouched.** Both spellings of a WSL project resolve to exactly the
 *     canonical, host and inner paths they resolved to before this existed, the tab is broken
 *     for whatever reason it was already broken for, and a `distro` is still accepted.
 *  4. **A reader is told the same thing**, by `docs/running.md`, without having to try it.
 *
 * **How another platform is simulated, and what that is worth.** Sections 2 and 3 start a real
 * `dist/server.js` from a launcher that rewrites `process.platform` before importing it. Node's
 * own modules have already chosen by then — `path` stays the host's — so what this simulates is
 * exactly the decision under test, "which platform does this code believe it is on", and not a
 * whole mac. That is the property being asserted, and it is why the same run means something on
 * a Windows machine, a Linux runner and a mac. Where a case genuinely needs the host to *be*
 * Windows — a directory that is really there, registered with a `distro` beside it — it says so
 * and stands down elsewhere rather than pretending.
 *
 * This file names `wsl.exe` in order to assert that nothing builds one, so it is listed in
 * `check-tiers.mjs`'s `SELF_DESCRIBING` for the reason `check-browser-strict.mjs` is: its
 * source is about the evidence rather than an instance of it. It needs no distro and never
 * spawns one.
 *
 * Self-contained: it builds a throwaway registry, project directories and launchers under the
 * temporary directory, starts its own canvas servers on ports the kernel just handed out and
 * kills them. No browser, no GitHub, no `wsl.exe`. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-wsl-windows-only.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let skipped = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function skip(name, why) {
  skipped++;
  console.log(`  skip  ${name} — ${why}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

/** The one binary this whole file exists to keep off a machine that has none. */
const WSL_BINARY = 'wsl.exe';

/** A distro that cannot be behind the UNC share on any machine, including the maintainer's. */
const DISTRO = 'Not-A-Real-Distro';
const INNER = '/home/me/proj';
const UNC = `\\\\wsl.localhost\\${DISTRO}\\home\\me\\proj`;

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `wsl-windows-only-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

function makeProject(name) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name }, null, 2), 'utf8');
  return dir;
}

const nativeDir = makeProject('native-project');
/** Three directories that are really there, one per project this check registers. */
const acceptedDir = join(workDir, 'accepted-project');
const ordinaryDir = join(workDir, 'ordinary-project');
const withDistroDir = join(workDir, 'with-distro-project');
for (const dir of [acceptedDir, ordinaryDir, withDistroDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'wsl-project', path: INNER, distro: DISTRO },
    { id: 'native-project', path: slash(nativeDir) },
  ],
}, null, 2), 'utf8');

const readRegistry = () => JSON.parse(readFileSync(registryPath, 'utf8'));

/**
 * An implement agent that records having been started.
 *
 * It can only ever run on the native side — a WSL workspace's command is wrapped in the
 * binary above, which is the thing that is missing — so the marker is the second half of the
 * refusal: the route answered 400, and nothing was spawned on the way to answering it.
 */
const markerPath = join(workDir, 'the-agent-ran');
const agentStub = join(workDir, 'agent-stub.mjs');
writeFileSync(agentStub,
  `import { writeFileSync } from 'node:fs';\n`
  + `writeFileSync(${JSON.stringify(markerPath)}, 'started\\n', 'utf8');\n`,
  'utf8');

/**
 * A canvas that believes it is running on `platform`.
 *
 * The rewrite happens here, before `dist/server.js` is imported, and nowhere inside the
 * product: a board that could be told its own platform by the environment would be one
 * environment variable away from spawning the missing binary on purpose.
 */
function launcher(platform) {
  const server = join(repoRoot, 'dist', 'server.js');
  const file = join(workDir, `canvas-as-${platform}.mjs`);
  writeFileSync(file,
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });\n`
    // `dist/server.js` only listens when it is the entry point (`isMainModule`), and imported
    // from here it is not. Handing it its own path is what makes this a launcher rather than
    // a second program: the board that comes up is the board, on the port it was given.
    + `process.argv[1] = ${JSON.stringify(server)};\n`
    + `await import(${JSON.stringify(pathToFileURL(server).href)});\n`,
    'utf8');
  return file;
}

/** The same rewrite, for a child that only wants to ask the path resolver a question. */
function probe(platform) {
  const file = join(workDir, `probe-as-${platform}.mjs`);
  writeFileSync(file,
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });\n`
    + `const { resolveWorkspacePath } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'dist', 'core', 'workspace-paths.js')).href)});\n`
    + `console.log(JSON.stringify({\n`
    + `  unc: resolveWorkspacePath(${JSON.stringify(UNC)}),\n`
    + `  posix: resolveWorkspacePath(${JSON.stringify(INNER)}, ${JSON.stringify(DISTRO)}),\n`
    + `}));\n`,
    'utf8');
  return file;
}

function runProbe(platform) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probe(platform)], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('close', () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ error: `${out}${err}` }); }
    });
    child.on('error', (error) => resolve({ error: error.message }));
  });
}

const running = [];

/**
 * A board on `platform`, with a registry, an implement agent on both sides and nothing else.
 *
 * `HOME`, `USERPROFILE` and `LOCALAPPDATA` are pointed into the throwaway directory because
 * the log path and the pidfile are chosen from the platform too: a server told it is a mac
 * would otherwise write `Library/Logs` into the operator's real home.
 */
async function startBoard(platform) {
  const port = await freePort();
  const server = startCanvas({
    port,
    script: launcher(platform),
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, `board-${platform}.log`),
      HOME: workDir,
      USERPROFILE: workDir,
      LOCALAPPDATA: workDir,
      XDG_STATE_HOME: workDir,
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_IMPLEMENT_AGENT: `node ${slash(agentStub)}`,
      EXCALIDRAW_IMPLEMENT_AGENT_WSL: `node ${slash(agentStub)}`,
    },
  });
  running.push(server.child);

  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the ${platform} canvas exited early:\n${server.read()}`);
    }
    try {
      if ((await fetch(`${server.base}/health`)).ok) return server;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the ${platform} canvas never answered on ${server.base}:\n${server.read()}`);
}

async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const addProject = (base, body) =>
  call(base, '/api/workspaces', { method: 'POST', body: JSON.stringify(body) });
const listProjects = (base) => call(base, '/api/workspaces');
const workspaceIn = (listed, id) => (listed.body?.workspaces ?? []).find((one) => one.id === id);

/** Whether a sentence says which platform this is and that the other one is Windows. */
const namesTheRule = (text) =>
  typeof text === 'string' && /\bWSL\b/.test(text) && /\bWindows-only\b/.test(text);

try {
  // ─── 1 ────────────────────────────────────────────────────────
  console.log('1. the board can say why a distro is not reachable from here');

  const pathsModule = join(repoRoot, 'dist', 'core', 'workspace-paths.js');
  if (!existsSync(pathsModule)) {
    check('dist/core/workspace-paths.js exists', false, 'run ./node_modules/.bin/tsc first');
  } else {
    const { wslUnsupportedHere } = await import(pathToFileURL(pathsModule).href);
    if (typeof wslUnsupportedHere !== 'function') {
      check('workspace-paths exports wslUnsupportedHere', false,
            'without it nothing conditions the WSL path on the host platform, and every '
            + `command built for such a project is ${WSL_BINARY}`);
    } else {
      check('on Windows there is nothing to refuse', wslUnsupportedHere('win32') === null,
            JSON.stringify(wslUnsupportedHere('win32')));
      check('on darwin it names WSL and Windows', namesTheRule(wslUnsupportedHere('darwin')),
            JSON.stringify(wslUnsupportedHere('darwin')));
      check('and the platform the reader is actually on',
            /darwin/.test(wslUnsupportedHere('darwin') ?? ''),
            JSON.stringify(wslUnsupportedHere('darwin')));
      check('linux gets the same sentence, about linux',
            namesTheRule(wslUnsupportedHere('linux')) && /linux/.test(wslUnsupportedHere('linux')),
            JSON.stringify(wslUnsupportedHere('linux')));
    }
  }

  // ─── 2 ────────────────────────────────────────────────────────
  console.log('\n2. a board with no wsl.exe refuses the project instead of spawning one');

  const mac = await startBoard('darwin');
  const macList = await listProjects(mac.base);
  const macWsl = workspaceIn(macList, 'wsl-project');

  check('the WSL project is still listed', Boolean(macWsl),
        JSON.stringify((macList.body?.workspaces ?? []).map((one) => one.id)));
  check('and it is marked broken, with the reason', namesTheRule(macWsl?.error),
        JSON.stringify(macWsl?.error));
  check('the reason names this platform rather than a missing file',
        /darwin/.test(macWsl?.error ?? '') && !/board\.config\.json/.test(macWsl?.error ?? ''),
        JSON.stringify(macWsl?.error));
  check('the native project beside it is unaffected',
        workspaceIn(macList, 'native-project')?.error === null,
        JSON.stringify(workspaceIn(macList, 'native-project')));

  const started = await call(mac.base, '/api/implement?workspace=wsl-project', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://github.com/vitorengers/mcp_excalidraw/issues/286' }),
  });
  check('a run against it is refused', started.status === 400,
        `got ${started.status} ${JSON.stringify(started.body)}`);
  check('and the refusal carries the same sentence', namesTheRule(started.body?.error),
        JSON.stringify(started.body?.error));
  check(`nothing was spawned on the way to that answer, ${WSL_BINARY} least of all`,
        !existsSync(markerPath),
        'the implement agent stub recorded a start');

  const before = readRegistry().workspaces.length;
  const posted = await addProject(mac.base, { path: '/home/me/another', distro: DISTRO });
  check('the + refuses a distro', posted.status === 400,
        `got ${posted.status} ${JSON.stringify(posted.body)}`);
  check('with the reason, not a directory it could not read', namesTheRule(posted.body?.error),
        JSON.stringify(posted.body?.error));

  const postedUnc = await addProject(mac.base, { path: '\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\other' });
  check('and the UNC spelling, which needs no distro field to be one', postedUnc.status === 400,
        `got ${postedUnc.status} ${JSON.stringify(postedUnc.body)}`);
  check('nothing was written to the registry by either', readRegistry().workspaces.length === before,
        JSON.stringify(readRegistry().workspaces.map((entry) => entry.id)));

  const stillNative = await addProject(mac.base, { path: slash(acceptedDir) });
  check('a project that is not WSL-backed is still accepted here', stillNative.status === 201,
        `got ${stillNative.status} ${JSON.stringify(stillNative.body)}`);

  // ─── 3 ────────────────────────────────────────────────────────
  console.log('\n3. on Windows the same registry resolves exactly as it did');

  const expected = {
    canonical: `wsl:${DISTRO.toLowerCase()}:${INNER}`,
    hostPath: UNC,
    innerPath: INNER,
    environment: { kind: 'wsl', distro: DISTRO },
  };
  const resolved = await runProbe('win32');
  for (const [spelling, got] of Object.entries(resolved)) {
    if (spelling === 'error') {
      check('the path resolver answered', false, resolved.error);
      continue;
    }
    check(`the ${spelling} spelling still resolves to one WSL project`,
          got?.canonical === expected.canonical
          && got?.hostPath === expected.hostPath
          && got?.innerPath === expected.innerPath
          && got?.environment?.kind === 'wsl'
          && got?.environment?.distro === DISTRO,
          `${JSON.stringify(got)} — expected ${JSON.stringify(expected)}`);
  }

  const windows = await startBoard('win32');
  const winList = await listProjects(windows.base);
  const winWsl = workspaceIn(winList, 'wsl-project');

  check('the entry is still a WSL workspace there', winWsl?.environment?.kind === 'wsl',
        JSON.stringify(winWsl?.environment));
  check('with the host and inner paths it always had',
        winWsl?.path === UNC && winWsl?.innerPath === INNER,
        JSON.stringify({ path: winWsl?.path, innerPath: winWsl?.innerPath }));
  check('and whatever it says about itself, it is not that Windows is elsewhere',
        !namesTheRule(winWsl?.error), JSON.stringify(winWsl?.error));

  const winPosted = await addProject(windows.base, { path: INNER, distro: DISTRO });
  check('the same POST is not refused for the platform there',
        !namesTheRule(winPosted.body?.error),
        `got ${winPosted.status} ${JSON.stringify(winPosted.body)}`);

  const plain = await addProject(windows.base, { path: slash(ordinaryDir) });
  check('and an ordinary project is accepted', plain.status === 201,
        `got ${plain.status} ${JSON.stringify(plain.body)}`);

  // The one case that cannot be simulated: a directory that is really there, registered with
  // a `distro` beside it. Off Windows that path is POSIX, so the resolver reads it as the
  // inner path of a distro and the host path becomes a UNC share nothing can stat.
  if (process.platform === 'win32') {
    const withDistro = await addProject(windows.base, {
      path: slash(withDistroDir), id: 'with-distro', distro: DISTRO,
    });
    check('a distro field on Windows is still accepted', withDistro.status === 201,
          `got ${withDistro.status} ${JSON.stringify(withDistro.body)}`);
  } else {
    skip('a distro field on Windows is still accepted',
         `this is ${process.platform}, where a real directory cannot also be inside a distro`);
  }

  // ─── 4 ────────────────────────────────────────────────────────
  console.log('\n4. docs/running.md tells a reader the same thing');

  const doc = readFileSync(join(repoRoot, 'docs', 'running.md'), 'utf8');
  const headings = [...doc.matchAll(/^##\s+(.+?)\s*$/gm)].map(([, title]) => title);
  const windowsHeading = headings.find((title) => /^Windows only\b/i.test(title));
  check('there is a Windows-only heading', Boolean(windowsHeading), headings.join(' | '));
  check('and it says what it is about', /WSL/i.test(windowsHeading ?? ''), windowsHeading);

  const sections = doc.split(/^##\s+/m).slice(1);
  const sectionOf = (needle) => sections.find((section) => section.includes(needle));
  const WSL_VARIABLES = [
    'EXCALIDRAW_ISSUE_AGENT_WSL',
    'EXCALIDRAW_IMPLEMENT_AGENT_WSL',
    'EXCALIDRAW_GH_COMMAND_WSL',
  ];
  for (const variable of WSL_VARIABLES) {
    const where = sectionOf(`\`${variable}\``);
    check(`${variable} is documented under it`,
          Boolean(where) && /^Windows only\b/i.test(where),
          `it is under "${(where ?? '').split(/\r?\n/)[0] ?? 'nothing'}"`);
  }

  const general = sectionOf('| `EXCALIDRAW_WORKSPACES` |') ?? '';
  const stragglers = WSL_VARIABLES.filter((variable) => general.includes(`| \`${variable}\``));
  check('no _WSL row is left in the general table', stragglers.length === 0, stragglers.join(', '));
  check('and the general table says the rest apply everywhere',
        /macOS|mac\b|three platforms|Linux/i.test(general.split(/\r?\n/).slice(0, 12).join('\n')),
        'a reader on a mac has to be told which of these are theirs');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(200);
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(300);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log(skipped ? `\nall cases passed (${skipped} skipped)` : '\nall cases passed');
