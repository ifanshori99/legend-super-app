// Production wiring of the profit share statement issuer (bead legend-33im6,
// S5). `configureProfitShareStatementDeps` was only ever called by tests, so in
// production issuing answered 503 on every payment and `statement_file_key`
// stayed NULL. server.ts calls `installProfitShareStatementPorts` beside the
// other ports (not createApp, so tests keep their fakes).
//
// Storage comes from the optional STORAGE_S3_* settings (all-or-none,
// validated at boot in config/env.ts; OBJECT_STORAGE_* is a deprecated fallback); email reuses the notification Brevo
// settings. Neither is required: without storage the issuer keeps its current
// behavior (503, swallowed by the payment path) and one startup warning says
// so. Messages name keys only, never values.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { EmailProvider, ObjectStorage } from "@starter/shared/adapters";
import type { OutletId } from "@starter/shared/core";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import {
  createBrevoEmailProvider,
  parseNotificationProviderEnv,
} from "../worker/notification-adapters.ts";
import { createObjectStorageFromEnv } from "./core-storage-runtime.ts";
import { notifyBrevoAuthFailed } from "./edge-sync-conflict-alert.ts";
import {
  configureProfitShareStatementDeps,
  type StatementIssuerDeps,
} from "./profit-share-statement.service.ts";

type Env = Record<string, string | undefined>;
const present = (env: Env, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

/**
 * `null` while no object storage is configured. Throws on a partial setup or
 * conflicting values. The same STORAGE_S3_* set as uploads (OBJECT_STORAGE_*
 * only as a deprecated fallback).
 */
export function createStatementObjectStorage(env: Env): ObjectStorage | null {
  return createObjectStorageFromEnv(env);
}

/**
 * `null` unless NOTIFICATION_EMAIL_PROVIDER=brevo with a valid setup. A Brevo
 * 401/403 raises the same throttled ops alert as the worker (legend-65i3t);
 * `options` lets tests inject their own database and fetch.
 */
export function createStatementEmailProvider(
  env: Env,
  options: {
    database?: NodePgDatabase<typeof schema>;
    fetch?: typeof globalThis.fetch;
  } = {},
): EmailProvider | null {
  const database = options.database ?? db;
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
      fetch: options.fetch,
      onAuthFailure: (context, failure) =>
        withTenant(database, context, (tx) =>
          notifyBrevoAuthFailed(tx, context, {
            tenantId: context.tenant.tenantId,
            outletId: failure.outletId as OutletId | null,
            status: failure.status,
          }),
        ),
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
      "profit share statements are not issued: object storage is not configured (set the STORAGE_S3_* keys)",
    );
  return { storage: Boolean(storage), email: Boolean(email) };
}
