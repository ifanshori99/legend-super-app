// Opens a sealed edge selfie (LSS1, design docs/design/hris-edge-replication.md 5).
//
//   "LSS1" | u32 headerLen | header (JSON) | u16 wrappedKeyLen | wrappedKey
//          | iv(12) | ciphertext | tag(16)
//
// One AES-256-GCM key per file, wrapped with RSA-OAEP-SHA256 to the cloud key
// named by header.kid. AAD = "LSS1" | headerLen | header, so an edited header
// breaks the tag. Plaintext = u32 metaLen | meta (JSON) | webp bytes.
// Never log key material, the sealed bytes or the plaintext.
import {
  constants,
  createDecipheriv,
  createHash,
  createPrivateKey,
  privateDecrypt,
  type KeyObject,
} from "node:crypto";
import {
  LSS1_MAGIC,
  lss1HeaderSchema,
  lss1MetaSchema,
  type Lss1Header,
  type Lss1Meta,
} from "@starter/shared/edge";
import { HttpError } from "../lib/http-error.ts";

export const SELFIE_SEAL_KEYS_ENV = "ATTENDANCE_SELFIE_SEAL_KEYS";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 1024;
const MAX_META_BYTES = 4096;
const MAX_WRAPPED_KEY_BYTES = 1024;

/** The sealed file cannot be opened: bad format, unknown key, broken tag or lying meta. */
export class SelfieUnsealError extends HttpError {
  constructor(message = "The selfie cannot be decrypted.") {
    super(422, "SELFIE_UNSEAL_FAILED", message);
    this.name = "SelfieUnsealError";
  }
}

/** Private keys by `kid`. Empty when none is configured. */
export type SelfieSealKeys = ReadonlyMap<string, KeyObject>;

/**
 * Reads `ATTENDANCE_SELFIE_SEAL_KEYS` (JSON `{kid: PKCS#8 PEM}`) on every call,
 * so a rotated key needs no restart. A missing, malformed or unreadable value
 * yields fewer (or no) keys; nothing about the value is logged.
 */
export function loadSelfieSealKeys(
  env: Record<string, string | undefined> = process.env,
): SelfieSealKeys {
  const keys = new Map<string, KeyObject>();
  const raw = env[SELFIE_SEAL_KEYS_ENV];
  if (!raw || !raw.trim()) return keys;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return keys;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return keys;
  for (const [kid, pem] of Object.entries(parsed)) {
    if (typeof pem !== "string" || !kid) continue;
    try {
      keys.set(kid, createPrivateKey(pem));
    } catch {
      // Skip a key that does not parse; the file for that kid then gets a 422.
    }
  }
  return keys;
}

export type UnsealedSelfie = {
  header: Lss1Header;
  meta: Lss1Meta;
  webp: Buffer;
};

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SelfieUnsealError();
  }
}

export function unsealSelfie(
  sealed: Buffer,
  keys: SelfieSealKeys,
): UnsealedSelfie {
  // magic(4) + headerLen(4)
  if (
    sealed.length < 8 ||
    sealed.subarray(0, 4).toString("ascii") !== LSS1_MAGIC
  )
    throw new SelfieUnsealError();
  const headerLen = sealed.readUInt32BE(4);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES)
    throw new SelfieUnsealError();
  let offset = 8;
  if (sealed.length < offset + headerLen + 2) throw new SelfieUnsealError();
  const headerBytes = sealed.subarray(offset, offset + headerLen);
  offset += headerLen;
  const wrappedLen = sealed.readUInt16BE(offset);
  offset += 2;
  if (
    wrappedLen === 0 ||
    wrappedLen > MAX_WRAPPED_KEY_BYTES ||
    sealed.length < offset + wrappedLen + IV_BYTES + TAG_BYTES
  )
    throw new SelfieUnsealError();
  const wrappedKey = sealed.subarray(offset, offset + wrappedLen);
  offset += wrappedLen;
  const iv = sealed.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const ciphertext = sealed.subarray(offset, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  const header = lss1HeaderSchema.safeParse(parseJson(headerBytes));
  if (!header.success) throw new SelfieUnsealError();
  const privateKey = keys.get(header.data.kid);
  if (!privateKey) throw new SelfieUnsealError();

  let plaintext: Buffer;
  try {
    const aesKey = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      wrappedKey,
    );
    const lenBytes = Buffer.alloc(4);
    lenBytes.writeUInt32BE(headerLen);
    const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAAD(
      Buffer.concat([Buffer.from(LSS1_MAGIC, "ascii"), lenBytes, headerBytes]),
    );
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SelfieUnsealError();
  }

  if (plaintext.length < 4) throw new SelfieUnsealError();
  const metaLen = plaintext.readUInt32BE(0);
  if (
    metaLen === 0 ||
    metaLen > MAX_META_BYTES ||
    plaintext.length < 4 + metaLen
  )
    throw new SelfieUnsealError();
  const meta = lss1MetaSchema.safeParse(
    parseJson(plaintext.subarray(4, 4 + metaLen)),
  );
  if (!meta.success) throw new SelfieUnsealError();
  const webp = plaintext.subarray(4 + metaLen);
  if (
    webp.length === 0 ||
    createHash("sha256").update(webp).digest("hex") !== meta.data.plainSha256
  )
    throw new SelfieUnsealError();
  return { header: header.data, meta: meta.data, webp };
}
