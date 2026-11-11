// Versioned blind index (legend-n039). A blind index is an HMAC-SHA256 digest
// used for equality lookups and uniqueness without storing the value.
//
// - Version 1 is the legacy digest: HMAC under the raw data key
//   (lib/secrets.ts `blindIndex`). Every row written before 0265 holds it, so
//   it stays byte-identical; it is read and compared, and written only while
//   BLIND_INDEX_ACTIVE_VERSION is 1 (rollback).
// - Version 2 is HMAC under an HKDF subkey of the data key, so the key that
//   indexes a value is not the key that seals it. No new secret is needed.
//
// Both versions frame the input as `<purpose>\0<value>`. Rows carry the version
// of their digest (`employees.blind_index_version`,
// `legal_entities.npwp_hash_version`); worker/blind-index-rebuild.job.ts moves
// them to the active version. Nothing here logs or echoes a value.

import { createHmac } from "node:crypto";
import { env } from "../config/env.ts";
import { blindIndex, deriveDataSubkey } from "./secrets.ts";

export const BLIND_INDEX_VERSIONS = [1, 2] as const;
export type BlindIndexVersion = (typeof BLIND_INDEX_VERSIONS)[number];

/** Version new digests are written under. */
export const BLIND_INDEX_ACTIVE_VERSION: BlindIndexVersion =
  env.BLIND_INDEX_ACTIVE_VERSION === 2 ? 2 : 1;

const V2_INFO = "legend:blind-index:v2";

/** Digest (hex) of `value` for `purpose` under one key version. */
export function blindIndexAt(
  version: BlindIndexVersion,
  value: string,
  purpose: string,
): string {
  // Version 1 is the legacy digest; its key (the raw data key) never leaves
  // lib/secrets.ts. Only the v2 subkey is handled here.
  if (version === 1) return blindIndex(value, purpose);
  if (version !== 2) throw new RangeError("Unsupported blind index version");
  return createHmac("sha256", deriveDataSubkey(V2_INFO))
    .update(`${purpose}\u0000${value}`, "utf8")
    .digest("hex");
}

/** Digest under every supported version, for lookups across a cutover. */
export function blindIndexCandidates(
  value: string,
  purpose: string,
): { version: BlindIndexVersion; digest: string }[] {
  return BLIND_INDEX_VERSIONS.map((version) => ({
    version,
    digest: blindIndexAt(version, value, purpose),
  }));
}
