import {
  dropTestDatabase,
  endTestPool,
  waitForNoTestDatabaseSessions as waitForNoSessions,
} from "./helpers/database-cleanup.ts";
// Bead legend-l29ln: migrations 0433 and 0434 run by a migrator that is a plain
// table owner (NOSUPERUSER, NOBYPASSRLS) over a database that already holds
// journal entries, bank recon matches and payment intents.
//
// 0433 adds a foreign key from bank_statement_line_matches onto journal_entries
// and 0434 backfills payment_intents with an UPDATE. A plain owner would hit
// 42501 from app.require_tenant_id under FORCE ROW LEVEL SECURITY, so both lift
// FORCE for their transaction and restore it. The tests prove:
//   - the owner cannot read these tables while FORCE is on (the reason for the lift);
//   - the migrations succeed as that owner over populated tables;
//   - FORCE is back on every touched table afterwards;
//   - the 0433 columns exist and old rows stay "not stale";
//   - the 0434 backfill copies provider_final_at and nothing else.
//
// The scratch databases live on the disposable test server. One template is
// built through 0432 as a BYPASSRLS owner (older migrations need it), the role
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
const ownerRole = `mig0433_owner_${suffix}`;
const ownerPassword = randomBytes(16).toString("hex");
const templateDb = `mig0433_tpl_${suffix}`;
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

// A copy of drizzle/ holding every migration before 0433 (journal cut there).
function copyFolderBefore0433(workDir: string): string {
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const cut = journal.entries.findIndex((entry) =>
    entry.tag.startsWith("0433_"),
  );
  expect(cut).toBeGreaterThan(0);
  const kept = journal.entries.slice(0, cut);
  const keptTags = new Set(kept.map((entry) => entry.tag));
  const folder = join(workDir, "drizzle-before-0433");
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

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const tenantA = uuid(1);
const tenantB = uuid(2);
const entity = uuid(901);
const period = uuid(902);
const bankAccount = uuid(903);
const outlet = uuid(904);
const paymentLink = uuid(905);

const TOUCHED = [
  "bank_statement_line_matches",
  "journal_entries",
  "payment_intents",
];

describe("legend-l29ln migrations 0433-0434 run by a NOBYPASSRLS table owner over populated tables", () => {
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
    workDir = mkdtempSync(join(tmpdir(), "legend-mig0433-"));
    const owner = new Pool({
      connectionString: urlFor(templateDb, ownerRole, ownerPassword),
      max: 1,
    });
    try {
      await runMigrations(
        owner,
        copyFolderBefore0433(workDir),
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

  // Legacy rows are written by the superuser with session_replication_role =
  // replica: foreign keys and triggers are skipped, which is how rows written
  // before the new guards look.
  async function seedPopulated(client: PoolClient) {
    for (const tenant of [tenantA, tenantB])
      await client.query(
        `INSERT INTO tenants
           (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         VALUES ($1, $2, 'Legacy tenant', 'lengkap', 'active', 'shared',
                 '{"modules":[],"integrationProviders":[]}',
                 '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}',
                 $3)`,
        [tenant, `mig0433-${tenant}`, uuid(9999)],
      );

    // Journal entries, each matched by one bank statement line.
    let seq = 0;
    for (const tenant of [tenantA, tenantB])
      for (let i = 0; i < 2; i += 1) {
        seq += 1;
        const journalId = uuid(100 + seq);
        const lineId = uuid(200 + seq);
        await client.query(
          `INSERT INTO journal_entries
             (tenant_id, id, legal_entity_id, entry_date, fiscal_period_id,
              source_type, source_id, description, idempotency_key,
              request_fingerprint)
           VALUES ($1, $2, $3, '2026-01-31', $4, 'depreciation', $5,
                   'legacy journal', $6, $7)`,
          [
            tenant,
            journalId,
            entity,
            period,
            uuid(300 + seq),
            `legacy-${journalId}`,
            "a".repeat(64),
          ],
        );
        await client.query(
          `INSERT INTO bank_statement_line_matches
             (tenant_id, bank_account_id, line_id, ref_type, ref_id,
              amount_idr, source, matched_by)
           VALUES ($1, $2, $3, 'journal_entry', $4, 1000, 'auto', 'legacy')`,
          [tenant, bankAccount, lineId, journalId],
        );
      }

    // Payment intents: an answered-and-paid one, an answered-and-failed one,
    // and a pending one nobody answered yet.
    const intents: [string, number, string, boolean][] = [
      [tenantA, 1, "paid", true],
      [tenantA, 2, "failed", true],
      [tenantA, 3, "pending", false],
      [tenantB, 4, "paid", true],
    ];
    for (const [tenant, n, status, final] of intents)
      await client.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, method, provider,
            amount_idr, idempotency_key, status, instructions, expires_at,
            paid_at, provider_final_at)
         VALUES ($1, $2, $3, $4, 'qris', 'doit', 25000, $5, $6, '{}'::jsonb,
                 '2026-02-01T00:00:00Z', $7, $8)`,
        [
          uuid(400 + n),
          tenant,
          outlet,
          paymentLink,
          `legacy-intent-${n}`,
          status,
          status === "paid" ? "2026-01-31T10:00:00Z" : null,
          final ? "2026-01-31T10:05:00Z" : null,
        ],
      );
  }

  async function scenario(
    body: (ctx: {
      owner: Pool;
      superuser: Pool;
      migrate: () => Promise<void>;
    }) => Promise<void>,
  ) {
    const db = `mig0433_s_${randomBytes(6).toString("hex")}`;
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
        await seedPopulated(client);
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

  it("the migrator is a plain table owner that FORCE RLS applies to", async () => {
    const { rows } = await admin.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [ownerRole],
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await scenario(async ({ owner, superuser }) => {
      expect(await forceFlags(superuser, TOUCHED)).toEqual(allForced(TOUCHED));
      // The reason 0433 and 0434 lift FORCE: this owner cannot read a forced table.
      for (const table of TOUCHED)
        await expect(
          owner.query(`SELECT 1 FROM public.${table} LIMIT 1`),
        ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("applies 0433 and 0434 over populated tables and restores FORCE RLS", async () => {
    await scenario(async ({ superuser, migrate }) => {
      await migrate();

      expect(await forceFlags(superuser, TOUCHED)).toEqual(allForced(TOUCHED));

      // 0433: old matches are not stale, the new foreign key and check exist.
      const matches = await superuser.query(
        `SELECT count(*)::int AS total,
                count(stale_at)::int AS stale,
                count(stale_by_reversal_entry_id)::int AS stale_by
           FROM bank_statement_line_matches`,
      );
      expect(matches.rows).toEqual([{ total: 4, stale: 0, stale_by: 0 }]);
      const constraints = await superuser.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'public.bank_statement_line_matches'::regclass
            AND conname IN ('bank_statement_line_matches_stale_reversal_fk',
                            'bank_statement_line_matches_stale_check')
          ORDER BY 1`,
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "bank_statement_line_matches_stale_check",
        "bank_statement_line_matches_stale_reversal_fk",
      ]);

      // 0434: provider_answered_at is copied from provider_final_at only.
      const intents = await superuser.query(
        `SELECT idempotency_key, status,
                provider_answered_at IS NOT DISTINCT FROM provider_final_at AS copied,
                provider_answered_at IS NOT NULL AS answered
           FROM payment_intents ORDER BY idempotency_key`,
      );
      expect(intents.rows).toEqual([
        {
          idempotency_key: "legacy-intent-1",
          status: "paid",
          copied: true,
          answered: true,
        },
        {
          idempotency_key: "legacy-intent-2",
          status: "failed",
          copied: true,
          answered: true,
        },
        {
          idempotency_key: "legacy-intent-3",
          status: "pending",
          copied: true,
          answered: false,
        },
        {
          idempotency_key: "legacy-intent-4",
          status: "paid",
          copied: true,
          answered: true,
        },
      ]);
    });
  });

  it("keeps FORCE RLS on for the owner after the migrations ran", async () => {
    await scenario(async ({ owner, migrate }) => {
      await migrate();
      for (const table of TOUCHED)
        await expect(
          owner.query(`SELECT 1 FROM public.${table} LIMIT 1`),
        ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
