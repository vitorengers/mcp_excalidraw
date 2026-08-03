/**
 * A caller a guard has to treat as remote, on a machine that only has itself.
 *
 * While the guards here tested the **bind address**, a check could ask the whole question
 * without a network: bind `127.0.0.2`, which the code under test called "not loopback" over a
 * list of `127.0.0.1` and `::1` exactly, and nothing ever left the machine. `check-workspaces-
 * guard.mjs` and `check-board-reads-guard.mjs` both say so at length, and they were right.
 *
 * Since #501 the guards ask who is **calling**, and that trick is gone: `127.0.0.2` is a
 * loopback address by RFC 1122 and the whole of `127.0.0.0/8` is one, so a caller reaching a
 * server there is local and is served. There is no substitute left for a peer address that is
 * genuinely not loopback — a check that wants one has to have the server accept on an address
 * some other machine could in principle use.
 *
 * So this picks one, and picks it in an order that minimises what is published while it does:
 *
 *   1. a **host-only** adapter first — a Hyper-V or WSL virtual switch, a Docker bridge, a
 *      VirtualBox host network. Its address is not loopback, so the code under test calls the
 *      caller remote, and it is not on the LAN either;
 *   2. any other non-internal IPv4 address, named on stdout when it is taken, because a check
 *      that puts a board on a real interface for a second should say so rather than do it
 *      quietly;
 *   3. `null`, when the machine has nothing but loopback. A check then has no way to build a
 *      remote caller and says which cases it could not run instead of passing as though it had.
 *
 * The exposure is a few seconds on a port the kernel just handed out, and what is being asserted
 * in those seconds is that the board refuses everything arriving there.
 */

import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, get as httpGet } from 'node:http';
import { networkInterfaces } from 'node:os';

/** Adapters that exist to talk to something on this machine, in the names Windows and Linux use. */
const HOST_ONLY = /vethernet|hyper-v|virtualbox|vboxnet|vmnet|docker|wsl|host-only|virtual/i;

/** Whether this machine will let a server sit on `host`. */
export function canBind(host) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * Whether an address is one only this machine can hold — the same question the server asks,
 * spelled out here rather than imported.
 *
 * A check that establishes its own premise with the code it is about to test has established
 * nothing. This is deliberately the crude form: it is used to *reject* a candidate, so it only
 * has to recognise the loopback spellings a socket actually produces.
 */
export function looksLikeLoopback(address) {
  const value = String(address ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === '::1'
    || value.startsWith('127.')
    || value.startsWith('::ffff:127.')
    || value === '0:0:0:0:0:0:0:1';
}

/**
 * A non-loopback IPv4 address on this machine a server can be bound to, or `null`.
 *
 * `note` is called with a line for stdout whenever the answer is a real interface rather than a
 * host-only one, so the check's output records what it published and where.
 */
export async function remoteInterfaceAddress(note = () => {}) {
  const hostOnly = [];
  const rest = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (looksLikeLoopback(entry.address)) continue;
      (HOST_ONLY.test(name) ? hostOnly : rest).push({ name, address: entry.address });
    }
  }

  for (const candidate of hostOnly) {
    if (await canBind(candidate.address)) return candidate.address;
  }
  for (const candidate of rest) {
    if (await canBind(candidate.address)) {
      note(`no host-only adapter here; using ${candidate.name} at ${candidate.address}, `
           + 'which is a real interface for as long as this check runs');
      return candidate.address;
    }
  }
  return null;
}

/**
 * The peer address a server bound to `address` actually sees when it is called there.
 *
 * The premise of every remote case is that connecting to one of this machine's own interface
 * addresses gives the *interface* as the source rather than `127.0.0.1`. That is how source
 * selection works on both platforms this repository runs on, and it is one system call away from
 * being checked rather than assumed — so it is checked, by a throwaway HTTP server of this
 * check's own that reports what it was handed.
 */
export function peerAddressSeenOn(address) {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((request, response) => {
      const peer = request.socket.remoteAddress ?? '';
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(peer);
    });
    server.once('error', reject);
    server.listen(0, address, () => {
      const { port } = server.address();
      const request = httpGet({ host: address, port, path: '/' }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => server.close(() => resolve(body.trim())));
      });
      request.once('error', (error) => server.close(() => reject(error)));
    });
  });
}
