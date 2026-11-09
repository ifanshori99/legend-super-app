// Training mode (Mode Latihan) report filter (bead legend-165; PRD v1.7 §3 F5
// "Mode Latihan"). A device in training mode keeps working and keeps its rows,
// but sales made inside one of its training periods must never reach a report.
//
// Rule for every report query over `pos_orders`: AND `reportablePosOrders()`
// into the WHERE clause (legend-2lp.8: `pos_orders.is_training` is stamped from
// the device at creation). `reportableActivity` / `isDeviceInTrainingAt` stay
// for other device-stamped activity and as the fallback for legacy rows made
// before the stamp existed. A forgotten filter silently inflates revenue, so
// new report queries must be reviewed against this rule.
//
// A period covers [started_at, ended_at); an open period (ended_at IS NULL)
// runs to now. Activity with no device (deviceId NULL) is always reportable.
// Periods are matched on the device id only: device ids are globally unique
// UUIDs, and the `tenant_isolation`/`outlet_isolation` RLS policies already
// limit the subquery to the caller's tenant and outlets.
import {
  and,
  eq,
  gt,
  isNull,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { deviceTrainingPeriods } from "../db/schema/device.ts";
import { posOrders } from "../db/schema/pos-order.ts";
import type { Tx } from "./permission-resolver.ts";

/** SQL boolean for `pos_orders` report WHERE clauses: not a training order. */
export function reportablePosOrders(): SQL {
  return eq(posOrders.isTraining, false);
}

/**
 * Fallback for legacy rows (no stamp, or non-pos_orders activity). SQL
 * boolean: the device was in training mode at `occurredAt`. Both arguments
 * are SQL expressions (columns or values) of the outer query.
 */
export function isTrainingActivity(
  deviceIdSql: SQLWrapper,
  occurredAtSql: SQLWrapper,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${deviceTrainingPeriods}
    WHERE ${deviceTrainingPeriods.deviceId} = ${deviceIdSql}
      AND ${deviceTrainingPeriods.startedAt} <= ${occurredAtSql}
      AND (${deviceTrainingPeriods.endedAt} IS NULL
        OR ${occurredAtSql} < ${deviceTrainingPeriods.endedAt})
  )`;
}

/** Fallback for legacy rows: SQL boolean, the activity is NOT training. */
export function reportableActivity(
  deviceIdSql: SQLWrapper,
  occurredAtSql: SQLWrapper,
): SQL {
  return sql`NOT ${isTrainingActivity(deviceIdSql, occurredAtSql)}`;
}

/** Fallback for legacy rows: point lookup on the caller's transaction (RLS scoped). */
export async function isDeviceInTrainingAt(
  tx: Tx,
  deviceId: string,
  at: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: deviceTrainingPeriods.id })
    .from(deviceTrainingPeriods)
    .where(
      and(
        eq(deviceTrainingPeriods.deviceId, deviceId),
        lte(deviceTrainingPeriods.startedAt, at),
        or(
          isNull(deviceTrainingPeriods.endedAt),
          gt(deviceTrainingPeriods.endedAt, at),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}
