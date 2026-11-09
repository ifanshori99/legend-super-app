import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/incidents — generic report viewer for facility.incidents
// (PRD v1.7 §3 F25 "Laporan": insiden fasilitas).
export const Route = createFileRoute("/_kelola/reports/facility/incidents")(
  reportRouteOptions("facility.incidents"),
);
