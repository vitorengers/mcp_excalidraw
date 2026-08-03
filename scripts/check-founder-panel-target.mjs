#!/usr/bin/env node
/**
 * Checks that selecting a founder card resolves a founder target, and never an issue.
 *
 * A founder action is the work only a person can do. The card that stands for one is drawn by
 * the mirror as an ordinary `role: 'card'` under the mirror's own kind — that is what keeps it
 * out of every derived-element strip point — so to the selection resolver it looks exactly like
 * a mirrored issue card until something tells the two apart. The thing that tells them apart is
 * `customData.founderKey`, and the branch that reads it has to be **before** the issue branch:
 * `offersImplement` takes only `{ githubState, implementState }` and knows nothing about
 * columns, so it cannot be trusted to keep the Implement control off a founder card. The target
 * must simply not look like an issue.
 *
 * The fixtures are built by hand rather than by calling `layoutMirror`, so this check says
 * nothing about how the column is drawn and is independent of the change that draws it. The
 * mirror's kind is spelled out here for the same reason.
 *
 * Offline, pure, no server and no browser. Run `./node_modules/.bin/tsc` first — this reads the
 * compiled module.
 *
 * Usage: node scripts/check-founder-panel-target.mjs
 *
 * Tier: fast
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(repoRoot, 'dist', 'core', 'panel-target.js');

if (!existsSync(modulePath)) {
  console.error('  FAIL  the panel target module exists — dist/core/panel-target.js not found');
  console.error('        (run tsc; this check reads the compiled module)');
  process.exit(1);
}

const { resolvePanelTarget } = await import(pathToFileURL(modulePath).href);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * The mirror's own kind, spelled rather than imported.
 *
 * Importing `src/core/project-board-layout.ts` for one string would make this check depend on
 * the module that draws the column, and the column and this branch are two separate changes.
 */
const MIRROR = 'project-board';

const box = (id, extra = {}) => ({
  id, type: 'rectangle', x: 0, y: 0, width: 300, height: 116, ...extra
});

/** A founder card as the mirror draws one: a card under the mirror's kind, carrying a key. */
const founderCard = (id, custom = {}) => box(id, {
  customData: { kind: MIRROR, role: 'card', founderKey: `w:gh-login`, ...custom }
});

/** The bound label a card's text lives in — a separate element, which is the old defect. */
const boundLabel = (id, containerId, text) => ({
  id, type: 'text', x: 8, y: 40, width: 280, height: 20, text, containerId
});

console.log('1. a founder card resolves to a founder target');
{
  const card = founderCard('pb-f-1', {
    founderKind: 'gh-login',
    founderState: 'open'
  });
  const elements = [card, boundLabel('pb-f-1-t', 'pb-f-1', 'Sign the GitHub CLI in to your account')];
  const target = resolvePanelTarget(elements, ['pb-f-1']);

  check('there is a card at all', target !== null,
        'a founder card resolves to nothing — no panel, no steps, no Done');
  check('the key came through', target?.founder?.key === 'w:gh-login', String(target?.founder?.key));
  check('the kind came through', target?.founder?.kind === 'gh-login', String(target?.founder?.kind));
  check('the state came through', target?.founder?.state === 'open', String(target?.founder?.state));
  check('the title is read off the bound label',
        target?.founder?.title === 'Sign the GitHub CLI in to your account',
        String(target?.founder?.title));
  check('anchored to the card', target?.anchorId === 'pb-f-1', String(target?.anchorId));
  check('and it claims no document', target?.docKey === null, String(target?.docKey));
}

console.log('\n2. a click on the label resolves to the same founder target as a click on the card');
{
  const card = founderCard('pb-f-2', { founderKind: 'gh-billing' });
  const elements = [card, boundLabel('pb-f-2-t', 'pb-f-2', 'GitHub is refusing work until billing is settled')];

  const fromCard = resolvePanelTarget(elements, ['pb-f-2']);
  const fromLabel = resolvePanelTarget(elements, ['pb-f-2-t']);

  check('the label resolves to a founder target', fromLabel?.founder != null,
        'clicking a label instead of the box it sits in was a real defect once');
  // Compared against the value rather than against the other answer, so that two shapes
  // resolving to nothing cannot report as two shapes resolving to the same thing.
  check('to the same key', fromLabel?.founder?.key === 'w:gh-login'
        && fromCard?.founder?.key === 'w:gh-login',
        `${String(fromLabel?.founder?.key)} vs ${String(fromCard?.founder?.key)}`);
  check('to the same kind', fromLabel?.founder?.kind === 'gh-billing'
        && fromCard?.founder?.kind === 'gh-billing',
        `${String(fromLabel?.founder?.kind)} vs ${String(fromCard?.founder?.kind)}`);
  check('and anchored to the card either way', fromLabel?.anchorId === 'pb-f-2',
        String(fromLabel?.anchorId));
}

console.log('\n3. the founder branch is read before the issue branch');
{
  // Everything `issueShapeOf` looks for, on a card that is a founder action: the mirror's kind,
  // `role: 'card'`, an issue URL and the Todo mark that would offer a re-research. If the issue
  // branch ran first this would resolve as an implementable card.
  const card = founderCard('pb-f-3', {
    issueUrl: 'https://github.com/octo-founder/pantry/issues/7',
    inTodo: true,
    implementState: 'failed',
    founderKind: 'agent-missing'
  });
  const elements = [card, boundLabel('pb-f-3-t', 'pb-f-3', 'The coding agent is not installed on this machine')];
  const target = resolvePanelTarget(elements, ['pb-f-3']);

  check('it resolves as a founder action', target?.founder?.key === 'w:gh-login',
        String(target?.founder?.key));
  check('and not as an issue', target?.issue === null, JSON.stringify(target?.issue));
  check('so nothing carries an issue URL to implement against',
        target?.issue?.issueUrl == null, String(target?.issue?.issueUrl));
  check('and the run mark on the card is not offered as a run',
        target?.issue?.implementState == null, String(target?.issue?.implementState));
}

console.log('\n4. a founder action is not an issue anybody may build or re-research');
{
  // The same Todo mark that makes a mirrored issue card recreatable.
  const card = founderCard('pb-f-4', { inTodo: true, founderKind: 'gh-scope' });
  const target = resolvePanelTarget([card], ['pb-f-4']);

  check('the target reports it is not recreatable', target?.founder?.recreatable === false,
        String(target?.founder?.recreatable));
  check('and there is no issue to read a recreate gate off',
        target?.issue?.recreatable === undefined, String(target?.issue?.recreatable));
  check('no Implement, Resume, Fix or Recreate control has anything to attach to',
        target?.issue === null, JSON.stringify(target?.issue));
}

console.log('\n5. an unmarked founder card is open, and a settled one says so');
{
  const open = resolvePanelTarget([founderCard('pb-f-5a')], ['pb-f-5a']);
  check('a card carrying no state reads as open', open?.founder?.state === 'open',
        String(open?.founder?.state));

  const settled = resolvePanelTarget([founderCard('pb-f-5b', { founderState: 'resolved' })], ['pb-f-5b']);
  check('a resolved card reads as resolved', settled?.founder?.state === 'resolved',
        String(settled?.founder?.state));

  const dismissed = resolvePanelTarget([founderCard('pb-f-5c', { founderState: 'dismissed' })], ['pb-f-5c']);
  check('a dismissed card reads as dismissed', dismissed?.founder?.state === 'dismissed',
        String(dismissed?.founder?.state));

  const nonsense = resolvePanelTarget([founderCard('pb-f-5d', { founderState: 'halfway' })], ['pb-f-5d']);
  check('a state the store cannot write reads as open rather than as a fourth state',
        nonsense?.founder?.state === 'open', String(nonsense?.founder?.state));

  const unkinded = resolvePanelTarget([founderCard('pb-f-5e')], ['pb-f-5e']);
  check('a card naming no kind reports none rather than guessing one',
        unkinded?.founder?.kind === null, String(unkinded?.founder?.kind));
}

console.log('\n6. every other shape resolves exactly as it does today');
{
  const card = box('pb-c-9', {
    customData: {
      kind: MIRROR, role: 'card', itemId: 'i9',
      issueUrl: 'https://github.com/octo-founder/pantry/issues/9', inTodo: true
    }
  });
  const mirrored = resolvePanelTarget([card, boundLabel('pb-c-9-t', 'pb-c-9', '#9 A real issue')],
                                      ['pb-c-9']);
  check('a mirrored issue card still resolves as an issue', mirrored?.issue?.state === 'created',
        String(mirrored?.issue?.state));
  check('with its URL', mirrored?.issue?.issueUrl === 'https://github.com/octo-founder/pantry/issues/9');
  check('and still recreatable in Todo', mirrored?.issue?.recreatable === true);
  check('and no founder target', mirrored?.founder === null, JSON.stringify(mirrored?.founder));

  const block = box('block', {
    customData: { kind: 'issue', issueState: 'created', issueUrl: 'https://github.com/octo-founder/pantry/issues/3' }
  });
  const authored = resolvePanelTarget([block], ['block']);
  check('an authored issue block still resolves as an issue', authored?.issue?.state === 'created',
        String(authored?.issue?.state));
  check('and no founder target', authored?.founder === null, JSON.stringify(authored?.founder));

  const docs = box('doc', { customData: { docKey: 'sync-reconciliation' } });
  const documented = resolvePanelTarget([docs], ['doc']);
  check('a docs card still resolves to its document', documented?.docKey === 'sync-reconciliation',
        String(documented?.docKey));
  check('and no founder target', documented?.founder === null, JSON.stringify(documented?.founder));

  const image = { id: 'img', type: 'image', x: 0, y: 0, width: 300, height: 200 };
  const collapsible = resolvePanelTarget([image], ['img']);
  check('an image still gets its collapse control', collapsible?.collapsible?.id === 'img');
  check('and no founder target', collapsible?.founder === null, JSON.stringify(collapsible?.founder));

  check('a bare rectangle still resolves to nothing',
        resolvePanelTarget([box('plain')], ['plain']) === null,
        JSON.stringify(resolvePanelTarget([box('plain')], ['plain'])));
}

console.log('\n7. a selection that is not one shape, and a shape with no marks');
{
  const two = [founderCard('pb-f-7a'), founderCard('pb-f-7b', { founderKey: 'w:gh-scope' })];
  check('two selected shapes resolve to nothing', resolvePanelTarget(two, ['pb-f-7a', 'pb-f-7b']) === null,
        JSON.stringify(resolvePanelTarget(two, ['pb-f-7a', 'pb-f-7b'])));
  check('an empty selection resolves to nothing', resolvePanelTarget(two, []) === null);
  check('a shape with no marks resolves to nothing', resolvePanelTarget([box('bare')], ['bare']) === null,
        JSON.stringify(resolvePanelTarget([box('bare')], ['bare'])));
  check('a deleted founder card is not a selection',
        resolvePanelTarget([founderCard('pb-f-7c', {})].map((element) => ({ ...element, isDeleted: true })),
                           ['pb-f-7c']) === null);
}

console.log('\n8. a key on its own is not a founder card');
{
  const loose = box('loose', { customData: { founderKey: 'w:gh-login' } });
  check('a shape the mirror never drew is not a founder card',
        resolvePanelTarget([loose], ['loose']) === null,
        JSON.stringify(resolvePanelTarget([loose], ['loose'])));

  const authored = box('mixed', {
    customData: { kind: 'issue', issueState: 'draft', founderKey: 'w:gh-login' }
  });
  const mixed = resolvePanelTarget([authored], ['mixed']);
  check('an authored block carrying the key is still an issue', mixed?.issue?.state === 'draft',
        String(mixed?.issue?.state));
  check('and is not a founder target', mixed?.founder === null, JSON.stringify(mixed?.founder));

  const blank = box('blank', { customData: { kind: MIRROR, role: 'card', founderKey: '' } });
  check('a card whose key is empty addresses nothing and resolves to nothing',
        resolvePanelTarget([blank], ['blank']) === null,
        JSON.stringify(resolvePanelTarget([blank], ['blank'])));
}

console.log('\n9. the resolver does not reach into the store');
{
  // `frontend/tsconfig.json` sets `"types": []`, so even a type imported from a module that
  // opens files resolves that module's graph and fails the frontend type check in files nobody
  // touched. The founder target's shape is therefore declared here or taken from the pure
  // register module, never from the store.
  const source = readFileSync(join(repoRoot, 'src', 'core', 'panel-target.ts'), 'utf8');
  check('src/core/panel-target.ts names no founder store',
        !/founder-store/.test(source),
        'a type imported from the store drags `fs` into the browser build');
  check('and the compiled module imports none either',
        !/founder-store/.test(readFileSync(modulePath, 'utf8')));
  check('the founder target is declared where the browser can read it',
        /FounderTargetData/.test(source), 'no FounderTargetData in the module');
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
