import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/operations/kitchen-queue — generic report viewer for operations.kitchen_queue (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/operations/kitchen-queue",
)(reportRouteOptions("operations.kitchen_queue"));
