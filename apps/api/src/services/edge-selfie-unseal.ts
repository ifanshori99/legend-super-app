// Cloud side of the sealed edge selfie (LSS1, design
// docs/design/hris-edge-replication.md 5). The format itself lives in
// lib/selfie-seal.ts (C5, legend-we0yc: sealSelfie on the edge, openSelfie on
// the cloud); this file only picks the private key named by the header's kid,
// maps every failure to one 422 and checks the plaintext hash.
// Never log key material, the sealed bytes or the plaintext.
import { createHash } from "node:crypto";
import type { Lss1Header, Lss1Meta } from "@starter/shared/edge";
import { HttpError } from "../lib/http-error.ts";
import { openSelfie, readLss1Header } from "../lib/selfie-seal.ts";

export const SELFIE_SEAL_KEYS_ENV = "ATTENDANCE_SELFIE_SEAL_KEYS";

/** The sealed file cannot be opened: bad format, unknown key, broken tag or lying meta. */
export class SelfieUnsealError extends HttpError {
  constructor(message = "The selfie cannot be decrypted.") {
    super(422, "SELFIE_UNSEAL_FAILED", message);
    this.name = "SelfieUnsealError";
  }
}

/** Private key PEMs by `kid`. Empty when none is configured. */
export type SelfieSealKeys = ReadonlyMap<string, string>;

/**
 * Reads `ATTENDANCE_SELFIE_SEAL_KEYS` (JSON `{kid: PKCS#8 PEM}`) on every call,
 * so a rotated key needs no restart. A missing or malformed value yields fewer
 * (or no) keys; nothing about the value is logged. A PEM that does not parse
 * is only found out when a file names that kid (422).
 */
export function loadSelfieSealKeys(
  env: Record<string, string | undefined> = process.env,
): SelfieSealKeys {
  const keys = new Map<string, string>();
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
  for (const [kid, pem] of Object.entries(parsed))
    if (kid && typeof pem === "string") keys.set(kid, pem);
  return keys;
}

export type UnsealedSelfie = {
  header: Lss1Header;
  meta: Lss1Meta;
  webp: Buffer;
};

export function unsealSelfie(
  sealed: Buffer,
  keys: SelfieSealKeys,
): UnsealedSelfie {
  try {
    const pem = keys.get(readLss1Header(sealed).kid);
    if (!pem) throw new SelfieUnsealError();
    const opened = openSelfie(sealed, pem);
    if (
      opened.webp.length === 0 ||
      createHash("sha256").update(opened.webp).digest("hex") !==
        opened.meta.plainSha256
    )
      throw new SelfieUnsealError();
    return opened;
  } catch (error) {
    // Any failure (format, key, tag, meta, hash) is the same 422; the cause
    // is never echoed, it could describe key material.
    if (error instanceof SelfieUnsealError) throw error;
    throw new SelfieUnsealError();
  }
}
