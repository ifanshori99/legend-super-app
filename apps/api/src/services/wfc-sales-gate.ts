// Brief 1270 W1: the one gate every paid WFC sale must pass, inside the sale's
// transaction and before it writes anything. `WFC_SALES_ENABLED` is off by
// default and anything but exactly `true` is off (fail closed). On, an outlet
// sells only with a complete settings version in force, at least one active
// seat in a WFC zone and at least one quota cell above zero.
import { and, eq, gt } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env.ts";
import { eqId } from "../db/branded-ids.ts";
import { wfcHourlyQuotas } from "../db/schema/wfc-settings.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./facility-shared.ts";
import { countActiveWfcSeats } from "./wfc-seat.service.ts";
import {
  findWfcSettings,
  wfcBusinessDate,
  wfcConfigIncomplete,
  type WfcSettingsRow,
} from "./wfc-settings.ts";

export function wfcSalesEnabled(): boolean {
  return env.WFC_SALES_ENABLED === true;
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
  const settings = await findWfcSettings(
    tx,
    context,
    outletId,
    await wfcBusinessDate(tx, context, outletId, now),
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
  if (!settings || !quota || seats === 0) throw wfcConfigIncomplete();
  return settings;
}
