// 1269 E6 (legend-osqou.27, docs/briefs/1269-e6-keputusan.md): back office
// refunds an edge sale the cloud ingested. The cloud is the only refund ledger
// of that sale; the edge never refunds after payment.
// - Only a refund (full or partial) through the existing POS refund path and
//   approval; no void after payment from back office (D3).
// - The drawer belongs to the edge: the cash part is paid by Finance outside
//   the drawer (bank transfer or petty cash) and stays `requested` until its
//   payment reference is recorded (D1). The card part is refunded at the
//   outlet terminal and stays `requested` until its refund RRN and approval
//   code are recorded; one refund RRN is used once (D2).
// - Only when every part is paid does the refund count as money: then one
//   `order.refunded` (journal) names where the cash came from.
// Written from the decision, before the code. Harness: the real services and
// RLS in the seeded tenant, as edge-order-ingest-guard.test.ts.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  refundPosOrder,
  settlePosRefundPayout,
  voidPosOrderCorrection,
} from "../services/pos-order-corrections.ts";
import {
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

const orders: string[] = [];
const overrides: string[] = [];
let businessDate = "";
let requester: Staff;
let supervisor: Staff;
let finance: Staff;

type Tender = { method: string; provider: string; amountIdr: number };
type Sale = { orderId: string; orderUuid: string; paid: number };

const scope = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const otherTenantScope = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(randomUUID()),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
// Back office: a browser session, no verified device and no drawer.
const backOffice = () => ({
  userId: userIdSchema.parse(requester.userId),
  deviceId: null,
  expectedVersion: null,
});
const financeCaller = () => ({
  userId: userIdSchema.parse(finance.userId),
  deviceId: null,
  expectedVersion: null,
});
const outletA = () => outletIdSchema.parse(seededOutletA);

async function asOwner<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

/** A completed sale the cloud ingested from the edge (ledger `ingested`). */
async function edgeSale(
  tenders: Tender[] = [
    { method: "cash", provider: "manual", amountIdr: 100_000 },
  ],
  ledger: "ingested" | null = "ingested",
): Promise<Sale> {
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  const paid = tenders.reduce((sum, tender) => sum + tender.amountIdr, 0);
  orders.push(orderUuid);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'completed', $6::date, now())`,
      [
        orderUuid,
        seededTenantId,
        seededOutletA,
        `E6-${orderId.slice(-20)}`,
        paid,
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    for (const tender of tenders) {
      const cash = tender.method === "cash";
      await client.query(
        `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
           amount_idr, status, reference, requested_at, resolved_at, received_idr, change_idr)
         VALUES ($1, $2, $3, $4, $5, $6, 'captured', $7, now(), now(), $8, $9)`,
        [
          seededTenantId,
          seededOutletA,
          orderUuid,
          tender.method,
          tender.provider,
          tender.amountIdr,
          `REF-${createUlid()}`,
          cash ? tender.amountIdr : null,
          cash ? 0 : null,
        ],
      );
    }
    if (ledger)
      await client.query(
        `INSERT INTO edge_order_ingests (tenant_id, order_id, outlet_id, paid_event_id, state)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          seededTenantId,
          orderUuid,
          seededOutletA,
          ulidToUuid(createUlid()),
          ledger,
        ],
      );
  });
  return { orderId, orderUuid, paid };
}

async function approval(
  bill: Sale,
  action: "void" | "refund",
  amountIdr: number,
) {
  const overrideId = createUlid();
  const overrideUuid = ulidToUuid(overrideId);
  overrides.push(overrideUuid);
  const reason = "Pelanggan komplain";
  await asOwner((client) =>
    client.query(
      `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method, status,
         requested_by, approved_by, reason, value_idr, object_type, object_id,
         request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'supervisor_pin', 'approved', $5, $6, $7, $8,
         'order', $9, $10, now(), now())`,
      [
        overrideUuid,
        seededTenantId,
        seededOutletA,
        action,
        requester.userId,
        supervisor.userId,
        reason,
        amountIdr,
        bill.orderId,
        pinOverrideFixtureFingerprint({
          requestedBy: requester.userId,
          outletId: seededOutletA,
          action,
          valueIdr: amountIdr,
          reason,
          objectType: "order",
          objectId: bill.orderId,
          approverUserId: supervisor.userId,
        }),
      ],
    ),
  );
  return { overrideId, approvedBy: supervisor.userId };
}

async function refund(bill: Sale, amountIdr: number, key = randomUUID()) {
  const verified = await approval(bill, "refund", amountIdr);
  return refundPosOrder(scope, backOffice(), outletA(), bill.orderId, {
    amountIdr,
    reason: "quality_complaint",
    reasonNote: "Keluhan kualitas",
    idempotencyKey: key,
    overrideId: verified.overrideId,
    approvedBy: verified.approvedBy,
  } as Parameters<typeof refundPosOrder>[4]);
}

type SettleBody = Parameters<typeof settlePosRefundPayout>[5];
function settle(
  bill: Sale,
  refundId: string,
  body: Omit<SettleBody, "idempotencyKey"> & { idempotencyKey?: string },
  options: {
    mfaVerified?: boolean;
    context?: typeof scope;
    outletId?: string;
  } = {},
) {
  return settlePosRefundPayout(
    options.context ?? scope,
    financeCaller(),
    outletIdSchema.parse(options.outletId ?? seededOutletA),
    bill.orderId,
    refundId,
    { idempotencyKey: randomUUID(), ...body } as SettleBody,
    { mfaVerified: options.mfaVerified ?? true },
  );
}

async function state(bill: Sale) {
  const { rows } = await owner.query<{
    refunds: number;
    refundShifts: number;
    voids: number;
    events: number;
    outbox: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2) AS refunds,
       (SELECT count(*)::int FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2 AND shift_id IS NOT NULL) AS "refundShifts",
       (SELECT count(*)::int FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2) AS voids,
       (SELECT count(*)::int FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND type = 'order.refunded') AS events,
       (SELECT count(*)::int FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'order.refunded') AS outbox`,
    [seededTenantId, bill.orderUuid],
  );
  return rows[0]!;
}

async function payoutOf(refundId: string) {
  const { rows } = await owner.query<{
    status: string;
    cash_idr: string;
    edc_idr: string;
    cash_channel: string | null;
    cash_reference: string | null;
    edc_rrn: string | null;
    edc_approval_code: string | null;
  }>(
    `SELECT status, cash_idr::text, edc_idr::text, cash_channel, cash_reference,
            edc_rrn, edc_approval_code
       FROM pos_refund_payouts WHERE tenant_id = $1 AND pos_refund_id = $2`,
    [seededTenantId, refundId],
  );
  return rows;
}

async function refundedEvents(bill: Sale) {
  const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM order_events
      WHERE tenant_id = $1 AND order_id = $2 AND type = 'order.refunded'`,
    [seededTenantId, bill.orderUuid],
  );
  return rows.map((row) => row.payload);
}

beforeAll(async () => {
  const app = createApp();
  requester = await staffWithRole(app, {
    template: "supervisor",
    label: "E6 Back Office",
  });
  supervisor = await staffWithRole(app, {
    template: "supervisor",
    label: "E6 Approver",
  });
  finance = await staffWithRole(app, {
    template: "owner",
    label: "E6 Finance",
  });
  const { rows } = await owner.query<{ business_date: string }>(
    "SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date::text AS business_date",
  );
  businessDate = rows[0]!.business_date;
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    for (const table of [
      "pos_refund_payouts",
      "edge_order_ingests",
      "pos_order_voids",
      "pos_order_refunds",
      "pos_order_tenders",
      "pos_order_approval_uses",
      "order_events",
      "pos_orders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE order_id = ANY($1::uuid[])`,
        [orders],
      );
    await client.query(
      "DELETE FROM domain_event_outbox WHERE aggregate_id = ANY($1::uuid[])",
      [orders],
    );
    await client.query("DELETE FROM pos_overrides WHERE id = ANY($1::uuid[])", [
      overrides,
    ]);
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orders,
    ]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await owner.end();
});

describe("1269 E6 back office refunds an ingested edge sale", () => {
  it("D1 a cash refund without a payment reference stays requested: no drawer, no money event", async () => {
    const bill = await edgeSale();
    const result = await refund(bill, 40_000);
    expect(Number(result.amountIdr)).toBe(40_000);
    expect(await payoutOf(result.id)).toEqual([
      expect.objectContaining({
        status: "requested",
        cash_idr: "40000",
        edc_idr: "0",
        cash_reference: null,
      }),
    ]);
    expect(await state(bill)).toMatchObject({
      refunds: 1,
      refundShifts: 0,
      events: 0,
      outbox: 0,
    });
  });

  it("D1 the payment reference makes the cash part succeeded and books one refund paid from the bank", async () => {
    const bill = await edgeSale();
    const result = await refund(bill, 40_000);
    const key = randomUUID();
    const payout = await settle(bill, result.id, {
      idempotencyKey: key,
      cash: { channel: "bank_transfer", reference: "TRF-20261127-001" },
    });
    expect(payout).toMatchObject({ status: "succeeded" });
    expect(await payoutOf(result.id)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        cash_channel: "bank_transfer",
        cash_reference: "TRF-20261127-001",
      }),
    ]);
    const events = await refundedEvents(bill);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      refundId: result.id,
      amountIdr: 40_000,
      refundCashIdr: 40_000,
      cashPaidFrom: "bank",
    });
    expect((await state(bill)).outbox).toBe(1);
    // A replay (same key) and a repeat with the same values book nothing more.
    await settle(bill, result.id, {
      idempotencyKey: key,
      cash: { channel: "bank_transfer", reference: "TRF-20261127-001" },
    });
    await settle(bill, result.id, {
      cash: { channel: "bank_transfer", reference: "TRF-20261127-001" },
    });
    expect(await refundedEvents(bill)).toHaveLength(1);
  });

  it("D1 petty cash names the petty cash account; a settled part never takes another reference", async () => {
    const bill = await edgeSale();
    const result = await refund(bill, 25_000);
    await settle(bill, result.id, {
      cash: { channel: "petty_cash", reference: "KK-E6-0001" },
    });
    expect((await refundedEvents(bill))[0]).toMatchObject({
      cashPaidFrom: "petty_cash",
    });
    await expect(
      settle(bill, result.id, {
        cash: { channel: "bank_transfer", reference: "TRF-OTHER-01" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "REFUND_PAYOUT_SETTLED" });
    expect(await refundedEvents(bill)).toHaveLength(1);
  });

  it("D1 one payment reference never pays two refunds", async () => {
    const first = await edgeSale();
    const second = await edgeSale();
    const a = await refund(first, 10_000);
    const b = await refund(second, 10_000);
    await settle(first, a.id, {
      cash: { channel: "bank_transfer", reference: "TRF-E6-SAME" },
    });
    await expect(
      settle(second, b.id, {
        cash: { channel: "bank_transfer", reference: "TRF-E6-SAME" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "REFUND_PAYOUT_REFERENCE_USED",
    });
    expect((await payoutOf(b.id))[0]!.status).toBe("requested");
    expect(await refundedEvents(second)).toHaveLength(0);
  });

  it("D2 a card refund stays requested until its RRN and approval code; one refund RRN is used once", async () => {
    const card = [{ method: "edc_card", provider: "edc", amountIdr: 100_000 }];
    const first = await edgeSale(card);
    const second = await edgeSale(card);
    const a = await refund(first, 60_000);
    expect(await payoutOf(a.id)).toEqual([
      expect.objectContaining({
        status: "requested",
        cash_idr: "0",
        edc_idr: "60000",
      }),
    ]);
    expect(await refundedEvents(first)).toHaveLength(0);
    await settle(first, a.id, {
      edc: { rrn: "RRN-5566-77", approvalCode: "AP1234" },
    });
    expect((await payoutOf(a.id))[0]).toMatchObject({
      status: "succeeded",
      edc_rrn: "RRN556677",
      edc_approval_code: "AP1234",
    });
    expect((await refundedEvents(first))[0]).toMatchObject({
      refundEdcIdr: 60_000,
      refundCashIdr: 0,
    });

    const b = await refund(second, 30_000);
    // Same slip, other spelling: still one RRN.
    await expect(
      settle(second, b.id, {
        edc: { rrn: "rrn556677", approvalCode: "AP9999" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "REFUND_PAYOUT_RRN_USED" });
    expect((await payoutOf(b.id))[0]!.status).toBe("requested");
    expect(await refundedEvents(second)).toHaveLength(0);
  });

  it("D2 a mixed cash and card refund books only when both parts are paid", async () => {
    const bill = await edgeSale([
      { method: "cash", provider: "manual", amountIdr: 50_000 },
      { method: "edc_card", provider: "edc", amountIdr: 50_000 },
    ]);
    const result = await refund(bill, 100_000);
    await settle(bill, result.id, {
      cash: { channel: "petty_cash", reference: "KK-E6-MIX-1" },
    });
    expect((await payoutOf(result.id))[0]!.status).toBe("requested");
    expect(await refundedEvents(bill)).toHaveLength(0);
    await settle(bill, result.id, {
      edc: { rrn: "RRN-E6-MIX-1", approvalCode: "MX0001" },
    });
    expect((await payoutOf(result.id))[0]!.status).toBe("succeeded");
    const events = await refundedEvents(bill);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      refundCashIdr: 50_000,
      refundEdcIdr: 50_000,
      cashPaidFrom: "petty_cash",
    });
  });

  it("a part the refund does not have is refused", async () => {
    const bill = await edgeSale();
    const result = await refund(bill, 10_000);
    await expect(
      settle(bill, result.id, {
        edc: { rrn: "RRN-E6-NONE", approvalCode: "NO0001" },
      }),
    ).rejects.toMatchObject({ status: 422, code: "REFUND_PAYOUT_PART_ABSENT" });
    expect((await payoutOf(result.id))[0]!.status).toBe("requested");
  });

  it("a double refund is refused: same key replays, another key beyond what was paid fails", async () => {
    const bill = await edgeSale();
    const key = randomUUID();
    const first = await refund(bill, 60_000, key);
    // The replay needs the same body, so the same approval is sent again.
    const replay = await refundPosOrder(
      scope,
      backOffice(),
      outletA(),
      bill.orderId,
      {
        amountIdr: 60_000,
        reason: "quality_complaint",
        reasonNote: "Keluhan kualitas",
        idempotencyKey: key,
        overrideId: first.overrideId,
        approvedBy: first.approvedBy,
      } as Parameters<typeof refundPosOrder>[4],
    );
    expect(replay.id).toBe(first.id);
    // A requested refund already holds its money: 60 000 + 60 000 > 100 000.
    await expect(refund(bill, 60_000)).rejects.toMatchObject({
      status: 422,
      code: "REFUND_EXCEEDS_PAID",
    });
    expect((await state(bill)).refunds).toBe(1);
  });

  it("a refund above what was paid is refused and writes nothing", async () => {
    const bill = await edgeSale();
    await expect(refund(bill, 150_000)).rejects.toMatchObject({ status: 422 });
    expect(await state(bill)).toMatchObject({ refunds: 0, events: 0 });
  });

  it("D3 a void after payment of an ingested edge sale is refused from back office", async () => {
    const bill = await edgeSale();
    const verified = await approval(bill, "void", bill.paid);
    await expect(
      voidPosOrderCorrection(scope, backOffice(), outletA(), bill.orderId, {
        reason: "customer_cancelled",
        reasonNote: "Pelanggan batal",
        idempotencyKey: randomUUID(),
        overrideId: verified.overrideId,
        approvedBy: verified.approvedBy,
      } as Parameters<typeof voidPosOrderCorrection>[4]),
    ).rejects.toMatchObject({
      status: 409,
      code: "EDGE_ORDER_CORRECTION_BLOCKED",
    });
    expect(await state(bill)).toMatchObject({ voids: 0, refunds: 0 });
  });

  it("a gateway tender of an edge sale is not refunded from back office (no payout path yet)", async () => {
    const bill = await edgeSale([
      { method: "qris", provider: "duitku", amountIdr: 100_000 },
    ]);
    await expect(refund(bill, 10_000)).rejects.toMatchObject({
      status: 409,
      code: "EDGE_REFUND_METHOD_UNSUPPORTED",
    });
    expect((await state(bill)).refunds).toBe(0);
  });

  it("recording a payout needs a second factor on the session", async () => {
    const bill = await edgeSale();
    const result = await refund(bill, 10_000);
    await expect(
      settle(
        bill,
        result.id,
        { cash: { channel: "bank_transfer", reference: "TRF-E6-MFA" } },
        { mfaVerified: false },
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    expect((await payoutOf(result.id))[0]!.status).toBe("requested");
  });

  it("another outlet, another order, another tenant or an unknown refund is 404", async () => {
    const bill = await edgeSale();
    const other = await edgeSale();
    const result = await refund(bill, 10_000);
    const body = {
      cash: { channel: "bank_transfer", reference: "TRF-E6-404" },
    } as const;
    await expect(
      settle(bill, result.id, body, { outletId: seededOutletB }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(settle(other, result.id, body)).rejects.toMatchObject({
      status: 404,
    });
    await expect(settle(bill, randomUUID(), body)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      settle(bill, result.id, body, { context: otherTenantScope }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await payoutOf(result.id))[0]!.status).toBe("requested");
  });

  it("a cloud sale (not ingested) keeps its drawer refund and has no payout row", async () => {
    const bill = await edgeSale(undefined, null);
    await expect(refund(bill, 10_000)).rejects.toMatchObject({
      code: "SHIFT_NOT_OPEN",
    });
    expect((await state(bill)).refunds).toBe(0);
  });
});
