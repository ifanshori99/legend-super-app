import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/transactions — generic report viewer for sales.transactions (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/transactions")(
  reportRouteOptions("sales.transactions"),
);
