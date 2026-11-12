import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateSchema, userIdSchema } from "@starter/shared/core";
import { journalLineInputSchema } from "@starter/shared/accounting";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { replaceAccountMappingsForEntity } from "../services/accounting-accounts.service.ts";
import {
  postJournalInTransaction,
  reverseJournalInTransaction,
} from "../services/accounting-journal.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  balanceOf,
  BUSINESS_DATE,
  contextOf,
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

const sale: Sale = {
  grossSalesIdr: 100_000,
  snapshots: {
    pbjt: { baseIdr: 100_000, taxIdr: 10_000, rateBp: 1000 },
  },
};

async function replacementAccount(world: World): Promise<string> {
  const replacement = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '2299', 'PBJT pengganti', 'liability', 'current_liability')
     RETURNING id`,
    [world.tenant.id, world.entity],
  );
  return replacement.rows[0]!.id;
}

async function postLegacySale(world: World, orderId: string): Promise<void> {
  const context = contextOf(world.tenant);
  await withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId: world.entity,
      outletId: world.outletId,
      entryDate: businessDateSchema.parse(BUSINESS_DATE),
      sourceType: "sale",
      sourceId: orderId,
      orderId: ulidToUuid(orderId),
      description: "Penjualan sebelum snapshot mapping",
      lines: [
        {
          accountId: world.accounts.cash_on_hand,
          debitIdr: 110_000,
          creditIdr: 0,
        },
        {
          accountId: world.accounts.sales_revenue,
          debitIdr: 0,
          creditIdr: 100_000,
        },
        {
          accountId: world.accounts.tax_payable_pbjt,
          debitIdr: 0,
          creditIdr: 10_000,
        },
      ].map((line) =>
        journalLineInputSchema.parse({
          ...line,
          outletId: world.outletId,
          costCenter: null,
        }),
      ),
      postedBy: null,
      idempotencyKey: `aj:sale:${orderId}`,
    }),
  );
}

describe("547b historical tax payable accounts", () => {
  it("uses the current funded payout account while reversing historic tax and revenue accounts", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedPosOrder(world, orderId, sale);
    await post(world, orderPaid(world, orderId, sale));
    const context = contextOf(world.tenant);
    // Finance moves the actual Rp110000 to the replacement cash account.
    await withTenant(db, context, (tx) =>
      postJournalInTransaction(tx, context, {
        legalEntityId: world.entity,
        outletId: world.outletId,
        entryDate: businessDateSchema.parse(BUSINESS_DATE),
        sourceType: "manual",
        sourceId: null,
        description: "Pindahkan saldo kas ke akun pengganti",
        lines: [
          { accountId: world.accounts.bank, debitIdr: 110_000, creditIdr: 0 },
          {
            accountId: world.accounts.cash_on_hand,
            debitIdr: 0,
            creditIdr: 110_000,
          },
        ].map((line) =>
          journalLineInputSchema.parse({
            ...line,
            outletId: world.outletId,
            costCenter: null,
          }),
        ),
        postedBy: null,
        idempotencyKey: `cash-transfer-${orderId}`,
      }),
    );
    const replacementTaxId = await replacementAccount(world);
    await owner.query(
      `UPDATE account_mappings SET account_id = CASE
         WHEN role = 'cash_on_hand' THEN $3::uuid ELSE $4::uuid END
       WHERE tenant_id = $1 AND legal_entity_id = $2 AND role IN ('cash_on_hand', 'tax_payable_pbjt')`,
      [world.tenant.id, world.entity, world.accounts.bank, replacementTaxId],
    );
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    expect(await balanceOf(world, "bank")).toBe(110_000);

    const event = orderRefunded(world, orderId, createUlid(), {
      grossSalesIdr: 100_000,
      taxIdr: 10_000,
    });
    const refund = await post(world, event);
    await expectBalanced(world, refund);
    const credits = await netCreditByRole(world, refund);
    expect(credits.bank).toBe(110_000);
    expect(credits.cash_on_hand ?? 0).toBe(0);
    expect(credits.tax_payable_pbjt).toBe(-10_000);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    expect(await balanceOf(world, "bank")).toBe(0);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
    expect((await deliver(world, event)).status).toBe("already_posted");
    expect(await journalCount(world)).toBe(3);
  });

  it("after mapping A to B refunds and caps against A, leaving B untouched", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedPosOrder(world, orderId, sale);
    const saleEntryId = await post(world, orderPaid(world, orderId, sale));
    const snapshot = await owner.query<{
      posting_account_snapshot: Record<string, string>;
    }>(
      "SELECT posting_account_snapshot FROM journal_entries WHERE tenant_id = $1 AND id = $2",
      [world.tenant.id, saleEntryId],
    );
    expect(snapshot.rows[0]!.posting_account_snapshot.tax_payable_pbjt).toBe(
      world.accounts.tax_payable_pbjt,
    );
    await expect(
      owner.query(
        "UPDATE journal_entries SET posting_account_snapshot = '{}'::jsonb WHERE tenant_id = $1 AND id = $2",
        [world.tenant.id, saleEntryId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(db, contextOf(world.tenant), (tx) =>
        tx.execute(
          sql`UPDATE journal_entries SET posting_account_snapshot = '{}'::jsonb WHERE tenant_id = ${world.tenant.id}::uuid AND id = ${saleEntryId}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    const replacementId = await replacementAccount(world);
    await owner.query(
      `UPDATE account_mappings SET account_id = $3
       WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'tax_payable_pbjt'`,
      [world.tenant.id, world.entity, replacementId],
    );
    // The immutable column works without audit evidence, including after the
    // audit purge removes history. This direct remap deliberately has no audit.
    const auditHistory = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'accounting.account_mappings.replaced'",
      [world.tenant.id],
    );
    expect(Number(auditHistory.rows[0]!.n)).toBe(0);

    for (let index = 0; index < 2; index += 1) {
      const refundEvent = orderRefunded(world, orderId, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 5_000,
      });
      const entryId = await post(world, refundEvent);
      await expectBalanced(world, entryId);
      expect((await netCreditByRole(world, entryId)).tax_payable_pbjt).toBe(
        -5_000,
      );
      expect((await deliver(world, refundEvent)).status).toBe("already_posted");
    }
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    const replacementLines = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_lines
       WHERE tenant_id = $1 AND account_id = $2`,
      [world.tenant.id, replacementId],
    );
    expect(Number(replacementLines.rows[0]!.n)).toBe(0);
    expect(await journalCount(world)).toBe(3);

    const extra = await deliver(
      world,
      orderRefunded(world, orderId, createUlid(), {
        grossSalesIdr: 0,
        taxIdr: 1,
      }),
    );
    expect(extra.status).toBe("parked");
    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
  });

  it("recovers a pre-snapshot sale from audited mapping history, including a reversed refund", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedPosOrder(world, orderId, sale);
    const context = contextOf(world.tenant);
    await postLegacySale(world, orderId);
    const actorId = userIdSchema.parse(randomUUID());
    await owner.query(
      "INSERT INTO \"user\" (id, name, email) VALUES ($1, 'Finance', $2)",
      [actorId, `${actorId}@example.test`],
    );
    const replacementId = await replacementAccount(world);
    await replaceAccountMappingsForEntity(
      context,
      world.entity,
      {
        mappings: Object.entries(world.accounts).map(([role, accountId]) => ({
          role,
          accountId: role === "tax_payable_pbjt" ? replacementId : accountId,
        })),
      } as Parameters<typeof replaceAccountMappingsForEntity>[2],
      actorId,
    );

    const first = await post(
      world,
      orderRefunded(world, orderId, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 5_000,
      }),
    );
    expect((await netCreditByRole(world, first)).tax_payable_pbjt).toBe(-5_000);
    await withTenant(db, context, (tx) =>
      reverseJournalInTransaction(tx, context, first, {
        entryDate: businessDateSchema.parse(BUSINESS_DATE),
        reason: "Refund dibatalkan",
        idempotencyKey: `historic-reverse-${first}`,
        lateAdjustmentFrom: null,
        postedBy: null,
      }),
    );
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(-10_000);
    const full = await post(
      world,
      orderRefunded(world, orderId, createUlid(), {
        grossSalesIdr: 100_000,
        taxIdr: 10_000,
      }),
    );
    await expectBalanced(world, full);
    expect((await netCreditByRole(world, full)).tax_payable_pbjt).toBe(-10_000);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    const replacementLines = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
      [world.tenant.id, replacementId],
    );
    expect(Number(replacementLines.rows[0]!.n)).toBe(0);
  });
  it("parks a pre-snapshot sale when remapping has no matching historical evidence", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedPosOrder(world, orderId, sale);
    await postLegacySale(world, orderId);
    const replacementId = await replacementAccount(world);
    await owner.query(
      `UPDATE account_mappings SET account_id = $3
       WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'tax_payable_pbjt'`,
      [world.tenant.id, world.entity, replacementId],
    );
    const result = await deliver(
      world,
      orderRefunded(world, orderId, createUlid(), {
        grossSalesIdr: 50_000,
        taxIdr: 5_000,
      }),
    );
    expect(result).toMatchObject({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
    });
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(-10_000);
    expect(await balanceOf(world, "cash_on_hand")).toBe(110_000);
  });
});
