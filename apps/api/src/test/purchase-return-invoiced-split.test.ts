// Aturan uang 2 (tambahan), docs/briefs/ws-purchasing-apar-design.md §6 and §9:
// how a supplier return is split into "not invoiced yet" (Dr GRNI) and
// "already invoiced" (a debit note that lowers the supplier's debt), and that a
// debit note can never be booked twice or exceed what is still owed. Written
// fail-first from the design contract, not from the implementation. The
// consumer side (the card moves once) is `purchase-return-ap-open-item.test.ts`.
//
// Money rules under test (founder: nobody is paid more, the outlet never loses):
// - Not-invoiced-first: a return first consumes the quantity the supplier has
//   not billed yet; only the rest is a debit note against billed AP.
// - A held invoice is not billed (no AP exists), so it never counts as invoiced.
// - The PPN credited back is proportional to the invoiced part and never
//   exceeds the PPN of the invoice.
// - A return that would debit more than the supplier's outstanding payable for
//   that PO is refused (409), and nothing is left half-recorded.
// - The database refuses a second debit-note settlement of the same return.
//
// Assumptions (the brief does not pin these down):
// - Fixtures are a PO of 10 units at Rp 10.000 fully received; invoices carry
//   PPN at 11% of the PO-priced goods, which is within the 12% cap (K6).
// - The split is read from the persisted return row (`purchase_returns`
//   uninvoiced/invoiced/ppn columns) and from the `purchase_return.recorded`
//   outbox payload; both must agree.
// - PPN is allocated per invoice as invoice.ppn x invoiced value / invoice DPP,
//   HALF_UP, capped so the cumulative PPN never passes the invoice's PPN.
// - A held invoice is made with a PO price +50% (above any tolerance the policy
//   allows: default 0 bp, maximum 1000 bp).
// - "Outstanding payable of the PO" is lowered for the 409 case by writing a
//   payment settlement and `settled_idr` directly as the migration owner (the
//   supplier payment flow is not what is under test here).
// - The 409 code is `PURCHASE_RETURN_EXCEEDS_PAYABLE` (design §8). The same
//   idempotency key is reused after the refusal: it must not stay claimed.
// - Ids of the form ISP-nn name the cases below.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import {
  closeOwner,
  hex,
  invoicePo,
  key,
  owner,
  returnEventPayload,
  returnPo,
  returnRow,
  seedReceivedPo,
  setupApWorld,
  stockOf,
  tenantId,
} from "./purchasing-ap-world.ts";

beforeAll(() => {
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
});

afterEach(() => {
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
});

afterAll(async () => {
  setAuditWriter(null);
  setPurchaseReturnPostingEnabled(null);
  setSupplierInvoicePostingEnabled(null);
  // Ledgers and history are append-only and every world is random: left as is.
  await closeOwner();
});

async function expectSplit(
  returnId: string,
  expected: { uninvoiced: number; invoiced: number; ppn: number },
) {
  const row = await returnRow(returnId);
  expect(row).toMatchObject({
    ...expected,
    value: expected.uninvoiced + expected.invoiced,
  });
  // The event the accounting consumer receives carries the same split.
  expect(await returnEventPayload(returnId)).toMatchObject({
    uninvoicedValueIdr: expected.uninvoiced,
    invoicedValueIdr: expected.invoiced,
    ppnIdr: expected.ppn,
  });
}

describe("§6 not-invoiced-first split of a purchase return", () => {
  it("ISP-01 received 10, invoiced 5, return 3: all not invoiced, no debit note, no PPN", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const invoice = await invoicePo(world, fx, { quantity: 5, ppnIdr: 5_500 });
    expect(invoice.invoice.status).toBe("matched");

    const { purchaseReturn } = await returnPo(world, fx, 3);

    await expectSplit(purchaseReturn.id, {
      uninvoiced: 30_000,
      invoiced: 0,
      ppn: 0,
    });
  });

  it("ISP-02 received 10, invoiced 10, return 3: all invoiced, with proportional PPN", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const invoice = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    expect(invoice.invoice.status).toBe("matched");

    const { purchaseReturn } = await returnPo(world, fx, 3);

    // 11.000 PPN x 30.000 / 100.000 DPP = 3.300.
    await expectSplit(purchaseReturn.id, {
      uninvoiced: 0,
      invoiced: 30_000,
      ppn: 3_300,
    });
  });

  it("ISP-03 received 10, invoiced 8, return 4: 2 units not invoiced, 2 units invoiced with PPN", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    await invoicePo(world, fx, { quantity: 8, ppnIdr: 8_800 });

    const { purchaseReturn } = await returnPo(world, fx, 4);

    // Not invoiced: 4 x 10.000 x 2/4 = 20.000. Invoiced: 20.000, PPN
    // 8.800 x 20.000 / 80.000 = 2.200.
    await expectSplit(purchaseReturn.id, {
      uninvoiced: 20_000,
      invoiced: 20_000,
      ppn: 2_200,
    });
  });

  it("ISP-04 no invoice at all: the whole return is not invoiced", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);

    const { purchaseReturn } = await returnPo(world, fx, 3);

    await expectSplit(purchaseReturn.id, {
      uninvoiced: 30_000,
      invoiced: 0,
      ppn: 0,
    });
  });

  it("ISP-05 a held invoice is not billed: the return stays fully not invoiced", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    // Price +50% over the PO: three-way match fails, the invoice is held and
    // has no AP, so there is nothing a debit note could reduce.
    const held = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
      unitPriceIdr: 15_000,
    });
    expect(held.invoice.status).toBe("held");

    const { purchaseReturn } = await returnPo(world, fx, 3);

    await expectSplit(purchaseReturn.id, {
      uninvoiced: 30_000,
      invoiced: 0,
      ppn: 0,
    });
  });

  it("ISP-06 cumulative PPN of several returns never passes the invoice's PPN", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world, { quantity: 3 });
    // DPP 30.000, PPN 3.302 (within 12%). Each unit is 1.100,67: rounded half
    // up 1.101 three times would be 3.303, one rupiah too much.
    await invoicePo(world, fx, { quantity: 3, ppnIdr: 3_302 });

    let ppnTotal = 0;
    for (let index = 0; index < 3; index += 1) {
      const { purchaseReturn } = await returnPo(world, fx, 1);
      const row = await returnRow(purchaseReturn.id);
      expect(row.invoiced).toBe(10_000);
      ppnTotal += row.ppn;
    }

    expect(ppnTotal).toBe(3_302);
  });
});

describe("§6 a return larger than the outstanding payable is refused", () => {
  it("ISP-07 409 PURCHASE_RETURN_EXCEEDS_PAYABLE, nothing is recorded, the key is reusable", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const invoice = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    expect(invoice.invoice.payableIdr).toBe(111_000);
    // The outlet already paid 61.000: only 50.000 is still owed on this PO.
    await owner.query(
      `UPDATE accounting_open_items SET settled_idr = 61000
        WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
      [tenantId, invoice.invoice.id],
    );
    await owner.query(
      `INSERT INTO accounting_open_item_settlements (tenant_id, kind, open_item_id, method, settled_on, amount_idr)
       VALUES ($1, 'payable', $2, 'payment', $3, 61000)`,
      [tenantId, invoice.invoice.id, fx.receivedOn],
    );
    const sameKey = key();
    const stockBefore = await stockOf(fx.locationId, fx.itemId);

    // 5 units are all invoiced: 50.000 + 5.500 PPN = 55.500 > 50.000 owed.
    await expect(returnPo(world, fx, 5, sameKey)).rejects.toMatchObject({
      status: 409,
      code: "PURCHASE_RETURN_EXCEEDS_PAYABLE",
    });

    const { rows: returns } = await owner.query(
      "SELECT 1 FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
      [tenantId, fx.receiptId],
    );
    expect(returns).toHaveLength(0);
    const { rows: events } = await owner.query(
      `SELECT 1 FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'purchase_return.recorded'
          AND event->'payload'->>'supplierId' = $2`,
      [tenantId, world.supplierId],
    );
    expect(events).toHaveLength(0);
    expect(await stockOf(fx.locationId, fx.itemId)).toBe(stockBefore);

    // A return within what is owed goes through, with the same key: the
    // refusal left no idempotency claim behind.
    const ok = await returnPo(world, fx, 2, sameKey);
    expect(await returnRow(ok.purchaseReturn.id)).toMatchObject({
      invoiced: 20_000,
      ppn: 2_200,
    });
  });
});

describe("§6 the database refuses a second debit note of the same return", () => {
  async function openItem(settled: number): Promise<string> {
    const id = randomUUID();
    const { rows: entity } = await owner.query<{ id: string }>(
      "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
      [tenantId, `Entity ISP ${hex()}`],
    );
    await owner.query(
      `INSERT INTO accounting_open_items
         (tenant_id, kind, id, legal_entity_id, outlet_id, counterparty_type, counterparty_id,
          counterparty_name, document_number, document_date, due_on, original_idr, settled_idr)
       VALUES ($1, 'payable', $2, $3, NULL, 'supplier', $4, 'Pemasok ISP', $5, '2026-10-01', '2026-10-31', 1000000, $6)`,
      [tenantId, id, entity[0]!.id, randomUUID(), `INV-${hex()}`, settled],
    );
    return id;
  }

  const insertSettlement = (
    openItemId: string,
    method: string,
    sourceId: string | null,
  ) =>
    owner.query(
      `INSERT INTO accounting_open_item_settlements
         (tenant_id, kind, open_item_id, method, settled_on, amount_idr, source_id)
       VALUES ($1, 'payable', $2, $3, '2026-10-05', 100000, $4)`,
      [tenantId, openItemId, method, sourceId],
    );

  it("ISP-08 the same return cannot debit the same open item twice (unique index)", async () => {
    const itemId = await openItem(100_000);
    const returnId = randomUUID();
    await insertSettlement(itemId, "debit_note", returnId);

    await expect(
      insertSettlement(itemId, "debit_note", returnId),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "accounting_open_item_settlements_debit_note_key",
    });
  });

  it("ISP-09 a debit note always names the return it comes from", async () => {
    const itemId = await openItem(100_000);

    await expect(
      insertSettlement(itemId, "debit_note", null),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("ISP-10 the uniqueness is only for debit notes: other returns and payments are not blocked", async () => {
    const itemId = await openItem(400_000);
    const returnId = randomUUID();
    await insertSettlement(itemId, "debit_note", returnId);
    // Another return on the same open item is a different debit note.
    await insertSettlement(itemId, "debit_note", randomUUID());
    // Two payments that share a source id are not debit notes.
    await insertSettlement(itemId, "payment", returnId);
    await insertSettlement(itemId, "payment", returnId);

    const { rows } = await owner.query(
      "SELECT 1 FROM accounting_open_item_settlements WHERE tenant_id = $1 AND open_item_id = $2",
      [tenantId, itemId],
    );
    expect(rows).toHaveLength(4);
  });
});
