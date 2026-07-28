/**
 * The fields on an element that the server authors, and a browser only ever carries.
 *
 * `POST /api/elements/sync` merges whole elements by `version`, and `version` is a number
 * the browser owns: Excalidraw bumps it on every keystroke, drag and nudge, while the
 * server bumps it once per state change. Measured on a real run, the browser sat five
 * versions ahead of the store for two seconds with a research run in flight — so whenever a
 * browser payload built before a server write is applied after it, the browser wins, and it
 * wins with the *whole element*. `issueState`, `issueUrl` and `issueTitle` go back to
 * whatever that browser last knew, which for a block whose run started while the reader was
 * still working on it is the pristine draft.
 *
 * That is #118: three blocks that produced #94, #95 and #96 and kept no record of it. The
 * loss is silent in every direction — the run succeeded, the issue is good, and the only
 * symptom is a block that looks like it never ran, which nothing can retire and nothing can
 * run again.
 *
 * So these fields are taken out of the version race altogether. A version number can decide
 * where a shape sits and what its label says, because those are the browser's to decide. It
 * cannot decide whether an issue exists, because the browser was never told and has no way
 * of finding out.
 *
 * **Both directions.** A field the store holds is restored onto the payload; a field the
 * store does *not* hold is removed from it. The second half is the same defect read
 * backwards: after `DELETE /api/issue-block/:id` clears a stuck run, a browser still holding
 * `issueState: "running"` would otherwise put it straight back on the next autosync.
 */
import { issueBlockAppearance } from './issue-appearance.js';

/**
 * The `customData` keys the server writes and the browser never authors.
 *
 * One list, exported, so the writer and the merge cannot drift: every one of these is
 * written by `markState`, `adoptIssueTitle` or `recordImplement` in `src/server.ts` and by
 * nothing in `frontend/`.
 */
export const SERVER_AUTHORED_CUSTOM_DATA = [
  'issueState',
  'issueUrl',
  'issueError',
  'issueTitle',
  'observation',
  'implementState',
  'implementUrl',
  'implementError',
  'implementStartedAt',
  'implementEndedAt',
] as const;

interface ElementLike {
  customData?: Record<string, unknown> | null;
}

/**
 * The incoming element with the server's own fields put back.
 *
 * Returns the payload **untouched** when it already agrees, which is the ordinary case: a
 * browser that received the update over the socket carries these fields forward correctly,
 * and a shape that is not an issue block has none of them on either side. Only a payload
 * that disagrees is rewritten, and only in these fields — everything else about the element
 * is still the browser's.
 *
 * The appearance travels with the state it is drawn from. `markState` writes both together
 * because the look is the server's (`docs/issue-block.md`), so a merge that restored the
 * state and kept the browser's colours would leave a created block wearing the dashed
 * outline that means *no issue behind this yet* — the third of the three symptoms in #118.
 * Only a block that disagreed is repainted, so a reader's own styling of a block whose state
 * arrived normally is left alone.
 */
export function preserveServerAuthored<T extends ElementLike>(
  incoming: T,
  stored: ElementLike | undefined | null
): T {
  if (!stored) return incoming;

  const storedCustom = (stored.customData ?? {}) as Record<string, unknown>;
  const incomingCustom = (incoming.customData ?? {}) as Record<string, unknown>;

  const merged: Record<string, unknown> = { ...incomingCustom };
  let disagrees = false;
  for (const key of SERVER_AUTHORED_CUSTOM_DATA) {
    const held = Object.prototype.hasOwnProperty.call(storedCustom, key);
    if (held) {
      if (!Object.is(incomingCustom[key], storedCustom[key])) disagrees = true;
      merged[key] = storedCustom[key];
    } else if (Object.prototype.hasOwnProperty.call(incomingCustom, key)) {
      disagrees = true;
      delete merged[key];
    }
  }

  if (!disagrees) return incoming;

  // The appearance is only ever the server's for a block that is one of these. Repainting
  // anything else would be this fix committing the very mistake it is undoing.
  const isIssueBlock = storedCustom.kind === 'issue' || incomingCustom.kind === 'issue';
  return {
    ...incoming,
    ...(isIssueBlock ? issueBlockAppearance(storedCustom.issueState as string | undefined) : {}),
    customData: merged,
  };
}
