import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/per-employee — generic report viewer for sales.per_employee (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/per-employee")(
  reportRouteOptions("sales.per_employee"),
);
