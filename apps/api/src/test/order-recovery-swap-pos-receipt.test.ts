// legend-135b4: receipt, kuitansi, reprint, invoice, PDF and the receipt email
// of a COMPLETED POS order that had a kitchen swap. The consumer
// (order-recovery-swap-kitchen) keeps the old line live and adds the
// replacement line at unit price 0, so buildReceiptDocument used to fail with a
// ZodError on `unitPriceIdr` (posDocumentLineSchema demanded a positive price).
//
// Assumptions where the brief is silent:
// - Same setup as order-recovery-swap-pos-detail.test.ts, but the completed
//   sale gets a REAL pos_receipts row (owner SQL, with its receipt_sequences
//   run) because the documents are built from that table, not from the port
//   stub. A captured cash tender equal to total_idr is inserted by SQL.
// - A baseline document is built BEFORE the swap; if that fails, the setup is
//   wrong (not the swap behavior), and the test says so.
// - Expected replacement line (design 135b4): name `Pengganti: <name of the
//   replacement order line>`, quantity 1, unit price 0, modifiers 0, line
//   total 0. The old line stays in the document with its original price.
// - Subtotal, total and every other amount equal the baseline (the swap adds
//   no charge and no refund).
// - The PDF is uncompressed text, so the label is searched in the raw bytes;
//   only the word "Pengganti" is asserted because a narrow 80mm receipt page
//   may wrap the line after the colon.
// - The email job swallows build errors into a failed/queued delivery row; the
//   test asserts the delivery is `sent` and the provider got one mail.

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
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { FakeEmailProvider } from "@starter/shared/adapters";
import type { EventEnvelope } from "@starter/shared/events";
import {
  createPosOrder as createPosOrderContract,
  formatReceiptNumber,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { createPosOrder } from "../services/pos-order.service.ts";
import {
  createInvoice,
  getInvoicePdf,
  getReceiptDocument,
  getReceiptPdf,
  issueReceiptDeliveries,
} from "../services/pos-receipt-delivery.service.ts";
import { runPosReceiptEmailJob } from "../worker/pos-receipt-email.job.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const stations = { hot: randomUUID(), bar: randomUUID() };
const OUTLET_SNAPSHOT = JSON.stringify({
  outletName: "Cafe Legend Senopati",
  outletAddress: "Jl. Kopi Legenda No. 12, Jakarta Selatan",
  legalName: null,
  npwpLast4: null,
});

beforeAll(async () => {
  w = await createWorld();
  setAuditWriter(coreAuditWriter);
  for (const [id, name, type] of [
    [stations.hot, "Dapur POS Uji", "hot_kitchen"],
    [stations.bar, "Bar POS Uji", "beverage_bar"],
  ] as const)
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
      [id, w.tenant.tenantId, w.tenant.outletId, name, type],
    );
  for (const [menuItemId, stationId, stationType] of [
    [w.ids.roti, stations.hot, "hot_kitchen"],
    [w.ids.kopi, stations.bar, "beverage_bar"],
    [w.ids.teh, stations.bar, "beverage_bar"],
    // rotiLain: deliberately no station.
  ] as const)
    await owner.query(
      `UPDATE menu_items SET station_id = $3, station_type = $4
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, menuItemId, stationId, stationType],
    );
}, 120_000);

afterAll(async () => {
  setAuditWriter(null);
  await w.teardown();
});

// ---- helpers ---------------------------------------------------------------

function contextOf(tenantId: string): ScopedTenantContext {
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
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

const context = () => contextOf(w.tenant.tenantId);
const outletId = () => outletIdSchema.parse(w.tenant.outletId);
const caller = () => ({ userId: userIdSchema.parse(w.floorStaff.userId) });

async function deliver(event: EventEnvelope) {
  const ctx = context();
  return withTenant(db, ctx, (tx) => deliverSwapKitchenEvent(ctx, event, tx));
}

async function resolvedEvent(issueId: string): Promise<EventEnvelope> {
  const rows = await w.outboxRows("order_issue.resolved", issueId);
  expect(rows, "order_issue.resolved event in the outbox").toHaveLength(1);
  return rows[0]!.event;
}

/** A POS dine-in order: roti x1 (18.000) + kopi x1 (25.000), made by the service. */
async function posOrder() {
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
  const { rows } = await owner.query<{ id: string; menu_item_id: string }>(
    `SELECT id, menu_item_id FROM order_items
     WHERE tenant_id = $1 AND order_id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  const rotiRow = rows.find((row) => row.menu_item_id === w.ids.roti)!;
  return { orderId, rotiLineId: uuidToUlid(rotiRow.id) };
}

/**
 * Completes the sale by SQL: status completed, a captured cash tender for the
 * full total, and a real receipt (+ its receipt_sequences run). Returns the
 * receipt id and number.
 */
async function completeWithReceipt(orderId: string) {
  const orderUuid = toUuid(orderId);
  await owner.query(
    `UPDATE orders SET status = 'completed', payment_mode = 'pay_first'
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, orderUuid],
  );
  await owner.query(
    `INSERT INTO pos_order_tenders
       (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr,
        change_idr, status, requested_at, resolved_at)
     SELECT tenant_id, outlet_id, id, 'cash', 'manual', total_idr, total_idr, 0,
            'captured', now(), now()
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, orderUuid],
  );
  const sequenceId = randomUUID();
  const deviceId = randomUUID();
  const prefix = `S${randomUUID().slice(0, 4).toUpperCase()}`;
  const number = formatReceiptNumber(prefix, 1);
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
      number,
      OUTLET_SNAPSHOT,
    ],
  );
  return { receiptId: rows[0]!.id, receiptNumber: number as string };
}

type Variant = {
  label: string;
  replacementItemId: () => string;
  pricier: boolean;
};
const VARIANTS: Variant[] = [
  {
    label: "pengganti lebih mahal",
    replacementItemId: () => w.ids.kopi,
    pricier: true,
  },
  {
    label: "pengganti harga sama",
    replacementItemId: () => w.ids.rotiLain,
    pricier: false,
  },
];

/**
 * A completed POS order with a receipt, a baseline document, then a delivered
 * staff swap of the failed roti.
 */
async function swappedCompletedOrder(variant: Variant) {
  const order = await posOrder();
  const receipt = await completeWithReceipt(order.orderId);

  // Baseline (before the swap). If this fails the test setup is wrong.
  const before = await getReceiptDocument(
    context(),
    outletId(),
    receipt.receiptId,
  );

  const issueId = (await w.report(order.rotiLineId)).body.data.id as string;
  const approvalRequestId = variant.pricier
    ? await w.insertApproval({
        actionType: "price_correction",
        objectType: "order_issue",
        objectId: issueId,
        amountIdr: PRICES.kopi - PRICES.roti,
        status: "approved",
        requestedBy: w.floorStaff.userId,
      })
    : undefined;
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: variant.replacementItemId(),
      ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
    },
  );
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  await deliver(await resolvedEvent(issueId));

  const { rows } = await owner.query<{ name: string; unit_price_idr: number }>(
    `SELECT rep.name, rep.unit_price_idr::int AS unit_price_idr
     FROM order_issues i
     JOIN order_items rep
       ON rep.tenant_id = i.tenant_id AND rep.id = i.replacement_order_item_id
     WHERE i.tenant_id = $1 AND i.id = $2`,
    [w.tenant.tenantId, toUuid(issueId)],
  );
  expect(rows, "replacement line of the swapped issue").toHaveLength(1);
  // Kept final order: the replacement is free.
  expect(rows[0]!.unit_price_idr).toBe(0);
  return {
    ...order,
    ...receipt,
    before,
    replacementName: rows[0]!.name,
    expectedLabel: `Pengganti: ${rows[0]!.name}`,
  };
}

type DocumentLike = {
  items: {
    name: string;
    quantity: number;
    unitPriceIdr: number;
    modifiersTotalIdr: number;
    lineTotalIdr: number;
    swapRole?: string;
  }[];
  subtotalIdr: number;
  totalIdr: number;
  taxIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  roundingIdr: number;
};

function expectSwapDocument(
  after: DocumentLike,
  before: DocumentLike,
  expectedLabel: string,
) {
  const replacement = after.items.find((line) => line.name === expectedLabel);
  expect(
    replacement,
    `line "${expectedLabel}" in ${JSON.stringify(after.items.map((l) => l.name))}`,
  ).toBeDefined();
  expect(replacement).toMatchObject({
    quantity: 1,
    unitPriceIdr: 0,
    modifiersTotalIdr: 0,
    lineTotalIdr: 0,
    swapRole: "replacement",
  });
  // The old line is still on the document with its original price.
  for (const line of before.items)
    expect(after.items).toContainEqual(expect.objectContaining(line));
  expect(after.items).toHaveLength(before.items.length + 1);
  // The swap adds no charge and no refund.
  for (const key of [
    "subtotalIdr",
    "totalIdr",
    "taxIdr",
    "discountIdr",
    "serviceChargeIdr",
    "roundingIdr",
  ] as const)
    expect(after[key], key).toBe(before[key]);
}

const pdfText = (pdf: Buffer) => pdf.toString("latin1");

// ---- tests -----------------------------------------------------------------

describe.each(VARIANTS)(
  "legend-135b4 dokumen POS setelah swap dapur, $label",
  (variant) => {
    it("struk: dokumen tersusun, baris pengganti Rp0 ada, total sama seperti sebelum swap", async () => {
      const order = await swappedCompletedOrder(variant);
      const after = await getReceiptDocument(
        context(),
        outletId(),
        order.receiptId,
      );
      expectSwapDocument(after, order.before, order.expectedLabel);
    });

    it("kuitansi: dokumen tersusun dan memuat baris pengganti Rp0", async () => {
      const order = await swappedCompletedOrder(variant);
      const after = await getReceiptDocument(
        context(),
        outletId(),
        order.receiptId,
        "kuitansi",
      );
      expect(after.documentKind).toBe("kuitansi");
      expectSwapDocument(after, order.before, order.expectedLabel);
    });

    it("cetak ulang struk: berhasil dan memuat baris pengganti", async () => {
      const order = await swappedCompletedOrder(variant);
      const first = await issueReceiptDeliveries(
        context(),
        caller(),
        outletId(),
        order.orderId,
        { deliveries: ["print"], idempotencyKey: randomUUID() },
      );
      expectSwapDocument(first.document, order.before, order.expectedLabel);
      const reprint = await issueReceiptDeliveries(
        context(),
        caller(),
        outletId(),
        order.orderId,
        { deliveries: ["print"], idempotencyKey: randomUUID() },
      );
      expect(reprint.document.reprint).toBe(true);
      expectSwapDocument(reprint.document, order.before, order.expectedLabel);
    });

    it("invoice: dibuat dan PDF-nya memuat baris pengganti, total sama", async () => {
      const order = await swappedCompletedOrder(variant);
      const invoice = await createInvoice(
        context(),
        caller(),
        outletId(),
        order.orderId,
        {
          billedTo: {
            name: "PT Uji Legend",
            address: "Jl. Uji No. 1, Jakarta",
          },
          dueDate: "2026-12-31",
          idempotencyKey: randomUUID(),
        },
      );
      expect(invoice.documentKind).toBe("invoice");
      expectSwapDocument(invoice, order.before, order.expectedLabel);

      const { rows } = await owner.query<{ id: string }>(
        `SELECT id FROM pos_invoices WHERE tenant_id = $1 AND order_id = $2`,
        [w.tenant.tenantId, toUuid(order.orderId)],
      );
      expect(rows).toHaveLength(1);
      const file = await getInvoicePdf(context(), outletId(), rows[0]!.id);
      expect(file.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdfText(file.pdf)).toContain("Pengganti");
    });

    it("PDF struk dan kuitansi: tidak error dan memuat label Pengganti", async () => {
      const order = await swappedCompletedOrder(variant);
      for (const kind of ["receipt", "kuitansi"] as const) {
        const file = await getReceiptPdf(
          context(),
          outletId(),
          order.receiptId,
          kind,
        );
        expect(file.pdf.subarray(0, 5).toString("latin1"), kind).toBe("%PDF-");
        expect(pdfText(file.pdf), kind).toContain("Pengganti");
      }
    });

    it("email struk: pekerjaan kirim berhasil (status sent), satu surel terkirim", async () => {
      const order = await swappedCompletedOrder(variant);
      const address = `swap-${randomUUID().slice(0, 8)}@example.com`;
      await issueReceiptDeliveries(
        context(),
        caller(),
        outletId(),
        order.orderId,
        {
          deliveries: ["email"],
          email: address,
          idempotencyKey: randomUUID(),
        },
      );
      const provider = new FakeEmailProvider();
      await runPosReceiptEmailJob([context()], { email: provider });
      const mine = provider.sent.filter((mail) => mail.to === address);
      expect(mine, "one mail for the swapped order").toHaveLength(1);
      const { rows } = await owner.query<{
        status: string;
        failure_reason: string | null;
      }>(
        `SELECT status, failure_reason FROM pos_receipt_deliveries
         WHERE tenant_id = $1 AND receipt_id = $2 AND channel = 'email'`,
        [w.tenant.tenantId, order.receiptId],
      );
      expect(rows).toEqual([{ status: "sent", failure_reason: null }]);
    });
  },
);
