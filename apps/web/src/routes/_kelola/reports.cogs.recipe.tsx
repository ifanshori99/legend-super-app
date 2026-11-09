import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/cogs/recipe — generic report viewer for cogs.recipe (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/cogs/recipe")(
  reportRouteOptions("cogs.recipe"),
);
