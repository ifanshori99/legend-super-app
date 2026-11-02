import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/per-menu — generic report viewer for sales.per_menu (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/per-menu")(
  reportRouteOptions("sales.per_menu"),
);
