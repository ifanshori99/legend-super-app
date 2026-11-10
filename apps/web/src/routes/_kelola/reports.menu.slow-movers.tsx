import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/menu/slow-movers — generic report viewer for menu.slow_movers (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/menu/slow-movers")(
  reportRouteOptions("menu.slow_movers"),
);
