#!/usr/bin/env node
/**
 * Checks what the documentation card shows for a given selection.
 *
 * Two user-visible defects came out of this one piece of logic: a click landing on a
 * label instead of the box it sits in, and a card that would not close when the shape
 * was deselected. Both compiled perfectly. It is pure now, so it can be checked without
 * driving a browser.
 *
 * Offline. Run `./node_modules/.bin/tsc` first — this reads the compiled module.
 *
 * Usage: node scripts/check-panel-target.mjs
 *
 * Tier: fast
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(repoRoot, 'dist', 'core', 'panel-target.js');

if (!existsSync(modulePath)) {
  console.error('  FAIL  the panel target module exists — dist/core/panel-target.js not found');
  console.error('        (selection still resolves inside the component; run tsc if it does not)');
  process.exit(1);
}

const { resolvePanelTarget } = await import(pathToFileURL(modulePath).href);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const box = (id, extra = {}) => ({
  id, type: 'rectangle', x: 0, y: 0, width: 200, height: 100, ...extra
});

console.log('1. nothing selected means no card');
{
  const elements = [box('a', { customData: { docKey: 'sync-reconciliation' } })];
  check('an empty selection resolves to nothing', resolvePanelTarget(elements, []) === null);
  check('a selection of an unknown id resolves to nothing',
        resolvePanelTarget(elements, ['gone']) === null);
}

console.log('\n2. several shapes selected means no card');
{
  const elements = [
    box('a', { customData: { docKey: 'one' } }),
    box('b', { x: 400, customData: { docKey: 'two' } })
  ];
  check('two selected shapes resolve to nothing', resolvePanelTarget(elements, ['a', 'b']) === null);
}

console.log('\n3. a shape with nothing to say gets no card, not an empty one');
{
  const elements = [box('plain')];
  check('a plain rectangle resolves to nothing', resolvePanelTarget(elements, ['plain']) === null,
        JSON.stringify(resolvePanelTarget(elements, ['plain'])));
}

console.log('\n4. clicking the label resolves to the box that holds the document');
{
  const elements = [
    box('outer', { width: 600, height: 400, customData: { docKey: 'section' } }),
    box('inner', { x: 20, y: 20, width: 200, height: 100, customData: { docKey: 'sync-reconciliation' } }),
    { id: 'label', type: 'text', x: 30, y: 40, width: 100, height: 20, text: 'Sync reconciliation', containerId: 'inner' }
  ];
  const target = resolvePanelTarget(elements, ['label']);
  check('resolved to a document', target?.docKey === 'sync-reconciliation', target?.docKey);
  check('anchored to the box, not the label', target?.anchorId === 'inner', target?.anchorId);
}

console.log('\n5. a label with no container falls back to the smallest enclosing box');
{
  const elements = [
    box('section', { width: 600, height: 400, customData: { docKey: 'section' } }),
    box('card', { x: 20, y: 20, width: 200, height: 100, customData: { docKey: 'card' } }),
    { id: 'free', type: 'text', x: 30, y: 40, width: 80, height: 20, text: 'Card' }
  ];
  const target = resolvePanelTarget(elements, ['free']);
  check('resolved to the innermost box, not the section', target?.docKey === 'card', target?.docKey);
  check('anchored to that box', target?.anchorId === 'card', target?.anchorId);
}

console.log('\n6. an issue block carries its own state, and anchors to itself');
{
  const elements = [box('block', {
    customData: {
      kind: 'issue',
      issueState: 'created',
      issueUrl: 'https://github.com/o/r/issues/1',
      issueTitle: 'A title',
      observation: 'the original wording'
    }
  })];
  const target = resolvePanelTarget(elements, ['block']);
  check('there is a card', target !== null);
  check('the issue state came through', target?.issue?.state === 'created', target?.issue?.state);
  check('the url came through', target?.issue?.issueUrl === 'https://github.com/o/r/issues/1');
  check('the observation was kept', target?.issue?.observation === 'the original wording');
  check('anchored to the block', target?.anchorId === 'block', target?.anchorId);
  check('no document is claimed', target?.docKey === null, String(target?.docKey));
}

console.log('\n7. deselecting an issue block closes it too');
{
  const elements = [box('block', { customData: { kind: 'issue', issueState: 'created' } })];
  check('nothing selected resolves to nothing', resolvePanelTarget(elements, []) === null,
        'the card would stay fully open with nothing selected');
}

console.log('\n8. an image gets a collapse control with or without a document');
{
  const bare = [{ id: 'img', type: 'image', x: 0, y: 0, width: 300, height: 200 }];
  const bareTarget = resolvePanelTarget(bare, ['img']);
  check('an undocumented image still gets a card', bareTarget !== null);
  check('with a collapse control', bareTarget?.collapsible?.id === 'img');
  check('reported as expanded', bareTarget?.collapsible?.collapsed === false);

  const collapsed = [{ ...bare[0], customData: { collapsed: true } }];
  check('a collapsed image reports collapsed',
        resolvePanelTarget(collapsed, ['img'])?.collapsible?.collapsed === true);
}

console.log('\n9. a deleted shape is not a selection');
{
  const elements = [box('gone', { isDeleted: true, customData: { docKey: 'one' } })];
  check('a deleted shape resolves to nothing', resolvePanelTarget(elements, ['gone']) === null);
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
