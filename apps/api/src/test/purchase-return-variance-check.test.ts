// Read-only check of old purchase returns that missed their price variance
// (card legend-eestb, brief docs/briefs/991-akuntansi-kas-supplier.md section
// E). Written fail-first from the brief, not from the implementation.
//
// Background: when a supplier invoice was billed at another price than the PO
// (a held invoice that finance released, or one inside the tolerance), a
// return of the invoiced part must carry
//   price_variance_idr = billed - invoicedValue
// (billed from the FIFO slot of each invoice line, invoicedValue at PO price).
// Returns recorded before the fix stored 0. The script lists, per tenant, every
// posted return with invoiced_value_idr > 0 whose stored variance differs from
// the one the formula gives. An empty report means safe. It never writes.
//
// Contract the tests rely on (the brief only fixes the behaviour, so these are
// assumptions, also stated in the report):
// - The script exports the core function
//     checkPurchaseReturnVariance({ tenant?: string }): Promise<{ findings: Finding[] }>
//   `tenant` is a tenant SLUG (like `--tenant` of metrics-daily-backfill.ts);
//   without it every tenant is scanned.
// - Finding = { tenantId, purchaseReturnId, storedPriceVarianceIdr,
//   expectedPriceVarianceIdr, differenceIdr } with differenceIdr = expected -
//   stored, all signed integer rupiah.
// - A return is only a finding when stored != expected: a correct stored value,
//   no price difference and a return of not-yet-invoiced goods are all clean.
// - Fixtures: PO price Rp 10.000 per unit; an invoice at another price is held
//   (default tolerance 0 bp) and released by finance, so it is billed at the
//   invoice price. "Old" returns are simulated by writing the stored column as
//   the migration owner (the same state the pre-fix code left behind).
// - The shared Cafe Legend tenant also holds the rows of other test files, so
//   assertions look up this file's returns by id, never count tenant-wide.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import {
  releaseSupplierInvoice,
  setSupplierInvoicePostingEnabled,
} from "../services/purchasing-invoice.service.ts";
import { checkPurchaseReturnVariance } from "../scripts/purchase-return-variance-check.ts";
import { createIsolatedTenant } from "./floor-test-helpers.ts";
import {
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
  stockOf,
  tenantId,
  type ApWorld,
  type ReceivedPo,
} from "./purchasing-ap-world.ts";

const TENANT_SLUG = cafeLegendPlatformFixtures.tenant.slug;

type Finding = {
  tenantId: string;
  purchaseReturnId: string;
  storedPriceVarianceIdr: number;
  expectedPriceVarianceIdr: number;
  differenceIdr: number;
  needsManualReview?: boolean;
};

beforeAll(() => {
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
});

afterAll(async () => {
  setAuditWriter(null);
  setPurchaseReturnPostingEnabled(null);
  setSupplierInvoicePostingEnabled(null);
  await closeOwner();
});

async function scan(): Promise<Finding[]> {
  const result = await checkPurchaseReturnVariance({ tenant: TENANT_SLUG });
  return result.findings as Finding[];
}
const findingOf = (findings: Finding[], returnId: string) =>
  findings.find((finding) => finding.purchaseReturnId === returnId);

/** Writes the stored variance as the migration owner (triggers bypassed). */
async function storeVariance(
  returnId: string,
  valueIdr: number,
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rowCount } = await client.query(
      "UPDATE purchase_returns SET price_variance_idr = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, returnId, valueIdr],
    );
    expect(rowCount).toBe(1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

type Scenario = {
  world: ApWorld;
  fx: ReceivedPo;
  returnId: string;
  invoiceId: string | null;
};

/**
 * Receives `received` units at Rp 10.000, bills `invoiceQty` units at
 * `invoicePrice` (releasing it when the price difference held it), then
 * returns `returnQty` units. `invoiceQty` 0 means no invoice at all.
 */
async function scenario(options: {
  received?: number;
  invoiceQty: number;
  invoicePrice?: number;
  ppnIdr?: number;
  returnQty: number;
}): Promise<Scenario> {
  const world = await setupApWorld();
  let invoiceId: string | null = null;
  const fx = await seedReceivedPo(world, {
    quantity: options.received ?? 10,
  });
  if (options.invoiceQty > 0) {
    const created = await invoicePo(world, fx, {
      quantity: options.invoiceQty,
      ppnIdr: options.ppnIdr ?? 0,
      ...(options.invoicePrice === undefined
        ? {}
        : { unitPriceIdr: options.invoicePrice }),
    });
    invoiceId = created.invoice.id;
    if (created.invoice.status === "held")
      await releaseSupplierInvoice(
        outletScope(world.outletId),
        world.finance.userId,
        created.invoice.id,
        {
          note: "Selisih harga disetujui finance",
          idempotencyKey: key(),
        } as Parameters<typeof releaseSupplierInvoice>[3],
      );
    else expect(created.invoice.status).toBe("matched");
  }
  const { purchaseReturn } = await returnPo(world, fx, options.returnQty);
  return { world, fx, returnId: purchaseReturn.id, invoiceId };
}

describe("legend-eestb purchase return variance check", () => {
  it("[legend-eestb-VC-1] an old return of goods billed above the PO price is found with the right expected variance", async () => {
    // Billed 12.000 per unit, PO 10.000, 3 units returned: 36.000 - 30.000.
    const { returnId } = await scenario({
      invoiceQty: 10,
      invoicePrice: 12_000,
      ppnIdr: 11_000,
      returnQty: 3,
    });
    expect((await returnRow(returnId)).invoiced).toBe(30_000);
    await storeVariance(returnId, 0);

    const finding = findingOf(await scan(), returnId);
    expect(finding).toBeDefined();
    expect(finding).toMatchObject({
      tenantId,
      purchaseReturnId: returnId,
      storedPriceVarianceIdr: 0,
      expectedPriceVarianceIdr: 6_000,
      differenceIdr: 6_000,
    });
    // The invoice existed before the return: no manual review needed.
    expect(finding!.needsManualReview).toBeFalsy();
  });

  it("[legend-eestb-VC-2] only the invoiced part of a mixed return counts (not-invoiced-first)", async () => {
    // Received 10, billed 8 at 12.000, return 4: 2 units were never billed, 2
    // are billed. Invoiced value 20.000 at PO price, billed 24.000.
    const { returnId } = await scenario({
      invoiceQty: 8,
      invoicePrice: 12_000,
      ppnIdr: 8_800,
      returnQty: 4,
    });
    expect(await returnRow(returnId)).toMatchObject({
      uninvoiced: 20_000,
      invoiced: 20_000,
    });
    await storeVariance(returnId, 0);

    expect(findingOf(await scan(), returnId)).toMatchObject({
      storedPriceVarianceIdr: 0,
      expectedPriceVarianceIdr: 4_000,
      differenceIdr: 4_000,
    });
  });

  it("[legend-eestb-VC-3] a price below the PO gives a negative expected variance", async () => {
    // Billed 9.000 per unit, 2 units returned: 18.000 - 20.000.
    const { returnId } = await scenario({
      invoiceQty: 10,
      invoicePrice: 9_000,
      ppnIdr: 5_000,
      returnQty: 2,
    });
    await storeVariance(returnId, 0);

    expect(findingOf(await scan(), returnId)).toMatchObject({
      storedPriceVarianceIdr: 0,
      expectedPriceVarianceIdr: -2_000,
      differenceIdr: -2_000,
    });
  });

  it("[legend-eestb-VC-4] a wrong non-zero stored value is found too, with the gap to the formula", async () => {
    const { returnId } = await scenario({
      invoiceQty: 10,
      invoicePrice: 12_000,
      ppnIdr: 11_000,
      returnQty: 3,
    });
    await storeVariance(returnId, 1_000);

    expect(findingOf(await scan(), returnId)).toMatchObject({
      storedPriceVarianceIdr: 1_000,
      expectedPriceVarianceIdr: 6_000,
      differenceIdr: 5_000,
    });
  });

  it("[legend-eestb-VC-5] clean returns are not reported: stored value correct, no price difference, nothing invoiced", async () => {
    // Billed above PO but the stored variance already equals the formula.
    const correct = await scenario({
      invoiceQty: 10,
      invoicePrice: 12_000,
      ppnIdr: 11_000,
      returnQty: 3,
    });
    await storeVariance(correct.returnId, 6_000);
    // Billed exactly at the PO price: variance 0 is right.
    const samePrice = await scenario({
      invoiceQty: 10,
      ppnIdr: 11_000,
      returnQty: 3,
    });
    await storeVariance(samePrice.returnId, 0);
    // Never billed: the whole return is not invoiced, no variance to carry.
    const unbilled = await scenario({ invoiceQty: 0, returnQty: 3 });
    expect((await returnRow(unbilled.returnId)).invoiced).toBe(0);

    const findings = await scan();
    for (const { returnId } of [correct, samePrice, unbilled])
      expect(findingOf(findings, returnId)).toBeUndefined();
  });

  it("[legend-eestb-VC-6] a tenant without any such return gives an empty report (safe)", async () => {
    // A flagged return exists in the Cafe Legend tenant (control: it is found
    // there), but a different, empty tenant must report nothing and never show
    // that tenant's rows.
    const { returnId } = await scenario({
      invoiceQty: 10,
      invoicePrice: 12_000,
      ppnIdr: 11_000,
      returnQty: 3,
    });
    await storeVariance(returnId, 0);
    expect(findingOf(await scan(), returnId)).toBeDefined();

    const empty = await createIsolatedTenant(
      `varcheck-${randomUUID().slice(0, 6)}`,
    );
    const { rows } = await owner.query<{ slug: string }>(
      "SELECT slug FROM tenants WHERE id = $1",
      [empty.tenantId],
    );
    const result = await checkPurchaseReturnVariance({
      tenant: rows[0]!.slug,
    });
    expect(result.findings).toEqual([]);
  });

  it("[legend-eestb-VC-7] the check writes nothing: returns, journals, stock and the report itself are unchanged", async () => {
    const { world, fx, returnId } = await scenario({
      invoiceQty: 10,
      invoicePrice: 12_000,
      ppnIdr: 11_000,
      returnQty: 3,
    });
    await storeVariance(returnId, 0);

    const snapshot = async () => ({
      returnRow: (
        await owner.query(
          "SELECT to_jsonb(r) AS row FROM purchase_returns r WHERE tenant_id = $1 AND id = $2",
          [tenantId, returnId],
        )
      ).rows[0],
      returns: (
        await owner.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM purchase_returns WHERE tenant_id = $1 AND purchase_order_id = $2",
          [tenantId, fx.poId],
        )
      ).rows[0]!.n,
      journals: await journalCount(world),
      outbox: (
        await owner.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2",
          [tenantId, returnId],
        )
      ).rows[0]!.n,
      openItems: (
        await owner.query(
          `SELECT id, settled_idr::text AS settled FROM accounting_open_items
            WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY id`,
          [tenantId, world.entityId],
        )
      ).rows,
      stock: await stockOf(fx.locationId, fx.itemId),
    });

    const before = await snapshot();
    const first = await scan();
    const second = await scan();
    expect(await snapshot()).toEqual(before);
    // The stored variance is still the old 0: the check reported, not repaired.
    expect((await returnRow(returnId)).priceVariance).toBe(0);
    // Running it again finds the same thing.
    expect(findingOf(second, returnId)).toEqual(findingOf(first, returnId));
    expect(findingOf(first, returnId)).toBeDefined();
  });
  it("[legend-eestb-VC-8] an invoice created after the return was posted is a finding flagged needsManualReview", async () => {
    // The FIFO slots of the invoice cannot be trusted for a return that was
    // posted before the invoice existed, so the formula's number is only a
    // hint: the finding says a person must review it. Simulated by moving the
    // invoice's creation time after the return (owner write, triggers bypassed).
    // Assumption: the flag is the boolean `needsManualReview` on the finding.
    const { returnId, invoiceId } = await scenario({
      invoiceQty: 10,
      invoicePrice: 12_000,
      ppnIdr: 11_000,
      returnQty: 3,
    });
    await storeVariance(returnId, 0);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const { rowCount } = await client.query(
        "UPDATE supplier_invoices SET created_at = clock_timestamp() + interval '1 day' WHERE tenant_id = $1 AND id = $2",
        [tenantId, invoiceId],
      );
      expect(rowCount).toBe(1);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const finding = findingOf(await scan(), returnId);
    expect(finding).toBeDefined();
    expect(finding).toMatchObject({
      purchaseReturnId: returnId,
      storedPriceVarianceIdr: 0,
      needsManualReview: true,
    });
  });
});
