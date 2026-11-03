import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/refund — generic report viewer for sales.refund (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/refund")(
  reportRouteOptions("sales.refund"),
);
