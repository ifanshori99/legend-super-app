// DATA_ENCRYPTION key ring (bead legend-dheu, PAY-06 "kredensial integrasi
// tersegel, kunci dapat dirotasi"). The envelope version byte of
// lib/secrets.ts is the key version: version 1 is the base key
// (DATA_ENCRYPTION_KEY), versions 2..255 come from DATA_ENCRYPTION_KEYS.
//
// Written from the brief (docs of the bundle), before the implementation:
//   - createSecretRing({ baseKey, extraKeys, activeVersion })
//       -> { seal(plaintext, aad), open(sealed, aad), activeVersion,
//            supports(version) }
//   - parseDataEncryptionKeys(raw) and assertDataEncryptionActiveVersion(...)
//     in lib/data-encryption-keys.ts, DATA_ENCRYPTION_MAX_KEY_VERSION = 255.
//
// Assumptions (the brief does not pin them down):
//   - baseKey is a 32-byte Buffer; extraKeys is whatever
//     parseDataEncryptionKeys returns (it is passed through untouched here).
//   - parseDataEncryptionKeys("") means "no extra keys" and does not throw.
//   - assertDataEncryptionActiveVersion(activeVersion, extraKeys) throws when
//     the active version is neither 1 nor a registered version.
//   - Error messages never contain key material (checked by looking for the
//     base64 key text in the message).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DATA_ENCRYPTION_MAX_KEY_VERSION,
  assertDataEncryptionActiveVersion,
  parseDataEncryptionKeys,
} from "../lib/data-encryption-keys.ts";
import { createSecretRing, sealedVersion } from "../lib/secrets.ts";

const AAD = "tenant_integrations:tenant-1:row-1";
const PLAINTEXT = "doit-merchant-secret-0123456789";

const baseKey = randomBytes(32);
const key2 = randomBytes(32).toString("base64");
const key3 = randomBytes(32).toString("base64");

const keys23 = parseDataEncryptionKeys(`2:${key2},3:${key3}`);
const keys2 = parseDataEncryptionKeys(`2:${key2}`);
const noExtraKeys = parseDataEncryptionKeys("");

const ringV1 = createSecretRing({
  baseKey,
  extraKeys: noExtraKeys,
  activeVersion: 1,
});
const ringV2 = createSecretRing({
  baseKey,
  extraKeys: keys2,
  activeVersion: 2,
});

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

describe("PAY-06 secret key ring: seal and open", () => {
  it("PAY-06 a ring with version 1 active writes envelope version 1 and opens it again", () => {
    const sealed = ringV1.seal(PLAINTEXT, AAD);
    expect(ringV1.activeVersion).toBe(1);
    expect(sealedVersion(sealed)).toBe(1);
    expect(ringV1.open(sealed, AAD)).toBe(PLAINTEXT);
    expect(sealed).not.toContain(PLAINTEXT);
  });

  it("PAY-06 a value sealed under version 1 still opens in a ring whose active version is 2 (previous-key fallback)", () => {
    const old = ringV1.seal(PLAINTEXT, AAD);
    expect(ringV2.activeVersion).toBe(2);
    expect(ringV2.open(old, AAD)).toBe(PLAINTEXT);
  });

  it("PAY-06 a ring with version 2 active writes envelope version 2 (the first envelope byte is the key version)", () => {
    const sealed = ringV2.seal(PLAINTEXT, AAD);
    expect(sealedVersion(sealed)).toBe(2);
    expect(ringV2.open(sealed, AAD)).toBe(PLAINTEXT);
    // The same plaintext sealed twice differs (fresh nonce).
    expect(ringV2.seal(PLAINTEXT, AAD)).not.toBe(sealed);
  });

  it("PAY-06 each registered version seals and opens in a ring that holds all of them", () => {
    const ring3 = createSecretRing({
      baseKey,
      extraKeys: keys23,
      activeVersion: 3,
    });
    const sealed3 = ring3.seal(PLAINTEXT, AAD);
    expect(sealedVersion(sealed3)).toBe(3);
    expect(ring3.open(sealed3, AAD)).toBe(PLAINTEXT);
    expect(ring3.open(ringV2.seal(PLAINTEXT, AAD), AAD)).toBe(PLAINTEXT);
    expect(ring3.open(ringV1.seal(PLAINTEXT, AAD), AAD)).toBe(PLAINTEXT);
  });

  it("PAY-06 a ring without version 2 cannot open a version 2 value", () => {
    const sealed = ringV2.seal(PLAINTEXT, AAD);
    expect(ringV1.supports(2)).toBe(false);
    expect(ringV2.supports(1)).toBe(true);
    expect(ringV2.supports(2)).toBe(true);
    expect(ringV2.supports(3)).toBe(false);
    expect(() => ringV1.open(sealed, AAD)).toThrow();
  });

  it("PAY-06 a ring whose version 2 key differs does not open the value (wrong key, same version)", () => {
    const otherRing2 = createSecretRing({
      baseKey,
      extraKeys: parseDataEncryptionKeys(
        `2:${randomBytes(32).toString("base64")}`,
      ),
      activeVersion: 2,
    });
    expect(() => otherRing2.open(ringV2.seal(PLAINTEXT, AAD), AAD)).toThrow();
  });

  it("PAY-06 a different AAD does not open the value (blob bound to its row)", () => {
    for (const ring of [ringV1, ringV2]) {
      const sealed = ring.seal(PLAINTEXT, AAD);
      expect(() =>
        ring.open(sealed, "tenant_integrations:tenant-1:row-2"),
      ).toThrow();
    }
  });

  it("PAY-06 an unknown envelope version fails with the existing message", () => {
    const sealed = ringV1.seal(PLAINTEXT, AAD);
    const bytes = Buffer.from(sealed, "base64");
    bytes[0] = 77;
    const forged = bytes.toString("base64");
    expect(() => ringV2.open(forged, AAD)).toThrow(
      "Unknown sealed value version",
    );
  });

  // Brief 466 item 1 (two-stage rotation guard): a process whose ring does not
  // know the envelope version must say why, so an operator who activated a key
  // before rolling it out to every process sees the cause. The message names the
  // version and the key ring, and never carries key material.
  it("PAY-06 a ring that only knows version 1 opens a version 2 envelope with a message that names the version and the key ring, without key material", () => {
    const sealed = ringV2.seal(PLAINTEXT, AAD);
    expect(sealedVersion(sealed)).toBe(2);
    const message = messageOf(() => ringV1.open(sealed, AAD));
    expect(message).toContain("Unknown sealed value version 2");
    expect(message).toContain("key ring");
    for (const material of [
      key2,
      key3,
      baseKey.toString("base64"),
      baseKey.toString("hex"),
      sealed,
      PLAINTEXT,
    ]) {
      expect(message).not.toContain(material);
    }
  });

  it("PAY-06 a tampered ciphertext does not open", () => {
    const sealed = ringV2.seal(PLAINTEXT, AAD);
    const bytes = Buffer.from(sealed, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    expect(() => ringV2.open(bytes.toString("base64"), AAD)).toThrow();
  });

  it("PAY-06 a ring cannot be built with an active version that is not registered", () => {
    expect(() =>
      createSecretRing({ baseKey, extraKeys: keys2, activeVersion: 3 }),
    ).toThrow();
    expect(() =>
      createSecretRing({ baseKey, extraKeys: noExtraKeys, activeVersion: 2 }),
    ).toThrow();
  });
});

describe("PAY-06 DATA_ENCRYPTION_KEYS parser", () => {
  it("PAY-06 accepts versions 2 and above up to the single-byte maximum", () => {
    expect(DATA_ENCRYPTION_MAX_KEY_VERSION).toBe(255);
    const ring = createSecretRing({
      baseKey,
      extraKeys: parseDataEncryptionKeys(`255:${key2}`),
      activeVersion: 255,
    });
    expect(ring.supports(255)).toBe(true);
    expect(sealedVersion(ring.seal(PLAINTEXT, AAD))).toBe(255);
  });

  it("PAY-06 takes several comma separated entries and tolerates spaces around them", () => {
    const parsed = parseDataEncryptionKeys(` 2:${key2} , 3:${key3} `);
    const ring = createSecretRing({
      baseKey,
      extraKeys: parsed,
      activeVersion: 3,
    });
    expect(ring.supports(2)).toBe(true);
    expect(ring.supports(3)).toBe(true);
  });

  it("PAY-06 an empty value means no extra keys", () => {
    expect(
      createSecretRing({
        baseKey,
        extraKeys: noExtraKeys,
        activeVersion: 1,
      }).supports(2),
    ).toBe(false);
  });

  it("PAY-06 refuses version 1 (the base key owns it) without printing key material", () => {
    const message = messageOf(() => parseDataEncryptionKeys(`1:${key2}`));
    expect(message).not.toContain(key2);
  });

  it("PAY-06 refuses a duplicate version without printing key material", () => {
    const message = messageOf(() =>
      parseDataEncryptionKeys(`2:${key2},2:${key3}`),
    );
    expect(message).not.toContain(key2);
    expect(message).not.toContain(key3);
  });

  it("PAY-06 refuses a key that is not 32 bytes without printing key material", () => {
    const short = randomBytes(16).toString("base64");
    const long = randomBytes(48).toString("base64");
    expect(
      messageOf(() => parseDataEncryptionKeys(`2:${short}`)),
    ).not.toContain(short);
    expect(messageOf(() => parseDataEncryptionKeys(`2:${long}`))).not.toContain(
      long,
    );
  });

  it("PAY-06 refuses version 256 (does not fit the one-byte envelope), 0 and non-numeric versions", () => {
    expect(() => parseDataEncryptionKeys(`256:${key2}`)).toThrow();
    expect(() => parseDataEncryptionKeys(`0:${key2}`)).toThrow();
    expect(() => parseDataEncryptionKeys(`-2:${key2}`)).toThrow();
    expect(() => parseDataEncryptionKeys(`x:${key2}`)).toThrow();
    expect(() => parseDataEncryptionKeys(`2.5:${key2}`)).toThrow();
  });

  it("PAY-06 refuses an entry without a version or without a key", () => {
    expect(() => parseDataEncryptionKeys(key2)).toThrow();
    expect(() => parseDataEncryptionKeys("2:")).toThrow();
  });
});

describe("PAY-06 active key version check", () => {
  it("PAY-06 version 1 is always allowed, a registered version is allowed", () => {
    expect(() =>
      assertDataEncryptionActiveVersion(1, noExtraKeys),
    ).not.toThrow();
    expect(() => assertDataEncryptionActiveVersion(1, keys23)).not.toThrow();
    expect(() => assertDataEncryptionActiveVersion(2, keys23)).not.toThrow();
    expect(() => assertDataEncryptionActiveVersion(3, keys23)).not.toThrow();
  });

  it("PAY-06 an unregistered active version is refused", () => {
    expect(() => assertDataEncryptionActiveVersion(2, noExtraKeys)).toThrow();
    expect(() => assertDataEncryptionActiveVersion(4, keys23)).toThrow();
    expect(() => assertDataEncryptionActiveVersion(0, keys23)).toThrow();
  });
});
