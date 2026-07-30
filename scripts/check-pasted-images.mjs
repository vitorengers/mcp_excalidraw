#!/usr/bin/env node
/**
 * Checks what the panel takes off the clipboard, and when.
 *
 * A screenshot taken with `Win+Shift+S` is a bitmap with no path on disk, so the file
 * picker that attaches reference images cannot reach it at all. Reading one off a `paste`
 * event is three small decisions — which of the clipboard's contents is an image, whether
 * the block showing may take one, and what to call a file that has no name — and every one
 * of them is wrong in a way that compiles.
 *
 * This is the arithmetic. `check-pasted-images-browser.mjs` covers what the arithmetic is
 * wired to, which is the half that has burnt this project before.
 *
 * Offline. Run `./node_modules/.bin/tsc` first — this reads the compiled module.
 *
 * Usage: node scripts/check-pasted-images.mjs
 *
 * Tier: fast
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(repoRoot, 'dist', 'core', 'pasted-images.js');

if (!existsSync(modulePath)) {
  console.error('  FAIL  the clipboard module exists — dist/core/pasted-images.js not found');
  console.error('        (attaching is picker-only until it does; run tsc if it should be there)');
  process.exit(1);
}

const { clipboardImages, panelTakesPaste, isWritableTarget, referenceImageName } =
  await import(pathToFileURL(modulePath).href);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** A `File` as far as any of this cares. */
const file = (name, type, size = 1024) => ({ name, type, size });

/** A clipboard the way Chrome hands one over: the same file on `files` and on `items`. */
const clipboard = (files, strings = []) => ({
  files,
  items: [
    ...files.map((entry) => ({ kind: 'file', type: entry.type, getAsFile: () => entry })),
    ...strings.map((type) => ({ kind: 'string', type, getAsFile: () => null })),
  ],
});

console.log('1. a screenshot on the clipboard is one image, not two');
{
  const shot = file('image.png', 'image/png', 82_000);
  const images = clipboardImages(clipboard([shot]));
  check('the screenshot came through', images.length === 1 && images[0] === shot,
        JSON.stringify(images));

  // Chrome fills `files` and `items` with the same file. Reading both would attach it twice
  // and put two identical thumbnails in the panel.
  check('and it is not counted once per list it appears on', images.length === 1,
        `${images.length} images from one screenshot`);
}

console.log('\n2. a clipboard with no image in it is left alone');
{
  check('plain text yields nothing',
        clipboardImages(clipboard([], ['text/plain'])).length === 0);
  check('text and HTML together yield nothing',
        clipboardImages(clipboard([], ['text/plain', 'text/html'])).length === 0);
  check('a copied PDF is not an image',
        clipboardImages(clipboard([file('report.pdf', 'application/pdf')])).length === 0);
  check('a file with no type at all is not an image',
        clipboardImages(clipboard([file('mystery', '')])).length === 0);
  check('an empty clipboard yields nothing', clipboardImages({}).length === 0);
  check('no clipboard at all yields nothing', clipboardImages(null).length === 0);
}

console.log('\n3. what is offered is filtered, not taken wholesale');
{
  const shot = file('image.png', 'image/png');
  const doc = file('notes.txt', 'text/plain');
  const images = clipboardImages(clipboard([doc, shot]));
  check('the image is kept and the text file dropped',
        images.length === 1 && images[0] === shot, JSON.stringify(images));

  const many = clipboardImages(clipboard([
    file('a.png', 'image/png'), file('b.jpg', 'image/jpeg'), file('c.gif', 'image/gif'),
  ]));
  check('several images copied together all come through', many.length === 3,
        JSON.stringify(many));
}

console.log('\n4. a browser that only fills `items` still works');
{
  // Safari has shipped a `paste` whose `files` is empty and whose `items` carries the file.
  const shot = file('image.png', 'image/png');
  const images = clipboardImages({
    files: [],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => shot }],
  });
  check('the screenshot came off `items`', images.length === 1 && images[0] === shot,
        JSON.stringify(images));
  check('an item that hands back nothing is skipped',
        clipboardImages({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] })
          .length === 0);
}

console.log('\n5. the panel takes a paste exactly when it offers the button');
{
  // The same condition that puts "Attach reference images" on screen. The two drifting
  // apart is the failure worth naming: a paste that silently does nothing, or one that
  // attaches to a block whose issue was written days ago.
  check('a draft block takes it', panelTakesPaste({ state: 'draft' }) === true);
  check('a failed block takes it — the run is what failed, not the block',
        panelTakesPaste({ state: 'failed' }) === true);
  check('a block whose run is in flight does not', panelTakesPaste({ state: 'running' }) === false);
  check('a block whose issue exists does not', panelTakesPaste({ state: 'created' }) === false);
  check('a mirrored card does not — it is `created` by construction',
        panelTakesPaste({ state: 'created' }) === false);
  check('nothing selected takes nothing', panelTakesPaste(null) === false);
  check('and neither does an undefined one', panelTakesPaste(undefined) === false);
}

console.log('\n6. something being typed into keeps its own paste');
{
  check('a textarea keeps it', isWritableTarget({ tagName: 'TEXTAREA' }) === true);
  check('an input keeps it', isWritableTarget({ tagName: 'INPUT' }) === true);
  check('so does Excalidraw\'s own text editor',
        isWritableTarget({ tagName: 'TEXTAREA', className: 'excalidraw-wysiwyg' }) === true);
  check('and anything contenteditable',
        isWritableTarget({ tagName: 'DIV', isContentEditable: true }) === true);
  check('the canvas does not', isWritableTarget({ tagName: 'CANVAS' }) === false);
  check('nor does the card itself', isWritableTarget({ tagName: 'DIV' }) === false);
  check('nor does nothing at all', isWritableTarget(null) === false);
  check('the tag name is matched however it is spelled',
        isWritableTarget({ tagName: 'textarea' }) === true);
}

console.log('\n7. an oversize image is named in the error, even when it has no name');
{
  check('a picked file is named by its name',
        referenceImageName(file('screenshot-2026-07-27.png', 'image/png'))
          === 'screenshot-2026-07-27.png');
  // A pasted screenshot is `image.png` at best and unnamed at worst, and the message was
  // built from the name alone — so the empty case read " is larger than 10 MB."
  check('an unnamed one still reads as a sentence',
        referenceImageName(file('', 'image/png')) === 'The pasted image');
  check('so does one whose name is only whitespace',
        referenceImageName(file('   ', 'image/png')) === 'The pasted image');
  check('and one with no name property at all',
        referenceImageName({ type: 'image/png' }) === 'The pasted image');
  check('and no file at all', referenceImageName(null) === 'The pasted image');
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
