// The key a client address is rate-limited and counted under (bead legend-6jgd2).
//
// A single IPv6 subscriber holds at least a /64, so keying on the full address
// would give one client an unlimited supply of fresh buckets. The key is:
// - IPv4: the address itself (dotted quad, unchanged);
// - IPv4-mapped IPv6 (`::ffff:a.b.c.d`, also the hex form `::ffff:7f00:1`):
//   the IPv4 address, so the same client is one bucket however Express reports it;
// - any other IPv6: the /64 prefix, written canonically (`2001:db8:0:1::/64`),
//   so every spelling of an address in the same /64 shares one key;
// - an empty or unparseable value: "unknown" for empty, otherwise the trimmed,
//   lower-cased text (never throws). Garbage text that happens to spell a
//   canonical key shares that key, which only tightens the limit.
// Env-free on purpose, so it can be used by the limiters, the edge link server
// and the identity digests alike.

import { isIPv4, isIPv6 } from "node:net";

const MAX_RAW_KEY_LENGTH = 64;

/** Expands any valid IPv6 text (zone id and embedded IPv4 included) to 8 groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!isIPv6(text)) return null;

  // An embedded IPv4 tail ("::ffff:1.2.3.4") becomes two hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [
    ...head,
    ...(halves.length === 2 ? Array<string>(missing).fill("0") : []),
    ...rest,
  ].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

export function clientIpKey(address: string | null | undefined): string {
  const raw = (address ?? "").trim();
  if (raw === "") return "unknown";
  if (isIPv4(raw)) return raw;
  const groups = ipv6Groups(raw);
  if (groups === null) return raw.toLowerCase().slice(0, MAX_RAW_KEY_LENGTH);
  // ::ffff:0:0/96 is an IPv4-mapped address: key it as the IPv4 client.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const high = groups[6]!;
    const low = groups[7]!;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}
