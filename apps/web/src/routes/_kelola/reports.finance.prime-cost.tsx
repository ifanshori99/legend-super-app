import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/finance/prime-cost — generic report viewer for finance.prime_cost (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/finance/prime-cost")(
  reportRouteOptions("finance.prime_cost"),
);
