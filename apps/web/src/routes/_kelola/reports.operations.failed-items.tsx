import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/operations/failed-items — generic report viewer for operations.failed_items (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/operations/failed-items",
)(reportRouteOptions("operations.failed_items"));
