// Architect review of 538-G3 slice A (xa9bc, knfl6): money-path gaps found
// after the first implementation. Fail-first for each:
// - a refund posted before journal_entries.order_id existed (no order id) still
//   reduces the room of its order's refund cap;
// - a reversed refund gives its tax back (the room is restored);
// - the per-type proration never debits a payable account below what the sale
//   credited, moving the rounding excess to a type with room;
// - two tax roles mapped to one account: a refund is not posted (its balance
//   cannot be told apart per type) and the PBJT report does not count that
//   account twice;
// - the 0355 backfill gives an already provisioned entity the two new accounts
//   and mappings, never under a parent that already holds postings.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  postJournalInTransaction,
  reverseJournalInTransaction,
} from "../services/accounting-journal.service.ts";
import { defaultTaxLineSource } from "../services/accounting-tax-line-source.ts";
import {
  asTenant,
  balanceOf,
  BUSINESS_DATE,
  contextOf,
  createUlid,
  deliver,
  journalCount,
  makeTenant,
  makeWorld,
  netCreditByRole,
  orderPaid,
  orderRefunded,
  owner,
  post,
  seedPosOrder,
  ulidToUuid,
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

const posted = (status: string) =>
  ["posted", "already_posted"].includes(status);

async function sellMixed(world: World): Promise<string> {
  const orderUlid = createUlid();
  await seedPosOrder(world, orderUlid, mixedSale);
  await post(world, orderPaid(world, orderUlid, mixedSale));
  return orderUlid;
}

/**
 * A refund journal exactly as the consumer posted it before 0356: source
 * 'refund', source id = the refund row id, NO order id. The refund row of the
 * POS (pos_order_refunds) is what names its order.
 */
async function postLegacyRefund(
  world: World,
  orderUlid: string,
  tax: { pbjt: number; ppn: number; other: number },
): Promise<string> {
  const refundId = randomUUID();
  const revenue = 60_000;
  const taxTotal = tax.pbjt + tax.ppn + tax.other;
  const amount = revenue + taxTotal;
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO pos_order_refunds
         (id, tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
          requested_by, approved_by, approval_request_id, refunded_at)
       VALUES ($1, $2, $3, $4, $5, 'customer_request', 'Pesanan salah',
               $6::jsonb, 'kasir', 'supervisor', $7, now())`,
      [
        refundId,
        world.tenant.id,
        world.outletId,
        ulidToUuid(orderUlid),
        amount,
        JSON.stringify([{ method: "cash", amountIdr: amount }]),
        randomUUID(),
      ],
    ),
  );
  const line = (
    role: keyof World["accounts"],
    debit: number,
    credit: number,
  ) => ({
    accountId: world.accounts[role],
    debitIdr: debit,
    creditIdr: credit,
    outletId: world.outletId,
    costCenter: null,
  });
  const context = contextOf(world.tenant);
  const entry = await withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId: world.entity,
      outletId: world.outletId,
      entryDate: BUSINESS_DATE,
      sourceType: "refund",
      sourceId: refundId,
      description: "Refund sebelum order_id",
      lines: [
        line("sales_revenue", revenue, 0),
        line("tax_payable_pbjt", tax.pbjt, 0),
        line("tax_payable_ppn", tax.ppn, 0),
        line("tax_payable_other", tax.other, 0),
        line("cash_on_hand", 0, amount),
      ].filter((l) => l.debitIdr + l.creditIdr > 0),
      postedBy: null,
      idempotencyKey: `aj:order-refund:${refundId}`,
    } as never),
  );
  return entry.id;
}

describe("review: refunds posted before journal_entries.order_id", () => {
  it("a legacy refund (no order id) still counts: a refund that would exceed the collected tax is not posted", async () => {
    const world = await makeWorld();
    const orderUlid = await sellMixed(world);
    await postLegacyRefund(world, orderUlid, {
      pbjt: 6_154,
      ppn: 1_231,
      other: 615,
    });

    // 8.000 already refunded; 8.000 more would be 16.000 of 13.000 collected.
    const second = await deliver(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 40_000,
        taxIdr: 8_000,
      }),
    );

    expect(posted(second.status)).toBe(false);
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBeLessThanOrEqual(0);
    expect(await balanceOf(world, "tax_payable_ppn")).toBeLessThanOrEqual(0);
    expect(await balanceOf(world, "tax_payable_other")).toBeLessThanOrEqual(0);
  });

  it("a legacy refund leaves exactly the rest of the collected tax to refund", async () => {
    const world = await makeWorld();
    const orderUlid = await sellMixed(world);
    await postLegacyRefund(world, orderUlid, {
      pbjt: 6_154,
      ppn: 1_231,
      other: 615,
    });

    const rest = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 40_000,
        taxIdr: 5_000,
      }),
    );

    const credits = await netCreditByRole(world, rest);
    expect(
      -(
        credits.tax_payable_pbjt! +
        credits.tax_payable_ppn! +
        credits.tax_payable_other!
      ),
    ).toBe(5_000);
    // No payable account is debit-heavy: legacy 8.000 + this 5.000 = 13.000.
    expect(await balanceOf(world, "tax_payable_pbjt")).toBeLessThanOrEqual(0);
    expect(await balanceOf(world, "tax_payable_ppn")).toBeLessThanOrEqual(0);
    expect(await balanceOf(world, "tax_payable_other")).toBeLessThanOrEqual(0);
  });
});

describe("review: a reversed refund gives its tax back", () => {
  it("after the refund journal is reversed the full tax can be refunded again", async () => {
    const world = await makeWorld();
    const orderUlid = await sellMixed(world);
    const first = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 60_000,
        taxIdr: 8_000,
      }),
    );
    const context = contextOf(world.tenant);
    await withTenant(db, context, (tx) =>
      reverseJournalInTransaction(tx, context, first, {
        entryDate: BUSINESS_DATE,
        reason: "Refund ditolak",
        idempotencyKey: `review-reversal-${first}`,
        lateAdjustmentFrom: null,
        postedBy: null,
      } as never),
    );

    // Without the reversal 8.000 + 13.000 > 13.000 would be refused.
    const full = await deliver(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 100_000,
        taxIdr: 13_000,
      }),
    );

    expect(posted(full.status)).toBe(true);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
    expect(await balanceOf(world, "tax_payable_ppn")).toBe(0);
    expect(await balanceOf(world, "tax_payable_other")).toBe(0);
  });
});

describe("review: per-type clamp", () => {
  it("three uneven refunds never debit a payable account above what was credited; the rounding excess moves to a type with room", async () => {
    const world = await makeWorld();
    const orderUlid = await sellMixed(world);
    const refund = () =>
      post(
        world,
        orderRefunded(world, orderUlid, createUlid(), {
          grossSalesIdr: 33_333,
          taxIdr: 4_333,
        }),
      );

    await refund();
    await refund();
    const third = await refund();

    // Proportional shares of the third would be 3.333 / 667 / 333, but the PPN
    // account only has 666 left (667 + 667 already debited): the extra unit goes
    // to PBJT, which has room.
    const credits = await netCreditByRole(world, third);
    expect(credits.tax_payable_ppn).toBe(-666);
    expect(credits.tax_payable_pbjt).toBe(-3_334);
    expect(credits.tax_payable_other).toBe(-333);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
    expect(await balanceOf(world, "tax_payable_ppn")).toBe(0);
    expect(await balanceOf(world, "tax_payable_other")).toBe(-1);
  });
});

describe("review: two tax roles on one account", () => {
  it("a refund is not posted when PPN and PBJT payables are the same account", async () => {
    const world = await makeWorld();
    const orderUlid = await sellMixed(world);
    await owner.query(
      `UPDATE account_mappings SET account_id = $3
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'tax_payable_ppn'`,
      [world.tenant.id, world.entity, world.accounts.tax_payable_pbjt],
    );

    const result = await deliver(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 6_500,
      }),
    );

    expect(posted(result.status)).toBe(false);
    expect(await journalCount(world)).toBe(1);
  });

  it("the PBJT report does not count a PPN account mapped onto the PBJT account twice", async () => {
    const world = await makeWorld();
    await owner.query(
      `UPDATE account_mappings SET account_id = $3
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'tax_payable_ppn'`,
      [world.tenant.id, world.entity, world.accounts.tax_payable_pbjt],
    );
    await sellMixed(world);

    const lines = await withTenant(db, contextOf(world.tenant), (tx) =>
      defaultTaxLineSource(tx, {
        tenantId: tenantIdSchema.parse(world.tenant.id),
        legalEntityId: world.entity,
        type: "pbjt",
        period: "2026-10",
      }),
    );

    // The PBJT account holds PBJT + PPN (12.000); the report keeps the PBJT 10.000.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ baseIdr: 100_000, taxIdr: 10_000 });
  });
});

describe("review: 0355 backfill", () => {
  const statements = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../drizzle/0355_tax_payable_ppn_other_roles.sql",
    ),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    // Only the data statements: the ALTER TABLE FORCE toggles take table locks
    // other test files would wait on.
    .filter((part) => /^INSERT\s+INTO/im.test(part.replace(/^--.*$/gm, "")));

  /** An entity provisioned before 0355: chart with 2200 > 2201, old mappings only. */
  async function oldEntity(options: { parentHasPostings: boolean }) {
    const tenant = await makeTenant();
    const entity = randomUUID();
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity lama', false)",
      [entity, tenant.id],
    );
    const account = async (
      code: string,
      name: string,
      parent: string | null,
    ): Promise<string> => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
         VALUES ($1, $2, $3, $4, 'liability', 'current_liability', $5) RETURNING id`,
        [tenant.id, entity, code, name, parent],
      );
      return rows[0]!.id;
    };
    const header = await account("2200", "Utang Pajak", null);
    const pbjt = await account("2201", "Utang PBJT", header);
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'tax_payable_pbjt', $3)`,
      [tenant.id, entity, pbjt],
    );
    if (options.parentHasPostings)
      // The parent carries a mapping: no new account may go under it.
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, 'tax_payable_other', $3)`,
        [tenant.id, entity, header],
      );
    return { tenant, entity, header };
  }

  async function runBackfill(): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const readback = async (tenantId: string, entity: string) => {
    const accounts = await owner.query<{
      code: string;
      parent_id: string | null;
    }>(
      `SELECT code, parent_id FROM chart_of_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND code IN ('2205', '2206')
        ORDER BY code`,
      [tenantId, entity],
    );
    const mappings = await owner.query<{ role: string; code: string }>(
      `SELECT m.role, a.code FROM account_mappings m
         JOIN chart_of_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
        WHERE m.tenant_id = $1 AND m.legal_entity_id = $2
          AND m.role IN ('tax_payable_ppn', 'tax_payable_other')
        ORDER BY m.role`,
      [tenantId, entity],
    );
    return { accounts: accounts.rows, mappings: mappings.rows };
  };

  it("adds 2205 / 2206 under the parent of 2201 and maps both new roles; a re-run changes nothing", async () => {
    const { tenant, entity, header } = await oldEntity({
      parentHasPostings: false,
    });

    await runBackfill();
    const first = await readback(tenant.id, entity);
    await runBackfill();
    const second = await readback(tenant.id, entity);

    expect(first.accounts).toEqual([
      { code: "2205", parent_id: header },
      { code: "2206", parent_id: header },
    ]);
    expect(first.mappings).toEqual([
      { role: "tax_payable_other", code: "2206" },
      { role: "tax_payable_ppn", code: "2205" },
    ]);
    expect(second).toEqual(first);
  });

  it("creates the accounts top-level when the parent of 2201 already carries a mapping", async () => {
    const { tenant, entity } = await oldEntity({ parentHasPostings: true });

    await runBackfill();
    const result = await readback(tenant.id, entity);

    expect(result.accounts).toEqual([
      { code: "2205", parent_id: null },
      { code: "2206", parent_id: null },
    ]);
    // tax_payable_other was already mapped (to the header): kept as is.
    expect(result.mappings).toEqual([
      { role: "tax_payable_other", code: "2200" },
      { role: "tax_payable_ppn", code: "2205" },
    ]);
  });
});
