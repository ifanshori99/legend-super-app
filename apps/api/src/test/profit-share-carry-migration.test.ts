import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Profit share carry-over (bead legend-lzvh0, brief docs/briefs/lzvh0-carry.md
// section B; founder rule Q83). Migration 0219_profit_share_carry adds
// `distribution_run_shortfalls`, `distribution_carry_deductions` and
// `carry_deducted_idr` on `distribution_runs` / `distribution_lines`.
//
// Like migrator-role.test.ts it runs on a scratch database of the disposable
// test server, migrated from zero by the production migrator login
// (NOSUPERUSER, BYPASSRLS): a plain owner could not add foreign keys to the
// FORCE RLS parents without lifting FORCE first (contracts.md pattern 2).
// Tests inside the describe run in order and share state.
//
// Assumptions where the brief is silent: both new tables are append-only for
// the app login (no UPDATE, DELETE or TRUNCATE), and a deduction must point at
// a shortfall of the SAME shareholder (composite foreign key), so a shortfall
// can never be charged to another shareholder.
//
// Database guards (architect review of lzvh0): a shortfall is written only for
// a DRAFT adjustment run and its rows must add up to `unabsorbed_idr` at commit;
// a deduction is written only for a DRAFT regular run, against a shortfall of
// the same entity whose adjustment is approved or paid, the deductions of a run
// must add up to `carry_deducted_idr` and the live deductions of a shortfall may
// never exceed it. Rows are therefore written in the same transaction as their
// run, and the deferred checks only fire at COMMIT.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionMigrator } from "../db/migrator-role";
import { provisionRoles } from "../db/provision-roles";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function urlFor(database: string, user?: string, password?: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

// Refuse to create databases or roles on anything but the disposable server.
function assertDisposableServer() {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
}

async function dropRoles(admin: Pool, roles: string[]) {
  for (const role of roles)
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
}

/** SQLSTATE of a failing statement, or "ok" when it succeeds. */
async function sqlState(promise: Promise<unknown>) {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
}

describe("legend-lzvh0 migration 0219 profit share carry", () => {
  const database = `profit_carry_${hex(6)}`;
  const bootstrap = {
    user: new URL(adminUrl ?? "postgres://x@localhost/x").username,
    password: new URL(adminUrl ?? "postgres://x@localhost/x").password,
  };
  const migratorUser = `legend_migrator_${hex(8)}`;
  const migratorPassword = hex(24);
  const appUser = `legend_runtime_${hex(8)}`;
  const appPassword = hex(24);
  const workerUser = `legend_worker_${hex(8)}`;
  const workerPassword = hex(24);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let migratorUrl: string;
  let appUrl: string;
  let workerUrl: string;
  let admin: Pool;
  let migrator: Pool;

  // Seeded world of tenant A.
  const entityId = randomUUID();
  const holder1 = randomUUID();
  const holder2 = randomUUID();
  const adjustmentRunId = randomUUID();
  const regularRunId = randomUUID();
  const carryRunId = randomUUID();
  const shortfall1 = randomUUID();
  const shortfall2 = randomUUID();
  const periods: Record<string, string> = {};
  let legalEntity = "";
  let periodCounter = 0;

  beforeAll(async () => {
    assertDisposableServer();
    migratorUrl = urlFor(database, migratorUser, migratorPassword);
    appUrl = urlFor(database, appUser, appPassword);
    workerUrl = urlFor(database, workerUser, workerPassword);
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
  }, 60_000);

  afterAll(async () => {
    if (migrator) await endTestPool(migrator);
    if (admin) {
      try {
        await dropTestDatabase(admin, database);
        await dropRoles(admin, [appUser, workerUser, migratorUser]);
      } finally {
        await endTestPool(admin);
      }
    }
  });

  // Run + lines in one transaction: the totals trigger is deferred to commit.
  async function insertRun(
    run: {
      id: string;
      type: "regular" | "adjustment";
      period: string;
      periodId: string;
      distributable: number;
      gross: number;
      carry: number;
      unabsorbed?: number;
      adjustsRunId?: string;
      idempotency: string;
      /** Written in the same transaction (the deferred guards fire at COMMIT). */
      shortfalls?: { id: string; shareholderId: string; amount: number }[];
      deductions?: {
        shortfallId: string;
        shareholderId: string;
        amount: number;
      }[];
    },
    lines: {
      shareholderId: string;
      bp: number;
      gross: number;
      carry: number;
    }[],
  ) {
    const client: PoolClient = await migrator.connect();
    try {
      await client.query("BEGIN");
      const regular = run.type === "regular";
      await client.query(
        `INSERT INTO distribution_runs
           (tenant_id, id, profit_entity_id, fiscal_period_id, fiscal_period_version, period,
            type, basis, status, share_version, period_net_profit_idr, reserve_idr,
            distributable_idr, total_gross_idr, total_tax_withheld_idr, total_net_idr,
            unabsorbed_idr, carry_deducted_idr, tax_withholding_bp, requested_by,
            adjusts_run_id, adjustment_reason, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 'draft', 1, $8, $9, $10, $11, 0, $11, $12, $13, 0,
                 'requester', $14, $15, $16)`,
        [
          tenantA,
          run.id,
          entityId,
          run.periodId,
          run.period,
          run.type,
          regular ? "closed_period_net_profit" : "approved_run_adjustment",
          regular ? 1000 : null,
          regular ? 100 : 0,
          run.distributable,
          run.gross,
          run.unabsorbed ?? 0,
          run.carry,
          run.adjustsRunId ?? null,
          regular ? null : "koreksi uji",
          run.idempotency,
        ],
      );
      for (const [position, line] of lines.entries())
        await client.query(
          `INSERT INTO distribution_lines
             (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr,
              tax_withheld_idr, net_idr, carry_deducted_idr, position)
           VALUES ($1, $2, $3, $4, $5, 0, $5, $6, $7)`,
          [
            tenantA,
            run.id,
            line.shareholderId,
            line.bp,
            line.gross,
            line.carry,
            position,
          ],
        );
      for (const row of run.shortfalls ?? [])
        await client.query(
          `INSERT INTO distribution_run_shortfalls
             (tenant_id, id, distribution_run_id, profit_entity_id, shareholder_id, amount_idr)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantA, row.id, run.id, entityId, row.shareholderId, row.amount],
        );
      for (const row of run.deductions ?? [])
        await client.query(
          `INSERT INTO distribution_carry_deductions
             (tenant_id, distribution_run_id, shortfall_id, profit_entity_id, shareholder_id, amount_idr)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            tenantA,
            run.id,
            row.shortfallId,
            entityId,
            row.shareholderId,
            row.amount,
          ],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const approve = async (runId: string) => {
    await migrator.query(
      `UPDATE distribution_runs SET status = 'pending_approval'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA, runId],
    );
    await migrator.query(
      `UPDATE distribution_runs SET status = 'approved', approved_by = 'approver', approved_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA, runId],
    );
  };

  const insertShortfall = (
    id: string,
    shareholderId: string,
    amount: number,
    runId = adjustmentRunId,
    tenantId = tenantA,
  ) =>
    migrator.query(
      `INSERT INTO distribution_run_shortfalls
         (tenant_id, id, distribution_run_id, profit_entity_id, shareholder_id, amount_idr)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, id, runId, entityId, shareholderId, amount],
    );

  const insertDeduction = (
    shortfallId: string,
    shareholderId: string,
    amount: number,
    runId = carryRunId,
    profitEntityId = entityId,
  ) =>
    migrator.query(
      `INSERT INTO distribution_carry_deductions
         (tenant_id, distribution_run_id, shortfall_id, profit_entity_id, shareholder_id, amount_idr)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantA, runId, shortfallId, profitEntityId, shareholderId, amount],
    );

  /**
   * Statements that fail at the statement itself: run them in a transaction that
   * is always rolled back, so nothing is committed and no deferred guard fires.
   * Returns the SQLSTATE and message of the first failure, or "ok".
   */
  async function inRolledBack(
    work: (client: PoolClient) => Promise<unknown>,
  ): Promise<{ state: string; message: string }> {
    const client = await migrator.connect();
    try {
      await client.query("BEGIN");
      await work(client);
      return { state: "ok", message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { state: e.code ?? "no-code", message: e.message ?? "" };
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  /** Writes in one transaction and reports what COMMIT (the deferred guards) says. */
  async function committed(
    work: (client: PoolClient) => Promise<unknown>,
  ): Promise<{ state: string; message: string }> {
    const client = await migrator.connect();
    try {
      await client.query("BEGIN");
      await work(client);
      await client.query("COMMIT");
      return { state: "ok", message: "" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const e = error as { code?: string; message?: string };
      return { state: e.code ?? "no-code", message: e.message ?? "" };
    } finally {
      client.release();
    }
  }

  /** A draft adjustment run with no shortfall (unabsorbed 0), for guard tests. */
  async function draftAdjustment() {
    const id = randomUUID();
    await insertRun(
      {
        id,
        type: "adjustment",
        period: "2025-01",
        periodId: periods["2025-01"]!,
        distributable: -10,
        gross: -10,
        carry: 0,
        adjustsRunId: regularRunId,
        idempotency: `run-${randomUUID()}`,
      },
      [{ shareholderId: holder1, bp: 6000, gross: -10, carry: 0 }],
    );
    return id;
  }

  /** An approved adjustment run that left `amount` unabsorbed on a shareholder (default holder1). */
  async function approvedShortfall(amount: number, shareholderId = holder1) {
    const id = randomUUID();
    const shortfallId = randomUUID();
    await insertRun(
      {
        id,
        type: "adjustment",
        period: "2025-01",
        periodId: periods["2025-01"]!,
        distributable: -10,
        gross: -10,
        carry: 0,
        unabsorbed: amount,
        adjustsRunId: regularRunId,
        idempotency: `run-${randomUUID()}`,
        shortfalls: [{ id: shortfallId, shareholderId, amount }],
      },
      [{ shareholderId: holder1, bp: 6000, gross: -10, carry: 0 }],
    );
    await approve(id);
    return shortfallId;
  }

  /** One regular run per entity and period: every draft gets a closed period of its own. */
  async function freshPeriod() {
    periodCounter += 1;
    const period = `${2030 + Math.floor(periodCounter / 12)}-${String((periodCounter % 12) + 1).padStart(2, "0")}`;
    const { rows } = await migrator.query<{ id: string }>(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
       VALUES ($1, $2, $3, 'closed', 'closer', now()) RETURNING id`,
      [tenantA, legalEntity, period],
    );
    return { period, periodId: rows[0]!.id };
  }

  /** A draft regular run in a fresh period that deducts `carry` from holder1. */
  const carryDraft = async (
    carry: number,
    deductions: {
      shortfallId: string;
      shareholderId: string;
      amount: number;
    }[],
    id = randomUUID(),
  ) =>
    insertRun(
      {
        id,
        type: "regular",
        ...(await freshPeriod()),
        distributable: 900,
        gross: 900 - carry,
        carry,
        idempotency: `run-${randomUUID()}`,
        deductions,
      },
      [{ shareholderId: holder1, bp: 10000, gross: 900 - carry, carry }],
    );

  it("provisions a non-superuser migrator and applies every migration from zero, 0219 included", async () => {
    await provisionMigrator({ bootstrap, migratorUrl, appUrl, workerUrl });
    const flags = await admin.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [migratorUser],
    );
    expect(flags.rows[0]).toEqual({ rolsuper: false, rolbypassrls: true });
    migrator = new Pool({ connectionString: migratorUrl, max: 2 });
    await expect(
      migrate(drizzle(migrator), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
    await provisionRoles({ adminUrl: migratorUrl, appUrl, workerUrl });

    const journal = JSON.parse(
      readFileSync(resolve(drizzleFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const entry = journal.entries.find(
      (e) => e.tag === "0219_profit_share_carry",
    );
    expect(entry).toMatchObject({ idx: 219, when: 1794300000000 });
    expect(journal.entries[journal.entries.indexOf(entry!) - 1]?.tag).toBe(
      "0218_profit_share_unabsorbed",
    );
    const applied = await migrator.query(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    expect(applied.rows[0].n).toBe(journal.entries.length);
  }, 240_000);

  it("creates both tables, the new columns and the named constraints", async () => {
    const columns = await migrator.query(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'distribution_run_shortfalls' AND column_name IN
                ('tenant_id','id','distribution_run_id','profit_entity_id','shareholder_id','amount_idr','created_at'))
            OR (table_name = 'distribution_carry_deductions' AND column_name IN
                ('tenant_id','id','distribution_run_id','shortfall_id','profit_entity_id','shareholder_id','amount_idr','created_at'))
            OR (table_name IN ('distribution_runs','distribution_lines') AND column_name = 'carry_deducted_idr'))`,
    );
    const names = columns.rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .sort();
    expect(names).toEqual(
      [
        ...[
          "tenant_id",
          "id",
          "distribution_run_id",
          "profit_entity_id",
          "shareholder_id",
          "amount_idr",
          "created_at",
        ].map((c) => `distribution_run_shortfalls.${c}`),
        ...[
          "tenant_id",
          "id",
          "distribution_run_id",
          "shortfall_id",
          "profit_entity_id",
          "shareholder_id",
          "amount_idr",
          "created_at",
        ].map((c) => `distribution_carry_deductions.${c}`),
        "distribution_runs.carry_deducted_idr",
        "distribution_lines.carry_deducted_idr",
      ].sort(),
    );
    for (const row of columns.rows) {
      expect(row.is_nullable, `${row.table_name}.${row.column_name}`).toBe(
        "NO",
      );
      if (row.column_name === "carry_deducted_idr")
        expect(row.column_default).toBe("0");
    }

    const constraints = await migrator.query(
      `SELECT conname FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conrelid IN ('distribution_run_shortfalls'::regclass,
                           'distribution_carry_deductions'::regclass,
                           'distribution_runs'::regclass,
                           'distribution_lines'::regclass)`,
    );
    const have = new Set(constraints.rows.map((r) => r.conname));
    for (const name of [
      "distribution_run_shortfalls_tenant_id_id_pk",
      "distribution_run_shortfalls_run_shareholder_key",
      "distribution_run_shortfalls_amount_check",
      "distribution_carry_deductions_tenant_id_id_pk",
      "distribution_carry_deductions_run_shortfall_key",
      "distribution_carry_deductions_amount_check",
      "distribution_runs_carry_check",
      "distribution_runs_totals_check",
      "distribution_lines_carry_check",
    ])
      expect(have.has(name), name).toBe(true);
  });

  it("forces tenant RLS on both new tables and keeps FORCE on the parents", async () => {
    const tables = await migrator.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT array_agg(p.polname::text ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relname IN ('distribution_run_shortfalls','distribution_carry_deductions',
                            'distribution_runs','distribution_lines','shareholders','profit_entities')`,
    );
    expect(tables.rows).toHaveLength(6);
    for (const row of tables.rows) {
      expect(row.relrowsecurity, `${row.relname} RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} FORCE`).toBe(true);
      expect(row.policies, `${row.relname} policies`).toEqual([
        "tenant_access",
        "tenant_isolation",
      ]);
    }
    const privileges = await migrator.query(
      `SELECT t.table_name,
              has_table_privilege('legend_app', 'public.' || t.table_name, 'SELECT') AS can_select,
              has_table_privilege('legend_app', 'public.' || t.table_name, 'INSERT') AS can_insert,
              has_table_privilege('legend_app', 'public.' || t.table_name, 'UPDATE') AS can_update,
              has_table_privilege('legend_app', 'public.' || t.table_name, 'DELETE') AS can_delete,
              has_table_privilege('legend_app', 'public.' || t.table_name, 'TRUNCATE') AS can_truncate
         FROM (VALUES ('distribution_run_shortfalls'), ('distribution_carry_deductions')) AS t(table_name)`,
    );
    for (const row of privileges.rows)
      expect(row, row.table_name).toMatchObject({
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
        can_truncate: false,
      });
  });

  it("seeds a closed period, approved shares and an approved regular run", async () => {
    await migrator.query(
      `INSERT INTO tenants (id, slug, name, plan, deployment_mode, limits, created_by)
       VALUES ($1, $2, 'Tenant A', 'starter', 'shared', '{}'::jsonb, $3),
              ($4, $5, 'Tenant B', 'starter', 'shared', '{}'::jsonb, $3)`,
      [
        tenantA,
        `carry-a-${hex(4)}`,
        randomUUID(),
        tenantB,
        `carry-b-${hex(4)}`,
      ],
    );
    legalEntity = randomUUID();
    await migrator.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
      [legalEntity, tenantA],
    );
    for (const period of ["2025-01", "2025-02", "2025-03"]) {
      const { rows } = await migrator.query<{ id: string }>(
        `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
         VALUES ($1, $2, $3, 'closed', 'closer', now()) RETURNING id`,
        [tenantA, legalEntity, period],
      );
      periods[period] = rows[0]!.id;
    }
    await migrator.query(
      `INSERT INTO profit_entities
         (tenant_id, id, name, type, legal_entity_id, reserve_bp, frequency, tax_withholding_bp, created_by)
       VALUES ($1, $2, 'Entitas Uji', 'legal_entity', $3, 1000, 'monthly', 0, 'creator')`,
      [tenantA, entityId, legalEntity],
    );
    for (const [id, name] of [
      [holder1, "Andi"],
      [holder2, "Budi"],
    ])
      await migrator.query(
        `INSERT INTO shareholders (tenant_id, id, name, type, created_by)
         VALUES ($1, $2, $3, 'person', 'creator')`,
        [tenantA, id, name],
      );
    await migrator.query(
      `INSERT INTO share_allocation_versions
         (tenant_id, profit_entity_id, version, effective_from, status, requested_by, idempotency_key)
       VALUES ($1, $2, 1, '2020-01-01', 'draft', 'requester', $3)`,
      [tenantA, entityId, `ver-${randomUUID()}`],
    );
    for (const [position, [holder, bp]] of [
      [holder1, 6000],
      [holder2, 4000],
    ].entries())
      await migrator.query(
        `INSERT INTO share_allocations
           (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [tenantA, entityId, holder, bp, position],
      );
    await migrator.query(
      `UPDATE share_allocation_versions SET status = 'pending_approval'
        WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = 1`,
      [tenantA, entityId],
    );
    await migrator.query(
      `UPDATE share_allocation_versions
          SET status = 'approved', decided_by = 'approver', decided_at = now()
        WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = 1`,
      [tenantA, entityId],
    );

    await insertRun(
      {
        id: regularRunId,
        type: "regular",
        period: "2025-01",
        periodId: periods["2025-01"]!,
        distributable: 900,
        gross: 900,
        carry: 0,
        idempotency: `run-${randomUUID()}`,
      },
      [
        { shareholderId: holder1, bp: 6000, gross: 540, carry: 0 },
        { shareholderId: holder2, bp: 4000, gross: 360, carry: 0 },
      ],
    );
    await approve(regularRunId);
    // Claw-back with 40 rupiah nobody could absorb (Q83).
    await insertRun(
      {
        id: adjustmentRunId,
        type: "adjustment",
        period: "2025-01",
        periodId: periods["2025-01"]!,
        distributable: -100,
        gross: -100,
        carry: 0,
        unabsorbed: 40,
        adjustsRunId: regularRunId,
        idempotency: `run-${randomUUID()}`,
        shortfalls: [
          { id: shortfall1, shareholderId: holder1, amount: 25 },
          { id: shortfall2, shareholderId: holder2, amount: 15 },
        ],
      },
      [{ shareholderId: holder1, bp: 6000, gross: -100, carry: 0 }],
    );
    await approve(adjustmentRunId);

    // The run that deducts the carry: distributable 900 = gross 860 + carry 40.
    await expect(
      insertRun(
        {
          id: carryRunId,
          type: "regular",
          period: "2025-02",
          periodId: periods["2025-02"]!,
          distributable: 900,
          gross: 860,
          carry: 40,
          idempotency: `run-${randomUUID()}`,
          deductions: [
            { shortfallId: shortfall1, shareholderId: holder1, amount: 25 },
            { shortfallId: shortfall2, shareholderId: holder2, amount: 15 },
          ],
        },
        [
          { shareholderId: holder1, bp: 6000, gross: 515, carry: 25 },
          { shareholderId: holder2, bp: 4000, gross: 345, carry: 15 },
        ],
      ),
    ).resolves.toBeUndefined();
    const stored = await migrator.query(
      `SELECT carry_deducted_idr::text AS carry FROM distribution_runs
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA, carryRunId],
    );
    expect(stored.rows[0].carry).toBe("40");
  });

  it("rejects run and line amounts that break the carry rules", async () => {
    // Failing CHECK constraint name, or "ok". Rows are inserted as drafts: an
    // approved run is frozen by its guard trigger before any CHECK is reached.
    const constraintOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return "ok";
      } catch (error) {
        const e = error as { code?: string; constraint?: string };
        return `${e.code}:${e.constraint ?? ""}`;
      }
    };
    const draft = (
      overrides: Partial<Parameters<typeof insertRun>[0]>,
      lines = [{ shareholderId: holder1, bp: 10000, gross: 900, carry: 0 }],
    ) =>
      insertRun(
        {
          id: randomUUID(),
          type: "regular",
          period: "2025-03",
          periodId: periods["2025-03"]!,
          distributable: 900,
          gross: 900,
          carry: 0,
          idempotency: `run-${randomUUID()}`,
          ...overrides,
        },
        lines,
      );
    // Regular: distributable = total_gross + carry; the old rule is gone.
    expect(await constraintOf(draft({ gross: 900, carry: 100 }))).toBe(
      "23514:distribution_runs_totals_check",
    );
    expect(await constraintOf(draft({ gross: 800, carry: 50 }))).toBe(
      "23514:distribution_runs_totals_check",
    );
    // Never negative.
    expect(await constraintOf(draft({ gross: 901, carry: -1 }))).toBe(
      "23514:distribution_runs_carry_check",
    );
    // A negative adjustment carries no deduction (a positive one may).
    expect(
      await constraintOf(
        draft(
          {
            type: "adjustment",
            adjustsRunId: regularRunId,
            period: "2025-01",
            periodId: periods["2025-01"]!,
            distributable: -105,
            gross: -110,
            carry: 5,
          },
          [{ shareholderId: holder1, bp: 6000, gross: -110, carry: 0 }],
        ),
      ),
    ).toBe("23514:distribution_runs_carry_check");
    // A line never carries a negative deduction.
    expect(
      await constraintOf(
        draft({}, [
          { shareholderId: holder1, bp: 10000, gross: 900, carry: -1 },
        ]),
      ),
    ).toBe("23514:distribution_lines_carry_check");
    // Control: a consistent run with a deduction is accepted.
    const room = await approvedShortfall(100);
    expect(
      await constraintOf(
        carryDraft(100, [
          { shortfallId: room, shareholderId: holder1, amount: 100 },
        ]),
      ),
    ).toBe("ok");
  });

  it("holds one shortfall per shareholder and run, with positive amounts", async () => {
    // Sum of the rows equals distribution_runs.unabsorbed_idr (40).
    const total = await migrator.query(
      `SELECT sum(amount_idr)::text AS total FROM distribution_run_shortfalls
        WHERE tenant_id = $1 AND distribution_run_id = $2`,
      [tenantA, adjustmentRunId],
    );
    expect(total.rows[0].total).toBe("40");

    // Rows are tried on a draft adjustment, inside a rolled-back transaction.
    const draftId = await draftAdjustment();
    const attempt = async (
      shareholderId: string,
      amount: number,
      { runId = draftId, tenantId = tenantA, twice = false } = {},
    ) =>
      (
        await inRolledBack(async (client) => {
          for (let attempt = 0; attempt < (twice ? 2 : 1); attempt++)
            await client.query(
              `INSERT INTO distribution_run_shortfalls
                 (tenant_id, distribution_run_id, profit_entity_id, shareholder_id, amount_idr)
               VALUES ($1, $2, $3, $4, $5)`,
              [tenantId, runId, entityId, shareholderId, amount],
            );
        })
      ).state;
    expect(await attempt(holder1, 1, { twice: true })).toBe("23505");
    expect(await attempt(holder1, 0)).toBe("23514");
    expect(await attempt(holder2, -5)).toBe("23514");
    // A shortfall points at a real run and shareholder of the same tenant.
    expect(await attempt(randomUUID(), 5)).toBe("23503");
    expect(await attempt(holder1, 5, { runId: randomUUID() })).toBe("23503");
    expect(
      await attempt(holder1, 5, { runId: adjustmentRunId, tenantId: tenantB }),
    ).toBe("23503");
  });

  it("holds one deduction per run and shortfall, positive, charged to the same shareholder", async () => {
    const stored = await migrator.query(
      `SELECT sum(amount_idr)::text AS total FROM distribution_carry_deductions
        WHERE tenant_id = $1 AND distribution_run_id = $2`,
      [tenantA, carryRunId],
    );
    expect(stored.rows[0].total).toBe("40");
    // Tried on the draft carry run, in rolled-back transactions.
    const state = async (
      shortfallId: string,
      shareholderId: string,
      amount: number,
      runId = carryRunId,
    ) =>
      (
        await inRolledBack(() =>
          insertDeduction(shortfallId, shareholderId, amount, runId),
        )
      ).state;
    // shortfall1 is already deducted on this run.
    expect(await state(shortfall1, holder1, 1)).toBe("23505");
    const spare = await approvedShortfall(5);
    expect(await state(spare, holder1, 0)).toBe("23514");
    expect(await state(spare, holder1, -3)).toBe("23514");
    // A shortfall of holder1 can never be charged to holder2.
    expect(await state(spare, holder2, 5)).toBe("23503");
    // Unknown shortfall and unknown run.
    expect(await state(randomUUID(), holder1, 5)).toBe("23503");
    expect(await state(spare, holder1, 5, randomUUID())).toBe("23503");
  });

  it("guard: a shortfall is written only for a draft adjustment run", async () => {
    // A regular run, even a draft one, cannot hold a shortfall.
    const regularDraft = randomUUID();
    await carryDraft(0, [], regularDraft);
    const onRegular = await inRolledBack(() =>
      insertShortfall(randomUUID(), holder2, 5, regularDraft),
    );
    expect(onRegular.state).toBe("23514");
    expect(onRegular.message).toMatch(/SH-CARRY/);
    // An approved adjustment is frozen: no row can be added afterwards.
    const onApproved = await inRolledBack(() =>
      insertShortfall(randomUUID(), holder1, 5, adjustmentRunId),
    );
    expect(onApproved.state).toBe("23514");
    expect(onApproved.message).toMatch(/SH-CARRY/);
    // A pending adjustment is frozen too.
    const pendingId = await draftAdjustment();
    await migrator.query(
      `UPDATE distribution_runs SET status = 'pending_approval'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA, pendingId],
    );
    const onPending = await inRolledBack(() =>
      insertShortfall(randomUUID(), holder1, 5, pendingId),
    );
    expect(onPending.state).toBe("23514");
    expect(onPending.message).toMatch(/SH-CARRY/);
  });

  it("guard: the shortfall rows of an adjustment add up to its unabsorbed_idr at commit", async () => {
    const insertAdjustment = (
      client: PoolClient,
      id: string,
      unabsorbed: number,
    ) =>
      client
        .query(
          `INSERT INTO distribution_runs
           (tenant_id, id, profit_entity_id, fiscal_period_id, fiscal_period_version, period,
            type, basis, status, share_version, period_net_profit_idr, reserve_idr,
            distributable_idr, total_gross_idr, total_tax_withheld_idr, total_net_idr,
            unabsorbed_idr, carry_deducted_idr, tax_withholding_bp, requested_by,
            adjusts_run_id, adjustment_reason, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, '2025-01', 'adjustment', 'approved_run_adjustment', 'draft', 1,
                 NULL, 0, -10, -10, 0, -10, $5, 0, 0, 'requester', $6, 'koreksi uji', $7)`,
          [
            tenantA,
            id,
            entityId,
            periods["2025-01"],
            unabsorbed,
            regularRunId,
            `run-${randomUUID()}`,
          ],
        )
        .then(() =>
          client.query(
            `INSERT INTO distribution_lines
             (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr,
              tax_withheld_idr, net_idr, carry_deducted_idr, position)
           VALUES ($1, $2, $3, 6000, -10, 0, -10, 0, 0)`,
            [tenantA, id, holder1],
          ),
        );
    // Too few: 30 of 40 unabsorbed rupiah kept.
    const short = await committed(async (client) => {
      const id = randomUUID();
      await insertAdjustment(client, id, 40);
      await client.query(
        `INSERT INTO distribution_run_shortfalls
           (tenant_id, distribution_run_id, profit_entity_id, shareholder_id, amount_idr)
         VALUES ($1, $2, $3, $4, 30)`,
        [tenantA, id, entityId, holder1],
      );
    });
    expect(short.state).toBe("23514");
    expect(short.message).toMatch(/SH-CARRY/);
    // Unabsorbed rupiah with no shortfall row at all.
    const none = await committed(async (client) => {
      await insertAdjustment(client, randomUUID(), 40);
    });
    expect(none.state).toBe("23514");
    // Shortfall rows although nothing is unabsorbed.
    const extra = await committed(async (client) => {
      const id = randomUUID();
      await insertAdjustment(client, id, 0);
      await client.query(
        `INSERT INTO distribution_run_shortfalls
           (tenant_id, distribution_run_id, profit_entity_id, shareholder_id, amount_idr)
         VALUES ($1, $2, $3, $4, 5)`,
        [tenantA, id, entityId, holder1],
      );
    });
    expect(extra.state).toBe("23514");
    // Control: rows that add up are accepted.
    const exact = await committed(async (client) => {
      const id = randomUUID();
      await insertAdjustment(client, id, 40);
      for (const [holder, amount] of [
        [holder1, 25],
        [holder2, 15],
      ] as const)
        await client.query(
          `INSERT INTO distribution_run_shortfalls
             (tenant_id, distribution_run_id, profit_entity_id, shareholder_id, amount_idr)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantA, id, entityId, holder, amount],
        );
    });
    expect(exact.state).toBe("ok");
  });

  it("guard: a deduction is written only for a draft regular run", async () => {
    const room = await approvedShortfall(50);
    // An approved regular run is frozen.
    const onApproved = await inRolledBack(() =>
      insertDeduction(room, holder1, 5, regularRunId),
    );
    expect(onApproved.state).toBe("23514");
    expect(onApproved.message).toMatch(/SH-CARRY/);
    // A negative adjustment run never deducts (a positive one may: see the
    // "zero line" test).
    const draftId = await draftAdjustment();
    const onAdjustment = await inRolledBack(() =>
      insertDeduction(room, holder1, 5, draftId),
    );
    expect(onAdjustment.state).toBe("23514");
    expect(onAdjustment.message).toMatch(/SH-CARRY/);
    // A pending regular run is frozen.
    const pendingId = randomUUID();
    await carryDraft(0, [], pendingId);
    await migrator.query(
      `UPDATE distribution_runs SET status = 'pending_approval'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA, pendingId],
    );
    const onPending = await inRolledBack(() =>
      insertDeduction(room, holder1, 5, pendingId),
    );
    expect(onPending.state).toBe("23514");
    expect(onPending.message).toMatch(/SH-CARRY/);
  });

  it("guard: a deduction needs the same entity and an approved or paid correction", async () => {
    const draftRegular = randomUUID();
    await carryDraft(0, [], draftRegular);
    // Entity of the deduction differs from the shortfall's.
    const room = await approvedShortfall(50);
    const otherEntity = await inRolledBack(() =>
      insertDeduction(room, holder1, 5, draftRegular, randomUUID()),
    );
    expect(otherEntity.state).toBe("23514");
    expect(otherEntity.message).toMatch(/SH-CARRY/);
    // The shortfall's adjustment is still a draft: nothing is owed yet.
    const stillDraft = await inRolledBack(async (client) => {
      const shortfallId = randomUUID();
      const adjustmentId = await draftAdjustment();
      await client.query(
        `INSERT INTO distribution_run_shortfalls
           (tenant_id, id, distribution_run_id, profit_entity_id, shareholder_id, amount_idr)
         VALUES ($1, $2, $3, $4, $5, 5)`,
        [tenantA, shortfallId, adjustmentId, entityId, holder1],
      );
      await client.query(
        `INSERT INTO distribution_carry_deductions
           (tenant_id, distribution_run_id, shortfall_id, profit_entity_id, shareholder_id, amount_idr)
         VALUES ($1, $2, $3, $4, $5, 5)`,
        [tenantA, draftRegular, shortfallId, entityId, holder1],
      );
    });
    expect(stillDraft.state).toBe("23514");
    expect(stillDraft.message).toMatch(/SH-CARRY/);
  });

  it("guard: the deductions of a run add up to its carry_deducted_idr at commit", async () => {
    const room = await approvedShortfall(100);
    // carry 100 but only 60 deducted.
    const under = await carryDraft(100, [
      { shortfallId: room, shareholderId: holder1, amount: 60 },
    ]).then(
      () => ({ state: "ok", message: "" }),
      (error: { code?: string; message?: string }) => ({
        state: error.code ?? "no-code",
        message: error.message ?? "",
      }),
    );
    expect(under.state).toBe("23514");
    expect(under.message).toMatch(/SH-CARRY/);
    // carry 100 but nothing deducted.
    expect(await sqlState(carryDraft(100, []))).toBe("23514");
    // deductions although carry is 0.
    expect(
      await sqlState(
        carryDraft(0, [
          { shortfallId: room, shareholderId: holder1, amount: 5 },
        ]),
      ),
    ).toBe("23514");
    // Control: the exact amount is accepted.
    expect(
      await sqlState(
        carryDraft(100, [
          { shortfallId: room, shareholderId: holder1, amount: 100 },
        ]),
      ),
    ).toBe("ok");
  });

  it("guard: live deductions of a shortfall never exceed it, a cancelled run releases its share", async () => {
    const room = await approvedShortfall(100);
    const first = randomUUID();
    expect(
      await sqlState(
        carryDraft(
          70,
          [{ shortfallId: room, shareholderId: holder1, amount: 70 }],
          first,
        ),
      ),
    ).toBe("ok");
    // 70 + 40 > 100.
    expect(
      await sqlState(
        carryDraft(40, [
          { shortfallId: room, shareholderId: holder1, amount: 40 },
        ]),
      ),
    ).toBe("23514");
    // The rest, 30, still fits.
    expect(
      await sqlState(
        carryDraft(30, [
          { shortfallId: room, shareholderId: holder1, amount: 30 },
        ]),
      ),
    ).toBe("ok");
    // A rejected (cancelled) run gives its 70 back.
    await migrator.query(
      `UPDATE distribution_runs
          SET status = 'cancelled', cancelled_by = 'approver', cancelled_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA, first],
    );
    expect(
      await sqlState(
        carryDraft(70, [
          { shortfallId: room, shareholderId: holder1, amount: 70 },
        ]),
      ),
    ).toBe("ok");
  });

  /** Failing CHECK/trigger of a write that is committed, or "ok". */
  const outcome = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      const e = error as { code?: string; constraint?: string };
      return `${e.code}:${e.constraint ?? ""}`;
    }
  };

  it("zero line: a share fully absorbed by carry keeps a 0 gross line, only with a deduction", async () => {
    const room = await approvedShortfall(540);
    const regular = async (
      lines: { gross: number; carry: number; bp?: number }[],
      carry: number,
      deductions: { shortfallId: string; amount: number }[],
    ) =>
      insertRun(
        {
          id: randomUUID(),
          type: "regular",
          ...(await freshPeriod()),
          distributable: 900,
          gross: 900 - carry,
          carry,
          idempotency: `run-${randomUUID()}`,
          deductions: deductions.map((row) => ({
            ...row,
            shareholderId: holder1,
          })),
        },
        [
          {
            shareholderId: holder1,
            bp: lines[0]!.bp ?? 6000,
            gross: lines[0]!.gross,
            carry: lines[0]!.carry,
          },
          {
            shareholderId: holder2,
            bp: 4000,
            gross: lines[1]!.gross,
            carry: lines[1]!.carry,
          },
        ],
      );
    // Holder1's whole share (540) is absorbed: gross 0, carry 540.
    expect(
      await outcome(
        regular(
          [
            { gross: 0, carry: 540 },
            { gross: 360, carry: 0 },
          ],
          540,
          [{ shortfallId: room, amount: 540 }],
        ),
      ),
    ).toBe("ok");
    // A zero line without a deduction on the line stays illegal.
    expect(
      await outcome(
        regular(
          [
            { gross: 0, carry: 0 },
            { gross: 540, carry: 0 },
          ],
          360,
          [],
        ),
      ),
    ).toBe("23514:distribution_lines_amounts_check");
    // A deduction is only taken from a share that exists: no negative gross.
    expect(
      await outcome(
        regular(
          [
            { gross: -5, carry: 5 },
            { gross: 360, carry: 0 },
          ],
          5,
          [],
        ),
      ),
    ).toBe("23514:distribution_lines_carry_check");
    // Every regular line is written now: a missing shareholder (bp < 10000) fails at commit.
    const missing = await committed(async (client) => {
      const runId = randomUUID();
      const { periodId, period } = await freshPeriod();
      await client.query(
        `INSERT INTO distribution_runs
           (tenant_id, id, profit_entity_id, fiscal_period_id, fiscal_period_version, period,
            type, basis, status, share_version, period_net_profit_idr, reserve_idr,
            distributable_idr, total_gross_idr, total_tax_withheld_idr, total_net_idr,
            unabsorbed_idr, carry_deducted_idr, tax_withholding_bp, requested_by, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, $5, 'regular', 'closed_period_net_profit', 'draft', 1, 1000, 100,
                 900, 360, 0, 360, 0, 540, 0, 'requester', $6)`,
        [tenantA, runId, entityId, periodId, period, `run-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO distribution_lines
           (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr,
            tax_withheld_idr, net_idr, carry_deducted_idr, position)
         VALUES ($1, $2, $3, 4000, 360, 0, 360, 540, 0)`,
        [tenantA, runId, holder2],
      );
      await client.query(
        `INSERT INTO distribution_carry_deductions
           (tenant_id, distribution_run_id, shortfall_id, profit_entity_id, shareholder_id, amount_idr)
         VALUES ($1, $2, $3, $4, $5, 540)`,
        [tenantA, runId, room, entityId, holder1],
      );
    });
    expect(missing.state).toBe("23514");
    expect(missing.message).toMatch(/SH-04/);
  });

  it("a positive adjustment may carry a deduction, a negative one may not", async () => {
    const room = await approvedShortfall(50);
    const topUp = (
      lines: { gross: number; carry: number }[],
      distributable: number,
      carry: number,
      deductions: { shortfallId: string; amount: number }[],
    ) =>
      insertRun(
        {
          id: randomUUID(),
          type: "adjustment",
          period: "2025-01",
          periodId: periods["2025-01"]!,
          distributable,
          gross: distributable - carry,
          carry,
          adjustsRunId: regularRunId,
          idempotency: `run-${randomUUID()}`,
          deductions: deductions.map((row) => ({
            ...row,
            shareholderId: holder1,
          })),
        },
        [
          { shareholderId: holder1, bp: 6000, ...lines[0]! },
          { shareholderId: holder2, bp: 4000, ...lines[1]! },
        ],
      );
    // Top-up 100: holder1's 60 is cut by 50 of carry, holder2 gets 40.
    expect(
      await outcome(
        topUp(
          [
            { gross: 10, carry: 50 },
            { gross: 40, carry: 0 },
          ],
          100,
          50,
          [{ shortfallId: room, amount: 50 }],
        ),
      ),
    ).toBe("ok");
    // A negative adjustment still carries nothing.
    expect(
      await outcome(
        topUp(
          [
            { gross: -60, carry: 0 },
            { gross: -40, carry: 0 },
          ],
          -95,
          5,
          [],
        ),
      ),
    ).toBe("23514:distribution_runs_carry_check");
    // Its deductions come from a shortfall of an approved correction, and are
    // drafted only: a draft top-up accepts one, a decided one is frozen.
    const decided = randomUUID();
    await insertRun(
      {
        id: decided,
        type: "adjustment",
        period: "2025-01",
        periodId: periods["2025-01"]!,
        distributable: 100,
        gross: 100,
        carry: 0,
        adjustsRunId: regularRunId,
        idempotency: `run-${randomUUID()}`,
      },
      [
        { shareholderId: holder1, bp: 6000, gross: 60, carry: 0 },
        { shareholderId: holder2, bp: 4000, gross: 40, carry: 0 },
      ],
    );
    await approve(decided);
    const frozen = await inRolledBack(() =>
      insertDeduction(room, holder1, 5, decided),
    );
    expect(frozen.state).toBe("23514");
    expect(frozen.message).toMatch(/SH-CARRY/);
  });

  it("a run whose every line is zero is paid on approval without a journal, a real gross still needs one", async () => {
    const roomA = await approvedShortfall(540, holder1);
    const roomB = await approvedShortfall(360, holder2);
    const zeroRun = randomUUID();
    await insertRun(
      {
        id: zeroRun,
        type: "regular",
        ...(await freshPeriod()),
        distributable: 900,
        gross: 0,
        carry: 900,
        idempotency: `run-${randomUUID()}`,
        deductions: [
          { shortfallId: roomA, shareholderId: holder1, amount: 540 },
          { shortfallId: roomB, shareholderId: holder2, amount: 360 },
        ],
      },
      [
        { shareholderId: holder1, bp: 6000, gross: 0, carry: 540 },
        { shareholderId: holder2, bp: 4000, gross: 0, carry: 360 },
      ],
    );
    await approve(zeroRun);
    await migrator.query(
      `UPDATE distribution_lines
          SET payment_status = 'paid', payment_ref = 'POTONG-KEKURANGAN',
              paid_at = now(), paid_by = 'approver'
        WHERE tenant_id = $1 AND distribution_run_id = $2`,
      [tenantA, zeroRun],
    );
    await migrator.query(
      `UPDATE distribution_runs SET status = 'paid', paid_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA, zeroRun],
    );
    const stored = await migrator.query(
      `SELECT status, journal_entry_id, reversal_journal_entry_id
         FROM distribution_runs WHERE tenant_id = $1 AND id = $2`,
      [tenantA, zeroRun],
    );
    expect(stored.rows[0]).toEqual({
      status: "paid",
      journal_entry_id: null,
      reversal_journal_entry_id: null,
    });

    // A run with a real gross still needs its journal to be paid.
    const real = randomUUID();
    await carryDraft(0, [], real);
    await approve(real);
    const paidWithoutJournal = await inRolledBack(async (client) => {
      await client.query(
        `UPDATE distribution_lines
            SET payment_status = 'paid', payment_ref = 'REF', paid_at = now(), paid_by = 'approver'
          WHERE tenant_id = $1 AND distribution_run_id = $2`,
        [tenantA, real],
      );
      await client.query(
        `UPDATE distribution_runs SET status = 'paid', paid_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantA, real],
      );
    });
    expect(paidWithoutJournal.state).toBe("23514");
    expect(paidWithoutJournal.message).toMatch(
      /distribution_runs_journal_check/,
    );
  });

  it("guard: a regular run's lines carry exactly its carry_deducted_idr", async () => {
    const room = await approvedShortfall(100);
    // Run carry 100 and 100 deducted, but the lines only carry 60.
    const short = await committed(async (client) => {
      const runId = randomUUID();
      const { periodId, period } = await freshPeriod();
      await client.query(
        `INSERT INTO distribution_runs
           (tenant_id, id, profit_entity_id, fiscal_period_id, fiscal_period_version, period,
            type, basis, status, share_version, period_net_profit_idr, reserve_idr,
            distributable_idr, total_gross_idr, total_tax_withheld_idr, total_net_idr,
            unabsorbed_idr, carry_deducted_idr, tax_withholding_bp, requested_by, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, $5, 'regular', 'closed_period_net_profit', 'draft', 1, 1000, 100,
                 900, 800, 0, 800, 0, 100, 0, 'requester', $6)`,
        [tenantA, runId, entityId, periodId, period, `run-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO distribution_lines
           (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr,
            tax_withheld_idr, net_idr, carry_deducted_idr, position)
         VALUES ($1, $2, $3, 10000, 800, 0, 800, 60, 0)`,
        [tenantA, runId, holder1],
      );
      await client.query(
        `INSERT INTO distribution_carry_deductions
           (tenant_id, distribution_run_id, shortfall_id, profit_entity_id, shareholder_id, amount_idr)
         VALUES ($1, $2, $3, $4, $5, 100)`,
        [tenantA, runId, room, entityId, holder1],
      );
    });
    expect(short.state).toBe("23514");
    expect(short.message).toMatch(/SH-04/);
  });

  it("keeps tenant isolation for the app login on both new tables", async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      for (const table of [
        "distribution_run_shortfalls",
        "distribution_carry_deductions",
      ])
        await expect(client.query(`SELECT 1 FROM ${table}`)).rejects.toThrow(
          /tenant context is required/,
        );

      await client.query("SELECT set_config('app.tenant_id', $1, false)", [
        tenantB,
      ]);
      for (const table of [
        "distribution_run_shortfalls",
        "distribution_carry_deductions",
      ]) {
        const other = await client.query(`SELECT 1 FROM ${table}`);
        expect(other.rowCount, `${table} as tenant B`).toBe(0);
      }
      // Writing a tenant A row while in tenant B context is refused by RLS.
      expect(
        await sqlState(
          client.query(
            `INSERT INTO distribution_run_shortfalls
               (tenant_id, distribution_run_id, profit_entity_id, shareholder_id, amount_idr)
             VALUES ($1, $2, $3, $4, 1)`,
            [tenantA, adjustmentRunId, entityId, holder2],
          ),
        ),
      ).toBe("42501");

      await client.query("SELECT set_config('app.tenant_id', $1, false)", [
        tenantA,
      ]);
      const shortfalls = await client.query(
        "SELECT tenant_id FROM distribution_run_shortfalls",
      );
      const expected = await migrator.query(
        `SELECT (SELECT count(*) FROM distribution_run_shortfalls WHERE tenant_id = $1)::int AS shortfalls,
                (SELECT count(*) FROM distribution_carry_deductions WHERE tenant_id = $1)::int AS deductions`,
        [tenantA],
      );
      expect(shortfalls.rowCount).toBe(expected.rows[0].shortfalls);
      expect(shortfalls.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
      const deductions = await client.query(
        "SELECT tenant_id FROM distribution_carry_deductions",
      );
      expect(deductions.rowCount).toBe(expected.rows[0].deductions);
      // Append-only for the app login.
      expect(
        await sqlState(client.query("DELETE FROM distribution_run_shortfalls")),
      ).toBe("42501");
      expect(
        await sqlState(
          client.query(
            "UPDATE distribution_carry_deductions SET amount_idr = 1",
          ),
        ),
      ).toBe("42501");
    } finally {
      await client.end();
    }
  }, 60_000);
});
