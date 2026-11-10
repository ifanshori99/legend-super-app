// Test-side helpers around the real LSS1 sealer (design docs/design/hris-edge-replication.md
// section 5). `sealSelfie` and `openSealed` delegate to `lib/selfie-seal.ts`, so
// the cloud tests seal and open with the same byte layout as the edge (C5) and
// the cloud receiver. Only the byte-level tamper helpers live here:
//
//   "LSS1" | u32 headerLen | header (UTF-8 JSON) | u16 wrappedKeyLen | wrappedKey
//          | iv(12) | ciphertext | tag(16)
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import sharp from "sharp";
import {
  openSelfie,
  sealSelfie as sealSelfieReal,
} from "../../lib/selfie-seal.ts";

export const LSS1_TEST_MAGIC = "LSS1";

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

/** Seals `webp` with the real sealer; every call uses a fresh AES key and IV. */
export function sealSelfie(options: SealOptions): Buffer {
  return sealSelfieReal({
    kid: options.headerKid ?? options.pair.kid,
    publicKeyPem: options.pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    tenantId: options.tenantId,
    objectId: options.objectId,
    meta: {
      outletId: options.meta.outletId,
      ownerUserId: options.meta.ownerUserId,
      contentType: "image/webp",
      width: options.meta.width ?? 64,
      height: options.meta.height ?? 64,
      plainSha256: options.plainSha256 ?? sha256Hex(options.webp),
      createdAt: options.meta.createdAt ?? new Date().toISOString(),
    },
    webp: options.webp,
  });
}

/** Test-side opener (the real `openSelfie`), used to prove the sealer itself. */
export function openSealed(
  sealed: Buffer,
  privateKeyPem: string,
): {
  header: Record<string, unknown>;
  meta: Record<string, unknown>;
  webp: Buffer;
} {
  return openSelfie(sealed, privateKeyPem);
}

function headerLength(sealed: Buffer): number {
  if (sealed.subarray(0, 4).toString("ascii") !== LSS1_TEST_MAGIC)
    throw new Error("not an LSS1 file");
  return sealed.readUInt32BE(4);
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
  const headerLen = headerLength(sealed);
  const header = sealed.subarray(8, 8 + headerLen);
  const edited = Buffer.from(
    JSON.stringify(edit(JSON.parse(header.toString("utf8")))),
    "utf8",
  );
  const rest = sealed.subarray(8 + headerLen);
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
