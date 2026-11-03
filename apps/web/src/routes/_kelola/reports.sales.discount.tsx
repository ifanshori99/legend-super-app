import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/discount — generic report viewer for sales.discount (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/discount")(
  reportRouteOptions("sales.discount"),
);
