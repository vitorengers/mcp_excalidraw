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

export { claudeCodeAdapter, codexCliAdapter, rawAdapter };
