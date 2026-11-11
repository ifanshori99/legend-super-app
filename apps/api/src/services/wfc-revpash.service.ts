// WFC RevPASH: revenue per available seat hour (PRD v1.7 §3 F39, FAC-14;
// bead legend-bz9h). A read-only report: it writes nothing and moves no money.
//
// Per zone and hour bucket (UTC-aligned hours of `from`..`to`):
// - revenue = paid orders of the tables of the zone, counted in the hour the
//   order was fully paid (its last captured tender). Spend is real money only
//   (captured tenders, never points, completed orders only), net of refunds
//   (the larger of the POS refunds and the completed gateway refunds of the
//   order's intents, so one refund is never subtracted twice), floored at 0
//   per order (M7). Revenue is never over-reported.
// - seats = the zone's `wfc_seats` that are active and already existed at the
//   end of the hour (seats keep no history, so a seat that was switched off
//   later is not counted; a known limit). seatHours = seats x 1 hour.
// - revpash = revenue / seatHours rounded to whole rupiah, half DOWN (never
//   up). A zone without seats has no RevPASH: `null`, not 0, no division by 0.
import { and, eq, sql } from "drizzle-orm";
import {
  idr,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  getRevpashInputSchema,
  type GetRevpashInput,
  type RevpashRow,
} from "@starter/shared/wfc";
import { db } from "../db/index.ts";
import { floorZones } from "../db/schema/floor.ts";
import { wfcSeats } from "../db/schema/wfc-seat.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertFacilityPermission,
  CONFIG_PERMISSION,
  notFound,
  type Tx,
} from "./facility-shared.ts";

const HOUR_S = 3600;
const HOUR_MS = HOUR_S * 1000;

type Row = Record<string, unknown>;

/** n / d rounded half down to a whole number (n >= 0, d > 0). */
export function roundHalfDown(n: number, d: number): number {
  return Math.floor((2 * n + d - 1) / (2 * d));
}

/** Net paid revenue per (zone, hour epoch) of the given zones. */
async function revenueByZoneHour(
  tx: Tx,
  tenantId: string,
  outletId: string,
  zoneIds: readonly string[],
  fromHour: Date,
  to: Date,
): Promise<Map<string, number>> {
  const zones = sql.join(
    zoneIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    WITH order_paid AS (
      SELECT o.id AS order_id, tb.zone_id,
             SUM(tn.amount_idr) AS paid,
             MAX(COALESCE(tn.resolved_at, tn.requested_at)) AS paid_at
        FROM orders o
        JOIN table_sessions s ON s.tenant_id = o.tenant_id AND s.id = o.table_session_id
        JOIN tables tb ON tb.tenant_id = s.tenant_id AND tb.id = s.table_id
        JOIN pos_order_tenders tn ON tn.tenant_id = o.tenant_id AND tn.order_id = o.id
       WHERE o.tenant_id = ${tenantId} AND o.outlet_id = ${outletId}
         AND o.status = 'completed'
         AND tn.status = 'captured' AND tn.method <> 'points'
         AND tb.zone_id IN (${zones})
       GROUP BY o.id, tb.zone_id)
    SELECT p.zone_id,
           floor(extract(epoch FROM p.paid_at) / 3600)::bigint AS hour_index,
           p.paid,
           GREATEST(
             COALESCE((SELECT SUM(r.amount_idr) FROM pos_order_refunds r
                        WHERE r.tenant_id = ${tenantId} AND r.order_id = p.order_id), 0),
             COALESCE((SELECT SUM(pr.amount_idr) FROM payment_refunds pr
                        WHERE pr.tenant_id = ${tenantId} AND pr.status = 'completed'
                          AND pr.payment_intent_id IN (
                            SELECT t2.payment_intent_id FROM pos_order_tenders t2
                             WHERE t2.tenant_id = ${tenantId}
                               AND t2.order_id = p.order_id
                               AND t2.payment_intent_id IS NOT NULL)), 0)
           ) AS refunded
      FROM order_paid p
     WHERE p.paid_at >= ${fromHour.toISOString()}::timestamptz
       AND p.paid_at < ${to.toISOString()}::timestamptz`);
  const revenue = new Map<string, number>();
  for (const row of result.rows as Row[]) {
    const key = `${String(row.zone_id)}:${Number(row.hour_index)}`;
    const net = Math.max(0, Number(row.paid) - Number(row.refunded));
    revenue.set(key, (revenue.get(key) ?? 0) + net);
  }
  return revenue;
}

/**
 * RevPASH rows for an outlet (one zone, or all of its zones), oldest hour
 * first. Needs `facility.config.manage` on the outlet.
 */
export async function getRevpash(
  context: ScopedTenantContext,
  actorUserId: string,
  input: GetRevpashInput,
): Promise<RevpashRow[]> {
  const query = getRevpashInputSchema.parse(input);
  const tenantId = context.tenant.tenantId;
  const from = new Date(query.from);
  const to = new Date(query.to);
  const firstHourMs = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS;
  return withTenant(db, context, async (tx) => {
    await assertFacilityPermission(
      tx,
      context,
      actorUserId,
      CONFIG_PERMISSION,
      query.outletId,
    );
    const zones = await tx
      .select({ id: floorZones.id })
      .from(floorZones)
      .where(
        and(
          eq(floorZones.tenantId, tenantId),
          eq(floorZones.outletId, outletIdSchema.parse(query.outletId)),
          ...(query.zoneId ? [eq(floorZones.id, query.zoneId)] : []),
        ),
      )
      .orderBy(floorZones.sortOrder, floorZones.id);
    if (query.zoneId && zones.length === 0) throw notFound("Zona");
    if (zones.length === 0) return [];
    const zoneIds = zones.map((zone) => zone.id);

    const seats = await tx
      .select({ zoneId: wfcSeats.zoneId, createdAt: wfcSeats.createdAt })
      .from(wfcSeats)
      .where(
        and(
          eq(wfcSeats.tenantId, tenantId),
          eq(wfcSeats.outletId, outletIdSchema.parse(query.outletId)),
          eq(wfcSeats.status, "active"),
        ),
      );
    const revenue = await revenueByZoneHour(
      tx,
      tenantId,
      query.outletId,
      zoneIds,
      new Date(firstHourMs),
      to,
    );

    const rows: RevpashRow[] = [];
    for (const zoneId of zoneIds)
      for (let ms = firstHourMs; ms < to.getTime(); ms += HOUR_MS) {
        const seatCount = seats.filter(
          (seat) =>
            seat.zoneId === zoneId && seat.createdAt.getTime() < ms + HOUR_MS,
        ).length;
        const revenueIdr = revenue.get(`${zoneId}:${ms / HOUR_MS}`) ?? 0;
        rows.push({
          zoneId,
          hourStart: new Date(ms).toISOString(),
          revenueIdr: idr(revenueIdr),
          seatHours: seatCount,
          revpashIdr:
            seatCount === 0 ? null : idr(roundHalfDown(revenueIdr, seatCount)),
        });
      }
    return rows;
  });
}
