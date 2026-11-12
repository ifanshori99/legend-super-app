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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  autoJournalFactOf,
  storedEventOf,
} from "../services/accounting-auto-journal-amounts.ts";
import {
  postJournalFromRuleInTransaction,
  reverseJournalInTransaction,
} from "../services/accounting-journal.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  asTenant,
  balanceOf,
  BUSINESS_DATE,
  contextOf,
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

type Tender = "cash" | "gateway" | "points";
const BUCKET = {
  cash: "refundCashIdr",
  gateway: "refundGatewayIdr",
  points: "refundPointsIdr",
} as const;

function refundEvent(
  world: World,
  orderUlid: string,
  refund: Refund,
  tender: Tender = "cash",
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
      refundCashIdr: 0,
      refundGatewayIdr: 0,
      refundPointsIdr: 0,
      [BUCKET[tender]]: amount,
      lines: [{ method: tender, amountIdr: amount }],
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

describe("a payout role remapped onto the service charge account after the sale", () => {
  // Nothing stops two roles sharing one account. A refund debits the service
  // charge account of the SALE but credits its payout role to TODAY's mapping;
  // if both are one account the payout credit must never lower "already
  // refunded" and open room for a second refund (fail closed: park).
  const cases: { role: Role; tender: Tender }[] = [
    { role: "loyalty_liability", tender: "points" },
    { role: "customer_deposit", tender: "gateway" },
  ];
  for (const { role, tender } of cases)
    it(`${role} remapped onto 2301: no refund passes what the sale collected`, async () => {
      const world = await makeWorld();
      const serviceChargeAccount = await mapToLiability(
        world,
        "service_charge",
        "2301",
      );
      const { orderUlid, paid } = await seedSaleWithServiceCharge(world);
      await post(world, paid);
      const saleTotal = totalOf(sale) + SERVICE_CHARGE;

      // The tenant remaps the payout role onto the service charge account.
      await owner.query(
        `UPDATE account_mappings SET account_id = $4
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3`,
        [world.tenant.id, world.entity, role, serviceChargeAccount],
      );

      // Refund A: half the sale, paid out through the remapped role.
      const a = await deliver(
        world,
        refundEvent(
          world,
          orderUlid,
          { grossSalesIdr: 50_000, serviceChargeIdr: 5_000, taxIdr: 5_000 },
          tender,
        ),
      );
      // Refund B: the whole sale again, in cash.
      const b = await deliver(
        world,
        refundEvent(world, orderUlid, {
          grossSalesIdr: 100_000,
          serviceChargeIdr: SERVICE_CHARGE,
          taxIdr: TAX,
        }),
      );

      expect(outcomeOf(b)).toBe("parked:AUTO_JOURNAL_PAYLOAD_INVALID");
      const refunded =
        (posted(a.status) ? 60_000 : 0) + (posted(b.status) ? saleTotal : 0);
      expect(refunded).toBeLessThanOrEqual(saleTotal);
      const sc = await totalsOf(world, "service_charge");
      expect(sc.debit).toBeLessThanOrEqual(SERVICE_CHARGE);
    });
});

describe("payout mapping changes after refund amounts are calculated (legend-48ft7)", () => {
  it("rejects when another transaction commits a payout remap between fact calculation and journal posting", async () => {
    const world = await makeWorld();
    await mapToLiability(world, "service_charge", "2301");
    const { orderUlid, paid } = await seedSaleWithServiceCharge(world);
    await post(world, paid);
    const event = refundEvent(world, orderUlid, {
      grossSalesIdr: 50_000,
      serviceChargeIdr: 5_000,
      taxIdr: 5_000,
    });
    const stored = storedEventOf({
      id: event.id,
      name: "order.refunded",
      outletId: event.outletId,
      occurredAt: event.occurredAt,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    });
    const context = contextOf(world.tenant);
    const before = await totalsOf(world, "tax_payable_pbjt");

    await expect(
      withTenant(db, context, async (tx) => {
        // Transaction A reads the original payout mapping as part of the
        // real fact calculation, then remains open while B commits a change.
        const fact = await autoJournalFactOf(
          tx,
          context.tenant.tenantId,
          stored,
        );
        expect(fact).not.toBeNull();
        await asTenant(world.tenant, async (client) => {
          await client.query("SET LOCAL lock_timeout = '2s'");
          await client.query(
            `UPDATE account_mappings SET account_id = $3
              WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'cash_on_hand'`,
            [world.tenant.id, world.entity, world.accounts.tax_payable_pbjt],
          );
        });
        return postJournalFromRuleInTransaction(tx, context, {
          eventName: fact!.ruleEvent,
          variant: fact!.variant,
          amounts: fact!.amounts,
          accountOverrides: fact!.accountOverrides,
          legalEntityId: world.entity,
          outletId: world.outletId,
          entryDate: BUSINESS_DATE,
          sourceId: fact!.sourceId,
          orderId: fact!.orderId,
          postedBy: null,
          idempotencyKey: `race-refund:${createUlid()}`,
        });
      }),
    ).rejects.toMatchObject({ code: "POSTING_AMOUNTS_MISMATCH" });

    expect(await journalCount(world)).toBe(1);
    expect(await totalsOf(world, "tax_payable_pbjt")).toEqual(before);
  });

  for (const protectedRole of ["service_charge", "tax_payable_pbjt"] as const) {
    it(`refuses the actual payout mapping when cash points to the historical ${protectedRole} account`, async () => {
      const world = await makeWorld();
      await mapToLiability(world, "service_charge", "2301");
      const { paid } = await seedSaleWithServiceCharge(world);
      await post(world, paid);

      // Amount calculation has already captured the sale's protected accounts.
      // Another transaction remaps the payout before journal rule resolution.
      const accountOverrides = {
        sales_revenue: world.accounts.sales_revenue,
        service_charge: world.accounts.service_charge,
        tax_payable_pbjt: world.accounts.tax_payable_pbjt,
      };
      await owner.query(
        `UPDATE account_mappings SET account_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'cash_on_hand'`,
        [world.tenant.id, world.entity, world.accounts[protectedRole]],
      );
      const before = await totalsOf(world, protectedRole);
      const context = contextOf(world.tenant);
      await expect(
        withTenant(db, context, (tx) =>
          postJournalFromRuleInTransaction(tx, context, {
            eventName: "order.refunded",
            amounts: {
              grossSalesIdr: 50_000,
              serviceChargeIdr: 5_000,
              pbjtIdr: 5_000,
              discountIdr: 0,
              refundCashIdr: 60_000,
              refundGatewayIdr: 0,
              refundEdcIdr: 0,
              refundPointsIdr: 0,
            },
            legalEntityId: world.entity,
            outletId: world.outletId,
            entryDate: BUSINESS_DATE,
            sourceId: createUlid(),
            postedBy: null,
            idempotencyKey: `race-refund:${createUlid()}`,
            accountOverrides,
          }),
        ),
      ).rejects.toThrow();
      expect(await journalCount(world)).toBe(1);
      expect(await totalsOf(world, protectedRole)).toEqual(before);
    });
  }
});

describe("legacy refund history that credited the service charge account", () => {
  // A refund journal posted by an older mapping may have CREDITED the service
  // charge (or a tax) account. Counting "already refunded" as debit minus credit
  // would then shrink and reopen room for a second refund, so a new refund of
  // that order must park and post nothing (fail closed), even though today's
  // mapping is clean (no payout role sits on the service charge account).
  // Assumptions: a refund entry is a `refund` journal keyed
  // `aj:order-refund:<refundId>` whose order_id is the sale's order, as the real
  // refund posting produces; the legacy entry is cloned from the sale entry's
  // header and given lines that balance.
  type LegacyLine = { role: Role; debit: number; credit: number };

  async function insertLegacyRefund(
    world: World,
    orderUlid: string,
    lines: LegacyLine[],
  ): Promise<string> {
    const refundId = createUlid();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id,
            source_type, source_id, description, posted_at, idempotency_key,
            request_fingerprint, order_id, posting_account_snapshot)
         SELECT tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id,
                'refund', $3::varchar, 'Refund lama', posted_at, $4::varchar,
                md5($4::text) || md5($3::text), order_id, posting_account_snapshot
           FROM journal_entries
          WHERE tenant_id = $1 AND idempotency_key = $2
         RETURNING id`,
        [
          world.tenant.id,
          `aj:sale:${orderUlid}`,
          refundId,
          `aj:order-refund:${refundId}`,
        ],
      );
      const entryId = rows[0]!.id;
      for (const [index, line] of lines.entries())
        await client.query(
          `INSERT INTO journal_lines
             (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
           SELECT $1, $2, $3, $4, $5, $6, outlet_id
             FROM journal_entries WHERE id = $2`,
          [
            world.tenant.id,
            entryId,
            world.accounts[line.role],
            index + 1,
            line.debit,
            line.credit,
          ],
        );
      await client.query("COMMIT");
      return entryId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const newRefund: Refund = {
    grossSalesIdr: 10_000,
    serviceChargeIdr: 1_000,
    taxIdr: 1_000,
  };

  it("an earlier refund that credited the service charge account parks a new refund and posts nothing; the same history without that credit posts", async () => {
    // Control: the earlier refund debits the service charge like a normal one.
    const control = await makeWorld();
    await mapToLiability(control, "service_charge", "2301");
    const controlSale = await seedSaleWithServiceCharge(control);
    await post(control, controlSale.paid);
    await insertLegacyRefund(control, controlSale.orderUlid, [
      { role: "sales_revenue", debit: 36_000, credit: 0 },
      { role: "service_charge", debit: 4_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 4_000, credit: 0 },
      { role: "cash_on_hand", debit: 0, credit: 44_000 },
    ]);
    expect(await journalCount(control)).toBe(2);
    const posted1 = await deliver(
      control,
      refundEvent(control, controlSale.orderUlid, newRefund),
    );
    expect(outcomeOf(posted1)).toBe("posted");
    expect(await journalCount(control)).toBe(3);

    // Legacy history: the earlier refund CREDITED the service charge account.
    const world = await makeWorld();
    await mapToLiability(world, "service_charge", "2301");
    const { orderUlid, paid } = await seedSaleWithServiceCharge(world);
    await post(world, paid);
    await insertLegacyRefund(world, orderUlid, [
      { role: "sales_revenue", debit: 40_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 4_000, credit: 0 },
      { role: "service_charge", debit: 0, credit: 4_000 },
      { role: "cash_on_hand", debit: 0, credit: 40_000 },
    ]);
    expect(await journalCount(world)).toBe(2);
    const before = await totalsOf(world, "service_charge");

    const result = await deliver(
      world,
      refundEvent(world, orderUlid, newRefund),
    );

    expect(outcomeOf(result)).toBe("parked:AUTO_JOURNAL_PAYLOAD_INVALID");
    expect(await journalCount(world)).toBe(2);
    expect(await totalsOf(world, "service_charge")).toEqual(before);
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

  it("a reversed legacy refund journal alone does not prove its payout was recovered, so a new refund remains parked", async () => {
    const world = await makeWorld();
    await mapToLiability(world, "service_charge", "2301");
    const { orderUlid, paid } = await seedSaleWithServiceCharge(world);
    await post(world, paid);
    const legacyId = await insertLegacyRefund(world, orderUlid, [
      { role: "sales_revenue", debit: 40_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 4_000, credit: 0 },
      { role: "service_charge", debit: 0, credit: 4_000 },
      { role: "cash_on_hand", debit: 0, credit: 40_000 },
    ]);
    const context = contextOf(world.tenant);
    await withTenant(db, context, (tx) =>
      reverseJournalInTransaction(tx, context, legacyId, {
        entryDate: BUSINESS_DATE,
        reason: "Refund lama dibatalkan",
        idempotencyKey: `reverse-legacy:${legacyId}`,
        lateAdjustmentFrom: null,
        postedBy: null,
      } as never),
    );

    const full = refundEvent(world, orderUlid, {
      grossSalesIdr: 100_000,
      serviceChargeIdr: SERVICE_CHARGE,
      taxIdr: TAX,
    });
    // Reversing a journal does not establish that the earlier 40k payout was
    // cancelled or returned. Paying the whole 120k again could overpay 40k.
    const before = await journalCount(world);
    expect(outcomeOf(await deliver(world, full))).toBe(
      "parked:AUTO_JOURNAL_PAYLOAD_INVALID",
    );
    expect(await journalCount(world)).toBe(before);
    expect(await totalsOf(world, "service_charge")).toEqual({
      debit: 4_000,
      credit: SERVICE_CHARGE + 4_000,
    });
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
