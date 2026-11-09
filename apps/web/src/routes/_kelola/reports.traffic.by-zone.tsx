import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/traffic/by-zone — generic report viewer for traffic.by_zone (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/traffic/by-zone")(
  reportRouteOptions("traffic.by_zone"),
);
