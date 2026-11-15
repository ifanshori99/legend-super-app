// TL-11 get_anomalies (bead legend-ktqc). Rule based, from existing data only:
// for each outlet and type the period is compared with the previous period of
// the same length (the baseline). A row is raised when the period holds at
// least MIN_EVENTS events and the observed value is at least twice the
// baseline. Observed/baseline are counts for void and refund, and rupiah for
// discount, cash_variance and ingredient_usage (waste value + negative stock-count variance).
import { sql } from "drizzle-orm";
import {
  ANOMALY_TYPES,
  getAnomaliesInputSchema,
  type GetAnomaliesOutput,
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
  daysInPeriod,
  outletClause,
  resolveReach,
  scopeOutlets,
} from "./support.ts";

export const ANOMALY_MIN_EVENTS = 3;
const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

type AnomalyType = (typeof ANOMALY_TYPES)[number];
type Stat = { count: number; value: number; last: Date | null };
const NONE: Stat = { count: 0, value: 0, last: null };

type OutletRow = { id: string; timezone: string; business_day_cutoff: string };
type StatRow = { c: number; v: number; m: string | Date | null };
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

const stat = (row: StatRow | undefined): Stat =>
  row
    ? {
        count: Number(row.c),
        value: Number(row.v),
        last: row.m === null ? null : new Date(row.m),
      }
    : NONE;

async function one(tx: Tx, query: ReturnType<typeof sql>): Promise<Stat> {
  const result = await tx.execute(query);
  return stat(result.rows[0] as StatRow | undefined);
}

/** Observed value of an anomaly type: counts for void/refund, rupiah otherwise. */
const measure = (type: AnomalyType, s: Stat): number =>
  type === "void" || type === "refund" ? s.count : s.value;

async function windowStat(
  tx: Tx,
  tenantId: string,
  outletId: string,
  type: AnomalyType,
  start: Date,
  end: Date,
): Promise<Stat> {
  const from = start.toISOString();
  const to = end.toISOString();
  switch (type) {
    case "void":
      return one(
        tx,
        sql`select count(*)::int c, coalesce(sum(amount_idr), 0)::float8 v, max(voided_at) m
          from pos_order_voids
          where tenant_id = ${tenantId}::uuid and outlet_id = ${outletId}::uuid
            and voided_at >= ${from}::timestamptz and voided_at < ${to}::timestamptz`,
      );
    case "refund":
      return one(
        tx,
        sql`select count(*)::int c, coalesce(sum(r.amount_idr + coalesce((
            select sum(d.amount_idr) from pos_deposit_refunds d
             where d.tenant_id = r.tenant_id and d.pos_refund_id = r.id
          ), 0)), 0)::float8 v, max(r.refunded_at) m
          from pos_order_refunds r
          where r.tenant_id = ${tenantId}::uuid and r.outlet_id = ${outletId}::uuid
            and r.refunded_at >= ${from}::timestamptz and r.refunded_at < ${to}::timestamptz`,
      );
    case "discount":
      return one(
        tx,
        sql`select count(*)::int c, coalesce(sum(amount_idr), 0)::float8 v, max(created_at) m
          from pos_order_discounts
          where tenant_id = ${tenantId}::uuid and outlet_id = ${outletId}::uuid
            and removed_at is null
            and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz`,
      );
    case "ingredient_usage": {
      const waste = await one(
        tx,
        sql`select count(*)::int c, coalesce(sum(value_idr), 0)::float8 v, max(occurred_at) m
          from waste_logs
          where tenant_id = ${tenantId}::uuid and outlet_id = ${outletId}::uuid
            and occurred_at >= ${from}::timestamptz and occurred_at < ${to}::timestamptz`,
      );
      const shrink = await one(
        tx,
        sql`select count(*)::int c, coalesce(sum(-l.variance_idr), 0)::float8 v, max(c.posted_at) m
          from stock_count_lines l
          join stock_counts c on c.tenant_id = l.tenant_id and c.id = l.stock_count_id
          where l.tenant_id = ${tenantId}::uuid and l.outlet_id = ${outletId}::uuid
            and l.variance_idr < 0
            and c.posted_at >= ${from}::timestamptz and c.posted_at < ${to}::timestamptz`,
      );
      const last = [waste.last, shrink.last]
        .filter((date): date is Date => date !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        count: waste.count + shrink.count,
        value: waste.value + shrink.value,
        last: last ?? null,
      };
    }
    case "cash_variance":
      return one(
        tx,
        sql`select count(*)::int c, coalesce(sum(abs(variance_idr)), 0)::float8 v, max(closed_at) m
          from pos_shifts
          where tenant_id = ${tenantId}::uuid and outlet_id = ${outletId}::uuid
            and status = 'closed' and variance_idr <> 0
            and closed_at >= ${from}::timestamptz and closed_at < ${to}::timestamptz`,
      );
    default:
      return NONE;
  }
}

const LABEL: Record<AnomalyType, string> = {
  void: "void",
  discount: "diskon",
  refund: "refund",
  cash_variance: "selisih kas",
  ingredient_usage: "pemakaian bahan",
};

const decimal = (value: number) =>
  formatDecimal4(BigInt(Math.max(0, Math.round(value))) * 10_000n);

function severityOf(ratio: number, count: number): "low" | "medium" | "high" {
  if (ratio >= 4 || count >= 10) return "high";
  if (ratio >= 3) return "medium";
  return "low";
}

export const getAnomalies: AiToolHandler = async (ctx, raw) => {
  const input = getAnomaliesInputSchema.parse(raw);
  const reach = await resolveReach(ctx, "report.operational.view", "TL-11");
  const wanted = scopeOutlets(reach, input.outletIds);
  const types = input.types ?? [
    "void",
    "discount",
    "refund",
    "cash_variance",
    "ingredient_usage",
  ];
  const tenantId = ctx.access.tenant.tenantId;
  const days = daysInPeriod(input.period);
  const baselinePeriod = {
    from: addDays(input.period.from, -days),
    to: addDays(input.period.from, -1),
  };

  const anomalies: GetAnomaliesOutput["anomalies"] = [];
  await withTenant(db, reach.context, async (tx) => {
    const outletRows = (
      await tx.execute(sql`
        select id, timezone, business_day_cutoff from outlets
        where tenant_id = ${tenantId}::uuid
        ${outletClause(sql`id`, wanted)}
        order by code, id
      `)
    ).rows as OutletRow[];
    for (const outlet of outletRows) {
      const clock: BusinessDayClock = {
        timeZone: outlet.timezone,
        cutoff: outlet.business_day_cutoff,
      };
      const current = {
        start: businessDayRange(input.period.from, clock).start,
        end: businessDayRange(input.period.to, clock).end,
      };
      const baseline = {
        start: businessDayRange(baselinePeriod.from as BusinessDate, clock)
          .start,
        end: businessDayRange(baselinePeriod.to as BusinessDate, clock).end,
      };
      for (const type of types) {
        const observed = await windowStat(
          tx,
          tenantId,
          outlet.id,
          type,
          current.start,
          current.end,
        );
        if (observed.count < ANOMALY_MIN_EVENTS) continue;
        const previous = await windowStat(
          tx,
          tenantId,
          outlet.id,
          type,
          baseline.start,
          baseline.end,
        );
        const now = measure(type, observed);
        const before = measure(type, previous);
        if (now < 2 * before) continue;
        const ratio = before > 0 ? now / before : Number.POSITIVE_INFINITY;
        const unit = type === "void" || type === "refund" ? "kali" : "rupiah";
        anomalies.push({
          type,
          outletId: outlet.id,
          detectedAt: (observed.last ?? current.end).toISOString(),
          severity: severityOf(ratio, observed.count),
          observedValue: decimal(now),
          baselineValue: decimal(before),
          description: `${LABEL[type]} ${Math.round(now)} ${unit} pada periode ini, baseline ${Math.round(before)} ${unit} pada periode sebelumnya (${baselinePeriod.from} s/d ${baselinePeriod.to}).`,
          link: "/laporan/anomali",
        } as GetAnomaliesOutput["anomalies"][number]);
      }
    }
  });

  anomalies.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.detectedAt.localeCompare(a.detectedAt),
  );
  const output: GetAnomaliesOutput = {
    anomalies: anomalies.slice(0, TOOL_MAX_ROWS),
    truncated: anomalies.length > TOOL_MAX_ROWS,
    sources: [
      {
        label: "Deteksi anomali",
        period: input.period,
        finality: "estimate",
        link: "/laporan/anomali",
      },
    ],
  };
  return output;
};
