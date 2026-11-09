import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/traffic/peak-hours — generic report viewer for traffic.peak_hours (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/traffic/peak-hours")(
  reportRouteOptions("traffic.peak_hours"),
);
