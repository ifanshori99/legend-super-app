// LSS1 sealed selfie (design docs/design/hris-edge-replication.md section 5).
// The edge seals with a cloud public key and can never open its own files; the
// cloud receiver (legend-0wvoz, C6) uses `readLss1Header` and `openSelfie` from
// here, so both sides share one byte layout:
//
//   "LSS1" | u32 headerLen | header (JSON) | u16 wrappedKeyLen | wrappedKey
//          | iv(12) | ciphertext | tag(16)
//   plaintext = u32 metaLen | meta (JSON) | webp
//   AAD       = "LSS1" | u32 headerLen | header
//
// A fresh AES-256-GCM key per file, wrapped with RSA-OAEP (SHA-256). Node
// `crypto` only. Nothing here logs, and no input is written to disk.
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { z } from "@starter/shared/core";
import {
  EDGE_SELFIE_ALG,
  LSS1_MAGIC,
  lss1HeaderSchema,
  lss1MetaSchema,
  type Lss1Header,
  type Lss1Meta,
} from "@starter/shared/edge";

export const SELFIE_SEAL_MIN_RSA_BITS = 3072;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AES_KEY_BYTES = 32;
const MAGIC = Buffer.from(LSS1_MAGIC, "ascii");
const MAX_HEADER_BYTES = 4096;
const MAX_META_BYTES = 4096;

export class SelfieSealError extends Error {
  constructor(
    readonly code: "BAD_FORMAT" | "BAD_KEY" | "AUTH_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SelfieSealError";
  }
}

export interface SealInput {
  kid: string;
  publicKeyPem: string;
  /** Header fields (plaintext, routing only). */
  tenantId: string;
  objectId: string;
  /** Who, where, when: encrypted. Validated against `lss1MetaSchema` here. */
  meta: z.input<typeof lss1MetaSchema>;
  webp: Uint8Array;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function rsaBits(key: KeyObject): number {
  return key.asymmetricKeyType === "rsa"
    ? (key.asymmetricKeyDetails?.modulusLength ?? 0)
    : 0;
}

/** Public key that may seal: RSA, at least 3072 bits. Never throws key text. */
export function importSealPublicKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new SelfieSealError("BAD_KEY", "Seal public key is not valid.");
  }
  if (rsaBits(key) < SELFIE_SEAL_MIN_RSA_BITS)
    throw new SelfieSealError(
      "BAD_KEY",
      `Seal key must be RSA of at least ${SELFIE_SEAL_MIN_RSA_BITS} bits.`,
    );
  return key;
}

function importSealPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new SelfieSealError("BAD_KEY", "Seal private key is not valid.");
  }
  if (rsaBits(key) < SELFIE_SEAL_MIN_RSA_BITS)
    throw new SelfieSealError("BAD_KEY", "Seal key is too small.");
  return key;
}

/**
 * Boot check of the cloud's seal keys (`ATTENDANCE_SELFIE_SEAL_KEYS`, JSON
 * `{kid: PKCS#8 PEM}`, and `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID`). Both unset is
 * fine (the cloud then tells edges there is no key). Messages never carry key
 * text or a parser error.
 */
export function sealKeyConfigProblems(
  rawKeys: string | undefined,
  activeKid: string | undefined,
): Array<{ path: string; message: string }> {
  const keysPath = "ATTENDANCE_SELFIE_SEAL_KEYS";
  const kidPath = "ATTENDANCE_SELFIE_SEAL_ACTIVE_KID";
  if (rawKeys === undefined && activeKid === undefined) return [];
  if (rawKeys === undefined)
    return [
      {
        path: keysPath,
        message: `Set ${keysPath} when ${kidPath} is set.`,
      },
    ];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    return [{ path: keysPath, message: "Must be valid JSON." }];
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0
  )
    return [
      {
        path: keysPath,
        message:
          "Must be a JSON object of kid to PKCS#8 PEM, with one key at least.",
      },
    ];
  const problems: Array<{ path: string; message: string }> = [];
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [kid, pem] of entries) {
    if (kid.length < 1 || kid.length > 64) {
      problems.push({
        path: keysPath,
        message: "Every kid must be 1 to 64 characters.",
      });
      continue;
    }
    try {
      if (typeof pem !== "string") throw new Error("not a string");
      importSealPrivateKey(pem);
    } catch {
      problems.push({
        path: keysPath,
        message: `The key of kid "${kid.slice(0, 64)}" must be an RSA private key (PKCS#8 PEM) of at least ${SELFIE_SEAL_MIN_RSA_BITS} bits.`,
      });
    }
  }
  if (activeKid === undefined)
    problems.push({
      path: kidPath,
      message: `Set ${kidPath} when ${keysPath} is set.`,
    });
  else if (!Object.hasOwn(parsed as object, activeKid))
    problems.push({
      path: kidPath,
      message: `Must name a kid in ${keysPath}.`,
    });
  return problems;
}

function aad(headerBytes: Buffer): Buffer {
  return Buffer.concat([MAGIC, u32(headerBytes.length), headerBytes]);
}

export function sealSelfie(input: SealInput): Buffer {
  const key = importSealPublicKey(input.publicKeyPem);
  const header = lss1HeaderSchema.parse({
    v: 1,
    kid: input.kid,
    alg: EDGE_SELFIE_ALG,
    tenantId: input.tenantId,
    objectId: input.objectId,
  });
  const meta = lss1MetaSchema.parse(input.meta);
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const metaBytes = Buffer.from(JSON.stringify(meta), "utf8");
  const plaintext = Buffer.concat([
    u32(metaBytes.length),
    metaBytes,
    Buffer.from(input.webp),
  ]);
  const aesKey = randomBytes(AES_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(aad(headerBytes));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = publicEncrypt(
    {
      key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  );
  aesKey.fill(0);
  const wrappedLen = Buffer.alloc(2);
  wrappedLen.writeUInt16BE(wrapped.length);
  return Buffer.concat([
    MAGIC,
    u32(headerBytes.length),
    headerBytes,
    wrappedLen,
    wrapped,
    iv,
    ciphertext,
    tag,
  ]);
}

interface Parsed {
  header: Lss1Header;
  headerBytes: Buffer;
  wrapped: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function bad(message: string): never {
  throw new SelfieSealError("BAD_FORMAT", message);
}

function parse(sealed: Uint8Array): Parsed {
  const buffer = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.length);
  if (buffer.length < MAGIC.length + 4 || !buffer.subarray(0, 4).equals(MAGIC))
    bad("Not an LSS1 file.");
  const headerLen = buffer.readUInt32BE(4);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) bad("Bad header size.");
  let offset = 8;
  if (buffer.length < offset + headerLen + 2) bad("Truncated.");
  const headerBytes = buffer.subarray(offset, offset + headerLen);
  offset += headerLen;
  let header: Lss1Header;
  try {
    header = lss1HeaderSchema.parse(JSON.parse(headerBytes.toString("utf8")));
  } catch {
    return bad("Bad header.");
  }
  const wrappedLen = buffer.readUInt16BE(offset);
  offset += 2;
  if (
    wrappedLen === 0 ||
    buffer.length < offset + wrappedLen + IV_BYTES + TAG_BYTES + 4
  )
    bad("Truncated.");
  const wrapped = buffer.subarray(offset, offset + wrappedLen);
  offset += wrappedLen;
  const iv = buffer.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const ciphertext = buffer.subarray(offset, buffer.length - TAG_BYTES);
  const tag = buffer.subarray(buffer.length - TAG_BYTES);
  return { header, headerBytes, wrapped, iv, ciphertext, tag };
}

/** The plaintext routing header; needs no key and proves nothing by itself. */
export function readLss1Header(sealed: Uint8Array): Lss1Header {
  return parse(sealed).header;
}

export function openSelfie(
  sealed: Uint8Array,
  privateKeyPem: string,
): { header: Lss1Header; meta: Lss1Meta; webp: Buffer } {
  const key = importSealPrivateKey(privateKeyPem);
  const parsed = parse(sealed);
  let plaintext: Buffer;
  let aesKey: Buffer | null = null;
  try {
    aesKey = privateDecrypt(
      {
        key,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      parsed.wrapped,
    );
    if (aesKey.length !== AES_KEY_BYTES) throw new Error("key size");
    const decipher = createDecipheriv("aes-256-gcm", aesKey, parsed.iv);
    decipher.setAAD(aad(parsed.headerBytes));
    decipher.setAuthTag(parsed.tag);
    plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new SelfieSealError("AUTH_FAILED", "Sealed file cannot be opened.");
  } finally {
    aesKey?.fill(0);
  }
  if (plaintext.length < 4) bad("Truncated plaintext.");
  const metaLen = plaintext.readUInt32BE(0);
  if (
    metaLen === 0 ||
    metaLen > MAX_META_BYTES ||
    plaintext.length < 4 + metaLen
  )
    bad("Bad meta size.");
  let meta: Lss1Meta;
  try {
    meta = lss1MetaSchema.parse(
      JSON.parse(plaintext.subarray(4, 4 + metaLen).toString("utf8")),
    );
  } catch {
    return bad("Bad meta.");
  }
  return {
    header: parsed.header,
    meta,
    webp: plaintext.subarray(4 + metaLen),
  };
}
