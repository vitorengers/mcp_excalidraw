/**
 * What this canvas answers to on the wire.
 *
 * The `service` field in `/health` is a contract rather than a label: `isCanvasHealth` gates
 * auto-start and `stop` on it, and the identity re-probe in front of every `/api` request
 * refuses anything that does not carry it. So the rename that is coming cannot be one commit.
 * Acceptance ships first — a build from this branch attaches to a canvas answering either
 * marker — and only a later release changes what the server itself answers. The other order
 * hands a user with a canvas already running from the old build a `CANVAS_UNREACHABLE` and a
 * message blaming "a pre-1.1 canvas build or an unrelated service on the port", which is the
 * wrong problem.
 *
 * No imports on purpose: this is read by `core/port.ts`, which the CLI entry point loads
 * *before* `core/config.ts` captures a canvas URL, and anything reaching config from here
 * would freeze that URL a resolution earlier than it should.
 */

/** What every build up to and including this one puts in `/health`. */
export const LEGACY_CANVAS_SERVICE_NAME = 'mcp-excalidraw-canvas';

/** What the rename will put there. Accepted now, answered with later. */
export const NEXT_CANVAS_SERVICE_NAME = 'vibemaxxing-canvas';

/**
 * The marker the server answers with today. Deliberately still the legacy one: this change is
 * the acceptance half, and a commit that moved both halves at once would be the failure the
 * acceptance exists to prevent.
 */
export const CANVAS_SERVICE_NAME = LEGACY_CANVAS_SERVICE_NAME;

/** Newest first, because that is the one a payload will carry once the rename lands. */
export const ACCEPTED_CANVAS_SERVICE_NAMES: readonly string[] = [
  NEXT_CANVAS_SERVICE_NAME,
  LEGACY_CANVAS_SERVICE_NAME
];

/**
 * Whether a `/health` payload's `service` is one of ours.
 *
 * How long the legacy value stays accepted is a release decision rather than a code one. This
 * fork has never published, so the population it protects is the maintainer and anyone who
 * cloned — one release is what that can defend, and removing the entry is a one-line change
 * here when the time comes.
 */
export function isAcceptedCanvasService(service: unknown): boolean {
  return typeof service === 'string' && ACCEPTED_CANVAS_SERVICE_NAMES.includes(service);
}
