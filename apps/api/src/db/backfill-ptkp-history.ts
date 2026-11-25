// One-shot PTKP history backfill (bead 1223 r2). Run once after migration
// 0520 and BEFORE the next payroll simulate (docs/deployment.md), from apps/api
// with the migration owner's connection:
//   pnpm exec tsx src/db/backfill-ptkp-history.ts [--year YYYY] [--force]
// Refused in a tenant where HR already corrected a PTKP (PUT
// /api/hris/employees/:id/ptkp) unless --force.
// Production (node dist/backfill-ptkp-history.js, legend-1265 G3): needs
// MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE and stops without it
// before any connection; the app DATABASE_URL is never used. The login must be
// the migration owner (superuser or BYPASSRLS), and no tenant read is an error.
// Default year: the running tax year in Jakarta. Idempotent; prints counts
// only (no status, name or payroll value).
import { Pool } from "pg";
import { databaseError } from "./connection.ts";
import {
  assertMigrationOwner,
  migrationOwnerUrl,
  SafeError,
} from "./migration-owner.ts";

const jakartaToday = () =>
  new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** The built file runs without tsx; the source (tsx) keeps the dev fallback. */
const isBuilt = !import.meta.url.endsWith(".ts");

const args = process.argv.slice(2).filter((arg) => arg !== "--");
let pool: Pool | undefined;
try {
  const today = jakartaToday();
  let taxYear = Number(today.slice(0, 4));
  const force = args.includes("--force");
  const rest = args.filter((arg) => arg !== "--force");
  if (rest.length === 2 && rest[0] === "--year" && /^\d{4}$/.test(rest[1]!))
    taxYear = Number(rest[1]);
  else if (rest.length !== 0)
    throw new SafeError(
      "Usage: backfill-ptkp-history [--year YYYY] [--force]  (source: pnpm exec tsx src/db/backfill-ptkp-history.ts; built: node dist/backfill-ptkp-history.js)",
    );
  await import("../load-env.ts");
  const url = migrationOwnerUrl(isBuilt);
  const { backfillPtkpHistoryForTenant } =
    await import("../services/payroll-ptkp-backfill.ts");
  pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  // The history is written by the migration owner; the app login cannot write
  // it and, under row level security, would read nothing useful.
  await assertMigrationOwner(pool);
  const tenants = await pool.query<{ id: string }>(
    "SELECT id FROM tenants ORDER BY id",
  );
  // An empty read means the wrong database or login, never "nothing to do".
  if (tenants.rows.length === 0)
    throw new SafeError(
      "No tenant was read; check the database and the migration login. Nothing was written.",
    );
  let employees = 0;
  let changed = 0;
  for (const { id } of tenants.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [id],
      );
      const result = await backfillPtkpHistoryForTenant(
        client,
        id,
        taxYear,
        today,
        force,
      );
      await client.query("COMMIT");
      employees += result.employees;
      changed += result.changed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(
    `PTKP history ${taxYear}: ${tenants.rows.length} tenant, ${employees} karyawan, ${changed} dengan status baru untuk tahun berikutnya.`,
  );
} catch (error) {
  console.error(
    error instanceof SafeError ||
      (error instanceof Error &&
        /^(Sudah ada koreksi|Slip )/.test(error.message))
      ? error.message
      : databaseError(error),
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
