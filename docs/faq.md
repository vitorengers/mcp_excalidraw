# Questions, and things that go wrong

The questions the front page used to answer at length, and the failures worth recognising on
sight. [install.md](install.md) is the fuller "it will not come up" section;
[running.md](running.md) is the operator procedure.

## How is this different from the official Excalidraw MCP?

Excalidraw has an [official MCP](https://github.com/excalidraw/excalidraw-mcp) — a chat widget
that streams a diagram inline from a single prompt. It is very good at "draw me a cat" inside a
chat client. This project solves a different problem: giving a *coding agent* a persistent canvas
workbench.

| | Official Excalidraw MCP | This project |
|---|---|---|
| **Approach** | Prompt in, diagram out (one-shot widget) | Element-level control, over a CLI and MCP tools |
| **State** | Checkpoints inside the chat widget | A persistent live canvas with real-time sync |
| **Element CRUD** | Declarative re-send with delete markers | Full create / read / update / delete per element |
| **The agent sees the canvas** | No | `describe` (structured text) and `screenshot` (an image) |
| **Iterative refinement** | Regenerate from a checkpoint | Draw, look, adjust, look again — element by element |
| **Layout tools** | No | align, distribute, group / ungroup, lock, duplicate |
| **File I/O** | No model-facing export | `.excalidraw` export and import — diagrams as repo artifacts |
| **Works without MCP** | No | Yes — the CLI, the agent skill and the REST API |
| **Multi-agent** | A single chat | Several agents on the same canvas at once |

And then the half that has no counterpart there at all: issue blocks, the mirrored project board,
implementations in a worktree each, and real shells on the canvas.

## Can the agent actually see the diagram it drew?

Yes, and it is the point. `describe` returns a structured text summary — ids, positions, labels,
connections — and `screenshot` returns a rendered PNG. Agents use both to catch truncated labels,
overlaps and bad arrow routing, then fix them element by element. See [cli.md](cli.md).

## Do I need a browser tab open?

Only for the rendering-dependent commands: screenshots, PNG and SVG export, viewport control and
Mermaid conversion, all of which render in the Excalidraw frontend. Creating, querying and
updating elements, and exporting `.excalidraw` JSON, work with no tab. The CLI exits with code
`4` and says so when a tab is needed.

## Which agents and clients does it work with?

Anything that can run a shell command can use the CLI; any Model Context Protocol client can use
the MCP server ([mcp-server.md](mcp-server.md) has a configuration block for each); anything else
can use the [REST API](rest-api.md). For the coding agent that opens issues and writes
implementations, see [agents.md](agents.md) — that one is a command line you supply.

## Are my diagrams persistent?

Across a restart, yes: each board is saved about a second after it changes, into this tool's
per-user state directory, and read back when the server comes up. That is a working memory and
not a place to keep anything — nothing there is committed. Export the diagrams you mean to keep
into your repository (`export --out docs/architecture.excalidraw`) and re-`import` one to keep
refining it. Named `snapshot`s live in memory only, for undoing a change within a session, and
the files behind pasted images do too — a restored image is an element whose file has gone.

## Are excalidraw.com share links private?

`share` encrypts the scene locally with AES-GCM before uploading; the decryption key is only in
the URL fragment, which excalidraw.com's server never sees. Anyone you give the whole link to can
view the diagram.

## Does it need an API key or a cloud service?

No. Core drawing runs locally under an MIT licence. The only outbound calls are the optional
`share` upload and, if you use the workbench half, the github.com requests it makes on your
behalf.

## Things that go wrong

- **CLI exit code 3** — the canvas is unreachable: the server is not running for an inspecting
  command such as `status`, auto-start is off (`EXCALIDRAW_NO_AUTOSTART=1`), or
  `EXPRESS_SERVER_URL` points at a non-loopback host. Run `start` explicitly, or fix the
  environment.
- **CLI exit code 4** — a browser tab is required. Open the canvas URL that `status` prints and
  retry.
- **The canvas does not update** — confirm `EXPRESS_SERVER_URL` points at the canvas server that
  is actually running; `status` shows the URL in use.
- **The board comes up blank** — expected in a clone that has registered no project yet. See
  [The first run](running.md#the-first-run-register-the-clone-as-its-own-project).
- **A block's buttons do nothing** — the agent behind it is missing rather than broken. Run
  `vibemaxxing doctor`, which reports per role and per environment and names the variable to set.
- **The terminal block is missing** — press `Alt+T`. One key covers every way it can be absent:
  it scrolls to the blocks, places one if the board has none, and opens a session if none is
  running, including after the last tab was closed. See [terminal.md](terminal.md).
- **The port you wanted is taken** — the server takes a free one and prints it. On Windows a
  portproxy rule can make a port answer itself and hang; [trap-port-3000.md](trap-port-3000.md)
  is that story.
- **An agent exits 0 having done nothing** — its allowed-tools pattern no longer matches. See
  [trap-allowed-tools.md](trap-allowed-tools.md).
