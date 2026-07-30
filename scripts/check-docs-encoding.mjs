#!/usr/bin/env node
/**
 * Checks that no tracked text file has been through a wrong decoder.
 *
 * A board was seen rendering `Board Tool â€" the tool, mapped` and `1 Â· How the pieces fit`
 * — UTF-8 bytes decoded as cp1252 and re-encoded, the signature of a shell pipeline that
 * announced no error at all. The tracked file was clean that time. Nothing in this
 * repository would have noticed if it had not been: `check-board-map.mjs` and
 * `check-board-docs.mjs` parse the board and assert nothing about its characters, and
 * `check-english-only.mjs` reads words rather than bytes. Export a mis-decoded scene back
 * over `docs/board.excalidraw` and every check in the repository stays green while the
 * front page of the project reads as garbage.
 *
 * Three questions, in the order a wrong decoder answers them:
 *
 *  1. **Are the bytes UTF-8 at all?** Decoded strictly, so a truncated or Latin-1 file is a
 *     failure rather than a silent field of `?`.
 *  2. **Did something already replace a character it could not read?** U+FFFD is that
 *     admission, and a BOM is the other half of the same story.
 *  3. **Do the characters spell out a double decode?** UTF-8 read as cp1252 or Latin-1
 *     always produces a lead byte from `Â Ã â ð` followed by one of the characters those
 *     encodings give bytes 0x80–0xBF. Real prose does not put those pairs together.
 *
 * The detector is exercised against fixtures **first**, in section 1, because a detector
 * that finds nothing and a detector that cannot find anything read identically against a
 * clean tree — and this tree is clean.
 *
 * Offline and self-contained.
 *
 * Usage: node scripts/check-docs-encoding.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Text this repository authors. Binary and vendored payloads are not prose. */
const SCANNED_EXTENSIONS = [
  '.md', '.excalidraw', '.excalidrawlib', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs',
  '.css', '.html', '.yml', '.yaml',
];

/**
 * This file is the one place the corrupt sequences are allowed to appear, because it is the
 * detector. Scanning it would fail on its own fixtures.
 */
const SELF = 'scripts/check-docs-encoding.mjs';

/**
 * What cp1252 and Latin-1 hand back for the bytes 0x80–0xBF — every continuation byte a
 * multi-byte UTF-8 sequence can carry. A lead from `Â Ã â ð` followed by one of these is
 * text that has been decoded twice.
 */
const CONTINUATION = '-¿€‚ƒ„…†‡ˆ‰'
  + 'Š‹ŒŽ‘’“”•–—˜™š'
  + '›œžŸ';
const MOJIBAKE = new RegExp(`[ÂÃâð][${CONTINUATION}]`, 'g');

const REPLACEMENT = /�/g;
const BOM = /^﻿/;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * `ignoreBOM` keeps a leading U+FEFF in the string instead of swallowing it, which is the
 * only way question 2 can see one. `fatal` is what makes question 1 an error rather than a
 * field of replacement characters.
 */
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Everything wrong with one file's bytes, as human sentences.
 *
 * Returns `[]` for a clean file, which is the only answer that lets it through.
 */
function faults(buffer, label) {
  let text;
  try {
    text = strict.decode(buffer);
  } catch (error) {
    return [`${label}: not valid UTF-8 — ${error.message}`];
  }

  const found = [];
  if (BOM.test(text)) found.push(`${label}: starts with a byte-order mark`);

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [hit] of line.matchAll(REPLACEMENT)) {
      found.push(`${label}:${index + 1}: U+FFFD, a character something already gave up on${hit ? '' : ''}`);
    }
    for (const [hit] of line.matchAll(MOJIBAKE)) {
      const codes = [...hit].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
      found.push(`${label}:${index + 1}: ${JSON.stringify(hit)} (${codes.join(' ')}) — UTF-8 read as cp1252`);
    }
  });
  return found;
}

// ─── 1. The detector, against text that is known to be wrong ──

console.log('1. the detector fires on text that has been decoded twice');

const encode = (text) => Buffer.from(text, 'utf8');

/** The two sequences the board was actually seen rendering. */
const SEEN_ON_SCREEN = 'Board Tool â€" the tool, mapped\n1 Â· How the pieces fit';

check('the em dash and middle dot from the screenshot are both caught',
      faults(encode(SEEN_ON_SCREEN), 'fixture').length === 2,
      JSON.stringify(faults(encode(SEEN_ON_SCREEN), 'fixture')));
check('a replacement character is caught',
      faults(encode('a � b'), 'fixture').length === 1);
check('a byte-order mark is caught',
      faults(encode('﻿{"type":"excalidraw"}'), 'fixture').length === 1);
check('bytes that are not UTF-8 at all are caught',
      faults(Buffer.from([0x48, 0xC3, 0x28]), 'fixture').length === 1,
      JSON.stringify(faults(Buffer.from([0x48, 0xC3, 0x28]), 'fixture')));
check('a whole board is caught when its text has been through the wrong decoder',
      faults(encode(JSON.stringify({
        type: 'excalidraw',
        elements: [{ type: 'text', text: '1 Â· How the pieces fit' }],
      })), 'fixture').length === 1);

console.log('\n1b. and stays quiet on the characters this project legitimately writes');
check('a real em dash, middle dot, arrow and accented name pass',
      faults(encode('Board Tool — the tool · mapped → ção ↻ ⌘'), 'fixture').length === 0,
      JSON.stringify(faults(encode('Board Tool — the tool · mapped → ção ↻ ⌘'), 'fixture')));

// ─── 2. Every tracked text file ───────────────────────────────

console.log('\n2. no tracked text file carries a wrong decode');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((file) => file.split('\\').join(posix.sep))
  .filter((file) => file !== SELF)
  .filter((file) => SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension)));

check('there are files to scan', tracked.length > 0);

const offences = [];
for (const file of tracked) offences.push(...faults(readFileSync(join(repoRoot, file)), file));
check(`every one of the ${tracked.length} scanned files decodes cleanly`, offences.length === 0,
      `\n        ${offences.slice(0, 20).join('\n        ')}`);

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
