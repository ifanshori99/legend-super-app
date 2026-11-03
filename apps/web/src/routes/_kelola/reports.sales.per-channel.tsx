import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/sales/per-channel — generic report viewer for sales.per_channel (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/sales/per-channel")(
  reportRouteOptions("sales.per_channel"),
);
