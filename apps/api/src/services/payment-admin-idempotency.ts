import { createHash } from "node:crypto";
import {
  CoreError,
  idempotencyKeySchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { and, eq, sql } from "drizzle-orm";
import { paymentAdminIdempotency } from "../db/schema/payment-admin.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./permission-resolver.ts";

/**
 * Keys the system requesters (`system:*`) write under. User keys share the
 * tenant namespace, so a user claiming one first would make the system filer
 * fail with IDEMPOTENCY_KEY_REUSED and its refund would never be filed. Spelled
 * out here because the filer modules import this one (import cycle).
 */
const SYSTEM_KEY_PREFIXES = [
  "pos-late-payment-refund:",
  "qr-late-payment-refund:",
  "pos-refund-gateway:",
  "reservation-refund:",
  "order-recovery-refund:",
  "facility-breakfast-refund:",
  // Re-file after a failed refund (facility-breakfast-money.ts).
  "fb-refile:cancel:",
  "fb-refile:late:",
  // Late WFC pass payment (wfc-payment-consumer.ts).
  "wfc-late-refund:",
];

/** Run inside the mutation's tenant transaction, after authorization. */
export async function idempotentPaymentAdminWrite<T>(
  tx: Tx,
  context: ScopedTenantContext,
  actorId: string,
  key: string,
  operation: string,
  request: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const parsedKey = idempotencyKeySchema.parse(key);
  if (
    !actorId.startsWith("system:") &&
    SYSTEM_KEY_PREFIXES.some((prefix) => parsedKey.startsWith(prefix))
  )
    throw new HttpError(
      422,
      "IDEMPOTENCY_KEY_RESERVED",
      "This idempotency key is reserved for the system. Use another key.",
    );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        operation,
        actorId,
        scope: context.outletScope,
        request,
      }),
    )
    .digest("hex");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.tenant.tenantId}:${parsedKey}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(paymentAdminIdempotency)
    .where(
      and(
        eq(paymentAdminIdempotency.tenantId, context.tenant.tenantId),
        eq(paymentAdminIdempotency.key, parsedKey),
      ),
    );
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key already used for a different request.",
      );
    return existing.response as T;
  }
  const response = await run();
  await tx.insert(paymentAdminIdempotency).values({
    tenantId: context.tenant.tenantId,
    key: parsedKey,
    fingerprint,
    response,
  });
  return response;
}
