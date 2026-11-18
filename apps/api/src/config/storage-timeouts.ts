import { z } from "zod";

/** Node timers overflow above this value and fire after one millisecond. */
const MAX_TIMEOUT_MS = 2_147_483_647;

const timeoutMs = (fallback: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.coerce.number().int().min(1).max(MAX_TIMEOUT_MS).default(fallback),
  );

/** Shared by startup validation and storage runtimes built from raw env. */
export const storageTimeoutEnvShape = {
  STORAGE_S3_REQUEST_TIMEOUT_MS: timeoutMs(120_000),
  STORAGE_S3_SOCKET_TIMEOUT_MS: timeoutMs(60_000),
};

const storageTimeoutEnvSchema = z.object(storageTimeoutEnvShape);

/** Invalid deployment settings name their keys without disclosing env values. */
export function parseStorageTimeouts(
  source: Readonly<Record<string, string | undefined>>,
) {
  const parsed = storageTimeoutEnvSchema.safeParse(source);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new Error(`Invalid storage timeout settings: ${fields.join(", ")}.`);
  }
  return parsed.data;
}
