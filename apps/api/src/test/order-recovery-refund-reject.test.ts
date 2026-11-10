// legend-94q2l Putaran 4 (T5): a recovery refund (`system:recovery`, ORD-09) that
// fails `rejected` is final, so the revenue its `order.refunded` booked is put
// back. Contract: docs/briefs/94q2l-impl-brief.md, section "Putaran 4". Written
// from the contract before the implementation exists, so the file starts red.
//
// Part 1 (producer; the order-recovery world, real outbox): the `rejected`
//   branch of `refileRecoveryRefundAfterFailure` appends one
//   `order_issue.refund_reversal_requested` event per issue (aggregate
//   `order_issue`, aggregateId = issue id, strict payload orderId, orderIssueId,
//   refundId, amountIdr, rejectedAt) when the issue has an `order.refunded`
//   (QR pay-first). Open bill (no `order.refunded`): audit only, no event. The
//   sale hold takes the refunded money back: the refundable cap drops by it.
// Part 2 (consumer; fresh tenant per case, `deliverAutoJournalEvent`): the event
//   reverses the posted journal `aj:order-refund:<issueId>` once; a refund
//   journal that is still pending parks the reversal retryable until the sweep;
//   the `qrSales` payout guard stops counting the refund once reversed.
//
// Assumptions where the brief is not exact:
// - A rejected refund is produced like T3 does it: the approval request of the
//   refund chain is marked rejected, then `settleRefundFromChain` ends the refund
//   `failed` (`failure_reason = 'rejected'`) through `failRefund`. `failed` with
//   another reason is set by SQL and the hook is called as `failRefund` does
//   (T4 helper). The approval policy of the refund chain is inserted here.
// - `payload.orderId` may be a ULID or its uuid (compared as uuid); `refundId` is
//   the uuid of the rejected refund; `rejectedAt` is any ISO-8601 timestamp.
// - Only `rejected` reverses. `approval_expired` re-files (revenue stays reversed
//   for the new refund) and `provider_declined` may mean the money already left,
//   so neither emits a reversal.
// - Running the failure path again for the same rejected refund appends no second
//   reversal event ("append once per issue").
// - The consumer parks a still-pending refund journal retryable under the key
//   `aj:order-refund-reversal:<issueId>` (the parked error code is not asserted:
//   the brief names only the error class `AutoJournalRecoveryRefundPending`).
// - A reversal whose refund journal never existed (not posted, not in the
//   outbox) is `ignored`; the exact replay of a posted reversal is
//   `already_posted` (same as AJ-142-F2a for the void).
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
  retryParkedAutoJournals,
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

// ============================================================================
// Part 1: the rejected branch emits the reversal request
// ============================================================================

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";
const KOPI_LINE = 60_000;
const ROTI_WANTED = 20_790;
const KOPI_WANTED = 69_300;

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

describe("legend-94q2l T5 refund rejected: the reversal request", () => {
  // The refund chain only opens when the tenant has a refund approval policy:
  // one level for every amount, decided by the supervisor role.
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

  it("RJ-1 QR pay-first, rejected: one order_issue.refund_reversal_requested event with the strict payload", async () => {
    const { order, issueId, first } = await deliveredRefund();
    expect(await reversalEvents(issueId)).toHaveLength(0);

    await failChain(first.id, "rejected");

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
    expect(typeof payload.rejectedAt).toBe("string");
    expect(Number.isNaN(Date.parse(payload.rejectedAt as string))).toBe(false);
    expect(payload.rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("RJ-2 rejected: audit order_issue.refund_rejected stays, no re-file, the original order.refunded is the only one", async () => {
    const { order, issueId, first } = await deliveredRefund();

    await failChain(first.id, "rejected");

    expect(await auditCount(issueId, "order_issue.refund_rejected")).toBe(1);
    expect(await auditCount(issueId, "order_issue.refund_refiled")).toBe(0);
    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      id: first.id,
      status: "failed",
      failure_reason: "rejected",
    });
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
    // The reversal request is what undoes it, exactly one.
    expect(await reversalEvents(issueId)).toHaveLength(1);
  });

  it("RJ-3 the failure path runs again on the same rejected refund: still one reversal request", async () => {
    const { issueId, first } = await deliveredRefund();
    await failChain(first.id, "rejected");
    expect(await reversalEvents(issueId)).toHaveLength(1);

    await runFailureHook(first.id);

    expect(await reversalEvents(issueId)).toHaveLength(1);
    expect(await issueRefunds(issueId)).toHaveLength(1);
  });

  it("RJ-4 hold: after rejected the sale holds its money again, the refundable cap drops by the refund", async () => {
    const { intentId, first } = await deliveredRefund();
    // Fired pay-first sale: nothing refundable; the recovery refund released it.
    expect(await holdOf(intentId)).toEqual({
      cap: ROTI_WANTED,
      reserved: ROTI_WANTED,
    });

    await failChain(first.id, "rejected");

    expect(await holdOf(intentId)).toEqual({ cap: 0, reserved: 0 });
  });

  it("RJ-5 two issues on one order: rejecting one reverses only that issue and keeps the hold released for the other", async () => {
    const paid = await w.paidOrder();
    const intentId = await intentIdOf(paid.order.id);
    const kopi = await approvedRefund(paid.kopi.id, KOPI_LINE);
    const roti = await approvedRefund(paid.roti.id, PRICES.roti);
    await deliverRecovery(kopi.event);
    await deliverRecovery(roti.event);
    const kopiRefund = (await issueRefunds(kopi.issueId))[0]!;
    const rotiRefund = (await issueRefunds(roti.issueId))[0]!;
    expect(await holdOf(intentId)).toEqual({
      cap: CART_TOTAL,
      reserved: CART_TOTAL,
    });

    await failChain(rotiRefund.id, "rejected");

    const events = await reversalEvents(roti.issueId);
    expect(events).toHaveLength(1);
    expect((events[0]!.event.payload as { refundId: string }).refundId).toBe(
      rotiRefund.id,
    );
    expect(await reversalEvents(kopi.issueId)).toHaveLength(0);
    expect((await issueRefunds(kopi.issueId))[0]).toMatchObject({
      id: kopiRefund.id,
      status: "pending",
    });
    expect(await holdOf(intentId)).toEqual({
      cap: KOPI_WANTED,
      reserved: KOPI_WANTED,
    });
  });

  it("RJ-6 approval_expired is not final: the refund is re-filed and no reversal is requested", async () => {
    const { order, issueId, first } = await deliveredRefund();

    await failChain(first.id, "approval_expired");

    expect(await issueRefunds(issueId)).toHaveLength(2);
    expect(await reversalEvents(issueId)).toHaveLength(0);
    expect(await auditCount(issueId, "order_issue.refund_rejected")).toBe(0);
    expect(await orderRefundedEvents(order.id)).toHaveLength(1);
  });

  it("RJ-7 provider_declined is final (legend-iu91r): not re-filed, audited as refund_refile_blocked, and the reversal is requested like rejected", async () => {
    const { issueId, first } = await deliveredRefund();

    await failAndRefile(first.id, "provider_declined");

    expect(await reversalEvents(issueId)).toHaveLength(1);
    expect(await auditCount(issueId, "order_issue.refund_rejected")).toBe(0);
  });

  it("RJ-8 open bill (no order.refunded), rejected: audit refund_rejected only, no reversal request", async () => {
    const { order, issueId, event } = await paidOpenBill();
    await deliverRecovery(event);
    const refunds = await issueRefunds(issueId);
    expect(refunds).toHaveLength(1);
    expect(await orderRefundedEvents(order.id)).toHaveLength(0);

    await failChain(refunds[0]!.id, "rejected");

    expect(await auditCount(issueId, "order_issue.refund_rejected")).toBe(1);
    expect(await reversalEvents(issueId)).toHaveLength(0);
    expect(await orderRefundedEvents(order.id)).toHaveLength(0);
    expect(await issueRefunds(issueId)).toHaveLength(1);
  });
});

// ============================================================================
// Part 2: the auto-journal consumer reverses the refund journal
// ============================================================================

const NOW = new Date("2026-11-08T03:00:00Z");
const SWEEP_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
/** 2026-10-15 12:00 in Jakarta; the order fires and the money arrives here. */
const DAY = "2026-10-15T05:00:00.000Z";
const T_RECOVERY = "2026-10-15T08:00:00.000Z";
const REFUND_DAY = "2026-10-16T05:00:00.000Z";
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

/** The recovery refund of the issue, ended `failed` / `rejected` (never paid out). */
async function seedRejectedRefund(
  world: LedgerWorld,
  intentId: string,
  amountIdr: number,
  issueId: string,
): Promise<string> {
  const refundId = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          failure_reason, requested_by, decided_at, order_issue_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'Refund item gagal (ORD-09)', 'failed', 'rejected',
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
      ],
    ),
  );
  return refundId;
}

/** A completed manual gateway payout of the intent (no issue). */
async function seedManualPayout(
  world: LedgerWorld,
  intentId: string,
  amountIdr: number,
): Promise<string> {
  const refundId = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', $6, $6,
               $6::timestamptz - interval '1 minute')`,
      [
        refundId,
        world.tenant.id,
        world.outletId,
        intentId,
        amountIdr,
        REFUND_DAY,
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

function paymentRefunded(
  world: LedgerWorld,
  refundId: string,
  intentId: string,
  amountIdr: number,
) {
  return envelope(world, {
    name: "payment.refunded",
    aggregateType: "payment",
    aggregateId: refundId,
    occurredAt: REFUND_DAY,
    payload: { refundId, paymentIntentId: intentId, amountIdr },
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

/** An event as a pending outbox row ("emitted but not consumed yet"). */
async function seedOutboxEvent(
  world: LedgerWorld,
  event: EventEnvelope,
  aggregateUuid: string,
): Promise<string> {
  const outboxId = randomUUID();
  await owner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'cloud-sync', 'pending')`,
    [
      world.tenant.id,
      outboxId,
      world.outletId,
      randomUUID(),
      event.aggregateType,
      aggregateUuid,
      JSON.stringify(event),
    ],
  );
  return outboxId;
}

async function markDelivered(
  world: LedgerWorld,
  outboxId: string,
): Promise<void> {
  await owner.query(
    "UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now() WHERE tenant_id = $1 AND id = $2",
    [world.tenant.id, outboxId],
  );
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

function sweep(tenant: Tenant) {
  return retryParkedAutoJournals(ledgerContext(tenant), SWEEP_AT);
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

async function parkedOf(tenant: Tenant, idempotencyKey: string) {
  const { rows } = await owner.query<{ retryable: boolean }>(
    "SELECT retryable FROM auto_journal_parked WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenant.id, idempotencyKey],
  );
  return rows;
}

const AMOUNTS_MISMATCH = {
  status: "parked",
  code: "POSTING_AMOUNTS_MISMATCH",
  retryable: false,
} as const;

describe("legend-94q2l T5 the refund journal of a rejected recovery refund is reversed", () => {
  beforeAll(() => {
    setAuditWriter(coreAuditWriter);
  });
  afterAll(() => {
    setAuditWriter(null);
  });

  /** Receipt 110k and the QR sale of 110k are posted; nothing refunded yet. */
  async function sold(tenant?: Tenant) {
    const world = await makeWorld(tenant ?? (await makeTenant()));
    const { linkId, intentId } = await seedPaidIntent(world, 110_000);
    const { orderUlid, orderUuid } = await seedQrOrder(world, linkId, intentId);
    await post(world, paymentPaid(world, intentId, 110_000));
    await post(world, qrOrderPaid(world, orderUlid));
    return { world, intentId, orderUlid, orderUuid };
  }

  /** Sold, plus the posted order.refunded journal of one issue and its rejected refund row. */
  async function refundedAndRejected() {
    const base = await sold();
    const balancesAfterSale = await balances(base.world);
    const issueId = await seedIssue(base.world, base.orderUuid);
    const refundEntry = await post(
      base.world,
      recoveryRefunded(base.world, base.orderUlid, issueId),
    );
    const refundId = await seedRejectedRefund(
      base.world,
      base.intentId,
      44_000,
      issueId,
    );
    return {
      ...base,
      issueId,
      refundId,
      refundEntryId: refundEntry.journalEntryId,
      balancesAfterSale,
    };
  }

  it("RJ-9 the reversal request posts a journal that mirrors the refund journal: reversal_of = the refund entry, debit and credit swapped, every account back to its pre-refund balance", async () => {
    const {
      world,
      orderUlid,
      issueId,
      refundId,
      refundEntryId,
      balancesAfterSale,
    } = await refundedAndRejected();
    // The refund journal moved money: revenue and PBJT are lower than after the sale.
    expect(await balances(world)).not.toEqual(balancesAfterSale);
    const refundLines = await linesOf(world, refundEntryId);

    const result = await post(
      world,
      reversalRequested(world, orderUlid, issueId, refundId),
    );

    expect(await reversalOf(world, result.journalEntryId)).toEqual({
      reversal_of: refundEntryId,
      source_type: "reversal",
    });
    expect(await linesOf(world, result.journalEntryId)).toEqual(
      refundLines.map((line) => ({
        role: line.role,
        debit: line.credit,
        credit: line.debit,
      })),
    );
    expect(await balances(world)).toEqual(balancesAfterSale);
    // receipt + sale + refund + reversal
    expect(await journalCount(world)).toBe(4);
  });

  it("RJ-10 delivered again: no second reversal (exact replay is already_posted; another envelope for the same issue books nothing)", async () => {
    const { world, orderUlid, issueId, refundId, balancesAfterSale } =
      await refundedAndRejected();
    const event = reversalRequested(world, orderUlid, issueId, refundId);
    await post(world, event);

    expect(await deliver(world.tenant, event)).toMatchObject({
      status: "already_posted",
    });
    await deliver(
      world.tenant,
      reversalRequested(world, orderUlid, issueId, refundId),
    );

    expect(await journalCount(world)).toBe(4);
    expect(await balances(world)).toEqual(balancesAfterSale);
  });

  it("RJ-11 the refund journal is still in the outbox: the reversal parks retryable; once the refund journal posts the sweep posts the reversal", async () => {
    const tenant = await makeTenant();
    const { world, intentId, orderUlid, orderUuid } = await sold(tenant);
    const balancesAfterSale = await balances(world);
    const issueId = await seedIssue(world, orderUuid);
    const refundEvent = recoveryRefunded(world, orderUlid, issueId);
    const outboxId = await seedOutboxEvent(world, refundEvent, orderUuid);
    const refundId = await seedRejectedRefund(world, intentId, 44_000, issueId);
    const reversalKey = `aj:order-refund-reversal:${issueId}`;

    const parked = await deliver(
      tenant,
      reversalRequested(world, orderUlid, issueId, refundId),
    );
    expect(parked).toMatchObject({ status: "parked", retryable: true });
    // receipt + sale only
    expect(await journalCount(world)).toBe(2);
    expect(await parkedOf(tenant, reversalKey)).toEqual([
      expect.objectContaining({ retryable: true }),
    ]);

    await markDelivered(world, outboxId);
    await post(world, refundEvent);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await parkedOf(tenant, reversalKey)).toHaveLength(0);
    // receipt + sale + refund + reversal
    expect(await journalCount(world)).toBe(4);
    expect(await balances(world)).toEqual(balancesAfterSale);
  });

  it("RJ-12 a refund journal that never existed (not posted, not in the outbox): the reversal is ignored and books nothing", async () => {
    const { world, intentId, orderUlid, orderUuid } = await sold();
    const issueId = await seedIssue(world, orderUuid);
    const refundId = await seedRejectedRefund(world, intentId, 44_000, issueId);

    expect(
      await deliver(
        world.tenant,
        reversalRequested(world, orderUlid, issueId, refundId),
      ),
    ).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(2);
  });

  it("RJ-13 guard: once the reversal is posted the sale holds its money again, so a manual payout of 44k parks mismatch", async () => {
    const { world, intentId, orderUlid, issueId, refundId } =
      await refundedAndRejected();
    await post(world, reversalRequested(world, orderUlid, issueId, refundId));
    const manual = await seedManualPayout(world, intentId, 44_000);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, manual, intentId, 44_000),
      ),
    ).toEqual(AMOUNTS_MISMATCH);
    // receipt + sale + refund + reversal; the payout parked
    expect(await journalCount(world)).toBe(4);
  });
});
