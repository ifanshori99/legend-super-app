// P3 (legend-wasr7.4): the cloud, not the tablet page, remembers what was sent
// to a tablet printer. A kitchen ticket printed twice without "CETAK ULANG"
// makes the kitchen cook twice, and a reload of the tablet must not forget.
import { sql } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import {
  tabletPrintMarks,
  type TabletPrintKind,
} from "../db/schema/tablet-print-marks.ts";
import type { Tx } from "./permission-resolver.ts";

/**
 * Records one print of `refId` and says whether it was printed before. The
 * insert and the counter are one statement, so two simultaneous first prints
 * cannot both read "first": the loser of the race is a reprint.
 */
export async function recordTabletPrint(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    kind: TabletPrintKind;
    refId: string;
    outletId: OutletId;
    userId: string;
  },
): Promise<{ printedBefore: boolean }> {
  const [row] = await tx
    .insert(tabletPrintMarks)
    .values({
      tenantId: context.tenant.tenantId,
      kind: input.kind,
      refId: input.refId,
      outletId: input.outletId,
      firstPrintedBy: input.userId,
    })
    .onConflictDoUpdate({
      target: [
        tabletPrintMarks.tenantId,
        tabletPrintMarks.kind,
        tabletPrintMarks.refId,
      ],
      set: {
        printCount: sql`${tabletPrintMarks.printCount} + 1`,
        lastPrintedAt: sql`now()`,
      },
    })
    // xmax is 0 only on a row this statement inserted.
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return { printedBefore: row ? !row.inserted : false };
}
