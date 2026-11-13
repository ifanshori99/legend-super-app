// Anti dobel buku, docs/briefs/ws-purchasing-apar-design.md §5 "Anti dobel
// buku" and §9: the same purchase must never put its payable into the ledger
// twice. A supplier invoice books Dr GRNI / Cr Accounts Payable in the
// purchasing transaction; a fixed asset bought on that invoice must not post
// `asset_acquisition` (Dr fixed assets / Cr Accounts Payable) a second time,
// and the auto-journal consumer must not re-post the invoice journal.
// Written fail-first from the design contract, not from the implementation.
//
// Money rules under test (founder: nobody is paid more, the outlet never loses):
// - A supplier invoice journal never touches the fixed assets account.
// - `createFixedAsset` pointing at a supplier invoice (matched or held) as its
//   source document is refused with 409 before anything is posted.
// - `supplier_invoice.recorded` is not an auto-journal event (it is posted in
//   the purchasing transaction already).
// - The general ledger balance of accounts_payable equals the payable aging
//   total after an invoice, a held invoice released by finance, and a debit
//   note; redelivering the return changes neither.
//
// Assumptions (the brief does not pin these down):
// - A fixed asset with no source document is a legitimate asset and is not
//   refused (the guard is only for invoice ids); it is the control case.
// - The 409 of `createFixedAsset` is asserted by status only (its code is not
//   fixed by the design).
// - The held invoice in AD-04 is a price +20% case (PO price 10.000, invoice
//   12.000). PPN is 11% of the PO-priced goods, within the 12% cap whichever
//   way DPP is read (K6). Released by finance, the payable is the invoiced
//   amount: goods 40.000 + variance 8.000 + PPN 4.400 = 52.400.
// - How the debit note PPN is shared across invoices is not asserted, only that
//   card and ledger fall by exactly the invoiced value + PPN the return row
//   records.
// - The debit note enters through the same `purchase_return.recorded` event the
//   return wrote to the outbox, delivered to `deliverAutoJournalEvent`.
// - Ids AD-nn name the cases below.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema, type UserId } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createFixedAsset } from "../services/accounting-fixed-assets.service.ts";
import { getAgingReport } from "../services/accounting-open-items.service.ts";
import { AUTO_JOURNAL_EVENTS } from "../services/accounting-auto-journal-amounts.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import {
  releaseSupplierInvoice,
  setSupplierInvoicePostingEnabled,
} from "../services/purchasing-invoice.service.ts";
import {
  apLedger,
  closeOwner,
  invoicePo,
  journalCount,
  key,
  outletScope,
  owner,
  returnPo,
  returnRow,
  seedReceivedPo,
  setupApWorld,
  tenantId,
  tenantScope,
  type ApWorld,
} from "./purchasing-ap-world.ts";

const actor: UserId = userIdSchema.parse(randomUUID());

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

const assetInput = (
  world: ApWorld,
  receivedOn: string,
  sourceId: string | null,
) => ({
  legalEntityId: world.entityId,
  outletId: world.outletId,
  name: "Mesin espresso",
  acquiredOn: receivedOn,
  costIdr: 5_000_000,
  residualValueIdr: 0,
  usefulLifeMonths: 12,
  depreciationStartPeriod: receivedOn.slice(0, 7),
  sourceDocumentId: sourceId,
  payable:
    sourceId === null
      ? null
      : {
          supplierId: world.supplierId,
          documentNumber: `AST-${key()}`.slice(0, 60),
          documentDate: receivedOn,
          dueOn: receivedOn,
        },
  idempotencyKey: key(),
});

async function assetCount(world: ApWorld): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM fixed_assets WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}

async function cardTotal(world: ApWorld, asOf: string): Promise<number> {
  const report = await getAgingReport(tenantScope(), {
    legalEntityId: world.entityId,
    kind: "payable",
    asOf,
  });
  return report.totalIdr;
}

describe("legend-uyk2 an invoice and an asset never book the same payable twice", () => {
  it("AD-01 the supplier invoice journal has no fixed assets line and no asset_acquisition exists", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    expect(invoice.status).toBe("matched");

    const { rows: entries } = await owner.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE tenant_id = $1 AND source_type = 'supplier_invoice' AND source_id = $2`,
      [tenantId, invoice.id],
    );
    expect(entries).toHaveLength(1);
    const { rows: lines } = await owner.query<{
      account_id: string;
      debit_idr: string;
      credit_idr: string;
    }>(
      `SELECT account_id, debit_idr::text, credit_idr::text FROM journal_lines
        WHERE tenant_id = $1 AND entry_id = $2`,
      [tenantId, entries[0]!.id],
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines.some((line) => line.account_id === world.accounts.fixed_assets),
    ).toBe(false);
    // The one credit to accounts_payable is the invoice payable, booked once.
    const ap = lines.filter(
      (line) => line.account_id === world.accounts.accounts_payable,
    );
    expect(ap.map((line) => Number(line.credit_idr))).toEqual([111_000]);

    const { rows: acquisitions } = await owner.query(
      `SELECT 1 FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'asset_acquisition'`,
      [tenantId, world.entityId],
    );
    expect(acquisitions).toHaveLength(0);
    expect(await apLedger(world)).toBe(111_000);
  });

  it("AD-02 an asset sourced from a matched supplier invoice is refused with 409 and posts nothing", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    expect(invoice.status).toBe("matched");
    const journalsBefore = await journalCount(world);
    const ledgerBefore = await apLedger(world);

    await expect(
      createFixedAsset(
        tenantScope(),
        assetInput(world, fx.receivedOn, invoice.id),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await apLedger(world)).toBe(ledgerBefore);
    expect(await assetCount(world)).toBe(0);
  });

  it("AD-03 a held supplier invoice id is refused as an asset source too", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
      unitPriceIdr: 15_000,
    });
    expect(invoice.status).toBe("held");
    const journalsBefore = await journalCount(world);

    await expect(
      createFixedAsset(
        tenantScope(),
        assetInput(world, fx.receivedOn, invoice.id),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await assetCount(world)).toBe(0);
  });

  it("AD-04 control: an asset with no source document is still registered", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    await invoicePo(world, fx, { quantity: 10, ppnIdr: 11_000 });

    const created = await createFixedAsset(
      tenantScope(),
      assetInput(world, fx.receivedOn, null),
      actor,
    );

    expect(created.costIdr).toBe(5_000_000);
    expect(await assetCount(world)).toBe(1);
  });

  it("AD-05 supplier_invoice.recorded is not an auto-journal event", () => {
    // Its journal is posted inside the purchasing transaction. Listing it here
    // would make the consumer post it a second time.
    expect(AUTO_JOURNAL_EVENTS as readonly string[]).not.toContain(
      "supplier_invoice.recorded",
    );
    expect(AUTO_JOURNAL_EVENTS as readonly string[]).not.toContain(
      "supplier_invoice.matched",
    );
  });
});

describe("legend-uyk2 the ledger accounts_payable equals the payable card", () => {
  it("AD-06 after an invoice, a released hold and a debit note, ledger and card stay equal", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const tie = async (expected: number) => {
      expect(await apLedger(world)).toBe(expected);
      expect(await cardTotal(world, fx.receivedOn)).toBe(expected);
    };

    // 1. A clean invoice of 6 units: payable 60.000 + 6.600 PPN.
    const first = await invoicePo(world, fx, { quantity: 6, ppnIdr: 6_600 });
    expect(first.invoice.status).toBe("matched");
    await tie(66_600);

    // 2. A held invoice (price +20%) has no AP at all.
    const held = await invoicePo(world, fx, {
      quantity: 4,
      ppnIdr: 4_400,
      unitPriceIdr: 12_000,
    });
    expect(held.invoice.status).toBe("held");
    await tie(66_600);

    // 3. Finance releases it: the payable is exactly what the supplier billed.
    const released = await releaseSupplierInvoice(
      outletScope(world.outletId),
      world.finance.userId,
      held.invoice.id,
      {
        note: "Harga naik disetujui finance",
        idempotencyKey: key(),
      } as Parameters<typeof releaseSupplierInvoice>[3],
    );
    expect(released.invoice.status).toBe("released");
    expect(released.invoice.payableIdr).toBe(52_400);
    await tie(66_600 + 52_400);

    // 4. A return of 3 units, all billed now: the debit note lowers both
    // sides by the invoiced value plus PPN of the return row, once.
    const { purchaseReturn } = await returnPo(world, fx, 3);
    const split = await returnRow(purchaseReturn.id);
    expect(split.invoiced).toBeGreaterThan(0);
    const debitNote = split.invoiced + split.ppn;

    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'purchase_return.recorded'`,
      [tenantId, purchaseReturn.id],
    );
    expect(rows).toHaveLength(1);
    const event = eventEnvelopeSchema.parse(rows[0]!.event);
    const deliver = () =>
      withTenant(db, tenantScope(), (tx) =>
        deliverAutoJournalEvent(tenantScope(), event, tx, new Date()),
      );
    expect(await deliver()).toMatchObject({ status: "posted" });
    await tie(66_600 + 52_400 - debitNote);

    // 5. The same event again changes nothing.
    await deliver();
    await tie(66_600 + 52_400 - debitNote);
  });
});
