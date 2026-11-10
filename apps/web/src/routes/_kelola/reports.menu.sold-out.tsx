import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/menu/sold-out — generic report viewer for menu.sold_out (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/menu/sold-out")(
  reportRouteOptions("menu.sold_out"),
);
