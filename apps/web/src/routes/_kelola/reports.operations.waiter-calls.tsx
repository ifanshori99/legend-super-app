import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/operations/waiter-calls — generic report viewer for operations.waiter_calls (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/operations/waiter-calls",
)(reportRouteOptions("operations.waiter_calls"));
