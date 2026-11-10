import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/operations/table-turnover — generic report viewer for operations.table_turnover (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/operations/table-turnover",
)(reportRouteOptions("operations.table_turnover"));
