// TL-07 get_customer_segments (bead legend-ktqc). Aggregate only: no customer
// identity or contact field, and a segment under CUSTOMER_SEGMENT_MIN_SIZE is
// never returned (§40 Input Minimum).
//
// GAP: the schema has no customer / loyalty / tier table yet (WS CRM customer
// profile is not built), so there is nothing to aggregate. The handler still
// enforces the permission and reach, and returns the contract's empty shape
// with its source, so the answer says "no segment data" instead of guessing.
import {
  getCustomerSegmentsInputSchema,
  type GetCustomerSegmentsOutput,
} from "@starter/shared/ai";
import type { AiToolHandler } from "../types.ts";
import { resolveReach, todayPeriod } from "./support.ts";

export const getCustomerSegments: AiToolHandler = async (ctx, raw) => {
  const input = getCustomerSegmentsInputSchema.parse(raw);
  await resolveReach(ctx, "crm.customer.view", "TL-07");
  const output: GetCustomerSegmentsOutput = {
    segmentBy: input.segmentBy,
    segments: [],
    truncated: false,
    sources: [
      {
        label: "Segmen pelanggan (data pelanggan belum tersedia)",
        period: todayPeriod(ctx.now),
        finality: "estimate",
        link: "/pelanggan/segmen",
      },
    ],
  };
  return output;
};
