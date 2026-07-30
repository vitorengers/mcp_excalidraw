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

/** One port nobody is listening on. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
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
  const probes = [];
  try {
    const ports = [];
    for (let i = 0; i < n; i++) {
      const { probe, port } = await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => resolve({ probe, port: probe.address().port }));
      });
      probes.push(probe);
      ports.push(port);
    }
    return ports;
  } finally {
    await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))));
  }
}
