import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payroll/gross — generic report viewer for payroll.gross (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/payroll/gross")(
  reportRouteOptions("payroll.gross"),
);
