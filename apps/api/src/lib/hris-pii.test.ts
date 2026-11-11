// HR-03 field encryption helper (PRD v1.7 §2 enkripsi aplikasi + blind index;
// bead legend-qe1z). Pure: no database.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HRIS_PII_KEY_VERSION,
  hrisBlindIndex,
  hrisBlindIndexCandidates,
  hrisFingerprintMatches,
  hrisRequestFingerprint,
  maskHrisPii,
  normalizeHrisPii,
  openHrisPii,
  sealHrisPii,
  type HrisPiiBinding,
} from "./hris-pii.ts";
import {
  assertHrisPiiActiveVersion,
  parseHrisPiiKeys,
} from "./hris-pii-keys.ts";
import { BLIND_INDEX_ACTIVE_VERSION, blindIndexAt } from "./blind-index.ts";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const employee1 = "33333333-3333-4333-8333-333333333333";
const employee2 = "44444444-4444-4444-8444-444444444444";
const NIK = "3273010101900001";

const binding = (overrides: Partial<HrisPiiBinding> = {}): HrisPiiBinding => ({
  tenantId: tenantA,
  table: "employees",
  rowId: employee1,
  field: "nik",
  ...overrides,
});

describe("HR-03 hris-pii sealing", () => {
  it("[HR-03] round-trips a value and never stores plaintext in the envelope", () => {
    const sealed = sealHrisPii(NIK, binding());
    expect(Buffer.isBuffer(sealed)).toBe(true);
    expect(sealed[0]).toBe(1); // envelope version byte
    expect(sealed.toString("latin1")).not.toContain(NIK);
    expect(sealed.toString("base64")).not.toContain(NIK);
    expect(openHrisPii(sealed, binding(), HRIS_PII_KEY_VERSION)).toBe(NIK);
  });

  it("[HR-03] uses a fresh nonce: equal values seal to different bytes", () => {
    expect(
      sealHrisPii(NIK, binding()).equals(sealHrisPii(NIK, binding())),
    ).toBe(false);
  });

  it("[HR-03] AAD binds tenant, row, field and key version (ciphertext cannot move)", () => {
    const sealed = sealHrisPii(NIK, binding());
    expect(() =>
      openHrisPii(sealed, binding({ rowId: employee2 }), 1),
    ).toThrow();
    expect(() =>
      openHrisPii(sealed, binding({ tenantId: tenantB }), 1),
    ).toThrow();
    expect(() => openHrisPii(sealed, binding({ field: "npwp" }), 1)).toThrow();
    expect(() =>
      openHrisPii(sealed, binding({ table: "employment_contracts" }), 1),
    ).toThrow();
    // Unknown key version fails closed.
    expect(() => openHrisPii(sealed, binding(), 2)).toThrow(
      "Unsupported HRIS PII key version",
    );
    expect(() => sealHrisPii(NIK, binding(), 7)).toThrow();
  });

  it("[HR-03] a tampered envelope fails authentication", () => {
    const sealed = sealHrisPii(NIK, binding());
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => openHrisPii(tampered, binding(), 1)).toThrow();
  });
});

describe("HR-03 blind index and normalization", () => {
  it("[HR-03] blind index is deterministic per tenant and separated across tenants and fields", () => {
    const a = hrisBlindIndex("nik", tenantA, NIK);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(hrisBlindIndex("nik", tenantA, NIK)).toBe(a);
    expect(hrisBlindIndex("nik", tenantA.toUpperCase(), NIK)).toBe(a);
    expect(hrisBlindIndex("nik", tenantB, NIK)).not.toBe(a);
    expect(hrisBlindIndex("npwp", tenantA, NIK)).not.toBe(a);
    expect(a).not.toContain(NIK);
  });

  it("[HR-03] fields without a blind index column refuse one", () => {
    expect(() =>
      hrisBlindIndex("emergencyContactName", tenantA, "Siti"),
    ).toThrow();
  });

  it("[HR-03] normalizes separators so one number has one blind index", () => {
    expect(normalizeHrisPii("nik", "3273.0101-0190 0001")).toBe(NIK);
    expect(normalizeHrisPii("npwp", "12.345.678.9-012.000")).toBe(
      "123456789012000",
    );
    expect(normalizeHrisPii("bankAccount", "123-456 7890")).toBe("1234567890");
    expect(normalizeHrisPii("emergencyContactName", "  Siti   Aminah ")).toBe(
      "Siti Aminah",
    );
    expect(normalizeHrisPii("emergencyContactPhone", "+62 812-3456-7890")).toBe(
      "+6281234567890",
    );
    expect(normalizeHrisPii("salarySnapshot", "5500000")).toBe("5500000");
  });

  it("[HR-03] rejects malformed values without echoing them", () => {
    for (const [field, value] of [
      ["nik", "32730101019000"],
      ["nik", "3273010101900001X"],
      ["npwp", "12345"],
      ["bpjsKesNo", "abc12345"],
      ["bankAccount", "12#45678"],
      ["emergencyContactPhone", "12"],
      ["salarySnapshot", "-1"],
      ["salarySnapshot", "1.5"],
    ] as const) {
      let message = "";
      try {
        normalizeHrisPii(field, value);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `${field} accepted`).not.toBe("");
      expect(message).not.toContain(value);
    }
  });

  it("[HR-03] request fingerprints are HMACs, not bare hashes of PII", () => {
    const fp = hrisRequestFingerprint(tenantA, { nik: NIK });
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(hrisRequestFingerprint(tenantB, { nik: NIK })).not.toBe(fp);
  });
});

describe("HR-03 masking", () => {
  it("[HR-03] masks to the contract rule and keeps the key version", () => {
    expect(maskHrisPii("nik", NIK, 1)).toEqual({
      masked: "****0001",
      keyVersion: 1,
    });
    expect(maskHrisPii("emergencyContactName", "Siti Aminah", 1).masked).toBe(
      "Siti A***",
    );
    expect(maskHrisPii("bankAccount", "1234567890", 1).masked).not.toContain(
      "123456",
    );
  });
});

// ---------------------------------------------------------------- rotation

const KEY2 = Buffer.alloc(32, 2).toString("base64");
const KEY3 = Buffer.alloc(32, 3).toString("base64");

describe("legend-33mj HRIS PII key ring parsing", () => {
  it("[HR-03] parses versions >= 2 with 32-byte base64 keys; empty is no extra keys", () => {
    expect(parseHrisPiiKeys(undefined).size).toBe(0);
    expect(parseHrisPiiKeys("  ").size).toBe(0);
    const ring = parseHrisPiiKeys(`2:${KEY2}, 3:${KEY3}`);
    expect([...ring.keys()]).toEqual([2, 3]);
    expect(ring.get(2)?.equals(Buffer.alloc(32, 2))).toBe(true);
  });

  it("[HR-03] rejects bad entries without echoing the key", () => {
    const bad = [
      `1:${KEY2}`, // version 1 is DATA_ENCRYPTION_KEY
      `0:${KEY2}`,
      `40000:${KEY2}`,
      `2:${KEY2},2:${KEY3}`, // duplicate
      "2:c2hvcnQ=", // too short
      `x:${KEY2}`,
      KEY2, // no version
      "2:not base64 !!",
    ];
    for (const spec of bad) {
      let message = "";
      try {
        parseHrisPiiKeys(spec);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, spec).not.toBe("");
      expect(message).not.toContain(KEY2);
    }
  });

  it("[HR-03] the active version must be 1 or in the ring", () => {
    const ring = parseHrisPiiKeys(`2:${KEY2}`);
    expect(() => assertHrisPiiActiveVersion(1, ring)).not.toThrow();
    expect(() => assertHrisPiiActiveVersion(2, ring)).not.toThrow();
    expect(() => assertHrisPiiActiveVersion(3, ring)).toThrow();
    expect(() => assertHrisPiiActiveVersion(0, ring)).toThrow();
  });
});

describe("legend-33mj HRIS PII after rotation to version 2", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function rotated() {
    vi.resetModules();
    vi.stubEnv("HRIS_PII_KEYS", `2:${KEY2}`);
    vi.stubEnv("HRIS_PII_ACTIVE_KEY_VERSION", "2");
    return import("./hris-pii.ts");
  }

  it("[HR-03] writes with the active version and still opens version 1 data", async () => {
    const before = sealHrisPii(NIK, binding(), 1);
    const pii = await rotated();
    expect(pii.HRIS_PII_KEY_VERSION).toBe(2);
    // Old data stays readable under its own version.
    expect(pii.openHrisPii(before, binding(), 1)).toBe(NIK);
    // New seals default to version 2 and open only as version 2.
    const sealed = pii.sealHrisPii(NIK, binding());
    expect(pii.openHrisPii(sealed, binding(), 2)).toBe(NIK);
    expect(() => pii.openHrisPii(sealed, binding(), 1)).toThrow();
    // A v1 envelope claimed as v2 fails closed (different key and AAD).
    expect(() => pii.openHrisPii(before, binding(), 2)).toThrow();
    // Version 1 can still be written explicitly (re-seal job reads old only).
    expect(
      pii.openHrisPii(pii.sealHrisPii(NIK, binding(), 1), binding(), 1),
    ).toBe(NIK);
  });

  it("[HR-03] a version outside the ring fails closed", async () => {
    const pii = await rotated();
    const sealed = pii.sealHrisPii(NIK, binding());
    expect(() => pii.openHrisPii(sealed, binding(), 3)).toThrow(
      "Unsupported HRIS PII key version",
    );
    expect(() => pii.sealHrisPii(NIK, binding(), 3)).toThrow(
      "Unsupported HRIS PII key version",
    );
  });

  it("[HR-03] the blind index does not rotate: lookups stay valid", async () => {
    const before = hrisBlindIndex("nik", tenantA, NIK);
    const pii = await rotated();
    expect(pii.hrisBlindIndex("nik", tenantA, NIK)).toBe(before);
  });

  it("[legend-n039] the blind index is independent of the PII ring (v2 stable across ring rotation)", async () => {
    const before = hrisBlindIndex("nik", tenantA, NIK, 2);
    const beforeDefault = hrisBlindIndex("nik", tenantA, NIK);
    const pii = await rotated();
    expect(pii.hrisBlindIndex("nik", tenantA, NIK, 2)).toBe(before);
    expect(pii.hrisBlindIndex("nik", tenantA, NIK)).toBe(beforeDefault);
  });

  it("[HR-03] a wrong key for the version does not open another ring's data", async () => {
    const pii = await rotated();
    const sealed = pii.sealHrisPii(NIK, binding());
    vi.resetModules();
    vi.stubEnv("HRIS_PII_KEYS", `2:${KEY3}`);
    vi.stubEnv("HRIS_PII_ACTIVE_KEY_VERSION", "2");
    const other = await import("./hris-pii.ts");
    expect(() => other.openHrisPii(sealed, binding(), 2)).toThrow();
  });
});

describe("legend-n039 HRIS blind index versions", () => {
  it("defaults to the active version (1 until BLIND_INDEX_ACTIVE_VERSION=2, 488-6), different from the other digest", () => {
    const v1 = hrisBlindIndex("nik", tenantA, NIK, 1);
    const v2 = hrisBlindIndex("nik", tenantA, NIK, 2);
    expect(v1).not.toBe(v2);
    expect(hrisBlindIndex("nik", tenantA, NIK)).toBe(
      BLIND_INDEX_ACTIVE_VERSION === 2 ? v2 : v1,
    );
  });

  it("v1 equals the legacy purpose-framed HMAC (existing rows stay findable)", async () => {
    const { blindIndex } = await import("./secrets.ts");
    expect(hrisBlindIndex("nik", tenantA, NIK, 1)).toBe(
      blindIndex(NIK, `hris:nik:${tenantA}`),
    );
  });

  it("separates tenants and fields in every version", () => {
    for (const version of [1, 2] as const) {
      expect(hrisBlindIndex("nik", tenantA, NIK, version)).not.toBe(
        hrisBlindIndex("nik", tenantB, NIK, version),
      );
      expect(hrisBlindIndex("nik", tenantA, NIK, version)).not.toBe(
        hrisBlindIndex("npwp", tenantA, NIK, version),
      );
    }
  });

  it("candidates cover both versions and include the active digest", () => {
    const candidates = hrisBlindIndexCandidates("nik", tenantA, NIK);
    expect(candidates.map((c) => c.version).sort()).toEqual([1, 2]);
    expect(candidates.map((c) => c.digest)).toContain(
      hrisBlindIndex("nik", tenantA, NIK),
    );
    expect(candidates.map((c) => c.digest)).toContain(
      hrisBlindIndex("nik", tenantA, NIK, 1),
    );
  });

  it("a field without a blind index still throws", () => {
    expect(() =>
      hrisBlindIndex("emergencyContactName", tenantA, "Budi"),
    ).toThrow(TypeError);
  });

  it("fingerprint: new fingerprints use the active version", () => {
    const request = { operation: "x", request: { a: 1 } };
    const fingerprint = hrisRequestFingerprint(tenantA, request);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(hrisFingerprintMatches(tenantA, request, fingerprint)).toBe(true);
  });

  it("fingerprint: a stored fingerprint of the other version still matches the same request after cutover", async () => {
    const request = { operation: "x", request: { a: 1 } };
    const stored = blindIndexAt(
      BLIND_INDEX_ACTIVE_VERSION === 1 ? 2 : 1,
      JSON.stringify(request),
      `hris:idempotency:${tenantA}`,
    );
    expect(stored).not.toBe(hrisRequestFingerprint(tenantA, request));
    expect(hrisFingerprintMatches(tenantA, request, stored)).toBe(true);
  });

  it("fingerprint: a different request, another tenant or garbage never matches", async () => {
    const { blindIndex } = await import("./secrets.ts");
    const request = { operation: "x", request: { a: 1 } };
    const v1 = blindIndex(
      JSON.stringify(request),
      `hris:idempotency:${tenantA}`,
    );
    const v2 = hrisRequestFingerprint(tenantA, request);
    for (const stored of [v1, v2]) {
      expect(
        hrisFingerprintMatches(
          tenantA,
          { operation: "x", request: { a: 2 } },
          stored,
        ),
      ).toBe(false);
      expect(hrisFingerprintMatches(tenantB, request, stored)).toBe(false);
    }
    expect(hrisFingerprintMatches(tenantA, request, "")).toBe(false);
    expect(hrisFingerprintMatches(tenantA, request, "zz")).toBe(false);
    expect(hrisFingerprintMatches(tenantA, request, "0".repeat(64))).toBe(
      false,
    );
  });
});
