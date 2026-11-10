import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/crm/promo-cost — generic report viewer for crm.promo_cost (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/crm/promo-cost")(
  reportRouteOptions("crm.promo_cost"),
);
