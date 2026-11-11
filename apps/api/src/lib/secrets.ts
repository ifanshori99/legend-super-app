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
//
// Key ring (legend-dheu): the envelope's version byte is the key version. 1 is
// the key above; versions >= 2 come from DATA_ENCRYPTION_KEYS, and
// DATA_ENCRYPTION_ACTIVE_KEY_VERSION picks the one new seals use. Old versions
// keep opening until their rows are re-sealed (rotateIntegrationCredentials).

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { env } from "../config/env";
import { parseDataEncryptionKeys } from "./data-encryption-keys";

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_CONTEXT = "legend:data-encryption:v1";

let cachedKey: Buffer | undefined;

/** Version 1 key: DATA_ENCRYPTION_KEY, or the development scrypt fallback. */
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

function sealWith(
  version: number,
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
    Buffer.from([version]),
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64");
}

/**
 * Reads the envelope, asks `keyFor` for the key of its version byte (undefined
 * means unknown version), then authenticates it against `aad`.
 */
function openWith(
  keyFor: (version: number) => Buffer | undefined,
  sealed: string,
  aad: string,
): string {
  if (!sealed) throw new TypeError("Nothing to open");
  const envelope = Buffer.from(sealed, "base64");
  if (envelope.length < 1 + NONCE_BYTES + TAG_BYTES)
    throw new Error("Sealed value is truncated");
  const version = envelope[0];
  const key = version === undefined ? undefined : keyFor(version);
  if (!key) throw new Error("Unknown sealed value version");
  if (key.length !== 32) throw new TypeError("Sealing key must be 32 bytes");
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

export type SecretRing = {
  /** Seals under the active version; the envelope's first byte is that version. */
  seal(plaintext: string, aad: string): string;
  /** Opens any envelope whose version byte is in the ring. */
  open(sealed: string, aad: string): string;
  readonly activeVersion: number;
  supports(version: number): boolean;
};

/**
 * Key ring of the data encryption key (legend-dheu). The envelope's version
 * byte is the key version: 1 is `baseKey`, versions >= 2 come from `extraKeys`.
 * `activeVersion` picks the key new seals use; every ring version can open.
 */
export function createSecretRing(options: {
  baseKey: Buffer;
  extraKeys?: ReadonlyMap<number, Buffer>;
  activeVersion?: number;
}): SecretRing {
  const { baseKey, extraKeys = new Map<number, Buffer>() } = options;
  const activeVersion = options.activeVersion ?? VERSION;
  const keyFor = (version: number): Buffer | undefined =>
    version === VERSION ? baseKey : extraKeys.get(version);
  const activeKey = keyFor(activeVersion);
  if (!activeKey) throw new Error("Active key version is not in the key ring");
  return {
    seal: (plaintext, aad) =>
      sealWith(activeVersion, activeKey, plaintext, aad),
    open: (sealed, aad) => openWith(keyFor, sealed, aad),
    activeVersion,
    supports: (version) => keyFor(version) !== undefined,
  };
}

let cachedRing: SecretRing | undefined;

/** Default ring from the environment, resolved once like `dataKey()`. */
function defaultRing(): SecretRing {
  cachedRing ??= createSecretRing({
    baseKey: dataKey(),
    extraKeys: parseDataEncryptionKeys(env.DATA_ENCRYPTION_KEYS),
    activeVersion: env.DATA_ENCRYPTION_ACTIVE_KEY_VERSION,
  });
  return cachedRing;
}

/** Seals a UTF-8 value for the row identified by `aad`, under the active key. */
export function sealSecret(plaintext: string, aad: string): string {
  return defaultRing().seal(plaintext, aad);
}

/**
 * Same envelope as `sealSecret` under an explicit 32-byte key, always written
 * as version 1 (HRIS key rotation, lib/hris-pii.ts: their key version lives in
 * a column, not in the envelope). The caller owns the key's lifetime.
 */
export function sealSecretWithKey(
  key: Buffer,
  plaintext: string,
  aad: string,
): string {
  return sealWith(VERSION, key, plaintext, aad);
}

/**
 * Seals under the version 1 key whatever the active data key version is. HRIS
 * and payroll track their own key version in a column and treat their version 1
 * as "the base data key"; a data key rotation must not move those rows.
 */
export function sealSecretBaseKey(plaintext: string, aad: string): string {
  return sealWith(VERSION, dataKey(), plaintext, aad);
}

/** Opens a sealed value; throws if the envelope or AAD does not match. */
export function openSecret(sealed: string, aad: string): string {
  return defaultRing().open(sealed, aad);
}

/** `openSecret` under an explicit 32-byte key (version 1 envelopes only). */
export function openSecretWithKey(
  key: Buffer,
  sealed: string,
  aad: string,
): string {
  if (key.length !== 32) throw new TypeError("Sealing key must be 32 bytes");
  return openWith(
    (version) => (version === VERSION ? key : undefined),
    sealed,
    aad,
  );
}

/**
 * HMAC-SHA256 blind index (hex) for uniqueness and equality lookups without
 * storing plaintext: one NPWP per legal entity inside a tenant. Always the
 * version 1 key: a blind index must stay stable across key rotations.
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

/** The envelope/key version sealSecret writes today (the ring's active version). */
export function currentSealVersion(): number {
  return defaultRing().activeVersion;
}
