// Fail-first regression tests for BRK-TAX-05 (CTO decision): the service_charge
// role may be mapped to a LIABILITY account (e.g. 2301). A sale may then credit
// it and a refund may debit it, but
// - the service charge reversed across all refunds of one sale never exceeds
//   what the sale collected (PB1/PBJT cap unchanged);
// - any OTHER liability credit (neither a tax role nor service_charge) still
//   makes the refund fail with AUTO_JOURNAL_PAYLOAD_INVALID.
//
// Assumptions (the contract is the brief, not the implementation):
// - order.paid / order.refunded carry `serviceChargeIdr`; the order total is
//   gross - discount + service charge + tax, and a refund's amount is
//   gross + service charge + tax.
// - An over-refund is refused: the delivery is not "posted" and nothing is
//   added to the ledger (it is parked rather than clamped).
// - A "stray" liability credit is simulated by mapping sales_revenue onto a
//   liability account 2399, so the sale posts but credits an account that is
//   neither a tax role nor service_charge.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EventEnvelope } from "@starter/shared/events";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  asTenant,
  balanceOf,
  createUlid,
  deliver,
  journalCount,
  linesOf,
  orderPaid,
  orderRefunded,
  owner,
  post,
  seedPosOrder,
  totalOf,
  makeWorld,
  type Role,
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

/** Gross 100.000, PBJT 10% = 10.000, service charge 10.000: total 120.000. */
const SERVICE_CHARGE = 10_000;
const TAX = 10_000;
const sale: Sale = {
  grossSalesIdr: 100_000,
  snapshots: { pbjt: { baseIdr: 100_000, taxIdr: TAX, rateBp: 1000 } },
};

type Refund = {
  grossSalesIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
};

const posted = (status: string) =>
  ["posted", "already_posted"].includes(status);

/** "posted", or the parked error code, so a failure names its reason. */
const outcomeOf = (result: { status: string; code?: string }): string =>
  result.status === "parked" ? `parked:${result.code}` : result.status;

/** Maps a role onto a freshly created liability account and returns its id. */
async function mapToLiability(
  world: World,
  role: Role,
  code: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, $3, $4, 'liability', 'current_liability') RETURNING id`,
    [world.tenant.id, world.entity, code, `Liabilitas ${code}`],
  );
  const id = rows[0]!.id;
  await owner.query(
    `UPDATE account_mappings SET account_id = $4
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3`,
    [world.tenant.id, world.entity, role, id],
  );
  world.accounts[role] = id;
  return id;
}

/** Seeds the order and builds an order.paid that carries the service charge
 *  (the completed order row is immutable, so the charge lives in the event). */
async function seedSaleWithServiceCharge(
  world: World,
): Promise<{ orderUlid: string; paid: EventEnvelope }> {
  const orderUlid = createUlid();
  await seedPosOrder(world, orderUlid, sale);
  const total = totalOf(sale) + SERVICE_CHARGE;
  const event = orderPaid(world, orderUlid, sale);
  const paid = {
    ...event,
    payload: {
      ...(event.payload as Record<string, unknown>),
      serviceChargeIdr: SERVICE_CHARGE,
      totalIdr: total,
      paidCashIdr: total,
      tenders: [{ method: "cash", amountIdr: total }],
    },
  } as EventEnvelope;
  return { orderUlid, paid };
}

function refundEvent(
  world: World,
  orderUlid: string,
  refund: Refund,
): EventEnvelope {
  const event = orderRefunded(world, orderUlid, createUlid(), {
    grossSalesIdr: refund.grossSalesIdr,
    taxIdr: refund.taxIdr,
  });
  const amount = refund.grossSalesIdr + refund.serviceChargeIdr + refund.taxIdr;
  return {
    ...event,
    payload: {
      ...(event.payload as Record<string, unknown>),
      amountIdr: amount,
      serviceChargeIdr: refund.serviceChargeIdr,
      refundCashIdr: amount,
      lines: [{ method: "cash", amountIdr: amount }],
    },
  } as EventEnvelope;
}

/** Total debit and credit booked on one role's account over the whole ledger. */
async function totalsOf(
  world: World,
  role: Role,
): Promise<{ debit: number; credit: number }> {
  const { rows } = await owner.query<{ debit: string; credit: string }>(
    `SELECT coalesce(sum(debit_idr), 0)::text AS debit, coalesce(sum(credit_idr), 0)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return { debit: Number(rows[0]!.debit), credit: Number(rows[0]!.credit) };
}

describe("service_charge mapped to a liability account", () => {
  it("sale posts crediting 2301 and a partial refund posts (not parked)", async () => {
    const world = await makeWorld();
    await mapToLiability(world, "service_charge", "2301");
    const { orderUlid, paid } = await seedSaleWithServiceCharge(world);

    const saleJournal = await post(world, paid);
    const saleLines = await linesOf(world, saleJournal);
    expect(
      saleLines.find((line) => line.role === "service_charge")?.credit,
    ).toBe(SERVICE_CHARGE);

    const result = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 40_000,
        serviceChargeIdr: 4_000,
        taxIdr: 4_000,
      }),
    );

    expect(outcomeOf(result)).toBe("posted");
    expect(await journalCount(world)).toBe(2);
    expect(await totalsOf(world, "service_charge")).toEqual({
      debit: 4_000,
      credit: SERVICE_CHARGE,
    });
  });

  it("staged refunds never reverse more service charge or PBJT than the sale collected; over-refunds post nothing", async () => {
    const world = await makeWorld();
    await mapToLiability(world, "service_charge", "2301");
    const { orderUlid, paid } = await seedSaleWithServiceCharge(world);
    await post(world, paid);

    const step = (refund: Refund) =>
      deliver(world, refundEvent(world, orderUlid, refund));
    const expectNoExtraPosting = async (journals: number) => {
      expect(await journalCount(world)).toBe(journals);
      const sc = await totalsOf(world, "service_charge");
      const pbjt = await totalsOf(world, "tax_payable_pbjt");
      expect(sc.debit).toBeLessThanOrEqual(sc.credit);
      expect(pbjt.debit).toBeLessThanOrEqual(pbjt.credit);
    };

    // 1 and 2: two partial refunds (30%, 30%).
    const first = await step({
      grossSalesIdr: 30_000,
      serviceChargeIdr: 3_000,
      taxIdr: 3_000,
    });
    expect(outcomeOf(first)).toBe("posted");
    const second = await step({
      grossSalesIdr: 30_000,
      serviceChargeIdr: 3_000,
      taxIdr: 3_000,
    });
    expect(posted(second.status)).toBe(true);
    await expectNoExtraPosting(3);

    // 3: the service charge asked (5.000) exceeds its remaining room (4.000).
    // refundComponentsOf does not refuse a refund that fits the sale as a
    // whole; it reallocates the overflow over the remaining components, so
    // the money returned stays exact and no component passes what was collected.
    const overflowing = await step({
      grossSalesIdr: 30_000,
      serviceChargeIdr: 5_000,
      taxIdr: 3_000,
    });
    expect(outcomeOf(overflowing)).toBe("posted");
    await expectNoExtraPosting(4);
    const afterThird = await totalsOf(world, "service_charge");
    expect(afterThird.debit).toBeGreaterThan(6_000);
    expect(afterThird.debit).toBeLessThan(SERVICE_CHARGE);

    // 4: 10.001 left to refund is 1 above what the sale still holds (10.000):
    // refused, nothing posted.
    const tooMuch = await step({
      grossSalesIdr: 10_001,
      serviceChargeIdr: 0,
      taxIdr: 0,
    });
    expect(posted(tooMuch.status)).toBe(false);
    await expectNoExtraPosting(4);

    // 5: the final refund takes exactly what is left.
    const last = await step({
      grossSalesIdr: 10_000,
      serviceChargeIdr: 0,
      taxIdr: 0,
    });
    expect(posted(last.status)).toBe(true);
    await expectNoExtraPosting(5);
    expect(await balanceOf(world, "service_charge")).toBe(0);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);

    // 6: anything more on an exhausted sale is refused.
    const afterExhausted = await step({
      grossSalesIdr: 0,
      serviceChargeIdr: 1_000,
      taxIdr: 0,
    });
    expect(posted(afterExhausted.status)).toBe(false);
    await expectNoExtraPosting(5);
    expect(await balanceOf(world, "service_charge")).toBe(0);
  });
});

describe("a sale crediting another liability account", () => {
  it("a stray 2399 liability credit keeps the refund rejected: historical sale accounts cannot be established", async () => {
    const world = await makeWorld();
    // Revenue lands on a liability that is neither a tax role nor service_charge.
    await mapToLiability(world, "sales_revenue", "2399");
    const { orderUlid, paid } = await seedSaleWithServiceCharge(world);
    await post(world, paid);

    const result = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 40_000,
        serviceChargeIdr: 4_000,
        taxIdr: 4_000,
      }),
    );

    expect(result).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(1);
    // The "Historical sale tax accounts cannot be established" text is not
    // persisted in the parked row, so the code and row are the observable outcome.
    const parked = await asTenant(world.tenant, (client) =>
      client.query<{ error_code: string; retryable: boolean }>(
        "SELECT error_code, retryable FROM auto_journal_parked WHERE tenant_id = $1",
        [world.tenant.id],
      ),
    );
    expect(parked.rows).toEqual([
      { error_code: "AUTO_JOURNAL_PAYLOAD_INVALID", retryable: false },
    ]);
  });
});

describe("service_charge mapped to a revenue account (regression guard)", () => {
  it("sale and a partial refund still post, crediting and debiting the revenue account", async () => {
    const world = await makeWorld(); // default: service_charge -> 4103 revenue
    const { orderUlid, paid } = await seedSaleWithServiceCharge(world);
    await post(world, paid);

    const result = await deliver(
      world,
      refundEvent(world, orderUlid, {
        grossSalesIdr: 40_000,
        serviceChargeIdr: 4_000,
        taxIdr: 4_000,
      }),
    );

    expect(result).toMatchObject({ status: "posted" });
    expect(await totalsOf(world, "service_charge")).toEqual({
      debit: 4_000,
      credit: SERVICE_CHARGE,
    });
  });
});
