/**
 * A port the operating system has just told us nobody is on.
 *
 * The checks used to compute their port as `<base> + (process.pid % N)`, which is not an
 * allocation at all — it is a guess with a band attached, and the bands overlapped. Two checks
 * running at once on the same machine could land on the same number, and a browser check's CDP
 * port could land inside another check's server band, so a failure read as a bug in the feature
 * when it was a bug in the arithmetic. Ask the kernel instead: bind port 0, read back what it
 * gave, close it.
 *
 * There is a race between the close and the caller's own listen, and it cannot be closed from
 * here — only narrowed. It is narrow because the port is freshly released and the kernel hands
 * out the ephemeral range in rough rotation, and a caller that loses it sees `EADDRINUSE` on
 * startup rather than a silent collision with somebody else's server, which is the failure mode
 * worth having.
 */
import { createServer } from 'node:net';

/**
 * Every port this process has already handed out.
 *
 * A check asks for its server's port, and later for its second server's or its Chrome's. Between
 * the two the first probe has closed, so nothing stops the kernel from offering the same number
 * twice — and by then the check has printed it into a stub script or a fixture and is about to
 * bind it. Remembering is what makes two separate `freePort()` calls in one run distinct, which
 * is what lets each declaration stay where it was written instead of being hoisted into one
 * allocation at the top of the file.
 */
const handedOut = new Set();

function probe() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.unref();
    socket.on('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

/** One port nobody is listening on, and that this process has not already claimed. */
export async function freePort() {
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = await probe();
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error('freePort: the kernel kept offering ports this run had already taken');
}

/**
 * `n` ports nobody is listening on, all different from each other.
 *
 * Calling `freePort()` in a loop is not enough: each probe closes before the next one opens, so
 * the kernel is free to hand back the same number twice. Every probe here is held open until
 * all of them have a port, which is what makes the set distinct — the checks that start a second
 * server, or a headless Chrome next to their server, depend on that and not merely on each port
 * being free on its own.
 */
export async function freePorts(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`freePorts(${n}): ask for at least one port`);
  const held = [];
  try {
    const ports = [];
    for (let attempt = 0; ports.length < n; attempt++) {
      if (attempt >= n + 64) {
        throw new Error('freePorts: the kernel kept offering ports this run had already taken');
      }
      const socket = await new Promise((resolve, reject) => {
        const socket = createServer();
        socket.unref();
        socket.on('error', reject);
        socket.listen(0, '127.0.0.1', () => resolve(socket));
      });
      held.push(socket);
      const { port } = socket.address();
      // Held open either way — dropping a duplicate here would hand it straight back on the
      // next turn of the loop.
      if (handedOut.has(port)) continue;
      handedOut.add(port);
      ports.push(port);
    }
    return ports;
  } finally {
    await Promise.all(held.map((socket) => new Promise((resolve) => socket.close(resolve))));
  }
}
