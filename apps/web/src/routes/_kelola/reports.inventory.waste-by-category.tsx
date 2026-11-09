import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/inventory/waste-by-category — generic report viewer for inventory.waste_by_category (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/inventory/waste-by-category",
)(reportRouteOptions("inventory.waste_by_category"));
