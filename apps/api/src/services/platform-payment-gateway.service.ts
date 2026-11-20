// Platform payment gateway registry reader and Super Admin writer (sub-302
// D9, D10, D11). `platform_payment_gateways` is a global, non-secret table:
// tenant request paths only SELECT it, through a 30 s process cache. Disabling
// a gateway blocks only NEW things (rules, intents); callers that resolve an
// existing intent by `intent.provider` never ask `isPlatformGatewayEnabled`.

import {
  platformGatewaySchema,
  type PlatformGateway,
  type UpdatePlatformGatewayInput,
} from "@starter/shared/platform";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db";
import {
  platformPaymentGatewayChanges,
  platformPaymentGateways,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  paymentGatewayLegacyMode,
  registeredGatewayProviders,
} from "./payment-gateway";

const CACHE_TTL_MS = 30_000;
const DEFAULT_TOLERANCE_PAST_MS = 25 * 60 * 60 * 1000;
const DEFAULT_TOLERANCE_FUTURE_MS = 5 * 60 * 1000;
const DEFAULT_SECRET_GRACE_MS = 72 * 60 * 60 * 1000;

type GatewayRow = typeof platformPaymentGateways.$inferSelect;

let cache: { at: number; rows: readonly PlatformGateway[] } | null = null;

/** Tests, and the writer after each update. */
export function resetPlatformGatewayCache(): void {
  cache = null;
}

function toGateway(row: GatewayRow): PlatformGateway {
  return platformGatewaySchema.parse({
    provider: row.provider,
    displayName: row.displayName,
    enabled: row.enabled,
    isDefault: row.isDefault,
    webhookTolerancePastSec: row.webhookTolerancePastSec,
    webhookToleranceFutureSec: row.webhookToleranceFutureSec,
    secretGraceHours: row.secretGraceHours,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Non-secret columns kept in the change history. */
function changeSnapshot(row: GatewayRow): Record<string, unknown> {
  return {
    enabled: row.enabled,
    isDefault: row.isDefault,
    webhookTolerancePastSec: row.webhookTolerancePastSec,
    webhookToleranceFutureSec: row.webhookToleranceFutureSec,
    secretGraceHours: row.secretGraceHours,
  };
}

export async function listPlatformGateways(
  now = Date.now(),
): Promise<readonly PlatformGateway[]> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await db
    .select()
    .from(platformPaymentGateways)
    .orderBy(asc(platformPaymentGateways.provider));
  cache = { at: now, rows: rows.map(toGateway) };
  return cache.rows;
}

export async function getPlatformGateway(
  provider: string,
): Promise<PlatformGateway | null> {
  return (
    (await listPlatformGateways()).find((row) => row.provider === provider) ??
    null
  );
}

/** Missing row -> false (fail closed), except in the test-only legacy mode,
 * where one injected port answers for every provider. */
export async function isPlatformGatewayEnabled(
  provider: string,
): Promise<boolean> {
  const row = await getPlatformGateway(provider);
  if (!row) return paymentGatewayLegacyMode();
  return row.enabled;
}

export async function platformDefaultGateway(): Promise<string | null> {
  return (
    (await listPlatformGateways()).find((row) => row.isDefault && row.enabled)
      ?.provider ?? null
  );
}

export async function gatewayWebhookTolerance(
  provider: string,
): Promise<{ pastMs: number; futureMs: number }> {
  const row = await getPlatformGateway(provider);
  if (!row)
    return {
      pastMs: DEFAULT_TOLERANCE_PAST_MS,
      futureMs: DEFAULT_TOLERANCE_FUTURE_MS,
    };
  return {
    pastMs: row.webhookTolerancePastSec * 1000,
    futureMs: row.webhookToleranceFutureSec * 1000,
  };
}

export async function gatewaySecretGraceMs(provider: string): Promise<number> {
  const row = await getPlatformGateway(provider);
  return row ? row.secretGraceHours * 3_600_000 : DEFAULT_SECRET_GRACE_MS;
}

/** A full update (API) or a partial one (CLI): fields left out keep the value
 * read under the lock, so a stale caller cannot overwrite a newer change. */
export type PlatformGatewayPatch = Partial<
  Omit<UpdatePlatformGatewayInput, "reason">
> &
  Pick<UpdatePlatformGatewayInput, "reason">;

/**
 * Super Admin update. One transaction: lock, merge the patch onto the locked
 * row, validate, clear the old default (the partial unique index allows one),
 * write the row and append the change history. The caller (route or CLI)
 * already ran its own guards.
 */
export async function updatePlatformGateway(
  provider: string,
  patch: PlatformGatewayPatch,
  actorUserId: string,
): Promise<PlatformGateway> {
  const updated = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('platform_payment_gateways', 0))`,
    );
    const [current] = await tx
      .select()
      .from(platformPaymentGateways)
      .where(eq(platformPaymentGateways.provider, provider))
      .for("update");
    if (!current)
      throw new HttpError(404, "NOT_FOUND", "Payment gateway not found.");
    const input = {
      enabled: patch.enabled ?? current.enabled,
      isDefault: patch.isDefault ?? current.isDefault,
      webhookTolerancePastSec:
        patch.webhookTolerancePastSec ?? current.webhookTolerancePastSec,
      webhookToleranceFutureSec:
        patch.webhookToleranceFutureSec ?? current.webhookToleranceFutureSec,
      secretGraceHours: patch.secretGraceHours ?? current.secretGraceHours,
      reason: patch.reason,
    };
    if (input.isDefault && !input.enabled && !current.isDefault)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "The default gateway must be enabled.",
      );
    if (current.isDefault && (!input.enabled || !input.isDefault))
      throw new HttpError(
        422,
        "GATEWAY_IS_DEFAULT",
        "Pick another default gateway before disabling or unsetting this one.",
      );
    // Never leave the platform without an active gateway (every new payment
    // would fail). Counted under the same lock as the write.
    if (current.enabled && !input.enabled) {
      const [others] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(platformPaymentGateways)
        .where(
          and(
            eq(platformPaymentGateways.enabled, true),
            ne(platformPaymentGateways.provider, provider),
          ),
        );
      if (!others || others.n === 0)
        throw new HttpError(
          422,
          "GATEWAY_LAST_ACTIVE",
          "This is the only active gateway; enable another one first.",
        );
    }
    if (input.enabled && !registeredGatewayProviders().includes(provider))
      throw new HttpError(
        422,
        "GATEWAY_NOT_REGISTERED",
        "This gateway has no adapter in this deployment.",
      );
    if (input.isDefault && !current.isDefault)
      await tx
        .update(platformPaymentGateways)
        .set({ isDefault: false })
        .where(eq(platformPaymentGateways.isDefault, true));
    const [row] = await tx
      .update(platformPaymentGateways)
      .set({
        enabled: input.enabled,
        isDefault: input.isDefault,
        webhookTolerancePastSec: input.webhookTolerancePastSec,
        webhookToleranceFutureSec: input.webhookToleranceFutureSec,
        secretGraceHours: input.secretGraceHours,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(platformPaymentGateways.provider, provider))
      .returning();
    if (!row) throw new Error("Platform gateway update returned no row");
    await tx.insert(platformPaymentGatewayChanges).values({
      provider,
      actorUserId,
      reason: input.reason,
      before: changeSnapshot(current),
      after: changeSnapshot(row),
    });
    return row;
  });
  resetPlatformGatewayCache();
  return toGateway(updated);
}
