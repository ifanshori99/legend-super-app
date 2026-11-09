// `Idempotency-Key` for the promo admin commands that create something
// (createPromotion, issueVoucher; bead legend-nloi). Same pattern as
// accounting-ap-fa-shared.ts `idempotentCommand`: the key is bound to a sha256
// fingerprint of the canonical request. The same key with the same body replays
// the stored response; the same key with another body fails 409
// IDEMPOTENCY_KEY_REUSED. A per-(tenant, key) advisory lock serializes two
// concurrent deliveries of one key so the second waits and replays. The row is
// written in the caller's tenant transaction, so command and key commit
// together. Rows are keyed per tenant (primary key includes tenant_id).
//
// A header-less request (`key === null`) just runs the command, as before.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { promoCommandIdempotency } from "../db/schema";
import { HttpError } from "../lib/http-error";
import type { Tx } from "./permission-resolver";

/** Stable JSON: object keys sorted, so the fingerprint ignores key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}

function fingerprintOf(
  tenantId: string,
  operation: string,
  request: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify([tenantId, operation, canonical(request)]))
    .digest("hex");
}

export interface PromoIdempotencyInput<T> {
  /** Validated `Idempotency-Key` header, or null when the client sent none. */
  key: string | null;
  operation: "promotion.create" | "voucher.issue";
  /** The validated request body the key is bound to. */
  request: unknown;
  /** Maps the result to what is stored (e.g. seals a one-time secret). */
  encode?: (result: T) => unknown;
  /** Maps the stored value back to the result. */
  decode?: (stored: unknown) => T;
}

/**
 * Runs `run` at most once per (tenant, key) inside the caller's transaction.
 * Returns the fresh result, or the decoded stored one on a replay.
 */
export async function promoIdempotentCommand<T>(
  tx: Tx,
  context: ScopedTenantContext,
  input: PromoIdempotencyInput<T>,
  run: () => Promise<T>,
): Promise<T> {
  if (input.key === null) return run();
  const tenantId = context.tenant.tenantId;
  const key = input.key;
  const fingerprint = fingerprintOf(tenantId, input.operation, input.request);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`promo-idem:${tenantId}:${key}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(promoCommandIdempotency)
    .where(
      and(
        eq(promoCommandIdempotency.tenantId, tenantId),
        eq(promoCommandIdempotency.key, key),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.operation !== input.operation ||
      existing.fingerprint !== fingerprint
    )
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key sudah dipakai untuk permintaan yang berbeda.",
      );
    return input.decode
      ? input.decode(existing.response)
      : (existing.response as T);
  }
  const result = await run();
  await tx.insert(promoCommandIdempotency).values({
    tenantId,
    key,
    operation: input.operation,
    fingerprint,
    response: (input.encode ? input.encode(result) : result) as object,
  });
  return result;
}
