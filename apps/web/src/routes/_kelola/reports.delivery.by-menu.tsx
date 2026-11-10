import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/delivery/by-menu — generic report viewer for delivery.by_menu (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/delivery/by-menu")(
  reportRouteOptions("delivery.by_menu"),
);
