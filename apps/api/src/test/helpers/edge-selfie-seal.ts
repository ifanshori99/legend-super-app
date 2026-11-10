// Test-only LSS1 sealer (design docs/design/hris-edge-replication.md section 5).
// The edge sealer (C5) is not in this branch, so the cloud tests make their own
// sealed files here with node `crypto` only. Format, all lengths big-endian:
//
//   "LSS1" | u32 headerLen | header (UTF-8 JSON) | u16 wrappedKeyLen | wrappedKey
//          | iv(12) | ciphertext | tag(16)
//   header    = {"v":1,"kid","alg":"RSA-OAEP-256+A256GCM","tenantId","objectId"}
//   plaintext = u32 metaLen | meta (UTF-8 JSON) | webp bytes
//   meta      = {"outletId","ownerUserId","contentType":"image/webp",
//                "width","height","plainSha256","createdAt"}
//
// One fresh AES-256-GCM key per file, wrapped with RSA-OAEP-SHA256 (3072-bit
// key). AAD = "LSS1" | u32 headerLen | header, so an edited header breaks the tag.
import {
  constants,
  createDecipheriv,
  createCipheriv,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import sharp from "sharp";

export const LSS1_TEST_MAGIC = "LSS1";
export const LSS1_TEST_ALG = "RSA-OAEP-256+A256GCM";

export type SealKeyPair = {
  kid: string;
  publicKey: KeyObject;
  /** PKCS#8 PEM, the form the cloud keeps in ATTENDANCE_SELFIE_SEAL_KEYS. */
  privateKeyPem: string;
};

/** A 3072-bit RSA key pair for one `kid` (a few hundred ms: build once per file). */
export function generateSealKeyPair(kid: string): SealKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
  });
  return {
    kid,
    publicKey,
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
}

/** Value for the env var `ATTENDANCE_SELFIE_SEAL_KEYS`: JSON `{kid: PKCS#8 PEM}`. */
export function sealKeysEnvValue(...pairs: SealKeyPair[]): string {
  return JSON.stringify(
    Object.fromEntries(pairs.map((pair) => [pair.kid, pair.privateKeyPem])),
  );
}

export type SealedMeta = {
  outletId: string;
  ownerUserId: string;
  width?: number;
  height?: number;
  createdAt?: string;
};

export type SealOptions = {
  pair: SealKeyPair;
  tenantId: string;
  objectId: string;
  meta: SealedMeta;
  webp: Buffer;
  /** Overrides the plaintext hash inside meta (a lie the cloud must catch). */
  plainSha256?: string;
  /** Overrides the `kid` written in the header (the key is still `pair`). */
  headerKid?: string;
};

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function aad(header: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(LSS1_TEST_MAGIC, "ascii"),
    u32(header.length),
    header,
  ]);
}

/** Seals `webp` the way the edge does; every call uses a fresh AES key and IV. */
export function sealSelfie(options: SealOptions): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      v: 1,
      kid: options.headerKid ?? options.pair.kid,
      alg: LSS1_TEST_ALG,
      tenantId: options.tenantId,
      objectId: options.objectId,
    }),
    "utf8",
  );
  const meta = Buffer.from(
    JSON.stringify({
      outletId: options.meta.outletId,
      ownerUserId: options.meta.ownerUserId,
      contentType: "image/webp",
      width: options.meta.width ?? 64,
      height: options.meta.height ?? 64,
      plainSha256: options.plainSha256 ?? sha256Hex(options.webp),
      createdAt: options.meta.createdAt ?? new Date().toISOString(),
    }),
    "utf8",
  );
  const plaintext = Buffer.concat([u32(meta.length), meta, options.webp]);
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(aad(header));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt(
    {
      key: options.pair.publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  );
  return Buffer.concat([
    Buffer.from(LSS1_TEST_MAGIC, "ascii"),
    u32(header.length),
    header,
    u16(wrappedKey.length),
    wrappedKey,
    iv,
    ciphertext,
    tag,
  ]);
}

type Parts = {
  header: Buffer;
  wrappedKey: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

function parts(sealed: Buffer): Parts {
  if (sealed.subarray(0, 4).toString("ascii") !== LSS1_TEST_MAGIC)
    throw new Error("not an LSS1 file");
  const headerLen = sealed.readUInt32BE(4);
  const header = sealed.subarray(8, 8 + headerLen);
  let offset = 8 + headerLen;
  const wrappedLen = sealed.readUInt16BE(offset);
  offset += 2;
  const wrappedKey = sealed.subarray(offset, offset + wrappedLen);
  offset += wrappedLen;
  const iv = sealed.subarray(offset, offset + 12);
  offset += 12;
  const ciphertext = sealed.subarray(offset, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  return { header, wrappedKey, iv, ciphertext, tag };
}

/** Test-side opener (the reverse of `sealSelfie`), used to prove the sealer itself. */
export function openSealed(
  sealed: Buffer,
  privateKeyPem: string,
): {
  header: Record<string, unknown>;
  meta: Record<string, unknown>;
  webp: Buffer;
} {
  const { header, wrappedKey, iv, ciphertext, tag } = parts(sealed);
  const aesKey = privateDecrypt(
    {
      key: createPrivateKey(privateKeyPem),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    wrappedKey,
  );
  const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAAD(aad(header));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  const metaLen = plaintext.readUInt32BE(0);
  return {
    header: JSON.parse(header.toString("utf8")) as Record<string, unknown>,
    meta: JSON.parse(
      plaintext.subarray(4, 4 + metaLen).toString("utf8"),
    ) as Record<string, unknown>,
    webp: plaintext.subarray(4 + metaLen),
  };
}

/** Flips one bit of the GCM tag (the last byte): decryption must fail. */
export function withBrokenTag(sealed: Buffer): Buffer {
  const out = Buffer.from(sealed);
  out[out.length - 1] = out[out.length - 1]! ^ 0x01;
  return out;
}

/**
 * Rewrites the plaintext header with `edit` and keeps every other byte, so the
 * file is well formed but the GCM tag no longer matches the AAD.
 */
export function withEditedHeader(
  sealed: Buffer,
  edit: (header: Record<string, unknown>) => Record<string, unknown>,
): Buffer {
  const { header } = parts(sealed);
  const edited = Buffer.from(
    JSON.stringify(edit(JSON.parse(header.toString("utf8")))),
    "utf8",
  );
  const rest = sealed.subarray(8 + header.length);
  return Buffer.concat([
    Buffer.from(LSS1_TEST_MAGIC, "ascii"),
    u32(edited.length),
    edited,
    rest,
  ]);
}

/** A small real WebP (a decodable image, distinct per `seed`). */
export async function sampleWebp(seed = 0): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: seed % 256, g: (seed * 7) % 256, b: 120 },
    },
  })
    .webp()
    .toBuffer();
}

/** True when the bytes start like a WebP (RIFF....WEBP) or JPEG file. */
export function looksLikeImage(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  return (
    (buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP") ||
    (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
  );
}
