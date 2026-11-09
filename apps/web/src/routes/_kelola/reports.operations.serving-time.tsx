import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/operations/serving-time — generic report viewer for operations.serving_time (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/operations/serving-time",
)(reportRouteOptions("operations.serving_time"));
