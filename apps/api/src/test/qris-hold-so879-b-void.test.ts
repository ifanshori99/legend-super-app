// legend-5ailc (docs/briefs/so-879-qris-hold-fix.md): voiding an unpaid QR order
// whose split part has a collectible QR must answer 409 QRIS_HOLD_ACTIVE, and
// nothing else may change: items, daily stock, promo usage, refunds, events.
//
// Old behavior: voidAwaitingPaymentOrderTx updated items, released daily stock
// and promo usage, requested refunds, and only then wrote `orders.status`, where
// the 0369 trigger raised a raw 23514 (`QRIS_HOLD_ACTIVE: ...` as a check
// violation). Callers outside HTTP saw that raw database error instead of a
// 409; the transaction rolled back, but the contract was a 500-class error.
//
// Assumptions:
// - The refusal is a PosError/CoreError whose `code` is QRIS_HOLD_ACTIVE and
//   whose `status` (when present) is 409; a raw pg error (code 23514) fails.
// - "Nothing changed" = every tenant table whose name mentions order, stock,
//   usage, promo, voucher, redemption, refund, outbox or tender has the same
//   rows (hashed whole rows) before and after the refused void.
// - The QR order is a guest order awaiting payment; the hold comes from a split
//   part's QR (the only guest QR that creates a hold).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { voidUnpaidQrOrder } from "../services/qr-order.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  assertInvariants,
  holdFixture,
  readHold,
  refundsOfIntent,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so879-void");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

/** Hash of every row of the tenant in the money/stock/promo/event tables. */
async function snapshot() {
  const client: PoolClient = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    const { rows: tables } = await client.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema=c.table_schema AND t.table_name=c.table_name
        WHERE c.table_schema='public' AND c.column_name='tenant_id'
          AND t.table_type='BASE TABLE'
          AND c.table_name ~ '(order|stock|usage|promo|voucher|redemption|refund|outbox|tender|payment_intent|bill_split)'
        ORDER BY c.table_name`,
    );
    const result: Record<string, string> = {};
    for (const { table_name } of tables) {
      const { rows } = await client.query<{ h: string }>(
        `SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h
           FROM "${table_name}" x WHERE tenant_id=$1`,
        [fx.tenant.tenantId],
      );
      result[table_name] = rows[0]!.h;
    }
    await client.query("ROLLBACK");
    return result;
  } finally {
    client.release();
  }
}

async function splitWithQr() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const split = await fx.guestPost(guest, "/splits", {
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  const parts = split.body.data.splits as { id: string; amountIdr: number }[];
  const paid = await fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: parts[0]!.id },
    method: "qris",
    payerSecret: secretFor(parts[0]!.id),
    idempotencyKey: randomUUID(),
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  return { order, intentId: paid.body.data.id as string, parts };
}

describe("legend-5ailc void of an unpaid QR order while a split QR is collectible", () => {
  it("5ailc-1 the void answers 409 QRIS_HOLD_ACTIVE (not a raw 23514) and items, stock, promo, refunds and events are untouched", async () => {
    const { order, intentId } = await splitWithQr();
    expect((await readHold(fx, order.id))?.state).toBe("open");
    const before = await snapshot();

    const failure = await voidUnpaidQrOrder(fx.context, order.id, {
      reason: "Staf membatalkan pesanan",
      actorUserId: fx.staff.userId,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(
      failure,
      "void of a bill with a collectible QR must be refused",
    ).not.toBeNull();
    const e = failure as { code?: unknown; status?: unknown; message?: string };
    expect(e.code, String(e.message)).toBe("QRIS_HOLD_ACTIVE");
    expect(e.code).not.toBe("23514");
    if (e.status !== undefined) expect(e.status).toBe(409);

    expect(await snapshot(), "refused void must roll back everything").toEqual(
      before,
    );
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM orders WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(rows[0]?.status).toBe("awaiting_payment");
    const items = await owner.query<{ status: string }>(
      "SELECT status FROM order_items WHERE tenant_id=$1 AND order_id=$2",
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(items.rows.map((r) => r.status)).not.toContain("voided");
    // The customer's QR is still collectible and nobody is refunded.
    expect((await readHold(fx, order.id))?.state).toBe("open");
    expect(await refundsOfIntent(fx, intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });

  it("5ailc-2 a second refused void is the same 409 and still changes nothing", async () => {
    const { order } = await splitWithQr();
    const before = await snapshot();
    for (let i = 0; i < 2; i += 1) {
      const failure = await voidUnpaidQrOrder(fx.context, order.id, {
        reason: "Coba lagi",
        actorUserId: fx.staff.userId,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect((failure as { code?: unknown } | null)?.code).toBe(
        "QRIS_HOLD_ACTIVE",
      );
    }
    expect(await snapshot()).toEqual(before);
  });
});
