// legend-n039: dedicated, versioned blind-index key. Pure: no database.
// v1 = legacy HMAC under the raw data key (kept byte-identical so no stored
// digest is locked out); v2 = HKDF subkey of the data key, separate from the
// raw key and from the identity-digest key.
import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Config reads the environment when it loads, before the imports below run.
const DATA_KEY = vi.hoisted(() => {
  const key = Buffer.alloc(32, 7);
  process.env.DATA_ENCRYPTION_KEY = key.toString("base64");
  delete process.env.BLIND_INDEX_ACTIVE_VERSION;
  return key;
});

import {
  BLIND_INDEX_ACTIVE_VERSION,
  BLIND_INDEX_VERSIONS,
  blindIndexAt,
  blindIndexCandidates,
} from "./blind-index.ts";
import { blindIndex, deriveDataSubkey } from "./secrets.ts";

const VALUE = "3273010101900001";
const purposeA = "hris:nik:11111111-1111-4111-8111-111111111111";
const purposeB = "hris:nik:22222222-2222-4222-8222-222222222222";

const hmacHex = (key: Buffer, purpose: string, value: string) =>
  createHmac("sha256", key)
    .update(`${purpose}\u0000${value}`, "utf8")
    .digest("hex");

describe("legend-n039 blind index versions", () => {
  it("supports versions 1 and 2, and defaults to 2", () => {
    expect([...BLIND_INDEX_VERSIONS]).toEqual([1, 2]);
    expect(BLIND_INDEX_ACTIVE_VERSION).toBe(2);
  });

  it("v1 is byte-identical to the legacy secrets.blindIndex (no lockout)", () => {
    expect(blindIndexAt(1, VALUE, purposeA)).toBe(blindIndex(VALUE, purposeA));
    expect(blindIndexAt(1, VALUE, purposeA)).toBe(
      hmacHex(DATA_KEY, purposeA, VALUE),
    );
  });

  it("v2 is HMAC under the HKDF subkey for blind-index v2, same framing", () => {
    const subkey = Buffer.from(
      hkdfSync("sha256", DATA_KEY, "legend", "legend:blind-index:v2", 32),
    );
    expect(blindIndexAt(2, VALUE, purposeA)).toBe(
      hmacHex(subkey, purposeA, VALUE),
    );
    expect(blindIndexAt(2, VALUE, purposeA)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("v2 differs from v1 and is deterministic", () => {
    const v2 = blindIndexAt(2, VALUE, purposeA);
    expect(v2).not.toBe(blindIndexAt(1, VALUE, purposeA));
    expect(blindIndexAt(2, VALUE, purposeA)).toBe(v2);
  });

  it("v2 key is neither the raw data key nor the identity-digest key", () => {
    const key = deriveDataSubkey("legend:blind-index:v2");
    expect(key.length).toBe(32);
    expect(key.equals(DATA_KEY)).toBe(false);
    // v1 is the legacy digest under the raw data key, which is not exported.
    expect(blindIndexAt(1, VALUE, purposeA)).toBe(blindIndex(VALUE, purposeA));
    const identity = Buffer.from(
      hkdfSync(
        "sha256",
        process.env.BETTER_AUTH_SECRET ?? "fallback-secret",
        "legend",
        "legend:identity-login-digest:v1",
        32,
      ),
    );
    expect(key.equals(identity)).toBe(false);
  });

  it("separates purposes: same value for another tenant gives another digest", () => {
    expect(blindIndexAt(2, VALUE, purposeA)).not.toBe(
      blindIndexAt(2, VALUE, purposeB),
    );
    expect(blindIndexAt(1, VALUE, purposeA)).not.toBe(
      blindIndexAt(1, VALUE, purposeB),
    );
  });

  it("separates values under one purpose", () => {
    expect(blindIndexAt(2, VALUE, purposeA)).not.toBe(
      blindIndexAt(2, `${VALUE}0`, purposeA),
    );
  });

  it("candidates list every supported version, each matching blindIndexAt", () => {
    const candidates = blindIndexCandidates(VALUE, purposeA);
    expect(candidates.map((c) => c.version).sort()).toEqual([1, 2]);
    for (const { version, digest } of candidates)
      expect(digest).toBe(blindIndexAt(version, VALUE, purposeA));
  });

  it("deriveDataSubkey is domain-separated by info and stable", () => {
    const a = deriveDataSubkey("legend:blind-index:v2");
    expect(deriveDataSubkey("legend:blind-index:v2").equals(a)).toBe(true);
    expect(deriveDataSubkey("legend:other").equals(a)).toBe(false);
    expect(blindIndexAt(2, VALUE, purposeA)).toBe(hmacHex(a, purposeA, VALUE));
  });

  it("rejects an unsupported version instead of falling back", () => {
    expect(() => blindIndexAt(3 as never, VALUE, purposeA)).toThrow();
    expect(() => blindIndexAt(0 as never, VALUE, purposeA)).toThrow();
  });
});

describe("legend-n039 active version rollback lever", () => {
  it("BLIND_INDEX_ACTIVE_VERSION=1 makes v1 the active version", async () => {
    vi.resetModules();
    vi.stubEnv("BLIND_INDEX_ACTIVE_VERSION", "1");
    try {
      const mod = await import("./blind-index.ts");
      expect(mod.BLIND_INDEX_ACTIVE_VERSION).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("rejects an unknown active version at startup", async () => {
    vi.resetModules();
    vi.stubEnv("BLIND_INDEX_ACTIVE_VERSION", "3");
    try {
      await expect(import("./blind-index.ts")).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
