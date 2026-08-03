/**
 * Who is calling, rather than where this server opened.
 *
 * The guard in front of the board's contents used to test the **bind address** —
 * `LOOPBACK_ADDRESSES.includes(HOST)` — and that made a board on any interface inert for
 * everybody, the browser on the host machine included: its request comes from loopback and was
 * refused all the same. A bind on every interface and a bind on one address of a private
 * overlay — `100.x.y.z` on a tailnet, say — were treated
 * alike, so the careful configuration was punished exactly as hard as the reckless one, and
 * there was no configuration, however narrow, in which the board was reachable from a second
 * machine. That was the right answer while there was nobody to ask about (#366): the only
 * identity was one per-start bearer token, and a control that holds only while a second one is
 * set is not a control that was decided.
 *
 * #501 changes the question to the caller's own address:
 *
 * - the caller reached this server from the machine it runs on → allowed, exactly as before;
 * - the caller is remote → refused. The device credential that is meant to let one in is the
 *   next issue in this milestone; until it exists, "remote" and "refused" are the same answer.
 *   That is what makes this compatible: with no device paired, every existing board behaves as
 *   it did, and nothing a remote caller could not reach before becomes reachable now.
 *
 * **`X-Forwarded-For` is not read, and the request's own socket is.** This is the thing that
 * must not be got wrong. A reverse proxy reaches this server *on loopback*, which is why a proxy
 * configuration worked before this change and is untouched by it. Trusting a forwarded header
 * would let any remote caller claim to be loopback by setting one — turning the single property
 * of a caller nobody can forge into one anybody can. If proxy-awareness is ever wanted it is a
 * separate, opt-in decision with the proxy's own address pinned; it is not this, and it is why
 * the function below takes an address and not a request.
 *
 * This is a different question from `origin-gate.ts`, and neither stands in for the other. That
 * one asks what a *browser* said about itself, and its own comment records that a program which
 * can set headers can set any header. This one asks what the kernel filled in.
 */

/**
 * Whether `address` is one only this machine can hold.
 *
 * The whole of `127.0.0.0/8` is loopback by RFC 1122, not `127.0.0.1` alone, and no packet
 * carrying one of those as its source is accepted off an interface — which is the property this
 * guard rests on. `::ffff:127.0.0.1` is the mapped form a dual-stack listener reports for a
 * plain IPv4 client, so a guard that does not read it as loopback refuses the browser on the
 * operator's own machine.
 *
 * Anything this cannot read is **not** loopback. A hostname is not an address and a socket never
 * reports one; the value of an `X-Forwarded-For` is a list and parses as nothing; an exotic IPv6
 * spelling of `::1` that Node has never produced fails closed, which costs a local caller a 403
 * rather than letting a remote one in.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (typeof address !== 'string') return false;
  let value = address.trim().toLowerCase();
  if (!value) return false;

  // A zone index — `fe80::1%eth0` — names an interface and is not part of the address.
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  // Bracketed, as an authority spells an IPv6 address.
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (!value) return false;

  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;

  // The IPv4-mapped and IPv4-compatible forms, which is how an IPv4 client arrives at a
  // dual-stack listener. Node writes the embedded address in dotted quad.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return isLoopbackIPv4(mapped[1] as string);

  return isLoopbackIPv4(value);
}

function isLoopbackIPv4(value: string): boolean {
  const octets = value.split('.');
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return false;
    if (Number(octet) > 255) return false;
  }
  return Number(octets[0]) === 127;
}

/** What this needs of a request: its socket, and nothing that travelled inside the request. */
export interface CallerSocket {
  socket?: { remoteAddress?: string | null } | null;
}

/**
 * Whether the caller behind this request reached the server from the machine it runs on.
 *
 * An HTTP request and a WebSocket upgrade both arrive carrying one, so both funnels ask this and
 * get the same answer. A request with no socket to read — which this server never produces, but
 * a type says nothing about what a future transport might hand over — is refused.
 */
export function callerIsLocal(request: CallerSocket): boolean {
  return isLoopbackAddress(request.socket?.remoteAddress ?? null);
}
