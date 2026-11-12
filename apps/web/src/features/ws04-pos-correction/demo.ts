// `?demo=<seed>` for the correction mock (VITE_API_MOCK=true only; components
// never read it). The kasir mock's demo lines are all sent to the kitchen, so
// the "void sebelum dapur" screen needs a line that was not.
//
//   ?demo=belum-dapur   the first line of the order is held (not in the kitchen yet)
//
// The kasir mock engine reads the same `?demo=` and ignores values it does not
// know, so this seed leaves its own seeds alone.
import type { PosOrderDetail } from "@starter/shared/pos";
import { readDemoSeed } from "../ws04-pos-kasir/demo-seed";

export const CORRECTION_DEMO_SEEDS = ["belum-dapur"] as const;
export type CorrectionDemoSeed = (typeof CORRECTION_DEMO_SEEDS)[number];

export function correctionDemoSeed(
  raw: string | null,
): CorrectionDemoSeed | null {
  return (CORRECTION_DEMO_SEEDS as readonly string[]).includes(raw ?? "")
    ? (raw as CorrectionDemoSeed)
    : null;
}

/** The order the mock answered, adjusted for the page's demo seed. */
export function applyCorrectionDemo(order: PosOrderDetail): PosOrderDetail {
  if (correctionDemoSeed(readDemoSeed()) !== "belum-dapur") return order;
  return {
    ...order,
    items: order.items.map((item, index) =>
      index === 0
        ? { ...item, fireStatus: "held", firedAt: null, status: "queued" }
        : item,
    ),
  };
}
