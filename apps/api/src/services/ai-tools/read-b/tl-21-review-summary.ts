// TL-21 get_review_summary (bead legend-39d.5, AI-11). Aggregates of
// customer_reviews per outlet for a period (outlet business days):
// review count, average rating, 1..5 star distribution and mention counts for
// a fixed theme lexicon. Reviews hidden by moderation never count.
// The review text is matched inside the database and never leaves it: the
// output carries counts only, no text, name, phone or customer id.
import { sql } from "drizzle-orm";
import {
  REVIEW_THEMES,
  getReviewSummaryInputSchema,
  type GetReviewSummaryOutput,
  type ReviewTheme,
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
  forbidden,
  outletClause,
  resolveReach,
  scopeOutlets,
} from "./support.ts";

/** Fixed lexicon (Indonesian), POSIX regex alternatives matched at a word start. */
export const REVIEW_THEME_LEXICON: Record<ReviewTheme, string> = {
  makanan: "(makanan|masakan|menu|rasa|enak|lezat|porsi|minuman|kopi)",
  pelayanan: "(pelayanan|layanan|pelayan|ramah|staf|staff|kasir|sigap)",
  harga: "(harga|mahal|murah|promo|diskon)",
  kebersihan: "(bersih|kotor|kebersihan|jorok|toilet)",
  waktu_tunggu: "(menunggu|nunggu|antre|antri|lambat|waktu tunggu|lama sekali)",
};

type OutletRow = {
  id: string;
  name: string;
  timezone: string;
  business_day_cutoff: string;
};
type StatRow = {
  review_count: number;
  rating_sum: number;
  star1: number;
  star2: number;
  star3: number;
  star4: number;
  star5: number;
  makanan: number;
  pelayanan: number;
  harga: number;
  kebersihan: number;
  waktu_tunggu: number;
};

/** `count(*) filter (where body ~* '\m<lexicon>')` for one theme. */
const themeCount = (theme: ReviewTheme) =>
  sql`count(*) filter (where body ~* ${`\\m${REVIEW_THEME_LEXICON[theme]}`})::int`;

export const getReviewSummary: AiToolHandler = async (ctx, raw) => {
  const input = getReviewSummaryInputSchema.parse(raw);
  const reach = await resolveReach(ctx, "review.respond", "TL-21");
  const wanted = scopeOutlets(reach, input.outletIds);
  const tenantId = ctx.access.tenant.tenantId;

  const found = await withTenant(db, reach.context, async (tx) => {
    // An outlet that is not this tenant's is denied, never dropped: a
    // whole-tenant reach does not list outlet ids, so scopeOutlets cannot
    // tell a foreign outlet from an empty one.
    if (input.outletIds !== undefined && wanted !== null && wanted.length > 0) {
      const known = (
        await tx.execute(sql`
          select count(*)::int as n from outlets o
          where o.tenant_id = ${tenantId}::uuid
          ${outletClause(sql`o.id`, wanted)}
        `)
      ).rows[0] as { n: number } | undefined;
      if (Number(known?.n ?? 0) !== wanted.length) throw forbidden();
    }
    const outletRows = (
      await tx.execute(sql`
        select o.id, o.name, o.timezone, o.business_day_cutoff
        from outlets o
        where o.tenant_id = ${tenantId}::uuid
        ${outletClause(sql`o.id`, wanted)}
        order by o.code, o.id
        limit ${TOOL_MAX_ROWS + 1}
      `)
    ).rows as OutletRow[];

    const result: { outlet: OutletRow; stat: StatRow }[] = [];
    for (const outlet of outletRows) {
      const clock: BusinessDayClock = {
        timeZone: outlet.timezone,
        cutoff: outlet.business_day_cutoff,
      };
      const start = businessDayRange(
        input.period.from as BusinessDate,
        clock,
      ).start;
      const end = businessDayRange(input.period.to as BusinessDate, clock).end;
      const stat = (
        await tx.execute(sql`
          select count(*)::int as review_count,
            coalesce(sum(rating), 0)::int as rating_sum,
            count(*) filter (where rating = 1)::int as star1,
            count(*) filter (where rating = 2)::int as star2,
            count(*) filter (where rating = 3)::int as star3,
            count(*) filter (where rating = 4)::int as star4,
            count(*) filter (where rating = 5)::int as star5,
            ${themeCount("makanan")} as makanan,
            ${themeCount("pelayanan")} as pelayanan,
            ${themeCount("harga")} as harga,
            ${themeCount("kebersihan")} as kebersihan,
            ${themeCount("waktu_tunggu")} as waktu_tunggu
          from customer_reviews
          where tenant_id = ${tenantId}::uuid and outlet_id = ${outlet.id}::uuid
            and moderation_status <> 'hidden'
            and created_at >= ${start.toISOString()}::timestamptz
            and created_at < ${end.toISOString()}::timestamptz
        `)
      ).rows[0] as StatRow | undefined;
      if (stat && Number(stat.review_count) > 0) result.push({ outlet, stat });
    }
    return { result, truncated: outletRows.length > TOOL_MAX_ROWS };
  });

  const output: GetReviewSummaryOutput = {
    rows: found.result.slice(0, TOOL_MAX_ROWS).map(({ outlet, stat }) => {
      const count = Number(stat.review_count);
      // Average scaled by 10^4, rounded half up, from integer sums only.
      const average = BigInt(
        Math.floor(
          (Number(stat.rating_sum) * 10_000 * 2 + count) / (2 * count),
        ),
      );
      return {
        outletId: outlet.id,
        outletName: outlet.name,
        reviewCount: count,
        averageRating: formatDecimal4(average),
        ratingDistribution: {
          "1": Number(stat.star1),
          "2": Number(stat.star2),
          "3": Number(stat.star3),
          "4": Number(stat.star4),
          "5": Number(stat.star5),
        },
        themes: REVIEW_THEMES.map((theme) => ({
          theme,
          mentions: Number(stat[theme]),
        })),
      };
    }) as GetReviewSummaryOutput["rows"],
    truncated: found.truncated,
    sources: [
      {
        label: "Ringkasan ulasan",
        period: input.period,
        finality: "estimate",
        link: "/kelola/ulasan",
      },
    ],
  };
  return output;
};
