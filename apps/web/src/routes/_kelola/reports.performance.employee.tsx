import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/performance/employee — generic report viewer for performance.employee (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/performance/employee")(
  reportRouteOptions("performance.employee"),
);
