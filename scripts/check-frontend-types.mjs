#!/usr/bin/env node
/**
 * Checks that `frontend/` is type-checked, and that the type check catches what it is for.
 *
 * The root `tsconfig.json` compiles `src/` and excludes `frontend/`; `vite build` bundles
 * `frontend/` and only *strips* types, never checks them. Between the two, nothing read the
 * canvas half of this repository at all — so `adoptWorkspace` in `App.tsx` could call
 * `setWorkspacesConfigured(true)`, a name defined nowhere in the file or anywhere under
 * `frontend/`, and ship. Adding the first project through the `+` on the workspace strip then
 * threw a `ReferenceError` *after* the registry write had landed and before either of the two
 * lines that finish the gesture: the project was registered and its tab appeared, the dialog
 * stayed open with the error printed in it, and the board never switched to what had just been
 * added. On the M6 milestone that is the first thing a fresh clone does (#412).
 *
 * A green build was not evidence about that, and could not have been. So:
 *
 *  1. `frontend/tsconfig.json` exists, emits nothing, is `strict`, and covers both extensions
 *     — a config that quietly stopped including `.tsx` would leave `App.tsx` unread while
 *     every section below still passed.
 *  2. The frontend as it stands type-checks clean. This is the gate; the rest is about
 *     whether the gate is one.
 *  3. The shipped configuration, used as it ships, **rejects** the defect above. A probe that
 *     calls a name defined nowhere has to be `TS2304`, and one that reads a property off a
 *     typed object has to be `TS2339` — the second because a check that only proved "some
 *     error was reported" would pass against a config that had been reduced to a linter.
 *  4. And it **accepts** ordinary frontend code, JSX and all, so section 3 is not passing
 *     because the configuration refuses everything.
 *
 * Sections 3 and 4 build their probes in a temporary directory whose `tsconfig.json`
 * `extends` the real one, rather than restating its flags: a probe with its own hand-written
 * options would keep passing after somebody loosened the file that actually runs.
 *
 * Offline and self-contained. No server, no browser.
 *
 * Usage: node scripts/check-frontend-types.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = join(repoRoot, 'frontend');
const configPath = join(frontendDir, 'tsconfig.json');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// `tsc`'s own entry point under this Node, rather than the `.bin` wrapper: on Windows that
// wrapper is a `.cmd` and reaching it needs `shell: true`, which Node deprecates for a call
// that passes arguments.
const tscEntry = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/** Run `tsc` and hand back what it said, joined the way a reader reads it. */
function runTsc(args) {
  const run = spawnSync(process.execPath, [tscEntry, ...args], { cwd: repoRoot, encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  return {
    status: run.status,
    output: output.trim(),
    codes: new Set(output.match(/error TS\d+/g) ?? [])
  };
}

/** Type-check one project directory. */
const typeCheck = (project) => runTsc(['--noEmit', '-p', project]);

console.log('\n1. the frontend has a type-check configuration of its own');

check('frontend/tsconfig.json exists', existsSync(configPath),
  'nothing type-checks frontend/ without it — vite only strips types');

// Read through `tsc` rather than `JSON.parse`: the file is JSONC, and this is the resolved
// answer rather than the text.
const shown = runTsc(['--showConfig', '-p', frontendDir]);
let resolved = null;
try { resolved = JSON.parse(shown.output); } catch { /* reported below */ }

check('tsc can resolve it', resolved !== null, shown.output.slice(0, 300));

const options = resolved?.compilerOptions ?? {};
check('it emits nothing', options.noEmit === true,
  `noEmit is ${JSON.stringify(options.noEmit)} — this config is for checking, vite does the building`);
check('it is strict', options.strict === true,
  `strict is ${JSON.stringify(options.strict)}`);

// `--showConfig` expands `include` into the file list, which is the honest thing to assert:
// what matters is that `App.tsx` is in it, not how the glob was spelled.
const files = (resolved?.files ?? []).map((file) => file.replace(/\\/g, '/'));
check('it covers App.tsx', files.some((file) => file.endsWith('/src/App.tsx')),
  `${files.length} file(s) resolved, none of them App.tsx`);
check('it covers the plain .ts modules too',
  files.some((file) => file.endsWith('/src/canvas-fonts.ts')),
  'a .tsx-only include would leave half the frontend unread');

console.log('\n2. and the frontend type-checks clean under it');

const real = typeCheck(frontendDir);
check('tsc --noEmit -p frontend reports nothing', real.status === 0 && real.output === '',
  real.output ? real.output.split('\n').slice(0, 20).join('\n        ') : `exit ${real.status}`);

// ─── The probes ───────────────────────────────────────────────

// Under `node_modules` rather than under `%TEMP%`, and that is the whole of why: a probe
// outside the repository has no `node_modules` above it, so `react` resolves to JavaScript
// with no declarations beside it and section 4 fails on the probe's own address rather than
// on anything about the configuration. From here the walk up finds the real one. The
// directory is inside a path `git` already ignores and is removed below either way.
const scratch = mkdtempSync(join(repoRoot, 'node_modules', '.frontend-types-'));

/** A probe project next to the real config, inheriting every flag it ships with. */
function probe(name, source) {
  const dir = join(scratch, name);
  const file = join(dir, `${name}.tsx`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, source, 'utf8');
  // Only the probe, and no `compilerOptions` of its own: every flag under test is the
  // inherited one. `include` is emptied because it is inherited too, and the real one would
  // drag the whole frontend into a probe run.
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    extends: configPath.replace(/\\/g, '/'),
    include: [],
    files: [`./${name}.tsx`]
  }, null, 2), 'utf8');
  return typeCheck(dir);
}

try {
  console.log('\n3. the configuration it ships with rejects the defect it is for');

  // #412 reduced: the setter is `adoptWorkspace`'s, and nothing declares it.
  const undefinedName = probe('undefined-name', `export function adoptWorkspace(id: string): void {
  setWorkspacesConfigured(true)
  switchWorkspace(id)
}

function switchWorkspace(id: string): void { void id }
`);
  check('a name defined nowhere is TS2304', undefinedName.codes.has('error TS2304'),
    `reported ${[...undefinedName.codes].join(', ') || 'nothing'} — this is the shape #412 shipped in`);
  check('and it names the identifier', /setWorkspacesConfigured/.test(undefinedName.output),
    undefinedName.output.slice(0, 300));

  // Not only undeclared names: a configuration reduced to a linter would still pass the two
  // above and let every one of these through.
  const missingProperty = probe('missing-property', `interface WorkspaceSummary { id: string }

export function label(workspace: WorkspaceSummary): string {
  return workspace.displayName
}
`);
  check('a property that does not exist is TS2339', missingProperty.codes.has('error TS2339'),
    `reported ${[...missingProperty.codes].join(', ') || 'nothing'}`);

  console.log('\n4. and accepts ordinary frontend code');

  const ordinary = probe('ordinary', `import type { ReactElement } from 'react'
import { useState } from 'react'

export function Strip({ names }: { names: string[] }): ReactElement {
  const [active, setActive] = useState<string | null>(names[0] ?? null)
  return (
    <div className="workspace-strip">
      {names.map((name) => (
        <button key={name} type="button" onClick={() => setActive(name)}>
          {name === active ? \`\${name} (open)\` : name}
        </button>
      ))}
    </div>
  )
}
`);
  check('JSX, hooks and the DOM lib all resolve', ordinary.status === 0 && ordinary.output === '',
    ordinary.output.split('\n').slice(0, 10).join('\n        ') || `exit ${ordinary.status}`);
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a Windows lock, not a failure */ }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
