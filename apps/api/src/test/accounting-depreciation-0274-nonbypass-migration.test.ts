import {
  dropTestDatabase,
  endTestPool,
  waitForNoTestDatabaseSessions as waitForNoSessions,
} from "./helpers/database-cleanup.ts";
// Bead legend-2pt9d: migrations 0274-0275 run by a migrator that is a plain
// table owner (NOSUPERUSER, NOBYPASSRLS) over a database that already holds
// depreciation reversals and corrections from 0269-0272.
//
// 0274 lifts FORCE ROW LEVEL SECURITY around its backfill (a plain owner would
// otherwise hit 42501 from app.require_tenant_id), so the tests prove:
//   - it succeeds as that owner and puts FORCE back on every table it touched;
//   - the backfill copies what the legacy rows took back, per correcting journal;
//   - legacy data that already breaks the claim rule (a journal that took back
//     more than it debits, or one that is both claimed and reversed by hand) is
//     rejected loudly, the whole migration rolls back (FORCE RLS included), and
//     the migration passes once the data is repaired. It is never copied silently.
//
// The scratch databases live on the disposable test server. One template is
// built through 0273 as a BYPASSRLS owner (older migrations need it), the role
// then loses BYPASSRLS, and every scenario clones the template.
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migration-session";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const drizzleDir = join(apiRoot, "drizzle");
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const suffix = randomBytes(6).toString("hex");
const ownerRole = `dep0274_owner_${suffix}`;
const ownerPassword = randomBytes(16).toString("hex");
const templateDb = `dep0274_tpl_${suffix}`;
const migrationOptions = { lockTimeout: "10s", statementTimeout: "0" };

function urlFor(db: string, user?: string, password?: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${db}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

// Refuse to create databases on anything but the disposable test server.
function assertDisposableServer() {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
}

type Journal = { entries: { idx: number; when: number; tag: string }[] };

// A copy of drizzle/ holding every migration before 0274 (journal cut there).
function copyFolderBefore0274(workDir: string): string {
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const cut = journal.entries.findIndex((entry) =>
    entry.tag.startsWith("0274_"),
  );
  expect(cut).toBeGreaterThan(0);
  const kept = journal.entries.slice(0, cut);
  const keptTags = new Set(kept.map((entry) => entry.tag));
  const folder = join(workDir, "drizzle-before-0274");
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const file of readdirSync(drizzleDir))
    if (file.endsWith(".sql") && keptTags.has(file.replace(/\.sql$/, "")))
      cpSync(join(drizzleDir, file), join(folder, file));
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return folder;
}

// The PostgreSQL error itself. Drizzle wraps it in an error whose message
// holds the whole failed statement (including every error code the migration
// mentions), so assertions must read the innermost error, never the wrapper.
function pgFailure(error: unknown): { code: string; message: string } {
  let current: unknown = error;
  let found: { code: string; message: string } | null = null;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown };
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    )
      found = { code: candidate.code, message: String(candidate.message) };
    current = (current as { cause?: unknown }).cause;
  }
  if (!found) throw new Error(`no PostgreSQL error in: ${String(error)}`);
  return found;
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const tenantA = uuid(1);
const tenantB = uuid(2);
const entity = uuid(901);
const period = uuid(902);
const accountDebit = uuid(903);
const accountCredit = uuid(904);

// Legacy rows are written by the superuser with session_replication_role =
// replica: foreign keys and triggers (including the 0271 total check) are
// skipped, which is exactly how a row written before the guards would look.
type Seeder = {
  correctionJournal: (
    tenant: string,
    id: string,
    asset: string,
    debit: number,
    reversalOf?: string,
    sourceType?: string,
  ) => Promise<void>;
  reversal: (
    tenant: string,
    depreciationId: string,
    amount: number,
    asset: string,
    correctionId: string,
  ) => Promise<void>;
};

function seeder(client: PoolClient): Seeder {
  let depSeq = 0;
  return {
    async correctionJournal(tenant, id, asset, debit, reversalOf, sourceType) {
      await client.query(
        `INSERT INTO journal_entries
           (tenant_id, id, legal_entity_id, entry_date, fiscal_period_id,
            source_type, source_id, description, idempotency_key,
            request_fingerprint, reversal_of)
         VALUES ($1, $2, $3, '2026-01-31', $4, $9, $5,
                 'legacy correction', $6, $7, $8)`,
        [
          tenant,
          id,
          entity,
          period,
          asset,
          `legacy-${id}`,
          "a".repeat(64),
          reversalOf ?? null,
          sourceType ?? (reversalOf ? "reversal" : "depreciation"),
        ],
      );
      if (debit > 0) {
        await client.query(
          `INSERT INTO journal_lines
             (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
           VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
          [tenant, id, accountDebit, accountCredit, debit],
        );
      }
    },
    async reversal(tenant, depreciationId, amount, asset, correctionId) {
      depSeq += 1;
      await client.query(
        `INSERT INTO fixed_asset_depreciations
           (tenant_id, id, fixed_asset_id, period, amount_idr, journal_entry_id,
            reversed_at)
         VALUES ($1, $2, $3, $6, $4, $5, now())`,
        [
          tenant,
          depreciationId,
          asset,
          amount,
          uuid(5000 + depSeq),
          // One row per asset month: the legacy rows sit in different months.
          `2026-${String(((depSeq - 1) % 12) + 1).padStart(2, "0")}`,
        ],
      );
      await client.query(
        `INSERT INTO fixed_asset_depreciation_reversals
           (tenant_id, id, depreciation_id, journal_entry_id, reason)
         VALUES ($1, $2, $3, $4, 'legacy correction')`,
        [tenant, uuid(6000 + depSeq), depreciationId, correctionId],
      );
    },
  };
}

const TOUCHED = [
  "journal_entries",
  "journal_lines",
  "fixed_asset_depreciations",
  "fixed_asset_depreciation_reversals",
];

describe("legend-2pt9d migrations 0274-0275 run by a NOBYPASSRLS table owner over legacy data", () => {
  let admin: Pool; // superuser, default database
  let workDir: string;
  const scenarioDbs: string[] = [];

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Names and the hex password are generated here: interpolation into DDL is
    // safe. Older migrations need BYPASSRLS for a non-superuser owner (foreign
    // keys onto force-RLS tables validate rows under the tenant policy), so the
    // role loses it only after the template is built.
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB`,
    );
    // legend_payout (drizzle/0410) is cluster-wide and already exists, created by
    // the bootstrap superuser; the migrator manages it through ADMIN OPTION only,
    // as provisionMigrator gives it in production (db/migrator-role.ts).
    await admin.query(
      `GRANT legend_payout TO ${ownerRole} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
    await admin.query(`CREATE DATABASE ${templateDb} OWNER ${ownerRole}`);
    workDir = mkdtempSync(join(tmpdir(), "legend-dep0274-"));
    const owner = new Pool({
      connectionString: urlFor(templateDb, ownerRole, ownerPassword),
      max: 1,
    });
    try {
      await runMigrations(
        owner,
        copyFolderBefore0274(workDir),
        migrationOptions,
      );
    } finally {
      await endTestPool(owner);
    }
    await waitForNoSessions(admin, templateDb);
    // ALTER ROLE applies to new sessions only; every scenario opens its own.
    await admin.query(`ALTER ROLE ${ownerRole} NOBYPASSRLS`);
  }, 300_000);

  afterAll(async () => {
    if (admin) {
      try {
        for (const db of [...scenarioDbs, templateDb]) {
          await dropTestDatabase(admin, db);
        }
        await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  async function scenario(
    seed: (seed: Seeder) => Promise<void>,
    body: (ctx: {
      owner: Pool;
      superuser: Pool;
      migrate: () => Promise<void>;
    }) => Promise<void>,
  ) {
    const db = `dep0274_s_${randomBytes(6).toString("hex")}`;
    scenarioDbs.push(db);
    await admin.query(
      `CREATE DATABASE ${db} TEMPLATE ${templateDb} OWNER ${ownerRole}`,
    );
    const superuser = new Pool({ connectionString: urlFor(db), max: 1 });
    const owner = new Pool({
      connectionString: urlFor(db, ownerRole, ownerPassword),
      max: 1,
    });
    try {
      const client = await superuser.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        // The claims table points at tenants; legacy rows always had tenants.
        for (const tenant of [tenantA, tenantB])
          await client.query(
            `INSERT INTO tenants
               (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
             VALUES ($1, $2, 'Legacy tenant', 'lengkap', 'active', 'shared',
                     '{"modules":[],"integrationProviders":[]}',
                     '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}',
                     $3)`,
            [tenant, `dep0274-${tenant}`, uuid(9999)],
          );
        await seed(seeder(client));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await body({
        owner,
        superuser,
        migrate: () => runMigrations(owner, drizzleDir, migrationOptions),
      });
    } finally {
      await endTestPool(owner);
      await endTestPool(superuser);
    }
  }

  async function forceFlags(pool: Pool, tables: string[]) {
    const { rows } = await pool.query<{
      relname: string;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1) ORDER BY 1`,
      [tables],
    );
    return Object.fromEntries(
      rows.map((row) => [row.relname, row.relforcerowsecurity]),
    );
  }

  const allForced = (tables: string[]) =>
    Object.fromEntries(tables.map((name) => [name, true]));

  async function functionExists(pool: Pool) {
    const { rows } = await pool.query(
      "SELECT to_regprocedure('app.claim_correction_journal(uuid,uuid,bigint,boolean)') IS NOT NULL AS present",
    );
    return rows[0].present as boolean;
  }

  async function relationExists(pool: Pool, name: string) {
    const { rows } = await pool.query(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [name],
    );
    return rows[0].present as boolean;
  }

  it("the migrator is a plain table owner that FORCE RLS applies to", async () => {
    const { rows } = await admin.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [ownerRole],
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await scenario(
      async () => undefined,
      async ({ owner, superuser }) => {
        expect(await forceFlags(superuser, TOUCHED)).toEqual(
          allForced(TOUCHED),
        );
        // The reason 0274 lifts FORCE: this owner cannot read a forced table.
        await expect(
          owner.query("SELECT 1 FROM public.journal_entries LIMIT 1"),
        ).rejects.toMatchObject({ code: "42501" });
      },
    );
  });

  it("backfills legacy reversals per correcting journal and restores FORCE RLS", async () => {
    const assetA = uuid(701);
    const assetB = uuid(702);
    await scenario(
      async (seed) => {
        // Tenant A: one correction taking back two rows, exactly what it debits.
        await seed.correctionJournal(tenantA, uuid(101), assetA, 200);
        await seed.reversal(tenantA, uuid(201), 100, assetA, uuid(101));
        await seed.reversal(tenantA, uuid(202), 100, assetA, uuid(101));
        // Tenant A: a second correction taking back less than it debits. That
        // is accepted: nobody is paid more, and a later claim up to the debit
        // total still works.
        await seed.correctionJournal(tenantA, uuid(102), assetB, 500);
        await seed.reversal(tenantA, uuid(203), 300, assetB, uuid(102));
        // Tenant B: the same journal shape, kept apart from tenant A.
        await seed.correctionJournal(tenantB, uuid(103), assetA, 100);
        await seed.reversal(tenantB, uuid(204), 100, assetA, uuid(103));
        // A correction nothing was linked to, with a manual reversal journal
        // (reversal_of -> correction): no claim row, nothing to repair.
        await seed.correctionJournal(tenantA, uuid(104), assetB, 50);
        await seed.correctionJournal(tenantA, uuid(105), assetB, 50, uuid(104));
      },
      async ({ owner, superuser, migrate }) => {
        await migrate();

        const claims = await superuser.query(
          `SELECT tenant_id, journal_entry_id, claimed_idr::text AS claimed, reversed
             FROM fixed_asset_correction_claims ORDER BY tenant_id, journal_entry_id`,
        );
        expect(claims.rows).toEqual([
          {
            tenant_id: tenantA,
            journal_entry_id: uuid(101),
            claimed: "200",
            reversed: false,
          },
          {
            tenant_id: tenantA,
            journal_entry_id: uuid(102),
            claimed: "300",
            reversed: false,
          },
          {
            tenant_id: tenantB,
            journal_entry_id: uuid(103),
            claimed: "100",
            reversed: false,
          },
        ]);

        const restored = [...TOUCHED, "fixed_asset_correction_claims"];
        expect(await forceFlags(superuser, restored)).toEqual(
          allForced(restored),
        );
        // 0274 functions and the 0275 trigger exist.
        const objects = await superuser.query(
          `SELECT
             to_regprocedure('app.claim_correction_journal(uuid,uuid,bigint,boolean)') IS NOT NULL AS claim_fn,
             EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'fixed_asset_depreciations_born_active') AS born_active`,
        );
        expect(objects.rows[0]).toEqual({ claim_fn: true, born_active: true });
        // The owner is still subject to the tenant policy after the migration.
        await expect(
          owner.query("SELECT 1 FROM public.journal_lines LIMIT 1"),
        ).rejects.toMatchObject({ code: "42501" });
      },
    );
  }, 180_000);

  // The migration refuses the data: a clear error naming the code and the
  // journal, and nothing is half applied (no claims table, FORCE RLS intact).
  async function expectRefused(
    ctx: { superuser: Pool; migrate: () => Promise<void> },
    code: string,
    journals: string[],
    notNamed: string[] = [],
  ) {
    const failure = await ctx.migrate().then(
      () => null,
      (error: unknown) => pgFailure(error),
    );
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("23514");
    const message = failure?.message ?? "";
    expect(message).toContain("migration 0274");
    expect(message).toContain(`(${code})`);
    for (const journal of journals) expect(message).toContain(journal);
    for (const journal of notNamed) expect(message).not.toContain(journal);
    expect(
      await relationExists(
        ctx.superuser,
        "public.fixed_asset_correction_claims",
      ),
    ).toBe(false);
    expect(await functionExists(ctx.superuser)).toBe(false);
    expect(await forceFlags(ctx.superuser, TOUCHED)).toEqual(
      allForced(TOUCHED),
    );
  }

  // The repair the error message describes: a superuser removes the reversal
  // row and makes the depreciation row active again.
  async function repair(
    superuser: Pool,
    reversalId: string,
    depreciationId: string,
  ) {
    await superuser.query(
      `DELETE FROM fixed_asset_depreciation_reversals WHERE id = $1`,
      [reversalId],
    );
    await superuser.query(
      `UPDATE fixed_asset_depreciations SET reversed_at = NULL WHERE id = $1`,
      [depreciationId],
    );
  }

  const claimsOf = (superuser: Pool) =>
    superuser
      .query(
        `SELECT tenant_id, journal_entry_id, claimed_idr::text AS claimed, reversed
           FROM fixed_asset_correction_claims ORDER BY tenant_id, journal_entry_id`,
      )
      .then((result) => result.rows);

  it("rejects a legacy journal that took back more than it debits, rolls back, and passes after repair", async () => {
    const asset = uuid(711);
    await scenario(
      async (seed) => {
        // The correction debits 100 but two rows of 100 were taken back through
        // it: a double claim. A clean journal of tenant B sits next to it.
        await seed.correctionJournal(tenantA, uuid(111), asset, 100);
        await seed.reversal(tenantA, uuid(211), 100, asset, uuid(111));
        await seed.reversal(tenantA, uuid(212), 100, asset, uuid(111));
        await seed.correctionJournal(tenantB, uuid(112), asset, 100);
        await seed.reversal(tenantB, uuid(213), 100, asset, uuid(112));
      },
      async (ctx) => {
        await expectRefused(
          ctx,
          "DEPRECIATION_REVERSAL_AMOUNT",
          [uuid(111), "took back 200, debits 100"],
          [uuid(112)],
        );
        await repair(ctx.superuser, uuid(6002), uuid(212));
        await ctx.migrate();
        expect(await claimsOf(ctx.superuser)).toEqual([
          {
            tenant_id: tenantA,
            journal_entry_id: uuid(111),
            claimed: "100",
            reversed: false,
          },
          {
            tenant_id: tenantB,
            journal_entry_id: uuid(112),
            claimed: "100",
            reversed: false,
          },
        ]);
        // The repaired depreciation row is active again.
        const row = await ctx.superuser.query(
          `SELECT reversed_at FROM fixed_asset_depreciations WHERE id = $1`,
          [uuid(212)],
        );
        expect(row.rows).toEqual([{ reversed_at: null }]);
      },
    );
  }, 180_000);

  it("rejects a claimed journal that has no lines at all (it debits nothing)", async () => {
    const asset = uuid(731);
    await scenario(
      async (seed) => {
        await seed.correctionJournal(tenantA, uuid(131), asset, 0);
        await seed.reversal(tenantA, uuid(231), 100, asset, uuid(131));
      },
      async (ctx) => {
        await expectRefused(ctx, "DEPRECIATION_REVERSAL_AMOUNT", [
          uuid(131),
          "took back 100, debits 0",
        ]);
      },
    );
  }, 180_000);

  it("rejects a legacy journal that is both taken back and reversed by hand, and passes after repair", async () => {
    const asset = uuid(721);
    await scenario(
      async (seed) => {
        await seed.correctionJournal(tenantA, uuid(121), asset, 100);
        await seed.reversal(tenantA, uuid(221), 100, asset, uuid(121));
        // A manual reversal journal of the same correction.
        await seed.correctionJournal(tenantA, uuid(122), asset, 100, uuid(121));
        // Control: a tenant B journal that names tenant A's journal in
        // reversal_of must not count against tenant A (every check is keyed on
        // the tenant; the composite foreign key makes it unreachable for real).
        await seed.correctionJournal(tenantB, uuid(123), asset, 100, uuid(121));
      },
      async (ctx) => {
        await expectRefused(ctx, "DEPRECIATION_CORRECTION_REVERSED", [
          `${tenantA}/${uuid(121)}`,
        ]);
        // The repair the message describes cannot void the manual reversal (a
        // journal is never deleted), so the row that took the journal back is
        // removed: the journal is then only reversed, never claimed.
        await repair(ctx.superuser, uuid(6001), uuid(221));
        await ctx.migrate();
        expect(await claimsOf(ctx.superuser)).toEqual([]);
      },
    );
  }, 180_000);

  it("rejects a taken-back journal that is not a plain depreciation journal", async () => {
    const asset = uuid(741);
    await scenario(
      async (seed) => {
        // Journal 141 is itself a reversal journal (reversal_of -> 140) and a
        // depreciation row was taken back through it: the reversal trigger
        // would never mark it, so the claim could not be protected.
        await seed.correctionJournal(tenantA, uuid(141), asset, 100, uuid(140));
        await seed.reversal(tenantA, uuid(241), 100, asset, uuid(141));
      },
      async (ctx) => {
        await expectRefused(ctx, "DEPRECIATION_REVERSAL_INVALID", [
          uuid(141),
          "source_type reversal",
        ]);
      },
    );
  }, 180_000);

  it("rejects a taken-back journal of another source type, with no reversal_of", async () => {
    const asset = uuid(751);
    await scenario(
      async (seed) => {
        // Not a depreciation journal at all: the reversal trigger ignores it.
        await seed.correctionJournal(
          tenantA,
          uuid(151),
          asset,
          100,
          undefined,
          "asset_disposal",
        );
        await seed.reversal(tenantA, uuid(251), 100, asset, uuid(151));
      },
      async (ctx) => {
        await expectRefused(ctx, "DEPRECIATION_REVERSAL_INVALID", [
          uuid(151),
          "source_type asset_disposal",
        ]);
      },
    );
  }, 180_000);
});
