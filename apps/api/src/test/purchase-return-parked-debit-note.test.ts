// legend-3fi5v: a debit note whose AP posting is parked must not block the next
// legitimate purchase return, and the debt must never fall twice.
// Written fail-first from the card text (bd show legend-3fi5v) and the design
// docs/briefs/ws-purchasing-apar-design.md section 6, not from the implementation.
//
// Money rules under test (founder: nobody is paid more, the outlet never loses):
// - The return pre-check counts only debit notes already settled against the
//   payable (they are already inside the open item's outstanding). A debit
//   note parked by the consumer (AutoJournalPayloadInvalid, for example because
//   a payment raced the return) has reduced nothing, so it does not shrink
//   what a later return may take.
// - A return larger than the outstanding payable is still refused (409
//   PURCHASE_RETURN_EXCEEDS_PAYABLE), whatever was parked before.
// - A parked event posts nothing; the same event redelivered after the cause is
//   fixed posts once; a redelivery after that changes nothing.
//
// Assumptions (the card does not pin these down):
// - "Parked" is reproduced the way the design describes it: the payable is
//   short when the consumer applies the debit note (a payment of 61.000 lands
//   between the return and the delivery of its event). The consumer then answers
//   `{ status: "parked", retryable: false }`. The payment is written directly
//   as the migration owner (settled_idr), like ISP-07; the supplier payment
//   flow is not under test.
// - The "repair flow" is redelivery of the same event once the cause is gone
//   (the shortage disappears). The brief names no endpoint or command, so none
//   is asserted.
// - A second return that is legitimate on its own (invoiced value + PPN is not
//   more than the outstanding payable) is accepted even though the first one
//   is still parked; the sum of both may then exceed the outstanding payable,
//   in which case the consumer parks the one that no longer fits and never
//   books it half way.
// - Invoice of 10 units at 10.000 + PPN 11.000 = payable 111.000. A return of
//   n units carries invoiced n x 10.000 and PPN n x 1.100.
// - PD-04..06 (design scratchpad design.md section 4, decision F5): a debit note
//   still pending (event not consumed yet) or parked retryable (mapping missing)
//   keeps its value reserved for the next return, because it will post by
//   itself; a debit note parked non-retryable for a short payable
//   (`AUTO_JOURNAL_DEBIT_NOTE_SHORT`, rechecked a day later) reserves nothing.
//   The recheck allocates to the payable open items of the same supplier and
//   legal entity, so a new invoice of that supplier can absorb it. The sweep
//   runs a day or more after the delivery (the clock is passed in).
// - PD-04 and PD-05 reproduce "owed" with the same payment of 61.000 as PD-01.
// - Ids PD-nn name the cases below.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import {
  apLedger,
  closeOwner,
  invoicePo,
  journalCount,
  owner,
  returnPo,
  returnRow,
  seedReceivedPo,
  setupApWorld,
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

const PARKED = { status: "parked", retryable: false };

async function card(world: ApWorld, asOf: string): Promise<number> {
  const report = await getAgingReport(tenantScope(), {
    legalEntityId: world.entityId,
    kind: "payable",
    asOf,
  });
  return report.totalIdr;
}

/** The `purchase_return.recorded` event the return wrote to the outbox. */
async function eventOf(returnId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'purchase_return.recorded'`,
    [tenantId, returnId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

const deliver = (event: EventEnvelope) =>
  withTenant(db, tenantScope(), (tx) =>
    deliverAutoJournalEvent(tenantScope(), event, tx, new Date()),
  );

/** The outlet pays `amount` of the invoice (open item) directly, like ISP-07. */
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

/** Invoice of all 10 units: payable 111.000. */
async function invoicedWorld(): Promise<{
  world: ApWorld;
  fx: ReceivedPo;
  invoiceId: string;
}> {
  const world = await setupApWorld();
  const fx = await seedReceivedPo(world);
  const { invoice } = await invoicePo(world, fx, {
    quantity: 10,
    ppnIdr: 11_000,
  });
  expect(invoice.status).toBe("matched");
  expect(invoice.payableIdr).toBe(111_000);
  return { world, fx, invoiceId: invoice.id };
}

describe("legend-3fi5v a parked debit note does not block the next legitimate return", () => {
  it("PD-01 return 1 is parked by a payment race; return 2 within what is owed is accepted and the debt falls once", async () => {
    const { world, fx, invoiceId } = await invoicedWorld();

    // Return 1: 6 units, debit note 66.600. Pre-check passes (111.000 owed).
    const first = await returnPo(world, fx, 6);
    expect(await returnRow(first.purchaseReturn.id)).toMatchObject({
      invoiced: 60_000,
      ppn: 6_600,
    });
    // A payment of 61.000 lands before the event is consumed: 50.000 is owed.
    await pay(invoiceId, fx.receivedOn, 61_000);
    expect(await card(world, fx.receivedOn)).toBe(50_000);
    const ledgerBefore = await apLedger(world);
    const journalsBefore = await journalCount(world);

    // The debit note (66.600) no longer fits: parked, nothing recorded.
    const firstEvent = await eventOf(first.purchaseReturn.id);
    expect(await deliver(firstEvent)).toMatchObject(PARKED);
    expect(await card(world, fx.receivedOn)).toBe(50_000);
    expect(await apLedger(world)).toBe(ledgerBefore);
    expect(await journalCount(world)).toBe(journalsBefore);

    // Return 2: 4 units, 44.400 <= 50.000 owed. The parked note reduced
    // nothing, so this return is legitimate and must not be refused.
    const second = await returnPo(world, fx, 4);
    expect(await returnRow(second.purchaseReturn.id)).toMatchObject({
      invoiced: 40_000,
      ppn: 4_400,
    });

    // Its debit note reduces the debt exactly once.
    const secondEvent = await eventOf(second.purchaseReturn.id);
    expect(await deliver(secondEvent)).toMatchObject({ status: "posted" });
    expect(await card(world, fx.receivedOn)).toBe(5_600);
    expect(await apLedger(world)).toBe(ledgerBefore - 44_400);

    // Redelivering either event changes nothing; the first stays parked
    // (66.600 > 5.600 owed) and the debt never goes below zero.
    await deliver(secondEvent);
    expect(await deliver(firstEvent)).toMatchObject(PARKED);
    expect(await card(world, fx.receivedOn)).toBe(5_600);
    expect(await apLedger(world)).toBe(ledgerBefore - 44_400);
  });

  it("PD-02 repair: once the shortage is gone the parked note posts once, and the debt falls by each return exactly once", async () => {
    const { world, fx, invoiceId } = await invoicedWorld();
    const first = await returnPo(world, fx, 6);
    // Payment race: the debit note does not fit and is parked.
    await pay(invoiceId, fx.receivedOn, 61_000);
    const firstEvent = await eventOf(first.purchaseReturn.id);
    expect(await deliver(firstEvent)).toMatchObject(PARKED);
    expect(await card(world, fx.receivedOn)).toBe(50_000);
    const ledgerBefore = await apLedger(world);

    // The payment is undone (shortage gone; written as the migration owner,
    // the payment flow is not under test): the same event is redelivered.
    await owner.query(
      `DELETE FROM accounting_open_item_settlements
        WHERE tenant_id = $1 AND kind = 'payable' AND open_item_id = $2 AND method = 'payment'`,
      [tenantId, invoiceId],
    );
    await owner.query(
      `UPDATE accounting_open_items SET settled_idr = 0
        WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
      [tenantId, invoiceId],
    );
    expect(await deliver(firstEvent)).toMatchObject({ status: "posted" });
    expect(await card(world, fx.receivedOn)).toBe(44_400);
    expect(await apLedger(world)).toBe(ledgerBefore - 66_600);

    // Delivering it again does not reduce the debt again.
    await deliver(firstEvent);
    expect(await card(world, fx.receivedOn)).toBe(44_400);
    expect(await apLedger(world)).toBe(ledgerBefore - 66_600);

    // The remaining 4 units (44.400) are exactly what is still owed: accepted,
    // and the debt ends at zero, never below.
    const second = await returnPo(world, fx, 4);
    expect(
      await deliver(await eventOf(second.purchaseReturn.id)),
    ).toMatchObject({ status: "posted" });
    expect(await card(world, fx.receivedOn)).toBe(0);
    expect(await apLedger(world)).toBe(ledgerBefore - 66_600 - 44_400);
  });

  it("PD-03 control: settled debit notes are counted once; a return above what is still owed stays refused", async () => {
    const { world, fx, invoiceId } = await invoicedWorld();
    // 61.000 paid: 50.000 owed.
    await pay(invoiceId, fx.receivedOn, 61_000);

    // Return A (2 units, 22.200) settles: 27.800 owed.
    const a = await returnPo(world, fx, 2);
    expect(await deliver(await eventOf(a.purchaseReturn.id))).toMatchObject({
      status: "posted",
    });
    expect(await card(world, fx.receivedOn)).toBe(27_800);

    // Return B (2 units, 22.200 <= 27.800) is accepted: A is already inside
    // the outstanding, it is not subtracted a second time.
    const b = await returnPo(world, fx, 2);
    expect(await deliver(await eventOf(b.purchaseReturn.id))).toMatchObject({
      status: "posted",
    });
    expect(await card(world, fx.receivedOn)).toBe(5_600);

    // Return C (2 units, 22.200 > 5.600) is refused and records nothing.
    const { rows: before } = await owner.query(
      "SELECT 1 FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
      [tenantId, fx.receiptId],
    );
    await expect(returnPo(world, fx, 2)).rejects.toMatchObject({
      status: 409,
      code: "PURCHASE_RETURN_EXCEEDS_PAYABLE",
    });
    const { rows: after } = await owner.query(
      "SELECT 1 FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
      [tenantId, fx.receiptId],
    );
    expect(after).toHaveLength(before.length);
    expect(await card(world, fx.receivedOn)).toBe(5_600);
  });
});

const DAY = 24 * 60 * 60 * 1000;

async function parkedOf(returnId: string) {
  const { rows } = await owner.query<{
    error_code: string;
    retryable: boolean;
  }>(
    `SELECT error_code, retryable FROM auto_journal_parked
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, `aj:purchase-return:${returnId}`],
  );
  return rows;
}

async function returnsOf(fx: ReceivedPo): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
    [tenantId, fx.receiptId],
  );
  return Number(rows[0]!.n);
}

describe("legend-3fi5v a debit note still on its way keeps its room reserved", () => {
  it("PD-04 two quick returns before any event is consumed: the second is refused when both together exceed what is owed", async () => {
    const { world, fx, invoiceId } = await invoicedWorld();
    // Return 1 (3 units, 33.300) is recorded; its event is not consumed yet.
    const first = await returnPo(world, fx, 3);
    // A payment of 61.000 lands: 50.000 is owed, 33.300 of it already claimed.
    await pay(invoiceId, fx.receivedOn, 61_000);
    const ledgerBefore = await apLedger(world);

    // 4 units = 44.400 fits 50.000 alone but not what is left (16.700).
    await expect(returnPo(world, fx, 4)).rejects.toMatchObject({
      status: 409,
      code: "PURCHASE_RETURN_EXCEEDS_PAYABLE",
    });
    expect(await returnsOf(fx)).toBe(1);

    // 1 unit = 11.100 <= 16.700 is accepted.
    const second = await returnPo(world, fx, 1);
    expect(await returnsOf(fx)).toBe(2);

    // Both notes post; the debt falls by each once and never below zero.
    expect(await deliver(await eventOf(first.purchaseReturn.id))).toMatchObject(
      { status: "posted" },
    );
    expect(
      await deliver(await eventOf(second.purchaseReturn.id)),
    ).toMatchObject({ status: "posted" });
    expect(await card(world, fx.receivedOn)).toBe(50_000 - 33_300 - 11_100);
    expect(await apLedger(world)).toBe(ledgerBefore - 33_300 - 11_100);
  });

  it("PD-05 a debit note parked retryable (mapping missing) still reserves its room; once the mapping is back the sweep posts it and nothing falls twice", async () => {
    const { world, fx, invoiceId } = await invoicedWorld();
    const first = await returnPo(world, fx, 3);
    const firstEvent = await eventOf(first.purchaseReturn.id);
    // A payment of 61.000 lands: 50.000 is owed.
    await pay(invoiceId, fx.receivedOn, 61_000);
    await owner.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'accounts_payable'",
      [tenantId, world.entityId],
    );
    const ledgerBefore = await apLedger(world);

    expect(await deliver(firstEvent)).toMatchObject({
      status: "parked",
      retryable: true,
    });
    expect(await parkedOf(first.purchaseReturn.id)).toMatchObject([
      { error_code: "ACCOUNT_MAPPING_MISSING", retryable: true },
    ]);
    expect(await apLedger(world)).toBe(ledgerBefore);

    // 33.300 is still reserved: 4 units (44.400) do not fit the 16.700 left,
    // 1 unit (11.100) does.
    await expect(returnPo(world, fx, 4)).rejects.toMatchObject({
      status: 409,
      code: "PURCHASE_RETURN_EXCEEDS_PAYABLE",
    });
    const second = await returnPo(world, fx, 1);

    // The mapping comes back: the sweep posts the parked note, the other is
    // delivered; each reduces the debt once.
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'accounts_payable', $3)`,
      [tenantId, world.entityId, world.accounts.accounts_payable],
    );
    await retryParkedAutoJournals(tenantScope(), new Date(Date.now() + DAY));
    expect(
      await deliver(await eventOf(second.purchaseReturn.id)),
    ).toMatchObject({ status: "posted" });
    await deliver(firstEvent);

    expect(await card(world, fx.receivedOn)).toBe(50_000 - 33_300 - 11_100);
    expect(await apLedger(world)).toBe(ledgerBefore - 33_300 - 11_100);
  });
});

describe("legend-3fi5v a debit note parked for a short payable is rechecked daily", () => {
  it("PD-06 parked DEBIT_NOTE_SHORT reserves nothing; a new invoice of the same supplier lets the daily recheck post it once", async () => {
    const { world, fx, invoiceId } = await invoicedWorld();
    const first = await returnPo(world, fx, 6);
    await pay(invoiceId, fx.receivedOn, 61_000);
    const firstEvent = await eventOf(first.purchaseReturn.id);
    const ledgerBefore = await apLedger(world);

    // 66.600 does not fit the 50.000 owed: parked, never retried by luck.
    expect(await deliver(firstEvent)).toMatchObject(PARKED);
    expect(await parkedOf(first.purchaseReturn.id)).toMatchObject([
      { error_code: "AUTO_JOURNAL_DEBIT_NOTE_SHORT", retryable: false },
    ]);
    expect(await apLedger(world)).toBe(ledgerBefore);

    // A new invoice of the same supplier (111.000) lands on a second PO.
    const second = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, second, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    expect(invoice.status).toBe("matched");
    expect(await card(world, fx.receivedOn)).toBe(50_000 + 111_000);

    // The daily recheck (a day later) allocates the note to the payables of
    // that supplier: it posts once, the debt falls by 66.600 once.
    const at = new Date(Date.now() + DAY + 60 * 60 * 1000);
    await retryParkedAutoJournals(tenantScope(), at);
    expect(await card(world, fx.receivedOn)).toBe(161_000 - 66_600);
    expect(await apLedger(world)).toBe(ledgerBefore + 111_000 - 66_600);

    // Another sweep, and a redelivery of the event, change nothing.
    await retryParkedAutoJournals(tenantScope(), new Date(at.getTime() + DAY));
    await deliver(firstEvent);
    expect(await card(world, fx.receivedOn)).toBe(161_000 - 66_600);
    expect(await apLedger(world)).toBe(ledgerBefore + 111_000 - 66_600);

    // No payable of the supplier is ever below zero.
    const { rows } = await owner.query<{ lowest: string }>(
      `SELECT min(original_idr - settled_idr)::text AS lowest FROM accounting_open_items
        WHERE tenant_id = $1 AND kind = 'payable' AND legal_entity_id = $2`,
      [tenantId, world.entityId],
    );
    expect(Number(rows[0]!.lowest)).toBeGreaterThanOrEqual(0);
  });
});
