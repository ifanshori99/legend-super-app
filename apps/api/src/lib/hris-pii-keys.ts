// Key ring syntax of HRIS PII rotation (bead legend-33mj). Pure: no env, no
// secrets import, so config/env.ts can validate the settings at boot without an
// import cycle. Version 1 is always the data key of lib/secrets.ts; this module
// only parses the extra versions (>= 2) from HRIS_PII_KEYS:
//
//   HRIS_PII_KEYS="2:<base64 32 bytes>,3:<base64 32 bytes>"
//
// Errors name the problem and the position, never the key material.

/** smallint column ceiling of `pii_key_version`. */
export const HRIS_PII_MAX_KEY_VERSION = 32767;

/** Parses HRIS_PII_KEYS into version → 32-byte key. Throws on any bad entry. */
export function parseHrisPiiKeys(
  spec: string | undefined,
): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  if (spec === undefined || spec.trim() === "") return keys;
  const entries = spec.split(",").map((entry) => entry.trim());
  entries.forEach((entry, index) => {
    const position = index + 1;
    const separator = entry.indexOf(":");
    if (separator < 1)
      throw new Error(
        `HRIS_PII_KEYS entry ${position} must be <version>:<key>`,
      );
    const rawVersion = entry.slice(0, separator).trim();
    if (!/^[0-9]+$/.test(rawVersion))
      throw new Error(`HRIS_PII_KEYS entry ${position} has a bad version`);
    const version = Number(rawVersion);
    if (version < 2 || version > HRIS_PII_MAX_KEY_VERSION)
      throw new Error(
        `HRIS_PII_KEYS entry ${position} version must be 2..${HRIS_PII_MAX_KEY_VERSION} (version 1 is DATA_ENCRYPTION_KEY)`,
      );
    if (keys.has(version))
      throw new Error(`HRIS_PII_KEYS repeats version ${version}`);
    const encoded = entry.slice(separator + 1).trim();
    const key = /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      ? Buffer.from(encoded, "base64")
      : Buffer.alloc(0);
    if (key.length !== 32)
      throw new Error(
        `HRIS_PII_KEYS entry ${position} key must be base64 of 32 bytes`,
      );
    keys.set(version, key);
  });
  return keys;
}

/** Throws unless `active` is version 1 or one of the parsed versions. */
export function assertHrisPiiActiveVersion(
  active: number,
  keys: ReadonlyMap<number, Buffer>,
): void {
  if (!Number.isInteger(active) || active < 1)
    throw new Error("HRIS_PII_ACTIVE_KEY_VERSION must be a positive integer");
  if (active !== 1 && !keys.has(active))
    throw new Error(
      "HRIS_PII_ACTIVE_KEY_VERSION must be 1 or a version listed in HRIS_PII_KEYS",
    );
}
