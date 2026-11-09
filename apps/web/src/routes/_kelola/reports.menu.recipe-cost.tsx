import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/menu/recipe-cost — generic report viewer for menu.recipe_cost (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/menu/recipe-cost")(
  reportRouteOptions("menu.recipe_cost"),
);
