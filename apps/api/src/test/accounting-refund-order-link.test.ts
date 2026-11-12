// Card knfl6 (538-G3 slice A): the refund journal carries its order id, and the
// PBJT tax report takes the refund's tax base exactly from the order's tax
// snapshot (prorated by refund tax / order tax) instead of an estimate. A refund
// never returns more tax than the order collected.
// Fail-first: today journal_entries has no order id (a refund journal's source id
// is the refund id), the refund base is a period-ratio estimate, and nothing caps
// the refunded tax at what was collected.
//
// Rules under test (brief 538-g3-sub, slice A):
// - journal_entries.order_id is set on the order's sale journal and on each of its
//   refund journals.
// - Report line (type pbjt) base = sum of PBJT snapshot bases of sold orders minus
//   the refunded share of each order's PBJT base (refund PBJT tax / order PBJT
//   tax). A full refund removes the whole base; a half refund half of it.
// - The PBJT report counts only PBJT: PPN and other tax of a mixed order never
//   enter the PBJT line.
// - Refunds (singly or added up) that would return more tax than was collected are
//   not posted; no payable account ever ends up debit-heavy because of them.
//
// Assumptions: journal_entries.order_id may hold the uuid or ULID text form of the
// order id (both accepted). "Not posted" means the delivery result status is
// neither "posted" nor "already_posted" (parked or failed), with no refund journal.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { defaultTaxLineSource } from "../services/accounting-tax-line-source.ts";
import {
  balanceOf,
  contextOf,
  createUlid,
  deliver,
  journalCount,
  makeWorld,
  orderIdForms,
  orderIdOf,
  orderPaid,
  orderRefunded,
  owner,
  post,
  seedPosOrder,
  sourceTypeOf,
  type Sale,
  type World,
} from "./accounting-tax-split-helpers.ts";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

/** PBJT 10% + PPN 2% + other 1% on a 100.000 base: tax 13.000. */
const mixedSale: Sale = {
  grossSalesIdr: 100_000,
  snapshots: {
    pbjt: { baseIdr: 100_000, taxIdr: 10_000, rateBp: 1000 },
    ppn: { baseIdr: 100_000, taxIdr: 2_000, rateBp: 200 },
    other: { baseIdr: 100_000, taxIdr: 1_000, rateBp: 100 },
  },
};

const octoberPbjtLines = (world: World) =>
  withTenant(db, contextOf(world.tenant), (tx) =>
    defaultTaxLineSource(tx, {
      tenantId: tenantIdSchema.parse(world.tenant.id),
      legalEntityId: world.entity,
      type: "pbjt",
      period: "2026-10",
    }),
  );

async function sell(world: World, sale: Sale): Promise<string> {
  const orderUlid = createUlid();
  await seedPosOrder(world, orderUlid, sale);
  await post(world, orderPaid(world, orderUlid, sale));
  return orderUlid;
}

describe("knfl6 refund journal carries the order id", () => {
  it("knfl6 the sale journal and each refund journal of an order point to that order", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, mixedSale);
    const saleEntry = await post(world, orderPaid(world, orderUlid, mixedSale));
    const firstRefund = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 6_500,
      }),
    );
    const secondRefund = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 6_500,
      }),
    );

    expect(await sourceTypeOf(world, firstRefund)).toBe("refund");
    for (const entryId of [saleEntry, firstRefund, secondRefund])
      expect(orderIdForms(orderUlid)).toContain(
        await orderIdOf(world, entryId),
      );
  });

  it("knfl6 refund journals of different orders do not share an order id", async () => {
    const world = await makeWorld();
    const first = await sell(world, mixedSale);
    const second = await sell(world, mixedSale);
    const refundOfFirst = await post(
      world,
      orderRefunded(world, first, createUlid(), {
        grossSalesIdr: 100_000,
        taxIdr: 13_000,
      }),
    );

    expect(orderIdForms(first)).toContain(
      await orderIdOf(world, refundOfFirst),
    );
    expect(orderIdForms(second)).not.toContain(
      await orderIdOf(world, refundOfFirst),
    );
  });
});

describe("knfl6 refund tax base comes exactly from the order snapshot", () => {
  it("knfl6 a full refund takes out the order's whole base even when the period's base/tax ratio differs", async () => {
    const world = await makeWorld();
    // Order A: PBJT 10% (base 100.000, tax 10.000). Order B: PBJT 5% (base
    // 100.000, tax 5.000). The period ratio base/tax is 200.000/15.000, so a ratio
    // estimate of B's refund base (5.000 x 13,33) is 66.667, not 100.000.
    await sell(world, {
      grossSalesIdr: 100_000,
      snapshots: { pbjt: { baseIdr: 100_000, taxIdr: 10_000, rateBp: 1000 } },
    });
    const orderB = await sell(world, {
      grossSalesIdr: 100_000,
      snapshots: { pbjt: { baseIdr: 100_000, taxIdr: 5_000, rateBp: 500 } },
    });
    await post(
      world,
      orderRefunded(world, orderB, createUlid(), {
        grossSalesIdr: 100_000,
        taxIdr: 5_000,
      }),
    );

    const lines = await octoberPbjtLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ baseIdr: 100_000, taxIdr: 10_000 });
  });

  it("knfl6 a half refund of a mixed order removes half of the PBJT base, and PPN / other never enter the PBJT line", async () => {
    const world = await makeWorld();
    const orderUlid = await sell(world, mixedSale);
    await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 6_500,
      }),
    );

    const lines = await octoberPbjtLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ baseIdr: 50_000, taxIdr: 5_000 });
  });

  it("knfl6 a discounted order refunded in full removes exactly its discounted base", async () => {
    const world = await makeWorld();
    // Gross 100.000 less discount 20.000: PBJT 10% on 80.000 = 8.000. A second,
    // undiscounted order stays in the period; the refund must remove only 80.000.
    await sell(world, {
      grossSalesIdr: 100_000,
      snapshots: { pbjt: { baseIdr: 100_000, taxIdr: 10_000, rateBp: 1000 } },
    });
    const discounted = await sell(world, {
      grossSalesIdr: 100_000,
      discountIdr: 20_000,
      snapshots: { pbjt: { baseIdr: 80_000, taxIdr: 8_000, rateBp: 1000 } },
    });
    await post(
      world,
      orderRefunded(world, discounted, createUlid(), {
        grossSalesIdr: 80_000,
        taxIdr: 8_000,
      }),
    );

    const lines = await octoberPbjtLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ baseIdr: 100_000, taxIdr: 10_000 });
  });

  it("knfl6 a fully refunded order leaves no PBJT line", async () => {
    const world = await makeWorld();
    const orderUlid = await sell(world, mixedSale);
    await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 100_000,
        taxIdr: 13_000,
      }),
    );

    expect(await octoberPbjtLines(world)).toEqual([]);
  });
});

describe("knfl6 a refund never returns more tax than was collected", () => {
  it("knfl6 a refund whose tax exceeds the order's tax is not posted", async () => {
    const world = await makeWorld();
    const orderUlid = await sell(world, mixedSale);

    const result = await deliver(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 100_000,
        taxIdr: 14_000,
      }),
    );

    expect(["posted", "already_posted"]).not.toContain(result.status);
    // Only the sale journal exists; every payable account still holds its credit.
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(-10_000);
    expect(await balanceOf(world, "tax_payable_ppn")).toBe(-2_000);
    expect(await balanceOf(world, "tax_payable_other")).toBe(-1_000);
  });

  it("knfl6 two refunds that together exceed the collected tax: the second is not posted", async () => {
    const world = await makeWorld();
    const orderUlid = await sell(world, mixedSale);
    await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 60_000,
        taxIdr: 8_000,
      }),
    );

    // 8.000 + 8.000 = 16.000 > 13.000 collected.
    const second = await deliver(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 40_000,
        taxIdr: 8_000,
      }),
    );

    expect(["posted", "already_posted"]).not.toContain(second.status);
    // sale + first refund only; 13.000 - 8.000 of tax is still payable.
    expect(await journalCount(world)).toBe(2);
    const stillPayable =
      -(await balanceOf(world, "tax_payable_pbjt")) -
      (await balanceOf(world, "tax_payable_ppn")) -
      (await balanceOf(world, "tax_payable_other"));
    expect(stillPayable).toBe(5_000);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBeLessThanOrEqual(0);
    expect(await balanceOf(world, "tax_payable_ppn")).toBeLessThanOrEqual(0);
    expect(await balanceOf(world, "tax_payable_other")).toBeLessThanOrEqual(0);
  });

  it("knfl6 two refunds that exactly use up the collected tax both post and zero the payables", async () => {
    const world = await makeWorld();
    const orderUlid = await sell(world, mixedSale);
    await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 6_500,
      }),
    );
    await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 6_500,
      }),
    );

    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
    expect(await balanceOf(world, "tax_payable_ppn")).toBe(0);
    expect(await balanceOf(world, "tax_payable_other")).toBe(0);
  });
});
