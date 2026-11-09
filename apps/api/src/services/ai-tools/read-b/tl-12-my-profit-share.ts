// TL-12 get_my_profit_share (bead legend-ktqc). Own distributions only: there
// is no shareholder id in the input, the caller is `ctx.access.userId`.
//
// GAP: no profit-share registry or distribution table exists yet (accounting
// has only the `distributionRunStatus` contract), so the handler returns the
// contract's empty shape after the permission check.
import {
  getMyProfitShareInputSchema,
  type GetMyProfitShareOutput,
  type ToolPeriod,
} from "@starter/shared/ai";
import type { AiToolHandler } from "../types.ts";
import { resolveReach } from "./support.ts";

export const getMyProfitShare: AiToolHandler = async (ctx, raw) => {
  const input = getMyProfitShareInputSchema.parse(raw);
  await resolveReach(ctx, "profit_share.own.view", "TL-12");
  const year = input.year ?? ctx.now.getUTCFullYear();
  const output: GetMyProfitShareOutput = {
    distributions: [],
    truncated: false,
    sources: [
      {
        label: `Bagi hasil ${year} (data distribusi belum tersedia)`,
        period: { from: `${year}-01-01`, to: `${year}-12-31` } as ToolPeriod,
        finality: "final",
        link: "/pemegang-saham/bagi-hasil",
      },
    ],
  };
  return output;
};
