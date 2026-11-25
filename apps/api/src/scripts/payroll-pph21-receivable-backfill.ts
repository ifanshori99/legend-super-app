// Release-only backfill of the employee PPh 21 receivable open item (bead
// legend-i848k). Gives each employee whose receivable predates the 972 open
// item the missing item (never more than the payslip balance). Idempotent: a
// second run changes nothing. One transaction per tenant. Doubt (unreadable
// payslip, item above the balance) is held back and reported, never guessed.
// Prints counts and employee ids only, never names or amounts per person.
//   pnpm --filter @starter/api payroll:backfill-pph21-receivable -- --dry-run
//   pnpm --filter @starter/api payroll:backfill-pph21-receivable
// Inside the production image (no pnpm, tsx or src; only dist/):
//   node dist/payroll-pph21-receivable-backfill.js [--dry-run]
import { sql } from "drizzle-orm";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { Pph21ReceivableBackfillReport } from "../services/payroll-pph21-receivable-backfill.service";

export const USAGE =
  "Usage: pnpm --filter @starter/api payroll:backfill-pph21-receivable -- [--dry-run]";

class DryRunRollback extends Error {}

export async function backfillPph21Receivables(options: {
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<{ tenants: number; created: number; held: number }> {
  // Delay app/config imports until env loading.
  const { db } = await import("../db/index");
  const { withTenant } = await import("../db/tenant");
  const { backfillPph21ReceivableOpenItemsInTransaction } =
    await import("../services/payroll-pph21-receivable-backfill.service");
  const log = options.log ?? console.log;
  const total = { tenants: 0, created: 0, held: 0 };
  const tenants = await db.execute(
    sql`SELECT id FROM tenants ORDER BY id::text`,
  );
  for (const row of tenants.rows) {
    const tenantId = tenantIdSchema.parse(row.id);
    const scope: ScopedTenantContext = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "job" }),
      { kind: "tenant" },
    );
    let report: Pph21ReceivableBackfillReport | undefined;
    try {
      await withTenant(db, scope, async (tx) => {
        report = await backfillPph21ReceivableOpenItemsInTransaction(tx, scope);
        if (options.dryRun) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
    if (!report) continue;
    total.tenants += 1;
    total.created += report.created;
    total.held += report.held.length;
    log(
      JSON.stringify({
        tenantId,
        created: report.created,
        createdIdr: report.createdIdr,
        held: report.held,
        dryRun: Number(options.dryRun ?? false),
      }),
    );
  }
  return total;
}

export async function cli(args: string[]): Promise<number> {
  const values = args.filter((arg) => arg !== "--");
  const dryRun = values.includes("--dry-run");
  if (values.some((arg) => arg !== "--dry-run")) {
    console.error(USAGE);
    return 2;
  }
  let pool: typeof import("../db/index").pool | undefined;
  try {
    await import("../load-env");
    const { logger } = await import("../lib/logger");
    logger.level = "silent";
    pool = (await import("../db/index")).pool;
    const total = await backfillPph21Receivables({ dryRun });
    console.log(JSON.stringify({ summary: total, dryRun: Number(dryRun) }));
    return 0;
  } catch {
    console.error(
      "PPh 21 receivable backfill failed; nothing of the failing tenant was written. Rerun after checking database availability and migrations.",
    );
    return 1;
  } finally {
    await pool?.end();
  }
}
