import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/performance/service-quality — generic report viewer for performance.service_quality (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/performance/service-quality",
)(reportRouteOptions("performance.service_quality"));
