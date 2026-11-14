// TL-12 get_my_profit_share (bead legend-ktqc). Own distributions only: there
// is no shareholder id in the input, the caller is `ctx.access.userId`.
//
// Source: the F35 "Bagi Hasil Pribadi" service (`getMyProfitShareService`),
// which already filters by the caller's own shareholder row and own paid
// lines. Only its paid statements leave here, as stated: amounts and basis
// points are copied, never recomputed or rounded again. Running estimates
// (`estimates`) are not read, so no row is ever an unapproved figure.
import {
  getMyProfitShareInputSchema,
  type GetMyProfitShareOutput,
  type ToolPeriod,
} from "@starter/shared/ai";
import { formatDecimal4 } from "@starter/shared/core";
import { HttpError } from "../../../lib/http-error.ts";
import { getMyProfitShareService } from "../../profit-share-distribution.service.ts";
import type { AiToolHandler } from "../types.ts";
import { resolveReach, TOOL_MAX_ROWS } from "./support.ts";

const LABEL_MAX = 200;

/** "Bagi hasil 2026-03 · <entitas>": the entity name (set by the owner, not
 * personal data) tells apart two entities paying in the same period. */
function periodLabelOf(statement: {
  runType: string;
  period: string;
  profitEntityName: string;
}): string {
  const head = `${statement.runType === "adjustment" ? "Koreksi bagi hasil" : "Bagi hasil"} ${statement.period}`;
  const name = statement.profitEntityName
    .trim()
    .slice(0, LABEL_MAX - head.length - 3)
    .trim();
  return name ? `${head} · ${name}` : head;
}

export const getMyProfitShare: AiToolHandler = async (ctx, raw) => {
  const input = getMyProfitShareInputSchema.parse(raw);
  const reach = await resolveReach(ctx, "profit_share.own.view", "TL-12");
  const year = input.year ?? ctx.now.getUTCFullYear();

  const mine = await getMyProfitShareService(
    reach.context,
    ctx.access.userId,
    ctx.now,
  ).catch((error: unknown) => {
    // Not (or no longer) a shareholder: nothing of their own to show.
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  });

  const prefix = `${year}-`;
  const statements = (mine?.distributionHistory ?? [])
    .filter(
      (statement) =>
        statement.paymentStatus === "paid" &&
        statement.period.startsWith(prefix),
    )
    .sort(
      (a, b) =>
        a.period.localeCompare(b.period) ||
        a.profitEntityName.localeCompare(b.profitEntityName) ||
        (a.paidAt ?? "").localeCompare(b.paidAt ?? "") ||
        a.distributionLineId.localeCompare(b.distributionLineId),
    );

  const output: GetMyProfitShareOutput = {
    distributions: statements.slice(0, TOOL_MAX_ROWS).map((statement) => ({
      periodLabel: periodLabelOf(statement),
      // Basis points / 100 = percent, exact at 4 decimals (no rounding).
      sharePct: formatDecimal4(BigInt(statement.shareBp) * 100n),
      // What the shareholder receives: gross less tax withheld (carry is
      // already out of gross).
      amountIdr: statement.netIdr,
      status: "paid" as const,
    })),
    truncated: statements.length > TOOL_MAX_ROWS,
    sources: [
      {
        label: `Bagi hasil ${year} (pernyataan terbayar)`,
        period: { from: `${year}-01-01`, to: `${year}-12-31` } as ToolPeriod,
        finality: "final",
        link: "/pemegang-saham/bagi-hasil",
      },
    ],
  };
  return output;
};
