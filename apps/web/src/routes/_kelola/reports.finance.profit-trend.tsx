import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/finance/profit-trend — generic report viewer for finance.profit_trend (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/finance/profit-trend")(
  reportRouteOptions("finance.profit_trend"),
);
