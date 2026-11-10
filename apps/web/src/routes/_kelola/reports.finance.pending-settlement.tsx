import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/finance/pending-settlement — generic report viewer for finance.pending_settlement (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/finance/pending-settlement",
)(reportRouteOptions("finance.pending_settlement"));
