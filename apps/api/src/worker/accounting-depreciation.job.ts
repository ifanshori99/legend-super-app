// Scheduled monthly depreciation (PRD v1.7 §3.19 "Aset Tetap — depresiasi
// otomatis"; Jurnal Otomatis "depresiasi"; bead legend-hpgo).
//
// Runs on the worker's periodic relay sweep for one tenant (tenant-wide
// worker context). For every legal entity it posts the run of the month that
// just ended (Asia/Jakarta calendar, D-CORE-6) once:
// - idempotent: the command key is deterministic per entity+period
//   (`fa-dep-job:<entity>:<period>`), the run is UNIQUE per entity+period and
//   the ledger is UNIQUE per asset+period, so overlapping ticks or two
//   workers replay instead of posting twice;
// - skips an entity that already has the run, has no asset due, or whose
//   period is already closed (ACC-02: nothing posts into a closed month; the
//   next open run catches the months up);
// - fails closed per entity: a missing account mapping or any error leaves
//   that entity for the next tick and never blocks the other entities or the
//   relay. Logs carry no tenant data.

import { and, eq } from "drizzle-orm";
import { previousPeriod, periodOf } from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db";
import { fiscalPeriods } from "../db/schema/accounting.ts";
import { legalEntities } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { entityToday } from "../services/accounting-ap-fa-shared.ts";
import {
  depreciationRunExists,
  hasDueAssets,
  runDepreciationInTransaction,
} from "../services/accounting-fixed-assets.service.ts";

export type DepreciationJobResult = {
  readonly period: string;
  readonly posted: number;
  readonly skipped: number;
  readonly failed: number;
};

/** The deterministic command key of the scheduled run (exported for tests). */
export const depreciationJobKey = (legalEntityId: string, period: string) =>
  `fa-dep-job:${legalEntityId}:${period}`;

export async function runDueDepreciation(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<DepreciationJobResult> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Depreciation job requires tenant-wide scope");
  const tenantId = context.tenant.tenantId;
  const period = previousPeriod(periodOf(entityToday(now)));
  const entities = await withTenant(db, context, (tx) =>
    tx
      .select({ id: legalEntities.id })
      .from(legalEntities)
      .where(eq(legalEntities.tenantId, tenantId)),
  );
  let posted = 0;
  let skipped = 0;
  let failed = 0;
  for (const { id: legalEntityId } of entities) {
    try {
      const outcome = await withTenant(db, context, async (tx) => {
        if (await depreciationRunExists(tx, tenantId, legalEntityId, period))
          return "skipped";
        if (!(await hasDueAssets(tx, tenantId, legalEntityId, period)))
          return "skipped";
        const [fiscal] = await tx
          .select({ status: fiscalPeriods.status })
          .from(fiscalPeriods)
          .where(
            and(
              eq(fiscalPeriods.tenantId, tenantId),
              eq(fiscalPeriods.legalEntityId, legalEntityId),
              eq(fiscalPeriods.period, period),
            ),
          )
          .limit(1);
        if (fiscal?.status === "closed") return "skipped";
        await runDepreciationInTransaction(
          tx,
          context,
          {
            legalEntityId,
            period,
            idempotencyKey: depreciationJobKey(legalEntityId, period),
          },
          null,
          now,
        );
        return "posted";
      });
      if (outcome === "posted") posted += 1;
      else skipped += 1;
    } catch {
      failed += 1;
      console.error("Scheduled depreciation failed for a legal entity");
    }
  }
  return { period, posted, skipped, failed };
}
