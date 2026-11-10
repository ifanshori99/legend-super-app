import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/operations/devices — generic report viewer for operations.devices (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/operations/devices")(
  reportRouteOptions("operations.devices"),
);
