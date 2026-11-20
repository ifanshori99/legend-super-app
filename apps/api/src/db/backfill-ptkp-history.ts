// One-shot PTKP history backfill (bead 1223 r2). Run once after migration
// 0516 and BEFORE the next payroll simulate (docs/deployment.md), from apps/api
// with the migration owner's connection:
//   pnpm exec tsx src/db/backfill-ptkp-history.ts [--year YYYY]
// Default year: the running tax year in Jakarta. Idempotent; prints counts
// only (no status, name or payroll value).
import { Pool } from "pg";
import { databaseError, databaseUrl } from "./connection.ts";

const jakartaToday = () =>
  new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

const args = process.argv.slice(2).filter((arg) => arg !== "--");
let pool: Pool | undefined;
try {
  const today = jakartaToday();
  let taxYear = Number(today.slice(0, 4));
  if (args.length === 2 && args[0] === "--year" && /^\d{4}$/.test(args[1]!))
    taxYear = Number(args[1]);
  else if (args.length !== 0)
    throw new Error(
      "Usage: pnpm exec tsx src/db/backfill-ptkp-history.ts [--year YYYY]",
    );
  await import("../load-env.ts");
  const { backfillPtkpHistoryForTenant } =
    await import("../services/payroll-ptkp-backfill.ts");
  pool = new Pool({
    connectionString: databaseUrl(
      process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
    ),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const tenants = await pool.query<{ id: string }>(
    "SELECT id FROM tenants ORDER BY id",
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
  console.error(databaseError(error));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
