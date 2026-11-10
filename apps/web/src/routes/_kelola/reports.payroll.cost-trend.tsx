import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payroll/cost-trend — generic report viewer for payroll.cost_trend (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/payroll/cost-trend")(
  reportRouteOptions("payroll.cost_trend"),
);
