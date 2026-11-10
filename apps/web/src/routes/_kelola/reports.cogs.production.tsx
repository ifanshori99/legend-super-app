import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/cogs/production — generic report viewer for cogs.production (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/cogs/production")(
  reportRouteOptions("cogs.production"),
);
