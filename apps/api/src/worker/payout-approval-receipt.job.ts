// Receipts of attested payout steps (bead legend-7gghu; design
// docs/briefs/915/design-7gghu.md "Notifikasi").
//
// `app.payout_attest` writes one append-only row per step to
// `payroll_payout_approval_log`. This sweep (one tenant per call, tenant-wide
// worker context) turns each row into a `payout.step_attested` notification
// event, so the person whose login made the step hears about it outside that
// session:
// - the payload is the log id only; the recipient is re-read from the log by
//   the notification rule, never taken from the event;
// - idempotent: the event id is derived from the log id and a row that already
//   has an event in the outbox is skipped; if the outbox row was deleted before
//   it was delivered the next tick makes it again (same event id, so the
//   notification dedupe key still stops a second notification);
// - bounded: at most 200 rows per tick per tenant, only rows of the last 7
//   days, oldest first;
// - fail closed: an error rolls back the whole tick, the next tick retries it,
//   and it never blocks the other sweeps. The log carries counts only.

import { and, asc, eq, gt, notExists, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  createUlid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { payoutStepAttested } from "@starter/shared/hris/payroll";
import { db } from "../db";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { payrollPayoutApprovalLog } from "../db/schema/payroll-payout.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox } from "../services/core-outbox.ts";

/** The stream the notification consumer reads (rule-based events). */
const RECEIPT_DESTINATION = "notification";

/** Log rows one tick turns into events per tenant. */
export const PAYOUT_APPROVAL_RECEIPTS_PER_TICK = 200;
/** Only rows this young are swept: an old receipt is no longer a warning. */
export const PAYOUT_APPROVAL_RECEIPT_WINDOW_DAYS = 7;

export type PayoutApprovalReceiptResult = {
  /** Events appended this tick. */
  readonly created: number;
};

export async function runPayoutApprovalReceiptSweep(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { limit?: number } = {},
): Promise<PayoutApprovalReceiptResult> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Payout approval receipts require tenant-wide scope");
  const tenantId = context.tenant.tenantId;
  const limit = options.limit ?? PAYOUT_APPROVAL_RECEIPTS_PER_TICK;
  const since = new Date(
    now.getTime() - PAYOUT_APPROVAL_RECEIPT_WINDOW_DAYS * 86_400_000,
  );
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select({ id: payrollPayoutApprovalLog.id })
      .from(payrollPayoutApprovalLog)
      .where(
        and(
          eq(payrollPayoutApprovalLog.tenantId, tenantId),
          gt(payrollPayoutApprovalLog.loggedAt, since),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(domainEventOutbox)
              .where(
                and(
                  eq(domainEventOutbox.tenantId, tenantId),
                  eq(domainEventOutbox.destination, RECEIPT_DESTINATION),
                  eq(
                    domainEventOutbox.aggregateType,
                    payoutStepAttested.entry.aggregateType,
                  ),
                  eq(
                    domainEventOutbox.aggregateId,
                    payrollPayoutApprovalLog.id,
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(
        asc(payrollPayoutApprovalLog.loggedAt),
        asc(payrollPayoutApprovalLog.id),
      )
      .limit(limit);
    for (const row of rows) {
      // One event per log row, so it is always the first of its aggregate.
      const event = payoutStepAttested.envelopeSchema.parse({
        id: uuidToUlid(row.id),
        tenantId,
        outletId: null,
        name: payoutStepAttested.name,
        version: payoutStepAttested.version,
        aggregateType: payoutStepAttested.entry.aggregateType,
        aggregateId: row.id,
        sequence: 1,
        occurredAt: now.toISOString(),
        actor: { type: "system" },
        deviceId: null,
        idempotencyKey: `${payoutStepAttested.name}:${row.id}:1`,
        payloadSchemaRef: payoutStepAttested.payloadSchemaRef,
        payload: { logId: row.id },
      });
      await appendOutbox(tx, context, {
        id: createUlid(now.getTime()),
        event,
        destination: RECEIPT_DESTINATION,
        direction: null,
        peerId: null,
      });
    }
    return { created: rows.length };
  });
}
