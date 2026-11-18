// Loyalty and CRM families of the report viewer mock: member counts, reviews,
// points and promo cost.
import type { Atoms } from "../mock-day-model.ts";
import { count, idr, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  promo: { from: "discount", ratio: 0.55 },
  newMembers: { from: "pax", ratio: 24 / 148 },
  returning: { from: "pax", ratio: 0.46 },
  reviews: { from: "tx", ratio: 0.1 },
  points: { from: "tx", ratio: 35 },
  members: { from: "pax", snapshot: 1_320 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

/** Mock-only average: nothing in the day model moves it. */
const AVERAGE_REVIEW_RATING = "4.6000";

export function cellFor(metricCode: string, atoms: Figures): Cell | undefined {
  switch (metricCode) {
    case "promo_cost":
      return idr(atoms.promo);
    case "new_customers":
      return count(atoms.newMembers);
    case "active_members":
      return count(atoms.members);
    case "returning_customers":
      return count(atoms.returning);
    case "review_count":
      return count(atoms.reviews);
    case "review_rating":
      return { unit: "decimal", value: AVERAGE_REVIEW_RATING };
    case "points_redeemed":
      return count(atoms.points);
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  loyalty: [
    "loyalty.members",
    "loyalty.new_members",
    "loyalty.points",
    "loyalty.tier_mix",
    "loyalty.visits",
  ],
  crm: [
    "crm.campaign_performance",
    "crm.customers",
    "crm.promo_cost",
    "crm.repeat_visit",
    "crm.reviews",
    "crm.segments",
  ],
} as const;

/** Metrics the API answers `unavailable` (metric registry): the mock shows no number. */
export const unavailableMetrics: ReadonlySet<string> = new Set([
  "points_redeemed",
]);
