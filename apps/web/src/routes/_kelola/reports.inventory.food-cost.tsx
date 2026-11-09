import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/inventory/food-cost — generic report viewer for inventory.food_cost (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/inventory/food-cost")(
  reportRouteOptions("inventory.food_cost"),
);
