import { createHash } from "node:crypto";
import {
  CoreError,
  idempotencyKeySchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { and, eq, sql } from "drizzle-orm";
import { paymentAdminIdempotency } from "../db/schema/payment-admin.ts";
import type { Tx } from "./permission-resolver.ts";

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
