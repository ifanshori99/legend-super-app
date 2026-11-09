import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/by-category — generic report viewer for sales.by_category (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/by-category")(
  reportRouteOptions("sales.by_category"),
);
