// Brief 1270 W1: the one gate every paid WFC sale must pass, inside the sale's
// transaction and before it writes anything. `WFC_SALES_ENABLED` is off by
// default and anything but exactly `true` is off (fail closed). On, an outlet
// sells only with a complete settings version in force, at least one active
// seat in a WFC zone and at least one quota cell above zero.
import { and, desc, eq, gt, lte } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env.ts";
import { eqId } from "../db/branded-ids.ts";
import {
  wfcBusinessSettings,
  wfcHourlyQuotas,
} from "../db/schema/wfc-settings.ts";
import { HttpError } from "../lib/http-error.ts";
import { localDate } from "./facility-entitlement.service.ts";
import { outletTimeZone, type Tx } from "./facility-shared.ts";
import { countActiveWfcSeats } from "./wfc-seat.service.ts";

export type WfcSettingsRow = typeof wfcBusinessSettings.$inferSelect;

export function wfcSalesEnabled(): boolean {
  return env.WFC_SALES_ENABLED === true;
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

/** Throws unless the outlet may sell WFC now; returns the settings in force. */
export async function assertWfcSalesOpen(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<WfcSettingsRow> {
  if (!wfcSalesEnabled())
    throw new HttpError(
      403,
      "WFC_SALES_DISABLED",
      "Penjualan WFC belum dibuka.",
    );
  const timeZone = await outletTimeZone(tx, context, outletId);
  const settings = await findWfcSettings(
    tx,
    context,
    outletId,
    localDate(now, timeZone),
  );
  const [quota] = await tx
    .select({ id: wfcHourlyQuotas.id })
    .from(wfcHourlyQuotas)
    .where(
      and(
        eq(wfcHourlyQuotas.tenantId, context.tenant.tenantId),
        eqId(wfcHourlyQuotas.outletId, outletId),
        gt(wfcHourlyQuotas.seats, 0),
      ),
    )
    .limit(1);
  const seats = await countActiveWfcSeats(tx, context, outletId);
  if (!settings || !quota || seats === 0)
    throw new HttpError(
      409,
      "WFC_CONFIG_INCOMPLETE",
      "Pengaturan WFC outlet ini belum lengkap.",
    );
  return settings;
}
