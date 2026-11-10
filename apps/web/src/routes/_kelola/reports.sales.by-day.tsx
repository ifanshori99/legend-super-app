import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/by-day — generic report viewer for sales.by_day (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/by-day")(
  reportRouteOptions("sales.by_day"),
);
