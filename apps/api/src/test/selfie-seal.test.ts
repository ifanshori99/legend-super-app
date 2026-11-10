// T5 unit part (design docs/design/hris-edge-replication.md sections 5 and 9):
// LSS1 sealed selfie. Written before apps/api/src/lib/selfie-seal.ts exists.
//
// Assumptions where the design is silent:
// - Wrong private key and "public key given as private key" may surface as
//   BAD_KEY or AUTH_FAILED; both are accepted, anything else (or success) fails.
// - A 2048-bit public key is refused with SelfieSealError code BAD_KEY.
// - Header edits keep the byte length and stay schema-valid, so only the GCM
//   tag (AAD) can catch them: AUTH_FAILED.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Lss1Meta } from "@starter/shared/edge";
import {
  SelfieSealError,
  openSelfie,
  readLss1Header,
  sealSelfie,
} from "../lib/selfie-seal.ts";

const TENANT_ID = "3f2c1a9e-5b7d-4c8e-9a10-2b4d6f8a0c1e";
const OBJECT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OUTLET_ID = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
const OWNER_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const KID = "kid-2026-a";

function pem(bits: number) {
  return generateKeyPairSync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Valid-looking webp head (RIFF....WEBPVP8 ) followed by random bytes.
function makeWebp(size = 4096): Buffer {
  const head = Buffer.alloc(16);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(size - 8, 4);
  head.write("WEBPVP8 ", 8, "ascii");
  return Buffer.concat([head, randomBytes(size - 16)]);
}

function makeMeta(webp: Uint8Array): Lss1Meta {
  return {
    outletId: OUTLET_ID,
    ownerUserId: OWNER_ID,
    contentType: "image/webp",
    width: 640,
    height: 480,
    plainSha256: sha256Hex(webp),
    createdAt: "2026-11-10T01:02:03.000Z",
  } as Lss1Meta;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  return Buffer.from(haystack).indexOf(needle);
}

function expectSealError(fn: () => unknown, codes: string[]) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SelfieSealError);
  expect(codes).toContain((thrown as SelfieSealError).code);
}

describe("selfie seal (LSS1)", () => {
  let keys: { publicKey: string; privateKey: string };
  let otherKeys: { publicKey: string; privateKey: string };
  let webp: Buffer;
  let meta: Lss1Meta;
  let sealed: Buffer;
  // Byte offsets in the sealed file, derived from the documented format.
  let headerLen: number;
  let wrappedKeyOffset: number;
  let wrappedKeyLen: number;
  let ivOffset: number;

  beforeAll(() => {
    keys = pem(3072);
    otherKeys = pem(3072);
    webp = makeWebp();
    meta = makeMeta(webp);
    sealed = sealSelfie({
      kid: KID,
      publicKeyPem: keys.publicKey,
      tenantId: TENANT_ID,
      objectId: OBJECT_ID,
      meta,
      webp,
    });
    headerLen = sealed.readUInt32BE(4);
    wrappedKeyOffset = 4 + 4 + headerLen + 2;
    wrappedKeyLen = sealed.readUInt16BE(4 + 4 + headerLen);
    ivOffset = wrappedKeyOffset + wrappedKeyLen;
  }, 60_000);

  const seal = (overrides: Partial<Parameters<typeof sealSelfie>[0]> = {}) =>
    sealSelfie({
      kid: KID,
      publicKeyPem: keys.publicKey,
      tenantId: TENANT_ID,
      objectId: OBJECT_ID,
      meta,
      webp,
      ...overrides,
    });

  it("starts with the LSS1 magic and follows the documented layout", () => {
    expect(sealed.subarray(0, 4).toString("ascii")).toBe("LSS1");
    expect(wrappedKeyLen).toBe(384); // RSA-3072 output
    const header = JSON.parse(
      sealed.subarray(8, 8 + headerLen).toString("utf8"),
    );
    expect(header).toEqual({
      v: 1,
      kid: KID,
      alg: "RSA-OAEP-256+A256GCM",
      tenantId: TENANT_ID,
      objectId: OBJECT_ID,
    });
    // iv(12) + ciphertext(u32 metaLen + meta + webp) + tag(16)
    const cipherLen = sealed.length - ivOffset - 12 - 16;
    const metaJsonLen = Buffer.byteLength(JSON.stringify(meta), "utf8");
    expect(cipherLen).toBe(4 + metaJsonLen + webp.length);
  });

  it("readLss1Header returns the header without any key", () => {
    expect(readLss1Header(sealed)).toEqual({
      v: 1,
      kid: KID,
      alg: "RSA-OAEP-256+A256GCM",
      tenantId: TENANT_ID,
      objectId: OBJECT_ID,
    });
  });

  it("sealed bytes carry no jpeg, png or webp magic", () => {
    // Offset 0 is the LSS1 magic, not an image signature.
    expect(sealed.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(
      false,
    );
    expect(sealed.subarray(0, 4).toString("latin1")).not.toBe("\x89PNG");
    expect(sealed.subarray(0, 4).toString("latin1")).not.toBe("RIFF");
    // 4-byte signatures anywhere (random chance is about 1e-6 per file).
    expect(indexOfBytes(sealed, Buffer.from("RIFF", "ascii"))).toBe(-1);
    expect(indexOfBytes(sealed, Buffer.from("WEBP", "ascii"))).toBe(-1);
    expect(indexOfBytes(sealed, Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(
      -1,
    );
  });

  it("sealed bytes do not contain the plain bytes", () => {
    expect(indexOfBytes(sealed, webp)).toBe(-1);
    expect(indexOfBytes(sealed, webp.subarray(0, 32))).toBe(-1);
    expect(indexOfBytes(sealed, webp.subarray(1000, 1032))).toBe(-1);
  });

  it("meta strings are absent from the sealed bytes", () => {
    for (const secret of [
      OUTLET_ID,
      OWNER_ID,
      meta.plainSha256,
      meta.createdAt,
      "outletId",
      "ownerUserId",
      "plainSha256",
    ]) {
      expect(indexOfBytes(sealed, Buffer.from(secret, "utf8"))).toBe(-1);
    }
    // Routing header stays readable: tenant and object only.
    expect(
      indexOfBytes(sealed, Buffer.from(TENANT_ID, "utf8")),
    ).toBeGreaterThan(-1);
    expect(
      indexOfBytes(sealed, Buffer.from(OBJECT_ID, "utf8")),
    ).toBeGreaterThan(-1);
  });

  it("round trip with the private key returns header, meta and webp", () => {
    const opened = openSelfie(sealed, keys.privateKey);
    expect(opened.header.kid).toBe(KID);
    expect(opened.header.tenantId).toBe(TENANT_ID);
    expect(opened.header.objectId).toBe(OBJECT_ID);
    expect(opened.meta).toEqual(meta);
    expect(Buffer.from(opened.webp).equals(webp)).toBe(true);
    expect(sha256Hex(opened.webp)).toBe(opened.meta.plainSha256);
  });

  it("two seals of the same input differ and both open", () => {
    const second = seal();
    expect(second.equals(sealed)).toBe(false);
    // Fresh AES key and IV: wrapped key and ciphertext both change.
    const secondWrapped = second.subarray(
      wrappedKeyOffset,
      wrappedKeyOffset + wrappedKeyLen,
    );
    const firstWrapped = sealed.subarray(
      wrappedKeyOffset,
      wrappedKeyOffset + wrappedKeyLen,
    );
    expect(secondWrapped.equals(firstWrapped)).toBe(false);
    expect(
      second
        .subarray(ivOffset, ivOffset + 12)
        .equals(sealed.subarray(ivOffset, ivOffset + 12)),
    ).toBe(false);
    expect(
      Buffer.from(openSelfie(second, keys.privateKey).webp).equals(webp),
    ).toBe(true);
  });

  it("edited header kid fails the tag", () => {
    const edited = Buffer.from(sealed);
    const headerText = edited.subarray(8, 8 + headerLen).toString("utf8");
    const swapped = headerText.replace(KID, "kid-2026-b"); // same length
    expect(Buffer.byteLength(swapped)).toBe(headerLen);
    edited.write(swapped, 8, "utf8");
    expectSealError(() => openSelfie(edited, keys.privateKey), ["AUTH_FAILED"]);
  });

  it("edited header tenantId fails the tag", () => {
    const edited = Buffer.from(sealed);
    const headerText = edited.subarray(8, 8 + headerLen).toString("utf8");
    const otherTenant = "4f2c1a9e-5b7d-4c8e-9a10-2b4d6f8a0c1e"; // one char differs
    const swapped = headerText.replace(TENANT_ID, otherTenant);
    expect(Buffer.byteLength(swapped)).toBe(headerLen);
    edited.write(swapped, 8, "utf8");
    expect(readLss1Header(edited).tenantId).toBe(otherTenant);
    expectSealError(() => openSelfie(edited, keys.privateKey), ["AUTH_FAILED"]);
  });

  it("edited ciphertext fails", () => {
    const edited = Buffer.from(sealed);
    const ciphertextStart = ivOffset + 12;
    edited[ciphertextStart + 100] ^= 0x01;
    expectSealError(() => openSelfie(edited, keys.privateKey), ["AUTH_FAILED"]);
  });

  it("edited tag fails", () => {
    const edited = Buffer.from(sealed);
    edited[edited.length - 1] ^= 0x01;
    expectSealError(() => openSelfie(edited, keys.privateKey), ["AUTH_FAILED"]);
  });

  it("edited iv fails", () => {
    const edited = Buffer.from(sealed);
    edited[ivOffset] ^= 0x01;
    expectSealError(() => openSelfie(edited, keys.privateKey), ["AUTH_FAILED"]);
  });

  it("bad magic is BAD_FORMAT", () => {
    const edited = Buffer.from(sealed);
    edited.write("LSS2", 0, "ascii");
    expectSealError(() => openSelfie(edited, keys.privateKey), ["BAD_FORMAT"]);
    expectSealError(() => readLss1Header(edited), ["BAD_FORMAT"]);
    // A plain image is not a sealed file.
    expectSealError(() => openSelfie(webp, keys.privateKey), ["BAD_FORMAT"]);
    expectSealError(() => readLss1Header(webp), ["BAD_FORMAT"]);
  });

  it("truncated input is BAD_FORMAT", () => {
    const cuts = [
      0,
      3,
      4,
      7,
      8,
      8 + headerLen - 1, // inside the header
      8 + headerLen + 1, // inside the wrapped key length
      wrappedKeyOffset + 10, // inside the wrapped key
      ivOffset + 5, // inside the iv
    ];
    for (const cut of cuts) {
      const truncated = sealed.subarray(0, cut);
      expectSealError(
        () => openSelfie(truncated, keys.privateKey),
        ["BAD_FORMAT"],
      );
    }
    expectSealError(
      () => readLss1Header(sealed.subarray(0, 8 + headerLen - 1)),
      ["BAD_FORMAT"],
    );
  });

  it("header length that points past the end is BAD_FORMAT", () => {
    const edited = Buffer.from(sealed);
    edited.writeUInt32BE(sealed.length + 1000, 4);
    expectSealError(() => openSelfie(edited, keys.privateKey), ["BAD_FORMAT"]);
    expectSealError(() => readLss1Header(edited), ["BAD_FORMAT"]);
  });

  it("wrong private key cannot open the file", () => {
    expectSealError(
      () => openSelfie(sealed, otherKeys.privateKey),
      ["BAD_KEY", "AUTH_FAILED"],
    );
  });

  it("public key cannot open the file", () => {
    expectSealError(
      () => openSelfie(sealed, keys.publicKey),
      ["BAD_KEY", "AUTH_FAILED"],
    );
  });

  it("garbage key text cannot open the file", () => {
    expectSealError(
      () => openSelfie(sealed, "not a pem"),
      ["BAD_KEY", "AUTH_FAILED"],
    );
  });

  it("refuses a 2048-bit public key", () => {
    const weak = pem(2048);
    expectSealError(() => seal({ publicKeyPem: weak.publicKey }), ["BAD_KEY"]);
  });

  it("refuses a private key where a public key is expected", () => {
    expectSealError(() => seal({ publicKeyPem: "not a pem" }), ["BAD_KEY"]);
  });
});
