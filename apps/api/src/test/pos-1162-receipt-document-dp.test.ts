// legend-j772n: receipt, kuitansi, invoice and PDF of a COMPLETED POS order whose
// bill was settled partly or wholly by a reservation DP (`orders.deposit_applied_idr`).
// Before, checkDocumentTotals demanded sum(tenders) === total, so every such
// sale failed to produce a document (ZodError on `tenders`).
//
// Assumptions (the card text and docs/CONTRACT.md name no wire shape):
// - The document carries `depositAppliedIdr` (additive, optional, default 0).
// - It balances as sum(tenders) + depositAppliedIdr === totalIdr. DP is a bucket
//   of its own, never a tender row: no cash row for the DP amount, and the cash
//   tender stays at total - DP (payment is not counted twice).
// - A DP-only sale (DP === total) has no tender rows: the document builds with
//   `tenders: []` (the shared schema relaxes min(1) only when DP covers the total).
// - The PDF is uncompressed text: it shows the DP amount (formatRupiah) next to
//   the word "DP"; the cash amount shown is the remainder, not the total.
// - World, order and receipt setup follow order-recovery-swap-pos-receipt.test.ts.
//   The order gets its DP by owner SQL while still open; the captured cash
//   tender (when any) is total - DP.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/pos-1162-receipt-document-dp.test.ts" pnpm test

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  createPosOrder as createPosOrderContract,
  formatReceiptNumber,
} from "@starter/shared/pos";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createPosOrder } from "../services/pos-order.service.ts";
import {
  createInvoice,
  getInvoicePdf,
  getReceiptDocument,
  getReceiptPdf,
} from "../services/pos-receipt-delivery.service.ts";
import { formatRupiah } from "../services/pos-receipt-pdf.ts";
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const OUTLET_SNAPSHOT = JSON.stringify({
  outletName: "Cafe Legend Senopati",
  outletAddress: "Jl. Kopi Legenda No. 12, Jakarta Selatan",
  legalName: null,
  npwpLast4: null,
});

beforeAll(async () => {
  w = await createWorld();
  setAuditWriter(coreAuditWriter);
}, 120_000);

afterAll(async () => {
  setAuditWriter(null);
  await w.teardown();
});

// ---- helpers ---------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}
const outletId = () => outletIdSchema.parse(w.tenant.outletId);
const caller = () => ({ userId: userIdSchema.parse(w.floorStaff.userId) });

/** Order total in rupiah, read back from the order the service priced. */
async function totalOf(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT total_idr::text AS total FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return Number(rows[0]!.total);
}

/**
 * A completed POS order with a real receipt. `deposit` is applied while the
 * order is open (or `"all"` for the whole total); a captured cash tender
 * settles total - DP (no tender row when that is 0).
 */
async function completedOrder(deposit: number | "all") {
  const input = createPosOrderContract.body.parse({
    idempotencyKey: randomUUID(),
    channel: "pos",
    serviceType: "dine_in",
    items: [
      { menuItemId: w.ids.roti, quantity: 1, modifierIds: [] },
      { menuItemId: w.ids.kopi, quantity: 1, modifierIds: [] },
    ],
  });
  const created = await createPosOrder(
    context(),
    {
      userId: userIdSchema.parse(w.floorStaff.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletId(),
    input,
  );
  const orderId = created.id as string;
  const orderUuid = toUuid(orderId);
  const total = await totalOf(orderId);
  const dp = deposit === "all" ? total : deposit;
  expect(dp, "setup: DP must fit the order total").toBeLessThanOrEqual(total);

  if (dp > 0)
    await owner.query(
      `UPDATE orders SET deposit_applied_idr = $3
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, orderUuid, dp],
    );
  await owner.query(
    `UPDATE orders SET status = 'completed', payment_mode = 'pay_first'
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, orderUuid],
  );
  if (total - dp > 0)
    await owner.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr,
          change_idr, status, requested_at, resolved_at)
       SELECT tenant_id, outlet_id, id, 'cash', 'manual', $3::bigint, $3::bigint, 0,
              'captured', now(), now()
       FROM orders WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, orderUuid, total - dp],
    );

  const sequenceId = randomUUID();
  const deviceId = randomUUID();
  const prefix = `S${randomUUID().slice(0, 4).toUpperCase()}`;
  await owner.query(
    `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [sequenceId, w.tenant.tenantId, w.tenant.outletId, deviceId, prefix],
  );
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO pos_receipts
       (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number,
        status, issued_at, outlet_snapshot)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, 1, 'issued', now(), $7::jsonb)
     RETURNING id`,
    [
      w.tenant.tenantId,
      w.tenant.outletId,
      orderUuid,
      sequenceId,
      deviceId,
      formatReceiptNumber(prefix, 1),
      OUTLET_SNAPSHOT,
    ],
  );
  return { orderId, total, dp, receiptId: rows[0]!.id };
}

type DocumentLike = {
  totalIdr: number;
  depositAppliedIdr: number;
  tenders: { method: string; amountIdr: number }[];
};

/** Totals balance, DP is its own bucket, and no payment is counted twice. */
function expectBalanced(doc: DocumentLike, total: number, dp: number) {
  expect(doc.totalIdr).toBe(total);
  expect(doc.depositAppliedIdr).toBe(dp);
  const tendered = doc.tenders.reduce((sum, t) => sum + t.amountIdr, 0);
  expect(tendered + doc.depositAppliedIdr, "tenders + DP = total").toBe(total);
  // The tenders settle only the rest: never the DP, never the whole total.
  expect(tendered).toBe(total - dp);
  // DP is not a payment method: no tender row stands for it.
  for (const tender of doc.tenders)
    expect(["cash", "qris", "va", "ewallet", "card", "edc_card"]).toContain(
      tender.method,
    );
  if (dp > 0 && total - dp > 0)
    expect(doc.tenders, "DP must not appear as a cash row").not.toContainEqual(
      expect.objectContaining({ method: "cash", amountIdr: dp }),
    );
}

const pdfText = (pdf: Buffer) => pdf.toString("latin1");

// ---- tests -----------------------------------------------------------------

describe("legend-j772n dokumen POS dengan DP", () => {
  it("dibayar penuh tanpa DP: dokumen seperti biasa, DP 0", async () => {
    const order = await completedOrder(0);
    const doc = await getReceiptDocument(
      context(),
      outletId(),
      order.receiptId,
    );
    expectBalanced(doc, order.total, 0);
    expect(doc.tenders).toHaveLength(1);
    const pdf = pdfText(
      (await getReceiptPdf(context(), outletId(), order.receiptId, "receipt"))
        .pdf,
    );
    expect(pdf).toContain(formatRupiah(order.total));
  });

  it("DP sebagian: struk dan kuitansi tersusun, tender hanya sisa", async () => {
    const order = await completedOrder(10_000);
    for (const kind of ["receipt", "kuitansi"] as const) {
      const doc = await getReceiptDocument(
        context(),
        outletId(),
        order.receiptId,
        kind,
      );
      expect(doc.documentKind).toBe(kind);
      expectBalanced(doc, order.total, 10_000);
    }
  });

  it("DP sebagian: PDF menampilkan DP dan sisa tunai, bukan total sebagai tunai", async () => {
    const order = await completedOrder(10_000);
    const text = pdfText(
      (await getReceiptPdf(context(), outletId(), order.receiptId, "receipt"))
        .pdf,
    );
    expect(text).toContain("DP");
    expect(text).toContain(formatRupiah(10_000));
    expect(text).toContain(formatRupiah(order.total - 10_000));
  });

  it("DP penuh (DP-only): dokumen tersusun tanpa baris tender, PDF memuat DP", async () => {
    const order = await completedOrder("all");
    const doc = await getReceiptDocument(
      context(),
      outletId(),
      order.receiptId,
    );
    expectBalanced(doc, order.total, order.total);
    expect(doc.tenders).toEqual([]);
    const file = await getReceiptPdf(
      context(),
      outletId(),
      order.receiptId,
      "receipt",
    );
    expect(file.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = pdfText(file.pdf);
    expect(text).toContain("DP");
    expect(text).toContain(formatRupiah(order.total));
  });

  it("invoice dengan DP sebagian: total seimbang dan PDF dibuat", async () => {
    const order = await completedOrder(10_000);
    const invoice = await createInvoice(
      context(),
      caller(),
      outletId(),
      order.orderId,
      {
        billedTo: { name: "PT Uji Legend", address: "Jl. Uji No. 1, Jakarta" },
        dueDate: "2026-12-31",
        idempotencyKey: randomUUID(),
      },
    );
    expect(invoice.documentKind).toBe("invoice");
    expectBalanced(invoice, order.total, 10_000);
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM pos_invoices WHERE tenant_id = $1 AND order_id = $2`,
      [w.tenant.tenantId, toUuid(order.orderId)],
    );
    expect(rows).toHaveLength(1);
    const file = await getInvoicePdf(context(), outletId(), rows[0]!.id);
    expect(file.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfText(file.pdf)).toContain(formatRupiah(10_000));
  });

  it("invoice DP-only: total seimbang tanpa tender", async () => {
    const order = await completedOrder("all");
    const invoice = await createInvoice(
      context(),
      caller(),
      outletId(),
      order.orderId,
      {
        billedTo: { name: "PT Uji Legend", address: "Jl. Uji No. 1, Jakarta" },
        dueDate: "2026-12-31",
        idempotencyKey: randomUUID(),
      },
    );
    expectBalanced(invoice, order.total, order.total);
    expect(invoice.tenders).toEqual([]);
  });
});
