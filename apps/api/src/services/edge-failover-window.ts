// Read helpers for the outlet failover window (1271 F1). The cloud service
// (F3), the receipt allocator (F2), the edge applier (F4) and the day recap
// (F5) all ask the same two questions: is the outlet's window open, and may a
// business date hold failover rows. Writes live in edge-failover.service.ts.
import { and, eq, inArray } from "drizzle-orm";
import type { OutletId, TenantId } from "@starter/shared/core";
import { windowTouchesDate as contractWindowTouchesDate } from "@starter/shared/edge";
import { outletFailoverWindows } from "../db/schema/edge-failover.ts";
import type { Tx } from "./permission-resolver.ts";

export type FailoverWindowRow = typeof outletFailoverWindows.$inferSelect;

/**
 * The outlet's open window (`active` or `returning`), or null. At most one
 * exists (partial unique index). The caller decides what each status allows:
 * the cloud sells only while `active`; the edge refuses while either.
 */
export async function activeFailoverWindow(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<FailoverWindowRow | null> {
  const [row] = await tx
    .select()
    .from(outletFailoverWindows)
    .where(
      and(
        eq(outletFailoverWindows.tenantId, tenantId),
        eq(outletFailoverWindows.outletId, outletId),
        inArray(outletFailoverWindows.status, ["active", "returning"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Whether the business date may hold rows of this window (from..to, open end while active). */
export function windowTouchesDate(
  window: Pick<FailoverWindowRow, "businessDateFrom" | "businessDateTo">,
  businessDate: string,
): boolean {
  return contractWindowTouchesDate(window, businessDate);
}
