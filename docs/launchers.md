# Launchers, and the three things this is not

The release promises that one double-click brings up a working board. This is what that
double-click is, and — the more expensive half — what it deliberately is not, so that nobody
prices a bundled runtime or a signed app again without knowing it was already considered.

## What ships

Three files under `launchers/`, tracked, each a thin wrapper around the same command a person
could type:

| File | Platform | How it is used |
|---|---|---|
| [`launchers/vibemaxxing.cmd`](../launchers/vibemaxxing.cmd) | Windows | Double-click it. |
| [`launchers/VibeMaxxing.command`](../launchers/VibeMaxxing.command) | macOS | Double-click it in Finder; it opens in Terminal. |
| [`launchers/vibemaxxing.desktop`](../launchers/vibemaxxing.desktop) | Linux | Copy it into `~/.local/share/applications/` and it appears in the launcher. |

All three do the same three things: check that `node` is on the path, run
`npx -y @vitorengers/vibemaxxing@latest`, and make the failure visible instead of letting the
window vanish. Nothing else — no bundled runtime, no configuration, no state of their own.
`node scripts/check-launchers.mjs` holds them to it, including that all three name the same
package at the same tag, and that the version they tell a user to install is the one
`package.json`'s `engines.node` requires — a floor written into three files drifts from the
manifest the first time the manifest moves, which is what #418 did to it before this even
landed.

**They are not published in the npm tarball**, and they are not meant to be: a launcher whose
only job is to run `npx` is useless to somebody who has already installed the package. They
are what a first-time user downloads from the repository, one file.

### The two properties that go wrong in silence

Both are invisible in a normal diff and both are decided by the git index rather than by what
the file looks like locally, which is why they are asserted rather than remembered.

- **`VibeMaxxing.command` is mode `100755` in the index.** `core.filemode` is `false` on a
  normal Windows checkout, so a file added there lands `100644` however its local permissions
  read: `Permission denied` on Linux, and a macOS double-click that opens it in a text editor
  instead of running it. `git update-index --chmod=+x` is the only way to set it from such a
  checkout.
- **`vibemaxxing.cmd` arrives with CRLF**, because `cmd.exe` is the reader. That is pinned in
  `.gitattributes` as `*.cmd text eol=crlf`, which decides what a *checkout* writes; the blob
  in the index stays LF like every other text file in this repository, and
  [`scripts/check-tracked-file-modes.mjs`](../scripts/check-tracked-file-modes.mjs) would fail
  it if it did not.

### Two things a launcher cannot fix

- **macOS, and a `node` that only exists in an interactive shell.** Finder runs a `.command`
  through a login shell, so `/etc/paths` and `~/.zprofile` are read and a Homebrew or
  installer-package Node is found. A Node installed by `nvm` is not: `nvm` is loaded from
  `~/.zshrc`, which a login shell does not source. Such a machine gets the "Node.js is
  required" message despite having Node, and the answer is to type the `npx` command in a
  terminal instead.
- **Linux, and where the failure goes.** `Terminal=false` is the point of a desktop entry —
  the board's interface is the browser, and a terminal window that exists only to be ignored
  is worse than none. But it also means there is no window to keep open, so the one failure
  the entry can surface it surfaces another way: with no `node` on the path it opens
  nodejs.org's download page in the browser. A `.desktop` file placed on the *desktop* rather
  than in `~/.local/share/applications/` additionally needs the executable bit and GNOME's
  "Allow Launching" before it will run at all; the applications directory needs neither, which
  is why that is the instruction above.

## What was rejected, and why

The cheapest tier that works is the one that ships. Each of these is more expensive than it
looks, and each is hard to walk back once a release has gone out on it.

### Node SEA — a single executable

Node's single-executable-application feature bundles a script and the runtime into one file.
It cannot bundle this one. The terminal block depends on `@lydell/node-pty`, whose whole reason
for being chosen over `node-pty` is that it ships a prebuilt per-platform `.node` binary rather
than needing a compiler at install time
([`src/core/terminal-session.ts`](../src/core/terminal-session.ts)). A native addon is not
something a SEA can hold: it would have to be shipped beside the executable and loaded from
disk, which is the single file gone. And a SEA is still an unsigned binary on both macOS and
Windows, so it inherits the whole of the signing problem below without solving the packaging
one.

### Electron or Tauri — a desktop shell

Both would wrap a page the user's own browser already renders, better, with their own
bookmarks, extensions and zoom. What they add is a second build toolchain and a release matrix
— per-platform, per-architecture — maintained forever, for a window. This project's canvas is
a web page on loopback on purpose; a shell around it buys nothing a tab does not already have.

### A signed, notarised application

This is the only option that would make a downloaded binary open without a warning, and it is
a recurring bill rather than a one-off effort: an Apple Developer Program membership and a
notarisation round-trip on every build for macOS, and for Windows either an EV code-signing
certificate or months of accumulating SmartScreen reputation from a standing start.

Shipping it **unsigned** is not the cheap version of this — it is strictly worse than the
terminal command it replaces. Gatekeeper's *"cannot be opened because the developer cannot be
verified"* reads as malware to the person seeing it, where `npx` reads as normal. A first run
that looks like a virus warning is a worse first run than one that looks like a command.

## The command underneath

```
npx -y @vitorengers/vibemaxxing@latest
```

That is the whole of what the launchers do, and it is worth knowing because it is also the
answer whenever one of them cannot work: a machine with no Finder, a distro with no
`xdg-open`, an `nvm`-only Node. See [running.md](running.md) for what the board does once it is
up, and [cli.md](cli.md) for what a bare invocation means when it is an MCP client rather than
a person on the other end.
