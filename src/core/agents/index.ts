/**
 * The backends this board knows, and the one function that resolves a name to one.
 *
 * A registry of its own rather than a `switch` inside `agent-adapter.ts`, for a plain reason:
 * every adapter imports the types and the command-line helpers from that module, so a lookup
 * living there would import them back and close a cycle. Here the arrows all point one way —
 * `agent-adapter.ts` is the leaf every adapter reads, this is the leaf's index, and everything
 * that runs an agent imports this.
 *
 * A closed record rather than a lookup by file name. An adapter decides what argv a process is
 * spawned with, so "whatever module is on disk under this name" would be a way to run something
 * on a board where only one command line was ever granted — the property `workspaces.ts:30-34`
 * argues at length about a project file supplying a command, arriving through a different door.
 */
import type { AgentAdapter, AgentBackendId } from '../agent-adapter.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexCliAdapter } from './codex-cli.js';
import { rawAdapter } from './raw.js';

const ADAPTERS: Record<AgentBackendId, AgentAdapter> = {
  'claude-code': claudeCodeAdapter,
  'codex-cli': codexCliAdapter,
  raw: rawAdapter,
};

/**
 * The adapter for a named backend.
 *
 * Total: `AgentBackendId` is a closed union, so there is no unknown name to refuse and no
 * fallback to hide a typo. A name arriving as free text is turned into one — or into null —
 * by `agentBackendId` before it reaches here.
 */
export function adapterFor(id: AgentBackendId): AgentAdapter {
  return ADAPTERS[id];
}

/**
 * The reasoning-effort levels one backend accepts.
 *
 * A function of its own rather than a field read off `adapterFor`, because the caller is
 * `workspaces.ts`, which validates a project's settings and has no business holding a thing that
 * builds argv and parses streams. This is the whole of what the config layer needs to know about
 * a backend, and asking for it by name keeps it that way.
 */
export function agentEfforts(id: AgentBackendId): readonly string[] {
  return ADAPTERS[id].efforts;
}

/**
 * The backends that can say what this machine has spent, in the order they are declared.
 *
 * `readLimits` is optional, so this is the whole of the capability lookup: a backend that
 * cannot answer is not in the list rather than in it answering nothing. `agentEfforts` above
 * asks a *named* backend what it accepts; this asks the set of them which can answer at all,
 * because its caller has no backend in hand — see below.
 *
 * **Not the board's configured backend, deliberately.** Every board that exists runs `raw` — an
 * arbitrary command line — and a `raw` command line is very often Claude Code, so gating the
 * limits route on the configured backend would turn the HUD off for every reader who has one
 * today. What the route is asking is a question about the *machine*: has anything on it written
 * a reading these files can be read from. So it asks whoever can read, which is one backend
 * today; when a second can, the choice between them is a decision that belongs with the second
 * reader rather than guessed at here (#334).
 */
export function limitsReaders(): AgentAdapter[] {
  return Object.values(ADAPTERS).filter((adapter) => typeof adapter.readLimits === 'function');
}

export { claudeCodeAdapter, codexCliAdapter, rawAdapter };
