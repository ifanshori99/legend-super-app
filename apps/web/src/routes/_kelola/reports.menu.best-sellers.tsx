import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/menu/best-sellers — generic report viewer for menu.best_sellers (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/menu/best-sellers")(
  reportRouteOptions("menu.best_sellers"),
);
