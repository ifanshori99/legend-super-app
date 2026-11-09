// Metric sources of the "reservation-delivery" family (F8). Owned by this
// family's card (bead legend-5wzoc F-series): add sources and splits here,
// never in another file.
//
// Reservation (day = the business day of `reserved_for`, outlet clock):
// - `reservation_count`: every reservation except `cancelled` (the guest
//   withdrew; a no-show can only come from the rest). Splits: zone (id, or
//   "unassigned" when no zone was picked) and hour ("00".."23", outlet zone),
//   each adding up to the total.
// - `no_show_reservations`: status `no_show`, total only.
// - `reservation_no_show_pct`: derived, never stored.
// - `pax` is a point-of-sale metric (traffic family), not guests booked: not
//   claimed here.
//
// Delivery (day = the business day of `received_at`; orders `cancelled` or
// `rejected` never became sales and are left out of both codes):
// - `delivery_orders`: count, split by channel (the platform).
// - `delivery_sales`: gross - commission whole rupiah, split by channel and by
//   menu item. It reads the delivery order rows directly: the ledger does not
//   post it yet (it is in NON_GL_MONEY_METRICS), so there is no GL total to
//   reconcile and no residual row. A menu split row is the order net shared
//   across the lines by line total (remainder to the biggest line), so the
//   menu rows add up to the total; a line with no menu match is "unmapped".
// Tables are only read; the delivery services are not touched.

import { and, eq, gte, lt, ne, notInArray } from "drizzle-orm";
import {
  businessDayRange,
  idr,
  type OutletId,
  type TenantId,
} from "@starter/shared/core";
import { deliveryChannelOrders } from "../../db/schema/delivery";
import { outlets } from "../../db/schema/platform-org";
import { reservations } from "../../db/schema/reservation";
import { outletBusinessDayClock } from "../outlet-clock";
import type {
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSourceFamilyModule,
} from "./types";

const UNASSIGNED_ZONE = "unassigned";
const UNMAPPED_MENU = "unmapped";

async function dayRange(input: DailyComputeInput) {
  const [outlet] = await input.tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(
      and(eq(outlets.tenantId, input.tenantId), eq(outlets.id, input.outletId)),
    )
    .limit(1);
  if (!outlet) throw new Error("Outlet not found for the metric reader");
  const clock = outletBusinessDayClock(outlet);
  return { ...businessDayRange(input.businessDate, clock), clock };
}

function hourOf(instant: Date, timeZone: string): string {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return hour.padStart(2, "0");
}

const count = (n: number) => ({ unit: "count", value: n }) as const;

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function splitRows(
  metricCode: string,
  key: "zone" | "hour" | "channel",
  map: Map<string, number>,
): DailyMetricValue[] {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([value, n]) => ({
      metricCode,
      dimension: { key, value },
      value: count(n),
    }));
}

const reservationCountReader: DailyMetricReader = {
  metricCodes: ["reservation_count"],
  dimensions: ["zone", "hour"],
  requiresDailyClose: false,
  async compute(input) {
    const { start, end, clock } = await dayRange(input);
    const rows = await input.tx
      .select({
        reservedFor: reservations.reservedFor,
        zoneId: reservations.zoneId,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, input.tenantId as TenantId),
          eq(reservations.outletId, input.outletId as OutletId),
          gte(reservations.reservedFor, start),
          lt(reservations.reservedFor, end),
          ne(reservations.status, "cancelled"),
        ),
      );
    const byZone = new Map<string, number>();
    const byHour = new Map<string, number>();
    for (const row of rows) {
      bump(byZone, row.zoneId ?? UNASSIGNED_ZONE, 1);
      bump(byHour, hourOf(row.reservedFor, clock.timeZone), 1);
    }
    return [
      {
        metricCode: "reservation_count",
        dimension: null,
        value: count(rows.length),
      },
      ...splitRows("reservation_count", "zone", byZone),
      ...splitRows("reservation_count", "hour", byHour),
    ];
  },
};

const noShowReader: DailyMetricReader = {
  metricCodes: ["no_show_reservations"],
  dimensions: [],
  requiresDailyClose: false,
  async compute(input) {
    const { start, end } = await dayRange(input);
    const rows = await input.tx
      .select({ id: reservations.id })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, input.tenantId as TenantId),
          eq(reservations.outletId, input.outletId as OutletId),
          gte(reservations.reservedFor, start),
          lt(reservations.reservedFor, end),
          eq(reservations.status, "no_show"),
        ),
      );
    return [
      {
        metricCode: "no_show_reservations",
        dimension: null,
        value: count(rows.length),
      },
    ];
  },
};

async function deliveryOrdersOfDay(input: DailyComputeInput) {
  const { start, end } = await dayRange(input);
  return input.tx
    .select({
      platform: deliveryChannelOrders.platform,
      grossIdr: deliveryChannelOrders.grossIdr,
      commissionIdr: deliveryChannelOrders.commissionIdr,
      lines: deliveryChannelOrders.lines,
    })
    .from(deliveryChannelOrders)
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, input.tenantId as TenantId),
        eq(deliveryChannelOrders.outletId, input.outletId as OutletId),
        gte(deliveryChannelOrders.receivedAt, start),
        lt(deliveryChannelOrders.receivedAt, end),
        notInArray(deliveryChannelOrders.status, ["cancelled", "rejected"]),
      ),
    );
}

const deliveryOrdersReader: DailyMetricReader = {
  metricCodes: ["delivery_orders"],
  dimensions: ["channel"],
  requiresDailyClose: false,
  async compute(input) {
    const rows = await deliveryOrdersOfDay(input);
    const byChannel = new Map<string, number>();
    for (const row of rows) bump(byChannel, row.platform, 1);
    return [
      {
        metricCode: "delivery_orders",
        dimension: null,
        value: count(rows.length),
      },
      ...splitRows("delivery_orders", "channel", byChannel),
    ];
  },
};

/** Shares `net` over the lines by line total; the remainder goes to the biggest. */
function shareNet(net: number, lineTotals: readonly number[]): number[] {
  const sum = lineTotals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return lineTotals.map((_, index) => (index === 0 ? net : 0));
  const parts = lineTotals.map((total) => Math.floor((net * total) / sum));
  const remainder = net - parts.reduce((a, b) => a + b, 0);
  let biggest = 0;
  lineTotals.forEach((total, index) => {
    if (total > lineTotals[biggest]!) biggest = index;
  });
  parts[biggest] = parts[biggest]! + remainder;
  return parts;
}

const deliverySalesReader: DailyMetricReader = {
  metricCodes: ["delivery_sales"],
  dimensions: ["channel", "menu_item"],
  requiresDailyClose: false,
  async compute(input) {
    const rows = await deliveryOrdersOfDay(input);
    let total = 0;
    const byChannel = new Map<string, number>();
    const byMenu = new Map<string, number>();
    for (const row of rows) {
      const net = row.grossIdr - row.commissionIdr;
      total += net;
      bump(byChannel, row.platform, net);
      const lines = row.lines;
      const parts = shareNet(
        net,
        lines.map((line) => line.lineTotalIdr),
      );
      lines.forEach((line, index) =>
        bump(byMenu, line.menuItemId ?? UNMAPPED_MENU, parts[index] ?? 0),
      );
    }
    const money = (value: number) => ({
      unit: "idr" as const,
      valueIdr: idr(value),
    });
    const split = (
      key: "channel" | "menu_item",
      map: Map<string, number>,
    ): DailyMetricValue[] =>
      [...map.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([value, amount]) => ({
          metricCode: "delivery_sales",
          dimension: { key, value },
          value: money(amount),
        }));
    return [
      { metricCode: "delivery_sales", dimension: null, value: money(total) },
      ...split("channel", byChannel),
      ...split("menu_item", byMenu),
    ];
  },
};

export const reservationDeliverySources: MetricSourceFamilyModule = {
  family: "reservation-delivery",
  sources: [
    {
      kind: "daily",
      code: "reservation_count",
      reader: reservationCountReader,
    },
    { kind: "daily", code: "no_show_reservations", reader: noShowReader },
    {
      kind: "derived",
      code: "reservation_no_show_pct",
      numerator: "no_show_reservations",
      denominator: "reservation_count",
      scale: 100,
    },
    { kind: "daily", code: "delivery_orders", reader: deliveryOrdersReader },
    { kind: "daily", code: "delivery_sales", reader: deliverySalesReader },
  ],
  splits: [],
};
