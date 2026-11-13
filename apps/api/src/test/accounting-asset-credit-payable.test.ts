// legend-gzeya: a fixed asset bought on credit creates the supplier payable (AP
// open item) in the same transaction as its acquisition journal, without
// booking the debt twice next to a supplier invoice.
// Written fail-first from the card text (bd show legend-gzeya) and the design
// scratchpad design.md sections 3 and 8, not from the implementation.
//
// Money rules under test (founder: nobody is paid more, the outlet never loses):
// - Asset on credit: payable open item = cost, so the ledger accounts_payable
//   equals the payable card (aging); sending the same request again books
//   neither a second asset, a second journal nor a second open item.
// - An asset naming a supplier invoice (matched or held) as source is refused
//   409 and leaves no asset, journal or open item; the invoice payable stays
//   the only debt of that purchase.
// - Another tenant's supplier is refused 422; nothing is written.
// - What a payment may settle never exceeds the open item (cost).
//
// Assumptions (the design fixes the contract, a few details are open):
// - The credit purchase is an asset with `sourceDocumentId` (the supplier's
//   document id; any new uuid) plus a `payable` block (supplier, document number,
//   document date, due date), as the design's input contract says. The service is
//   called with the same shape the validator accepts.
// - The open item is found by entity and supplier (counterparty), not by id.
// - "422" for a missing/forbidden `payable` block is asserted at the validator
//   (shared schema), the same schema the HTTP route parses; the foreign supplier
//   is asserted through the service (status 422).
// - The payment limit is the database check settled <= original (the supplier
//   payment flow is not under test); it is exercised as the migration owner.
// - Ids CP-nn name the cases below.
// - One supplier document = one asset (limiting rule, the founder may loosen it
//   later): a source id that is a purchase order or goods receipt of the tenant,
//   or a supplier + document number already used (case and surrounding spaces
//   ignored) by another asset or a supplier invoice, is refused 409. The
//   purchase through a PO is booked by its supplier invoice, never twice.
//   A held supplier invoice (no open item yet) already owns its number (CP-14).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema, type UserId } from "@starter/shared/core";
import { createFixedAssetInputSchema } from "@starter/shared/accounting";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createFixedAsset } from "../services/accounting-fixed-assets.service.ts";
import { getAgingReport } from "../services/accounting-open-items.service.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import {
  releaseSupplierInvoice,
  setSupplierInvoicePostingEnabled,
} from "../services/purchasing-invoice.service.ts";
import {
  addDays,
  apLedger,
  closeOwner,
  hex,
  invoicePo,
  key,
  outletScope,
  owner,
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

const COST = 5_000_000;

type AssetInput = Parameters<typeof createFixedAsset>[1];

function creditAssetInput(
  world: ApWorld,
  receivedOn: string,
  options: {
    sourceId?: string | null;
    supplierId?: string;
    documentNumber?: string;
    idempotencyKey?: string;
  } = {},
): AssetInput {
  const sourceId =
    options.sourceId === undefined ? randomUUID() : options.sourceId;
  return {
    legalEntityId: world.entityId,
    outletId: world.outletId,
    name: "Mesin espresso",
    acquiredOn: receivedOn,
    costIdr: COST,
    residualValueIdr: 0,
    usefulLifeMonths: 12,
    depreciationStartPeriod: receivedOn.slice(0, 7),
    sourceDocumentId: sourceId,
    payable:
      sourceId === null
        ? null
        : {
            supplierId: options.supplierId ?? world.supplierId,
            documentNumber: options.documentNumber ?? `FAKTUR-ASET-${hex()}`,
            documentDate: receivedOn,
            dueOn: addDays(receivedOn, 30),
          },
    idempotencyKey: options.idempotencyKey ?? key(),
  } as unknown as AssetInput;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, [tenantId, ...params]);
  return Number(rows[0]!.n);
}

const assetCount = (world: ApWorld) =>
  count(
    "SELECT count(*)::text AS n FROM fixed_assets WHERE tenant_id = $1 AND legal_entity_id = $2",
    world.entityId,
  );

const acquisitionJournals = (world: ApWorld) =>
  count(
    `SELECT count(*)::text AS n FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'asset_acquisition'`,
    world.entityId,
  );

const payableItems = async (world: ApWorld) =>
  (
    await owner.query<{
      id: string;
      original_idr: string;
      settled_idr: string;
      counterparty_id: string;
    }>(
      `SELECT id, original_idr::text, settled_idr::text, counterparty_id
         FROM accounting_open_items
        WHERE tenant_id = $1 AND kind = 'payable' AND legal_entity_id = $2`,
      [tenantId, world.entityId],
    )
  ).rows;

async function card(world: ApWorld, asOf: string): Promise<number> {
  const report = await getAgingReport(tenantScope(), {
    legalEntityId: world.entityId,
    kind: "payable",
    asOf,
  });
  return report.totalIdr;
}

describe("legend-gzeya an asset bought on credit owes the supplier once", () => {
  it("CP-01 the acquisition books Dr fixed assets / Cr accounts payable and one open item of exactly the cost; ledger = card", async () => {
    const world = await setupApWorld();
    const { receivedOn } = await seedReceivedPo(world);

    const asset = await createFixedAsset(
      tenantScope(),
      creditAssetInput(world, receivedOn),
      actor,
    );

    expect(asset.costIdr).toBe(COST);
    const items = await payableItems(world);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      original_idr: String(COST),
      settled_idr: "0",
      counterparty_id: world.supplierId,
    });
    expect(await acquisitionJournals(world)).toBe(1);
    expect(await apLedger(world)).toBe(COST);
    expect(await card(world, receivedOn)).toBe(COST);
    // The debt is not a tax invoice record (no supplier_invoices row).
    expect(
      await count(
        "SELECT count(*)::text AS n FROM supplier_invoices WHERE tenant_id = $1 AND supplier_id = $2",
        world.supplierId,
      ),
    ).toBe(0);
  });

  it("CP-02 the same request sent again (same idempotency key) books nothing more", async () => {
    const world = await setupApWorld();
    const { receivedOn } = await seedReceivedPo(world);
    const input = creditAssetInput(world, receivedOn);

    await createFixedAsset(tenantScope(), input, actor);
    await createFixedAsset(tenantScope(), input, actor);

    expect(await assetCount(world)).toBe(1);
    expect(await acquisitionJournals(world)).toBe(1);
    expect(await payableItems(world)).toHaveLength(1);
    expect(await apLedger(world)).toBe(COST);
    expect(await card(world, receivedOn)).toBe(COST);
  });

  it("CP-03 an asset with no source document is cash: no open item, as before", async () => {
    const world = await setupApWorld();
    const { receivedOn } = await seedReceivedPo(world);

    await createFixedAsset(
      tenantScope(),
      creditAssetInput(world, receivedOn, { sourceId: null }),
      actor,
    );

    expect(await assetCount(world)).toBe(1);
    expect(await payableItems(world)).toHaveLength(0);
  });

  it("CP-04 the input contract: a source document needs the payable block, the block needs a source, the due date is not before the document date", () => {
    const base = {
      legalEntityId: randomUUID(),
      outletId: randomUUID(),
      name: "Mesin espresso",
      acquiredOn: "2026-11-01",
      costIdr: COST,
      residualValueIdr: 0,
      usefulLifeMonths: 12,
      depreciationStartPeriod: "2026-11",
      idempotencyKey: key(),
    };
    const payable = {
      supplierId: randomUUID(),
      documentNumber: "FAKTUR-1",
      documentDate: "2026-11-01",
      dueOn: "2026-12-01",
    };

    expect(
      createFixedAssetInputSchema.safeParse({
        ...base,
        sourceDocumentId: randomUUID(),
        payable,
      }).success,
    ).toBe(true);
    expect(
      createFixedAssetInputSchema.safeParse({
        ...base,
        sourceDocumentId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      createFixedAssetInputSchema.safeParse({
        ...base,
        sourceDocumentId: randomUUID(),
        payable: null,
      }).success,
    ).toBe(false);
    expect(
      createFixedAssetInputSchema.safeParse({
        ...base,
        sourceDocumentId: null,
        payable,
      }).success,
    ).toBe(false);
    expect(
      createFixedAssetInputSchema.safeParse({
        ...base,
        sourceDocumentId: randomUUID(),
        payable: { ...payable, dueOn: "2026-10-31" },
      }).success,
    ).toBe(false);
    // Control: a cash asset (no source, no block) is valid.
    expect(
      createFixedAssetInputSchema.safeParse({
        ...base,
        sourceDocumentId: null,
      }).success,
    ).toBe(true);
  });

  it("CP-05 a supplier of another tenant (or unknown) is refused 422 and nothing is written", async () => {
    const world = await setupApWorld();
    const { receivedOn } = await seedReceivedPo(world);
    const ledgerBefore = await apLedger(world);

    await expect(
      createFixedAsset(
        tenantScope(),
        creditAssetInput(world, receivedOn, { supplierId: randomUUID() }),
        actor,
      ),
    ).rejects.toMatchObject({ status: 422 });

    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await payableItems(world)).toHaveLength(0);
    expect(await apLedger(world)).toBe(ledgerBefore);
  });
});

describe("legend-gzeya the debt of one purchase is booked once", () => {
  it("CP-06 an asset naming a matched or held supplier invoice as source is refused 409 and the invoice payable stays the only debt", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const matched = await invoicePo(world, fx, {
      quantity: 6,
      ppnIdr: 6_600,
    });
    expect(matched.invoice.status).toBe("matched");
    const held = await invoicePo(world, fx, {
      quantity: 4,
      ppnIdr: 4_400,
      unitPriceIdr: 12_000,
    });
    expect(held.invoice.status).toBe("held");
    const ledgerBefore = await apLedger(world);
    const itemsBefore = await payableItems(world);
    expect(ledgerBefore).toBe(66_600);

    for (const invoiceId of [matched.invoice.id, held.invoice.id]) {
      await expect(
        createFixedAsset(
          tenantScope(),
          creditAssetInput(world, fx.receivedOn, { sourceId: invoiceId }),
          actor,
        ),
      ).rejects.toMatchObject({ status: 409 });
    }

    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await payableItems(world)).toEqual(itemsBefore);
    expect(await apLedger(world)).toBe(ledgerBefore);
  });

  it("CP-07 an asset on credit next to a PO invoice: the ledger holds each debt once (invoice + asset), card = ledger", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    expect(invoice.status).toBe("matched");

    await createFixedAsset(
      tenantScope(),
      creditAssetInput(world, fx.receivedOn),
      actor,
    );

    expect(await payableItems(world)).toHaveLength(2);
    expect(await apLedger(world)).toBe(111_000 + COST);
    expect(await card(world, fx.receivedOn)).toBe(111_000 + COST);
  });

  it("CP-08 the open item of the asset can never be settled for more than the cost", async () => {
    const world = await setupApWorld();
    const { receivedOn } = await seedReceivedPo(world);
    await createFixedAsset(
      tenantScope(),
      creditAssetInput(world, receivedOn),
      actor,
    );
    const [item] = await payableItems(world);
    expect(item).toBeDefined();

    // Paying exactly the cost is fine; one rupiah more is refused.
    await expect(
      owner.query(
        `UPDATE accounting_open_items SET settled_idr = $3
          WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
        [tenantId, item!.id, COST + 1],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await owner.query(
      `UPDATE accounting_open_items SET settled_idr = $3
        WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
      [tenantId, item!.id, COST],
    );
    expect(Number((await payableItems(world))[0]!.settled_idr)).toBe(COST);
  });
});

describe("legend-gzeya one supplier document is one debt", () => {
  it("CP-09 an asset naming a purchase order as source is refused 409: no asset, journal or open item", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
    });
    expect(invoice.status).toBe("matched");
    const ledgerBefore = await apLedger(world);
    const itemsBefore = await payableItems(world);

    await expect(
      createFixedAsset(
        tenantScope(),
        creditAssetInput(world, fx.receivedOn, { sourceId: fx.poId }),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await payableItems(world)).toEqual(itemsBefore);
    expect(await apLedger(world)).toBe(ledgerBefore);
  });

  it("CP-10 an asset naming a goods receipt as source is refused 409: no asset, journal or open item", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const ledgerBefore = await apLedger(world);

    await expect(
      createFixedAsset(
        tenantScope(),
        creditAssetInput(world, fx.receivedOn, { sourceId: fx.receiptId }),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await payableItems(world)).toHaveLength(0);
    expect(await apLedger(world)).toBe(ledgerBefore);
  });

  it("CP-11 a second asset with the same supplier and document number (other spaces or letters, new idempotency key) is refused 409", async () => {
    const world = await setupApWorld();
    const { receivedOn } = await seedReceivedPo(world);
    const number = `FAKTUR-DUP-${hex()}`;

    await createFixedAsset(
      tenantScope(),
      creditAssetInput(world, receivedOn, { documentNumber: number }),
      actor,
    );
    expect(await payableItems(world)).toHaveLength(1);

    await expect(
      createFixedAsset(
        tenantScope(),
        creditAssetInput(world, receivedOn, {
          documentNumber: `  ${number.toLowerCase()} `,
        }),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await assetCount(world)).toBe(1);
    expect(await acquisitionJournals(world)).toBe(1);
    expect(await payableItems(world)).toHaveLength(1);
    expect(await apLedger(world)).toBe(COST);
    expect(await card(world, receivedOn)).toBe(COST);
  });

  it("CP-12 an asset with the document number of an existing supplier invoice of the same supplier is refused 409", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const number = `INV-DUP-${hex()}`;
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 11_000,
      number,
    });
    expect(invoice.status).toBe("matched");
    const ledgerBefore = await apLedger(world);
    const itemsBefore = await payableItems(world);

    await expect(
      createFixedAsset(
        tenantScope(),
        creditAssetInput(world, fx.receivedOn, { documentNumber: number }),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await payableItems(world)).toEqual(itemsBefore);
    expect(await apLedger(world)).toBe(ledgerBefore);
  });

  it("CP-13 a supplier invoice with the document number of an existing asset debt of the same supplier (other spaces or letters) is refused 409: one open item only", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const number = `FAKTUR-ASET-INV-${hex()}`;

    await createFixedAsset(
      tenantScope(),
      creditAssetInput(world, fx.receivedOn, { documentNumber: number }),
      actor,
    );
    expect(await payableItems(world)).toHaveLength(1);
    const ledgerBefore = await apLedger(world);

    await expect(
      invoicePo(world, fx, {
        quantity: 10,
        ppnIdr: 11_000,
        number: `  ${number.toLowerCase()} `,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await payableItems(world)).toHaveLength(1);
    expect(await apLedger(world)).toBe(ledgerBefore);
    expect(await card(world, fx.receivedOn)).toBe(COST);
  });

  it("CP-14 a held supplier invoice (no open item yet) already owns its document number: an asset with the same supplier and number (other spaces or letters) is refused 409, and releasing the invoice then leaves exactly one open item", async () => {
    const world = await setupApWorld();
    const fx = await seedReceivedPo(world);
    const number = `INV-HELD-${hex()}`;
    // Price +20% is outside the default 0 bp tolerance: the invoice is held.
    const { invoice } = await invoicePo(world, fx, {
      quantity: 10,
      ppnIdr: 12_000,
      unitPriceIdr: 12_000,
      number,
    });
    expect(invoice.status).toBe("held");
    expect(await payableItems(world)).toHaveLength(0);

    await expect(
      createFixedAsset(
        tenantScope(),
        creditAssetInput(world, fx.receivedOn, {
          documentNumber: `  ${number.toLowerCase()} `,
        }),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await assetCount(world)).toBe(0);
    expect(await acquisitionJournals(world)).toBe(0);
    expect(await payableItems(world)).toHaveLength(0);

    const released = await releaseSupplierInvoice(
      outletScope(world.outletId),
      world.finance.userId,
      invoice.id,
      {
        note: "Harga naik disetujui finance",
        idempotencyKey: key(),
      } as Parameters<typeof releaseSupplierInvoice>[3],
    );
    expect(released.invoice.status).toBe("released");
    expect(await payableItems(world)).toHaveLength(1);
    expect(await assetCount(world)).toBe(0);
  });
});
