/**
 * Which checks remove a directory a canvas server was running out of, and whether that removal
 * can become the verdict.
 *
 * This is the sweep #472 asked for, in code rather than in a list somebody read once. The shape
 * it looks for is the one that went red in the field: a check whose assertions all passed and
 * which then died in its teardown, because Windows releases a killed server's handles on its
 * state directory asynchronously and `rmSync` arrived while the directory was still locked.
 *
 * The rule is narrow on purpose, and each half of it is what keeps this from firing on removals
 * that ought to throw:
 *
 *  - **only checks that start a canvas server**, by importing `startCanvas` or `openCanvas` from
 *    `lib/spawn-canvas.mjs`. Nothing else here holds a directory open across a process boundary.
 *  - **only removals after the first of those calls in the file.** A check that clears a stale
 *    fixture directory before it starts anything is not tearing down a server's state, and a
 *    failure there means it cannot run at all — which is a verdict, and correctly so.
 *  - **only recursive removals**, which is how a working directory goes and how a single file
 *    a check deletes on purpose to signal a stub does not.
 *
 * A removal is safe when it sits inside a `try` that has a `catch`: retries alone still throw
 * on the last attempt, and the contract is that a teardown cannot change the verdict at all.
 * `run-checks.mjs` reaps the `check-*` directories left in `os.tmpdir()`, so a leak costs a
 * directory until the next run and nothing else.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a check imports from `lib/spawn-canvas.mjs`, if it imports anything at all. */
const SPAWN_CANVAS_IMPORT = /import\s*\{([^{}]*)\}\s*from\s*['"][^'"]*spawn-canvas\.mjs['"]/;

/**
 * The names this file calls to start a canvas server, under whatever local spelling it gave
 * them: `check-github-host.mjs` imports `startCanvas as spawnCanvas`, and a scan that looked
 * for the exported name would have found no server and cleared the file for free.
 */
function serverStarters(code) {
  const clause = SPAWN_CANVAS_IMPORT.exec(code);
  if (!clause) return [];
  const names = [];
  for (const specifier of clause[1].split(',')) {
    const [exported, local] = specifier.split(/\bas\b/).map((part) => part.trim());
    if (exported === 'startCanvas' || exported === 'openCanvas') names.push(local || exported);
  }
  return names;
}

/**
 * The source with every comment and every string body blanked out, positions preserved.
 *
 * The brace walk below has to be able to trust a `{`, and a banner in this directory is a page
 * of prose that quotes object literals. Blanking rather than deleting keeps every index equal to
 * the index in the file, so a line number reported from here points at the real line.
 */
export function withoutCommentsAndStrings(source) {
  const out = source.split('');
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') { const end = source.indexOf('\n', i); blank(i, end === -1 ? source.length : end); i = end === -1 ? source.length : end; continue; }
    if (two === '/*') { const end = source.indexOf('*/', i + 2); const to = end === -1 ? source.length : end + 2; blank(i, to); i = to; continue; }
    const quote = source[i];
    if (quote === '\'' || quote === '"' || quote === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) break;
        if (quote !== '`' && source[j] === '\n') break;
        j++;
      }
      blank(i + 1, Math.min(j, source.length));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** The open-brace positions of every block enclosing `index`, outermost first. */
function enclosingBlocks(code, index) {
  const stack = [];
  for (let i = 0; i < index; i++) {
    if (code[i] === '{') stack.push(i);
    else if (code[i] === '}') stack.pop();
  }
  return stack;
}

/** Whether `index` sits inside a `try { … } catch`, so a throw there changes nothing. */
function insideTryCatch(code, index) {
  for (const open of enclosingBlocks(code, index)) {
    if (!/\btry\s*$/.test(code.slice(Math.max(0, open - 12), open))) continue;
    let depth = 1;
    let i = open + 1;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    if (/^\s*catch\b/.test(code.slice(i, i + 40))) return true;
  }
  return false;
}

/**
 * Every removal in `source` that tears down a directory a canvas server ran out of, with
 * whether it is guarded. Returns `null` for a file that starts no canvas server.
 */
export function teardownRemovals(source) {
  const code = withoutCommentsAndStrings(source);
  // Read the import off the file itself: the blanked copy has no module specifier left in it.
  const starters = serverStarters(source);
  if (starters.length === 0) return null;
  const firstServer = Math.min(
    ...starters.map((name) => {
      const at = code.search(new RegExp(`\\b${name}\\s*\\(`));
      return at === -1 ? Number.MAX_SAFE_INTEGER : at;
    }),
  );
  if (firstServer === Number.MAX_SAFE_INTEGER) return [];
  const removals = [];
  for (const match of code.matchAll(/\brmSync\(/g)) {
    if (match.index < firstServer) continue;
    // The call's arguments, to the matching close paren: a working directory goes recursively.
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      i++;
    }
    const call = code.slice(match.index, i);
    if (!/recursive:\s*true/.test(call)) continue;
    removals.push({
      line: source.slice(0, match.index).split('\n').length,
      guarded: insideTryCatch(code, match.index),
      text: source.slice(match.index, i).replace(/\s+/g, ' '),
    });
  }
  return removals;
}

/** Every `scripts/check-*.mjs`, by file name. */
export function checkFiles(dir = scriptsDir) {
  return readdirSync(dir).filter((file) => file.startsWith('check-') && file.endsWith('.mjs')).sort();
}

/** The checks whose teardown can still turn a green run red, as `{ file, line, text }`. */
export function unguardedTeardowns(dir = scriptsDir) {
  const found = [];
  for (const file of checkFiles(dir)) {
    const removals = teardownRemovals(readFileSync(join(dir, file), 'utf8'));
    for (const removal of removals ?? []) {
      if (!removal.guarded) found.push({ file, ...removal });
    }
  }
  return found;
}
