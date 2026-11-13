// legend-29vw: GRNI (goods received, not invoiced) in the general ledger.
// Written fail-first from the card text (bd show legend-29vw) and the design
// scratchpad design.md sections 2 and 8 (docs/briefs/ws-purchasing-apar-design.md
// for the fixed rules), not from the implementation.
//
// Money rules under test (founder: nobody is paid more, the outlet never loses):
// - A goods receipt journals Dr inventory / Cr GRNI at the received value
//   (through the auto-journal consumer, event `goods_receipt.recorded`), once.
// - A supplier invoice clears GRNI at the PO price (Dr GRNI + Dr PPN input /
//   Cr accounts payable); after receipt + matching invoice, the GRNI balance is
//   zero. A part invoice plus a return of the rest also ends at zero.
// - The invoice price difference goes to `purchase_price_variance`, never to
//   inventory; the payable is what the supplier billed, never more.
// - An invoice or an uninvoiced return on a receipt whose journal is not yet
//   posted is refused (409 GOODS_RECEIPT_NOT_JOURNALED) and writes nothing, so
//   GRNI is never debited without having been credited.
// - Re-sending, re-matching or re-releasing never books a second journal.
//
// Assumptions (the design fixes the contract, a few details are open):
// - "Receipt not yet journaled" is reproduced by seeding the PO while the
//   posting flag is off (the receipt event is then ignored), switching the flag
//   on afterwards and delivering the receipt event by hand when a case needs it.
//   Tests never depend on whether `seedReceivedPo` delivers the receipt event
//   itself: with the flag off it must not post.
// - The receipt journal has idempotency key `aj:goods-receipt:<receiptId>`, the
//   invoice journal `si-post:<invoiceId>` (design 2.2, 2.5).
// - The mapping of role `purchase_price_variance` (account 5105) is added to the
//   test world here when the shared world helper does not have it yet.
// - A price difference of +5% / -5% is "held" at the default 0% tolerance and is
//   released by finance; when a tolerance row of the shared tenant makes it
//   match instead, the invoice is used as it is. Either way the journal rule is
//   the same (design 2.4).
// - PPN is 11% of the PO-priced goods (inside the 12% cap whichever way DPP is
//   read, as in accounting-asset-no-double-ap).
// - The other tenant is refused with 403 or 404 ("tidak bocor"); only the
//   refusal is asserted.
// - Replaying a create with the same idempotency key returns the same invoice.
// - Ids GR-nn name the cases below.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { getAgingReport } from "../services/accounting-open-items.service.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
} from "../services/accounting-auto-journal-consumer.ts";
import {
  createGoodsReceipt,
  type CreateGoodsReceiptInput,
} from "../services/inventory-receiving.service.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import {
  createSupplierInvoice,
  releaseSupplierInvoice,
  rematchSupplierInvoice,
  setSupplierInvoicePostingEnabled,
} from "../services/purchasing-invoice.service.ts";
import {
  addDays,
  apLedger,
  closeOwner,
  hex,
  key,
  outletScope,
  owner,
  returnPo,
  returnRow,
  deliverGoodsReceiptJournal,
  seedReceivedPo,
  setupApWorld,
  stockOf,
  tenantId,
  tenantScope,
  type ApWorld,
  type ReceivedPo,
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

type InvoiceInput = Parameters<typeof createSupplierInvoice>[2];

type Fixture = { world: ApWorld; fx: ReceivedPo; variance: string };

/**
 * A world with one fully received PO (10 units at 10.000, receipt value
 * 100.000) whose receipt event has NOT been journaled yet: it is seeded with
 * the posting flag off, then the flag is switched on.
 */
async function receivedWorld(): Promise<Fixture> {
  setSupplierInvoicePostingEnabled(false);
  try {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const variance = await ensureVarianceAccount(world);
    return { world, fx, variance };
  } finally {
    setSupplierInvoicePostingEnabled(true);
  }
}

/** The account of role `purchase_price_variance` of the entity (5105 if absent). */
async function ensureVarianceAccount(world: ApWorld): Promise<string> {
  const { rows } = await owner.query<{ account_id: string }>(
    `SELECT account_id FROM account_mappings
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'purchase_price_variance'`,
    [tenantId, world.entityId],
  );
  if (rows[0]) return rows[0].account_id;
  const { rows: account } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '5105', 'Selisih Harga Pembelian', 'expense', 'cogs') RETURNING id`,
    [tenantId, world.entityId],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'purchase_price_variance', $3)`,
    [tenantId, world.entityId, account[0]!.id],
  );
  return account[0]!.id;
}

/** The `goods_receipt.recorded` event the receipt wrote to the outbox. */
async function receiptEvent(receiptId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'goods_receipt.recorded'
        AND event->'payload'->>'goodsReceiptId' = $2`,
    [tenantId, receiptId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** The `purchase_return.recorded` event of a return. */
async function returnEvent(returnId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'purchase_return.recorded'`,
    [tenantId, returnId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

const deliver = (
  event: EventEnvelope,
  scope: ScopedTenantContext = tenantScope(),
) =>
  withTenant(db, scope, (tx) =>
    deliverAutoJournalEvent(scope, event, tx, new Date()),
  );

/** Delivers the receipt event and asserts it posted. */
async function journalReceipt(fx: ReceivedPo): Promise<void> {
  expect(await deliver(await receiptEvent(fx.receiptId))).toMatchObject({
    status: "posted",
  });
}

const receiptKey = (fx: ReceivedPo) => `aj:goods-receipt:${fx.receiptId}`;

async function entryIdByKey(
  world: ApWorld,
  idempotencyKey: string,
): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3`,
    [tenantId, world.entityId, idempotencyKey],
  );
  return rows.map((row) => row.id);
}

type Sides = { debit: number; credit: number };

/** Journal lines of an entry summed per account (debit and credit apart). */
async function linesOf(entryId: string): Promise<Map<string, Sides>> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [tenantId, entryId],
  );
  return new Map(
    rows.map((row) => [
      row.account_id,
      { debit: Number(row.debit), credit: Number(row.credit) },
    ]),
  );
}

const side = (lines: Map<string, Sides>, accountId: string): Sides =>
  lines.get(accountId) ?? { debit: 0, credit: 0 };

function expectBalanced(lines: Map<string, Sides>) {
  let debit = 0;
  let credit = 0;
  for (const value of lines.values()) {
    debit += value.debit;
    credit += value.credit;
  }
  expect(debit).toBe(credit);
  expect(debit).toBeGreaterThan(0);
}

/** Credit minus debit of one account (liability reading). */
async function creditBalance(accountId: string): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    `SELECT coalesce(sum(credit_idr - debit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [tenantId, accountId],
  );
  return Number(rows[0]!.balance);
}

async function journalsOf(world: ApWorld): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}

async function parkedOf(idempotencyKey: string) {
  const { rows } = await owner.query<{
    error_code: string;
    retryable: boolean;
  }>(
    `SELECT error_code, retryable FROM auto_journal_parked
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return rows;
}

async function card(world: ApWorld, asOf: string): Promise<number> {
  const report = await getAgingReport(tenantScope(), {
    legalEntityId: world.entityId,
    kind: "payable",
    asOf,
  });
  return report.totalIdr;
}

function invoiceBody(
  world: ApWorld,
  fx: ReceivedPo,
  options: {
    quantity: number;
    ppnIdr: number;
    unitPriceIdr?: number;
    idempotencyKey?: string;
  },
): InvoiceInput {
  return {
    outletId: world.outletId,
    supplierId: world.supplierId,
    purchaseOrderId: fx.poId,
    number: `INV-${hex()}`,
    invoiceDate: fx.receivedOn,
    dueDate: addDays(fx.receivedOn, 30),
    lines: [
      {
        purchaseOrderLineId: fx.poLineId,
        kind: "goods",
        description: "Tepung",
        quantity: `${options.quantity}.0000`,
        unitPriceIdr: `${options.unitPriceIdr ?? fx.unitPriceIdr}.0000`,
      },
    ],
    ppnIdr: options.ppnIdr,
    pph23Idr: 0,
    idempotencyKey: options.idempotencyKey ?? key(),
  } as unknown as InvoiceInput;
}

const recordInvoice = (
  world: ApWorld,
  scope: ScopedTenantContext,
  body: InvoiceInput,
) => createSupplierInvoice(scope, world.buyer.userId, body);

const release = (world: ApWorld, invoiceId: string, idempotencyKey = key()) =>
  releaseSupplierInvoice(
    outletScope(world.outletId),
    world.finance.userId,
    invoiceId,
    {
      note: "Selisih harga disetujui finance",
      idempotencyKey,
    } as Parameters<typeof releaseSupplierInvoice>[3],
  );

/** Finance releases a held invoice; a matched one is used as it is. */
async function settled(
  world: ApWorld,
  created: Awaited<ReturnType<typeof createSupplierInvoice>>,
) {
  if (created.invoice.status === "held")
    return (await release(world, created.invoice.id)).invoice;
  expect(created.invoice.status).toBe("matched");
  return created.invoice;
}

/** Invoice journals (`si-post:<id>`) and payable open items of one invoice. */
async function invoiceFootprint(world: ApWorld, invoiceId: string) {
  const journals = await entryIdByKey(world, `si-post:${invoiceId}`);
  const { rows: bySource } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2
        AND source_type = 'supplier_invoice' AND source_id = $3`,
    [tenantId, world.entityId, invoiceId],
  );
  const { rows: openItems } = await owner.query<{ original_idr: string }>(
    `SELECT original_idr::text FROM accounting_open_items
      WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
    [tenantId, invoiceId],
  );
  return {
    journals,
    journalsBySource: Number(bySource[0]!.n),
    openItems: openItems.map((row) => Number(row.original_idr)),
  };
}

/** What a refused invoice must not leave behind, scoped to this PO / entity. */
async function invoiceTraces(world: ApWorld, fx: ReceivedPo) {
  const count = async (sql: string, ...params: unknown[]) =>
    Number(
      (await owner.query<{ n: string }>(sql, [tenantId, ...params])).rows[0]!.n,
    );
  return {
    invoices: await count(
      "SELECT count(*)::text AS n FROM purchase_invoices WHERE tenant_id = $1 AND purchase_order_id = $2",
      fx.poId,
    ),
    lines: await count(
      `SELECT count(*)::text AS n FROM purchase_invoice_lines
        WHERE tenant_id = $1 AND purchase_invoice_id IN
          (SELECT id FROM purchase_invoices WHERE tenant_id = $1 AND purchase_order_id = $2)`,
      fx.poId,
    ),
    taxRecords: await count(
      "SELECT count(*)::text AS n FROM supplier_invoices WHERE tenant_id = $1 AND supplier_id = $2",
      world.supplierId,
    ),
    openItems: await count(
      "SELECT count(*)::text AS n FROM accounting_open_items WHERE tenant_id = $1 AND legal_entity_id = $2",
      world.entityId,
    ),
    journals: await journalsOf(world),
    outbox: await count(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' LIKE 'supplier_invoice.%'
          AND event->'payload'->>'purchaseOrderId' = $2`,
      fx.poId,
    ),
  };
}

describe("legend-29vw goods receipt journal Dr inventory / Cr GRNI", () => {
  it("GR-01 the receipt event posts Dr inventory / Cr GRNI at the receipt value, balanced, once", async () => {
    const { world, fx } = await receivedWorld();
    const event = await receiptEvent(fx.receiptId);
    expect(await entryIdByKey(world, receiptKey(fx))).toHaveLength(0);

    const result = await deliver(event);
    expect(result).toMatchObject({ status: "posted" });

    const entries = await entryIdByKey(world, receiptKey(fx));
    expect(entries).toHaveLength(1);
    const lines = await linesOf(entries[0]!);
    expectBalanced(lines);
    expect(side(lines, world.accounts.inventory)).toEqual({
      debit: 100_000,
      credit: 0,
    });
    expect(side(lines, world.accounts.grni)).toEqual({
      debit: 0,
      credit: 100_000,
    });
    expect(lines.size).toBe(2);
    const journalsAfterFirst = await journalsOf(world);

    // Redelivery (twice) never doubles the journal or the balances.
    await deliver(event);
    await deliver(event);
    expect(await entryIdByKey(world, receiptKey(fx))).toHaveLength(1);
    expect(await journalsOf(world)).toBe(journalsAfterFirst);
    expect(await creditBalance(world.accounts.grni)).toBe(100_000);
  });

  it("GR-02 a missing GRNI mapping parks the receipt (retryable) and books nothing; with the mapping back the sweep posts it once", async () => {
    const { world, fx } = await receivedWorld();
    const event = await receiptEvent(fx.receiptId);
    await owner.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'grni'",
      [tenantId, world.entityId],
    );
    const journalsBefore = await journalsOf(world);

    expect(await deliver(event)).toMatchObject({
      status: "parked",
      retryable: true,
    });
    expect(await parkedOf(receiptKey(fx))).toMatchObject([
      { error_code: "ACCOUNT_MAPPING_MISSING", retryable: true },
    ]);
    expect(await entryIdByKey(world, receiptKey(fx))).toHaveLength(0);
    expect(await journalsOf(world)).toBe(journalsBefore);

    // The mapping comes back; the sweep (a day later) posts the receipt.
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'grni', $3)`,
      [tenantId, world.entityId, world.accounts.grni],
    );
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await retryParkedAutoJournals(tenantScope(), later);
    await retryParkedAutoJournals(tenantScope(), new Date(later.getTime() + 1));

    const entries = await entryIdByKey(world, receiptKey(fx));
    expect(entries).toHaveLength(1);
    const lines = await linesOf(entries[0]!);
    expect(side(lines, world.accounts.grni).credit).toBe(100_000);
    expect(await creditBalance(world.accounts.grni)).toBe(100_000);
  });

  it("GR-07 with the posting flag off the receipt event is ignored: no journal, nothing parked", async () => {
    const { world, fx } = await receivedWorld();
    const event = await receiptEvent(fx.receiptId);
    const journalsBefore = await journalsOf(world);

    setSupplierInvoicePostingEnabled(false);
    expect(await deliver(event)).toMatchObject({ status: "ignored" });

    expect(await entryIdByKey(world, receiptKey(fx))).toHaveLength(0);
    expect(await parkedOf(receiptKey(fx))).toHaveLength(0);
    expect(await journalsOf(world)).toBe(journalsBefore);
  });
});

describe("legend-29vw GRNI is cleared by the invoice at the PO price", () => {
  it("GR-03a receipt + matching invoice: GRNI is zero, inventory keeps the receipt value, the payable is the invoice total", async () => {
    const { world, fx } = await receivedWorld();
    await journalReceipt(fx);
    expect(await creditBalance(world.accounts.grni)).toBe(100_000);

    const { invoice } = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, { quantity: 10, ppnIdr: 11_000 }),
    );
    expect(invoice.status).toBe("matched");
    expect(invoice.payableIdr).toBe(111_000);

    const footprint = await invoiceFootprint(world, invoice.id);
    expect(footprint.journals).toHaveLength(1);
    const lines = await linesOf(footprint.journals[0]!);
    expectBalanced(lines);
    expect(side(lines, world.accounts.grni)).toEqual({
      debit: 100_000,
      credit: 0,
    });
    expect(side(lines, world.accounts.ppn_input)).toEqual({
      debit: 11_000,
      credit: 0,
    });
    expect(side(lines, world.accounts.accounts_payable)).toEqual({
      debit: 0,
      credit: 111_000,
    });
    expect(lines.has(world.accounts.inventory)).toBe(false);

    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(-100_000);
    expect(await apLedger(world)).toBe(111_000);
  });

  it("GR-03b receipt + part invoice + return of the rest: GRNI ends at zero", async () => {
    const { world, fx } = await receivedWorld();
    await journalReceipt(fx);

    // 6 units invoiced: 60.000 of the 100.000 GRNI is cleared.
    const { invoice } = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, { quantity: 6, ppnIdr: 6_600 }),
    );
    expect(invoice.status).toBe("matched");
    expect(await creditBalance(world.accounts.grni)).toBe(40_000);

    // The other 4 units go back before being invoiced: Dr GRNI / Cr inventory.
    const { purchaseReturn } = await returnPo(world, fx, 4);
    expect(await returnRow(purchaseReturn.id)).toMatchObject({
      uninvoiced: 40_000,
      invoiced: 0,
    });
    expect(await deliver(await returnEvent(purchaseReturn.id))).toMatchObject({
      status: "posted",
    });

    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(-60_000);
    // The debt is the part invoice only.
    expect(await apLedger(world)).toBe(66_600);
  });
});

describe("legend-29vw cutover guard: no invoice or return on a receipt without its journal", () => {
  it("GR-04 an invoice that would post on a receipt without journal is refused 409 and leaves nothing behind", async () => {
    const { world, fx } = await receivedWorld();
    expect(await entryIdByKey(world, receiptKey(fx))).toHaveLength(0);
    const before = await invoiceTraces(world, fx);
    const retryKey = key();
    const body = invoiceBody(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
      idempotencyKey: retryKey,
    });

    await expect(
      recordInvoice(world, outletScope(world.outletId), body),
    ).rejects.toMatchObject({
      status: 409,
      code: "GOODS_RECEIPT_NOT_JOURNALED",
    });

    // Nothing at all: no invoice, lines, tax record, payable, journal, event.
    expect(await invoiceTraces(world, fx)).toEqual(before);
    expect(await apLedger(world)).toBe(0);

    // The same request (same key) works once the receipt is journaled: no
    // claim was left stranded by the refused attempt.
    await journalReceipt(fx);
    const { invoice } = await recordInvoice(
      world,
      outletScope(world.outletId),
      body,
    );
    expect(invoice.status).toBe("matched");
    expect(await apLedger(world)).toBe(111_000);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
  });

  it("GR-04b an invoice whose result is held posts nothing, so it may still be saved on a receipt without journal", async () => {
    const { world, fx } = await receivedWorld();

    const { invoice } = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, {
        quantity: 4,
        ppnIdr: 4_400,
        unitPriceIdr: 12_000,
      }),
    );

    expect(invoice.status).toBe("held");
    expect(await apLedger(world)).toBe(0);
    const footprint = await invoiceFootprint(world, invoice.id);
    expect(footprint.journals).toHaveLength(0);
    expect(footprint.openItems).toHaveLength(0);
  });

  it("GR-10 a return of goods not yet invoiced on a receipt without journal is refused 409 and records nothing", async () => {
    const { world, fx } = await receivedWorld();
    const stockBefore = await stockOf(fx.locationId, fx.itemId);
    const journalsBefore = await journalsOf(world);
    const count = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
            [tenantId, fx.receiptId],
          )
        ).rows[0]!.n,
      );

    await expect(returnPo(world, fx, 2)).rejects.toMatchObject({
      status: 409,
      code: "GOODS_RECEIPT_NOT_JOURNALED",
    });

    expect(await count()).toBe(0);
    expect(await stockOf(fx.locationId, fx.itemId)).toBe(stockBefore);
    expect(await journalsOf(world)).toBe(journalsBefore);

    // Control: once the receipt is journaled the same return is accepted.
    await journalReceipt(fx);
    await returnPo(world, fx, 2);
    expect(await count()).toBe(1);
  });
});

describe("legend-29vw price difference goes to purchase_price_variance", () => {
  it("GR-05a an invoice 5% above the PO price: variance debited, GRNI cleared at the PO price, payable = what the supplier billed", async () => {
    const { world, fx, variance } = await receivedWorld();
    await journalReceipt(fx);

    // 10 units at 10.500 = 105.000 against 100.000 at the PO price.
    const created = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, {
        quantity: 10,
        ppnIdr: 11_000,
        unitPriceIdr: 10_500,
      }),
    );
    const invoice = await settled(world, created);

    expect(invoice.payableIdr).toBe(116_000);
    const footprint = await invoiceFootprint(world, invoice.id);
    expect(footprint.journals).toHaveLength(1);
    const lines = await linesOf(footprint.journals[0]!);
    expectBalanced(lines);
    expect(side(lines, world.accounts.grni)).toEqual({
      debit: 100_000,
      credit: 0,
    });
    expect(side(lines, variance)).toEqual({ debit: 5_000, credit: 0 });
    expect(side(lines, world.accounts.ppn_input)).toEqual({
      debit: 11_000,
      credit: 0,
    });
    expect(side(lines, world.accounts.accounts_payable)).toEqual({
      debit: 0,
      credit: 116_000,
    });
    // Inventory in the ledger is untouched by the price difference.
    expect(lines.has(world.accounts.inventory)).toBe(false);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(-100_000);
    expect(footprint.openItems).toEqual([116_000]);
    expect(await apLedger(world)).toBe(116_000);
  });

  it("GR-05b an invoice 5% below the PO price: variance credited, GRNI still cleared at the PO price, payable never above the bill", async () => {
    const { world, fx, variance } = await receivedWorld();
    await journalReceipt(fx);

    // 10 units at 9.500 = 95.000 against 100.000 at the PO price; PPN 11% of
    // 95.000.
    const created = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, {
        quantity: 10,
        ppnIdr: 10_450,
        unitPriceIdr: 9_500,
      }),
    );
    const invoice = await settled(world, created);

    expect(invoice.payableIdr).toBe(105_450);
    const footprint = await invoiceFootprint(world, invoice.id);
    expect(footprint.journals).toHaveLength(1);
    const lines = await linesOf(footprint.journals[0]!);
    expectBalanced(lines);
    expect(side(lines, world.accounts.grni)).toEqual({
      debit: 100_000,
      credit: 0,
    });
    expect(side(lines, variance)).toEqual({ debit: 0, credit: 5_000 });
    expect(side(lines, world.accounts.accounts_payable)).toEqual({
      debit: 0,
      credit: 105_450,
    });
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await apLedger(world)).toBe(105_450);
  });
});

// Assumption: a return is valued at the billed price (the PPN is already), so
// the debit note equals the bill share and the price difference of the returned
// units is reversed out of purchase_price_variance (5105). Asserted through the
// ledger and the payable card only, not through the return row columns.
async function returnAfterInvoice(
  unitPriceIdr: number,
  ppnIdr: number,
  returnQuantity = 10,
) {
  const { world, fx, variance } = await receivedWorld();
  await journalReceipt(fx);
  const created = await recordInvoice(
    world,
    outletScope(world.outletId),
    invoiceBody(world, fx, { quantity: 10, ppnIdr, unitPriceIdr }),
  );
  const invoice = await settled(world, created);
  const billed = invoice.payableIdr;
  expect(await apLedger(world)).toBe(billed);

  const { purchaseReturn } = await returnPo(world, fx, returnQuantity);
  expect(await deliver(await returnEvent(purchaseReturn.id))).toMatchObject({
    status: "posted",
  });
  return { world, fx, variance, billed };
}

/**
 * Nobody is paid more: every journal of the entity balances, and the payable
 * never goes below zero (a debit note above the bill would do that).
 */
async function expectNoOnePaidMore(world: ApWorld) {
  const { rows } = await owner.query<{
    entry_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT l.entry_id, sum(l.debit_idr)::text AS debit, sum(l.credit_idr)::text AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2 GROUP BY l.entry_id`,
    [tenantId, world.entityId],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.debit).toBe(row.credit);
  expect(await apLedger(world)).toBeGreaterThanOrEqual(0);
}

describe("legend-29vw a full return of invoiced goods with a price difference leaves nothing owed", () => {
  const fullReturnAfterInvoice = (unitPriceIdr: number, ppnIdr: number) =>
    returnAfterInvoice(unitPriceIdr, ppnIdr, 10);

  // legend-5b7uf: debit note must be valued at the billed price (+ PPN)
  it("GR-11 invoice price +5% released, full return: payable 0, 5105 0, GRNI 0, inventory 0", async () => {
    const { world, fx, variance, billed } = await fullReturnAfterInvoice(
      10_500,
      11_000,
    );
    expect(billed).toBe(116_000);

    // The supplier is not paid for goods that went back.
    expect(await apLedger(world)).toBe(0);
    expect(await card(world, fx.receivedOn)).toBe(0);
    // The price difference that the invoice put on 5105 is reversed.
    expect(await creditBalance(variance)).toBe(0);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(0);
    await expectNoOnePaidMore(world);
  });

  // legend-5b7uf: debit note must be valued at the billed price (+ PPN)
  it("GR-12 invoice price -5% (released or within tolerance), full return: payable 0, the debit note never exceeds the bill", async () => {
    const { world, fx, variance, billed } = await fullReturnAfterInvoice(
      9_500,
      10_450,
    );
    expect(billed).toBe(105_450);

    // A debit note above the bill would push the ledger below zero.
    expect(await apLedger(world)).toBe(0);
    expect(await card(world, fx.receivedOn)).toBe(0);
    expect(await creditBalance(variance)).toBe(0);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(0);
    await expectNoOnePaidMore(world);
  });
});

describe("legend-5b7uf a part return of invoiced goods with a price difference", () => {
  // Assumption: the PPN of the bill is returned pro rata to the quantity (4 of
  // 10 units = 40% of the bill's PPN), and the price difference per unit is
  // reversed out of 5105 for the returned units only.
  const partReturn = (unitPriceIdr: number, ppnIdr: number) =>
    returnAfterInvoice(unitPriceIdr, ppnIdr, 4);

  it("GR-13 invoice price +5%, return 4 of 10: debit note = 4 x 10.500 + PPN, payable = 6/10 of the bill, 5105 keeps 6/10 of the difference", async () => {
    const { world, fx, variance, billed } = await partReturn(10_500, 11_000);
    expect(billed).toBe(116_000);

    // Debit note 42.000 + 4.400 = 46.400; 116.000 - 46.400 = 69.600 still owed.
    expect(await apLedger(world)).toBe(69_600);
    expect(await card(world, fx.receivedOn)).toBe(69_600);
    // 5105 was debited 5.000 by the invoice; 2.000 of it goes back (credit).
    expect(await creditBalance(variance)).toBe(-3_000);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(-60_000);
    await expectNoOnePaidMore(world);
  });

  it("GR-14 invoice price -5%, return 4 of 10: debit note = 4 x 9.500 + PPN (below the PO price), payable = 6/10 of the bill", async () => {
    const { world, fx, variance, billed } = await partReturn(9_500, 10_450);
    expect(billed).toBe(105_450);

    // Debit note 38.000 + 4.180 = 42.180; 105.450 - 42.180 = 63.270 still owed.
    expect(await apLedger(world)).toBe(63_270);
    expect(await card(world, fx.receivedOn)).toBe(63_270);
    // 5105 was credited 5.000 by the invoice; 2.000 of it goes back (debit).
    expect(await creditBalance(variance)).toBe(3_000);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(-60_000);
    await expectNoOnePaidMore(world);
  });
});

// Round 1 review (T1). Assumptions: the outlet pays part of an invoice by
// writing the settlement directly (as purchase-return-parked-debit-note does);
// PPN of the 10,333 invoice is 11% of 103.330 rounded down = 11.366; a +3.33%
// difference is held at the default tolerance and released by finance
// (`settled` takes either path).
async function pay(invoiceId: string, receivedOn: string, amount: number) {
  await owner.query(
    `UPDATE accounting_open_items SET settled_idr = $3
      WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
    [tenantId, invoiceId, amount],
  );
  await owner.query(
    `INSERT INTO accounting_open_item_settlements (tenant_id, kind, open_item_id, method, settled_on, amount_idr)
     VALUES ($1, 'payable', $2, 'payment', $3, $4)`,
    [tenantId, invoiceId, receivedOn, amount],
  );
}

describe("legend-5b7uf returns that split the bill unevenly, and returns still on their way", () => {
  it("GR-15 returns of 3 + 3 + 4 units at an invoice unit price of 10.333: payable and 5105 end at exactly 0 (no rounding left behind)", async () => {
    const { world, fx, variance } = await receivedWorld();
    await journalReceipt(fx);
    const created = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, {
        quantity: 10,
        ppnIdr: 11_366,
        unitPriceIdr: 10_333,
      }),
    );
    const invoice = await settled(world, created);
    expect(invoice.payableIdr).toBe(103_330 + 11_366);
    expect(await apLedger(world)).toBe(114_696);
    // The invoice put 3.330 on 5105 (103.330 billed against 100.000 at PO price).
    expect(await creditBalance(variance)).toBe(-3_330);

    for (const units of [3, 3]) {
      const { purchaseReturn } = await returnPo(world, fx, units);
      expect(await deliver(await returnEvent(purchaseReturn.id))).toMatchObject(
        { status: "posted" },
      );
      // Part way: something is still owed, never a negative payable.
      expect(await apLedger(world)).toBeGreaterThan(0);
    }
    const last = await returnPo(world, fx, 4);
    expect(
      await deliver(await returnEvent(last.purchaseReturn.id)),
    ).toMatchObject({ status: "posted" });

    // The three notes add up to the bill exactly: not one rupiah owed, none overpaid.
    expect(await apLedger(world)).toBe(0);
    expect(await card(world, fx.receivedOn)).toBe(0);
    expect(await creditBalance(variance)).toBe(0);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(0);
    await expectNoOnePaidMore(world);
  });

  it("GR-16 a +5% return recorded but not yet journaled keeps its billed value (+ PPN) reserved: the next return that no longer fits what is owed is refused 409", async () => {
    const { world, fx } = await receivedWorld();
    await journalReceipt(fx);
    const created = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, {
        quantity: 10,
        ppnIdr: 11_000,
        unitPriceIdr: 10_500,
      }),
    );
    const invoice = await settled(world, created);
    expect(invoice.payableIdr).toBe(116_000);

    // Return 1: 3 units = 31.500 + PPN 3.300 = 34.800 billed value. Its event
    // is NOT delivered yet.
    const first = await returnPo(world, fx, 3);
    // 70.200 is paid: 45.800 owed, 34.800 of it already claimed, 11.000 left.
    await pay(invoice.id, fx.receivedOn, 70_200);
    const returnsOf = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
            [tenantId, fx.receiptId],
          )
        ).rows[0]!.n,
      );
    expect(await returnsOf()).toBe(1);

    // 1 unit = 10.500 + 1.100 = 11.600 > 11.000. At the PO price (11.100) it
    // would have slipped through and the supplier would be short-debited.
    await expect(returnPo(world, fx, 1)).rejects.toMatchObject({
      status: 409,
      code: "PURCHASE_RETURN_EXCEEDS_PAYABLE",
    });
    expect(await returnsOf()).toBe(1);

    // The first note still posts once and what is owed ends at 11.000.
    expect(
      await deliver(await returnEvent(first.purchaseReturn.id)),
    ).toMatchObject({ status: "posted" });
    expect(await card(world, fx.receivedOn)).toBe(45_800 - 34_800);
    await expectNoOnePaidMore(world);
  });

  it("GR-17 an old return event without returnPriceVarianceIdr still posts, at the old value with no variance line", async () => {
    const { world, fx, variance } = await receivedWorld();
    await journalReceipt(fx);
    // Invoice at the PO price: the old rule and the new rule give the same number.
    const created = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, { quantity: 10, ppnIdr: 11_000 }),
    );
    expect(created.invoice.status).toBe("matched");
    expect(await apLedger(world)).toBe(111_000);

    const { purchaseReturn } = await returnPo(world, fx, 4);
    const event = await returnEvent(purchaseReturn.id);
    // The event as an older release wrote it: the field does not exist.
    const payload = { ...(event.payload as Record<string, unknown>) };
    delete payload.returnPriceVarianceIdr;
    expect("returnPriceVarianceIdr" in payload).toBe(false);
    const oldEvent = { ...event, payload } as EventEnvelope;

    expect(await deliver(oldEvent)).toMatchObject({ status: "posted" });

    // 4 units: 40.000 + PPN 4.400 off the bill; 5105 untouched; no overpay.
    expect(await apLedger(world)).toBe(111_000 - 44_400);
    expect(await creditBalance(variance)).toBe(0);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
    expect(await creditBalance(world.accounts.inventory)).toBe(-60_000);
    await expectNoOnePaidMore(world);
  });

  // Round 2 review (T3). Assumptions: the PO unit "box" is 10/3 base units
  // (kg): stored as the reverse direction (1 kg = 0.3 box, factor 0.3000), the
  // only way a 4-decimal factor can express a third exactly. 3 box received
  // are then exactly 10 kg. Receipt and invoice quantities are in the PO unit
  // (box), the return quantity is in base units (kg), as the shared contract
  // says. Each invoice bills 1 box = 3.3333 kg, so the part of the stock that
  // one invoice covers (10 / 3) is not a whole number in 4 decimals: the three
  // parts round to 3.3333 kg each and add to 9.9999 kg, 0.0001 kg short. The
  // full return of 10 kg must still succeed, never be refused as worth more
  // than owed, and leave only that rounding crumb (at most 3 scaled units, i.e.
  // under Rp 5 here), never a negative payable. If this fixture cannot be
  // built (the receipt refuses the conversion) the test fails in setup, not in
  // the rule under test.
  it("GR-18 a PO unit that is not a whole number of base units, billed on 3 invoices of 1 PO unit: a full return of all 10 base units is accepted and leaves at most a rounding crumb, never a negative payable", async () => {
    const world = await setupApWorld();
    const { rows: box } = await owner.query<{ id: string }>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantId, `bx${hex(3)}`.slice(0, 10)],
    );
    const { rows: item } = await owner.query<{ id: string }>(
      "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
      [tenantId, `Tepung dus ${hex(3)}`, world.uomKg],
    );
    await owner.query(
      `INSERT INTO uom_conversions (tenant_id, inventory_item_id, from_uom_id, to_uom_id, factor)
       VALUES ($1, $2, $3, $4, 0.3000)`,
      [tenantId, item[0]!.id, world.uomKg, box[0]!.id],
    );
    const { rows: location } = await owner.query<{ id: string }>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
      [tenantId, world.outletId, `Gudang dus ${hex(3)}`],
    );
    const poId = randomUUID();
    const unitPriceIdr = 30_000;
    await owner.query(
      `INSERT INTO purchase_orders
         (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
          subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
          approved_at, sent_at)
       VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', $6, 0, $6, 'user', $7, $8, now(), now())`,
      [
        poId,
        tenantId,
        world.outletId,
        world.supplierId,
        `PO/209912/${hex()}`,
        3 * unitPriceIdr,
        world.creatorId,
        world.approverId,
      ],
    );
    const { rows: line } = await owner.query<{ id: string }>(
      `INSERT INTO purchase_order_lines
         (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
          uom_id, unit_price_idr, line_total_idr, line_no)
       VALUES ($1, $2, $3, $4, '3.0000', $5, $6, $7, 1) RETURNING id`,
      [
        tenantId,
        world.outletId,
        poId,
        item[0]!.id,
        box[0]!.id,
        `${unitPriceIdr}.0000`,
        3 * unitPriceIdr,
      ],
    );
    const receipt = await createGoodsReceipt(
      outletScope(world.outletId),
      world.warehouse.userId,
      {
        outletId: world.outletId,
        purchaseOrderId: poId,
        lines: [
          {
            purchaseOrderLineId: line[0]!.id,
            locationId: location[0]!.id,
            quantityReceived: "3.0000",
            quantityRejected: "0.0000",
          },
        ],
        idempotencyKey: key(),
      } as unknown as CreateGoodsReceiptInput,
    );
    await deliverGoodsReceiptJournal(receipt.receipt.id);
    const fx: ReceivedPo = {
      poId,
      poLineId: line[0]!.id,
      itemId: item[0]!.id,
      locationId: location[0]!.id,
      receiptId: receipt.receipt.id,
      receivedOn: receipt.receipt.receivedOn,
      unitPriceIdr,
    };
    expect(Number(await stockOf(fx.locationId, fx.itemId))).toBe(10);

    // Three invoices of 1 box at the PO price: 30.000 + PPN 3.300 each.
    for (let n = 0; n < 3; n++) {
      const created = await recordInvoice(
        world,
        outletScope(world.outletId),
        invoiceBody(world, fx, { quantity: 1, ppnIdr: 3_300 }),
      );
      expect(created.invoice.status).toBe("matched");
    }
    expect(await apLedger(world)).toBe(99_900);

    // The whole stock goes back (10 kg). It is not refused as exceeding what
    // is owed even though each invoice's share of the stock does not divide.
    const { purchaseReturn } = await returnPo(world, fx, 10);
    expect(await deliver(await returnEvent(purchaseReturn.id))).toMatchObject({
      status: "posted",
    });

    expect(Number(await stockOf(fx.locationId, fx.itemId))).toBe(0);
    const owed = await apLedger(world);
    expect(owed).toBeGreaterThanOrEqual(0);
    expect(owed).toBeLessThanOrEqual(5);
    const cardTotal = await card(world, fx.receivedOn);
    expect(cardTotal).toBeGreaterThanOrEqual(0);
    expect(cardTotal).toBeLessThanOrEqual(5);
    await expectNoOnePaidMore(world);
  });
});

describe("legend-29vw one invoice, one journal", () => {
  it("GR-06a the same create request sent again and a rematch of a matched invoice book nothing more", async () => {
    const { world, fx } = await receivedWorld();
    await journalReceipt(fx);
    const body = invoiceBody(world, fx, { quantity: 10, ppnIdr: 11_000 });
    const scope = outletScope(world.outletId);

    const first = await recordInvoice(world, scope, body);
    expect(first.invoice.status).toBe("matched");
    const again = await recordInvoice(world, scope, body);
    expect(again.invoice.id).toBe(first.invoice.id);

    await expect(
      rematchSupplierInvoice(scope, world.buyer.userId, first.invoice.id, {
        idempotencyKey: key(),
      } as Parameters<typeof rematchSupplierInvoice>[3]),
    ).rejects.toMatchObject({
      status: 409,
      code: "SUPPLIER_INVOICE_NOT_HELD",
    });

    const footprint = await invoiceFootprint(world, first.invoice.id);
    expect(footprint.journals).toHaveLength(1);
    expect(footprint.journalsBySource).toBe(1);
    expect(footprint.openItems).toEqual([111_000]);
    expect(await apLedger(world)).toBe(111_000);
    expect(await creditBalance(world.accounts.grni)).toBe(0);
  });

  it("GR-06b releasing a held invoice twice (same key, then another key) books one journal and one payable", async () => {
    const { world, fx } = await receivedWorld();
    await journalReceipt(fx);
    const { invoice } = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, {
        quantity: 4,
        ppnIdr: 4_400,
        unitPriceIdr: 12_000,
      }),
    );
    expect(invoice.status).toBe("held");
    expect((await invoiceFootprint(world, invoice.id)).journals).toHaveLength(
      0,
    );
    const releaseKey = key();

    const released = await release(world, invoice.id, releaseKey);
    expect(released.invoice.status).toBe("released");
    expect(released.invoice.payableIdr).toBe(52_400);
    // Same key again: a replay, never a second posting.
    await release(world, invoice.id, releaseKey).catch(() => undefined);
    // Another key: the invoice is no longer held.
    await expect(release(world, invoice.id)).rejects.toMatchObject({
      status: 409,
      code: "SUPPLIER_INVOICE_NOT_HELD",
    });

    const footprint = await invoiceFootprint(world, invoice.id);
    expect(footprint.journals).toHaveLength(1);
    expect(footprint.journalsBySource).toBe(1);
    expect(footprint.openItems).toEqual([52_400]);
    expect(await apLedger(world)).toBe(52_400);
  });
});

describe("legend-29vw another tenant is refused", () => {
  const foreign = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(randomUUID()),
        brandId: null,
        source: "domain",
      }),
      { kind: "tenant" },
    );

  it("GR-08 tenant B cannot post tenant A's receipt event nor record an invoice on A's PO", async () => {
    const { world, fx } = await receivedWorld();
    const event = await receiptEvent(fx.receiptId);
    const journalsBefore = await journalsOf(world);
    const other = foreign();

    // The envelope names tenant A; delivered under tenant B it is ignored.
    expect(await deliver(event, other)).toMatchObject({ status: "ignored" });
    expect(await journalsOf(world)).toBe(journalsBefore);
    expect(await entryIdByKey(world, receiptKey(fx))).toHaveLength(0);

    // Tenant B cannot see A's PO: the invoice is refused and nothing is written.
    const before = await invoiceTraces(world, fx);
    const outcome = await Promise.allSettled([
      recordInvoice(
        world,
        other,
        invoiceBody(world, fx, { quantity: 10, ppnIdr: 11_000 }),
      ),
    ]);
    expect(outcome[0]!.status).toBe("rejected");
    expect([403, 404]).toContain(
      ((outcome[0] as PromiseRejectedResult).reason as { status?: number })
        .status,
    );
    expect(await invoiceTraces(world, fx)).toEqual(before);

    // Control: under its own tenant the same event posts.
    expect(await deliver(event)).toMatchObject({ status: "posted" });
  });
});

describe("legend-29vw the supplier is never owed more than billed", () => {
  it("GR-09 ledger accounts_payable equals the payable card and never exceeds the invoice total (held books nothing, release books the bill)", async () => {
    const { world, fx } = await receivedWorld();
    await journalReceipt(fx);
    const tie = async (expected: number) => {
      expect(await apLedger(world)).toBe(expected);
      expect(await card(world, fx.receivedOn)).toBe(expected);
    };

    // Held (price +20%): no payable at all.
    const { invoice } = await recordInvoice(
      world,
      outletScope(world.outletId),
      invoiceBody(world, fx, {
        quantity: 4,
        ppnIdr: 4_400,
        unitPriceIdr: 12_000,
      }),
    );
    expect(invoice.status).toBe("held");
    await tie(0);

    // Released: goods 48.000 + PPN 4.400 = exactly the invoice total.
    const released = await release(world, invoice.id);
    expect(released.invoice.payableIdr).toBe(52_400);
    await tie(52_400);
    expect(await apLedger(world)).toBeLessThanOrEqual(48_000 + 4_400);
  });
});
