// Rate-limit subject for a client address (copied from apps/api/src/ip.ts, so an IP is limited alike by both Workers).
// An IPv6 host usually controls at least a /64 (2^64 addresses), so limiting per full IPv6 address is trivially
// bypassed: IPv6 is keyed on its /64 prefix, IPv4 on the full address.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function ipv4(raw: string): string | null {
  const m = IPV4_RE.exec(raw);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((p) => p <= 255) ? parts.join('.') : null;
}

/** The 8 hextets of an IPv6 address (handles `::` and a trailing dotted IPv4), or null. */
function ipv6Hextets(raw: string): number[] | null {
  let s = raw.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    // Trailing dotted IPv4 (e.g. ::ffff:1.2.3.4): rewrite as two hextets.
    const v4 = ipv4(s.slice(lastColon + 1));
    if (!v4) return null;
    const b = v4.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string | undefined): number[] | null => {
    if (!h) return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/u.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length;
  if (halves.length === 2) return known > 7 ? null : [...head, ...Array<number>(8 - known).fill(0), ...rest];
  return known === 8 ? head : null;
}

/** `v4:<address>` for IPv4 (and IPv4-mapped IPv6), `v6:<first 4 hextets>::/64` for IPv6, else `other:<raw>`. */
export function ipSubject(raw: string | null): string {
  if (!raw) return 'other:unknown';
  const v4 = ipv4(raw.trim());
  if (v4) return `v4:${v4}`;
  const h = ipv6Hextets(raw.trim());
  if (!h) return `other:${raw.trim().slice(0, 64)}`;
  // IPv4-mapped (::ffff:a.b.c.d): the IPv4 address.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return `v4:${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
  return `v6:${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
