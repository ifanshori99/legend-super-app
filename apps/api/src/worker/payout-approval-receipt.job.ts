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
//
// The same sweep also covers the two append-only tables of legend-l2zru
// (design docs/briefs/918/design-l2zru.md "Finance exception dan notifikasi"):
// a row of `payroll_payout_batch_disputes` becomes `payout.batch_disputed
// {disputeId}` and a row of `payroll_payout_batch_unfreezes` becomes
// `payout.batch_unfrozen {unfreezeId}`, with the same rules (id only, event id
// derived from the row id, 200 rows and 7 days per table per tick).

import { and, asc, eq, gt, notExists, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  assertTrustedScopedContext,
  createUlid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  payoutBatchDisputed,
  payoutBatchUnfrozen,
  payoutStepAttested,
} from "@starter/shared/hris/payroll";
import { db } from "../db";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import {
  payrollPayoutApprovalLog,
  payrollPayoutBatchDisputes,
  payrollPayoutBatchUnfreezes,
} from "../db/schema/payroll-payout.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox } from "../services/core-outbox.ts";

/** The stream the notification consumer reads (rule-based events). */
const RECEIPT_DESTINATION = "notification";

/** Rows one tick turns into events per tenant and per source table. */
export const PAYOUT_APPROVAL_RECEIPTS_PER_TICK = 200;
/** Only rows this young are swept: an old receipt is no longer a warning. */
export const PAYOUT_APPROVAL_RECEIPT_WINDOW_DAYS = 7;

export type PayoutApprovalReceiptResult = {
  /** Events appended this tick. */
  readonly created: number;
};

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** One append-only source table and the event it turns into. */
type ReceiptSource = {
  readonly event:
    | typeof payoutStepAttested
    | typeof payoutBatchDisputed
    | typeof payoutBatchUnfrozen;
  readonly idColumn: AnyPgColumn;
  readonly tenantColumn: AnyPgColumn;
  readonly atColumn: AnyPgColumn;
  readonly table:
    | typeof payrollPayoutApprovalLog
    | typeof payrollPayoutBatchDisputes
    | typeof payrollPayoutBatchUnfreezes;
  /** Payload of the event for one row id (the id only, never a recipient). */
  readonly payload: (id: string) => Record<string, string>;
};

const SOURCES: readonly ReceiptSource[] = [
  {
    event: payoutStepAttested,
    table: payrollPayoutApprovalLog,
    idColumn: payrollPayoutApprovalLog.id,
    tenantColumn: payrollPayoutApprovalLog.tenantId,
    atColumn: payrollPayoutApprovalLog.loggedAt,
    payload: (id) => ({ logId: id }),
  },
  {
    event: payoutBatchDisputed,
    table: payrollPayoutBatchDisputes,
    idColumn: payrollPayoutBatchDisputes.id,
    tenantColumn: payrollPayoutBatchDisputes.tenantId,
    atColumn: payrollPayoutBatchDisputes.createdAt,
    payload: (id) => ({ disputeId: id }),
  },
  {
    event: payoutBatchUnfrozen,
    table: payrollPayoutBatchUnfreezes,
    idColumn: payrollPayoutBatchUnfreezes.id,
    tenantColumn: payrollPayoutBatchUnfreezes.tenantId,
    atColumn: payrollPayoutBatchUnfreezes.createdAt,
    payload: (id) => ({ unfreezeId: id }),
  },
];

async function sweepSource(
  tx: Tx,
  context: ScopedTenantContext,
  source: ReceiptSource,
  now: Date,
  since: Date,
  limit: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const rows = await tx
    .select({ id: source.idColumn })
    .from(source.table)
    .where(
      and(
        eq(source.tenantColumn, tenantId),
        gt(source.atColumn, since),
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
                  source.event.entry.aggregateType,
                ),
                eq(domainEventOutbox.aggregateId, source.idColumn as never),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(source.atColumn) as SQL, asc(source.idColumn) as SQL)
    .limit(limit);
  for (const row of rows) {
    const id = String(row.id);
    // One event per source row, so it is always the first of its aggregate.
    const event = source.event.envelopeSchema.parse({
      id: uuidToUlid(id),
      tenantId,
      outletId: null,
      name: source.event.name,
      version: source.event.version,
      aggregateType: source.event.entry.aggregateType,
      aggregateId: id,
      sequence: 1,
      occurredAt: now.toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${source.event.name}:${id}:1`,
      payloadSchemaRef: source.event.payloadSchemaRef,
      payload: source.payload(id),
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination: RECEIPT_DESTINATION,
      direction: null,
      peerId: null,
    });
  }
  return rows.length;
}

export async function runPayoutApprovalReceiptSweep(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { limit?: number } = {},
): Promise<PayoutApprovalReceiptResult> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Payout approval receipts require tenant-wide scope");
  const limit = options.limit ?? PAYOUT_APPROVAL_RECEIPTS_PER_TICK;
  const since = new Date(
    now.getTime() - PAYOUT_APPROVAL_RECEIPT_WINDOW_DAYS * 86_400_000,
  );
  return withTenant(db, context, async (tx) => {
    let created = 0;
    for (const source of SOURCES)
      created += await sweepSource(tx, context, source, now, since, limit);
    return { created };
  });
}
