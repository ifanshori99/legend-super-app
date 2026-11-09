import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/operations/occupancy — generic report viewer for operations.occupancy (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/operations/occupancy")(
  reportRouteOptions("operations.occupancy"),
);
