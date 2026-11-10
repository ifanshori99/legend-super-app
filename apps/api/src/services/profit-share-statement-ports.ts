// Production wiring of the profit share statement issuer (bead legend-33im6,
// S5). `configureProfitShareStatementDeps` was only ever called by tests, so in
// production issuing answered 503 on every payment and `statement_file_key`
// stayed NULL. server.ts calls `installProfitShareStatementPorts` beside the
// other ports (not createApp, so tests keep their fakes).
//
// Storage comes from the optional OBJECT_STORAGE_* settings (all-or-none,
// validated at boot in config/env.ts); email reuses the notification Brevo
// settings. Neither is required: without storage the issuer keeps its current
// behavior (503, swallowed by the payment path) and one startup warning says
// so. Messages name keys only, never values.

import { S3Client } from "@aws-sdk/client-s3";
import type { EmailProvider, ObjectStorage } from "@starter/shared/adapters";
import { logger } from "../lib/logger.ts";
import {
  createBrevoEmailProvider,
  parseNotificationProviderEnv,
} from "../worker/notification-adapters.ts";
import { S3ObjectStorage } from "./core-storage-provider.ts";
import {
  configureProfitShareStatementDeps,
  type StatementIssuerDeps,
} from "./profit-share-statement.service.ts";

type Env = Record<string, string | undefined>;
const present = (env: Env, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

/** `null` while no object storage is configured. Throws on a partial setup. */
export function createStatementObjectStorage(env: Env): ObjectStorage | null {
  const region = present(env, "OBJECT_STORAGE_REGION");
  const endpoint = present(env, "OBJECT_STORAGE_ENDPOINT");
  const accessKeyId = present(env, "OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = present(env, "OBJECT_STORAGE_SECRET_ACCESS_KEY");
  const privateBucket = present(env, "OBJECT_STORAGE_PRIVATE_BUCKET");
  const publicBucket = present(env, "OBJECT_STORAGE_PUBLIC_BUCKET");
  const publicBaseUrl = present(env, "OBJECT_STORAGE_PUBLIC_BASE_URL");
  if (
    !region &&
    !endpoint &&
    !accessKeyId &&
    !secretAccessKey &&
    !privateBucket &&
    !publicBucket &&
    !publicBaseUrl
  )
    return null;
  if (
    !region ||
    !accessKeyId ||
    !secretAccessKey ||
    !privateBucket ||
    !publicBucket ||
    !publicBaseUrl
  )
    throw new Error("Incomplete OBJECT_STORAGE_* configuration");
  return new S3ObjectStorage({
    client: new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      // A custom endpoint is a non-AWS provider, which needs path-style URLs.
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    }),
    privateBucket,
    publicBucket,
    publicBaseUrl,
  });
}

/** `null` unless NOTIFICATION_EMAIL_PROVIDER=brevo with a valid setup. */
export function createStatementEmailProvider(env: Env): EmailProvider | null {
  if (present(env, "NOTIFICATION_EMAIL_PROVIDER") !== "brevo") return null;
  try {
    // The API process does not set the push and WhatsApp keys the shared
    // parser demands; they are irrelevant to this email-only use.
    const config = parseNotificationProviderEnv({
      ...env,
      NOTIFICATION_PUSH_PROVIDER: "disabled",
      NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
    });
    if (config.email.provider !== "brevo") return null;
    return createBrevoEmailProvider({
      apiKey: config.email.apiKey,
      from: config.email.from,
      fromName: config.email.fromName,
    });
  } catch (error) {
    // The notice is best effort: a broken mail setup must not stop the API.
    logger.warn(
      { reason: error instanceof Error ? error.message : "unknown" },
      "profit share statement email is not configured; notices are skipped",
    );
    return null;
  }
}

/**
 * Installs the statement issuer ports. `overrides` win over the environment
 * (tests pass fakes). Returns what ended up wired.
 */
export function installProfitShareStatementPorts(
  env: Env,
  overrides: StatementIssuerDeps = {},
): { storage: boolean; email: boolean } {
  const storage =
    overrides.storage !== undefined
      ? overrides.storage
      : createStatementObjectStorage(env);
  const email =
    overrides.email !== undefined
      ? overrides.email
      : createStatementEmailProvider(env);
  configureProfitShareStatementDeps({
    storage,
    email,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  if (!storage)
    logger.warn(
      "profit share statements are not issued: object storage is not configured (set the OBJECT_STORAGE_* keys)",
    );
  return { storage: Boolean(storage), email: Boolean(email) };
}
