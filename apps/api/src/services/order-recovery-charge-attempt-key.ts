// legend-f1mmf (d): the mark a supervisor leaves on a cash or card attempt of
// a dearer-swap charge that never reached the till
// (`order-recovery-charge-pos-resolve.ts`). A row in `pos_order_idempotency`
// (no migration) under a key no POS request can carry: the charge, the method
// and the till's key, hashed to fit the column. Every path that would start
// that attempt late (cash collect, the card start, the EDC agent's
// write-ahead) asks `isAttemptClosed` under its own lock and refuses.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { posOrderIdempotency } from "../db/schema/pos-order.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./menu-internals.ts";

export type ChargeAttemptMethod = "cash" | "edc";

/** `operation` of the closing row; no request is ever made under it. */
export const ATTEMPT_CLOSED_OPERATION = "issue_charge_attempt.resolve";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** `oic-attempt:` + hash of charge, method and key (76 characters). */
export function attemptClosedKey(
  chargeId: string,
  method: ChargeAttemptMethod,
  idempotencyKey: string,
): string {
  return `oic-attempt:${sha256(`${chargeId.toLowerCase()}:${method}:${idempotencyKey}`)}`;
}

export async function isAttemptClosed(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  chargeId: string,
  method: ChargeAttemptMethod,
  idempotencyKey: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: posOrderIdempotency.id })
    .from(posOrderIdempotency)
    .where(
      and(
        eq(posOrderIdempotency.tenantId, tenantId),
        eq(posOrderIdempotency.outletId, outletId),
        eq(
          posOrderIdempotency.key,
          attemptClosedKey(chargeId, method, idempotencyKey),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export const attemptClosedError = () =>
  new HttpError(
    409,
    "CONFLICT",
    "Percobaan pembayaran ini sudah ditutup supervisor; mulai percobaan baru.",
  );

export async function assertAttemptNotClosed(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  chargeId: string,
  method: ChargeAttemptMethod,
  idempotencyKey: string,
): Promise<void> {
  if (
    await isAttemptClosed(
      tx,
      tenantId,
      outletId,
      chargeId,
      method,
      idempotencyKey,
    )
  )
    throw attemptClosedError();
}

/** Inserts the closing row; the caller holds the attempt's locks. */
export async function closeAttempt(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  chargeId: string,
  method: ChargeAttemptMethod,
  idempotencyKey: string,
): Promise<void> {
  const key = attemptClosedKey(chargeId, method, idempotencyKey);
  await tx.insert(posOrderIdempotency).values({
    tenantId,
    outletId,
    key,
    operation: ATTEMPT_CLOSED_OPERATION,
    // Every request's fingerprint is the hash of a JSON object: never this.
    fingerprint: sha256(`${ATTEMPT_CLOSED_OPERATION}:${key}`),
    response: { chargeId, method },
  });
}
