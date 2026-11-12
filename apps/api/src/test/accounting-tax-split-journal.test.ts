// Card xa9bc (538-G3 slice A): the sale journal of an order with several tax
// types books each tax into its own payable account, and the refund journal
// mirrors that split. Fail-first: today every tax lands in tax_payable_pbjt and
// the roles tax_payable_ppn / tax_payable_other do not exist.
//
// Rules under test (brief 538-g3-sub, slice A):
// - order.paid splits the order tax per tax type (tax_snapshots of the order:
//   pbjt / ppn / other) into Cr tax_payable_pbjt / tax_payable_ppn /
//   tax_payable_other. Journal debit = credit.
// - An order without snapshots (pre-cutover) stays all-PBJT.
// - order.refunded prorates the refund tax over the same types (refund tax /
//   order tax, largest remainder, so the parts add up exactly) and debits the
//   same accounts. Debit = credit.
//
// Assumptions: the payload `pbjtIdr` is the order's total tax (orders.tax_idr);
// a refund's tax is likewise the total refund tax. See accounting-tax-split-helpers.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  balanceOf,
  createUlid,
  expectBalanced,
  linesOf,
  orderPaid,
  orderRefunded,
  owner,
  post,
  seedPosOrder,
  makeWorld,
  netCreditByRole,
  ulidToUuid,
  type Sale,
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

/** Gross 100.000, PBJT 10% + PPN 2% + other 1% on the same base: tax 13.000. */
const mixedSale: Sale = {
  grossSalesIdr: 100_000,
  snapshots: {
    pbjt: { baseIdr: 100_000, taxIdr: 10_000, rateBp: 1000 },
    ppn: { baseIdr: 100_000, taxIdr: 2_000, rateBp: 200 },
    other: { baseIdr: 100_000, taxIdr: 1_000, rateBp: 100 },
  },
};

describe("xa9bc sale journal splits tax per type", () => {
  it("xa9bc a PBJT + PPN + other order credits each tax to its own payable account, Dr = Cr", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, mixedSale);

    const entryId = await post(world, orderPaid(world, orderUlid, mixedSale));

    expect(await linesOf(world, entryId)).toEqual([
      { role: "cash_on_hand", debit: 113_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_other", debit: 0, credit: 1_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
      { role: "tax_payable_ppn", debit: 0, credit: 2_000 },
    ]);
    await expectBalanced(world, entryId);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(-10_000);
    expect(await balanceOf(world, "tax_payable_ppn")).toBe(-2_000);
    expect(await balanceOf(world, "tax_payable_other")).toBe(-1_000);
  });

  it("xa9bc a discounted mixed order splits the tax on the discounted base and still balances", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    // Gross 100.000 less discount 20.000: tax base 80.000 -> 8.000 + 1.600 + 800.
    const sale: Sale = {
      grossSalesIdr: 100_000,
      discountIdr: 20_000,
      snapshots: {
        pbjt: { baseIdr: 80_000, taxIdr: 8_000, rateBp: 1000 },
        ppn: { baseIdr: 80_000, taxIdr: 1_600, rateBp: 200 },
        other: { baseIdr: 80_000, taxIdr: 800, rateBp: 100 },
      },
    };
    await seedPosOrder(world, orderUlid, sale);

    const entryId = await post(world, orderPaid(world, orderUlid, sale));

    expect(await linesOf(world, entryId)).toEqual([
      { role: "cash_on_hand", debit: 90_400, credit: 0 },
      { role: "sales_discount", debit: 20_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_other", debit: 0, credit: 800 },
      { role: "tax_payable_pbjt", debit: 0, credit: 8_000 },
      { role: "tax_payable_ppn", debit: 0, credit: 1_600 },
    ]);
    await expectBalanced(world, entryId);
  });

  it("xa9bc an order with only PBJT and PPN leaves no line on the other-tax account", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const sale: Sale = {
      grossSalesIdr: 50_000,
      snapshots: {
        pbjt: { baseIdr: 50_000, taxIdr: 5_000, rateBp: 1000 },
        ppn: { baseIdr: 50_000, taxIdr: 1_000, rateBp: 200 },
      },
    };
    await seedPosOrder(world, orderUlid, sale);

    const entryId = await post(world, orderPaid(world, orderUlid, sale));

    expect(await linesOf(world, entryId)).toEqual([
      { role: "cash_on_hand", debit: 56_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 50_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 5_000 },
      { role: "tax_payable_ppn", debit: 0, credit: 1_000 },
    ]);
    await expectBalanced(world, entryId);
  });

  it("xa9bc a PBJT-only order books everything to tax_payable_pbjt as before", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const sale: Sale = {
      grossSalesIdr: 100_000,
      snapshots: { pbjt: { baseIdr: 100_000, taxIdr: 10_000, rateBp: 1000 } },
    };
    await seedPosOrder(world, orderUlid, sale);

    const entryId = await post(world, orderPaid(world, orderUlid, sale));

    expect(await linesOf(world, entryId)).toEqual([
      { role: "cash_on_hand", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    await expectBalanced(world, entryId);
  });

  it("xa9bc an order with no tax snapshots (pre-cutover) stays all-PBJT", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    // The order row carries tax 10.000 but no snapshot rows exist.
    const sale: Sale = {
      grossSalesIdr: 100_000,
      snapshots: { pbjt: { baseIdr: 100_000, taxIdr: 10_000, rateBp: 1000 } },
    };
    await seedPosOrder(world, orderUlid, sale);
    await owner.query(
      "DELETE FROM tax_snapshots WHERE tenant_id = $1 AND source_id = $2",
      [world.tenant.id, ulidToUuid(orderUlid)],
    );

    const entryId = await post(world, orderPaid(world, orderUlid, sale));

    expect(await linesOf(world, entryId)).toEqual([
      { role: "cash_on_hand", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    await expectBalanced(world, entryId);
  });
});

describe("xa9bc refund journal mirrors the per-type split", () => {
  it("xa9bc a full refund of a mixed order debits each payable account by what was collected, Dr = Cr", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, mixedSale);
    await post(world, orderPaid(world, orderUlid, mixedSale));

    const refundEntry = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 100_000,
        taxIdr: 13_000,
      }),
    );

    expect(await linesOf(world, refundEntry)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 113_000 },
      { role: "sales_revenue", debit: 100_000, credit: 0 },
      { role: "tax_payable_other", debit: 1_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 10_000, credit: 0 },
      { role: "tax_payable_ppn", debit: 2_000, credit: 0 },
    ]);
    await expectBalanced(world, refundEntry);
    // Sale plus full refund nets every payable account to zero.
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
    expect(await balanceOf(world, "tax_payable_ppn")).toBe(0);
    expect(await balanceOf(world, "tax_payable_other")).toBe(0);
  });

  it("xa9bc a half refund is prorated per type and balances", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, mixedSale);
    await post(world, orderPaid(world, orderUlid, mixedSale));

    // Half of the order: revenue 50.000, tax 6.500 = 5.000 + 1.000 + 500.
    const refundEntry = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 6_500,
      }),
    );

    expect(await linesOf(world, refundEntry)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 56_500 },
      { role: "sales_revenue", debit: 50_000, credit: 0 },
      { role: "tax_payable_other", debit: 500, credit: 0 },
      { role: "tax_payable_pbjt", debit: 5_000, credit: 0 },
      { role: "tax_payable_ppn", debit: 1_000, credit: 0 },
    ]);
    await expectBalanced(world, refundEntry);
  });

  it("xa9bc an uneven refund splits by largest remainder: the parts add up to the refund tax", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, mixedSale);
    await post(world, orderPaid(world, orderUlid, mixedSale));

    // Refund tax 4.333 of 13.000 (10.000 / 2.000 / 1.000): exact shares are
    // 3.333,08 / 666,62 / 333,31 -> floors 3.333 / 666 / 333 leave 1; the largest
    // fraction (PPN, .62) gets it: 3.333 / 667 / 333.
    const refundEntry = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 33_333,
        taxIdr: 4_333,
      }),
    );

    const debits = await netCreditByRole(world, refundEntry);
    expect(debits.tax_payable_pbjt).toBe(-3_333);
    expect(debits.tax_payable_ppn).toBe(-667);
    expect(debits.tax_payable_other).toBe(-333);
    expect(
      -(
        debits.tax_payable_pbjt! +
        debits.tax_payable_ppn! +
        debits.tax_payable_other!
      ),
    ).toBe(4_333);
    await expectBalanced(world, refundEntry);
  });
});
