/**
 * Which key reaches which part of a board — decided by the board, not by this file.
 *
 * The two keys that came before this one are constants in the frontend: `Alt+B` finds the
 * GitHub mirror and `Alt+T` the terminal, both by looking for a `customData.kind` and
 * scrolling onto it. That works because a mirror and a terminal are features of every
 * board. A *section* is not: what this board calls "Project structure" and "Development"
 * is this board's own cut of its own documentation, and a third and fourth constant in
 * `App.tsx` would make the feature wrong for every other project the moment someone drew
 * their sections differently.
 *
 * So the mark carries the key. A shape with `customData.kind = "board-section"`,
 * a `title` and a `hotkeyCode` is a section, and the frontend binds whatever it finds.
 * Authored `customData` already survives the sync and the export — `docKey` has proved
 * that since #3 — so a board declares its own navigation and nothing has to be deployed.
 *
 * Pure, and separate from the component, for the same reason `panel-target.ts` is: a
 * hotkey that does nothing compiles perfectly. `scripts/check-board-map.mjs` runs this
 * against boards built in memory, and `scripts/check-board-sections-browser.mjs` runs the
 * binding it produces against a real Chrome.
 */

export const BOARD_SECTION_KIND = 'board-section';

/**
 * Keys the frontend binds itself, which a board therefore cannot have.
 *
 * Ignored rather than overridden in either direction: a section that silently stole
 * `Alt+T` would break the terminal from a data file, and one that silently lost its key
 * with nothing said would look like a hotkey that does not work.
 */
export const RESERVED_HOTKEY_CODES: readonly string[] = ['KeyB', 'KeyT'];

export interface BoardSectionElement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: Record<string, unknown> | null;
  isDeleted?: boolean;
}

export interface BoardSectionBinding {
  code: string;
  title: string;
  elementId: string;
}

export interface IgnoredSectionClaim extends BoardSectionBinding {
  reason: 'reserved' | 'duplicate' | 'malformed';
}

export interface BoardSectionHotkeys {
  bindings: BoardSectionBinding[];
  ignored: IgnoredSectionClaim[];
}

/** A `KeyboardEvent.code`, not a description of a chord: `KeyP`, never `Alt+P`. */
const isKeyCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value);

const asTitle = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

/**
 * Read the sections off a scene, and say which of them got their key.
 *
 * Reading order — down the board, then across — so that a duplicate is settled by where
 * the sections sit rather than by the order the store happened to hand them over. Two
 * sections claiming `Alt+P` is a mistake either way; deciding it by array order would
 * make which one wins change when nothing on the board did.
 *
 * Everything rejected comes back in `ignored` with a reason, so the frontend can say so
 * once instead of a key quietly doing nothing.
 */
export function resolveBoardSectionHotkeys(
  elements: readonly BoardSectionElement[],
  reserved: readonly string[] = RESERVED_HOTKEY_CODES
): BoardSectionHotkeys {
  const sections = elements
    .filter((element) => !element.isDeleted)
    .filter((element) => (element.customData ?? {}).kind === BOARD_SECTION_KIND)
    .slice()
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const bindings: BoardSectionBinding[] = [];
  const ignored: IgnoredSectionClaim[] = [];
  const taken = new Set<string>();

  for (const section of sections) {
    const custom = section.customData ?? {};
    const code = custom.hotkeyCode;
    const claim = {
      code: typeof code === 'string' ? code : '',
      title: asTitle(custom.title),
      elementId: section.id,
    };

    if (!isKeyCode(code)) ignored.push({ ...claim, reason: 'malformed' });
    else if (reserved.includes(code)) ignored.push({ ...claim, reason: 'reserved' });
    else if (taken.has(code)) ignored.push({ ...claim, reason: 'duplicate' });
    else { taken.add(code); bindings.push({ ...claim, code }); }
  }

  return { bindings, ignored };
}

/** What to print when a board asks for a key it cannot have. One line, once. */
export function describeIgnoredClaims(ignored: readonly IgnoredSectionClaim[]): string {
  return ignored
    .map((claim) => {
      const named = claim.title ? `"${claim.title}"` : claim.elementId;
      if (claim.reason === 'malformed') return `${named} claims ${JSON.stringify(claim.code)}, which is not a KeyboardEvent.code`;
      if (claim.reason === 'reserved') return `${named} claims ${claim.code}, which this canvas already binds`;
      return `${named} claims ${claim.code}, which a section higher on the board already has`;
    })
    .join('; ');
}
