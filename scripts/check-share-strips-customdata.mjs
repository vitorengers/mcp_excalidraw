#!/usr/bin/env node
/**
 * Checks that a scene handed to excalidraw.com carries none of this tool's block state.
 *
 * `exportToExcalidrawUrl` encrypts the scene and POSTs it to `https://json.excalidraw.com`,
 * a third-party store this fork does not control. The encryption is not the point: the key
 * travels in the URL fragment, and the whole purpose of the URL is to be given to somebody.
 * So whatever is in the scene is published, and `customData` is where this tool keeps what
 * a block *is* — `issueUrl`, `implementState`, `docKey`, `kind`, `inTodo`. A GitHub issue
 * URL for a private repository, uploaded because a shape happened to be on the canvas, is
 * not something an operator asking for a shareable picture agreed to.
 *
 * `cleanElementsForShare` already destructures out the server-only fields; `customData` was
 * simply not among them and rode along in the `...rest` spread. Removal rather than an
 * allowlist, because every key under it is this fork's own — stock excalidraw.com reads none
 * of them, so nothing rendered there can depend on one.
 *
 * What is asserted:
 *
 *   1. the cleaning path is reachable at all — it is exported, so this can drive the real
 *      function rather than a stub of somebody else's API;
 *   2. a cleaned element has no `customData` key, on every element kind that takes one;
 *   3. the serialised scene contains none of the marker values anywhere — nested, on an
 *      arrow, on a text element, on a bound label's parent;
 *   4. **the drawing survives**, which is the half that would let a check pass for the wrong
 *      reason: geometry, colours, labels, bindings and the element count are all still there.
 *      A cleaner that returned nothing would satisfy 2 and 3 perfectly;
 *   5. the notice the MCP tool hands back names the host that received the scene, so an
 *      operator reading an agent transcript can see that a third party has it.
 *
 * Offline and self-contained — no server, no browser, nothing uploaded. Run
 * `./node_modules/.bin/tsc` first; the cleaning path is a compiled module.
 *
 * Usage: node scripts/check-share-strips-customdata.mjs
 *
 * Tier: fast
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const modulePath = join(repoRoot, 'dist', 'core', 'share-url.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the share path exists — dist/core/share-url.js not found');
  console.error('        (run ./node_modules/.bin/tsc)');
  process.exit(1);
}

const shareModule = await import(pathToFileURL(modulePath).href);

// ─── 1. the cleaning path is reachable ────────────────────────

console.log('1. the cleaning path can be driven without uploading anything');

check('cleanElementsForShare is exported',
      typeof shareModule.cleanElementsForShare === 'function',
      `exports: ${Object.keys(shareModule).join(', ') || 'none'}`);
check('and the notice the tool hands back is too',
      typeof shareModule.shareUploadNotice === 'function',
      `exports: ${Object.keys(shareModule).join(', ') || 'none'}`);

if (typeof shareModule.cleanElementsForShare !== 'function') {
  console.error('\n        Nothing below can run: the check would otherwise have to stub');
  console.error('        excalidraw.com and assert against the stub instead of the real path.');
  process.exit(1);
}

const { cleanElementsForShare, shareUploadNotice } = shareModule;

// ─── 2. the block state a scene carries ───────────────────────

// Every marker below is a value this fork writes into customData somewhere, and none of
// them may appear in what is uploaded. The nested one is there because a stripper written
// as a key-by-key deletion would miss it.
const ISSUE_URL = 'https://github.com/vitorengers/vibemaxxing/issues/279';
const DOC_KEY = 'running.md';
const IMPLEMENT_BRANCH = 'issue-279';

const BOARD = [
  {
    id: 'issue-block', type: 'rectangle',
    x: 40, y: 60, width: 320, height: 140,
    strokeColor: '#1971c2', backgroundColor: '#a5d8ff',
    label: { text: 'An issue block' },
    customData: {
      kind: 'issue',
      issueUrl: ISSUE_URL,
      inTodo: true,
      implementState: { state: 'running', branch: IMPLEMENT_BRANCH, worktree: 'C:/secret/path' },
    },
  },
  {
    id: 'docs-card', type: 'rectangle',
    x: 40, y: 260, width: 200, height: 80,
    label: { text: 'How to run it' },
    customData: { docKey: DOC_KEY },
  },
  {
    id: 'a-note', type: 'text',
    x: 400, y: 60, width: 180, height: 25,
    text: 'A plain note',
    customData: { kind: 'terminal', issueUrl: ISSUE_URL },
  },
  {
    id: 'an-arrow', type: 'arrow',
    x: 360, y: 130, width: 40, height: 0,
    points: [[0, 0], [40, 0]],
    startBinding: { elementId: 'issue-block', focus: 0, gap: 4 },
    endBinding: { elementId: 'a-note', focus: 0, gap: 4 },
    label: { text: 'points at' },
    customData: { kind: 'board-section', issueUrl: ISSUE_URL },
  },
  {
    id: 'plain-shape', type: 'ellipse',
    x: 600, y: 260, width: 100, height: 100,
  },
];

const cleaned = cleanElementsForShare(BOARD);
const serialised = JSON.stringify(cleaned);
const byId = new Map(cleaned.map((el) => [el.id, el]));

console.log('\n2. no cleaned element carries a customData key');

for (const id of ['issue-block', 'docs-card', 'a-note', 'an-arrow']) {
  const el = byId.get(id);
  check(`${id} comes back without customData`,
        el !== undefined && !('customData' in el),
        el === undefined ? 'element missing entirely' : JSON.stringify(el.customData));
}
check('and a shape that never had one is unchanged by that',
      byId.has('plain-shape') && !('customData' in byId.get('plain-shape')));
check('no bound text element carries one either',
      cleaned.filter((el) => el.containerId).every((el) => !('customData' in el)));

// ─── 3. and none of the values survive anywhere ───────────────

console.log('\n3. no block state appears anywhere in the uploaded JSON');

const forbidden = [
  ['the issue URL', ISSUE_URL],
  ['the issue number in a URL', '/issues/279'],
  ['the key issueUrl', 'issueUrl'],
  ['the key implementState', 'implementState'],
  ['the key docKey', 'docKey'],
  ['the key customData', 'customData'],
  ['the branch an implementation runs on', IMPLEMENT_BRANCH],
  ['a local filesystem path', 'C:/secret/path'],
  ['the key inTodo', 'inTodo'],
];
for (const [what, needle] of forbidden) {
  check(`${what} is absent`, !serialised.includes(needle),
        `found ${JSON.stringify(needle)} in the scene`);
}
// `kind` is a short word that could plausibly appear in ordinary prose, so this asks about
// the values rather than the key.
for (const kind of ['"issue"', '"terminal"', '"board-section"']) {
  check(`the block kind ${kind} is absent`, !serialised.includes(kind));
}

// ─── 4. the drawing itself is untouched ───────────────────────

// Without this section a cleaner that returned an empty array would pass everything above.
console.log('\n4. the picture still arrives');

check('every element is still there, plus the bound labels',
      cleaned.length === BOARD.length + 3,
      `${cleaned.length} element(s) for ${BOARD.length} + 3 labels`);

const issueBlock = byId.get('issue-block');
check('geometry survives', issueBlock?.x === 40 && issueBlock?.y === 60
      && issueBlock?.width === 320 && issueBlock?.height === 140,
      JSON.stringify(issueBlock && { x: issueBlock.x, y: issueBlock.y, width: issueBlock.width, height: issueBlock.height }));
check('colours survive', issueBlock?.strokeColor === '#1971c2'
      && issueBlock?.backgroundColor === '#a5d8ff',
      JSON.stringify(issueBlock && { strokeColor: issueBlock.strokeColor, backgroundColor: issueBlock.backgroundColor }));
check('Excalidraw defaults are still filled in',
      issueBlock?.opacity === 100 && issueBlock?.isDeleted === false
      && typeof issueBlock?.index === 'string');

const labels = cleaned.filter((el) => el.type === 'text' && el.containerId);
check('a labelled shape still gets its bound text',
      labels.some((el) => el.containerId === 'issue-block' && el.text === 'An issue block'),
      JSON.stringify(labels.map((el) => [el.containerId, el.text])));
check('and so does the arrow',
      labels.some((el) => el.containerId === 'an-arrow' && el.text === 'points at'));
check('a standalone text element keeps its text',
      byId.get('a-note')?.text === 'A plain note', JSON.stringify(byId.get('a-note')?.text));

const arrow = byId.get('an-arrow');
check('arrow bindings survive', arrow?.startBinding?.elementId === 'issue-block'
      && arrow?.endBinding?.elementId === 'a-note',
      JSON.stringify(arrow && { start: arrow.startBinding, end: arrow.endBinding }));
check('and the shapes it touches know about it',
      (issueBlock?.boundElements ?? []).some((bound) => bound.id === 'an-arrow'),
      JSON.stringify(issueBlock?.boundElements));

// ─── 5. the operator is told where the scene went ─────────────

console.log('\n5. the notice names the host that received the scene');

if (typeof shareUploadNotice === 'function') {
  const notice = shareUploadNotice('https://excalidraw.com/#json=abc123,deadbeef');
  check('it names excalidraw.com', /excalidraw\.com/.test(notice), notice);
  check('it names the upload host rather than only the link',
        notice.includes('json.excalidraw.com'), notice);
  check('it says the scene was uploaded to a third party',
        /third[- ]party/i.test(notice), notice);
  check('it still carries the URL', notice.includes('https://excalidraw.com/#json=abc123,deadbeef'), notice);
  check('and it still says who can open it', /view and edit/i.test(notice), notice);
} else {
  check('it names excalidraw.com', false, 'shareUploadNotice is not exported');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
