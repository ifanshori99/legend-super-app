// TL-07 get_customer_segments (bead legend-ktqc). Aggregate only: no customer
// identity or contact field, and a segment under CUSTOMER_SEGMENT_MIN_SIZE is
// never returned (§40 Input Minimum).
//
// Source: active, non-merged `customer_profiles` (lifetime spend, visit count,
// last visit, tier) joined to `loyalty_tiers`. Segment codes and labels are
// fixed here, except a tier label, which is the owner-configured tier name;
// no free text typed by a customer is ever returned. Segments are listed best
// first (top tier, most recent, most frequent, biggest spender).
//
// Reach: `customer_profiles` carries only `home_outlet_id` (nullable), so a
// caller limited to some outlets sees the customers whose home outlet is in
// that reach; customers without a home outlet are counted for tenant-wide
// callers only.
import { sql } from "drizzle-orm";
import {
  CUSTOMER_SEGMENT_MIN_SIZE,
  getCustomerSegmentsInputSchema,
  type GetCustomerSegmentsOutput,
} from "@starter/shared/ai";
import { idr } from "@starter/shared/core";
import { db } from "../../../db/index.ts";
import { withTenant } from "../../../db/tenant.ts";
import type { AiToolHandler } from "../types.ts";
import {
  TOOL_MAX_ROWS,
  outletClause,
  resolveReach,
  scopeOutlets,
  todayPeriod,
} from "./support.ts";

type Bucket = { code: string; label: string };
type GroupRow = { k: string; name: string | null; c: number; a: number };

const DAY_MS = 86_400_000;

/** Bucket keys, best first; the order is the output order. */
const RECENCY: Record<string, Bucket> = {
  "1": { code: "recency-30", label: "Kunjungan terakhir 30 hari terakhir" },
  "2": { code: "recency-90", label: "Kunjungan terakhir 31-90 hari lalu" },
  "3": {
    code: "recency-over-90",
    label: "Kunjungan terakhir lebih dari 90 hari",
  },
  "4": { code: "recency-never", label: "Belum pernah berkunjung" },
};
const FREQUENCY: Record<string, Bucket> = {
  "1": { code: "frequency-10-plus", label: "10 kunjungan atau lebih" },
  "2": { code: "frequency-4-9", label: "4-9 kunjungan" },
  "3": { code: "frequency-1-3", label: "1-3 kunjungan" },
  "4": { code: "frequency-0", label: "Belum ada kunjungan" },
};
const SPEND: Record<string, Bucket> = {
  "1": {
    code: "spend-5m-plus",
    label: "Belanja seumur hidup Rp5.000.000 ke atas",
  },
  "2": {
    code: "spend-1m-5m",
    label: "Belanja seumur hidup Rp1.000.000-4.999.999",
  },
  "3": {
    code: "spend-under-1m",
    label: "Belanja seumur hidup di bawah Rp1.000.000",
  },
};

export const getCustomerSegments: AiToolHandler = async (ctx, raw) => {
  const input = getCustomerSegmentsInputSchema.parse(raw);
  const reach = await resolveReach(ctx, "crm.customer.view", "TL-07");
  const tenantId = ctx.access.tenant.tenantId;
  const recent30 = new Date(ctx.now.getTime() - 30 * DAY_MS).toISOString();
  const recent90 = new Date(ctx.now.getTime() - 90 * DAY_MS).toISOString();
  const homeOutlet = outletClause(
    sql`p.home_outlet_id`,
    scopeOutlets(reach, undefined),
  );

  const rows = await withTenant(db, reach.context, async (tx) => {
    const base = sql`from customer_profiles p
      where p.tenant_id = ${tenantId}::uuid
        and p.membership_status = 'active'
        and p.merged_into_profile_id is null
        ${homeOutlet}`;
    if (input.segmentBy === "tier") {
      return (
        await tx.execute(
          sql`select coalesce(t.rank::text, 'none') k, max(t.name) name,
              count(*)::int c, round(avg(p.lifetime_spend_idr))::float8 a
            from customer_profiles p
            left join loyalty_tiers t
              on t.tenant_id = p.tenant_id and t.id = p.tier_id
            where p.tenant_id = ${tenantId}::uuid
              and p.membership_status = 'active'
              and p.merged_into_profile_id is null
                    ${homeOutlet}
            group by t.rank`,
        )
      ).rows as GroupRow[];
    }
    const key =
      input.segmentBy === "recency"
        ? sql`case
            when p.last_visit_at is null then '4'
            when p.last_visit_at >= ${recent30}::timestamptz then '1'
            when p.last_visit_at >= ${recent90}::timestamptz then '2'
            else '3' end`
        : input.segmentBy === "frequency"
          ? sql`case
              when p.visits_count >= 10 then '1'
              when p.visits_count >= 4 then '2'
              when p.visits_count >= 1 then '3'
              else '4' end`
          : sql`case
              when p.lifetime_spend_idr >= 5000000 then '1'
              when p.lifetime_spend_idr >= 1000000 then '2'
              else '3' end`;
    return (
      await tx.execute(
        sql`select ${key} k, null::text name, count(*)::int c,
            round(avg(p.lifetime_spend_idr))::float8 a
          ${base}
          group by 1`,
      )
    ).rows as GroupRow[];
  });

  const buckets =
    input.segmentBy === "recency"
      ? RECENCY
      : input.segmentBy === "frequency"
        ? FREQUENCY
        : SPEND;
  const ordered = rows
    .filter((row) => Number(row.c) >= CUSTOMER_SEGMENT_MIN_SIZE)
    .map((row) => {
      if (input.segmentBy === "tier") {
        const rank = row.k === "none" ? null : Number(row.k);
        return {
          // Higher rank first, customers without a tier last.
          order: rank === null ? Number.MAX_SAFE_INTEGER : -rank,
          code: rank === null ? "tier-none" : `tier-${rank}`,
          label: rank === null ? "Tanpa tier" : (row.name ?? `Tier ${rank}`),
          row,
        };
      }
      const bucket = buckets[row.k]!;
      return { order: Number(row.k), ...bucket, row };
    })
    .sort((a, b) => a.order - b.order);
  const segments = ordered.slice(0, TOOL_MAX_ROWS).map((entry) => ({
    code: entry.code,
    label: entry.label,
    customerCount: Number(entry.row.c),
    avgSpendIdr: idr(Number(entry.row.a)),
  }));

  const output: GetCustomerSegmentsOutput = {
    segmentBy: input.segmentBy,
    segments,
    truncated: ordered.length > segments.length,
    sources: [
      {
        label: "Segmen pelanggan (profil member aktif)",
        period: todayPeriod(ctx.now),
        finality: "estimate",
        link: "/pelanggan/segmen",
      },
    ],
  };
  return output;
};
