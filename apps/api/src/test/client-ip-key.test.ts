// Rate-limit key of a client address (bead legend-6jgd2). Pure unit tests, no
// database and no HTTP.
//
// Contract under test: IPv4 stays as is; an IPv4-mapped IPv6 address keys as
// its IPv4; any other IPv6 address keys as its canonical /64
// (`2001:db8:0:1::/64`); an empty value is "unknown"; garbage never throws and
// keys as its trimmed, lower-cased text (at most 64 characters), so it can
// never collide with a shared IPv6 /64 key.
//
// Assumption: the exact canonical spelling is only asserted where the brief
// fixes it (`2001:db8:0:1::/64`); elsewhere cases compare keys with each other.

import { describe, expect, it } from "vitest";
import { clientIpKey } from "../lib/client-ip-key";

const V6_PREFIX_KEY = /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::\/64$/;

describe("clientIpKey: IPv4", () => {
  it.each(["1.2.3.4", "203.0.113.45", "127.0.0.1", "255.255.255.255"])(
    "keeps %s unchanged",
    (address) => {
      expect(clientIpKey(address)).toBe(address);
    },
  );

  it("trims surrounding whitespace", () => {
    expect(clientIpKey("  1.2.3.4 ")).toBe("1.2.3.4");
  });

  it("keeps different IPv4 addresses apart", () => {
    expect(clientIpKey("1.2.3.4")).not.toBe(clientIpKey("1.2.3.5"));
  });
});

describe("clientIpKey: IPv6 /64", () => {
  it("writes the /64 canonically", () => {
    expect(clientIpKey("2001:db8:0:1:aaaa:bbbb:cccc:dddd")).toBe(
      "2001:db8:0:1::/64",
    );
    expect(clientIpKey("2001:db8:0:1::1")).toBe("2001:db8:0:1::/64");
  });

  it("gives every spelling of addresses in one /64 the same key", () => {
    const sameSlash64 = [
      "2001:db8:0:1:aaaa:bbbb:cccc:dddd", // full
      "2001:db8:0:1::1", // compressed
      "2001:DB8:0:1::FFFF", // uppercase
      "2001:0db8:0000:0001:0000:0000:0000:0002", // zero padded
      "2001:db8:0:1:0:0:0:3", // partly compressed
      "2001:db8:0:1::1%eth0", // with a zone id
      "2001:db8:0:1:ffff:ffff:ffff:ffff", // last address of the /64
      "2001:db8:0:1::", // first address of the /64
    ];
    const keys = new Set(sameSlash64.map((a) => clientIpKey(a)));
    expect([...keys]).toEqual(["2001:db8:0:1::/64"]);
  });

  it("gives different /64 prefixes different keys", () => {
    const keys = [
      "2001:db8:0:1::1",
      "2001:db8:0:2::1",
      "2001:db8:1:1::1",
      "2001:db9:0:1::1",
      "2002:db8:0:1::1",
    ].map((a) => clientIpKey(a));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(V6_PREFIX_KEY);
  });

  it("does not look at the interface identifier (the low 64 bits)", () => {
    expect(clientIpKey("2001:db8::1")).toBe(
      clientIpKey("2001:db8:0:0:ffff::1"),
    );
  });

  it("handles the loopback and the unspecified address", () => {
    expect(clientIpKey("::1")).toMatch(V6_PREFIX_KEY);
    expect(clientIpKey("::")).toMatch(V6_PREFIX_KEY);
    // Both sit in ::/64, so they share one key.
    expect(clientIpKey("::1")).toBe(clientIpKey("::"));
  });

  it("keeps a link-local address with a zone id on its /64", () => {
    expect(clientIpKey("fe80::1%eth0")).toBe(clientIpKey("fe80::abcd"));
    expect(clientIpKey("fe80::1%eth0")).toMatch(V6_PREFIX_KEY);
  });
});

describe("clientIpKey: IPv4-mapped IPv6", () => {
  it.each([
    "::ffff:1.2.3.4",
    "::FFFF:1.2.3.4",
    "::ffff:102:304",
    "0:0:0:0:0:ffff:102:304",
    "0000:0000:0000:0000:0000:ffff:0102:0304",
    "::ffff:1.2.3.4%eth0",
  ])("keys %s as the IPv4 client 1.2.3.4", (address) => {
    expect(clientIpKey(address)).toBe("1.2.3.4");
  });

  it("maps the hex form of loopback to 127.0.0.1", () => {
    expect(clientIpKey("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(clientIpKey("::ffff:7f00:1")).toBe(clientIpKey("127.0.0.1"));
  });

  it("does not map the deprecated IPv4-compatible form ::a.b.c.d", () => {
    const key = clientIpKey("::1.2.3.4");
    expect(key).not.toBe("1.2.3.4");
    expect(key).toMatch(V6_PREFIX_KEY);
  });

  it("does not map the NAT64 prefix 64:ff9b::/96", () => {
    const key = clientIpKey("64:ff9b::1.2.3.4");
    expect(key).not.toBe("1.2.3.4");
    expect(key).toMatch(V6_PREFIX_KEY);
    expect(key).toBe(clientIpKey("64:ff9b::5.6.7.8"));
  });
});

describe("clientIpKey: empty and invalid input", () => {
  it.each([["" as string | null | undefined], ["   "], [null], [undefined]])(
    "returns unknown for %j",
    (value) => {
      expect(clientIpKey(value)).toBe("unknown");
    },
  );

  it.each([
    "not-an-ip",
    "1.2.3",
    "1:2:3",
    ":::",
    "12345::",
    "1.2.3.4.5",
    "256.1.1.1",
    "2001:db8::1::2",
    "x".repeat(300),
    "2001:db8:0:1::1/64",
  ])("never throws on %j and returns a stable, non-/64 key", (garbage) => {
    const key = clientIpKey(garbage);
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
    expect(key.length).toBeLessThanOrEqual(64);
    expect(clientIpKey(garbage)).toBe(key);
    expect(key).not.toBe("unknown");
    // Never one of the shared IPv6 /64 keys.
    expect(key).not.toMatch(V6_PREFIX_KEY);
  });

  it("keys garbage by its trimmed, lower-cased text", () => {
    expect(clientIpKey("  NOT-An-IP ")).toBe("not-an-ip");
  });

  it("does not merge distinct garbage into one key", () => {
    expect(clientIpKey("not-an-ip")).not.toBe(clientIpKey("also-not-an-ip"));
  });

  it("truncates 300-character garbage to at most 64 characters", () => {
    expect(clientIpKey("y".repeat(300)).length).toBeLessThanOrEqual(64);
  });
});
