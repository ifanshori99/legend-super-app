import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/cogs/per-menu — generic report viewer for cogs.per_menu (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/cogs/per-menu")(
  reportRouteOptions("cogs.per_menu"),
);
