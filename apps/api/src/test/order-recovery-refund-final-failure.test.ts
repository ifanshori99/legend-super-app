// legend-iu91r (R2 part 1): a recovery refund (`system:recovery`, ORD-09) that
// ends in a FINAL failure is treated like `rejected`: the money is stuck
// otherwise (journal stays reversed-less, the hold stays released, points stay
// deducted, and a person cannot refund by hand). Final failures:
// `provider_declined`, `cap_exceeded`, `source_document` and the `refile_limit`
// block (3 failed refunds on one issue).
//
// Part 1 (producer; order-recovery world, real outbox): the hook appends the
//   `order_issue.refund_refile_blocked` audit as before AND one
//   `order_issue.refund_reversal_requested` event per issue (only for a QR
//   pay-first refund, which has an `order.refunded`), and the sale holds the
//   money again (`qrSaleInUseOfIntent`, `refundableBalance`). `approval_expired`
//   is re-filed: no reversal, the hold stays released.
// Part 2 (consumer; fresh tenant per case): the reversal request reverses the
//   posted journal `aj:order-refund:<issueId>` (balanced, `reversal_of` = the
//   refund entry) for a refund row failed with each final reason.
// The loyalty consumer needs no change: `refundReversalSchema` carries no
// failure reason, so the points come back through the same
// `restoreRejectedRefund` path (covered by order-recovery-refund-loyalty.test.ts).
// - Guard case (part 2): QR pay_first order 100k + 10k PBJT paid by one intent of
//   110k; the recovery refund is 44k (line 40k + PBJT 4k) as in
//   order-recovery-refund-four-eyes.test.ts (RG-*). After its journal is posted
//   and then reversed, a manual payout of 44k finds the sale fully held again
//   and parks `POSTING_AMOUNTS_MISMATCH` (as RG-1). The rejected refund row is
//   seeded `failed` / `rejected`.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import {
  deliverAutoJournalEvent,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  deliverOrderRecoveryRefundEvent,
  refileRecoveryRefundAfterFailure,
} from "../services/order-recovery-refund.ts";
import { refundableBalance } from "../services/payment-admin.service.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import {
  CART_TOTAL,
  PRICES,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

const REVERSAL_EVENT = "order_issue.refund_reversal_requested";
const FINAL_REASONS = [
  "provider_declined",
  "cap_exceeded",
  "source_document",
] as const;

// ============================================================================
// Part 1: a final failure emits the reversal request
// ============================================================================

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";
const ROTI_WANTED = 20_790;

function tenantScope(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** API ids may be ULIDs; the database stores uuids. */
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliverRecovery(event: EventEnvelope) {
  const context = tenantScope(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
}

type Approved = { issueId: string; approvalId: string; event: EventEnvelope };

/** Reports one line as failed and resolves it with an approved ORD-09 refund. */
async function approvedRefund(
  itemId: string,
  lineTotalIdr: number,
): Promise<Approved> {
  const reported = await w.report(itemId);
  expect(reported.status).toBe(201);
  const issueId = reported.body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: lineTotalIdr,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: REASON,
    },
  );
  expect(resolved.status).toBe(200);
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows, "manual_refund_approved event in the outbox").toHaveLength(1);
  return { issueId, approvalId, event: rows[0]!.event };
}

async function paidRotiRefund() {
  const paid = await w.paidOrder();
  const approved = await approvedRefund(paid.roti.id, PRICES.roti);
  return { ...paid, ...approved };
}

async function intentIdOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ payment_intent_id: string | null }>(
    "SELECT payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(orderId)],
  );
  expect(rows[0]!.payment_intent_id, "order has an intent").not.toBeNull();
  return rows[0]!.payment_intent_id!;
}

type RefundRow = {
  id: string;
  amount_idr: number;
  status: string;
  failure_reason: string | null;
};

async function issueRefunds(issueId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, amount_idr::int AS amount_idr, status, failure_reason
     FROM payment_refunds WHERE tenant_id = $1 AND order_issue_id = $2
     ORDER BY created_at, id`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

async function auditCount(issueId: string, action: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [w.tenant.tenantId, action, issueId],
  );
  return Number(rows[0]!.n);
}

async function orderRefundedEvents(orderId: string) {
  return w.outboxRows("order.refunded", orderId);
}

/** `order_issues.refund_rejected_at` (legend-wumm8): set when the refund ended finally. */
async function rejectedAtOf(issueId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ refund_rejected_at: Date | null }>(
    "SELECT refund_rejected_at FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows, "issue row").toHaveLength(1);
  return rows[0]!.refund_rejected_at;
}

/** Reversal requests about one issue (the event carries the issue id). */
async function reversalEvents(issueId: string) {
  return w.outboxRows(REVERSAL_EVENT, issueId);
}

/** Refundable cap and reserved amount of an intent, as the admin module sees them. */
async function holdOf(intentId: string) {
  const context = tenantScope(w.tenant.tenantId);
  return withTenant(db, context, async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      );
    const balance = await refundableBalance(tx, intent!, {
      lockDeposit: false,
    });
    return { cap: Number(balance.cap), reserved: Number(balance.reserved) };
  });
}

/** Ends the refund `failed` as an expired or rejected approval chain does. */
async function failChain(
  refundId: string,
  how: "approval_expired" | "rejected",
) {
  if (how === "approval_expired")
    await owner.query(
      "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
      [w.tenant.tenantId, refundId],
    );
  else
    await owner.query(
      `UPDATE approval_requests
          SET status = 'rejected', decided_by = $3, decided_at = now(), reason = 'Ditolak uji T5'
        WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [w.tenant.tenantId, refundId, w.approverUserId],
    );
  const settled = await settleRefundFromChain(
    tenantScope(w.tenant.tenantId),
    refundId,
  );
  expect(settled.status).toBe("failed");
  expect(settled.failureReason).toBe(how);
}

/** Runs the failure hook on a refund row as `failRefund` does (same transaction shape). */
async function runFailureHook(refundId: string) {
  const context = tenantScope(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    await refileRecoveryRefundAfterFailure(tx, context, row!, new Date());
  });
}

/** Sets the refund `failed` for `reason` by SQL, then runs the hook. */
async function failAndRefile(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId, reason],
  );
  await runFailureHook(refundId);
}

/** A paid open-bill order (no `order.refunded` is ever written for it). */
async function paidOpenBill() {
  const made = await w.openBillOrder();
  const orderId = toUuid(made.order.id);
  const { rows } = await owner.query<{ outlet_id: string }>(
    "SELECT outlet_id FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId],
  );
  const outletId = rows[0]!.outlet_id;
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, '94q2l-test')`,
    [
      linkId,
      w.tenant.tenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `OB-${linkId.slice(0, 8)}`,
      CART_TOTAL,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid',
             '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
             now() + interval '1 hour', now())`,
    [
      intentId,
      w.tenant.tenantId,
      outletId,
      linkId,
      orderId,
      CART_TOTAL,
      `ob-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [w.tenant.tenantId, outletId, intentId, `evidence-${intentId}`, CART_TOTAL],
  );
  await owner.query(
    "UPDATE orders SET payment_intent_id = $3 WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId, intentId],
  );
  const approved = await approvedRefund(made.roti.id, PRICES.roti);
  return { ...made, intentId, ...approved };
}

describe("legend-iu91r R2 final failure of a recovery refund: the reversal request", () => {
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'refund', 0, $2, 1)`,
      [w.tenant.tenantId, w.ids.supervisorRole],
    );
  });

  /** A delivered recovery refund (pending, chain open) of a failed roti, QR pay-first. */
  async function deliveredRefund() {
    const made = await paidRotiRefund();
    const intentId = await intentIdOf(made.order.id);
    await deliverRecovery(made.event);
    const refunds = await issueRefunds(made.issueId);
    expect(refunds).toHaveLength(1);
    return { ...made, intentId, first: refunds[0]! };
  }

  /** Expires the chain of each refund in turn: 3 failures end in `refile_limit`. */
  async function failUntilLimit(issueId: string) {
    let lastFailedId = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pending = (await issueRefunds(issueId)).filter(
        (row) => row.status === "pending",
      );
      expect(pending, `live refund before failure ${attempt}`).toHaveLength(1);
      lastFailedId = pending[0]!.id;
      await failChain(lastFailedId, "approval_expired");
    }
    return lastFailedId;
  }

  it.each(FINAL_REASONS)(
    "FF-1 %s: one reversal request with the strict payload, the audit stays, no re-file",
    async (reason) => {
      const { order, issueId, first } = await deliveredRefund();
      expect(await reversalEvents(issueId)).toHaveLength(0);

      await failAndRefile(first.id, reason);

      const events = await reversalEvents(issueId);
      expect(events, "reversal request in the outbox").toHaveLength(1);
      const event = events[0]!.event;
      expect(event.name).toBe(REVERSAL_EVENT);
      expect(event.aggregateType).toBe("order_issue");
      expect(event.aggregateId).toBe(issueId);
      const payload = event.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        "amountIdr",
        "orderId",
        "orderIssueId",
        "refundId",
        "rejectedAt",
      ]);
      expect(toUuid(payload.orderId as string)).toBe(toUuid(order.id));
      expect(payload.orderIssueId).toBe(issueId);
      expect(payload.refundId).toBe(first.id);
      expect(payload.amountIdr).toBe(ROTI_WANTED);
      expect(
        await auditCount(issueId, "order_issue.refund_refile_blocked"),
      ).toBe(1);
      expect(await auditCount(issueId, "order_issue.refund_refiled")).toBe(0);
      expect(await issueRefunds(issueId)).toHaveLength(1);
      expect(await orderRefundedEvents(order.id)).toHaveLength(1);
    },
  );

  it.each(FINAL_REASONS)(
    "FF-2 %s: the failure path runs again on the same refund: still one reversal request",
    async (reason) => {
      const { issueId, first } = await deliveredRefund();
      await failAndRefile(first.id, reason);
      expect(await reversalEvents(issueId)).toHaveLength(1);

      await runFailureHook(first.id);

      expect(await reversalEvents(issueId)).toHaveLength(1);
      expect(await issueRefunds(issueId)).toHaveLength(1);
    },
  );

  it.each(FINAL_REASONS)(
    "FF-3 %s: hold, the sale holds its money again, the refundable cap drops by the refund",
    async (reason) => {
      const { intentId, first } = await deliveredRefund();
      expect(await holdOf(intentId)).toEqual({
        cap: ROTI_WANTED,
        reserved: ROTI_WANTED,
      });

      await failAndRefile(first.id, reason);

      expect(await holdOf(intentId)).toEqual({ cap: 0, reserved: 0 });
    },
  );

  it("FF-4 refile_limit: the third failure is final, one reversal request, hold back on the sale", async () => {
    const { issueId, intentId } = await deliveredRefund();

    const lastFailedId = await failUntilLimit(issueId);

    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(3);
    expect(refunds.every((row) => row.status === "failed")).toBe(true);
    expect(await auditCount(issueId, "order_issue.refund_refile_blocked")).toBe(
      1,
    );
    const events = await reversalEvents(issueId);
    expect(events, "reversal request in the outbox").toHaveLength(1);
    expect((events[0]!.event.payload as { refundId: string }).refundId).toBe(
      lastFailedId,
    );
    expect(await holdOf(intentId)).toEqual({ cap: 0, reserved: 0 });
  });

  it("FF-5 refile_limit: the first two failures re-file; no reversal and the hold stays released until the third", async () => {
    const { issueId, intentId } = await deliveredRefund();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const pending = (await issueRefunds(issueId)).filter(
        (row) => row.status === "pending",
      );
      await failChain(pending[0]!.id, "approval_expired");
      expect(await reversalEvents(issueId)).toHaveLength(0);
      expect(await holdOf(intentId)).toEqual({
        cap: ROTI_WANTED,
        reserved: ROTI_WANTED,
      });
    }
    expect(await issueRefunds(issueId)).toHaveLength(3);
  });

  /** After the final failure the line is reported again: a new issue, its own full refund. */
  async function rereportsAndRefunds(
    made: Awaited<ReturnType<typeof deliveredRefund>>,
  ) {
    expect(await rejectedAtOf(made.issueId), "stamped").not.toBeNull();
    const again = await approvedRefund(made.roti.id, PRICES.roti);
    expect(again.issueId).not.toBe(made.issueId);
    await deliverRecovery(again.event);
    const refunds = await issueRefunds(again.issueId);
    expect(refunds, "a refund for the new issue").toHaveLength(1);
    // The failed refund of the old issue released nothing: the full amount is due.
    expect(refunds[0]).toMatchObject({
      amount_idr: ROTI_WANTED,
      status: "pending",
    });
  }

  it.each(FINAL_REASONS)(
    "FF-9 %s: the issue is stamped refund_rejected_at (like rejected) and the line can be reported again for the full amount",
    async (reason) => {
      const made = await deliveredRefund();
      expect(await rejectedAtOf(made.issueId)).toBeNull();

      await failAndRefile(made.first.id, reason);

      await rereportsAndRefunds(made);
    },
  );

  it("FF-10 refile_limit: the issue is stamped refund_rejected_at and the line can be reported again for the full amount", async () => {
    const made = await deliveredRefund();

    await failUntilLimit(made.issueId);

    await rereportsAndRefunds(made);
  });

  it("FF-6 approval_expired with re-file: no reversal request, the hold stays released", async () => {
    const { order, issueId, intentId, first } = await deliveredRefund();

    await failChain(first.id, "approval_expired");

    expect(await issueRefunds(issueId)).toHaveLength(2);
    expect(await reversalEvents(issueId)).toHaveLength(0);
    expect(await auditCount(issueId, "order_issue.refund_refile_blocked")).toBe(
      0,
    );
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
    expect(await rejectedAtOf(issueId)).toBeNull();
    expect(await holdOf(intentId)).toEqual({
      cap: ROTI_WANTED,
      reserved: ROTI_WANTED,
    });
  });

  /** Parks an edge `order.refunded` of the order (brief 1264: drawer cash already paid out). */
  async function parkEdgeRefund(orderId: string) {
    const orderUuid = toUuid(orderId);
    const ulid = uuidToUlid(orderUuid);
    const eventId = createUlid();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [w.tenant.tenantId],
      );
      // The edge node row is not needed to read the parked fact.
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO edge_deferred_events
           (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id,
            aggregate_sequence, event_name, parked_reason, envelope)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'order', $5, 2, 'order.refunded',
           'deferred', $6::jsonb)`,
        [
          w.tenant.tenantId,
          w.tenant.outletId,
          randomUUID(),
          ulidToUuid(eventId),
          ulid,
          JSON.stringify({
            id: eventId,
            name: "order.refunded",
            aggregateType: "order",
            aggregateId: ulid,
            sequence: 2,
            payload: { orderId: ulid },
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("FF-1264 a parked edge order.refunded blocks the delivery: no ORD-09 refund, audit blocked", async () => {
    const made = await paidRotiRefund();
    await parkEdgeRefund(made.order.id);

    await deliverRecovery(made.event);

    expect(await issueRefunds(made.issueId)).toHaveLength(0);
    expect(await auditCount(made.issueId, "order_issue.refund_blocked")).toBe(
      1,
    );
  });

  it("FF-1264 a parked edge order.refunded blocks the re-file: no second refund, final failure", async () => {
    const { order, issueId, first } = await deliveredRefund();
    await parkEdgeRefund(order.id);

    await failChain(first.id, "approval_expired");

    expect(await issueRefunds(issueId)).toHaveLength(1);
    expect(await auditCount(issueId, "order_issue.refund_refile_blocked")).toBe(
      1,
    );
    expect(await auditCount(issueId, "order_issue.refund_refiled")).toBe(0);
  });

  it("FF-7 open bill (no order.refunded), final failure: audit only, no reversal request", async () => {
    const { order, issueId, event } = await paidOpenBill();
    await deliverRecovery(event);
    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);

    await failAndRefile(refunds[0]!.id, "provider_declined");

    expect(await auditCount(issueId, "order_issue.refund_refile_blocked")).toBe(
      1,
    );
    expect(await reversalEvents(issueId)).toHaveLength(0);
    expect(await orderRefundedEvents(order.id)).toHaveLength(0);
    // Stamped all the same, as `rejected` is (RJ-8): the guest got nothing.
    expect(await rejectedAtOf(issueId)).not.toBeNull();
  });
});

// ============================================================================
// Part 2: the auto-journal consumer reverses the refund journal
// ============================================================================

const NOW = new Date("2026-11-08T03:00:00Z");
/** 2026-10-15 12:00 in Jakarta; the order fires and the money arrives here. */
const DAY = "2026-10-15T05:00:00.000Z";
const T_RECOVERY = "2026-10-15T08:00:00.000Z";
const REJECTED_AT = "2026-10-16T09:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

type Role =
  | "gateway_clearing"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue";
const ROLES: Role[] = [
  "gateway_clearing",
  "tax_payable_pbjt",
  "customer_deposit",
  "sales_revenue",
];

const CHART: [Role, string, string, string, string][] = [
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
];

type Tenant = { id: string; brandId: string };
type LedgerWorld = {
  tenant: Tenant;
  entity: string;
  outletId: string;
  accounts: Record<Role, string>;
};

const short = () => randomUUID().slice(0, 6);

function ledgerContext(tenant: Tenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

async function asTenant<T>(
  tenant: Tenant,
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Refund Ditolak', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-rj-${id.slice(0, 8)}`,
      FLAGS_ON,
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, id],
  );
  return { id, brandId };
}

async function makeWorld(tenant: Tenant): Promise<LedgerWorld> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity RJ ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet RJ', 'Jl. RJ', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `RJ-${short()}`.toUpperCase(),
    ],
  );
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.id, entity, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.id, entity, period],
    );
  return { tenant, entity, outletId, accounts };
}

// ---- seeding ----------------------------------------------------------------

/** A paid gateway intent on its own link, with its evidence. */
async function seedPaidIntent(world: LedgerWorld, amountIdr: number) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      world.tenant.id,
      world.outletId,
      randomBytes(32).toString("hex"),
      `RJ-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', $7,
             '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      world.tenant.id,
      world.outletId,
      linkId,
      amountIdr,
      `rj-${intentId}`,
      DAY,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, $6)`,
    [
      world.tenant.id,
      world.outletId,
      intentId,
      `rj-ref-${intentId}`,
      amountIdr,
      DAY,
    ],
  );
  return { linkId, intentId };
}

/** A fired QR pay-first order of 100k + 10k PBJT (due 110k), pinned to the intent. */
async function seedQrOrder(
  world: LedgerWorld,
  linkId: string,
  intentId: string,
): Promise<{ orderUlid: string; orderUuid: string }> {
  const orderUlid = createUlid();
  const orderUuid = ulidToUuid(orderUlid);
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          prices_include_tax, status, business_date, placed_at, fired_at,
          deposit_applied_idr, payment_link_id, payment_link_token_sealed, payment_intent_id)
       VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 100000, 0, 0, 10000, 0, 110000,
               false, 'sent', '2026-10-15', now(), $5, 0, $6, 'sealed', $7)`,
      [
        orderUuid,
        world.tenant.id,
        world.outletId,
        `QR-${short()}`,
        DAY,
        linkId,
        intentId,
      ],
    ),
  );
  return { orderUlid, orderUuid };
}

/** A resolved ORD-09 failed-item issue of the order (user and menu FKs skipped). */
async function seedIssue(
  world: LedgerWorld,
  orderUuid: string,
): Promise<string> {
  const itemId = randomUUID();
  const issueId = randomUUID();
  await asTenant(
    world.tenant,
    async (client) => {
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
           quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
           fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, NULL, 'Roti Bakar', 1, 40000, 0, 40000, '[]'::jsonb,
           'fired', 'served', '2026-10-15')`,
        [itemId, world.tenant.id, world.outletId, orderUuid, randomUUID()],
      );
      await client.query(
        `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
           reason_note, reported_by, resolution, approved_by, cost_idr, status, idempotency_key, resolved_at)
         VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Roti habis, refund manual disetujui',
           $6, 'manual_refund', $7, 0, 'resolved', $8, now())`,
        [
          issueId,
          world.tenant.id,
          world.outletId,
          orderUuid,
          itemId,
          randomUUID(),
          randomUUID(),
          `rj-${randomUUID()}`,
        ],
      );
    },
    { replica: true },
  );
  return issueId;
}

/** The recovery refund of the issue, ended `failed` for a final reason (never paid out). */
async function seedFailedRefund(
  world: LedgerWorld,
  intentId: string,
  amountIdr: number,
  issueId: string,
  failureReason: string,
): Promise<string> {
  const refundId = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          failure_reason, requested_by, decided_at, order_issue_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'Refund item gagal (ORD-09)', 'failed', $9,
               'system:recovery', $6, $7, $8::timestamptz)`,
      [
        refundId,
        world.tenant.id,
        world.outletId,
        intentId,
        amountIdr,
        REJECTED_AT,
        issueId,
        T_RECOVERY,
        failureReason,
      ],
    ),
  );
  return refundId;
}

// ---- events -----------------------------------------------------------------

function envelope(
  world: LedgerWorld,
  input: {
    name: string;
    aggregateType: "payment" | "order" | "order_issue";
    aggregateId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  },
): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: input.name,
    version: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: input.occurredAt,
    actor: { type: "system" },
    idempotencyKey: `rj-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paymentPaid(
  world: LedgerWorld,
  intentId: string,
  receivedIdr: number,
) {
  return envelope(world, {
    name: "payment.paid",
    aggregateType: "payment",
    aggregateId: intentId,
    occurredAt: DAY,
    payload: {
      intentId,
      method: "qris",
      provider: "doit",
      receivedIdr,
      paidAt: DAY,
      late: false,
    },
  });
}

/** The order.paid a fired QR order emits: 100k + 10k PBJT, all by the gateway. */
function qrOrderPaid(world: LedgerWorld, orderUlid: string) {
  return envelope(world, {
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: DAY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: 100_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 10_000,
      roundingIdr: 0,
      totalIdr: 110_000,
      paidCashIdr: 0,
      paidGatewayIdr: 110_000,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      paidDepositIdr: 0,
      tenders: [{ method: "qris", amountIdr: 110_000 }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: DAY,
    },
  });
}

/** The order.refunded the recovery writes for an issue (refundId = issue id), 44k. */
function recoveryRefunded(
  world: LedgerWorld,
  orderUlid: string,
  issueId: string,
) {
  return envelope(world, {
    name: "order.refunded",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: T_RECOVERY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      refundId: issueId,
      amountIdr: 44_000,
      reason: "other",
      reasonNote: "Roti habis, refund manual disetujui",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: 40_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 4_000,
      refundCashIdr: 0,
      refundGatewayIdr: 44_000,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "qris", amountIdr: 44_000 }],
      refundedAt: T_RECOVERY,
    },
  });
}

/** The request the rejected branch of the failure hook writes (Putaran 4). */
function reversalRequested(
  world: LedgerWorld,
  orderUlid: string,
  issueId: string,
  refundId: string,
) {
  return envelope(world, {
    name: REVERSAL_EVENT,
    aggregateType: "order_issue",
    aggregateId: issueId,
    occurredAt: REJECTED_AT,
    payload: {
      orderId: orderUlid,
      orderIssueId: issueId,
      refundId,
      amountIdr: 44_000,
      rejectedAt: REJECTED_AT,
    },
  });
}

function deliver(
  tenant: Tenant,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = ledgerContext(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

async function post(world: LedgerWorld, event: EventEnvelope) {
  const result = await deliver(world.tenant, event);
  expect(result.status).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  return result;
}

async function balanceOf(world: LedgerWorld, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

async function balances(world: LedgerWorld): Promise<Record<Role, number>> {
  const result = {} as Record<Role, number>;
  for (const role of ROLES) result[role] = await balanceOf(world, role);
  return result;
}

async function journalCount(world: LedgerWorld): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
    [world.tenant.id],
  );
  return Number(rows[0]!.n);
}

type Line = { role: Role; debit: number; credit: number };

async function linesOf(world: LedgerWorld, entryId: string): Promise<Line[]> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [world.tenant.id, entryId],
  );
  const roleOf = new Map(
    (Object.entries(world.accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  return rows
    .map((row) => ({
      role: roleOf.get(row.account_id)!,
      debit: Number(row.debit),
      credit: Number(row.credit),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

async function reversalOf(world: LedgerWorld, entryId: string) {
  const { rows } = await owner.query<{
    reversal_of: string | null;
    source_type: string;
  }>(
    "SELECT reversal_of, source_type FROM journal_entries WHERE tenant_id = $1 AND id = $2",
    [world.tenant.id, entryId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("legend-iu91r R2 the refund journal of a finally failed recovery refund is reversed", () => {
  beforeAll(() => {
    setAuditWriter(coreAuditWriter);
  });
  afterAll(() => {
    setAuditWriter(null);
  });

  it.each(FINAL_REASONS)(
    "FF-8 %s: the reversal request posts a balanced journal that reverses aj:order-refund:<issueId>, every account back to its pre-refund balance",
    async (reason) => {
      const world = await makeWorld(await makeTenant());
      const { linkId, intentId } = await seedPaidIntent(world, 110_000);
      const { orderUlid, orderUuid } = await seedQrOrder(
        world,
        linkId,
        intentId,
      );
      await post(world, paymentPaid(world, intentId, 110_000));
      await post(world, qrOrderPaid(world, orderUlid));
      const balancesAfterSale = await balances(world);
      const issueId = await seedIssue(world, orderUuid);
      const refundEntry = await post(
        world,
        recoveryRefunded(world, orderUlid, issueId),
      );
      const refundId = await seedFailedRefund(
        world,
        intentId,
        44_000,
        issueId,
        reason,
      );
      const refundLines = await linesOf(world, refundEntry.journalEntryId);
      expect(await balances(world)).not.toEqual(balancesAfterSale);

      const result = await post(
        world,
        reversalRequested(world, orderUlid, issueId, refundId),
      );

      expect(await reversalOf(world, result.journalEntryId)).toEqual({
        reversal_of: refundEntry.journalEntryId,
        source_type: "reversal",
      });
      const reversalLines = await linesOf(world, result.journalEntryId);
      expect(reversalLines).toEqual(
        refundLines.map((line) => ({
          role: line.role,
          debit: line.credit,
          credit: line.debit,
        })),
      );
      const sum = (key: "debit" | "credit") =>
        reversalLines.reduce((total, line) => total + Number(line[key]), 0);
      expect(sum("debit")).toBe(sum("credit"));
      expect(await balances(world)).toEqual(balancesAfterSale);
      // receipt + sale + refund + reversal
      expect(await journalCount(world)).toBe(4);
    },
  );
});
