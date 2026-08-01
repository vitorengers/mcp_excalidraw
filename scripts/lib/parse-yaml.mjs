/**
 * A YAML subset, enough for the files this repository writes for GitHub.
 *
 * No parser ships with this repository and a workflow does not need one: mappings, block
 * sequences, flow sequences, block scalars and comments cover every line in `.github/workflows`
 * and every line of an issue form. Anything outside that is left as the text it was written as
 * rather than guessed at.
 *
 * It lives here rather than inside `check-ci-workflow.mjs`, where it was written, because
 * `check-community-files.mjs` parses the issue forms for the same reason that check parses the
 * workflow: GitHub answers a malformed file by quietly doing something else, so a check that
 * pattern-matched the text would pass on a form nobody can submit. `check-ci-workflow.mjs`
 * exercises it against inline fixtures.
 */

/** `#` starts a comment only outside quotes and only after whitespace or at the start. */
function stripComment(line) {
  let out = '';
  let quote = null;
  for (let index = 0; index < line.length; index++) {
    const here = line[index];
    if (quote) {
      out += here;
      if (here === quote) quote = null;
      continue;
    }
    if (here === '"' || here === "'") { quote = here; out += here; continue; }
    if (here === '#' && (index === 0 || /\s/.test(line[index - 1]))) break;
    out += here;
  }
  return out;
}

/** The offset of the `:` that separates a key from its value, or -1. Quotes are respected. */
function keyBreak(text) {
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const here = text[index];
    if (quote) { if (here === quote) quote = null; continue; }
    if (here === '"' || here === "'") { quote = here; continue; }
    if (here === ':' && (index + 1 === text.length || /\s/.test(text[index + 1]))) return index;
  }
  return -1;
}

function scalar(text) {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\[.*\]$/.test(trimmed)) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((part) => scalar(part));
  }
  if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

export function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  let cursor = 0;

  const content = (n) => stripComment(lines[n] ?? '');
  const isBlank = (n) => content(n).trim() === '';
  const indentOf = (n) => { const line = content(n); return line.length - line.trimStart().length; };
  const skipBlank = () => { while (cursor < lines.length && isBlank(cursor)) cursor++; };

  function parseBlock(indent) {
    skipBlank();
    if (cursor >= lines.length || indentOf(cursor) < indent) return null;
    const trimmed = content(cursor).trim();
    if (trimmed === '-' || trimmed.startsWith('- ')) return parseSequence(indentOf(cursor));
    return parseMapping(indentOf(cursor));
  }

  function parseMapping(indent) {
    const map = {};
    for (;;) {
      skipBlank();
      if (cursor >= lines.length || indentOf(cursor) < indent) break;
      const trimmed = content(cursor).trim();
      if (indentOf(cursor) > indent || trimmed.startsWith('- ')) { cursor++; continue; }
      const split = keyBreak(trimmed);
      if (split === -1) { cursor++; continue; }
      const key = scalar(trimmed.slice(0, split));
      const rest = trimmed.slice(split + 1).trim();
      cursor++;
      map[key] = parseValue(rest, indent);
    }
    return map;
  }

  function parseSequence(indent) {
    const list = [];
    for (;;) {
      skipBlank();
      if (cursor >= lines.length || indentOf(cursor) !== indent) break;
      const trimmed = content(cursor).trim();
      if (trimmed !== '-' && !trimmed.startsWith('- ')) break;
      const rest = trimmed.slice(1).trim();
      if (rest === '') { cursor++; list.push(parseBlock(indent + 1)); continue; }
      if (keyBreak(rest) !== -1) {
        // Re-indent the item's first key so the rest of the item is an ordinary mapping.
        lines[cursor] = ' '.repeat(indent + 2) + rest;
        list.push(parseMapping(indent + 2));
      } else {
        cursor++;
        list.push(scalar(rest));
      }
    }
    return list;
  }

  function parseBlockScalar(indent) {
    const out = [];
    while (cursor < lines.length) {
      const raw = lines[cursor];
      if (raw.trim() === '') { out.push(''); cursor++; continue; }
      if (raw.length - raw.trimStart().length <= indent) break;
      out.push(raw);
      cursor++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }

  function parseValue(rest, indent) {
    if (/^[|>][+-]?\d*$/.test(rest)) return parseBlockScalar(indent);
    if (rest !== '') return scalar(rest);
    skipBlank();
    if (cursor >= lines.length) return null;
    const childIndent = indentOf(cursor);
    if (childIndent < indent) return null;
    if (childIndent === indent) {
      const trimmed = content(cursor).trim();
      // A sequence is allowed to sit at its key's own indentation.
      return trimmed === '-' || trimmed.startsWith('- ') ? parseSequence(indent) : null;
    }
    return parseBlock(childIndent);
  }

  return parseBlock(0) ?? {};
}
