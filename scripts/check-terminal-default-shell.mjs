#!/usr/bin/env node
/**
 * Checks which shell a board starts when `EXCALIDRAW_TERMINAL` says "on" and nothing else.
 *
 * `defaultShellCommand` returned the literal string `bash` for every non-Windows workspace,
 * and that was a decision made on a machine whose only non-Windows case is a WSL Ubuntu
 * whose login shell really is bash. Elsewhere it is wrong twice over: on macOS the login
 * shell has been zsh since Catalina and `/bin/bash` is Apple's 3.2 from 2007, so the
 * headline feature opens a shell with none of the reader's rc files, aliases or prompt; on a
 * minimal Debian, an Alpine or a container image carrying only dash or ash, `bash` is not on
 * `PATH` at all and the session dies in the spawn.
 *
 * So a native POSIX workspace gets `$SHELL` where the machine names one, and an absolute
 * path that exists where it does not. The two branches either side of that are asserted
 * unchanged, because both are right for reasons `$SHELL` has nothing to say about: a WSL
 * workspace runs inside a distro where the variable is the *host's* and means nothing, and
 * Windows has no `$SHELL` to read.
 *
 * ## Why this stubs the platform rather than reading the machine's
 *
 * Every assertion here is about a platform, and the machine this repository is maintained on
 * reports `win32` — so a check that simply called the function would run its POSIX cases on
 * the Windows branch and pass without ever reaching the code it is about. That is the exact
 * failure `CLAUDE.md`'s write-the-check-first rule exists to catch, and it is named in the
 * issue's own Risk section.
 *
 * Each case therefore runs in a child process which redefines `process.platform` **before**
 * importing the compiled module, and every child reports the platform it ended up with, so a
 * stub that failed to take shows up as a failure rather than as a green run of the wrong
 * branch. `$SHELL` is stubbed the same way, in the child's environment, through
 * `canvasEnvironment` — this machine's session carries an `.env` and a `SHELL` of its own,
 * and a check that inherited either would be asserting the operator's machine.
 *
 * Offline and self-contained: no server, no browser, no network. It imports `dist/`, so run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-terminal-default-shell.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canvasEnvironment } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(join(repoRoot, 'dist', 'core', 'terminal-session.js')).href;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The two spellings Windows needs, which are not this issue's business and must not move. */
const POWERSHELL_PTY = 'powershell.exe -NoLogo -NoProfile';
const POWERSHELL_PIPE = 'powershell.exe -NoLogo -NoProfile -Command -';

/** What an unset or unusable `$SHELL` is allowed to fall back to. */
const FALLBACKS = ['/bin/bash', '/bin/sh'];

/**
 * Ask the compiled module what it would start, on a platform of our choosing.
 *
 * The workspace is a literal rather than a resolved one because `defaultShellCommand` reads
 * exactly one field of it — `environment.kind` — and building a real registry to hand over a
 * two-key object would only hide which field decides.
 */
function ask({ platform, shell, kind = 'native' }) {
  const environment = kind === 'wsl'
    ? { kind: 'wsl', distro: 'Ubuntu' }
    : { kind: 'native' };
  const source = `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });
    const module = await import(${JSON.stringify(moduleUrl)});
    const workspace = { id: 'shell-check', environment: ${JSON.stringify(environment)} };
    process.stdout.write(JSON.stringify({
      platform: process.platform,
      shell: process.env.SHELL ?? null,
      pty: module.defaultShellCommand(workspace, 'pty'),
      pipe: module.defaultShellCommand(workspace, 'pipe'),
      settingPty: module.shellCommandFrom('1', workspace, 'pty'),
      settingPipe: module.shellCommandFrom('default', workspace, 'pipe'),
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    // `canvasEnvironment` rather than `process.env`: the module pulls in `config.js`, which
    // reads the `.env` beside the working directory, and this machine's session carries a
    // `SHELL` of its own — either would decide the answer instead of the argument below.
    env: canvasEnvironment({ SHELL: shell }),
  });
  if (result.status !== 0) throw new Error(`could not ask the module: ${result.stderr || result.error}`);
  const answer = JSON.parse(result.stdout);
  // A stub that did not take would run the real platform's branch and pass on the wrong one.
  if (answer.platform !== platform) {
    throw new Error(`the platform stub did not take: asked for ${platform}, the child reported ${answer.platform}`);
  }
  return answer;
}

const absolutePosix = (value) => typeof value === 'string' && value.startsWith('/');

try {
  console.log('1. a native workspace starts the login shell the machine names');
  for (const platform of ['darwin', 'linux']) {
    const answer = ask({ platform, shell: '/usr/bin/fish' });
    check(`${platform}: a pseudoterminal gets $SHELL`, answer.pty === '/usr/bin/fish', answer.pty);
    check(`${platform}: and so does a pipe`, answer.pipe === '/usr/bin/fish', answer.pipe);
    // A bare `EXCALIDRAW_TERMINAL=1` is the only way anyone reaches the default, so the route
    // that carries it is asserted rather than assumed to pass its arguments on.
    check(`${platform}: EXCALIDRAW_TERMINAL=1 resolves to the same shell`,
          answer.settingPty === '/usr/bin/fish' && answer.settingPipe === '/usr/bin/fish',
          `${answer.settingPty} / ${answer.settingPipe}`);
    check(`${platform}: and no POSIX shell is handed a Windows flag`,
          !answer.pipe.includes('-Command'), answer.pipe);
  }

  console.log('\n2. and where it names none, an absolute path rather than a name to look up');
  //
  // The decision the issue left open: `/bin/bash` where it exists, because it is the closest
  // match to what this returned before, and `/bin/sh` otherwise, because it is the only shell
  // POSIX guarantees is there. A bare name is what the defect was — `bash` is not on the PATH
  // of an Alpine or a minimal Debian, and the session dies in the spawn rather than saying so.
  for (const shell of [undefined, '', '   ', 'bash', 'fish', '~/bin/zsh', 'usr/bin/zsh']) {
    const named = shell === undefined ? 'unset' : JSON.stringify(shell);
    const answer = ask({ platform: 'linux', shell });
    check(`$SHELL ${named}: the answer is an absolute POSIX path`,
          absolutePosix(answer.pty), answer.pty);
    check(`$SHELL ${named}: and it is one of ${FALLBACKS.join(' or ')}`,
          FALLBACKS.includes(answer.pty), answer.pty);
    check(`$SHELL ${named}: the pipe answer is the same`, answer.pipe === answer.pty,
          `${answer.pty} / ${answer.pipe}`);
  }

  // The done-when asks for a path that *exists*, and only a POSIX machine can be asked that.
  // On this one the probe below answers for `C:\bin\bash`, so it is reported rather than
  // asserted — the shape of the answer is what a Windows box can honestly check.
  const fallback = ask({ platform: 'linux', shell: undefined }).pty;
  if (process.platform === 'win32') {
    console.log(`  (this machine reports win32, so "${fallback}" cannot be probed here — the `
      + 'existence half of the rule is asserted on a POSIX box)');
  } else {
    check('and on this machine that path is really there', existsSync(fallback), fallback);
    check('and it is the closest match present', fallback === (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'),
          fallback);
  }

  console.log('\n3. a WSL-backed workspace is untouched, because $SHELL there is the host\'s');
  for (const platform of ['win32', 'linux']) {
    const answer = ask({ platform, shell: '/usr/bin/fish', kind: 'wsl' });
    check(`${platform}: a pseudoterminal still gets bash`, answer.pty === 'bash', answer.pty);
    check(`${platform}: and so does a pipe`, answer.pipe === 'bash', answer.pipe);
  }

  console.log('\n4. and Windows keeps both of its spellings, $SHELL or no $SHELL');
  for (const shell of ['/usr/bin/fish', undefined]) {
    const named = shell === undefined ? 'unset' : JSON.stringify(shell);
    const answer = ask({ platform: 'win32', shell });
    check(`$SHELL ${named}: the pseudoterminal spelling`, answer.pty === POWERSHELL_PTY, answer.pty);
    // `-Command -` is refused outright when stdin is a terminal, so the two are not a
    // preference and a check that let them merge would take a working feature apart.
    check(`$SHELL ${named}: and the pipe spelling, which reads stdin`,
          answer.pipe === POWERSHELL_PIPE, answer.pipe);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  the check ran to the end — ${error.message}`);
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
