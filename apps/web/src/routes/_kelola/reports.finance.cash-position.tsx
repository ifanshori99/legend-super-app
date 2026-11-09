import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/finance/cash-position — generic report viewer for finance.cash_position (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/finance/cash-position")(
  reportRouteOptions("finance.cash_position"),
);
