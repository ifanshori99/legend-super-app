// legend-89pn: data migration 0360 adds the account 2108 "Kas Masuk Belum
// Diklasifikasi" (role cash_in_clearing) and 6112 "Beban Kas Keluar Kasir"
// (role cash_out_expense) to entities that were provisioned before the code
// knew these roles. Without them a cash_movement.recorded event parks
// ACCOUNT_MAPPING_MISSING for ever. Written fail-first from the brief and the
// pattern of 0335 (purchase-price-variance-migration.test.ts), not from the SQL.
//
// Rules under test (same family as 0147 / 0205 / 0335):
// - Only entities that already have an `account_mappings` row get anything;
//   an unprovisioned entity gets nothing (the provisioning service seeds it).
// - 2108 is inserted as liability / current_liability under the entity's 2100,
//   6112 as expense / operating_expense under its 6100, each parent only when
//   it exists with the same type (else no parent).
// - Never update or delete: a custom account with the same code is kept; a
//   mapping the tenant already changed stays; a code of another type is not
//   mapped (the event keeps parking, which is safe); a header account (has a
//   child) is not mapped.
// - Restrictive (money, founder choice: when in doubt, limit): an account on
//   2108 / 6112 is mapped only when it carries exactly the seeded name AND is
//   not yet mapped to any role. A tenant's own account on the code (other
//   name, or already used by another role such as loyalty_liability) is never
//   hijacked; the event keeps parking ACCOUNT_MAPPING_MISSING, which is safe.
// - A parent that is a leaf posting account (mapped to a posting role such as
//   salary_expense or customer_deposit) is never used: adding a child would make
//   it a header and the next journal on it would fail ACCOUNT_NOT_POSTABLE. The
//   new account then has no parent. An unmapped 2100 / 6100 stays the parent.
// - Idempotent, spans every (tenant, legal entity) pair.
// - End to end: events parked before the backfill post a balanced journal
//   through the existing retry sweep, and never twice.
//
// Assumptions:
// - The migration file is `apps/api/drizzle/0360_cash_movement_mapping_backfill.sql`
//   and is run statement by statement as the migration owner, like the other
//   data-migration tests. It spans every tenant, so entities of other tests may
//   gain the accounts too; this file only looks at its own entities. Test files
//   run one at a time (fileParallelism false), so no other file is mid-flight.
// - Fixture entities are left in place (charts and ledgers are append-only).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { accountIdSchema } from "@starter/shared/accounting";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { postJournalInTransaction } from "../services/accounting-journal.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";
import { replayMigrationForTenant } from "./helpers/migration-replay.ts";

const fixtureTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const migrationSql = () =>
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../drizzle/0360_cash_movement_mapping_backfill.sql",
    ),
    "utf8",
  );

/** Replays the migration for one tenant only (legend-edxtt). */
const migrate = (tenantId: string = fixtureTenantId): Promise<void> =>
  replayMigrationForTenant(owner, migrationSql(), tenantId);

const GROUP_OF_TYPE: Record<string, string> = {
  asset: "current_asset",
  liability: "current_liability",
  expense: "operating_expense",
};

async function addAccount(
  tenantId: string,
  entityId: string,
  code: string,
  name: string,
  type: string,
  parentId: string | null = null,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tenantId, entityId, code, name, type, GROUP_OF_TYPE[type], parentId],
  );
  return rows[0]!.id;
}

async function mapRole(
  tenantId: string,
  entityId: string,
  role: string,
  accountId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, entityId, role, accountId],
  );
}

async function entity(
  provisioned: boolean,
  tenantId: string = fixtureTenantId,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [id, tenantId, `Entity 0360 ${id.slice(0, 8)}`],
  );
  if (provisioned) {
    // One mapping row is what makes an entity "provisioned".
    const cash = await addAccount(tenantId, id, "1101", "Kas", "asset");
    await mapRole(tenantId, id, "cash_on_hand", cash);
  }
  return id;
}

type AccountRow = {
  id: string;
  name: string;
  type: string;
  report_group: string;
  parent_id: string | null;
  is_active: boolean;
};

async function accountsOf(
  entityId: string,
  code: string,
  tenantId: string = fixtureTenantId,
): Promise<AccountRow[]> {
  const { rows } = await owner.query<AccountRow>(
    `SELECT id, name, type, report_group, parent_id, is_active FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
    [tenantId, entityId, code],
  );
  return rows;
}

async function mappingsOf(
  entityId: string,
  role: string,
  tenantId: string = fixtureTenantId,
): Promise<string[]> {
  const { rows } = await owner.query<{ account_id: string }>(
    `SELECT account_id FROM account_mappings
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3`,
    [tenantId, entityId, role],
  );
  return rows.map((row) => row.account_id);
}

async function rowCounts(
  entityId: string,
  tenantId: string = fixtureTenantId,
): Promise<{ accounts: number; mappings: number }> {
  const accounts = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, entityId],
  );
  const mappings = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, entityId],
  );
  return {
    accounts: Number(accounts.rows[0]!.n),
    mappings: Number(mappings.rows[0]!.n),
  };
}

describe("legend-89pn migration 0360 cash movement accounts and mappings", () => {
  it("MIG-01 a provisioned entity gets 2108 (liability, under 2100) and 6112 (expense, under 6100) with their role mappings", async () => {
    const entityId = await entity(true);
    const liabilityParent = await addAccount(
      fixtureTenantId,
      entityId,
      "2100",
      "Utang Lancar",
      "liability",
    );
    const expenseParent = await addAccount(
      fixtureTenantId,
      entityId,
      "6100",
      "Beban Operasional",
      "expense",
    );

    await migrate();

    const clearing = await accountsOf(entityId, "2108");
    expect(clearing).toHaveLength(1);
    expect(clearing[0]).toMatchObject({
      name: "Kas Masuk Belum Diklasifikasi",
      type: "liability",
      report_group: "current_liability",
      parent_id: liabilityParent,
      is_active: true,
    });
    const expense = await accountsOf(entityId, "6112");
    expect(expense).toHaveLength(1);
    expect(expense[0]).toMatchObject({
      name: "Beban Kas Keluar Kasir",
      type: "expense",
      report_group: "operating_expense",
      parent_id: expenseParent,
      is_active: true,
    });
    expect(await mappingsOf(entityId, "cash_in_clearing")).toEqual([
      clearing[0]!.id,
    ]);
    expect(await mappingsOf(entityId, "cash_out_expense")).toEqual([
      expense[0]!.id,
    ]);
  });

  it("MIG-01b without a usable parent the accounts have no parent (a parent of another type is never used)", async () => {
    const noParent = await entity(true);
    const wrongType = await entity(true);
    await addAccount(fixtureTenantId, wrongType, "2100", "Aset", "asset");
    await addAccount(fixtureTenantId, wrongType, "6100", "Aset 2", "asset");

    await migrate();

    for (const entityId of [noParent, wrongType]) {
      const clearing = await accountsOf(entityId, "2108");
      const expense = await accountsOf(entityId, "6112");
      expect(clearing).toHaveLength(1);
      expect(expense).toHaveLength(1);
      expect(clearing[0]!.parent_id).toBeNull();
      expect(expense[0]!.parent_id).toBeNull();
      expect(await mappingsOf(entityId, "cash_in_clearing")).toEqual([
        clearing[0]!.id,
      ]);
      expect(await mappingsOf(entityId, "cash_out_expense")).toEqual([
        expense[0]!.id,
      ]);
    }
  });

  it("MIG-02 is idempotent: running it twice leaves the same rows", async () => {
    const entityId = await entity(true);

    await migrate();
    const once = await rowCounts(entityId);
    const accountIds = (await accountsOf(entityId, "2108")).map((a) => a.id);
    await migrate();

    expect(once).toEqual({ accounts: 3, mappings: 3 });
    expect(await rowCounts(entityId)).toEqual(once);
    expect((await accountsOf(entityId, "2108")).map((a) => a.id)).toEqual(
      accountIds,
    );
  });

  it("MIG-03 never overwrites: a mapping the tenant changed stays, a custom account of another name on 2108 is kept and not mapped, a 6112 of another type is not mapped", async () => {
    const remapped = await entity(true);
    const mine = await addAccount(
      fixtureTenantId,
      remapped,
      "5999",
      "Beban Kasir Saya",
      "expense",
    );
    await mapRole(fixtureTenantId, remapped, "cash_out_expense", mine);

    const custom = await entity(true);
    const customId = await addAccount(
      fixtureTenantId,
      custom,
      "2108",
      "Titipan Khusus",
      "liability",
    );

    const wrong = await entity(true);
    const wrongId = await addAccount(
      fixtureTenantId,
      wrong,
      "6112",
      "Piutang Karyawan",
      "asset",
    );

    await migrate();
    await migrate();

    // The tenant's own mapping is untouched; no second 6112 mapping appears.
    expect(await mappingsOf(remapped, "cash_out_expense")).toEqual([mine]);
    // The unrelated 2108 is created where it is missing (the 6112 was remapped).
    expect(await accountsOf(remapped, "2108")).toHaveLength(1);

    // A custom account of another name on 2108 keeps its name, is never
    // duplicated and is NOT mapped: the cash-in would land on a tenant account.
    const customRows = await accountsOf(custom, "2108");
    expect(customRows).toHaveLength(1);
    expect(customRows[0]).toMatchObject({
      id: customId,
      name: "Titipan Khusus",
      type: "liability",
    });
    expect(await mappingsOf(custom, "cash_in_clearing")).toHaveLength(0);

    // An asset account on 6112 is never mapped as an expense; no error.
    const wrongRows = await accountsOf(wrong, "6112");
    expect(wrongRows).toHaveLength(1);
    expect(wrongRows[0]).toMatchObject({
      id: wrongId,
      name: "Piutang Karyawan",
      type: "asset",
    });
    expect(await mappingsOf(wrong, "cash_out_expense")).toHaveLength(0);
    // The other role of that entity is still backfilled.
    expect(await mappingsOf(wrong, "cash_in_clearing")).toHaveLength(1);
  });

  it("MIG-03b a 2108 with the seeded name that is already mapped to another role is not mapped to cash_in_clearing", async () => {
    const entityId = await entity(true);
    const taken = await addAccount(
      fixtureTenantId,
      entityId,
      "2108",
      "Kas Masuk Belum Diklasifikasi",
      "liability",
    );
    await mapRole(fixtureTenantId, entityId, "loyalty_liability", taken);

    await migrate();
    await migrate();

    expect(await accountsOf(entityId, "2108")).toHaveLength(1);
    expect(await mappingsOf(entityId, "loyalty_liability")).toEqual([taken]);
    expect(await mappingsOf(entityId, "cash_in_clearing")).toHaveLength(0);
    // The independent 6112 role is still backfilled.
    expect(await mappingsOf(entityId, "cash_out_expense")).toHaveLength(1);
  });

  it("MIG-03c a 6112 of another name is kept and not mapped to cash_out_expense", async () => {
    const entityId = await entity(true);
    const customId = await addAccount(
      fixtureTenantId,
      entityId,
      "6112",
      "Beban Lain-lain",
      "expense",
    );

    await migrate();
    await migrate();

    const rows = await accountsOf(entityId, "6112");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: customId, name: "Beban Lain-lain" });
    expect(await mappingsOf(entityId, "cash_out_expense")).toHaveLength(0);
    expect(await mappingsOf(entityId, "cash_in_clearing")).toHaveLength(1);
  });

  it("MIG-04 an entity with no account mapping at all (not provisioned) gets nothing", async () => {
    const entityId = await entity(false);

    await migrate();

    expect(await rowCounts(entityId)).toEqual({ accounts: 0, mappings: 0 });
  });

  it("MIG-05 a header account (it has a child) is not mapped", async () => {
    const entityId = await entity(true);
    const clearingId = await addAccount(
      fixtureTenantId,
      entityId,
      "2108",
      "Kas Masuk Belum Diklasifikasi",
      "liability",
    );
    await addAccount(
      fixtureTenantId,
      entityId,
      "21081",
      "Anak Header",
      "liability",
      clearingId,
    );
    const expenseId = await addAccount(
      fixtureTenantId,
      entityId,
      "6112",
      "Beban Kas Keluar Kasir",
      "expense",
    );
    await addAccount(
      fixtureTenantId,
      entityId,
      "61121",
      "Anak Beban",
      "expense",
      expenseId,
    );

    await migrate();

    expect((await accountsOf(entityId, "2108"))[0]!.id).toBe(clearingId);
    expect((await accountsOf(entityId, "6112"))[0]!.id).toBe(expenseId);
    expect(await mappingsOf(entityId, "cash_in_clearing")).toHaveLength(0);
    expect(await mappingsOf(entityId, "cash_out_expense")).toHaveLength(0);
  });

  it("MIG-05b an inactive account on the code is not mapped", async () => {
    const entityId = await entity(true);
    const clearingId = await addAccount(
      fixtureTenantId,
      entityId,
      "2108",
      "Kas Masuk Belum Diklasifikasi",
      "liability",
    );
    await owner.query(
      "UPDATE chart_of_accounts SET is_active = false WHERE id = $1",
      [clearingId],
    );

    await migrate();

    expect(await mappingsOf(entityId, "cash_in_clearing")).toHaveLength(0);
  });

  it("MIG-06 every (tenant, legal entity) pair gets its own accounts; an unprovisioned entity gets nothing; FORCE RLS stays on", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const a1 = await entity(true, tenantA.id);
    const a2 = await entity(true, tenantA.id);
    const b1 = await entity(true, tenantB.id);
    const untouched = await entity(false, tenantB.id);

    await migrate(tenantA.id);
    await migrate(tenantB.id);

    const ids = new Set<string>();
    for (const [tenantId, entityId] of [
      [tenantA.id, a1],
      [tenantA.id, a2],
      [tenantB.id, b1],
    ] as const) {
      const clearing = await accountsOf(entityId, "2108", tenantId);
      const expense = await accountsOf(entityId, "6112", tenantId);
      expect(clearing).toHaveLength(1);
      expect(expense).toHaveLength(1);
      expect(await mappingsOf(entityId, "cash_in_clearing", tenantId)).toEqual([
        clearing[0]!.id,
      ]);
      expect(await mappingsOf(entityId, "cash_out_expense", tenantId)).toEqual([
        expense[0]!.id,
      ]);
      ids.add(clearing[0]!.id);
      ids.add(expense[0]!.id);
    }
    expect(ids.size).toBe(6);
    expect(await rowCounts(untouched, tenantB.id)).toEqual({
      accounts: 0,
      mappings: 0,
    });

    const { rows } = await owner.query<{
      relname: string;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname IN ('chart_of_accounts', 'account_mappings')
          AND relnamespace = 'public'::regnamespace`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.relforcerowsecurity).toBe(true);
  });
});

// ---- end to end: parked cash movements post after the backfill -------------

const NOW = new Date("2026-11-08T03:00:00Z");
const SWEEP_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
/** 2026-10-15 12:00 Jakarta: business date 2026-10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
const FLOAT_IDR = 500_000;
const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

type Tenant = { id: string; brandId: string };

async function newTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Backfill Kas', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-bfcm-${id.slice(0, 8)}`,
      FLAGS_ON,
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, id],
  );
  return { id, brandId };
}

function contextOf(tenant: Tenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

async function asTenant<T>(
  tenant: Tenant,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type OldWorld = {
  tenant: Tenant;
  entityId: string;
  outletId: string;
  cashId: string;
};

/** A tenant provisioned before the roles existed: only cash_on_hand (+ headers). */
async function makeOldWorld(withCashOnHand = true): Promise<OldWorld> {
  const tenant = await newTenant();
  const entityId = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entityId, tenant.id, `Entity BF ${entityId.slice(0, 6)}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet BF', 'Jl. BF', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entityId,
      `BF-${outletId.slice(0, 6)}`.toUpperCase(),
    ],
  );
  const cashId = await addAccount(tenant.id, entityId, "1101", "Kas", "asset");
  // Without cash_on_hand the entity is still provisioned through another role.
  await mapRole(
    tenant.id,
    entityId,
    withCashOnHand ? "cash_on_hand" : "sales_revenue",
    cashId,
  );
  await addAccount(tenant.id, entityId, "2100", "Utang Lancar", "liability");
  await addAccount(tenant.id, entityId, "6100", "Beban Operasional", "expense");
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.id, entityId, period],
    );
  return { tenant, entityId, outletId, cashId };
}

type Movement = {
  id: string;
  shiftId: string;
  type: "cash_in" | "cash_out";
  amountIdr: number;
  cashierId: string;
  deviceId: string;
};

async function seedMovement(
  world: OldWorld,
  type: "cash_in" | "cash_out",
  amountIdr: number,
): Promise<Movement> {
  const cashierId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [cashierId, "Kasir BF", `${cashierId}@example.com`],
  );
  const shiftId = randomUUID();
  const deviceId = randomUUID();
  const id = randomUUID();
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, '2026-10-15', 'open', $6, $7, $8, $9)`,
      [
        shiftId,
        world.tenant.id,
        world.outletId,
        deviceId,
        cashierId,
        DAY,
        FLOAT_IDR,
        randomUUID(),
        "a".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO cash_movements
         (id, tenant_id, outlet_id, shift_id, type, amount_idr, reason_note,
          recorded_by, recorded_at, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'Alasan uji kas', $7, $8, $9, $10)`,
      [
        id,
        world.tenant.id,
        world.outletId,
        shiftId,
        type,
        amountIdr,
        cashierId,
        DAY,
        randomUUID(),
        "d".repeat(64),
      ],
    );
  });
  return { id, shiftId, type, amountIdr, cashierId, deviceId };
}

function movementRecorded(world: OldWorld, movement: Movement): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: "cash_movement.recorded",
    version: 1,
    aggregateType: "cash_movement",
    aggregateId: movement.id,
    sequence: 1,
    occurredAt: DAY,
    actor: { type: "system" },
    idempotencyKey: `bf-cm-test-${id}`,
    payloadSchemaRef: "cash_movement.recorded.v1",
    payload: {
      movementId: movement.id,
      shiftId: movement.shiftId,
      outletId: world.outletId,
      deviceId: movement.deviceId,
      type: movement.type,
      amountIdr: movement.amountIdr,
      reasonNote: "Alasan uji kas",
      recordedBy: movement.cashierId,
      recordedAt: DAY,
    },
  });
}

function deliver(
  tenant: Tenant,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = contextOf(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

let sweepCount = 0;
function sweep(tenant: Tenant) {
  sweepCount += 1;
  return retryParkedAutoJournals(
    contextOf(tenant),
    new Date(SWEEP_AT.getTime() + sweepCount * 60 * 60 * 1000),
  );
}

type JournalLine = { accountId: string; debit: number; credit: number };
type Journal = { key: string; lines: JournalLine[] };

async function journalsOf(world: OldWorld): Promise<Journal[]> {
  const entries = await owner.query<{ id: string; key: string | null }>(
    `SELECT id, idempotency_key AS key FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY created_at`,
    [world.tenant.id, world.entityId],
  );
  const journals: Journal[] = [];
  for (const entry of entries.rows) {
    const { rows } = await owner.query<{
      account_id: string;
      debit: string;
      credit: string;
    }>(
      `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
         FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
      [world.tenant.id, entry.id],
    );
    journals.push({
      key: entry.key ?? "",
      lines: rows.map((row) => ({
        accountId: row.account_id,
        debit: Number(row.debit),
        credit: Number(row.credit),
      })),
    });
  }
  return journals;
}

async function parkedCodes(world: OldWorld): Promise<string[]> {
  return asTenant(world.tenant, async (client) => {
    const { rows } = await client.query<{ error_code: string }>(
      `SELECT error_code FROM auto_journal_parked
        WHERE tenant_id = $1 AND outlet_id = $2 AND event_name = 'cash_movement.recorded'`,
      [world.tenant.id, world.outletId],
    );
    return rows.map((row) => row.error_code);
  });
}

describe("legend-89pn parked cash movements of an old tenant post after the backfill", () => {
  beforeAll(() => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    setAuditWriter(coreAuditWriter);
  });

  afterAll(async () => {
    setAuditWriter(null);
    await owner.end();
  });

  it("E2E-01 cash_out and cash_in park ACCOUNT_MAPPING_MISSING before, post balanced journals through the existing retry after, and never twice", async () => {
    const world = await makeOldWorld();
    const cashOut = await seedMovement(world, "cash_out", 30_000);
    const cashIn = await seedMovement(world, "cash_in", 75_000);
    const outEvent = movementRecorded(world, cashOut);
    const inEvent = movementRecorded(world, cashIn);

    for (const event of [outEvent, inEvent])
      expect(await deliver(world.tenant, event)).toMatchObject({
        status: "parked",
        code: "ACCOUNT_MAPPING_MISSING",
        retryable: true,
      });
    expect(await parkedCodes(world)).toEqual([
      "ACCOUNT_MAPPING_MISSING",
      "ACCOUNT_MAPPING_MISSING",
    ]);
    expect(await journalsOf(world)).toHaveLength(0);

    await migrate(world.tenant.id);
    await sweep(world.tenant);
    // The sweep consumed the parked rows: nothing is left parked.
    expect(await parkedCodes(world)).toEqual([]);

    const clearingId = (
      await accountsOf(world.entityId, "2108", world.tenant.id)
    )[0]!.id;
    const expenseId = (
      await accountsOf(world.entityId, "6112", world.tenant.id)
    )[0]!.id;
    const journals = await journalsOf(world);
    expect(journals).toHaveLength(2);

    const outJournal = journals.find((j) => j.key.includes(cashOut.id))!;
    const inJournal = journals.find((j) => j.key.includes(cashIn.id))!;
    expect(outJournal.key).toBe(`aj:cash-movement:${cashOut.id}`);
    expect(inJournal.key).toBe(`aj:cash-movement:${cashIn.id}`);
    expect([...outJournal.lines].sort(byAccount)).toEqual(
      [
        { accountId: expenseId, debit: 30_000, credit: 0 },
        { accountId: world.cashId, debit: 0, credit: 30_000 },
      ].sort(byAccount),
    );
    expect([...inJournal.lines].sort(byAccount)).toEqual(
      [
        { accountId: world.cashId, debit: 75_000, credit: 0 },
        { accountId: clearingId, debit: 0, credit: 75_000 },
      ].sort(byAccount),
    );
    for (const journal of journals)
      expect(sum(journal.lines, "debit")).toBe(sum(journal.lines, "credit"));

    // A second sweep and a redelivery of the same events add nothing.
    await sweep(world.tenant);
    await deliver(world.tenant, outEvent);
    await deliver(world.tenant, inEvent);
    expect(await journalsOf(world)).toHaveLength(2);
  });

  it("E2E-02 a provisioned entity without cash_on_hand gets the accounts, but its events keep parking and nothing is journaled", async () => {
    const world = await makeOldWorld(false);
    const cashOut = await seedMovement(world, "cash_out", 30_000);
    const cashIn = await seedMovement(world, "cash_in", 75_000);
    for (const movement of [cashOut, cashIn])
      expect(
        await deliver(world.tenant, movementRecorded(world, movement)),
      ).toMatchObject({ status: "parked", code: "ACCOUNT_MAPPING_MISSING" });

    await migrate(world.tenant.id);
    await sweep(world.tenant);

    expect(
      await accountsOf(world.entityId, "2108", world.tenant.id),
    ).toHaveLength(1);
    expect(
      await accountsOf(world.entityId, "6112", world.tenant.id),
    ).toHaveLength(1);
    expect(
      await mappingsOf(world.entityId, "cash_on_hand", world.tenant.id),
    ).toHaveLength(0);
    expect(await parkedCodes(world)).toEqual([
      "ACCOUNT_MAPPING_MISSING",
      "ACCOUNT_MAPPING_MISSING",
    ]);
    expect(await journalsOf(world)).toHaveLength(0);
  });

  /** Posts a balanced manual journal between a cash account and `accountId`. */
  function postBetween(
    world: OldWorld,
    accountId: string,
    side: "debit" | "credit",
    key: string,
  ) {
    const context = contextOf(world.tenant);
    const line = (id: string, debitIdr: number, creditIdr: number) => ({
      accountId: accountIdSchema.parse(id),
      debitIdr: idr(debitIdr),
      creditIdr: idr(creditIdr),
      outletId: outletIdSchema.parse(world.outletId),
      costCenter: null,
    });
    const target =
      side === "debit"
        ? line(accountId, 10_000, 0)
        : line(accountId, 0, 10_000);
    const cash =
      side === "debit"
        ? line(world.cashId, 0, 10_000)
        : line(world.cashId, 10_000, 0);
    return withTenant(db, context, (tx) =>
      postJournalInTransaction(
        tx,
        context,
        {
          legalEntityId: world.entityId,
          outletId: world.outletId,
          entryDate: "2026-10-15",
          sourceType: "manual",
          sourceId: null,
          description: "Uji parent daun (test)",
          lines: [target, cash],
          postedBy: null,
          idempotencyKey: key,
        },
        NOW,
      ),
    );
  }

  it("E2E-03 a 6100 that is a leaf mapped to salary_expense stays a leaf: 6112 has no parent and the salary journal still posts balanced", async () => {
    const world = await makeOldWorld();
    const salaryId = (
      await accountsOf(world.entityId, "6100", world.tenant.id)
    )[0]!.id;
    await mapRole(world.tenant.id, world.entityId, "salary_expense", salaryId);

    await migrate(world.tenant.id);

    const expense = await accountsOf(world.entityId, "6112", world.tenant.id);
    expect(expense).toHaveLength(1);
    expect(expense[0]!.parent_id).toBeNull();
    expect(
      await mappingsOf(world.entityId, "cash_out_expense", world.tenant.id),
    ).toEqual([expense[0]!.id]);
    const { rows } = await owner.query(
      "SELECT 1 FROM chart_of_accounts WHERE tenant_id = $1 AND parent_id = $2",
      [world.tenant.id, salaryId],
    );
    expect(rows).toHaveLength(0);

    const entry = await postBetween(
      world,
      salaryId,
      "debit",
      `bf-salary-${randomUUID()}`,
    );
    expect(entry.lines).toHaveLength(2);
    expect(
      sum(
        entry.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debitIdr,
          credit: l.creditIdr,
        })),
        "debit",
      ),
    ).toBe(10_000);
    expect(
      sum(
        entry.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debitIdr,
          credit: l.creditIdr,
        })),
        "credit",
      ),
    ).toBe(10_000);
  });

  it("E2E-04 a 2100 mapped to a posting role (customer_deposit) stays a leaf: 2108 has no parent and the journal on 2100 still posts", async () => {
    const world = await makeOldWorld();
    const depositId = (
      await accountsOf(world.entityId, "2100", world.tenant.id)
    )[0]!.id;
    await mapRole(
      world.tenant.id,
      world.entityId,
      "customer_deposit",
      depositId,
    );

    await migrate(world.tenant.id);

    const clearing = await accountsOf(world.entityId, "2108", world.tenant.id);
    expect(clearing).toHaveLength(1);
    expect(clearing[0]!.parent_id).toBeNull();
    expect(
      await mappingsOf(world.entityId, "cash_in_clearing", world.tenant.id),
    ).toEqual([clearing[0]!.id]);

    const entry = await postBetween(
      world,
      depositId,
      "credit",
      `bf-deposit-${randomUUID()}`,
    );
    expect(entry.lines).toHaveLength(2);
  });

  it("E2E-05 an unmapped 2100 / 6100 header stays the parent, and another entity's mapping on its own 6100 does not change that", async () => {
    const world = await makeOldWorld();
    const other = await makeOldWorld();
    const otherSalary = (
      await accountsOf(other.entityId, "6100", other.tenant.id)
    )[0]!.id;
    await mapRole(
      other.tenant.id,
      other.entityId,
      "salary_expense",
      otherSalary,
    );

    await migrate(world.tenant.id);
    await migrate(other.tenant.id);

    const ids = async (w: OldWorld, code: string) =>
      (await accountsOf(w.entityId, code, w.tenant.id))[0]!.id;
    const parent = async (w: OldWorld, code: string) =>
      (await accountsOf(w.entityId, code, w.tenant.id))[0]!.parent_id;
    expect(await parent(world, "6112")).toBe(await ids(world, "6100"));
    expect(await parent(world, "2108")).toBe(await ids(world, "2100"));
    expect(await parent(other, "6112")).toBeNull();
    // The 2100 of the other entity is unmapped, so it is still the parent there.
    expect(await parent(other, "2108")).toBe(await ids(other, "2100"));
  });
});

const byAccount = (a: JournalLine, b: JournalLine) =>
  a.accountId.localeCompare(b.accountId);
const sum = (lines: JournalLine[], key: "debit" | "credit") =>
  lines.reduce((total, line) => total + line[key], 0);
