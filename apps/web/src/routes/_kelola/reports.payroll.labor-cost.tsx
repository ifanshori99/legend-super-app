import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payroll/labor-cost — generic report viewer for payroll.labor_cost (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/payroll/labor-cost")(
  reportRouteOptions("payroll.labor_cost"),
);
