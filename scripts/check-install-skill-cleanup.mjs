#!/usr/bin/env node
/**
 * Checks that the bundled skill carries this project's name, and that installing it removes
 * the directory the old name left behind.
 *
 * The skill shipped as `skills/excalidraw-skill/`, and `install-skill` wrote it to
 * `<skills-root>/excalidraw-skill`. Both names came from upstream, whose package is published,
 * so `~/.claude/skills/excalidraw-skill` already exists on the machine of anyone who ran
 * upstream's installer. Renaming the directory alone does not fix that: an agent loads every
 * skill directory it finds under its skills root, so the machine ends up with two — and the
 * stale one tells a live agent to run a command that resolves to a different maintainer's
 * package on the registry. Replacing "the target directory" only ever meant the directory of
 * the *current* name; nothing knew about any other.
 *
 * So the rename has a removal attached to it, and the removal is the part worth a check:
 *
 *  1. **The tree agrees on one name.** `skills/` holds exactly one directory; its name is the
 *     `name:` in its own `SKILL.md` front matter, is the `SKILL_NAME` the command installs
 *     under, is what `scripts/sync-skills.mjs` mirrors — and is *not* one of the legacy names,
 *     which is the assertion that fails if the rename is ever quietly reverted.
 *  2. **No file under `skills/` hands an agent a bin this package does not declare.** The
 *     skill is read by an agent that will run what it reads, on a machine with no clone of
 *     this repository, so a stale command name there is executed rather than reported.
 *  3. **Removing someone else's directory is the failure to avoid**, so the sweep is gated on
 *     evidence: a directory is removed only when it holds a `SKILL.md` whose front-matter name
 *     is itself in the legacy list. A directory that merely shares the name — a user's own
 *     notes, a hand-written skill, anything with no `SKILL.md` at all — is left where it is,
 *     and this drives all three cases through the real CLI to say so.
 *  4. **What was removed is named in the JSON**, because a command that deletes a directory
 *     the user may never have installed from this tool and says nothing is indistinguishable
 *     from one that lost it.
 *
 * A symlinked legacy directory is left alone too: `install-skill` already refuses to replace a
 * symlinked target rather than following it out of the skills root, and the same reasoning
 * applies to a legacy one.
 *
 * Offline and self-contained: throwaway skills roots, a throwaway home, and the built CLI.
 * No server, no browser, no network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-install-skill-cleanup.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** A module from `dist`, or nothing — a check that dies on its first import shows its own
 * harness instead of the defect. */
async function importDist(relativePath, what) {
  const full = join(repoRoot, 'dist', relativePath);
  if (!existsSync(full)) {
    failures++;
    console.error(`  FAIL  ${what} is built — dist/${relativePath.replace(/\\/g, '/')} not found`);
    return null;
  }
  return import(pathToFileURL(full).href);
}

/** The `name:` of a markdown file's YAML front matter, or undefined. */
function frontMatterName(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  const line = match[1].split(/\r?\n/).find((entry) => /^name:\s*\S/.test(entry));
  return line?.replace(/^name:\s*/, '').trim().replace(/^["']|["']$/g, '');
}

function listDirectories(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const workDir = join(tmpdir(), `install-skill-cleanup-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const commandModule = await importDist(join('cli', 'commands', 'install-skill.js'), 'the install-skill command');

try {
  if (!commandModule) throw new Error('nothing to drive');

  // ─── 1. One name, and the whole tree spells it the same way ──

  console.log('1. the tree agrees on one skill name, and it is not a legacy one');

  const { SKILL_NAME, LEGACY_SKILL_NAMES } = commandModule;

  check('install-skill exports the name it installs under', typeof SKILL_NAME === 'string' && SKILL_NAME !== '',
        'nothing outside the module could ask what directory it writes');
  check('install-skill exports the legacy names it removes',
        Array.isArray(LEGACY_SKILL_NAMES) && LEGACY_SKILL_NAMES.length > 0,
        'without a list of what the skill used to be called, an install leaves the old directory beside the new one '
        + 'and the agent loads both');

  const legacy = Array.isArray(LEGACY_SKILL_NAMES) ? LEGACY_SKILL_NAMES : [];

  check('the name it installs under is not one of them', typeof SKILL_NAME === 'string' && !legacy.includes(SKILL_NAME),
        `${SKILL_NAME} is in the legacy list — the sweep would delete the install it just wrote`);
  check('the legacy list names the directory this project inherited', legacy.includes('excalidraw-skill'),
        `${JSON.stringify(legacy)} — upstream's published package installs that directory`);

  const skillsRoot = join(repoRoot, 'skills');
  const shipped = listDirectories(skillsRoot);
  check('skills/ holds exactly one directory', shipped.length === 1, shipped.join(', ') || 'none');
  check('and it is the one install-skill writes', shipped.length === 1 && shipped[0] === SKILL_NAME,
        `skills/${shipped[0]} vs SKILL_NAME ${SKILL_NAME}`);

  // Sections 3 and 4 drive the CLI, and they are the ones that show the defect as a user meets
  // it — so a missing export must not take them down with a path crash. Fall back to whatever
  // the tree ships and let the installed-directory assertions speak for themselves.
  const skillName = typeof SKILL_NAME === 'string' && SKILL_NAME !== '' ? SKILL_NAME : (shipped[0] ?? 'skill');

  const shippedDir = join(skillsRoot, shipped[0] ?? '');
  const shippedFrontMatter = existsSync(join(shippedDir, 'SKILL.md'))
    ? frontMatterName(readFileSync(join(shippedDir, 'SKILL.md'), 'utf8'))
    : undefined;
  check('its SKILL.md front matter names the same directory', shippedFrontMatter === shipped[0],
        `front matter says "${shippedFrontMatter}", the directory is "${shipped[0]}"`);

  const evalsPath = join(shippedDir, 'evals', 'evals.json');
  if (existsSync(evalsPath)) {
    const evals = JSON.parse(readFileSync(evalsPath, 'utf8'));
    check('its evals name the same skill', evals.skill_name === shipped[0],
          `${evals.skill_name} vs ${shipped[0]}`);
  }

  const syncScript = readFileSync(join(repoRoot, 'scripts', 'sync-skills.mjs'), 'utf8');
  check('scripts/sync-skills.mjs mirrors that directory',
        syncScript.includes(`'${skillName}'`),
        `it does not mention '${skillName}'`);
  check('and mirrors no legacy one',
        !legacy.some((name) => new RegExp(`'${name}'`).test(syncScript)),
        'the repo-local agent copy would keep the old directory alive');

  // ─── 2. What the skill tells an agent to run ─────────────────

  console.log('\n2. no file under skills/ names a bin this package does not declare');

  // The CLI's own subcommands, read from the source rather than listed here, so a command
  // added later widens this scan for free.
  const runSource = readFileSync(join(repoRoot, 'src', 'cli', 'run.ts'), 'utf8');
  const commandsBlock = /const COMMANDS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(runSource)?.[1] ?? '';
  const subcommands = [...commandsBlock.matchAll(/^\s+'?([a-z][a-z-]*)'?:\s*\{\s*handler/gm)].map(([, name]) => name);
  check('the CLI subcommand list was readable', subcommands.length > 5, `${subcommands.length} found`);

  const binNames = new Set(Object.keys(pkg.bin ?? {}));
  // A prose word never carries one of these; every package or bin name this project has
  // shipped, and every one it inherited, does.
  const NAME_SHAPED = /[-./@]/;
  const offences = [];

  for (const file of listFiles(skillsRoot)) {
    const text = readFileSync(file, 'utf8');
    let fenced = false;
    text.split(/\r?\n/).forEach((line, index) => {
      if (/^\s*```/.test(line)) { fenced = !fenced; return; }
      const pattern = new RegExp(String.raw`([@A-Za-z][\w@./-]*)[ \t]+(?:${subcommands.join('|')})\b`, 'g');
      for (const match of line.matchAll(pattern)) {
        const token = match[1];
        const before = line.slice(0, match.index);
        // `npx -y <pkg>` and `npm i -g <pkg>` name a package, not a bin: it must be the one
        // this repository publishes. Anything else in command position is a bin.
        const asPackage = /(?:npx\s+(?:-y\s+)?|npm\s+(?:i|install)\s+(?:-g\s+|--global\s+))$/.test(before);
        if (asPackage) {
          if (token !== pkg.name) {
            offences.push(`${relative(repoRoot, file)}:${index + 1} fetches "${token}", not "${pkg.name}"`);
          }
          continue;
        }
        if (binNames.has(token)) continue;
        if (token === 'npx' || token === 'npm' || token === 'node') continue;
        // In prose, only a name-shaped token is a claim about a command; inside a fenced
        // block, the first token of a line is one whatever it looks like.
        const inCommandPosition = fenced && /^\s*[$>]?\s*$/.test(before);
        if (!NAME_SHAPED.test(token) && !inCommandPosition) continue;
        offences.push(`${relative(repoRoot, file)}:${index + 1} runs "${token} ${line.slice(match.index + token.length).trim().split(/\s+/)[0]}"`);
      }
    });
  }

  check(`every command named under skills/ is one of ${[...binNames].join(', ')}`, offences.length === 0,
        `\n        ${offences.join('\n        ')}`);

  // ─── 3. The install removes the directory the old name left ──

  console.log('\n3. installing over a legacy install leaves only the new directory');

  const bin = join(repoRoot, 'dist', 'bin.js');
  if (!existsSync(bin)) {
    failures++;
    console.error('  FAIL  the CLI is built — dist/bin.js not found');
    throw new Error('nothing to drive');
  }

  /** A skills root nobody else is using, and a home to match. */
  function makeRoot(label) {
    const home = join(workDir, label, 'home');
    const root = join(workDir, label, 'skills');
    mkdirSync(home, { recursive: true });
    mkdirSync(root, { recursive: true });
    return { home, root };
  }

  /** A skill directory with front matter naming `declares`, plus a file to notice the loss of. */
  function seedSkill(root, dirName, declares) {
    const dir = join(root, dirName);
    mkdirSync(join(dir, 'references'), { recursive: true });
    if (declares !== null) {
      writeFileSync(join(dir, 'SKILL.md'),
        `---\nname: ${declares}\ndescription: a fixture\n---\n\n# ${declares}\n`);
    }
    writeFileSync(join(dir, 'references', 'marker.md'), `marker for ${dirName}\n`);
    return dir;
  }

  function install(home, args) {
    const run = spawnSync(process.execPath, [bin, 'install-skill', ...args], {
      cwd: workDir,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8'
    });
    let json;
    try { json = JSON.parse(run.stdout); } catch { /* reported by the case below */ }
    return { run, json };
  }

  {
    const { home, root } = makeRoot('replaces');
    const legacyDir = seedSkill(root, 'excalidraw-skill', 'excalidraw-skill');
    seedSkill(root, 'note-taking', 'note-taking');

    const { run, json } = install(home, ['--dir', root]);
    check('the CLI exited 0', run.status === 0, `${run.status} — ${(run.stderr || '').trim()}`);
    check('the new skill is installed', existsSync(join(root, skillName, 'SKILL.md')));
    check('the legacy directory is gone', !existsSync(legacyDir),
          'an agent reading this root would load both skills, and the stale one names another package');
    check('nothing else was touched', existsSync(join(root, 'note-taking', 'references', 'marker.md')));
    check('the root holds exactly the new skill and the unrelated one',
          JSON.stringify(listDirectories(root)) === JSON.stringify([skillName, 'note-taking'].sort()),
          listDirectories(root).join(', '));
    check('the JSON names what it removed',
          Array.isArray(json?.removed) && json.removed.length === 1 && json.removed[0] === legacyDir,
          `removed: ${JSON.stringify(json?.removed)} — expected [${legacyDir}]`);

    const second = install(home, ['--dir', root]);
    check('a second run removes nothing and says so',
          second.run.status === 0 && Array.isArray(second.json?.removed) && second.json.removed.length === 0,
          `removed: ${JSON.stringify(second.json?.removed)}`);
  }

  {
    const { home, root } = makeRoot('target-alias');
    const claudeRoot = join(home, '.claude', 'skills');
    mkdirSync(claudeRoot, { recursive: true });
    const legacyDir = seedSkill(claudeRoot, 'excalidraw-skill', 'excalidraw-skill');
    void root;

    const { run, json } = install(home, ['--target', 'claude']);
    check('--target claude sweeps the same root it writes to', run.status === 0 && !existsSync(legacyDir),
          `${run.status} — ${(run.stderr || '').trim()}`);
    check('and reports it', Array.isArray(json?.removed) && json.removed.includes(legacyDir),
          `removed: ${JSON.stringify(json?.removed)}`);
  }

  // ─── 4. A directory that only shares the name is not ours ────

  console.log('\n4. a same-named directory that is not this skill is left alone');

  for (const [label, declares, why] of [
    ['decoy', 'my-hand-written-notes', 'its front matter names something else'],
    ['no-front-matter', '', 'its SKILL.md has no front matter'],
    ['no-skill-md', null, 'it holds no SKILL.md at all']
  ]) {
    const { home, root } = makeRoot(label);
    const decoy = declares === null
      ? seedSkill(root, 'excalidraw-skill', null)
      : seedSkill(root, 'excalidraw-skill', declares);
    if (declares === '') {
      writeFileSync(join(decoy, 'SKILL.md'), '# notes\n\nno front matter here\n');
    }

    const { run, json } = install(home, ['--dir', root]);
    check(`${label}: the CLI exited 0`, run.status === 0, `${run.status} — ${(run.stderr || '').trim()}`);
    check(`${label}: the directory survives — ${why}`,
          existsSync(join(decoy, 'references', 'marker.md')),
          'deleting an unrelated directory that happens to share the name is the failure to avoid');
    check(`${label}: and nothing is reported as removed`,
          Array.isArray(json?.removed) && json.removed.length === 0,
          `removed: ${JSON.stringify(json?.removed)}`);
    check(`${label}: the new skill still landed`, existsSync(join(root, skillName, 'SKILL.md')));
  }
} catch (error) {
  if (String(error?.message) !== 'nothing to drive') {
    failures++;
    console.error(`  FAIL  the check itself threw — ${error?.stack ?? error}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

console.log('');
if (failures) { console.error(`${failures} case(s) failed`); process.exit(1); }
console.log('all cases passed');
