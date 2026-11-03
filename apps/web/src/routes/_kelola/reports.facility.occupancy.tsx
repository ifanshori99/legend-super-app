import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/occupancy — generic report viewer for facility.occupancy
// (PRD v1.7 §3 F25 "Laporan": utilisasi per bilik).
export const Route = createFileRoute("/_kelola/reports/facility/occupancy")(
  reportRouteOptions("facility.occupancy"),
);
