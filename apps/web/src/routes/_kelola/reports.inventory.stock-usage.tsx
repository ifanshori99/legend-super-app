import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/inventory/stock-usage — generic report viewer for inventory.stock_usage (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/inventory/stock-usage")(
  reportRouteOptions("inventory.stock_usage"),
);
