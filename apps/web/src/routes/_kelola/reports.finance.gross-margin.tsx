import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/finance/gross-margin — generic report viewer for finance.gross_margin (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/finance/gross-margin")(
  reportRouteOptions("finance.gross_margin"),
);
