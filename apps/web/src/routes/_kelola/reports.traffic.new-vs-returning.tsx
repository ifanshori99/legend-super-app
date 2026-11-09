import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/traffic/new-vs-returning — generic report viewer for traffic.new_vs_returning (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/traffic/new-vs-returning",
)(reportRouteOptions("traffic.new_vs_returning"));
