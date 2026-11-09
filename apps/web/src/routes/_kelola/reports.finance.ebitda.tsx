import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/finance/ebitda — generic report viewer for finance.ebitda (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/finance/ebitda")(
  reportRouteOptions("finance.ebitda"),
);
