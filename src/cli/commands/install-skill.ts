import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { parseArgs, CliUsageError } from '../args.js';
import { printJson, note } from '../util.js';

// Exported for scripts/check-install-skill-cleanup.mjs, which asserts the whole tree spells
// this the same way — the shipped directory, its own front matter, and scripts/sync-skills.mjs.
export const SKILL_NAME = 'vibemaxxing-canvas';

// What this skill used to be installed as. Upstream's package is published and ships its own
// `excalidraw-skill`, so that directory already exists under the skills root of anyone who ran
// upstream's installer — and an agent loads *every* directory it finds there. Renaming without
// removing therefore leaves two skills loaded together, the stale one instructing a live agent
// to run a command that resolves to a different maintainer's package.
export const LEGACY_SKILL_NAMES = ['excalidraw-skill'];

// The published package layout is <root>/{dist,skills,...}; this module
// compiles to dist/cli/commands/, so the package root is three levels up.
// Resolving relative to the module path keeps this working from the npx
// cache and global installs alike.
function findSkillSource(): string {
  const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const source = path.join(packageRoot, 'skills', SKILL_NAME);
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    throw new Error(`Bundled skill not found at ${source} (broken install?)`);
  }
  return source;
}

// A leading `~` is a shell convention, and it is written `~/` on every platform — including
// in this project's own docs. Testing `path.sep` made the rule conditional on the host, so
// `--dir ~/skills` on Windows fell through to `path.resolve` and made a directory literally
// named `~` in the working directory. Accept either separator everywhere; `path.join` spells
// the result with the host's. Anchored, so `~foo` (the POSIX other-user form, and a legal
// relative filename) is left alone.
// Exported for scripts/check-install-skill-home.mjs.
export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (/^~[\\/]/.test(input)) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveSkillsRoot(target: string): string {
  if (target === 'claude') return path.join(os.homedir(), '.claude', 'skills');
  if (target === 'codex') return path.join(os.homedir(), '.codex', 'skills');
  return path.resolve(expandHome(target));
}

function resolveTarget(target: string): { root: string; target: string; mode: string } {
  const root = resolveSkillsRoot(target);
  return { root, target: path.join(root, SKILL_NAME), mode: `target:${target}` };
}

/** The `name:` of a markdown file's YAML front matter, or undefined if it has none. */
function frontMatterName(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return undefined;
  const line = (block[1] ?? '').split(/\r?\n/).find((entry) => /^name:\s*\S/.test(entry));
  return line?.replace(/^name:\s*/, '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Remove installs this skill left behind under its old names, and say which.
 *
 * Deleting a directory the user may never have installed from this tool is only acceptable
 * because it is both *reported* and *evidenced*: a directory goes only when it holds a
 * `SKILL.md` whose own front matter names one of the legacy skills. A directory that merely
 * shares the name — somebody's notes, a hand-written skill, anything with no `SKILL.md` — is
 * left exactly where it is. A symlink is left alone for the same reason the target is: this
 * command does not follow one out of the skills root.
 */
function removeLegacyInstalls(root: string): string[] {
  const removed: string[] = [];
  for (const legacy of LEGACY_SKILL_NAMES) {
    if (legacy === SKILL_NAME) continue;
    const dir = path.join(root, legacy);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const declared = frontMatterName(path.join(dir, 'SKILL.md'));
    if (declared === undefined || !LEGACY_SKILL_NAMES.includes(declared)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
    note(`Removed legacy skill install at ${dir}`);
  }
  return removed;
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}

export async function installSkill(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv, {
    dir: { takesValue: true },
    target: { takesValue: true },
    'print-source': { takesValue: false }
  });
  const source = findSkillSource();

  if (flags['print-source'] === true) {
    printJson({
      success: true,
      skill: SKILL_NAME,
      source,
      files: countFiles(source)
    });
    return;
  }

  if (flags.dir !== undefined && flags.target !== undefined) {
    throw new CliUsageError('Use either --dir <skills-root> or --target <alias|skills-root>, not both');
  }

  const explicitDir = flags.dir as string | undefined;
  const targetSpec = (flags.target as string | undefined) ?? 'claude';
  const explicitRoot = explicitDir ? path.resolve(expandHome(explicitDir)) : undefined;
  const resolved = explicitRoot
    ? { root: explicitRoot, target: path.join(explicitRoot, SKILL_NAME), mode: 'dir' }
    : resolveTarget(targetSpec);
  const { root, target, mode } = resolved;

  // Replace, never overlay: stale files from older skill versions (e.g. the
  // pre-1.1 scripts/*.cjs helpers) must not survive an upgrade.
  let lstat: fs.Stats | undefined;
  try {
    lstat = fs.lstatSync(target);
  } catch { /* target does not exist yet */ }

  if (lstat?.isSymbolicLink()) {
    throw new Error(
      `${target} is a symlink; refusing to replace it. Remove it manually if you want the CLI to manage this install.`
    );
  }

  // Stage into a sibling temp dir, then swap
  fs.mkdirSync(root, { recursive: true });
  const staging = fs.mkdtempSync(path.join(root, `.${SKILL_NAME}-staging-`));

  try {
    fs.cpSync(source, staging, { recursive: true });
    if (lstat) {
      fs.rmSync(target, { recursive: true, force: true });
      note(`Replaced existing install at ${target}`);
    }
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  // After the new install is in place, never before it: a copy that fails must not take the
  // only skill on the machine with it.
  const removed = removeLegacyInstalls(root);

  printJson({
    success: true,
    skill: SKILL_NAME,
    mode,
    root,
    target,
    files: countFiles(target),
    removed
  });
}
