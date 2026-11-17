// TL-20 get_facility_utilization (bead legend-ktqc). Per facility for a
// period: sessions, utilization percent and revenue.
// - sessions: tickets in status issued / in_use / completed that start in the
//   period (outlet business days, owner Q39); holds, no-shows and cancelled
//   or refunded tickets do not count.
// - utilization: booked minutes (ends_at - starts_at) over available minutes
//   (units x operating hours of every day in the period), capped at 100%.
// - revenue: product price of `purchase` tickets plus overtime fees. Tickets
//   paid by package, subscription or tier benefit carry no price here (their
//   revenue is booked when the package or plan is sold).
// facility-slots.service.ts owns slot holds only and has no usage report, so
// the aggregate reads the same tables (access_tickets, facilities, units).
import { sql } from "drizzle-orm";
import {
  getFacilityUtilizationInputSchema,
  type GetFacilityUtilizationOutput,
} from "@starter/shared/ai";
import {
  businessDayRange,
  formatDecimal4,
  type BusinessDate,
  type BusinessDayClock,
} from "@starter/shared/core";
import { db } from "../../../db/index.ts";
import { withTenant } from "../../../db/tenant.ts";
import type { AiToolHandler } from "../types.ts";
import {
  TOOL_MAX_ROWS,
  addDays,
  assertKnownOutlets,
  outletClause,
  resolveReach,
  scopeOutlets,
} from "./support.ts";

type FacilityRow = {
  id: string;
  name: string;
  outlet_id: string;
  operating_hours: {
    daysOfWeek: number[];
    opensAt: string;
    closesAt: string;
  }[];
  timezone: string;
  business_day_cutoff: string;
  unit_count: number;
};
type UsageRow = {
  facility_id: string;
  sessions: number;
  booked_minutes: number;
  revenue: number;
};

const minutesOf = (time: string) => {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
};

/** Operating minutes of one facility over [from, to], per unit. */
function openMinutes(
  hours: FacilityRow["operating_hours"],
  from: string,
  to: string,
): number {
  let total = 0;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const day of hours)
      if (day.daysOfWeek.includes(weekday))
        total += minutesOf(day.closesAt) - minutesOf(day.opensAt);
  }
  return total;
}

export const getFacilityUtilization: AiToolHandler = async (ctx, raw) => {
  const input = getFacilityUtilizationInputSchema.parse(raw);
  const reach = await resolveReach(ctx, "report.operational.view", "TL-20");
  const wanted = scopeOutlets(reach, input.outletIds);
  const tenantId = ctx.access.tenant.tenantId;

  const rows = await withTenant(db, reach.context, async (tx) => {
    // An outlet that is not this tenant's is denied, never dropped.
    await assertKnownOutlets(tx, tenantId, input.outletIds, wanted);
    const facilities = (
      await tx.execute(sql`
        select f.id, f.name, f.outlet_id, f.operating_hours, o.timezone, o.business_day_cutoff,
          (select count(*)::int from facility_units u
            where u.tenant_id = f.tenant_id and u.facility_id = f.id) as unit_count
        from facilities f
        join outlets o on o.tenant_id = f.tenant_id and o.id = f.outlet_id
        where f.tenant_id = ${tenantId}::uuid
        ${outletClause(sql`f.outlet_id`, wanted)}
        ${input.facilityId ? sql`and f.id = ${input.facilityId}::uuid` : sql``}
        order by o.code, f.name, f.id
        limit ${TOOL_MAX_ROWS + 1}
      `)
    ).rows as FacilityRow[];

    const usageByOutlet = new Map<string, Map<string, UsageRow>>();
    for (const outletId of new Set(facilities.map((f) => f.outlet_id))) {
      const sample = facilities.find((f) => f.outlet_id === outletId)!;
      const clock: BusinessDayClock = {
        timeZone: sample.timezone,
        cutoff: sample.business_day_cutoff,
      };
      const start = businessDayRange(
        input.period.from as BusinessDate,
        clock,
      ).start;
      const end = businessDayRange(input.period.to as BusinessDate, clock).end;
      const usage = (
        await tx.execute(sql`
          select t.facility_id,
            count(*)::int as sessions,
            coalesce(sum(extract(epoch from (t.ends_at - t.starts_at)) / 60), 0)::float8 as booked_minutes,
            coalesce(sum(case when t.source = 'purchase' then coalesce(p.price_idr, 0) else 0 end
              + t.overtime_fee_idr), 0)::float8 as revenue
          from access_tickets t
          left join facility_products p on p.tenant_id = t.tenant_id and p.id = t.product_id
          where t.tenant_id = ${tenantId}::uuid and t.outlet_id = ${outletId}::uuid
            and t.status in ('issued', 'in_use', 'completed')
            and t.starts_at >= ${start.toISOString()}::timestamptz
            and t.starts_at < ${end.toISOString()}::timestamptz
          group by t.facility_id
        `)
      ).rows as UsageRow[];
      usageByOutlet.set(
        outletId,
        new Map(usage.map((u) => [u.facility_id, u])),
      );
    }
    return facilities.map((facility) => ({
      facility,
      usage: usageByOutlet.get(facility.outlet_id)?.get(facility.id),
    }));
  });

  const MAX_PERCENT = 1_000_000n; // 100.0000 percent, scaled by 10^4
  const output: GetFacilityUtilizationOutput = {
    rows: rows.slice(0, TOOL_MAX_ROWS).map(({ facility, usage }) => {
      const available =
        openMinutes(
          facility.operating_hours,
          input.period.from,
          input.period.to,
        ) * facility.unit_count;
      const booked = Math.round(Number(usage?.booked_minutes ?? 0));
      const percent =
        available > 0 ? (BigInt(booked) * 1_000_000n) / BigInt(available) : 0n;
      return {
        facilityId: facility.id,
        name: facility.name,
        sessions: Number(usage?.sessions ?? 0),
        utilizationPct: formatDecimal4(
          percent > MAX_PERCENT ? MAX_PERCENT : percent,
        ),
        revenueIdr: Math.round(Number(usage?.revenue ?? 0)),
      };
    }) as GetFacilityUtilizationOutput["rows"],
    truncated: rows.length > TOOL_MAX_ROWS,
    sources: [
      {
        label: "Pemakaian fasilitas",
        period: input.period,
        finality: "estimate",
        link: "/laporan/fasilitas",
      },
    ],
  };
  return output;
};
