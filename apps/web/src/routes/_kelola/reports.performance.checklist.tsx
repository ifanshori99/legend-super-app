import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/performance/checklist — generic report viewer for performance.checklist (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/performance/checklist")(
  reportRouteOptions("performance.checklist"),
);
