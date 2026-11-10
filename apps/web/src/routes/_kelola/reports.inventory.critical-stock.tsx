import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/inventory/critical-stock — generic report viewer for inventory.critical_stock (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/inventory/critical-stock",
)(reportRouteOptions("inventory.critical_stock"));
