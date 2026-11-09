import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/traffic/pax — generic report viewer for traffic.pax (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/traffic/pax")(
  reportRouteOptions("traffic.pax"),
);
