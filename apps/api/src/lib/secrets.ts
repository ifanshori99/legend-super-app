// Sealing for write-only personal/credential data (integration credentials,
// legal-entity NPWP). PRD §3 F4: integration credentials are encrypted per
// tenant/outlet and stored as a secret reference; NPWP is stored encrypted and
// read back as four digits only.
//
// AES-256-GCM with a random 96-bit nonce. The envelope is
// base64(version | nonce | tag | ciphertext) so the column stays text and the
// format can evolve. AAD binds a blob to the row that owns it, so a sealed
// value copied to another tenant row fails to open.
//
// Key material: DATA_ENCRYPTION_KEY (base64, 32 bytes) in any real deployment.
// Until it is provisioned, a domain-separated scrypt of BETTER_AUTH_SECRET is
// used so local development and the disposable test database work; production
// should set a dedicated key.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { env } from "../config/env";

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_CONTEXT = "legend:data-encryption:v1";

let cachedKey: Buffer | undefined;

function dataKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (env.DATA_ENCRYPTION_KEY) {
    const key = Buffer.from(env.DATA_ENCRYPTION_KEY, "base64");
    if (key.length !== 32)
      throw new Error("DATA_ENCRYPTION_KEY must be 32 base64-encoded bytes.");
    cachedKey = key;
  } else if (env.isProduction) {
    throw new Error("DATA_ENCRYPTION_KEY is required in production.");
  } else {
    cachedKey = scryptSync(env.BETTER_AUTH_SECRET, KEY_CONTEXT, 32);
  }
  return cachedKey;
}

/** Seals a UTF-8 value for the row identified by `aad`. */
export function sealSecret(plaintext: string, aad: string): string {
  return sealSecretWithKey(dataKey(), plaintext, aad);
}

/**
 * Same envelope as `sealSecret` under an explicit 32-byte key (HRIS PII key
 * rotation, lib/hris-pii.ts). The caller owns the key's lifetime.
 */
export function sealSecretWithKey(
  key: Buffer,
  plaintext: string,
  aad: string,
): string {
  if (!aad) throw new TypeError("Sealed data needs an AAD");
  if (key.length !== 32) throw new TypeError("Sealing key must be 32 bytes");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([VERSION]),
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64");
}

/** Opens a sealed value; throws if the envelope or AAD does not match. */
export function openSecret(sealed: string, aad: string): string {
  return openSecretWithKey(dataKey(), sealed, aad);
}

/** `openSecret` under an explicit 32-byte key. */
export function openSecretWithKey(
  key: Buffer,
  sealed: string,
  aad: string,
): string {
  if (!sealed) throw new TypeError("Nothing to open");
  if (key.length !== 32) throw new TypeError("Sealing key must be 32 bytes");
  const envelope = Buffer.from(sealed, "base64");
  if (envelope.length < 1 + NONCE_BYTES + TAG_BYTES)
    throw new Error("Sealed value is truncated");
  const version = envelope[0];
  if (version !== VERSION) throw new Error("Unknown sealed value version");
  const nonce = envelope.subarray(1, 1 + NONCE_BYTES);
  const tag = envelope.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(1 + NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

const subkeys = new Map<string, Buffer>();

/**
 * HKDF-SHA256 subkey of the data key for one purpose (`info`), so a key that
 * indexes values is never the key that seals them (legend-n039,
 * lib/blind-index.ts). Cached per `info`; the caller must not mutate it.
 */
export function deriveDataSubkey(info: string): Buffer {
  if (!info) throw new TypeError("A subkey needs an info label");
  let key = subkeys.get(info);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", dataKey(), "legend", info, 32));
    subkeys.set(info, key);
  }
  return key;
}

/**
 * HMAC-SHA256 blind index (hex) for uniqueness and equality lookups without
 * storing plaintext: one NPWP per legal entity inside a tenant.
 *
 * Legacy "version 1" blind index, keyed with the raw data key. New code goes
 * through lib/blind-index.ts, which keeps this digest byte-identical as v1.
 */
export function blindIndex(value: string, purpose: string): string {
  return createHmac("sha256", dataKey())
    .update(`${purpose}\u0000${value}`, "utf8")
    .digest("hex");
}

/** Opaque `sec_…` pointer handed out on reads (secretRefSchema). */
export function newSecretRef(): string {
  return `sec_${randomBytes(24).toString("base64url")}`;
}

/** Leading version byte of a sealed envelope (for key rotation). */
export function sealedVersion(sealed: string): number {
  const version = Buffer.from(sealed, "base64")[0];
  if (version === undefined) throw new Error("Sealed value is empty");
  return version;
}

let currentVersion: number | undefined;
/** The envelope/key version sealSecret writes today, read from a probe seal. */
export function currentSealVersion(): number {
  currentVersion ??= sealedVersion(sealSecret("probe", "seal-version-probe"));
  return currentVersion;
}
