import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/loyalty/tier-mix — generic report viewer for loyalty.tier_mix (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/loyalty/tier-mix")(
  reportRouteOptions("loyalty.tier_mix"),
);
