import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/finance/income-statement — generic report viewer for finance.income_statement (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/finance/income-statement",
)(reportRouteOptions("finance.income_statement"));
