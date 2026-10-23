/**
 * Classify an IP address for outbound-request (SSRF) policy.
 *
 * `classifyIp` returns null for a globally routable unicast address and a
 * rejection reason for anything else. IPv6 is parsed into its full 128-bit
 * form so that IPv4-mapped (`::ffff:a.b.c.d`, also written `::ffff:7f00:1`),
 * IPv4-compatible, SIIT, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) and 6to4
 * forms are judged by the IPv4 address they carry — a socket connecting to
 * `::ffff:127.0.0.1` reaches IPv4 loopback. Anything that does not parse is
 * refused (fail closed).
 */
import { isIPv4, isIPv6 } from 'node:net';

export type IpRejection = 'loopback' | 'private_address' | 'link_local' | 'reserved_address';

type Octets = [number, number, number, number];

function parseIPv4(address: string): Octets | null {
  if (!isIPv4(address)) return null;
  const parts = address.split('.').map(Number);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

function classifyIPv4(o: Octets): IpRejection | null {
  const [a, b, c] = o;
  if (a === 0) return 'loopback'; // 0.0.0.0/8 — connects to this host
  if (a === 127) return 'loopback';
  if (a === 10) return 'private_address';
  if (a === 172 && b >= 16 && b <= 31) return 'private_address';
  if (a === 192 && b === 168) return 'private_address';
  if (a === 100 && b >= 64 && b <= 127) return 'private_address'; // CGNAT 100.64/10
  if (a === 169 && b === 254) return 'link_local'; // incl. 169.254.169.254
  if (a === 192 && b === 0 && c === 0) return 'reserved_address'; // 192.0.0/24
  if (a === 192 && b === 0 && c === 2) return 'reserved_address'; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'reserved_address'; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'reserved_address'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved_address'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved_address'; // TEST-NET-3
  if (a >= 224) return 'reserved_address'; // multicast, 240/4, broadcast
  return null;
}

/** Expand an IPv6 literal (optionally with a trailing dotted quad) to 8 hextets. */
function parseIPv6(address: string): number[] | null {
  if (!isIPv6(address)) return null;
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const o = parseIPv4(maybeV4);
    if (!o) return null;
    const hex = (n: number) => n.toString(16);
    text = `${text.slice(0, lastColon + 1)}${hex((o[0] << 8) | o[1])}:${hex((o[2] << 8) | o[3])}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':').map((h) => Number.parseInt(h, 16)));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  const explicit = head.length + rest.length;
  if (halves.length === 1 && explicit !== 8) return null;
  if (explicit > 8) return null;
  const fill = halves.length === 2 ? new Array<number>(8 - explicit).fill(0) : [];
  const groups = [...head, ...fill, ...rest];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function embeddedV4(hi: number, lo: number): Octets {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function classifyIPv6(g: number[]): IpRejection | null {
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (zeroUpTo(8)) return 'loopback'; // :: — unspecified, connects locally
  if (zeroUpTo(7) && g[7] === 1) return 'loopback'; // ::1

  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (SIIT)
  if (zeroUpTo(5) && g[5] === 0xffff) return classifyIPv4(embeddedV4(g[6]!, g[7]!));
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return classifyIPv4(embeddedV4(g[6]!, g[7]!));
  // ::a.b.c.d (deprecated IPv4-compatible) — never globally routable.
  if (zeroUpTo(6)) return classifyIPv4(embeddedV4(g[6]!, g[7]!)) ?? 'reserved_address';
  // NAT64: 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return classifyIPv4(embeddedV4(g[6]!, g[7]!));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) {
    return classifyIPv4(embeddedV4(g[6]!, g[7]!));
  }

  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return 'private_address'; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if ((first & 0xffc0) === 0xfec0) return 'private_address'; // fec0::/10 site-local
  if ((first & 0xff00) === 0xff00) return 'reserved_address'; // multicast
  // Only 2000::/3 is global unicast; everything else (100::/64 discard, …) is refused.
  if ((first & 0xe000) !== 0x2000) return 'reserved_address';

  if (first === 0x2001 && g[1] === 0x0db8) return 'reserved_address'; // documentation
  if (first === 0x2001 && g[1] === 0) return 'reserved_address'; // Teredo
  if (first === 0x2002) return classifyIPv4(embeddedV4(g[1]!, g[2]!)); // 6to4
  return null;
}

export function classifyIp(address: string): IpRejection | null {
  const withoutZone = address.split('%')[0] ?? '';
  const v4 = parseIPv4(withoutZone);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(withoutZone);
  if (v6) return classifyIPv6(v6);
  return 'reserved_address';
}
