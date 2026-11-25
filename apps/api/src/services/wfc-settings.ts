// Brief 1270 W1: reading the WFC settings in force at an outlet.
import { and, desc, eq, lte } from "drizzle-orm";
import { businessDateOf, type ScopedTenantContext } from "@starter/shared/core";
import { eqId } from "../db/branded-ids.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { wfcBusinessSettings } from "../db/schema/wfc-settings.ts";
import { HttpError } from "../lib/http-error.ts";
import { notFound, type Tx } from "./facility-shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";

export type WfcSettingsRow = typeof wfcBusinessSettings.$inferSelect;

/** The outlet's business date (Q39 cutoff) of an instant. */
export async function wfcBusinessDate(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<string> {
  const [outlet] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eqId(outlets.id, outletId),
      ),
    )
    .limit(1);
  if (!outlet) throw notFound("Outlet");
  return businessDateOf(now, outletBusinessDayClock(outlet));
}

/** The settings version in force at the outlet on a business date, else null. */
export async function findWfcSettings(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  businessDate: string,
): Promise<WfcSettingsRow | null> {
  const [row] = await tx
    .select()
    .from(wfcBusinessSettings)
    .where(
      and(
        eq(wfcBusinessSettings.tenantId, context.tenant.tenantId),
        eqId(wfcBusinessSettings.outletId, outletId),
        lte(wfcBusinessSettings.effectiveFrom, businessDate),
      ),
    )
    .orderBy(
      desc(wfcBusinessSettings.effectiveFrom),
      desc(wfcBusinessSettings.version),
    )
    .limit(1);
  return row ?? null;
}

export const wfcConfigIncomplete = () =>
  new HttpError(
    409,
    "WFC_CONFIG_INCOMPLETE",
    "Pengaturan WFC outlet ini belum lengkap.",
  );
