import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payroll/overtime — generic report viewer for payroll.overtime (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/payroll/overtime")(
  reportRouteOptions("payroll.overtime"),
);
