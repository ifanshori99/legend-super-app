// legend-771dl money guard: a cloud void or refund of an order the cloud ingested
// from an edge sale is refused (HTTP 409 EDGE_ORDER_CORRECTION_BLOCKED). The edge
// already settled that sale (cash, EDC and points paid out there) and the cloud
// holds no drawer or payment ledger for it, so a cloud-side void/refund could pay
// the guest twice. Written from the brief (not the code): the guard applies to
// `edge_order_ingests` rows in state `ingested` or `voided`, for both
// voidPosOrderCorrection and refundPosOrder; an ordinary cloud order, and an
// order whose ledger row is `refused` / `cancelled` (the cloud's own order that
// the edge event could not replace), stays correctable.
//
// Harness: the real services and RLS in the seeded tenant, as in
// pos-void-refund-ceilings.test.ts. The sale rows are inserted directly (like that
// file) and the ledger row is written next to them; the ingest path itself is
// covered by edge-order-ingest.test.ts.
//
// Assumptions: a rejected correction writes no pos_order_voids / pos_order_refunds
// row and spends no approval (pos_order_approval_uses stays empty), as in the
// existing ceiling tests.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  refundPosOrder,
  voidPosOrderCorrection,
} from "../services/pos-order-corrections.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

const orders: string[] = [];
const overrides: string[] = [];
const users: string[] = [];
const deviceId = randomUUID();
let businessDate = "";
let cashier: Staff;
let supervisor: Staff;

type Sale = { orderId: string; orderUuid: string; paid: number };
type LedgerState = "ingested" | "voided" | "refused" | "cancelled";

const scope = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const caller = () => ({
  userId: userIdSchema.parse(cashier.userId),
  deviceId,
  expectedVersion: null,
});

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  replica = false,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

/**
 * A completed POS cash sale. With `ledger`, the cloud's ingest ledger also has a
 * row for it in that state (an edge-paid order the cloud ingested).
 */
async function sale(paid = 100_000, ledger?: LedgerState): Promise<Sale> {
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
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
        `GRD-${orderId.slice(-20)}`,
        paid,
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
         amount_idr, status, reference, requested_at, resolved_at, received_idr, change_idr)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, 'captured', $5, now(), now(), $4, 0)`,
      [seededTenantId, seededOutletA, orderUuid, paid, `REF-${orderId}`],
    );
    if (ledger)
      await client.query(
        `INSERT INTO edge_order_ingests (tenant_id, order_id, outlet_id, paid_event_id, state, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          seededTenantId,
          orderUuid,
          seededOutletA,
          ulidToUuid(createUlid()),
          ledger,
          ledger === "refused" ? "order_exists" : null,
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
  const reason = "Pelanggan salah pesan";
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
        cashier.userId,
        supervisor.userId,
        reason,
        amountIdr,
        bill.orderId,
        pinOverrideFixtureFingerprint({
          requestedBy: cashier.userId,
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

async function voidOrder(bill: Sale) {
  const verified = await approval(bill, "void", bill.paid);
  return voidPosOrderCorrection(
    scope,
    caller(),
    outletIdSchema.parse(seededOutletA),
    bill.orderId,
    {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
      idempotencyKey: randomUUID(),
      overrideId: verified.overrideId,
      approvedBy: verified.approvedBy,
    } as Parameters<typeof voidPosOrderCorrection>[4],
  );
}

async function refund(bill: Sale, amountIdr = 50_000) {
  const verified = await approval(bill, "refund", amountIdr);
  return refundPosOrder(
    scope,
    caller(),
    outletIdSchema.parse(seededOutletA),
    bill.orderId,
    {
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Keluhan kualitas",
      idempotencyKey: randomUUID(),
      overrideId: verified.overrideId,
      approvedBy: verified.approvedBy,
    } as Parameters<typeof refundPosOrder>[4],
  );
}

async function correctionRows(bill: Sale) {
  const { rows } = await owner.query<{
    voids: number;
    refunds: number;
    uses: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2) AS voids,
       (SELECT count(*)::int FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2) AS refunds,
       (SELECT count(*)::int FROM pos_order_approval_uses WHERE tenant_id = $1 AND order_id = $2) AS uses`,
    [seededTenantId, bill.orderUuid],
  );
  return rows[0]!;
}

const NONE = { voids: 0, refunds: 0, uses: 0 };
const BLOCKED = { status: 409, code: "EDGE_ORDER_CORRECTION_BLOCKED" };

/** Issues a receipt for any order on demand, like the real allocator would have. */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let sequence = 0;
  const issue = (orderId: string, outletId: string, at: Date) => {
    const existing = byOrder.get(orderId);
    if (existing) return existing;
    sequence += 1;
    const receipt = {
      id: randomUUID(),
      tenantId: seededTenantId,
      outletId,
      orderId,
      deviceId,
      number: `GRD-${String(sequence).padStart(6, "0")}`,
      sequenceNumber: sequence,
      status: "issued",
      issuedAt: at.toISOString(),
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      reprintCount: 0,
    } as unknown as PosReceipt;
    byOrder.set(orderId, receipt);
    return receipt;
  };
  return {
    async issueForSale(_tx, _context, input) {
      return issue(input.orderId, input.outletId, input.at);
    },
    async findForOrder(_tx, _context, orderId) {
      return issue(orderId, seededOutletA, new Date());
    },
    async voidForOrder(_tx, _context, input) {
      const found = issue(input.orderId, seededOutletA, input.at);
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

beforeAll(async () => {
  const app = createApp();
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Ingest Guard Cashier",
  });
  supervisor = await staffWithRole(app, {
    template: "supervisor",
    label: "Ingest Guard Supervisor",
  });
  users.push(cashier.userId, supervisor.userId);
  setPosReceiptPort(memoryReceiptPort());
  setDeviceOutletResolver(async ({ tenantId, deviceId: id }) =>
    tenantId === seededTenantId && id === deviceId ? seededOutletA : null,
  );
  // A real open drawer with plenty of cash, so only the guard decides.
  const shift = await openPosShift(
    scope,
    { userId: userIdSchema.parse(cashier.userId), deviceId },
    outletIdSchema.parse(seededOutletA),
    { openingFloatIdr: idr(10_000_000), idempotencyKey: randomUUID() },
  );
  const { rows } = await owner.query<{ business_date: string }>(
    "SELECT business_date::text AS business_date FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, shift.id],
  );
  businessDate = rows[0]!.business_date;
});

afterAll(async () => {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM pos_shifts WHERE tenant_id = $1 AND device_id = $2",
      [seededTenantId, deviceId],
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
    await client.query("DELETE FROM pos_overrides WHERE id = ANY($1::uuid[])", [
      overrides,
    ]);
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orders,
    ]);
  }, true);
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("legend-771dl cloud corrections of an ingested edge sale are blocked", () => {
  // 1269 E6 (docs/briefs/1269-e6-keputusan.md): an `ingested` sale is now
  // refunded by back office (edge-sale-back-office-refund.test.ts); a void
  // after payment stays refused (D3), and a voided sale is never refunded.
  it("a cloud refund of an order whose ledger state is voided is refused with 409 EDGE_ORDER_CORRECTION_BLOCKED", async () => {
    const bill = await sale(100_000, "voided");
    await expect(refund(bill)).rejects.toMatchObject(BLOCKED);
    expect(await correctionRows(bill)).toEqual(NONE);
  });

  for (const state of ["ingested", "voided"] as const)
    it(`a cloud void of an order whose ledger state is ${state} is refused with 409 EDGE_ORDER_CORRECTION_BLOCKED`, async () => {
      const bill = await sale(100_000, state);
      await expect(voidOrder(bill)).rejects.toMatchObject(BLOCKED);
      expect(await correctionRows(bill)).toEqual(NONE);
    });

  it("E6 a cloud refund of an ingested order is a back-office refund: no drawer touched", async () => {
    const bill = await sale(100_000, "ingested");
    const result = await refund(bill, 50_000);
    expect(Number(result.amountIdr)).toBe(50_000);
    const { rows } = await owner.query<{ shift_id: string | null }>(
      "SELECT shift_id FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
      [seededTenantId, bill.orderUuid],
    );
    expect(rows).toEqual([{ shift_id: null }]);
  });

  it("the refusal leaves the order completed and a second attempt is refused the same way", async () => {
    const bill = await sale(100_000, "ingested");
    await expect(voidOrder(bill)).rejects.toMatchObject(BLOCKED);
    await expect(voidOrder(bill)).rejects.toMatchObject(BLOCKED);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, bill.orderUuid],
    );
    expect(rows).toEqual([{ status: "completed" }]);
    expect(await correctionRows(bill)).toEqual(NONE);
  });

  it("the void refusal points to the back-office refund and promises no cloud void", async () => {
    const bill = await sale(100_000, "ingested");
    const error = await voidOrder(bill).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/tidak bisa di-void dari pusat/);
    expect(error?.message).toMatch(/refund dari back office/);
    expect(error?.message).not.toMatch(/akan di-?(void|refund)/i);
  });

  it("an ordinary cloud order (no ledger row) can still be refunded", async () => {
    const bill = await sale(100_000);
    const result = await refund(bill, 50_000);
    expect(Number(result.amountIdr)).toBe(50_000);
    expect((await correctionRows(bill)).refunds).toBe(1);
  });

  it("an ordinary cloud order (no ledger row) can still be voided", async () => {
    const bill = await sale(100_000);
    await voidOrder(bill);
    expect((await correctionRows(bill)).voids).toBe(1);
  });

  for (const state of ["refused", "cancelled"] as const)
    it(`an order whose ledger row is ${state} (the cloud's own order) stays refundable and voidable`, async () => {
      const refundable = await sale(100_000, state);
      const result = await refund(refundable, 50_000);
      expect(Number(result.amountIdr)).toBe(50_000);

      const voidable = await sale(100_000, state);
      await voidOrder(voidable);
      expect((await correctionRows(voidable)).voids).toBe(1);
    });

  it("a ledger row of another order does not block this order", async () => {
    await sale(100_000, "ingested");
    const mine = await sale(100_000);
    const result = await refund(mine, 50_000);
    expect(Number(result.amountIdr)).toBe(50_000);
  });
});
