import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/per-pax — generic report viewer for sales.per_pax (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/per-pax")(
  reportRouteOptions("sales.per_pax"),
);
