import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  balanceOf,
  createUlid,
  deliver,
  expectBalanced,
  journalCount,
  netCreditByRole,
  orderPaid,
  orderRefunded,
  owner,
  post,
  seedPosOrder,
  makeWorld,
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

const sale: Sale = {
  grossSalesIdr: 100_000,
  snapshots: {
    pbjt: { baseIdr: 100_000, taxIdr: 10_000, rateBp: 1000 },
  },
};

describe("547b refund component rounding", () => {
  it("posts 36670 + 36670 + 36660 completely, returning exactly the collected tax and revenue", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedPosOrder(world, orderId, sale);
    await post(world, orderPaid(world, orderId, sale));

    const refundEntries: string[] = [];
    for (const amountIdr of [36_670, 36_670, 36_660]) {
      // The producer independently rounds each refund's tax. Its final 3333
      // would overrun the collected tax by Rp1, although all cash is valid.
      const taxIdr = Math.round((amountIdr * 10_000) / 110_000);
      refundEntries.push(
        await post(
          world,
          orderRefunded(world, orderId, createUlid(), {
            grossSalesIdr: amountIdr - taxIdr,
            taxIdr,
          }),
        ),
      );
    }

    let refundedTax = 0;
    let refundedRevenue = 0;
    let refundedCash = 0;
    for (const entry of refundEntries) {
      await expectBalanced(world, entry);
      const credits = await netCreditByRole(world, entry);
      refundedTax -= credits.tax_payable_pbjt ?? 0;
      refundedRevenue -= credits.sales_revenue ?? 0;
      refundedCash += credits.cash_on_hand ?? 0;
    }
    expect(refundedTax).toBe(10_000);
    expect(refundedRevenue).toBe(100_000);
    expect(refundedCash).toBe(110_000);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
    expect(await balanceOf(world, "sales_revenue")).toBe(0);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    expect(await journalCount(world)).toBe(4);

    const extra = await deliver(
      world,
      orderRefunded(world, orderId, createUlid(), {
        grossSalesIdr: 9,
        taxIdr: 1,
      }),
    );
    expect(extra.status).toBe("parked");
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);

    // A zero-tax payload must not bypass the total cash/revenue cap either.
    const extraWithoutTax = await deliver(
      world,
      orderRefunded(world, orderId, createUlid(), {
        grossSalesIdr: 1,
        taxIdr: 0,
      }),
    );
    expect(extraWithoutTax.status).toBe("parked");
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
  });
});
