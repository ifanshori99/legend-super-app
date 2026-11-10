import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/cogs/trend — generic report viewer for cogs.trend (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/cogs/trend")(
  reportRouteOptions("cogs.trend"),
);
