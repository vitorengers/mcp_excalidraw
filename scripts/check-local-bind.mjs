#!/usr/bin/env node
/**
 * Checks where the canvas server binds, and what a second one on the same port does.
 *
 * Three properties: the default bind is IPv4 loopback and nothing else, a duplicate start on
 * a port already held exits rather than sitting there, and `HOST=::` — which would publish
 * the board on every interface — is refused.
 *
 * It asks the kernel for a free port and never reads `PORT`. It used to do the opposite —
 * `process.env.PORT || <a random number>` — and `PORT=3737` is in the development machine's
 * session, so it bound nothing, health-checked the operator's **live board** and reported the
 * duplicate-startup case green. See [trap-check-environment.md](../docs/trap-check-environment.md).
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-local-bind.mjs
 *
 * Tier: fast
 */
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment } from './lib/spawn-canvas.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const serverPath = join(repoRoot, 'dist', 'server.js');
const runtime = process.env.CANVAS_RUNTIME || process.execPath;
const runtimeName = basename(runtime).toLowerCase();
const runtimeArgs = runtimeName.includes('bun') ? ['run', serverPath] : [serverPath];
// Asked for, never read out of the environment. `PORT` is 3737 in this machine's session, so
// `process.env.PORT || <a random number>` used to make this check health-check the operator's
// live board and report the duplicate-startup case green without having started anything.
const port = await freePort();
const startupTimeoutMs = 5000;
const duplicateExitTimeoutMs = 2500;

function spawnCanvas(host) {
  // Not `startCanvas`: this is the one check that has to run the server under a runtime of its
  // own choosing (`CANVAS_RUNTIME`, for bun), and the default `HOST` is the subject rather than
  // a setting. The environment is built the same way every other check's is.
  const env = canvasEnvironment({
    PORT: String(port),
    LOG_LEVEL: 'error',
    HOST: host || undefined,
  });

  return spawn(runtime, runtimeArgs, {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collectOutput(child) {
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    output += chunk.toString();
  });
  return () => output.trim();
}

async function endpointResponds(url, timeoutMs = 500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(url, timeoutMs, child, getOutput) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const status = child.exitCode !== null ? `exit code ${child.exitCode}` : `signal ${child.signalCode}`;
      const output = getOutput ? getOutput() : '';
      throw new Error(`Canvas server exited before health check with ${status}.${output ? `\n${output}` : ''}`);
    }
    if (await endpointResponds(url)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };

    child.once('exit', onExit);
  });
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exit = await waitForExit(child, 1000);
  if (!exit) {
    child.kill('SIGKILL');
  }
}

let first;
let second;
let bindAll;

try {
  first = spawnCanvas();
  const firstOutput = collectOutput(first);

  await waitForHealth(`http://127.0.0.1:${port}/health`, startupTimeoutMs, first, firstOutput);

  if (await endpointResponds(`http://[::1]:${port}/health`)) {
    throw new Error('Default canvas server should not listen on IPv6 loopback.');
  }

  second = spawnCanvas();
  const secondOutput = collectOutput(second);
  const duplicateExit = await waitForExit(second, duplicateExitTimeoutMs);

  if (!duplicateExit) {
    throw new Error('Second canvas server stayed running on the same local port.');
  }
  if (duplicateExit.code === 0) {
    throw new Error('Second canvas server exited successfully instead of failing.');
  }

  bindAll = spawnCanvas('::');
  const bindAllOutput = collectOutput(bindAll);
  const bindAllExit = await waitForExit(bindAll, duplicateExitTimeoutMs);

  if (!bindAllExit) {
    throw new Error('Canvas server with HOST=:: stayed running while a loopback server was active.');
  }
  if (bindAllExit.code === 0) {
    throw new Error('Canvas server with HOST=:: exited successfully instead of failing.');
  }

  console.log(
    `Local bind check passed on port ${port} using ${runtimeName}: ` +
    'default bind is IPv4 loopback only, duplicate startup fails, and HOST=:: is guarded.'
  );

  await killChild(first);
  if (process.env.DEBUG_BIND_CHECK && firstOutput()) {
    console.error(firstOutput());
  }
  if (process.env.DEBUG_BIND_CHECK && secondOutput()) {
    console.error(secondOutput());
  }
  if (process.env.DEBUG_BIND_CHECK && bindAllOutput()) {
    console.error(bindAllOutput());
  }
} catch (error) {
  if (bindAll) await killChild(bindAll);
  if (second) await killChild(second);
  if (first) await killChild(first);
  console.error((error instanceof Error) ? error.message : String(error));
  process.exit(1);
}
