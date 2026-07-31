/**
 * Doc keys that belong to a block this server draws, not to the board it is drawn on.
 *
 * The mirror is generated onto every project that names a `githubProject`, always carrying
 * `docKey: "project-board"` — a key that resolved inside the mirrored project, where the
 * document has no reason to exist. A tool block's documentation is a property of the tool, so
 * these resolve against the tool's own directory whatever board is asking. That was true of the
 * mirror and of nothing else: the terminal block, the issue block and the docs card itself draw
 * on every board too, and pointed at documents only this repository has.
 *
 * **An explicit list, not the whole of `TOOL_DOCS_DIR`.** Falling through to the tool for any
 * unmatched key would let a project's own `index` or `configuration` key quietly resolve to this
 * one's — a wrong answer, where the 404 it replaces was at least an honest one. The cost is that
 * this list is hand-maintained, and `scripts/check-tool-doc-keys.mjs` is what keeps a key added
 * here from naming a document that does not ship.
 *
 * **Where a project holds a file of the same name, the tool's wins.** A mirror drawn onto a
 * project that happens to keep its own `project-board.md` must show the mirror's documentation,
 * because the block is the tool's and the reader selected the block. `docs/docs-block.md` states
 * the rule; the check enforces it.
 *
 * In its own module rather than beside the route, because the route is not the only thing that
 * has to agree about the set: the check asks every key in it to resolve, and a list it had to
 * copy would be a second definition to drift from this one.
 */
import { MIRROR_DOC_KEY } from './project-board-layout.js';

export const TOOL_DOC_KEYS = new Set<string>([
  MIRROR_DOC_KEY,    // 'project-board' — the mirror region and its header
  'issue-block',     // the observation block, and the agents behind it
  'terminal',        // the terminal block and its sessions
  'docs-block',      // the card this route draws
  'board-sections',  // the section marks, which carry keys of their own
  'shared-library',  // where the blocks above are dropped from
  'workspaces',      // the project tabs they are drawn on
]);
