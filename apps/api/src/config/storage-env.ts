// One canonical set of object storage settings: STORAGE_S3_* (plus
// STORAGE_PUBLIC_BASE_URL). The older OBJECT_STORAGE_* names (profit share
// statements, legend-33im6) stay as a deprecated fallback so a deployment that
// only knows them keeps working (legend-94xqo). Pure and import-free: env.ts,
// the storage factory and scripts/doctor.mjs (a copy of the same rules) share it.

type Source = Readonly<Record<string, string | undefined>>;

/** Legacy name -> canonical name. */
export const LEGACY_STORAGE_ENV = {
  OBJECT_STORAGE_REGION: "STORAGE_S3_REGION",
  OBJECT_STORAGE_ENDPOINT: "STORAGE_S3_ENDPOINT",
  OBJECT_STORAGE_ACCESS_KEY_ID: "STORAGE_S3_ACCESS_KEY_ID",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "STORAGE_S3_SECRET_ACCESS_KEY",
  OBJECT_STORAGE_PRIVATE_BUCKET: "STORAGE_S3_PRIVATE_BUCKET",
  OBJECT_STORAGE_PUBLIC_BUCKET: "STORAGE_S3_PUBLIC_BUCKET",
  OBJECT_STORAGE_PUBLIC_BASE_URL: "STORAGE_PUBLIC_BASE_URL",
} as const;

export type StorageEnvResolution = {
  /** The canonical keys filled in from the legacy ones where they were unset. */
  env: Record<string, string | undefined>;
  /** Legacy keys that supplied a value (deprecated). */
  deprecated: string[];
  /** Pairs whose two values differ: a deployment mistake, never guessed. */
  conflicts: Array<{ legacy: string; canonical: string }>;
};

const clean = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

let warned = false;
/** Test hook: the deprecation warning is once per process. */
export function resetStorageEnvWarning() {
  warned = false;
}

export function resolveStorageEnv(
  source: Source,
  warn?: (message: string) => void,
): StorageEnvResolution {
  const env: Record<string, string | undefined> = { ...source };
  const deprecated: string[] = [];
  const conflicts: StorageEnvResolution["conflicts"] = [];
  for (const [legacy, canonical] of Object.entries(LEGACY_STORAGE_ENV)) {
    const old = clean(source[legacy]);
    if (old === undefined) continue;
    deprecated.push(legacy);
    const current = clean(source[canonical]);
    if (current === undefined) env[canonical] = old;
    else if (current !== old) conflicts.push({ legacy, canonical });
  }
  // OBJECT_STORAGE_ENDPOINT always meant a non-AWS provider with path-style URLs.
  if (
    clean(source.OBJECT_STORAGE_ENDPOINT) !== undefined &&
    clean(source.STORAGE_S3_FORCE_PATH_STYLE) === undefined
  )
    env.STORAGE_S3_FORCE_PATH_STYLE = "true";
  if (warn && deprecated.length > 0 && !warned) {
    warned = true;
    warn(
      `Deprecated storage settings in use: ${deprecated.join(", ")}. Rename them to the STORAGE_S3_* set (see .env.example).`,
    );
  }
  return { env, deprecated, conflicts };
}

/** The refusal text for conflicting values; names keys only, never values. */
export function storageConflictMessage(
  conflicts: StorageEnvResolution["conflicts"],
) {
  return `Conflicting storage settings: ${conflicts
    .map(({ legacy, canonical }) => `${legacy} and ${canonical} differ`)
    .join(
      "; ",
    )}. Remove the deprecated OBJECT_STORAGE_* keys or make the values equal.`;
}
