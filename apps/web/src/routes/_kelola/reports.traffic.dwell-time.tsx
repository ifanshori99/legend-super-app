import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/traffic/dwell-time — generic report viewer for traffic.dwell_time (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/traffic/dwell-time")(
  reportRouteOptions("traffic.dwell_time"),
);
